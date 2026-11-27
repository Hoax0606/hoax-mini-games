/**
 * 노 터치 크라켄 렌더러 (HTML DOM — 카드 격자와 클릭이라 캔버스를 안 쓴다)
 *
 * 화면은 위에서 아래로:
 *   · 라운드 / 남은 뒤집기 / 남은 시간
 *   · 찾은 보물 · 내 역할 · 내 패 구성
 *   · 사람별 카드 줄 (뒷면 + 이번 라운드에 공개된 것)
 *   · 소식 한 줄
 *
 * 가리는 건 전부 호스트가 한다 (netSync 주석 참고). 여기선 받은 데이터를 그대로 그린다.
 * `counts` 가 들어 있는 자리 = 내 자리이거나 내가 관전자라는 뜻.
 */

import type { SyncSeat, KrPhase } from './netSync';
import { ROLE_LABEL, ROUNDS, type CardKind, type Role } from './rules';
import { escapeHtml } from '../../ui/escape';

export interface KrRenderState {
  seats: SyncSeat[];
  round: number;
  actionsLeft: number;
  turn: string;
  phase: KrPhase;
  found: { treasure: number; futile: number; kraken: number };
  totalTreasure: number;
  deadline: number;
  news: string;
  winner: Role | null;
  myPeerId: string;
  isSpectator: boolean;
}

export interface KrCallbacks {
  onFlip(targetPeerId: string, index: number): void;
}

export class KrakenRenderer {
  private canvas: HTMLCanvasElement;
  private cb: KrCallbacks;
  private root: HTMLDivElement;
  private styleEl: HTMLStyleElement;

  private topEl: HTMLDivElement;
  private tableEl: HTMLDivElement;
  private noticeEl: HTMLDivElement;

  private tableKey = '';

  constructor(canvas: HTMLCanvasElement, cb: KrCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    canvas.style.display = 'none';

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'kr-screen';
    this.root.innerHTML = `
      <div class="kr-top" id="kr-top"></div>
      <div class="kr-table" id="kr-table"></div>
      <div class="kr-notice" id="kr-notice" hidden></div>
    `;
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.root);
    }
    const q = <T extends HTMLElement>(id: string): T => this.root.querySelector<T>('#' + id)!;
    this.topEl = q('kr-top');
    this.tableEl = q('kr-table');
    this.noticeEl = q('kr-notice');

    // 클릭은 테이블에 한 번만 건다 (매번 다시 그려도 핸들러가 안 샌다)
    this.tableEl.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-t]');
      if (!el || el.classList.contains('is-locked')) return;
      this.cb.onFlip(el.dataset['t']!, Number(el.dataset['i']));
    });
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  render(s: KrRenderState): void {
    const me = s.seats.find((p) => p.peerId === s.myPeerId) ?? null;
    const canFlip = !!me && !me.gone && s.turn === s.myPeerId && s.phase === 'play';

    this.drawTop(s, me); // 타이머가 매 프레임 줄어서 여기는 항상 다시 그린다

    const key = s.seats.map((p) =>
      [p.peerId, p.hidden, p.opened.join(''), p.gone ? 1 : 0, p.role ?? '-',
        p.counts ? `${p.counts.treasure}/${p.counts.kraken}` : '-'].join(':'),
    ).join('|') + `#${s.turn}#${canFlip}#${s.phase}`;
    if (key !== this.tableKey) { this.tableKey = key; this.drawTable(s, canFlip); }

    this.noticeEl.textContent = s.news;
    this.noticeEl.hidden = !s.news;
  }

  // ------------------------------------------------

  private drawTop(s: KrRenderState, me: SyncSeat | null): void {
    const left = s.deadline > 0 && s.phase === 'play'
      ? Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000)) : null;
    const turnName = s.seats.find((p) => p.peerId === s.turn)?.nickname ?? '';
    const head = s.winner
      ? `${ROLE_LABEL[s.winner]} 승리!`
      : s.turn === s.myPeerId
        ? '내 차례 — 남의 카드를 한 장 뒤집어요'
        : `${escapeHtml(turnName)} 님 차례`;

    const mine = me?.counts
      ? `내 패 ${me.hidden}장 · 보물 ${me.counts.treasure}${me.counts.kraken > 0 ? ' · 크라켄 있음' : ''}`
      : '';

    this.topEl.innerHTML = `
      <div class="kr-turn${s.turn === s.myPeerId && !s.winner ? ' is-mine' : ''}">${head}${
        left !== null ? ` <span class="kr-timer${left <= 10 ? ' is-hot' : ''}">${left}초</span>` : ''
      }</div>
      <div class="kr-chips">
        <span class="kr-chip">${s.round}/${ROUNDS} 라운드</span>
        ${s.phase === 'play' ? `<span class="kr-chip">이 라운드 ${s.actionsLeft}번 남음</span>` : ''}
        <span class="kr-chip c-treasure">보물 ${s.found.treasure}/${s.totalTreasure}</span>
        ${s.isSpectator
          ? '<span class="kr-chip c-spec">관전 · 전부 보여요</span>'
          : me?.role
            ? `<span class="kr-chip r-${me.role}">${ROLE_LABEL[me.role]}</span>` : ''}
        ${mine ? `<span class="kr-chip c-mine">${mine}</span>` : ''}
      </div>`;
  }

  private drawTable(s: KrRenderState, canFlip: boolean): void {
    this.tableEl.innerHTML = s.seats.map((p) => {
      const isMe = p.peerId === s.myPeerId;
      const cls = ['kr-seat'];
      if (p.peerId === s.turn && s.phase === 'play') cls.push('is-turn');
      if (isMe) cls.push('is-me');
      if (p.gone) cls.push('is-gone');

      // 남의 뒷면 카드만 누를 수 있다 (내 카드는 못 뒤집는 게 규칙)
      const clickable = canFlip && !isMe && !p.gone;
      const backs = Array.from({ length: p.hidden }, (_, i) =>
        `<button class="kr-card is-back${clickable ? '' : ' is-locked'}" data-t="${p.peerId}" data-i="${i}">${BACK_SVG}</button>`,
      ).join('');
      const opened = p.opened.map((c) => `<div class="kr-card is-open c-${c}">${FACE[c]}</div>`).join('');

      // counts 가 있으면 = 내 자리거나 내가 관전자(또는 게임 끝). 그 사람 패 구성을 이름 옆에 적는다.
      // 다만 **게임 중 내 자리에는 안 적는다** — 같은 내용이 위 칩에 이미 있어서 중복인 데다,
      // 화면에 두 군데 뜨면 옆 사람한테 들킬 면만 넓어진다.
      const hideMine = isMe && s.phase === 'play';
      const tag = p.counts && !hideMine
        ? `<em class="kr-cnt">보물 ${p.counts.treasure}${p.counts.kraken > 0 ? ' · 크라켄' : ''}</em>`
        : '';
      const role = p.role && !hideMine ? `<em class="kr-role r-${p.role}">${ROLE_LABEL[p.role]}</em>` : '';

      return `<div class="${cls.join(' ')}">
        <div class="kr-name"><b>${escapeHtml(p.nickname)}</b>${role}${tag}${p.gone ? '<em class="kr-out">나감</em>' : ''}</div>
        <div class="kr-cards">${backs}${opened ? `<span class="kr-sep"></span>${opened}` : ''}</div>
      </div>`;
    }).join('');
  }
}

