/**
 * 루미큐브 렌더러 (HTML DOM — 타일을 끌어 옮겨야 해서 캔버스는 숨긴다)
 *
 * 턴 중의 조작은 전부 여기 안에서만 벌어진다. 서버(호스트)가 준 테이블을 복사해서
 * `work` 에 두고, 사람이 끌어 옮기는 건 `work` 만 바꾼다. 턴 끝내기를 누를 때
 * `work` 를 통째로 호스트에 보낸다. 퇴짜를 맞으면 그냥 되돌리면 된다.
 *
 * 옮기는 방법 두 가지를 다 지원한다.
 *   · 드래그 — 실물 루미큐브에 가장 가깝다. 여러 장을 재배치할 때 손맛이 좋다
 *   · 탭 → 탭 — 타일을 누르고 놓을 자리를 누른다. 오작동이 적다
 *
 * 규칙상 **테이블에 있던 타일은 손패로 못 가져온다**. 그래서 어디서 온 타일인지를
 * (serverTableIds) 기억해두고 손패로 돌아가는 건 내 타일만 허용한다.
 */

import type { Tile, TileSet } from './rules';
import { sortByColor, sortByNumber, validateSet } from './rules';
import type { SyncPlayer } from './netSync';
import { escapeHtml } from '../../ui/escape';

export interface RkRenderState {
  players: SyncPlayer[];
  turnPeerId: string | null;
  table: TileSet[];
  myHand: Tile[];
  poolLeft: number;
  turnDeadline: number;
  news: string;
  myPeerId: string;
  isSpectator: boolean;
}

export interface RkCallbacks {
  onCommit(table: TileSet[]): void;
  onDraw(): void;
}

/**
 * 조커 얼굴. 실물 루미큐브 조커는 별이 아니라 **웃는 얼굴**이다 (빨강·검정 한 장씩).
 * stroke/fill 을 currentColor 로 두면 타일 색(c-red / c-black)을 그대로 따라간다.
 */
const JOKER_FACE = `<svg class="rk-joker" viewBox="0 0 24 24" aria-label="조커">
  <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.9"/>
  <circle cx="8.9" cy="9.9" r="1.35" fill="currentColor"/>
  <circle cx="15.1" cy="9.9" r="1.35" fill="currentColor"/>
  <path d="M7.4 13.6c1.3 2.6 7.9 2.6 9.2 0" fill="none" stroke="currentColor"
        stroke-width="1.9" stroke-linecap="round"/>
</svg>`;

/** 타일이 어디에 있는지 — 손패인가, 테이블 몇 번째 조합인가 */
type Spot = { kind: 'hand' } | { kind: 'set'; index: number };

export class RummikubRenderer {
  private canvas: HTMLCanvasElement;
  private cb: RkCallbacks;
  private root: HTMLDivElement;
  private styleEl: HTMLStyleElement;

  private topEl: HTMLDivElement;
  private tableEl: HTMLDivElement;
  private handEl: HTMLDivElement;
  private actionEl: HTMLDivElement;
  private noticeEl: HTMLDivElement;
  private timerEl: HTMLSpanElement;

  private last: RkRenderState | null = null;

  /** 턴 중 작업본 — 확정 전까지 여기만 바뀐다 */
  private work: TileSet[] = [];
  private hand: Tile[] = [];
  /** 이번 턴 시작 시점에 테이블에 있던 타일 (손패로 되돌릴 수 없는 것들) */
  private serverTableIds = new Set<number>();
  /** 탭으로 고른 타일 id */
  private picked: number | null = null;
  /** 드래그 중인 타일 id */
  private dragging: number | null = null;
  private sortMode: 'color' | 'number' = 'color';
  private rejectText = '';
  private rejectUntil = 0;
  private myTurnBefore = false;
  private boardKey = '';

