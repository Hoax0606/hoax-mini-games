/**
 * 양세찬 게임 렌더러 (HTML DOM — 라이어 게임/꼬들과 통일, 캔버스는 숨긴다)
 *
 * 위에서 아래로 읽히게 짰다.
 *   · 주제 / 누구 차례                  — 지금 상황
 *   · 내 이마 큰 카드(???) + 남들 카드   — 아는 것과 모르는 것
 *   · 대화                               — 질문과 대답이 쌓이는 곳
 *   · 지금 질문 + 입력                   — 내가 할 일
 *
 * 입력 영역은 **차례가 바뀔 때만** 다시 그린다.
 * 질문이 올 때마다 새로 그리면 대답을 치던 글자가 날아간다.
 * (지금 질문 배너는 따로 떼서 바뀔 때만 글자를 갈아끼운다)
 */

import type { FeedEntry, PlayerState } from './rules';
import { escapeHtml } from '../../ui/escape';

export interface CnRenderState {
  players: PlayerState[];
  turnPeerId: string | null;
  theme: string;
  feed: FeedEntry[];
  /** 차례인 사람이 이번 차례 질문을 이미 했나 */
  asked: boolean;
  myPeerId: string;
  isSpectator: boolean;
  notice: string;
}

export interface CnCallbacks {
  onAsk(text: string): void;
  onAnswer(text: string): void;
  onGuess(word: string): void;
  onPass(): void;
}

export class CallMyNameRenderer {
  private canvas: HTMLCanvasElement;
  private cb: CnCallbacks;
  private root: HTMLDivElement;
  private styleEl: HTMLStyleElement;

  private themeEl: HTMLSpanElement;
  private turnEl: HTMLDivElement;
  private meEl: HTMLDivElement;
  private othersEl: HTMLDivElement;
  private feedEl: HTMLDivElement;
  private askEl: HTMLDivElement;
  private actionEl: HTMLDivElement;
  private noticeEl: HTMLDivElement;

  /** 바뀐 것만 다시 그린다 — 매 프레임 재생성하면 입력창 포커스가 날아간다 */
  private boardKey = '';
  private actionKey = '';
  private feedKey = '';
  private askKey = '';