/* 카드 뒷면 — 나침반 별. 앞면 세 종류와 확실히 구분되게 선만 쓴다 */
const BACK_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M12 3l3.1 5.9L21 12l-5.9 3.1L12 21l-3.1-5.9L3 12l5.9-3.1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
<circle cx="12" cy="12" r="1.7" fill="currentColor"/></svg>`;

const FACE: Record<CardKind, string> = {
  treasure: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M7 4.5h10l4 5-9 10.5L3 9.5z" fill="#ffd454" stroke="#c49a1f" stroke-width="1.5" stroke-linejoin="round"/>
<path d="M3 9.5h18" stroke="#c49a1f" stroke-width="1.2" opacity=".8"/>
<path d="M9.5 4.5L7.5 9.5 12 20M14.5 4.5l2 5L12 20" fill="none" stroke="#c49a1f" stroke-width="1.1" opacity=".65"/></svg>`,

  futile: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M3 8.5c2-1.8 4-1.8 6 0s4 1.8 6 0 4-1.8 6 0M3 13c2-1.8 4-1.8 6 0s4 1.8 6 0 4-1.8 6 0M3 17.5c2-1.8 4-1.8 6 0s4 1.8 6 0 4-1.8 6 0"
 fill="none" stroke="#a9c6c1" stroke-width="1.7" stroke-linecap="round"/></svg>`,

  kraken: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M12 3.2c3.4 0 5.9 2.4 5.9 5.5 0 1.5-.5 2.6-1.2 3.4H7.3c-.7-.8-1.2-1.9-1.2-3.4 0-3.1 2.5-5.5 5.9-5.5z" fill="#5b4a7d"/>
<path d="M7.5 12.4c-.5 2.3-1.8 3.4-3.6 3.7M10.3 12.4c-.5 2.9-.2 4.9.8 6.3M13.7 12.4c.5 2.9.2 4.9-.8 6.3M16.5 12.4c.5 2.3 1.8 3.4 3.6 3.7"
 fill="none" stroke="#5b4a7d" stroke-width="1.7" stroke-linecap="round"/>
<circle cx="10" cy="8.3" r="1" fill="#fff"/><circle cx="14" cy="8.3" r="1" fill="#fff"/></svg>`,
};

