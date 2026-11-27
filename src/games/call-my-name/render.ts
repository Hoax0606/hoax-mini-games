/**
 * 양세찬 게임 렌더러 (HTML DOM — 라이어 게임/꼬들과 통일, 캔버스는 숨긴다)
 *
 * 위에서 아래로 읽히게 짰다.
 *   · 주제 / 누구 차례          — 지금 상황
 *   · 내 이마 큰 카드(???)      — 내가 모르는 것
 *   · 지금 질문 + 진행(3/4·남은 시간)
 *   · 사람별 카드               — 그 사람 이마 + 그 사람 대답이 쌓인다
 *   · 입력                      — 지금 내가 할 일 하나만
 *
 * 대답을 한 피드에 시간순으로 섞어 쌓던 걸 걷어냈다. 누가 뭐라고 했는지 눈으로 좇아야 해서
 * 판이 안 읽혔다. 이제 대답은 **그 사람 카드 안에** 쌓이고, 최근 것이 맨 위에 온다.
 *
 * 입력 영역은 **내 할 일이 바뀔 때만** 다시 그린다.
 * 남이 대답할 때마다 새로 그리면 내가 치던 글자가 날아간다.
 */

import type { Round, PlayerState } from './rules';
import { NO_ANSWER } from './rules';
import type { CnPhase } from './netSync';
import { escapeHtml } from '../../ui/escape';

export interface CnRenderState {
  players: PlayerState[];
  turnPeerId: string | null;
  theme: string;
  phase: CnPhase;
  rounds: Round[];
  /** 대답 제한이 끝나는 시각(Date.now 기준). 0 이면 무제한 */
  answerDeadline: number;
  news: string;
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

/** 대답 입력 옆에 붙는 빠른 버튼 — 자유 입력이 본체고 이건 거들기만 한다 */
const QUICK = ['응', '아니', '글쎄'];

export class CallMyNameRenderer {
  private canvas: HTMLCanvasElement;
  private cb: CnCallbacks;
  private root: HTMLDivElement;
  private styleEl: HTMLStyleElement;

  private themeEl: HTMLSpanElement;
  private turnEl: HTMLDivElement;
  private meEl: HTMLDivElement;
  private qEl: HTMLDivElement;
  private timerEl: HTMLSpanElement;
  private cardsEl: HTMLDivElement;
  private newsEl: HTMLDivElement;
  private actionEl: HTMLDivElement;
  private noticeEl: HTMLDivElement;

  /** 바뀐 것만 다시 그린다 — 매 프레임 재생성하면 입력창 포커스가 날아간다 */
  private cardsKey = '';
  private actionKey = '';
  private qKey = '';
  private meKey = '';

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
      <div class="cn-q" id="cn-q" hidden>
        <div class="cn-q-text" id="cn-q-text"></div>
        <div class="cn-q-meta"><span id="cn-q-count"></span><span class="cn-timer" id="cn-timer"></span></div>
      </div>
      <div class="cn-cards" id="cn-cards"></div>
      <div class="cn-news" id="cn-news" hidden></div>
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
    this.qEl = q('cn-q');
    this.timerEl = q('cn-timer');
    this.cardsEl = q('cn-cards');
    this.newsEl = q('cn-news');
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
    const round = s.rounds[s.rounds.length - 1] ?? null;

    this.themeEl.textContent = `주제 · ${s.theme}`;
    this.turnEl.textContent = s.turnPeerId === null
      ? '모두 맞혔어요!'
      : myTurn ? '내가 물어볼 차례' : `${turn?.nickname ?? ''} 님 차례`;
    this.turnEl.classList.toggle('is-mine', myTurn);

    // 내 이마
    const meKey = `${me?.word ?? ''}|${me?.solved ?? false}|${me?.rank ?? 0}|${me?.tries ?? 0}|${s.isSpectator}`;
    if (meKey !== this.meKey) { this.meKey = meKey; this.drawMe(s, me); }

    // 지금 질문 + 몇 명 답했나
    this.drawQuestion(s, round);

