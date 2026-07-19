/**
 * 블루마블 HTML 렌더러. 캔버스 대신 부모(ctx.canvas.parentElement)에 DOM 보드를 마운트한다.
 *   - 보드는 constructor 에서 1회 생성, render(state) 에서 동적 부분(건물/말/센터/패널/모달)만 갱신.
 *   - 결정 모달(구매/건설/인수/카드)은 state.pending + 현재 차례가 나인지로 표시.
 *   - 아이콘/건물은 전부 인라인 SVG (프로젝트 방침: 이모지 X).
 */

import {
  BOARD, BUILD_TYPES, ISLAND_TILES, BASE_TOLL_MUL,
  buildMeta, buildCostOf, acquireCost, islandCount, hasAllHouses,
  type BMState, type BuildKind, type GroupColor,
} from './rules';

export interface BMRenderCallbacks {
  onRoll(): void;
  onDecision(accept: boolean): void;   // 구매/인수 예/아니오
  onBuild(kind: BuildKind): void;       // 건물 하나 건설
  onBuildDone(): void;                  // 건설 메뉴 완료
  onCard(keep: boolean): void;          // 황금열쇠 보관/사용
  onUseHeld(cardId: number): void;
  /** 주사위·이동 시퀀스가 끝나 화면이 idle 이 됨(호스트가 더미 진행 타이밍에 사용) */
  onSettled(): void;
}

const GROUP: Record<GroupColor, string> = {
  tan: '#d9b38c', sky: '#8fc2f0', pink: '#ff9bbb', orange: '#ffb27a', red: '#ff8a8a',
  yellow: '#f2d24c', green: '#8fe0b0', rose: '#e79ad0', teal: '#7fd6d0', navy: '#8a9ef0',
};
const ISLAND_BG = '#7fcdd8';
const tileColor = (i: number): string => {
  const t = BOARD[i];
  return t.type === 'island' ? ISLAND_BG : t.type === 'city' ? GROUP[t.group] : '#ccc';
};