/* 역할색(탐험대=민트 / 해적=자주)과 카드 앞면색은 이 게임의 정체성이라 여기서 정한다.
   나머지는 theme.css 변수 */
const CSS = `
.kr-screen{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:safe center;gap:10px;padding:10px 12px;box-sizing:border-box;overflow:auto;
  font-family:var(--font-sans);color:var(--text-main);}

.kr-top{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:6px;}
.kr-turn{font-size:15px;font-weight:900;padding:3px 15px;border-radius:var(--radius-full);
  background:var(--bg-inset);border:1px solid var(--border-soft);}
.kr-turn.is-mine{background:var(--highlight-soft);border-color:var(--highlight);
  color:var(--highlight-ink);}
.kr-timer{font-size:12.5px;font-weight:800;margin-left:6px;opacity:.8;}
.kr-timer.is-hot{color:var(--danger);}

.kr-chips{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:center;}
.kr-chip{font-size:11.5px;font-weight:800;padding:2px 10px;border-radius:var(--radius-full);
  background:var(--bg-inset);border:1px solid var(--border-soft);color:var(--text-muted);}
.kr-chip.c-treasure{color:#8e6f10;background:#fff4d2;border-color:#f0dca0;}
.kr-chip.c-mine{color:var(--text-main);background:var(--bg-card);}
.kr-chip.c-spec{color:var(--text-muted);}
.kr-chip.r-crew,.kr-role.r-crew{color:#1f6a55;background:#dff5ec;border-color:#a9dfcc;}
.kr-chip.r-pirate,.kr-role.r-pirate{color:#4a3a68;background:#ece6f7;border-color:#c9b9e8;}

/* 사람별 자리 — 6명까지라 자동으로 2~3열이 된다 */
/* 한 자리에 카드 5장이 한 줄로 들어가는 폭(최소 250px)을 지켜야 라운드 1 에서 안 접힌다 */
.kr-table{flex:0 1 auto;display:grid;gap:9px;width:100%;max-width:820px;
  grid-template-columns:repeat(auto-fit,minmax(250px,1fr));}
.kr-seat{display:flex;flex-direction:column;gap:5px;padding:8px 10px;
  background:var(--bg-card);border:2px solid var(--border-soft);border-radius:var(--radius-md);}
.kr-seat.is-me{border-color:var(--accent);}
.kr-seat.is-turn{border-color:var(--highlight);background:var(--highlight-soft);}
.kr-seat.is-gone{opacity:.5;}

.kr-name{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:12.5px;}
.kr-name b{font-weight:900;}
.kr-role,.kr-cnt,.kr-out{font-style:normal;font-size:10.5px;font-weight:800;
  padding:1px 7px;border-radius:var(--radius-full);border:1px solid transparent;}
.kr-cnt{color:var(--text-muted);background:var(--bg-inset);border-color:var(--border-soft);}
.kr-out{color:var(--danger);background:var(--danger-soft);}

.kr-cards{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-height:60px;}
.kr-sep{width:1px;align-self:stretch;margin:2px 3px;background:var(--border);}
.kr-card{width:clamp(30px,3vw,40px);aspect-ratio:5/7;padding:0;border-radius:7px;
  display:flex;align-items:center;justify-content:center;box-sizing:border-box;
  transition:transform .12s,box-shadow .12s;}
.kr-card svg{width:72%;height:72%;display:block;}

/* 뒷면 — 단단한 청록 카드. 누를 수 있을 때만 떠오른다 */
.kr-card.is-back{background:var(--teal-100);border:2px solid var(--teal-300);
  color:var(--teal-500);cursor:default;}
.kr-card.is-back:not(.is-locked){cursor:pointer;}
.kr-card.is-back:not(.is-locked):hover{transform:translateY(-4px);
  box-shadow:0 5px 12px rgba(0,0,0,.2);border-color:var(--accent);}

/* 앞면 — 공개돼서 판에서 빠진 카드 */
.kr-card.is-open{border:2px solid var(--border-soft);background:var(--bg-inset);}
.kr-card.is-open.c-treasure{background:#fff6dc;border-color:#f0dca0;}
.kr-card.is-open.c-kraken{background:#ece6f7;border-color:#c9b9e8;}

.kr-notice{flex:0 0 auto;font-size:12.5px;font-weight:700;color:var(--text-muted);
  text-align:center;max-width:720px;}
.kr-notice[hidden]{display:none;}
`;
