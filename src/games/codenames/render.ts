/**
 * 코드네임 렌더러 (HTML DOM — 격자와 입력이라 캔버스를 안 쓴다)
 *
 * 화면은 위에서 아래로:
 *   · 누구 차례 · 남은 카드 수 · 남은 시간
 *   · 지금 힌트 (크게)
 *   · 5×5 단어 격자
 *   · 내 역할에 맞는 입력 하나
 *
 * 색은 **받은 데이터에만** 들어 있다. 팀원에겐 공개된 카드 색만 오고,
 * 스파이마스터와 관전자에겐 전부 온다 (가리는 건 호스트 몫 — netSync 주석 참고).
 */

import type { MaskedCard, SyncPlayer, CdPhase } from './netSync';
import { TEAM_LABEL, COLS, type Team } from './rules';
import { escapeHtml } from '../../ui/escape';

export interface CdRenderState {
  players: SyncPlayer[];
  cards: MaskedCard[];
  turnTeam: Team;
  phase: CdPhase;
  hint: { word: string; count: number } | null;
  guessesLeft: number;
  left: { red: number; blue: number };
  deadline: number;
  news: string;
  winner: Team | null;
  myPeerId: string;
  isSpectator: boolean;
}

export interface CdCallbacks {
  onHint(word: string, count: number): void;
  onGuess(index: number): void;
  onPass(): void;
}

export class CodenamesRenderer {
  private canvas: HTMLCanvasElement;
  private cb: CdCallbacks;
  private root: HTMLDivElement;
  private styleEl: HTMLStyleElement;

  private topEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private gridEl: HTMLDivElement;
  private actionEl: HTMLDivElement;
  private noticeEl: HTMLDivElement;

  private gridKey = '';
  private actionKey = '';
  private rejectText = '';
  private rejectUntil = 0;