// ── 아이콘 (코너/특수/카드) ──
const IC: Record<string, string> = {
  flag: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="2.2" height="18" rx="1.1" fill="#8a7a8a"/><path d="M7.2 4 H18 L15 8 L18 12 H7.2 Z" fill="#57c777" stroke="#3f9e57" stroke-width="0.6"/></svg>',
  island: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="19" rx="9" ry="2.6" fill="#f2d24c"/><path d="M11.5 18 V9" stroke="#8a6a4a" stroke-width="1.8"/><path d="M11.5 8.5 C8.5 6 6 7 4.5 9.5 C7.5 8.5 9 9.5 11.5 9.5 C14 7 17 7 19 9.5 C17 6 14 6 11.5 8.5Z" fill="#57c777"/></svg>',
  gift: '<svg viewBox="0 0 24 24"><rect x="4.5" y="10" width="15" height="10" rx="1.5" fill="#ff9bbb"/><rect x="4.5" y="8" width="15" height="4" rx="1" fill="#ff7aa5"/><rect x="10.5" y="8" width="3" height="12" fill="#fff" opacity=".85"/><path d="M12 8 C10 4.5 6.5 5.5 8 8 M12 8 C14 4.5 17.5 5.5 16 8" stroke="#ff7aa5" stroke-width="1.6" fill="none"/></svg>',
  rocket: '<svg viewBox="0 0 24 24"><path d="M12 2.5 C16 5.5 16 11 14 15 H10 C8 11 8 5.5 12 2.5Z" fill="#9cc6f2" stroke="#5b9be6" stroke-width="1"/><circle cx="12" cy="8" r="1.9" fill="#fff"/><path d="M10 14 L7.5 18.5 L10.2 16.5Z M14 14 L16.5 18.5 L13.8 16.5Z" fill="#ff8a5b"/><path d="M11 15 h2 l-1 4.5Z" fill="#ffb845"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8.5" cy="8.5" r="4.6" fill="none" stroke="#f2c94c" stroke-width="2.6"/><path d="M11.5 11.5 L19 19 M16 16 l2 2 M18.5 13.5 l1.5 1.5" stroke="#f2c94c" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>',
  coin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="#f2c94c" stroke="#d9a93c" stroke-width="1.3"/><text x="12" y="16" font-size="11" font-weight="900" fill="#8a5a00" text-anchor="middle" font-family="sans-serif">₩</text></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M9 5.5 L18 3.5 V15" stroke="#b89aff" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="7" cy="16.5" r="2.7" fill="#b89aff"/><circle cx="16" cy="15" r="2.7" fill="#b89aff"/></svg>',
  cake: '<svg viewBox="0 0 24 24"><rect x="5" y="12" width="14" height="8" rx="1.5" fill="#ff9bbb"/><rect x="5" y="12" width="14" height="3" fill="#fff" opacity=".7"/><rect x="11.2" y="6" width="1.6" height="4" fill="#ffd454"/><circle cx="12" cy="5" r="1.4" fill="#ff8a3b"/></svg>',
  ticket: '<svg viewBox="0 0 24 24"><path d="M4 8 h16 v3 a2 2 0 0 0 0 2 v3 h-16 v-3 a2 2 0 0 0 0-2Z" fill="#8fe0c3" stroke="#4fbf9a" stroke-width="1"/><path d="M11 8 v8" stroke="#4fbf9a" stroke-width="1" stroke-dasharray="2 2"/></svg>',
  cross: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4.5" fill="#ff8a8a"/><path d="M12 8 v8 M8 12 h8" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
  siren: '<svg viewBox="0 0 24 24"><rect x="5" y="18" width="14" height="3" rx="1.2" fill="#5b9be6"/><path d="M7 18 C7 12 9 9 12 9 C15 9 17 12 17 18Z" fill="#ff5a5a"/><rect x="11" y="5" width="2" height="3.4" rx="1" fill="#ff5a5a"/></svg>',
  dice: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4.5" fill="#fff" stroke="#c9b7d6" stroke-width="1.6"/><g fill="#ff5a92"><circle cx="8.5" cy="8.5" r="1.7"/><circle cx="15.5" cy="8.5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="8.5" cy="15.5" r="1.7"/><circle cx="15.5" cy="15.5" r="1.7"/></g></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#57c777"/><path d="M8 12.5 L11 15.5 L16.5 9" stroke="#fff" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12 H17 M13 8 L17 12 L13 16" stroke="#9a8a9a" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
/** 특수/코너 칸 → 아이콘 키 */
function tileIcon(i: number): string {
  const t = BOARD[i];
  if (t.type === 'corner') return { start: 'flag', desert: 'island', welfare: 'gift', space: 'rocket' }[t.kind];
  if (t.type === 'special') return t.kind === 'goldkey' ? 'key' : t.kind === 'tax' ? 'coin' : 'music';
  return '';
}
/** 카드 id → 아이콘 키 */
const CARD_IC = ['coin', 'cake', 'ticket', 'cross', 'siren', 'flag', 'ticket', 'island', 'rocket'];

// ── 건물 SVG (소유자 색 currentColor) ──
const BSVG: Record<string, string> = {
  villa: '<svg viewBox="0 0 24 24" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"><rect x="6" y="13" width="12" height="8" fill="currentColor"/><path d="M4.5 13 L12 6.5 L19.5 13 Z" fill="currentColor"/><path d="M4.5 13 L12 6.5 L19.5 13 Z" fill="rgba(0,0,0,.15)" stroke="none"/><rect x="10.4" y="16" width="3.2" height="5" fill="#fff" stroke="none"/></svg>',
  house2: '<svg viewBox="0 0 24 24" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"><rect x="6.5" y="9" width="11" height="12" fill="currentColor"/><path d="M5 9 L12 3.5 L19 9 Z" fill="currentColor"/><path d="M5 9 L12 3.5 L19 9 Z" fill="rgba(0,0,0,.15)" stroke="none"/><g fill="#fff" stroke="none"><rect x="8" y="10.5" width="2.3" height="2.3"/><rect x="13.7" y="10.5" width="2.3" height="2.3"/></g><rect x="10.6" y="16" width="2.8" height="5" fill="#fff" stroke="none"/></svg>',
  apt: '<svg viewBox="0 0 24 24" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"><rect x="6" y="4" width="12" height="17" fill="currentColor"/><g fill="#fff" stroke="none" opacity=".95"><rect x="8" y="6" width="2.2" height="2.2"/><rect x="13.8" y="6" width="2.2" height="2.2"/><rect x="8" y="10" width="2.2" height="2.2"/><rect x="13.8" y="10" width="2.2" height="2.2"/><rect x="8" y="14" width="2.2" height="2.2"/><rect x="13.8" y="14" width="2.2" height="2.2"/></g><rect x="10.4" y="17.5" width="3.2" height="3.5" fill="#fff" stroke="none"/></svg>',
};
const GENERIC_LM = '<svg viewBox="0 0 24 24" stroke="#fff" stroke-width="0.9" stroke-linejoin="round"><path d="M12 1 L14 5.5 H10 Z" fill="#ffd454" stroke="#fff" stroke-width="0.6"/><rect x="8.5" y="6" width="7" height="15" fill="currentColor"/><rect x="8.5" y="6" width="7" height="2.6" fill="#ffd454" stroke="none"/><rect x="6" y="18" width="12" height="3" fill="currentColor"/><g fill="#fff" stroke="none" opacity=".9"><rect x="10" y="10" width="4" height="2"/><rect x="10" y="13.5" width="4" height="2"/></g></svg>';
const LM_ATTR = 'viewBox="0 0 24 24" stroke="#fff" stroke-width="0.9" stroke-linejoin="round"';
const LANDMARK: Record<string, string> = {
  '카이로': `<svg ${LM_ATTR}><path d="M12 3 L21 21 H3 Z" fill="currentColor"/><path d="M12 3 L12 21" stroke="rgba(0,0,0,.14)"/></svg>`,
  '아테네': `<svg ${LM_ATTR}><path d="M3 9 L12 4 L21 9 Z" fill="currentColor"/><g fill="currentColor" stroke="none"><rect x="5" y="10.5" width="2.2" height="8.5"/><rect x="9" y="10.5" width="2.2" height="8.5"/><rect x="12.8" y="10.5" width="2.2" height="8.5"/><rect x="16.8" y="10.5" width="2.2" height="8.5"/></g><rect x="3.5" y="19" width="17" height="2" fill="currentColor"/></svg>`,
  '로마': `<svg ${LM_ATTR}><rect x="3.5" y="8" width="17" height="12.5" rx="4" fill="currentColor"/><g fill="#fff" stroke="none" opacity=".85"><rect x="5.5" y="10" width="2.2" height="3.4" rx="1"/><rect x="9" y="10" width="2.2" height="3.4" rx="1"/><rect x="12.8" y="10" width="2.2" height="3.4" rx="1"/><rect x="16.3" y="10" width="2.2" height="3.4" rx="1"/></g></svg>`,
  '파리': `<svg ${LM_ATTR}><path d="M12 2 L14.6 21 H13 L12.5 16 H11.5 L11 21 H9.4 Z" fill="currentColor"/><path d="M9.5 15 H14.5" stroke="currentColor" stroke-width="1.4"/><path d="M8.2 20.5 Q12 16 15.8 20.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
  '런던': `<svg ${LM_ATTR}><rect x="9" y="7" width="6" height="14" fill="currentColor"/><path d="M8.5 7 L12 2.5 L15.5 7 Z" fill="currentColor"/><circle cx="12" cy="10" r="2.1" fill="#fff" stroke="none"/></svg>`,
  '시드니': `<svg ${LM_ATTR}><path d="M2.5 20 Q6 8 9 20 Z" fill="currentColor"/><path d="M7 20 Q12 5 15 20 Z" fill="currentColor"/><path d="M12.5 20 Q17.5 9 21.5 20 Z" fill="currentColor"/><rect x="2" y="20" width="20" height="1.8" fill="currentColor"/></svg>`,
  '리우': `<svg ${LM_ATTR}><path d="M6 21 Q12 17 18 21 Z" fill="currentColor"/><rect x="11.3" y="6" width="1.4" height="10" fill="currentColor" stroke="none"/><rect x="7" y="8.5" width="10" height="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="4.5" r="1.7" fill="currentColor"/></svg>`,
  '도쿄': `<svg ${LM_ATTR}><path d="M12 2 L15 21 H13 L12.5 16 H11.5 L11 21 H9 Z" fill="currentColor"/><path d="M10 14 H14" stroke="currentColor" stroke-width="1.2"/><rect x="11.2" y="2" width="1.6" height="2.5" fill="#ffd454" stroke="none"/></svg>`,
  '뉴욕': `<svg ${LM_ATTR}><rect x="9" y="18" width="6" height="3.5" fill="currentColor"/><path d="M10 18 L10.8 9 H13.2 L14 18 Z" fill="currentColor"/><circle cx="12" cy="6.5" r="2" fill="currentColor"/><g fill="currentColor" stroke="none"><rect x="11.6" y="2.5" width="0.8" height="2"/><rect x="10" y="3.5" width="0.8" height="1.6"/><rect x="13.2" y="3.5" width="0.8" height="1.6"/></g></svg>`,
  '서울': `<svg ${LM_ATTR}><rect x="11.2" y="9" width="1.6" height="12" fill="currentColor" stroke="none"/><ellipse cx="12" cy="8.5" rx="4" ry="2.4" fill="currentColor"/><rect x="11.4" y="2.5" width="1.2" height="4" fill="currentColor" stroke="none"/><path d="M8 21 H16" stroke="currentColor" stroke-width="1.4"/></svg>`,
  '이스탄불': `<svg ${LM_ATTR}><path d="M6 20 V13 Q6 8 12 8 Q18 8 18 13 V20 Z" fill="currentColor"/><path d="M12 8 V4.5" stroke="currentColor" stroke-width="1"/><circle cx="12" cy="4" r="1" fill="currentColor"/><rect x="3.5" y="10" width="1.8" height="10" fill="currentColor"/><rect x="18.7" y="10" width="1.8" height="10" fill="currentColor"/></svg>`,
  '베이징': `<svg ${LM_ATTR}><path d="M4 8 L12 4 L20 8 Z" fill="currentColor"/><path d="M5 13 L12 10 L19 13 Z" fill="currentColor"/><rect x="8" y="13" width="8" height="8" fill="currentColor"/><rect x="11" y="16" width="2" height="5" fill="#fff" stroke="none"/></svg>`,
};
const landmarkSvg = (name: string): string => LANDMARK[name] || GENERIC_LM;

function diceFace(n: number): string {
  const P: Record<number, number[][]> = {
    1: [[12, 12]], 2: [[7.5, 7.5], [16.5, 16.5]], 3: [[7.5, 7.5], [12, 12], [16.5, 16.5]],
    4: [[7.5, 7.5], [16.5, 7.5], [7.5, 16.5], [16.5, 16.5]],
    5: [[7.5, 7.5], [16.5, 7.5], [12, 12], [7.5, 16.5], [16.5, 16.5]],
    6: [[7.5, 7], [16.5, 7], [7.5, 12], [16.5, 12], [7.5, 17], [16.5, 17]],
  };
  return `<svg viewBox="0 0 24 24">${(P[n] || P[1]).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.2" fill="#4a3a4a"/>`).join('')}</svg>`;
}

/** 11×11 그리드에서 칸 index(시계방향, 우하단=출발) → grid cell */
function cell(i: number): { r: number; c: number } {
  if (i <= 10) return { r: 11, c: 11 - i };
  if (i <= 20) return { r: 11 - (i - 10), c: 1 };
  if (i <= 30) return { r: 1, c: 1 + (i - 20) };
  return { r: 1 + (i - 30), c: 11 };
}

const won = (n: number): string => `₩${n.toLocaleString()}`;

export class BlueMarbleRenderer {
  private root: HTMLDivElement;
  private cb: BMRenderCallbacks;
  private lastDice = '';
  private modalScrim: HTMLDivElement | null = null;
  /** 현재 열린 결정 모달의 종류(중복 오픈 방지) */
  private openKind = '';
  private destroyed = false;
  /** 화면에 표시 중인 말 위치 (state.pos 로 한 칸씩 애니메이션) */
  private dispPos: Record<string, number> = {};
  private moveTimer: number | null = null;
  private spinTimer: number | null = null;
  private settleTimer: number | null = null;
  /** 주사위 굴림 → 이동 시퀀스 진행 중이면 결정창 보류 */
  private busy = false;
  private myId = '';
  private spec = false;

  constructor(parent: HTMLElement, cb: BMRenderCallbacks) {
    this.cb = cb;
    injectStyle();
    this.root = document.createElement('div');
    this.root.className = 'bm-root';
    this.root.innerHTML = this.boardHTML();
    parent.appendChild(this.root);
    this.wireStatic();
  }

  destroy(): void {
    this.destroyed = true;
    this.clearMove();
    if (this.spinTimer !== null) window.clearInterval(this.spinTimer);
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.closeModal();
    this.root.remove();
  }

  private clearMove(): void { if (this.moveTimer !== null) { window.clearInterval(this.moveTimer); this.moveTimer = null; } }

  // ── 정적 보드 HTML (1회) ──
  private boardHTML(): string {
    let tiles = '';
    for (let i = 0; i < BOARD.length; i++) {
      const t = BOARD[i];
      const { r, c } = cell(i);
      const style = `grid-row:${r};grid-column:${c}`;
      if (t.type === 'city') {
        tiles += `<div class="bm-tile bm-prop" data-i="${i}" style="${style};background:${GROUP[t.group]}">
          <div class="bm-cinfo"><div class="bm-cnm">${t.name}</div><div class="bm-cpr">${won(t.price)}</div></div></div>`;
      } else if (t.type === 'island') {
        tiles += `<div class="bm-tile bm-prop" data-i="${i}" style="${style};background:${ISLAND_BG}">
          <span class="bm-islandic">${IC.island}</span>
          <div class="bm-cinfo"><div class="bm-cnm">${t.name}</div><div class="bm-cpr">${won(t.price)}</div></div></div>`;
      } else {
        const cls = t.type === 'corner' ? 'bm-corner' : 'bm-special';
        tiles += `<div class="bm-tile ${cls}" data-i="${i}" style="${style}">
          <div class="bm-ic">${IC[tileIcon(i)]}</div><div class="bm-nm">${t.name}</div></div>`;
      }
    }
    const center = `<div class="bm-center">
      <div class="bm-logo">BLUE<br>MARBLE</div>
      <div class="bm-dice"><div class="bm-die" id="bm-d1">${diceFace(1)}</div><div class="bm-die" id="bm-d2">${diceFace(1)}</div></div>
      <div class="bm-turn" id="bm-turn"></div>
      <button class="bm-roll" id="bm-roll">${IC.dice} 주사위 굴리기</button>
      <div class="bm-hint" id="bm-hint"></div>
    </div>`;
    return `<div class="bm-board">${tiles}${center}</div>
      <div class="bm-panel">
        <div class="bm-pcard"><h3>플레이어</h3><div id="bm-players"></div></div>
        <div class="bm-pcard"><h3>내 황금열쇠</h3><div id="bm-held" class="bm-heldlist"></div></div>
      </div>`;
  }

  private wireStatic(): void {
    this.root.querySelector('#bm-roll')!.addEventListener('click', () => this.cb.onRoll());
    // 타일 클릭 → 정보
    this.root.querySelectorAll<HTMLElement>('.bm-prop').forEach((el) => {
      el.addEventListener('click', () => this.infoModal(Number(el.dataset.i)));
    });
  }

  // ============================================
  // render(state)
  // ============================================

  render(state: BMState, myPeerId: string, isSpectator: boolean): void {
    if (this.destroyed) return;
    this._lastState = state; this.myId = myPeerId; this.spec = isSpectator;
    for (const p of state.order) if (this.dispPos[p] === undefined) this.dispPos[p] = state.pos[p]!;

    const key = state.dice ? state.dice.join(',') : '';
    const newRoll = !!state.dice && key !== this.lastDice && !this.busy;

    this.renderTiles(state);
    this.renderCenter(state, myPeerId, isSpectator);
    this.renderPanel(state, myPeerId);
    this.renderHeld(state, myPeerId);

    if (newRoll) { this.lastDice = key; this.startSequence(state); }   // ① 주사위 → ② 이동 → ③ 결정
    else if (!state.dice) { this.lastDice = ''; this.setDie('#bm-d1', 1); this.setDie('#bm-d2', 1); }

    this.renderPending(state, myPeerId, isSpectator);  // busy면 내부에서 보류
    if (state.phase === 'ended') this.showEnd(state, myPeerId);
    if (!this.busy) this.cb.onSettled();   // idle → 더미 진행 트리거
  }

  private setDie(sel: string, n: number): void { const el = this.root.querySelector(sel); if (el) el.innerHTML = diceFace(n); }

  /** ① 주사위 굴림 연출(~600ms) → 끝나면 이동 시퀀스 */
  private startSequence(state: BMState): void {
    this.busy = true; this.clearMove();
    if (this.spinTimer !== null) window.clearInterval(this.spinTimer);
    const d1 = this.root.querySelector<HTMLElement>('#bm-d1')!;
    const d2 = this.root.querySelector<HTMLElement>('#bm-d2')!;
    d1.classList.add('bm-rolling'); d2.classList.add('bm-rolling');
    let t = 0;
    this.spinTimer = window.setInterval(() => {
      if (this.destroyed) { if (this.spinTimer !== null) window.clearInterval(this.spinTimer); return; }
      d1.innerHTML = diceFace(1 + Math.floor(Math.random() * 6));
      d2.innerHTML = diceFace(1 + Math.floor(Math.random() * 6));
      if (++t > 8) {
        window.clearInterval(this.spinTimer!); this.spinTimer = null;
        d1.classList.remove('bm-rolling'); d2.classList.remove('bm-rolling');
        const s = this._lastState!;
        d1.innerHTML = diceFace(s.dice![0]); d2.innerHTML = diceFace(s.dice![1]);
        this.startMoveSeq();  // ② 이동
      }
    }, 65);
  }

  /** ② 말이 칸마다 한 칸씩 이동 → 도착하면 busy 해제 + 전체 리렌더(결정창 표시) */
  private startMoveSeq(): void {
    const s = this._lastState; if (!s) { this.busy = false; return; }
    for (const p of s.order) { const gap = (((s.pos[p]! - this.dispPos[p]!) % 40) + 40) % 40; if (gap > 12) this.dispPos[p] = s.pos[p]!; }
    if (!s.order.some((p) => this.dispPos[p] !== s.pos[p])) { this.settle(); return; }
    this.moveTimer = window.setInterval(() => {
      const st = this._lastState; if (this.destroyed || !st) { this.clearMove(); return; }
      for (const p of st.order) if (this.dispPos[p] !== st.pos[p]) this.dispPos[p] = (this.dispPos[p]! + 1) % 40;
      this.renderTiles(st);
      // 마지막 칸에 도착 → 말이 잠시 머문 뒤에 결정창(구매/황금열쇠) 표시
      if (!st.order.some((p) => this.dispPos[p] !== st.pos[p])) { this.clearMove(); this.settle(); }
    }, 220);
  }

  /** 도착 후 짧은 텀(360ms)을 두고 결정창/배너 표시 — 착지하자마자 모달이 뜨지 않게 */
  private settle(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      if (this.destroyed) return;
      this.busy = false;
      const st = this._lastState; if (st) this.render(st, this.myId, this.spec);
    }, 360);
  }

  private renderTiles(state: BMState): void {
    for (let i = 0; i < BOARD.length; i++) {
      const tile = this.root.querySelector<HTMLElement>(`.bm-tile[data-i="${i}"]`);
      if (!tile) continue;
      tile.querySelector('.bm-blds')?.remove();
      tile.querySelector('.bm-idock')?.remove();
      tile.querySelector('.bm-toks')?.remove();
      const o = state.owner[i];
      const t = BOARD[i];
      if (o !== undefined) {
        const col = colorOf(state, o);
        if (t.type === 'island') {
          const dk = document.createElement('div'); dk.className = 'bm-idock'; dk.style.background = col; tile.appendChild(dk);
        } else if (t.type === 'city') {
          const arr = state.builds[i] ?? [];
          if (arr.length) {
            const b = document.createElement('div'); b.style.color = col;
            if (arr.includes('landmark')) { b.className = 'bm-blds bm-lm'; b.innerHTML = landmarkSvg(t.name); }
            else { b.className = 'bm-blds'; b.innerHTML = arr.map((k) => BSVG[k]).join(''); }
            tile.appendChild(b);
          }
        }
      }
      // 말(구슬) — 표시 위치(dispPos)로
      const here = state.order.filter((p) => (this.dispPos[p] ?? state.pos[p]) === i && !state.players[p]!.bankrupt);
      if (here.length) {
        const tk = document.createElement('div'); tk.className = 'bm-toks';
        tk.innerHTML = here.map((p) => `<span class="bm-tok" style="background:radial-gradient(circle at 34% 30%, #fff 4%, ${colorOf(state, p)} 60%, ${colorOf(state, p)})"></span>`).join('');
        tile.appendChild(tk);
      }
    }
  }

  private renderCenter(state: BMState, myPeerId: string, isSpectator: boolean): void {
    const cur = state.order[state.turnIdx]!;
    const curP = state.players[cur]!;
    const isMine = cur === myPeerId && !isSpectator;
    const turnEl = this.root.querySelector<HTMLElement>('#bm-turn')!;
    turnEl.innerHTML = `<b style="background:${colorOf(state, cur)}">${isMine ? '내 차례' : curP.nickname + ' 차례'}</b>`;
    const roll = this.root.querySelector<HTMLButtonElement>('#bm-roll')!;
    roll.disabled = !(isMine && !state.pending && state.phase === 'playing');
    this.root.querySelector<HTMLElement>('#bm-hint')!.textContent = state.log || '';
  }

  private renderPanel(state: BMState, myPeerId: string): void {
    const el = this.root.querySelector<HTMLElement>('#bm-players')!;
    const cur = state.order[state.turnIdx];
    el.innerHTML = state.order.map((pid) => {
      const p = state.players[pid]!;
      const props = Object.values(state.owner).filter((o) => o === pid).length;
      return `<div class="bm-prow ${pid === cur ? 'active' : ''} ${p.bankrupt ? 'dead' : ''}">
        <span class="bm-pdot" style="background:${colorOf(state, pid)}"></span>
        <span class="bm-pname">${p.nickname}${pid === myPeerId ? ' (나)' : ''}</span>
        <span style="text-align:right"><div class="bm-pmoney">${p.bankrupt ? '파산' : won(p.money)}</div>
          <div class="bm-pprops">${props}곳 · ${p.laps}바퀴</div></span></div>`;
    }).join('');
  }

  private renderHeld(state: BMState, myPeerId: string): void {
    const el = this.root.querySelector<HTMLElement>('#bm-held')!;
    const cards = state.held[myPeerId] ?? [];
    if (!cards.length) { el.innerHTML = '<div class="bm-empty">보관한 카드가 없어요</div>'; return; }
    el.innerHTML = cards.map((cid) => `<div class="bm-hcard"><span class="bm-hic">${IC[CARD_IC[cid]!]}</span>
      <span class="bm-htxt">${cardTitle(cid)}</span><button class="bm-huse" data-cid="${cid}">사용</button></div>`).join('');
    el.querySelectorAll<HTMLButtonElement>('.bm-huse').forEach((b) => {
      b.onclick = () => this.cb.onUseHeld(Number(b.dataset.cid));
    });
  }

  // ── 결정 모달 / 행동중 배너 ──
  private renderPending(state: BMState, myPeerId: string, isSpectator: boolean): void {
    // 주사위/이동 시퀀스 중엔 결정창/배너 보류 (완료 후 render 재호출에서 표시)
    if (this.busy) { this.closeModal(); return; }
    const p = state.pending;
    if (!p) { this.closeModal(); return; }
    const cur = state.order[state.turnIdx]!;
    const mine = cur === myPeerId && !isSpectator;
    if (!mine) { this.showActing(`${state.players[cur]!.nickname}님이 ${pendingLabel(p)} 중…`); return; }
    // 내 결정 모달 (이미 같은 종류 열려있으면 유지)
    const kind = `${p.kind}:${'tile' in p ? p.tile : ''}`;
    if (this.openKind === kind && this.modalScrim) { if (p.kind === 'build') this.refreshBuildMenu(state); return; }
    this.openKind = kind;
    if (p.kind === 'buy') this.buyOrAcquireModal(state, p.tile, false);
    else if (p.kind === 'acquire') this.buyOrAcquireModal(state, p.tile, true);
    else if (p.kind === 'build') this.buildMenuModal(state, p.tile);
    else if (p.kind === 'card') this.cardModal(state, p.card);
  }

  private showActing(text: string): void {
    if (this.openKind === 'acting' && this.modalScrim) {
      const t = this.modalScrim.querySelector('.bm-acttxt'); if (t) t.textContent = text; return;
    }
    this.closeModal();
    const bar = document.createElement('div'); bar.className = 'bm-actbar';
    bar.innerHTML = `<span class="bm-sp"></span><span class="bm-acttxt">${text}</span>`;
    document.body.appendChild(bar);
    this.modalScrim = bar; this.openKind = 'acting';
  }

  private closeModal(): void {
    this.modalScrim?.remove(); this.modalScrim = null; this.openKind = '';
  }

  private buyOrAcquireModal(state: BMState, tile: number, isAcquire: boolean): void {
    this.closeModal();
    const cost = isAcquire ? acquireCost(state, tile) : (BOARD[tile] as { price: number }).price;
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal"><div class="bm-top" style="background:${tileColor(tile)}">${isAcquire ? '인수' : (BOARD[tile].type === 'island' ? '섬 구매' : '도시 구매')}</div>
      <div class="bm-body">${deedHTML(state, tile)}
        <div class="bm-mrow"><span>${isAcquire ? '인수 비용' : '가격'}</span><b>${won(cost)}</b></div>
        <div class="bm-btns"><button class="bm-yes">${isAcquire ? '인수' : '구매'}</button><button class="bm-no">패스</button></div>
      </div></div>`;
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = `${isAcquire ? 'acquire' : 'buy'}:${tile}`;
    scrim.querySelector<HTMLButtonElement>('.bm-yes')!.onclick = () => this.cb.onDecision(true);
    scrim.querySelector<HTMLButtonElement>('.bm-no')!.onclick = () => this.cb.onDecision(false);
  }

  private buildMenuModal(state: BMState, tile: number): void {
    this.closeModal();
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = `build:${tile}`;
    (scrim as HTMLElement & { _tile?: number })._tile = tile;
    this.refreshBuildMenu(state);
  }

  private refreshBuildMenu(state: BMState): void {
    const scrim = this.modalScrim as (HTMLElement & { _tile?: number }) | null;
    if (!scrim) return;
    const tile = scrim._tile!;
    const t = BOARD[tile] as { name: string; price: number };
    const p = state.players[state.order[state.turnIdx]!]!;
    const arr = state.builds[tile] ?? [];
    const rows = BUILD_TYPES.map((bt) => {
      const has = arr.includes(bt.kind);
      const cost = buildCostOf(tile, bt.kind);
      let st = '', dis = true;
      if (has) st = '<span style="color:#57c777">보유</span>';
      else if (p.laps < bt.lap) st = `<span style="color:#9a8a9a">${bt.lap}바퀴 필요</span>`;
      else if (bt.kind === 'landmark' && !hasAllHouses(arr)) st = '<span style="color:#9a8a9a">3건물 먼저</span>';
      else if (p.money < cost) st = '<span style="color:#e5484d">돈 부족</span>';
      else { st = `<b style="color:#ff5a92">${won(cost)}</b>`; dis = false; }
      const ic = bt.kind === 'landmark' ? landmarkSvg(t.name) : BSVG[bt.kind];
      return `<button class="bm-brow" data-k="${bt.kind}" ${dis ? 'disabled' : ''}>
        <span class="bm-bic" style="color:${colorOf(state, p.peerId)}">${ic}</span>
        <span class="bm-bnm">${bt.name}</span><span class="bm-bst">${st}</span></button>`;
    }).join('');
    scrim.innerHTML = `<div class="bm-modal" style="width:290px"><div class="bm-top" style="background:${tileColor(tile)}">${t.name} · 건설</div>
      <div class="bm-body"><div class="bm-sub">지을 건물을 골라요 (바퀴 ${p.laps})</div>
      <div class="bm-bmenu">${rows}</div>
      <div class="bm-btns"><button class="bm-no" style="flex:1">완료</button></div></div></div>`;
    scrim.querySelectorAll<HTMLButtonElement>('.bm-brow').forEach((b) => {
      b.onclick = () => this.cb.onBuild(b.dataset.k as BuildKind);
    });
    scrim.querySelector<HTMLButtonElement>('.bm-no')!.onclick = () => this.cb.onBuildDone();
  }

  private cardModal(state: BMState, cardId: number): void {
    this.closeModal();
    const keepable = [6, 7, 8].includes(cardId);
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    const btns = keepable
      ? `<div class="bm-btns"><button class="bm-yes">지금 쓰기</button><button class="bm-no" style="background:#fff0d0;color:#b8860b">보관</button></div>`
      : `<div class="bm-btns"><button class="bm-yes" style="background:#b89aff;color:#fff">확인</button></div>`;
    scrim.innerHTML = `<div class="bm-modal"><div class="bm-top" style="background:linear-gradient(90deg,#ffd454,#ffb02e)">${IC.key} 황금열쇠</div>
      <div class="bm-body"><div class="bm-cardic">${IC[CARD_IC[cardId]!]}</div>
        <div class="bm-ctitle">${cardTitle(cardId)}</div><div class="bm-cdesc">${cardDesc(cardId)}</div>${btns}</div></div>`;
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = `card:${cardId}`;
    scrim.querySelector<HTMLButtonElement>('.bm-yes')!.onclick = () => this.cb.onCard(false);
    scrim.querySelector<HTMLButtonElement>('.bm-no')?.addEventListener('click', () => this.cb.onCard(true));
  }

  private infoModal(tile: number): void {
    // 정보는 로컬 표시만 — 현재 상태는 마지막 render 의 DOM 기준이 아니라 별도로 계산 필요.
    // 간단히: 클릭 시점의 최신 state 를 렌더가 안 갖고 있으므로, index 가 넘겨준 최신 state 참조.
    if (!this._lastState) return;
    const state = this._lastState;
    const t = BOARD[tile];
    if (t.type !== 'city' && t.type !== 'island') return;
    const o = state.owner[tile];
    const ownerTxt = o !== undefined ? `${state.players[o]!.nickname} 소유` : '주인 없음';
    let cur: string, rows: string;
    if (t.type === 'island') {
      const base = Math.round(t.price * 0.5), cnt = o !== undefined ? islandCount(state, o) : 0;
      cur = o !== undefined
        ? `<div class="bm-curbox"><div class="bm-mrow"><span>보유 섬</span><b>${cnt}개</b></div>
             <div class="bm-mrow big"><span>밟으면 통행료</span><b>${won(base * cnt)}</b></div>
             <div class="bm-mrow"><span>인수</span><b>불가</b></div></div>`
        : `<div class="bm-curbox"><div class="bm-mrow big"><span>구매가</span><b>${won(t.price)}</b></div></div>`;
      rows = `<div class="bm-ihdr">통행료 (보유 섬 수)</div><table class="bm-itable">${[1, 2, 3, 4].map((n) => `<tr><td>섬 ${n}개</td><td>${won(base * n)}</td></tr>`).join('')}</table>`;
    } else {
      const arr = state.builds[tile] ?? [];
      const builtTxt = arr.length ? arr.map((k) => buildMeta(k).name).join('·') : '땅만';
      const acq = acquireCost(state, tile);
      cur = o !== undefined
        ? `<div class="bm-curbox"><div class="bm-mrow"><span>지은 건물</span><b>${builtTxt}</b></div>
             <div class="bm-mrow big"><span>밟으면 통행료</span><b>${won(tollForCity(state, tile))}</b></div>
             <div class="bm-mrow"><span>인수하려면</span><b>${acq < 0 ? '불가' : won(acq)}</b></div></div>`
        : `<div class="bm-curbox"><div class="bm-mrow big"><span>구매가</span><b>${won(t.price)}</b></div></div>`;
      rows = `<div class="bm-ihdr">건물별 건설비 · 통행료 기여</div><table class="bm-itable">
        <tr><td>땅만</td><td>통행료 ${won(Math.round(t.price * BASE_TOLL_MUL))}</td></tr>
        ${BUILD_TYPES.map((bt) => `<tr><td>${bt.name}</td><td>${won(buildCostOf(tile, bt.kind))} · +${won(Math.round(t.price * bt.tollMul))}</td></tr>`).join('')}</table>`;
    }
    const el = this.root.querySelector<HTMLElement>(`.bm-tile[data-i="${tile}"]`);
    el?.classList.add('bm-selected');
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal" style="width:284px"><div class="bm-top" style="background:${tileColor(tile)}">${t.name}</div>
      <div class="bm-body" style="text-align:left"><div style="text-align:center;margin-bottom:2px"><b>${won(t.price)}</b> · <span style="color:#9a8a9a;font-weight:700">${ownerTxt}</span></div>
      ${cur}${rows}<div class="bm-btns" style="margin-top:12px"><button class="bm-no" style="flex:1">닫기</button></div></div></div>`;
    document.body.appendChild(scrim);
    const close = (): void => { scrim.remove(); el?.classList.remove('bm-selected'); };
    scrim.querySelector<HTMLButtonElement>('.bm-no')!.onclick = close;
    scrim.onclick = (e) => { if (e.target === scrim) close(); };
  }

  private _lastState: BMState | null = null;

  private showEnd(state: BMState, myPeerId: string): void {
    if (this.root.querySelector('.bm-end')) return;
    const won2 = state.winnerPeerId;
    const iWon = won2 === myPeerId;
    const name = won2 ? state.players[won2]!.nickname : '';
    const end = document.createElement('div'); end.className = 'bm-end';
    end.innerHTML = `<div class="bm-endcard"><div class="bm-endt" style="color:${iWon ? '#ff5a92' : '#4a3a4a'}">${iWon ? '승리!' : name + ' 승리'}</div></div>`;
    this.root.appendChild(end);
  }

  /** index 가 매 render 마다 최신 state 를 넘겨 정보모달 등에 쓰게 */
  setLastState(state: BMState): void { this._lastState = state; }
}

// ── 렌더 밖 헬퍼 ──
function colorOf(state: BMState, peerId: string): string {
  const idx = state.order.indexOf(peerId);
  return ['#6ed9b3', '#ff5a92', '#5b9be6', '#f2c94c', '#b89aff', '#ff8a5b', '#7ed957', '#e07aff', '#4fd0d9', '#ffb12e'][idx % 10]!;
}
function tollForCity(state: BMState, tile: number): number {
  const t = BOARD[tile];
  if (t.type !== 'city') return 0;
  const arr = state.builds[tile] ?? [];
  return Math.round(t.price * (BASE_TOLL_MUL + arr.reduce((s, k) => s + buildMeta(k).tollMul, 0)));
}
function deedHTML(state: BMState, tile: number): string {
  const t = BOARD[tile] as { name: string; price: number };
  const info = BOARD[tile].type === 'island'
    ? `섬 · 보유 개수만큼 통행료 ↑ · 인수 불가`
    : `기본 통행료 ${won(Math.round(t.price * BASE_TOLL_MUL))}`;
  return `<div class="bm-deed" style="--bd:${tileColor(tile)}"><div class="bm-deedb"></div>
    <div class="bm-deedn">${t.name}</div><div class="bm-deedi">가격 ${won(t.price)}<br>${info}</div></div>`;
}
const CARD_TITLES = ['은행 이자', '생일 축하', '복권 당첨', '병원비', '속도위반 벌금', '출발로 이동', '통행료 면제권', '무인도 탈출권', '우주여행권'];
const CARD_DESCS = ['₩150 받기', '₩120 받기', '₩300 받기', '₩100 납부', '₩80 납부', '월급 ₩200 받기', '통행료 1회 면제 · 보관 가능', '무인도 탈출 · 보관 가능', '원하는 곳으로 · 보관 가능'];
const cardTitle = (id: number): string => CARD_TITLES[id] ?? '카드';
const cardDesc = (id: number): string => CARD_DESCS[id] ?? '';
const pendingLabel = (p: NonNullable<BMState['pending']>): string =>
  p.kind === 'buy' ? '구매 고민' : p.kind === 'build' ? '건설' : p.kind === 'acquire' ? '인수 고민' : '카드 확인';

// ============================================
// CSS (1회 주입)
// ============================================
let styleInjected = false;
function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
.bm-root{position:absolute;inset:0;display:flex;gap:16px;padding:16px;box-sizing:border-box;align-items:center;justify-content:center;
  font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif;color:#4a3a4a;}
.bm-board{height:100%;aspect-ratio:1;max-width:calc(100% - 300px);display:grid;grid-template-columns:repeat(11,1fr);grid-template-rows:repeat(11,1fr);
  gap:3px;background:linear-gradient(135deg,#e9f7ff,#ffeaf3);border-radius:16px;padding:7px;box-shadow:0 8px 26px rgba(120,80,140,.14);}
.bm-tile{position:relative;background:#fff;border:1px solid #efe3f2;border-radius:6px;overflow:hidden;min-width:0;display:flex;flex-direction:column;}
.bm-prop{cursor:pointer;}
.bm-cinfo{position:absolute;bottom:0;left:0;right:0;padding:2px 2px 1px;text-align:center;z-index:1;background:linear-gradient(transparent,rgba(0,0,0,.26));}
.bm-cnm{font-size:8px;font-weight:800;color:#fff;text-shadow:0 1px 1.5px rgba(0,0,0,.45);line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bm-cpr{font-size:7px;font-weight:700;color:rgba(255,255,255,.92);text-shadow:0 1px 1px rgba(0,0,0,.4);}
.bm-special,.bm-corner{align-items:center;justify-content:center;text-align:center;background:#fffdf7;}
.bm-corner{background:linear-gradient(135deg,#fff,#fff4fa);}
.bm-ic svg{width:17px;height:17px;} .bm-corner .bm-ic svg{width:25px;height:25px;}
.bm-nm{font-size:9px;font-weight:800;line-height:1.05;padding:2px;text-align:center;}
.bm-corner .bm-nm{font-size:8.5px;}
.bm-islandic{position:absolute;top:38%;left:50%;transform:translate(-50%,-50%);} .bm-islandic svg{width:22px;height:22px;filter:drop-shadow(0 1px 1px rgba(0,0,0,.2));}
.bm-idock{position:absolute;top:56%;left:50%;transform:translateX(-50%);width:18px;height:5px;border-radius:3px;border:1.5px solid rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.3);z-index:2;}
.bm-blds{position:absolute;left:0;right:0;top:3px;display:flex;justify-content:center;align-items:flex-end;gap:1px;z-index:2;}
.bm-blds svg{width:21px;height:21px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.3));}
.bm-blds.bm-lm svg{width:44px;height:44px;filter:drop-shadow(0 0 5px rgba(255,200,60,.9)) drop-shadow(0 1px 2px rgba(0,0,0,.35));}
.bm-toks{position:absolute;bottom:17px;left:0;right:0;display:flex;gap:2px;justify-content:center;flex-wrap:wrap;pointer-events:none;z-index:4;}
.bm-tok{width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,.95);box-shadow:0 2px 5px rgba(0,0,0,.32),inset 0 -2px 4px rgba(0,0,0,.22);}
.bm-selected{z-index:6;filter:brightness(1.12) saturate(1.1);box-shadow:0 0 0 3px #fff,0 0 0 5px #ff5a92;}
.bm-center{grid-column:2/11;grid-row:2/11;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:11px;
  background:linear-gradient(135deg,rgba(255,255,255,.5),rgba(255,240,247,.5));border-radius:12px;padding:12px;}
.bm-logo{font-size:clamp(20px,3vw,38px);font-weight:900;letter-spacing:-1px;transform:rotate(-8deg);line-height:.95;text-align:center;
  background:linear-gradient(90deg,#5b9be6,#ff5a92);-webkit-background-clip:text;background-clip:text;color:transparent;}
.bm-dice{display:flex;gap:12px;}
.bm-die{width:clamp(36px,4.6vw,52px);aspect-ratio:1;background:#fff;border-radius:12px;box-shadow:0 5px 14px rgba(120,80,140,.22);display:grid;place-items:center;}
.bm-die svg{width:80%;height:80%;} .bm-die.bm-rolling{animation:bm-shake .12s infinite;}
@keyframes bm-shake{0%{transform:translateY(0) rotate(-8deg);}50%{transform:translateY(-4px) rotate(8deg);}100%{transform:translateY(0) rotate(-8deg);}}
.bm-turn{font-size:14px;font-weight:800;} .bm-turn b{padding:1px 10px;border-radius:999px;color:#fff;}
.bm-roll{font:inherit;font-weight:800;font-size:14px;color:#fff;background:#ff5a92;border:none;border-radius:999px;padding:9px 20px;cursor:pointer;box-shadow:0 6px 16px rgba(255,90,146,.32);display:flex;align-items:center;gap:5px;}
.bm-roll svg{width:18px;height:18px;} .bm-roll:disabled{opacity:.45;cursor:default;}
.bm-hint{font-size:12px;color:#8a7a8a;min-height:15px;text-align:center;}
.bm-panel{width:290px;display:flex;flex-direction:column;gap:12px;}
.bm-pcard{background:rgba(255,255,255,.72);border:1px solid rgba(216,199,255,.7);border-radius:14px;padding:12px;box-shadow:0 4px 14px rgba(120,80,140,.08);}
.bm-pcard h3{margin:0 0 8px;font-size:12px;color:#8a7a8a;font-weight:800;}
.bm-prow{display:flex;align-items:center;gap:8px;padding:6px 7px;border-radius:9px;}
.bm-prow.active{background:#fff0f6;box-shadow:inset 0 0 0 1px rgba(255,90,146,.3);} .bm-prow.dead{opacity:.5;}
.bm-pdot{width:13px;height:13px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.18);flex:none;}
.bm-pname{font-size:12.5px;font-weight:800;flex:1;} .bm-pmoney{font-size:12.5px;font-weight:800;} .bm-pprops{font-size:10.5px;color:#8a7a8a;}
.bm-heldlist{display:flex;flex-direction:column;gap:7px;} .bm-empty{font-size:12px;color:#8a7a8a;}
.bm-hcard{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:11px;background:#fff;border:1.5px solid #ffe0a8;}
.bm-hic svg{width:22px;height:22px;} .bm-htxt{flex:1;font-size:12px;font-weight:800;}
.bm-huse{font:inherit;font-size:12px;font-weight:800;color:#fff;background:#b89aff;border:none;border-radius:9px;padding:6px 11px;cursor:pointer;}
.bm-scrim{position:fixed;inset:0;z-index:200;background:rgba(54,36,56,.42);display:grid;place-items:center;padding:20px;}
.bm-modal{width:290px;max-width:92vw;background:#fff;border-radius:20px;box-shadow:0 20px 50px rgba(80,50,80,.35);overflow:hidden;animation:bm-pop .26s cubic-bezier(.34,1.56,.64,1);}
@keyframes bm-pop{from{transform:scale(.85);opacity:0;}to{transform:scale(1);opacity:1;}}
.bm-top{height:60px;display:flex;align-items:center;justify-content:center;gap:5px;color:#fff;font-size:15px;font-weight:800;} .bm-top svg{width:19px;height:19px;}
.bm-body{padding:15px 17px 17px;text-align:center;} .bm-sub{font-size:12px;color:#8a7a8a;margin-bottom:8px;}
.bm-mrow{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:3px 0;} .bm-mrow span{color:#8a7a8a;font-weight:700;} .bm-mrow b{color:#4a3a4a;font-weight:900;} .bm-mrow.big b{color:#ff5a92;font-size:16px;}
.bm-btns{display:flex;gap:10px;margin-top:12px;} .bm-btns button{flex:1;font:inherit;font-size:14px;font-weight:800;padding:11px;border-radius:13px;cursor:pointer;border:none;}
.bm-yes{background:#6ed9b3;color:#1f6a55;} .bm-no{background:#f0e8ef;color:#8a7a8a;}
.bm-deed{width:132px;margin:0 auto 10px;border:1.5px solid #eadcf2;border-radius:12px;overflow:hidden;box-shadow:0 3px 10px rgba(120,80,140,.12);}
.bm-deedb{height:26px;background:var(--bd);} .bm-deedn{font-size:16px;font-weight:900;padding:6px 4px 0;} .bm-deedi{font-size:10.5px;color:#8a7a8a;padding:2px 4px 8px;line-height:1.3;}
.bm-cardic svg{width:46px;height:46px;} .bm-ctitle{font-size:18px;font-weight:900;margin-top:6px;} .bm-cdesc{font-size:12px;color:#8a7a8a;margin-bottom:6px;}
.bm-bmenu{display:flex;flex-direction:column;gap:7px;}
.bm-brow{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:12px;border:1.5px solid #eadcf2;background:#fff;font:inherit;cursor:pointer;text-align:left;}
.bm-brow:not(:disabled):hover{border-color:#ff5a92;} .bm-brow:disabled{opacity:.55;cursor:default;}
.bm-bic{width:26px;height:26px;flex:none;display:grid;place-items:center;} .bm-bic svg{width:26px;height:26px;}
.bm-bnm{flex:1;font-size:13px;font-weight:800;} .bm-bst{font-size:12px;font-weight:700;}
.bm-itable{width:100%;font-size:11.5px;border-collapse:collapse;margin-top:2px;} .bm-itable td{padding:3.5px 6px;border-bottom:1px solid #f2eaf4;} .bm-itable td:last-child{text-align:right;font-weight:800;} .bm-itable td:first-child{color:#6a5a6a;}
.bm-ihdr{font-size:11.5px;font-weight:800;color:#8a7a8a;margin-top:10px;}
.bm-curbox{background:#fff6fa;border:1px solid #ffd6e6;border-radius:12px;padding:8px 11px;margin:8px 0;}
.bm-actbar{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:210;background:rgba(74,58,74,.92);color:#fff;font-size:13px;font-weight:800;padding:9px 18px;border-radius:999px;display:flex;align-items:center;gap:8px;box-shadow:0 8px 22px rgba(0,0,0,.28);pointer-events:none;}
.bm-sp{width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:bm-spin .7s linear infinite;}
@keyframes bm-spin{to{transform:rotate(360deg);}}
.bm-end{position:absolute;inset:0;z-index:50;background:rgba(54,36,56,.55);display:grid;place-items:center;}
.bm-endcard{background:#fff;border-radius:20px;padding:26px 40px;box-shadow:0 16px 40px rgba(0,0,0,.3);} .bm-endt{font-size:30px;font-weight:900;}
@media(max-width:820px){.bm-root{flex-direction:column;} .bm-board{max-width:100%;height:auto;width:100%;} .bm-panel{width:100%;}}
`;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}