    // 사람별 카드 — 대답이 여기에 쌓인다
    const cardsKey = s.players.map((p) => `${p.peerId}:${p.word}:${p.solved}:${p.rank}:${p.tries}`).join('|')
      + '#' + s.rounds.map((r) => `${r.no}:${r.question}:${r.answers.map((a) => a.peerId + '=' + a.text).join(',')}`).join(';')
      + `#${s.turnPeerId}|${s.myPeerId}`;
    if (cardsKey !== this.cardsKey) { this.cardsKey = cardsKey; this.drawCards(s); }

    // 내가 할 일이 바뀔 때만 입력을 다시 그린다
    const iAnswered = round?.answers.find((a) => a.peerId === s.myPeerId)?.text ?? '';
    const amAnswerer = !!round?.answers.some((a) => a.peerId === s.myPeerId);
    const actionKey = `${s.phase}|${myTurn}|${s.isSpectator}|${amAnswerer}|${iAnswered !== ''}|${s.turnPeerId}|${round?.no ?? 0}`;
    if (actionKey !== this.actionKey) {
      this.actionKey = actionKey;
      this.drawAction(s, me, myTurn, { amAnswerer, answered: iAnswered !== '' });
    }

    this.newsEl.textContent = s.news;
    this.newsEl.hidden = !s.news;
    this.noticeEl.textContent = s.notice;
    this.noticeEl.hidden = !s.notice;
  }

  // ------------------------------------------------

  private drawMe(s: CnRenderState, me: PlayerState | null): void {
    // 관전자는 맞힐 게 없다 — 정작 봐야 할 판을 아래로 밀어내지 않게 비운다
    if (s.isSpectator || !me) { this.meEl.innerHTML = ''; return; }
    this.meEl.innerHTML = `
      <div class="cn-card cn-card-me${me.solved ? ' is-solved' : ''}">
        <div class="cn-label">${escapeHtml(me.nickname)} (나)</div>
        <div class="cn-word">${me.solved ? escapeHtml(me.word) : '???'}</div>
        <div class="cn-sub">${me.solved ? `${me.rank}등으로 맞혔어요` : `시도 ${me.tries}회`}</div>
      </div>`;
  }

  /**
   * 지금 질문 배너. 남은 시간은 매 프레임 갱신하되(숫자만 갈아끼움),
   * 질문 글자는 바뀔 때만 건드린다 — 매 프레임 innerHTML 을 새로 쓰면 글자가 깜빡인다.
   */
  private drawQuestion(s: CnRenderState, round: Round | null): void {
    const show = round !== null && round.question !== '' && s.phase !== 'over';
    this.qEl.hidden = !show;
    if (!show || !round) { this.qKey = ''; return; }

    const done = round.answers.filter((a) => a.text).length;
    const total = round.answers.length;
    const key = `${round.no}|${round.question}|${done}/${total}|${s.phase}`;
    if (key !== this.qKey) {
      this.qKey = key;
      this.root.querySelector<HTMLDivElement>('#cn-q-text')!.textContent = `“${round.question}”`;
      const countEl = this.root.querySelector<HTMLSpanElement>('#cn-q-count')!;
      countEl.textContent = total === 0
        ? '답할 사람이 없어요'
        : s.phase === 'answer' ? `${done} / ${total} 답함` : `${total}명 대답 완료`;
    }

    // 남은 시간 — 0.5초 단위로 줄어드는 숫자만 바꾼다
    if (s.phase === 'answer' && s.answerDeadline > 0) {
      const left = Math.max(0, Math.ceil((s.answerDeadline - Date.now()) / 1000));
      const txt = `${left}초`;
      if (this.timerEl.textContent !== txt) this.timerEl.textContent = txt;
      this.timerEl.classList.toggle('is-hot', left <= 5);
      this.timerEl.hidden = false;
    } else {
      this.timerEl.hidden = true;
    }
  }