  constructor(canvas: HTMLCanvasElement, cb: RkCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    canvas.style.display = 'none';

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'rk-screen';
    this.root.innerHTML = `
      <div class="rk-top" id="rk-top"></div>
      <div class="rk-table" id="rk-table"></div>
      <div class="rk-notice" id="rk-notice" hidden></div>
      <div class="rk-actions" id="rk-actions"></div>
      <div class="rk-hand" id="rk-hand"></div>
    `;
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.root);
    }
    const q = <T extends HTMLElement>(id: string): T => this.root.querySelector<T>('#' + id)!;
    this.topEl = q('rk-top');
    this.tableEl = q('rk-table');
    this.handEl = q('rk-hand');
    this.actionEl = q('rk-actions');
    this.noticeEl = q('rk-notice');
    this.timerEl = document.createElement('span');

    this.wireDropZones();
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  /** 호스트에서 새 상태가 왔다 — 작업본을 서버 기준으로 다시 깐다 */
  onNewState(myTurn: boolean): void {
    const s = this.last;
    if (!s) return;
    this.work = s.table.map((set) => set.slice());
    this.hand = s.myHand.slice();
    this.serverTableIds = new Set(s.table.flat().map((t) => t.id));
    this.picked = null;
    this.dragging = null;
    this.boardKey = '';
    if (myTurn && !this.myTurnBefore) this.rejectText = '';
    this.myTurnBefore = myTurn;
  }

  showReject(reason: string): void {
    this.rejectText = reason;
    this.rejectUntil = performance.now() + 4_000;
  }

  render(s: RkRenderState): void {
    const first = this.last === null;
    const prev = this.last;
    this.last = s;
    // 서버 상태가 바뀌면(턴 교대/남의 커밋) 작업본을 새로 깐다.
    // 내 조작 중에는 서버가 테이블을 바꿀 일이 없어서 작업본이 날아갈 걱정은 없다.
    if (first || !prev || tableKey(prev.table) !== tableKey(s.table)
      || handKey(prev.myHand) !== handKey(s.myHand)) {
      this.work = s.table.map((set) => set.slice());
      this.hand = s.myHand.slice();
      this.serverTableIds = new Set(s.table.flat().map((t) => t.id));
      this.picked = null;
      this.boardKey = '';
    }

    const myTurn = !s.isSpectator && s.turnPeerId === s.myPeerId;
    this.drawTop(s, myTurn);

    const key = [
      this.work.map((set) => set.map((t) => t.id).join('.')).join('|'),
      this.hand.map((t) => t.id).join('.'),
      this.picked ?? '', myTurn, this.sortMode,
    ].join('#');
    if (key !== this.boardKey) {
      this.boardKey = key;
      this.drawTable(myTurn);
      this.drawHand(myTurn);
      this.drawActions(s, myTurn);
    }

    if (this.rejectText && performance.now() > this.rejectUntil) this.rejectText = '';
    const notice = this.rejectText || s.news;
    this.noticeEl.textContent = notice;
    this.noticeEl.classList.toggle('is-bad', !!this.rejectText);
    this.noticeEl.hidden = !notice;
  }

  // ------------------------------------------------

  private drawTop(s: RkRenderState, myTurn: boolean): void {
    const turn = s.players.find((p) => p.peerId === s.turnPeerId);
    const left = s.turnDeadline > 0 ? Math.max(0, Math.ceil((s.turnDeadline - Date.now()) / 1000)) : null;
    this.topEl.innerHTML = `
      <div class="rk-turn${myTurn ? ' is-mine' : ''}">${
        s.turnPeerId === null ? '게임 끝' : myTurn ? '내 차례' : `${escapeHtml(turn?.nickname ?? '')} 님 차례`
      }${left !== null ? ` <span class="rk-timer${left <= 10 ? ' is-hot' : ''}">${left}초</span>` : ''}</div>
      <div class="rk-players">${s.players.map((p) => `
        <span class="rk-pchip${p.peerId === s.turnPeerId ? ' is-turn' : ''}${p.gone ? ' is-gone' : ''}">
          ${escapeHtml(p.nickname)}
          <b>${p.handCount}</b>${p.melded ? '' : '<i class="rk-nomeld">미등록</i>'}
        </span>`).join('')}
        <span class="rk-pool">더미 ${s.poolLeft}</span>
      </div>`;
  }

  private tileHTML(t: Tile, movable: boolean): string {
    const cls = ['rk-tile', `c-${t.color}`, t.joker ? 'is-joker' : '',
      movable ? 'is-movable' : '', this.picked === t.id ? 'is-picked' : ''].filter(Boolean).join(' ');
    return `<button class="${cls}" data-tile="${t.id}"${movable ? ' draggable="true"' : ''}>${
      t.joker ? JOKER_FACE : t.num}</button>`;
  }

  private drawTable(myTurn: boolean): void {
    const sets = this.work.map((set, i) => {
      const ok = validateSet(set);
      return `
        <div class="rk-set${ok ? '' : ' is-bad'}" data-set="${i}">
          ${set.map((t) => this.tileHTML(t, myTurn)).join('')}
        </div>`;
    }).join('');
    this.tableEl.innerHTML = sets + `
      <div class="rk-newset" data-set="new">${myTurn ? '여기에 놓아 새 조합' : ''}</div>`;
  }

  private drawHand(myTurn: boolean): void {
    const sorted = this.sortMode === 'color' ? sortByColor(this.hand) : sortByNumber(this.hand);
    this.handEl.innerHTML = sorted.length === 0
      ? '<div class="rk-empty">손패를 다 냈어요!</div>'
      : sorted.map((t) => this.tileHTML(t, myTurn)).join('');
  }

  private drawActions(s: RkRenderState, myTurn: boolean): void {
    if (s.isSpectator) {
      this.actionEl.innerHTML = '<span class="rk-hint">관전 중이에요</span>';
      return;
    }
    if (!myTurn) {
      this.actionEl.innerHTML = '<span class="rk-hint">내 차례를 기다리는 중…</span>';
      return;
    }
    const moved = this.hand.length !== (this.last?.myHand.length ?? 0);
    this.actionEl.innerHTML = `
      <button class="rk-btn ghost" id="rk-sort">${this.sortMode === 'color' ? '숫자순' : '색깔순'}</button>
      <button class="rk-btn ghost" id="rk-undo"${moved ? '' : ' disabled'}>되돌리기</button>
      <button class="rk-btn" id="rk-commit"${moved ? '' : ' disabled'}>턴 끝내기</button>
      <button class="rk-btn warn" id="rk-draw">한 장 가져오기</button>`;

    this.actionEl.querySelector('#rk-sort')!.addEventListener('click', () => {
      this.sortMode = this.sortMode === 'color' ? 'number' : 'color';
      this.boardKey = '';
    });
    this.actionEl.querySelector('#rk-undo')!.addEventListener('click', () => this.resetWork());
    this.actionEl.querySelector('#rk-commit')!.addEventListener('click', () => {
      this.cb.onCommit(this.work.filter((set) => set.length > 0));
    });
    this.actionEl.querySelector('#rk-draw')!.addEventListener('click', () => {
      this.resetWork();
      this.cb.onDraw();
    });
  }

  private resetWork(): void {
    const s = this.last;
    if (!s) return;
    this.work = s.table.map((set) => set.slice());
    this.hand = s.myHand.slice();
    this.picked = null;
    this.boardKey = '';
  }

  // ------------------------------------------------
  // 옮기기 — 드래그와 탭이 같은 move() 로 모인다
  // ------------------------------------------------

  private findTile(id: number): { tile: Tile; from: Spot; pos: number } | null {
    const h = this.hand.findIndex((t) => t.id === id);
    if (h >= 0) return { tile: this.hand[h]!, from: { kind: 'hand' }, pos: h };
    for (let i = 0; i < this.work.length; i++) {
      const p = this.work[i]!.findIndex((t) => t.id === id);
      if (p >= 0) return { tile: this.work[i]![p]!, from: { kind: 'set', index: i }, pos: p };
    }
    return null;
  }

  /** 타일 하나를 목적지로 옮긴다. to.index === -1 이면 새 조합 */
  private move(id: number, to: Spot | 'new', insertAt: number): void {
    const found = this.findTile(id);
    if (!found) return;
    // 테이블에 원래 있던 타일은 손패로 못 간다 (가져가기 금지)
    if (to !== 'new' && to.kind === 'hand' && this.serverTableIds.has(id)) {
      this.showReject('테이블 타일은 손으로 가져올 수 없어요');
      return;
    }

    // 먼저 빼낸다
    if (found.from.kind === 'hand') this.hand.splice(found.pos, 1);
    else this.work[found.from.index]!.splice(found.pos, 1);

    if (to === 'new') {
      this.work.push([found.tile]);
    } else if (to.kind === 'hand') {
      this.hand.push(found.tile);
    } else {
      const set = this.work[to.index];
      if (!set) { this.work.push([found.tile]); }
      else {
        // 같은 조합 안에서 뒤로 옮기면 빼낸 만큼 자리가 당겨진다
        let at = insertAt;
        if (found.from.kind === 'set' && found.from.index === to.index && found.pos < insertAt) at -= 1;
        set.splice(Math.max(0, Math.min(set.length, at)), 0, found.tile);
      }
    }
    // 빈 조합은 치운다
    this.work = this.work.filter((set) => set.length > 0);
    this.picked = null;
    this.boardKey = '';
  }

  /** 드롭 지점의 x 좌표로 조합 안 삽입 위치를 구한다 */
  private insertIndexAt(setEl: HTMLElement, clientX: number): number {
    const tiles = [...setEl.querySelectorAll<HTMLElement>('[data-tile]')];
    for (let i = 0; i < tiles.length; i++) {
      const r = tiles[i]!.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return tiles.length;
  }

  private targetFrom(el: HTMLElement | null): { to: Spot | 'new'; el: HTMLElement } | null {
    const setEl = el?.closest<HTMLElement>('[data-set]');
    if (setEl) {
      const raw = setEl.dataset['set']!;
      return { to: raw === 'new' ? 'new' : { kind: 'set', index: Number(raw) }, el: setEl };
    }
    const handEl = el?.closest<HTMLElement>('#rk-hand');
    if (handEl) return { to: { kind: 'hand' }, el: handEl };
    return null;
  }

  private wireDropZones(): void {
    // --- 탭 → 탭 ---
    this.root.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const tileEl = el.closest<HTMLElement>('[data-tile]');
      if (tileEl && tileEl.classList.contains('is-movable')) {
        const id = Number(tileEl.dataset['tile']);
        if (this.picked === null) { this.picked = id; this.boardKey = ''; return; }
        if (this.picked === id) { this.picked = null; this.boardKey = ''; return; }
        // 고른 타일을 이 타일 자리로
        const t = this.targetFrom(tileEl);
        if (t && t.to !== 'new' && t.to.kind === 'set') {
          const r = tileEl.getBoundingClientRect();
          const setEl = tileEl.closest<HTMLElement>('[data-set]')!;
          const at = this.insertIndexAt(setEl, r.left + 1);
          this.move(this.picked, t.to, at);
          return;
        }
        this.picked = id;
        this.boardKey = '';
        return;
      }
      if (this.picked === null) return;
      const t = this.targetFrom(el);
      if (!t) return;
      const at = t.to !== 'new' && t.to.kind === 'set'
        ? this.insertIndexAt(t.el, (e as MouseEvent).clientX) : 0;
      this.move(this.picked, t.to, at);
    });

    // --- 드래그 ---
    this.root.addEventListener('dragstart', (e) => {
      const tileEl = (e.target as HTMLElement).closest<HTMLElement>('[data-tile]');
      if (!tileEl || !tileEl.classList.contains('is-movable')) { e.preventDefault(); return; }
      this.dragging = Number(tileEl.dataset['tile']);
      this.picked = null;
      e.dataTransfer?.setData('text/plain', String(this.dragging));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    this.root.addEventListener('dragover', (e) => {
      if (this.dragging === null) return;
      const t = this.targetFrom(e.target as HTMLElement);
      if (!t) return;
      e.preventDefault(); // 여기에 놓을 수 있다는 뜻
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    this.root.addEventListener('drop', (e) => {
      if (this.dragging === null) return;
      const t = this.targetFrom(e.target as HTMLElement);
      if (!t) { this.dragging = null; return; }
      e.preventDefault();
      const at = t.to !== 'new' && t.to.kind === 'set'
        ? this.insertIndexAt(t.el, e.clientX) : 0;
      this.move(this.dragging, t.to, at);
      this.dragging = null;
    });
    this.root.addEventListener('dragend', () => { this.dragging = null; });
  }
}

function tableKey(table: TileSet[]): string {
  return table.map((s) => s.map((t) => t.id).join('.')).join('|');
}
function handKey(hand: Tile[]): string {
  return hand.map((t) => t.id).join('.');
}

/* 색은 theme.css 변수를 쓰되, 타일 4색은 루미큐브 고유색이라 여기서 정한다 */
const CSS = `
.rk-screen{position:absolute;inset:0;display:flex;flex-direction:column;gap:7px;
  padding:10px 12px;box-sizing:border-box;overflow:hidden;font-family:var(--font-sans);
  color:var(--text-main);}

.rk-top{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:5px;}
.rk-turn{font-size:15px;font-weight:900;color:var(--text-muted);}
.rk-turn.is-mine{color:var(--highlight-ink);background:var(--highlight-soft);
  padding:3px 14px;border-radius:var(--radius-full);}
.rk-timer{font-size:12.5px;font-weight:800;color:var(--accent);margin-left:6px;}
.rk-timer.is-hot{color:var(--danger);}
.rk-players{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;}
.rk-pchip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:800;
  color:var(--text-muted);background:var(--bg-inset);border:1px solid var(--border-soft);
  padding:2px 9px;border-radius:var(--radius-full);}
.rk-pchip b{color:var(--text-main);}
.rk-pchip.is-turn{border-color:var(--highlight);background:var(--highlight-soft);
  color:var(--highlight-ink);}
.rk-pchip.is-gone{opacity:.45;text-decoration:line-through;}
.rk-nomeld{font-style:normal;font-size:10px;color:var(--warn);}
.rk-pool{font-size:11.5px;font-weight:800;color:var(--text-muted);}

/* 테이블 — 조합들이 알아서 줄바꿈된다 */
.rk-table{flex:1 1 auto;min-height:0;overflow-y:auto;scrollbar-width:thin;
  display:flex;flex-wrap:wrap;align-content:flex-start;gap:9px;padding:9px;
  background:var(--bg-inset);border:1.5px solid var(--border-soft);
  border-radius:var(--radius-md);}
.rk-set{display:flex;gap:2px;padding:4px;border-radius:var(--radius-sm);
  background:var(--bg-card);border:1.5px solid var(--border-soft);}
/* 아직 조합이 안 되는 묶음 — 이대로는 턴을 못 끝낸다 */
.rk-set.is-bad{border-color:var(--danger);background:var(--danger-soft);}
.rk-newset{display:flex;align-items:center;justify-content:center;min-width:104px;
  padding:6px 12px;border:2px dashed var(--border);border-radius:var(--radius-sm);
  font-size:11px;font-weight:700;color:var(--text-muted);}

/* 타일 */
.rk-tile{font:inherit;font-weight:900;font-size:17px;width:34px;height:46px;flex:0 0 auto;
  display:flex;align-items:center;justify-content:center;border-radius:7px;
  background:#fffdf6;border:1.5px solid #e4dcc8;color:#333;cursor:default;
  box-shadow:0 1px 2px rgba(0,0,0,.12);padding:0;}
.rk-tile.c-red{color:#d3392f;}
.rk-tile.c-blue{color:#2563c9;}
.rk-tile.c-black{color:#3a3a3a;}
.rk-tile.c-orange{color:#e0790d;}
.rk-tile.is-joker{padding:0;}
.rk-joker{width:26px;height:26px;display:block;}
.rk-tile.is-movable{cursor:grab;}
.rk-tile.is-movable:hover{transform:translateY(-2px);box-shadow:0 3px 7px rgba(0,0,0,.18);}
.rk-tile.is-picked{outline:3px solid var(--accent);outline-offset:1px;transform:translateY(-4px);}

.rk-notice{flex:0 0 auto;font-size:12.5px;font-weight:700;color:var(--text-muted);
  text-align:center;}
.rk-notice.is-bad{color:var(--danger);}
.rk-notice[hidden]{display:none;}

.rk-actions{flex:0 0 auto;display:flex;gap:6px;justify-content:center;align-items:center;}
.rk-hint{font-size:12.5px;color:var(--text-muted);}
.rk-btn{font:inherit;font-weight:800;font-size:13px;color:#fff;background:var(--accent);
  border:none;border-radius:var(--radius-full);padding:8px 16px;cursor:pointer;}
.rk-btn:hover{background:var(--accent-hover);}
.rk-btn:disabled{opacity:.45;cursor:default;}
.rk-btn.ghost{background:transparent;color:var(--text-muted);border:1.5px solid var(--border);}
.rk-btn.ghost:hover:not(:disabled){background:var(--bg-subtle);}
.rk-btn.warn{background:var(--warn);}
.rk-btn.warn:hover{filter:brightness(.95);}

/* 내 손패 */
.rk-hand{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:3px;justify-content:center;
  max-height:118px;overflow-y:auto;scrollbar-width:thin;padding:7px;
  background:var(--bg-card);border:1.5px solid var(--border);border-radius:var(--radius-md);}
.rk-empty{font-size:13px;font-weight:800;color:var(--mint-500);padding:12px;}
`;
