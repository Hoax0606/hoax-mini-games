/**
 * 양세찬 게임 렌더러 (HTML DOM — 라이어 게임/꼬들과 통일, 캔버스는 숨긴다)
 *
 * 화면은 셋으로 나뉜다.
 *   · 가운데 큰 카드 = 내 이마. 내 단어만 ??? 로 가려진다
 *   · 그 아래 줄 = 남들의 이마 (단어가 그대로 보인다)
 *   · 아래 기록 = 누가 맞히고 틀렸는지
 *
 * 질문과 대답은 채팅으로 하므로 여기엔 입력이 거의 없다.
 * 내 차례일 때만 '정답 말하기 / 넘기기' 가 열린다.
 */

import type { PlayerState } from './rules';
import { escapeHtml } from '../../ui/escape';

export interface CnRenderState {
  players: PlayerState[];
  turnPeerId: string | null;
  theme: string;
  log: string[];
  myPeerId: string;
  isSpectator: boolean;
  notice: string;
}

export interface CnCallbacks {
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
  private actionEl: HTMLDivElement;
  private logEl: HTMLDivElement;
  private noticeEl: HTMLDivElement;

  /** 바뀐 것만 다시 그린다 — 매 프레임 재생성하면 입력창 포커스가 날아간다 */
  private boardKey = '';
  private actionKey = '';
  private logKey = '';

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
      <div class="cn-notice" id="cn-notice"></div>
      <div class="cn-action" id="cn-action"></div>
      <div class="cn-log" id="cn-log"></div>
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
    this.actionEl = q('cn-action');
    this.logEl = q('cn-log');
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
      : myTurn ? '내 차례예요' : `${turn?.nickname ?? ''} 님 차례`;
    this.turnEl.classList.toggle('is-mine', myTurn);

    const boardKey = s.players
      .map((p) => `${p.peerId}:${p.word}:${p.solved}:${p.rank}:${p.tries}`)
      .join('|') + `|${s.myPeerId}|${s.isSpectator}`;
    if (boardKey !== this.boardKey) {
      this.boardKey = boardKey;
      this.drawBoard(s, me);
    }

    const actionKey = `${myTurn}|${s.turnPeerId}|${me?.solved}|${s.isSpectator}|${me?.tries}`;
    if (actionKey !== this.actionKey) {
      this.actionKey = actionKey;
      this.drawAction(s, me, myTurn);
    }

    const logKey = s.log.join('|');
    if (logKey !== this.logKey) {
      this.logKey = logKey;
      this.logEl.innerHTML = s.log
        .map((l) => `<div class="cn-logline">${escapeHtml(l)}</div>`).join('');
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }

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

  private drawAction(s: CnRenderState, me: PlayerState | null, myTurn: boolean): void {
    if (s.isSpectator) {
      this.actionEl.innerHTML = '<p class="cn-hint">관전 중이에요</p>';
      return;
    }
    if (s.turnPeerId === null) {
      this.actionEl.innerHTML = '<p class="cn-hint">곧 결과가 나와요…</p>';
      return;
    }
    if (me?.solved) {
      this.actionEl.innerHTML = '<p class="cn-hint">맞혔어요! 남은 사람 응원해주세요</p>';
      return;
    }
    if (!myTurn) {
      this.actionEl.innerHTML =
        '<p class="cn-hint">채팅으로 질문하고 대답해요 · 거짓말은 금지, 애매하게는 OK</p>';
      return;
    }
    this.actionEl.innerHTML = `
      <p class="cn-hint">채팅으로 물어본 뒤, 감이 오면 정답을 말해보세요</p>
      <form class="cn-form" id="cn-form">
        <input class="cn-input" id="cn-input" type="text" maxlength="20" autocomplete="off"
               placeholder="내 이마에 뭐가 붙어있을까?" />
        <button type="submit" class="cn-btn">정답!</button>
        <button type="button" class="cn-btn cn-btn-ghost" id="cn-pass">넘기기</button>
      </form>`;

    const form = this.actionEl.querySelector<HTMLFormElement>('#cn-form')!;
    const input = this.actionEl.querySelector<HTMLInputElement>('#cn-input')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (v) { input.value = ''; this.cb.onGuess(v); }
    });
    this.actionEl.querySelector<HTMLButtonElement>('#cn-pass')
      ?.addEventListener('click', () => this.cb.onPass());
    // 채팅 치는 중이면 포커스를 뺏지 않는다
    const a = document.activeElement;
    if (!a || a === document.body || this.root.contains(a)) {
      window.setTimeout(() => {
        const b = document.activeElement;
        if (!b || b === document.body || this.root.contains(b)) input.focus();
      }, 40);
    }
  }
}