  /**
   * 사람별 카드. 위에서부터 [이름 · 이마 단어] [이번 대답] [지난 대답들].
   * 지난 대답은 최근 것이 위로 — 방금 뭐라 했는지가 제일 궁금하다.
   */
  private drawCards(s: CnRenderState): void {
    const others = s.players.filter((p) => p.peerId !== s.myPeerId);
    if (others.length === 0) {
      this.cardsEl.innerHTML = '<div class="cn-empty">혼자서는 서로 물어볼 사람이 없어요</div>';
      return;
    }
    const cur = s.rounds[s.rounds.length - 1] ?? null;

    this.cardsEl.innerHTML = others.map((p) => {
      const isTurn = p.peerId === s.turnPeerId;
      const curSlot = cur?.answers.find((a) => a.peerId === p.peerId) ?? null;
      // 이번 질문에 대한 칸: 대답 대상이 아니면 아예 안 보여준다(맞혀서 빠졌거나 질문자 본인)
      const now = curSlot === null
        ? (isTurn ? '<div class="cn-now is-asking">질문하는 중</div>' : '')
        : curSlot.text === ''
          ? '<div class="cn-now is-wait">대답 기다리는 중…</div>'
          : `<div class="cn-now${curSlot.text === NO_ANSWER ? ' is-none' : ''}">${escapeHtml(curSlot.text)}</div>`;

      // 지난 대답 — 이번 바퀴를 뺀 나머지를 최근순으로
      const past = s.rounds.slice(0, -1).reverse()
        .map((r) => {
          const slot = r.answers.find((a) => a.peerId === p.peerId);
          if (!slot || !slot.text) return '';
          return `<div class="cn-past"><span class="cn-past-q">${escapeHtml(r.question)}</span>
            <span class="cn-past-a">${escapeHtml(slot.text)}</span></div>`;
        }).filter(Boolean).join('');

      return `
        <div class="cn-card${p.solved ? ' is-solved' : ''}${isTurn ? ' is-turn' : ''}">
          <div class="cn-label">${escapeHtml(p.nickname)}${p.solved ? ` · ${p.rank}등` : ''}</div>
          <div class="cn-word">${escapeHtml(p.word)}</div>
          ${now}
          ${past ? `<div class="cn-pastbox">${past}</div>` : ''}
        </div>`;
    }).join('');
  }

  private drawAction(
    s: CnRenderState, me: PlayerState | null, myTurn: boolean,
    mine: { amAnswerer: boolean; answered: boolean },
  ): void {
    if (s.isSpectator) {
      this.actionEl.innerHTML = '<p class="cn-hint">관전 중이에요 · 답을 알고 있으니 조용히!</p>';
      return;
    }
    if (s.phase === 'over' || s.turnPeerId === null) {
      this.actionEl.innerHTML = '<p class="cn-hint">곧 결과가 나와요…</p>';
      return;
    }
    const turnName = s.players.find((p) => p.peerId === s.turnPeerId)?.nickname ?? '';

    if (myTurn) {
      if (s.phase === 'ask') { this.drawAskForm(); return; }
      if (s.phase === 'answer') {
        this.actionEl.innerHTML = '<p class="cn-hint">모두의 대답을 기다리는 중이에요</p>';
        return;
      }
      this.drawDecideForm(); // decide
      return;
    }

    // 남의 차례
    if (s.phase === 'ask') {
      this.actionEl.innerHTML = `<p class="cn-hint">${escapeHtml(turnName)} 님이 질문을 쓰는 중…</p>`;
      return;
    }
    if (s.phase === 'decide') {
      this.actionEl.innerHTML = `<p class="cn-hint">${escapeHtml(turnName)} 님이 정답을 고민하는 중…</p>`;
      return;
    }
    // answer 단계
    if (!mine.amAnswerer) {
      const why = me?.solved ? '맞혀서 이번 판은 쉬어요' : '이번 질문은 대답하지 않아도 돼요';
      this.actionEl.innerHTML = `<p class="cn-hint">${why}</p>`;
      return;
    }
    if (mine.answered) {
      this.actionEl.innerHTML = '<p class="cn-hint">대답했어요 · 남은 사람을 기다리는 중</p>';
      return;
    }
    this.drawAnswerForm();
  }

  /** 내 차례 1단계 — 질문 하나 */
  private drawAskForm(): void {
    this.actionEl.innerHTML = `
      <p class="cn-hint">질문은 한 번 · 모두가 한 번씩 대답해요</p>
      <form class="cn-form" id="cn-ask-form">
        <input class="cn-input" id="cn-ask-input" type="text" maxlength="60" autocomplete="off"
               placeholder="예: 나 먹을 수 있는 거야?" />
        <button type="submit" class="cn-btn">물어보기</button>
      </form>`;
    this.wireForm('cn-ask-form', 'cn-ask-input', (v) => this.cb.onAsk(v));
    this.focusSoon('cn-ask-input');
  }