  constructor(canvas: HTMLCanvasElement, cb: CnCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    canvas.style.display = 'none';

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'cn-screen';
    this.root.innerHTML = `
      <div class="cn-top">
        <span class="cn-pill" id="cn-theme"></span>
        <div class="cn-turn" id="cn-turn"></div>
      </div>
      <div class="cn-me" id="cn-me"></div>
      <div class="cn-others" id="cn-others"></div>
      <div class="cn-feed" id="cn-feed"></div>
      <div class="cn-ask" id="cn-ask" hidden></div>
      <div class="cn-notice" id="cn-notice" hidden></div>
      <div class="cn-action" id="cn-action"></div>
    `;
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.root);
    }
    const q = <T extends HTMLElement>(id: string): T => this.root.querySelector<T>('#' + id)!;
    this.themeEl = q('cn-theme');
    this.turnEl = q('cn-turn');
    this.meEl = q('cn-me');
    this.othersEl = q('cn-others');
    this.feedEl = q('cn-feed');
    this.askEl = q('cn-ask');
    this.actionEl = q('cn-action');
    this.noticeEl = q('cn-notice');
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  render(s: CnRenderState): void {
    const me = s.players.find((p) => p.peerId === s.myPeerId) ?? null;
    const turn = s.players.find((p) => p.peerId === s.turnPeerId) ?? null;
    const myTurn = !s.isSpectator && s.turnPeerId === s.myPeerId;

    this.themeEl.textContent = `주제 · ${s.theme}`;
    this.turnEl.textContent = s.turnPeerId === null
      ? '모두 맞혔어요!'
      : myTurn ? '내가 물어볼 차례' : `${turn?.nickname ?? ''} 님이 물어볼 차례`;
    this.turnEl.classList.toggle('is-mine', myTurn);

    const boardKey = s.players
      .map((p) => `${p.peerId}:${p.word}:${p.solved}:${p.rank}:${p.tries}`)
      .join('|') + `|${s.myPeerId}|${s.isSpectator}|${s.turnPeerId}`;
    if (boardKey !== this.boardKey) {
      this.boardKey = boardKey;
      this.drawBoard(s, me);
    }

    // 내 상황이 바뀔 때만 다시 그린다 — 남들끼리 차례가 넘어가도 내가 치던 대답은 살아있게
    const actionKey = `${myTurn}|${myTurn && s.asked}|${s.turnPeerId === null}` +
      `|${s.isSpectator}|${me?.solved ?? false}`;
    if (actionKey !== this.actionKey) {
      this.actionKey = actionKey;
      this.drawAction(s, me, myTurn);
    }

    this.drawFeed(s);
    this.drawAsk(s, myTurn);

    this.noticeEl.textContent = s.notice;
    this.noticeEl.hidden = !s.notice;
  }

  // ------------------------------------------------

  private drawBoard(s: CnRenderState, me: PlayerState | null): void {
    // 내 이마 — 관전자는 맞힐 게 없으니 안내만
    if (s.isSpectator || !me) {
      this.meEl.innerHTML = `<div class="cn-card cn-card-me cn-spec">
        <div class="cn-label">관전 중</div>
        <div class="cn-word">보고만 있어요</div></div>`;
    } else {
      // 내 카드엔 is-turn 을 안 붙인다 — 내 차례는 위 pill 이 이미 말해주고,
      // 노란 배경을 깔면 정작 중요한 ??? 가 묻힌다
      this.meEl.innerHTML = `
        <div class="cn-card cn-card-me${me.solved ? ' is-solved' : ''}">
          <div class="cn-label">${escapeHtml(me.nickname)} (나)</div>
          <div class="cn-word">${me.solved ? escapeHtml(me.word) : '???'}</div>
          <div class="cn-sub">${
            me.solved ? `${me.rank}등으로 맞혔어요` : `시도 ${me.tries}회`
          }</div>
        </div>`;
    }

    // 남들 이마
    const others = s.players.filter((p) => p.peerId !== s.myPeerId);
    this.othersEl.innerHTML = others.length === 0
      ? '<div class="cn-empty">혼자서는 서로 물어볼 사람이 없어요</div>'
      : others.map((p) => `
        <div class="cn-card${p.solved ? ' is-solved' : ''}${
          p.peerId === s.turnPeerId ? ' is-turn' : ''}">
          <div class="cn-label">${escapeHtml(p.nickname)}</div>
          <div class="cn-word">${escapeHtml(p.word)}</div>
          <div class="cn-sub">${p.solved ? `${p.rank}등` : `시도 ${p.tries}회`}</div>
        </div>`).join('');
  }

  /** 대화 — 질문은 왼쪽에 붙고 대답은 한 칸 들여쓴다 */
  private drawFeed(s: CnRenderState): void {
    const key = s.feed.map((f) => `${f.kind}\u0001${f.who}\u0001${f.text}`).join('\u0002');
    if (key === this.feedKey) return;
    this.feedKey = key;

    // 다시 그리기 전에 "지금 맨 아래를 보고 있었나" 를 기억해둔다.
    // 무조건 맨 아래로 내리면, 위로 올려 이전 대화를 읽는 중에 새 질문이 오는 순간
    // 끜려 내려가 버려서 읽던 데로 돌아가려면 매번 다시 올려야 했다.
    const stuckToBottom =
      this.feedEl.scrollHeight - this.feedEl.scrollTop - this.feedEl.clientHeight < 24;

    this.feedEl.innerHTML = s.feed.length === 0
      ? '<div class="cn-f cn-f-sys">질문과 대답이 여기에 쌓여요</div>'
      : s.feed.map((f) => {
        if (f.kind === 'sys') return `<div class="cn-f cn-f-sys">${escapeHtml(f.text)}</div>`;
        const cls = f.kind === 'ask' ? 'cn-f-ask' : 'cn-f-ans';
        return `<div class="cn-f ${cls}"><b>${escapeHtml(f.who)}</b>${escapeHtml(f.text)}</div>`;
      }).join('');
    if (stuckToBottom) this.feedEl.scrollTop = this.feedEl.scrollHeight;
  }

  /**
   * 가장 최근 질문을 입력창 바로 위에 붙여둔다 — 뭘 대답하는 중인지 안 놓치게.
   * 질문한 본인에겐 안 보여준다 (바로 위 대화에 똑같은 줄이 있어서 두 번 읽힌다).
   */
  private drawAsk(s: CnRenderState, myTurn: boolean): void {
    let last: FeedEntry | null = null;
    for (let i = s.feed.length - 1; i >= 0; i--) {
      const f = s.feed[i]!;
      if (f.kind === 'ask') { last = f; break; }
      if (f.kind === 'sys') break; // 사이에 알림이 끼었으면 차례가 넘어간 것 — 지난 질문이다
    }
    if (myTurn) last = null;

    const key = last ? `${last.who}\u0001${last.text}` : '';
    if (key === this.askKey) return;
    this.askKey = key;

    this.askEl.hidden = last === null;
    if (!last) return;
    this.askEl.innerHTML = `<span class="cn-ask-who">${escapeHtml(last.who)}</span>${
      escapeHtml(last.text)}`;
  }

  private drawAction(s: CnRenderState, me: PlayerState | null, myTurn: boolean): void {
    if (s.isSpectator) {
      this.actionEl.innerHTML = '<p class="cn-hint">관전 중이에요 · 답을 알고 있으니 조용히!</p>';
      return;
    }
    if (s.turnPeerId === null) {
      this.actionEl.innerHTML = '<p class="cn-hint">곧 결과가 나와요…</p>';
      return;
    }
    if (myTurn) this.drawAskForm(s.asked);
    else this.drawAnswerForm(me);
  }

  /**
   * 내 차례 — 질문은 한 번만.
   * 묻고 나면 질문창이 사라지고 '정답 / 다음 사람' 만 남는다.
   * 계속 물어볼 수 있게 두면 2인 게임에서 상대가 영영 질문을 못 한다.
   */
  private drawAskForm(asked: boolean): void {
    const guessRow = `
      <form class="cn-form${asked ? '' : ' cn-form-sub'}" id="cn-guess-form">
        <input class="cn-input cn-input-sm" id="cn-guess-input" type="text" maxlength="20"
               autocomplete="off" placeholder="내 이마에 뭐가 붙어있을까?" />
        <button type="submit" class="cn-btn cn-btn-hl">정답!</button>
        <button type="button" class="cn-btn cn-btn-ghost" id="cn-pass">${
          asked ? '다음 사람' : '넘기기'}</button>
      </form>`;

    this.actionEl.innerHTML = asked
      ? `<p class="cn-hint">대답을 보고 정답을 말하거나, 다음 사람에게 넘겨요</p>${guessRow}`
      : `
      <p class="cn-hint">질문은 한 번이에요 · 묻고 나면 정답을 말하거나 넘겨요</p>
      <form class="cn-form" id="cn-ask-form">
        <input class="cn-input" id="cn-ask-input" type="text" maxlength="60" autocomplete="off"
               placeholder="예: 나 먹을 수 있는 거야?" />
        <button type="submit" class="cn-btn">물어보기</button>
      </form>${guessRow}`;

    if (!asked) this.wireForm('cn-ask-form', 'cn-ask-input', (v) => this.cb.onAsk(v));
    this.wireForm('cn-guess-form', 'cn-guess-input', (v) => this.cb.onGuess(v));
    this.actionEl.querySelector<HTMLButtonElement>('#cn-pass')
      ?.addEventListener('click', () => this.cb.onPass());
    this.focusSoon(asked ? 'cn-guess-input' : 'cn-ask-input');
  }

  /** 남 차례 — 대답만. 이미 맞힌 사람도 계속 대답한다 */
  private drawAnswerForm(me: PlayerState | null): void {
    const hint = me?.solved
      ? '맞혔어요! 이제 남은 사람 질문에 대답해주세요'
      : '거짓말은 금지 · 애매하게 답하는 건 OK';
    this.actionEl.innerHTML = `
      <p class="cn-hint">${hint}</p>
      <form class="cn-form" id="cn-ans-form">
        <input class="cn-input" id="cn-ans-input" type="text" maxlength="60" autocomplete="off"
               placeholder="그건 좀 애매한데…" />
        <button type="submit" class="cn-btn">대답</button>
      </form>`;

    this.wireForm('cn-ans-form', 'cn-ans-input', (v) => this.cb.onAnswer(v));
    this.focusSoon('cn-ans-input');
  }

  private wireForm(formId: string, inputId: string, send: (v: string) => void): void {
    const form = this.actionEl.querySelector<HTMLFormElement>('#' + formId);
    const input = this.actionEl.querySelector<HTMLInputElement>('#' + inputId);
    if (!form || !input) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      send(v);
    });
  }

  /** 채팅 등 다른 곳을 치고 있으면 포커스를 뺏지 않는다 */
  private focusSoon(inputId: string): void {
    const a = document.activeElement;
    if (a && a !== document.body && !this.root.contains(a)) return;
    window.setTimeout(() => {
      const b = document.activeElement;
      if (b && b !== document.body && !this.root.contains(b)) return;
      this.actionEl.querySelector<HTMLInputElement>('#' + inputId)?.focus();
    }, 40);
  }
}