/* 색은 theme.css 변수를 쓴다 (하드코딩 금지 규약) */
const CSS = `
.cn-screen{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:safe center;gap:10px;padding:14px;box-sizing:border-box;overflow:auto;
  font-family:var(--font-sans);color:var(--text-main);}
.cn-top{display:flex;flex-direction:column;align-items:center;gap:6px;}
.cn-pill{font-size:11.5px;font-weight:800;padding:4px 12px;border-radius:var(--radius-full);
  background:var(--bg-subtle);color:var(--text-muted);}
.cn-turn{font-size:15px;font-weight:800;color:var(--text-muted);}
.cn-turn.is-mine{color:var(--highlight-ink);background:var(--highlight-soft);
  padding:3px 14px;border-radius:var(--radius-full);}

.cn-card{background:var(--bg-card);border:2px solid var(--border-soft);
  border-radius:var(--radius-md);padding:10px 14px;text-align:center;min-width:104px;
  box-shadow:var(--shadow-sm);}
.cn-card.is-turn{border-color:var(--highlight);background:var(--highlight-soft);}
.cn-card.is-solved{border-color:var(--mint-300);background:var(--mint-100);}
.cn-label{font-size:11.5px;font-weight:800;color:var(--text-muted);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;}
.cn-word{font-size:19px;font-weight:900;margin-top:2px;}
.cn-sub{font-size:10.5px;font-weight:700;color:var(--text-muted);margin-top:2px;}

/* 내 이마 — 가장 크게. 여기만 ??? 로 가려진다 */
.cn-card-me{min-width:220px;padding:16px 26px;border-width:2.5px;border-color:var(--accent);
  box-shadow:var(--shadow-md);}
.cn-card-me .cn-word{font-size:40px;letter-spacing:1px;}
.cn-card-me.is-solved{border-color:var(--mint-500);}
.cn-card-me.cn-spec{border-color:var(--border);}
.cn-card-me.cn-spec .cn-word{font-size:20px;color:var(--text-muted);}

.cn-others{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:620px;}
.cn-empty{font-size:12.5px;color:var(--text-muted);}

.cn-action{display:flex;flex-direction:column;align-items:center;gap:7px;}
.cn-hint{font-size:12.5px;color:var(--text-muted);margin:0;text-align:center;}
.cn-form{display:flex;gap:7px;align-items:center;}
/* flex 자식 input 은 min-width:0 을 꼭 붙인다 — 안 그러면 고유 폭 밑으로 안 줄어서 버튼이 밀려난다 */
.cn-input{flex:1 1 0;min-width:0;width:230px;padding:9px 15px;border:1.5px solid var(--border);
  border-radius:var(--radius-full);font:inherit;font-size:14px;background:var(--bg-inset);
  color:var(--text-main);outline:none;text-align:center;}
.cn-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(63,179,162,.20);}
.cn-btn{font:inherit;font-weight:800;font-size:13.5px;color:#fff;background:var(--accent);
  border:none;border-radius:var(--radius-full);padding:9px 16px;cursor:pointer;white-space:nowrap;}
.cn-btn:hover{background:var(--accent-hover);}
.cn-btn-ghost{background:transparent;color:var(--text-muted);border:1.5px solid var(--border);}
.cn-btn-ghost:hover{background:var(--bg-subtle);}
.cn-notice{font-size:12.5px;font-weight:700;color:var(--danger);text-align:center;}

.cn-log{width:100%;max-width:460px;max-height:104px;overflow-y:auto;display:flex;
  flex-direction:column;gap:3px;}
.cn-logline{font-size:11.5px;color:var(--text-muted);background:var(--bg-subtle);
  border-radius:var(--radius-sm);padding:4px 10px;text-align:center;}
`;