  /** 내 차례 3단계 — 대답을 다 들었으니 정답을 말하거나 넘긴다 */
  private drawDecideForm(): void {
    this.actionEl.innerHTML = `
      <p class="cn-hint">대답을 보고 정답을 말하거나, 다음 사람에게 넘겨요</p>
      <form class="cn-form" id="cn-guess-form">
        <input class="cn-input" id="cn-guess-input" type="text" maxlength="20" autocomplete="off"
               placeholder="내 이마에 뭐가 붙어있을까?" />
        <button type="submit" class="cn-btn cn-btn-hl">정답!</button>
        <button type="button" class="cn-btn cn-btn-ghost" id="cn-pass">넘기기</button>
      </form>`;
    this.wireForm('cn-guess-form', 'cn-guess-input', (v) => this.cb.onGuess(v));
    this.actionEl.querySelector<HTMLButtonElement>('#cn-pass')
      ?.addEventListener('click', () => this.cb.onPass());
    this.focusSoon('cn-guess-input');
  }

  /** 남 차례 2단계 — 나도 한 번은 꼭 대답해야 한다 */
  private drawAnswerForm(): void {
    this.actionEl.innerHTML = `
      <p class="cn-hint">거짓말은 금지 · 애매하게 답하는 건 OK</p>
      <form class="cn-form" id="cn-ans-form">
        <input class="cn-input" id="cn-ans-input" type="text" maxlength="60" autocomplete="off"
               placeholder="그건 좀 애매한데…" />
        <button type="submit" class="cn-btn">대답</button>
      </form>
      <div class="cn-quick">${QUICK.map((q) =>
        `<button type="button" class="cn-btn cn-btn-ghost cn-quick-btn" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`,
      ).join('')}</div>`;
    this.wireForm('cn-ans-form', 'cn-ans-input', (v) => this.cb.onAnswer(v));
    this.actionEl.querySelectorAll<HTMLButtonElement>('.cn-quick-btn').forEach((b) => {
      b.addEventListener('click', () => this.cb.onAnswer(b.dataset['q'] ?? ''));
    });
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
  justify-content:safe center;gap:8px;padding:12px 14px;box-sizing:border-box;overflow:auto;
  font-family:var(--font-sans);color:var(--text-main);}
.cn-top{display:flex;flex-direction:column;align-items:center;gap:5px;flex:0 0 auto;}
.cn-pill{font-size:11.5px;font-weight:800;padding:4px 12px;border-radius:var(--radius-full);
  background:var(--bg-subtle);color:var(--text-muted);}
.cn-turn{font-size:15px;font-weight:800;color:var(--text-muted);}
.cn-turn.is-mine{color:var(--highlight-ink);background:var(--highlight-soft);
  padding:3px 14px;border-radius:var(--radius-full);}

.cn-me{flex:0 0 auto;}
.cn-card{background:var(--bg-card);border:2px solid var(--border-soft);
  border-radius:var(--radius-md);padding:8px 11px;text-align:center;
  box-shadow:var(--shadow-sm);}
.cn-card.is-turn{border-color:var(--highlight);background:var(--highlight-soft);}
.cn-card.is-solved{border-color:var(--mint-300);background:var(--mint-100);}
.cn-label{font-size:11.5px;font-weight:800;color:var(--text-muted);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cn-word{font-size:17px;font-weight:900;margin-top:2px;}
.cn-sub{font-size:10.5px;font-weight:700;color:var(--text-muted);margin-top:1px;}

/* 내 이마 — 가장 크게. 여기만 ??? 로 가려진다 */
.cn-card-me{min-width:200px;padding:11px 24px;border-width:2.5px;border-color:var(--accent);
  box-shadow:var(--shadow-md);}
.cn-card-me .cn-word{font-size:clamp(24px, 5vh, 34px);letter-spacing:1px;}
.cn-card-me.is-solved{border-color:var(--mint-500);}

/* 지금 질문 */
.cn-q{flex:0 0 auto;width:100%;max-width:520px;display:flex;flex-direction:column;
  align-items:center;gap:3px;padding:8px 16px;box-sizing:border-box;
  background:var(--accent-soft);border-radius:var(--radius-md);}
.cn-q[hidden]{display:none;}
.cn-q-text{font-size:15px;font-weight:800;text-align:center;word-break:break-word;}
.cn-q-meta{display:flex;align-items:center;gap:10px;font-size:11.5px;font-weight:800;
  color:var(--text-muted);}
.cn-timer{color:var(--accent);}
.cn-timer.is-hot{color:var(--danger);}
.cn-timer[hidden]{display:none;}

/* 사람별 카드 — 대답이 이 안에 쌓인다 */
/* flex:0 1 auto — 내용만큼만 차지한다. 1 1 auto 로 두면 사람이 적을 때
   카드와 입력란 사이가 터무니처럼 비어버린다 */
.cn-cards{flex:0 1 auto;min-height:0;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;
  align-content:flex-start;width:100%;max-width:820px;max-height:46vh;overflow-y:auto;
  scrollbar-width:thin;padding:2px;box-sizing:border-box;}
.cn-cards .cn-card{width:150px;text-align:left;display:flex;flex-direction:column;gap:3px;}
.cn-now{font-size:13px;font-weight:800;padding:4px 8px;border-radius:var(--radius-sm);
  background:var(--bg-inset);word-break:break-word;}
.cn-now.is-wait{color:var(--text-muted);font-weight:700;font-size:11.5px;background:none;padding:2px 0;}
.cn-now.is-asking{color:var(--accent);font-weight:800;font-size:11.5px;background:none;padding:2px 0;}
.cn-now.is-none{color:var(--text-muted);}
.cn-pastbox{display:flex;flex-direction:column;gap:2px;max-height:104px;overflow-y:auto;
  scrollbar-width:thin;border-top:1px dashed var(--border-soft);padding-top:3px;}
.cn-past{font-size:10.5px;line-height:1.35;color:var(--text-muted);}
.cn-past-q{display:block;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cn-past-a{font-weight:800;color:var(--text-main);}
.cn-empty{font-size:12.5px;color:var(--text-muted);}

.cn-news{flex:0 0 auto;font-size:12px;font-weight:700;color:var(--text-muted);text-align:center;}
.cn-news[hidden]{display:none;}

.cn-action{display:flex;flex-direction:column;align-items:center;gap:6px;flex:0 0 auto;
  width:100%;max-width:460px;}
.cn-hint{font-size:12.5px;color:var(--text-muted);margin:0;text-align:center;}
.cn-form{display:flex;gap:6px;align-items:center;width:100%;}
/* flex 자식 input 은 min-width:0 을 꼭 붙인다 — 안 그러면 고유 폭 밑으로 안 줄어서 버튼이 밀려난다 */
.cn-input{flex:1 1 0;min-width:0;padding:9px 15px;border:1.5px solid var(--border);
  border-radius:var(--radius-full);font:inherit;font-size:14px;background:var(--bg-inset);
  color:var(--text-main);outline:none;}
.cn-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(63,179,162,.20);}
.cn-btn{font:inherit;font-weight:800;font-size:13.5px;color:#fff;background:var(--accent);
  border:none;border-radius:var(--radius-full);padding:9px 16px;cursor:pointer;white-space:nowrap;}
.cn-btn:hover{background:var(--accent-hover);}
.cn-btn-hl{background:var(--highlight);color:var(--highlight-ink);padding:7px 15px;font-size:13px;}
.cn-btn-hl:hover{background:var(--highlight);filter:brightness(.95);}
.cn-btn-ghost{background:transparent;color:var(--text-muted);border:1.5px solid var(--border);
  padding:6px 13px;font-size:13px;}
.cn-btn-ghost:hover{background:var(--bg-subtle);}
.cn-quick{display:flex;gap:6px;}
.cn-quick-btn{padding:4px 14px;font-size:12.5px;}

.cn-notice{font-size:12.5px;font-weight:700;color:var(--danger);text-align:center;flex:0 0 auto;}
.cn-notice[hidden]{display:none;}
`;