  constructor(canvas: HTMLCanvasElement, cb: CdCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    canvas.style.display = 'none';

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'cd-screen';
    this.root.innerHTML = `
      <div class="cd-top" id="cd-top"></div>
      <div class="cd-hint" id="cd-hint" hidden></div>
      <div class="cd-grid" id="cd-grid"></div>
      <div class="cd-notice" id="cd-notice" hidden></div>
      <div class="cd-action" id="cd-action"></div>
    `;
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.root);
    }
    const q = <T extends HTMLElement>(id: string): T => this.root.querySelector<T>('#' + id)!;
    this.topEl = q('cd-top');
    this.hintEl = q('cd-hint');
    this.gridEl = q('cd-grid');
    this.actionEl = q('cd-action');
    this.noticeEl = q('cd-notice');

    // 카드 클릭은 격자 전체에 한 번만 건다 (매번 다시 그려도 핸들러가 안 샌다)
    this.gridEl.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-idx]');
      if (!el || el.classList.contains('is-locked')) return;
      this.cb.onGuess(Number(el.dataset['idx']));
    });
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  showReject(reason: string): void {
    this.rejectText = reason;
    this.rejectUntil = performance.now() + 4_000;
  }

  render(s: CdRenderState): void {
    const me = s.players.find((p) => p.peerId === s.myPeerId) ?? null;
    const myTurn = !!me && me.team === s.turnTeam && s.phase !== 'over';
    const canGuess = myTurn && !me!.spymaster && s.phase === 'guess';

    this.drawTop(s, me);

    // 힌트 배너
    this.hintEl.hidden = s.hint === null;
    if (s.hint) {
      this.hintEl.innerHTML = `<b>${escapeHtml(s.hint.word)}</b> <span>${s.hint.count}</span>` +
        (s.phase === 'guess' ? `<i class="cd-left">${s.guessesLeft}번 남음</i>` : '');
      this.hintEl.className = `cd-hint t-${s.turnTeam}`;
    }

    const gridKey = s.cards.map((c) => `${c.word}:${c.revealed ? 1 : 0}:${c.color ?? '-'}`).join('|')
      + `#${canGuess}`;
    if (gridKey !== this.gridKey) { this.gridKey = gridKey; this.drawGrid(s, canGuess); }

    const actionKey = [s.phase, s.turnTeam, me?.team ?? '', me?.spymaster ?? '',
      s.isSpectator, s.guessesLeft, s.winner ?? ''].join('|');
    if (actionKey !== this.actionKey) { this.actionKey = actionKey; this.drawAction(s, me, myTurn); }

    if (this.rejectText && performance.now() > this.rejectUntil) this.rejectText = '';
    const notice = this.rejectText || s.news;
    this.noticeEl.textContent = notice;
    this.noticeEl.classList.toggle('is-bad', !!this.rejectText);
    this.noticeEl.hidden = !notice;
  }

  // ------------------------------------------------

  private drawTop(s: CdRenderState, me: SyncPlayer | null): void {
    const left = s.deadline > 0 && s.phase !== 'over'
      ? Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000)) : null;
    const myRole = s.isSpectator ? '관전'
      : me ? `${TEAM_LABEL[me.team]} 팀 · ${me.spymaster ? '스파이마스터' : '요원'}` : '';
    this.topEl.innerHTML = `
      <div class="cd-turn t-${s.turnTeam}">${
        s.winner ? `${TEAM_LABEL[s.winner]} 팀 승리!`
          : `${TEAM_LABEL[s.turnTeam]} 팀 차례 · ${s.phase === 'hint' ? '힌트 생각 중' : '카드 찾는 중'}`
      }${left !== null ? ` <span class="cd-timer${left <= 10 ? ' is-hot' : ''}">${left}초</span>` : ''}</div>
      <div class="cd-counts">
        <span class="cd-count t-red">빨강 ${s.left.red}</span>
        <span class="cd-count t-blue">파랑 ${s.left.blue}</span>
        ${myRole ? `<span class="cd-me">${escapeHtml(myRole)}</span>` : ''}
      </div>`;
  }

  private drawGrid(s: CdRenderState, canGuess: boolean): void {
    this.gridEl.style.setProperty('--cd-cols', String(COLS));
    this.gridEl.innerHTML = s.cards.map((c, i) => {
      const cls = ['cd-card'];
      if (c.color) cls.push(`c-${c.color}`);      // 색을 아는 사람에게만 붙는다
      if (c.revealed) cls.push('is-open');
      if (!canGuess || c.revealed) cls.push('is-locked');
      return `<button class="${cls.join(' ')}" data-idx="${i}">${escapeHtml(c.word)}</button>`;
    }).join('');
  }

  private drawAction(s: CdRenderState, me: SyncPlayer | null, myTurn: boolean): void {
    if (s.phase === 'over') {
      this.actionEl.innerHTML = '<span class="cd-hint-txt">곧 결과가 나와요…</span>';
      return;
    }
    if (s.isSpectator || !me) {
      this.actionEl.innerHTML = '<span class="cd-hint-txt">관전 중이에요 · 정답이 다 보여요</span>';
      return;
    }
    if (!myTurn) {
      this.actionEl.innerHTML = `<span class="cd-hint-txt">${
        TEAM_LABEL[s.turnTeam]} 팀이 ${s.phase === 'hint' ? '힌트를 생각하는 중' : '카드를 찾는 중'}…</span>`;
      return;
    }
    if (me.spymaster) {
      if (s.phase === 'hint') { this.drawHintForm(); return; }
      this.actionEl.innerHTML = '<span class="cd-hint-txt">팀원들이 찍는 중 · 표정 관리!</span>';
      return;
    }
    if (s.phase === 'guess') {
      this.actionEl.innerHTML = `
        <span class="cd-hint-txt">카드를 눌러요 · ${s.guessesLeft}번 남음</span>
        <button class="cd-btn ghost" id="cd-pass">넘기기</button>`;
      this.actionEl.querySelector('#cd-pass')!.addEventListener('click', () => this.cb.onPass());
      return;
    }
    this.actionEl.innerHTML = '<span class="cd-hint-txt">우리 스파이마스터를 기다리는 중…</span>';
  }

  private drawHintForm(): void {
    this.actionEl.innerHTML = `
      <form class="cd-form" id="cd-form" autocomplete="off">
        <input class="cd-input" id="cd-word" type="text" maxlength="12" placeholder="힌트 한 단어" />
        <select class="cd-num" id="cd-num">${
          [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<option value="${n}">${n}</option>`).join('')}</select>
        <button type="submit" class="cd-btn">힌트 주기</button>
      </form>`;
    const form = this.actionEl.querySelector<HTMLFormElement>('#cd-form')!;
    const word = this.actionEl.querySelector<HTMLInputElement>('#cd-word')!;
    const num = this.actionEl.querySelector<HTMLSelectElement>('#cd-num')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = word.value.trim();
      if (!v) return;
      this.cb.onHint(v, Number(num.value));
      word.value = '';
    });
    // 채팅 등 다른 곳을 치고 있으면 포커스를 뺏지 않는다
    const a = document.activeElement;
    if (!a || a === document.body || this.root.contains(a)) {
      window.setTimeout(() => word.focus(), 40);
    }
  }
}

/* 팀 색(빨강/파랑)은 이 게임의 정체성이라 여기서 정한다. 나머지는 theme.css 변수 */
const CSS = `
.cd-screen{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:safe center;gap:8px;padding:10px 12px;box-sizing:border-box;overflow:auto;
  font-family:var(--font-sans);color:var(--text-main);}