/* 색은 theme.css 변수를 쓴다 (하드코딩 금지 규약) */
const CSS = `
.cn-screen{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:safe center;gap:9px;padding:12px 14px;box-sizing:border-box;overflow:auto;
  font-family:var(--font-sans);color:var(--text-main);}
.cn-top{display:flex;flex-direction:column;align-items:center;gap:5px;flex:0 0 auto;}
.cn-pill{font-size:11.5px;font-weight:800;padding:4px 12px;border-radius:var(--radius-full);
  background:var(--bg-subtle);color:var(--text-muted);}
.cn-turn{font-size:15px;font-weight:800;color:var(--text-muted);}
.cn-turn.is-mine{color:var(--highlight-ink);background:var(--highlight-soft);
  padding:3px 14px;border-radius:var(--radius-full);}

.cn-me,.cn-others{flex:0 0 auto;}
.cn-card{background:var(--bg-card);border:2px solid var(--border-soft);
  border-radius:var(--radius-md);padding:8px 13px;text-align:center;min-width:96px;
  box-shadow:var(--shadow-sm);}
.cn-card.is-turn{border-color:var(--highlight);background:var(--highlight-soft);}
.cn-card.is-solved{border-color:var(--mint-300);background:var(--mint-100);}
.cn-label{font-size:11.5px;font-weight:800;color:var(--text-muted);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;}
.cn-word{font-size:18px;font-weight:900;margin-top:2px;}
.cn-sub{font-size:10.5px;font-weight:700;color:var(--text-muted);margin-top:1px;}

/* 내 이마 — 가장 크게. 여기만 ??? 로 가려진다 */
.cn-card-me{min-width:220px;padding:13px 26px;border-width:2.5px;border-color:var(--accent);
  box-shadow:var(--shadow-md);}
.cn-card-me .cn-word{font-size:clamp(26px, 6vh, 38px);letter-spacing:1px;}
.cn-card-me.is-solved{border-color:var(--mint-500);}
.cn-card-me.cn-spec{border-color:var(--border);}
.cn-card-me.cn-spec .cn-word{font-size:20px;color:var(--text-muted);}

.cn-others{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;max-width:620px;}
.cn-empty{font-size:12.5px;color:var(--text-muted);}

/* 대화 — 질문은 왼쪽에 붙고 대답은 한 칸 들여쓴다 */
.cn-feed{width:100%;max-width:460px;flex:1 1 auto;min-height:74px;max-height:min(210px,25vh);
  overflow-y:auto;scrollbar-width:thin;display:flex;flex-direction:column;gap:3px;
  padding:7px 9px;box-sizing:border-box;background:var(--bg-inset);
  border:1px solid var(--border-soft);border-radius:var(--radius-md);}
.cn-f{font-size:12px;line-height:1.45;border-radius:var(--radius-sm);padding:4px 9px;
  word-break:break-word;}
.cn-f b{font-weight:800;margin-right:6px;}
.cn-f-sys{font-size:11px;color:var(--text-muted);text-align:center;background:none;padding:2px 0;}
.cn-f-ask{background:var(--bg-card);border-left:3px solid var(--accent);font-weight:700;}
.cn-f-ask b{color:var(--accent);}
.cn-f-ans{margin-left:20px;background:var(--bg-subtle);color:var(--text-muted);}
.cn-f-ans b{color:var(--text-main);}

/* 지금 대답해야 할 질문 */
.cn-ask{flex:0 0 auto;max-width:460px;font-size:13.5px;font-weight:800;text-align:center;
  padding:5px 14px;border-radius:var(--radius-full);background:var(--accent-soft);
  color:var(--text-main);}
.cn-ask-who{font-weight:800;opacity:.72;margin-right:7px;}
.cn-ask[hidden]{display:none;}

.cn-action{display:flex;flex-direction:column;align-items:center;gap:6px;flex:0 0 auto;
  width:100%;max-width:460px;}
.cn-hint{font-size:12.5px;color:var(--text-muted);margin:0;text-align:center;}
.cn-form{display:flex;gap:6px;align-items:center;width:100%;}
.cn-form-sub{opacity:.92;}
/* flex 자식 input 은 min-width:0 을 꼭 붙인다 — 안 그러면 고유 폭 밑으로 안 줄어서 버튼이 밀려난다 */
.cn-input{flex:1 1 0;min-width:0;padding:9px 15px;border:1.5px solid var(--border);
  border-radius:var(--radius-full);font:inherit;font-size:14px;background:var(--bg-inset);
  color:var(--text-main);outline:none;}
.cn-input-sm{font-size:13px;padding:7px 14px;}
.cn-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(63,179,162,.20);}
.cn-btn{font:inherit;font-weight:800;font-size:13.5px;color:#fff;background:var(--accent);
  border:none;border-radius:var(--radius-full);padding:9px 16px;cursor:pointer;white-space:nowrap;}
.cn-btn:hover{background:var(--accent-hover);}
.cn-btn-hl{background:var(--highlight);color:var(--highlight-ink);padding:7px 15px;font-size:13px;}
.cn-btn-hl:hover{background:var(--highlight);filter:brightness(.95);}
.cn-btn-ghost{background:transparent;color:var(--text-muted);border:1.5px solid var(--border);
  padding:6px 13px;font-size:13px;}
.cn-btn-ghost:hover{background:var(--bg-subtle);}

.cn-notice{font-size:12.5px;font-weight:700;color:var(--danger);text-align:center;flex:0 0 auto;}
.cn-notice[hidden]{display:none;}
`;