.cd-top{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:5px;}
.cd-turn{font-size:15px;font-weight:900;padding:3px 14px;border-radius:var(--radius-full);}
.cd-turn.t-red{color:#b3261e;background:#fdeaea;}
.cd-turn.t-blue{color:#1b4fa8;background:#e8f0fd;}
.cd-timer{font-size:12.5px;font-weight:800;margin-left:6px;opacity:.8;}
.cd-timer.is-hot{color:var(--danger);}
.cd-counts{display:flex;gap:7px;align-items:center;}
.cd-count{font-size:12px;font-weight:900;padding:2px 10px;border-radius:var(--radius-full);}
.cd-count.t-red{color:#b3261e;background:#fdeaea;}
.cd-count.t-blue{color:#1b4fa8;background:#e8f0fd;}
.cd-me{font-size:11.5px;font-weight:800;color:var(--text-muted);
  background:var(--bg-inset);border:1px solid var(--border-soft);
  padding:2px 10px;border-radius:var(--radius-full);}

/* 지금 걸린 힌트 — 이 게임에서 제일 중요한 한 줄 */
.cd-hint{flex:0 0 auto;display:flex;align-items:center;gap:9px;padding:6px 18px;
  border-radius:var(--radius-full);font-size:16px;}
.cd-hint[hidden]{display:none;}
.cd-hint b{font-weight:900;}
.cd-hint span{font-weight:900;background:rgba(255,255,255,.75);border-radius:var(--radius-full);
  padding:1px 10px;}
.cd-hint .cd-left{font-style:normal;font-size:11.5px;font-weight:800;opacity:.75;}
.cd-hint.t-red{background:#fdeaea;color:#b3261e;}
.cd-hint.t-blue{background:#e8f0fd;color:#1b4fa8;}

/* 5×5 격자 */
.cd-grid{flex:0 1 auto;display:grid;grid-template-columns:repeat(var(--cd-cols,5),1fr);
  gap:6px;width:100%;max-width:720px;}
.cd-card{font:inherit;font-size:clamp(12px,1.6vw,15px);font-weight:800;
  min-height:clamp(44px,7.2vh,62px);padding:4px 6px;border-radius:var(--radius-sm);
  background:#fffdf4;border:2px solid #e8e0cc;color:#3c3730;cursor:default;
  display:flex;align-items:center;justify-content:center;text-align:center;word-break:keep-all;
  transition:transform .12s,box-shadow .12s;}
/* 색을 아는 사람(스파이마스터·관전자)에게만 옅게 깔린다 */
.cd-card.c-red{background:#fde3e1;border-color:#f0b4ae;}
.cd-card.c-blue{background:#e4edfd;border-color:#aec4ef;}
.cd-card.c-neutral{background:#f6f1e4;border-color:#ddd2b8;}
.cd-card.c-assassin{background:#3a3340;border-color:#241f29;color:#fff;}
/* 뒤집힌 카드 — 전원에게 같은 색으로 보인다 */
.cd-card.is-open{color:#fff;border-color:transparent;font-weight:900;}
.cd-card.is-open.c-red{background:#d3392f;}
.cd-card.is-open.c-blue{background:#2563c9;}
.cd-card.is-open.c-neutral{background:#b9ad92;}
.cd-card.is-open.c-assassin{background:#241f29;}
.cd-card:not(.is-locked){cursor:pointer;}
.cd-card:not(.is-locked):hover{transform:translateY(-2px);box-shadow:0 4px 10px rgba(0,0,0,.16);}

.cd-notice{flex:0 0 auto;font-size:12.5px;font-weight:700;color:var(--text-muted);text-align:center;}
.cd-notice.is-bad{color:var(--danger);}
.cd-notice[hidden]{display:none;}

.cd-action{flex:0 0 auto;display:flex;gap:7px;align-items:center;justify-content:center;
  width:100%;max-width:520px;}
.cd-hint-txt{font-size:12.5px;color:var(--text-muted);}
.cd-form{display:flex;gap:6px;align-items:center;width:100%;}
.cd-input{flex:1 1 0;min-width:0;padding:9px 15px;border:1.5px solid var(--border);
  border-radius:var(--radius-full);font:inherit;font-size:14px;background:var(--bg-inset);
  color:var(--text-main);outline:none;}
.cd-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(63,179,162,.20);}
.cd-num{font:inherit;font-size:14px;font-weight:800;padding:8px 10px;border-radius:var(--radius-md);
  border:1.5px solid var(--border);background:var(--bg-inset);color:var(--text-main);}
.cd-btn{font:inherit;font-weight:800;font-size:13.5px;color:#fff;background:var(--accent);
  border:none;border-radius:var(--radius-full);padding:9px 16px;cursor:pointer;white-space:nowrap;}
.cd-btn:hover{background:var(--accent-hover);}
.cd-btn.ghost{background:transparent;color:var(--text-muted);border:1.5px solid var(--border);}
.cd-btn.ghost:hover{background:var(--bg-subtle);}
`;
