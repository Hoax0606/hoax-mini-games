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
import { sortByColor, sortByNumber, validateSet, setScore, FIRST_MELD_MIN } from './rules';
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
  /**
   * 탭으로 고른 타일들 (고른 순서 그대로).
   * 여러 장을 고르고 한 번에 옮길 수 있다 — 조합 하나를 통째로 옮길 때 필요하다.
   */
  private picked: number[] = [];
  /** 드래그 중인 타일 id */
  private dragging: number | null = null;
  /** 드래그 중 강조해 둔 드롭 대상 */
  private overEl: HTMLElement | null = null;
  private sortMode: 'color' | 'number' = loadSortMode();
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
    this.picked = [];
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
      this.picked = [];
      this.boardKey = '';
    }

    const myTurn = !s.isSpectator && s.turnPeerId === s.myPeerId;
    this.drawTop(s, myTurn);

    const key = [
      this.work.map((set) => set.map((t) => t.id).join('.')).join('|'),
      this.hand.map((t) => t.id).join('.'),
      this.picked.join('.'), myTurn, this.sortMode,
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
      movable ? 'is-movable' : '', this.picked.includes(t.id) ? 'is-picked' : ''].filter(Boolean).join(' ');
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
      // 기다리는 동안에도 손패는 정리할 수 있게 둔다 — 내 차례가 오기 전에
      // 미리 늘어놓고 뭘 낼지 짜보는 게 이 게임에서 기다리는 시간의 전부다.
      this.actionEl.innerHTML = '<span class="rk-hint">내 차례를 기다리는 중…</span>' + SORT_BTN(this.sortMode);
      this.wireSort();
      return;
    }
    const moved = this.hand.length !== (this.last?.myHand.length ?? 0);
    // 깨진 조합이 하나라도 있으면 턴을 못 끝낸다 (테이블 전체를 검사하기 때문).
    // 예전엔 그냥 누르게 두고 "완성되지 않은 조합이 있어요" 만 띄웠는데,
    // 어느 조합이 문제인지 안 짚어줘서 멀쩡한 걸 새로 깔아도 계속 막히는 걸로 보였다.
    const bad = this.work.filter((set) => !validateSet(set)).length;
    // 몇 장 고랐는지 보여준다 — 여러 장 모아 한 번에 옮길 수 있는 걸 모르면 안 쓴다.
    // "한 조합" 이라고 못 박는 건, 13 13 13 9 9 9 를 한꺼번에 골라 놓고 두 조합으로
    // 갈리길 기대하다가 깨진 조합 하나를 만들어 턴이 막히는 일이 실제로 있었기 때문이다.
    const pickInfo = bad > 0
      ? `<span class="rk-pickinfo is-bad">빨간 조합 ${bad}개를 완성하거나 손패로 되돌려야 턴을 끝낼 수 있어요</span>`
      : this.picked.length > 0
        ? `<span class="rk-pickinfo">${this.picked.length}장 고름 · 누른 자리에 <b>한 조합</b>으로 들어가요</span>`
        : '';
    // 첫 등록 전에만 — 지금 깔은 내 타일의 점수를 숫자로 보여준다.
    // 30점을 암산으로 세고 있으면 재미가 아니라 귀찮다. 등록 후엔 안 보여준다(필요 없는 정보).
    const me = s.players.find((p) => p.peerId === s.myPeerId);
    let meldInfo = '';
    if (me && !me.melded) {
      const handIds = new Set((this.last?.myHand ?? []).map((t) => t.id));
      const fresh = this.work.filter((set) => set.every((t) => handIds.has(t.id)));
      const score = fresh.reduce((sum, set) => sum + setScore(set), 0);
      const ok = score >= FIRST_MELD_MIN;
      meldInfo = `<span class="rk-meldscore${ok ? ' is-ok' : ''}">${score} / ${FIRST_MELD_MIN}</span>`;
    }
    this.actionEl.innerHTML = pickInfo + meldInfo + SORT_BTN(this.sortMode) + `
      <button class="rk-btn ghost" id="rk-undo"${moved ? '' : ' disabled'}>되돌리기</button>
      <button class="rk-btn" id="rk-commit"${moved && bad === 0 ? '' : ' disabled'}>턴 끝내기</button>
      <button class="rk-btn warn" id="rk-draw">한 장 가져오기</button>`;

    this.wireSort();
    this.actionEl.querySelector('#rk-undo')!.addEventListener('click', () => this.resetWork());
    this.actionEl.querySelector('#rk-commit')!.addEventListener('click', () => {
      this.cb.onCommit(this.work.filter((set) => set.length > 0));
    });
    this.actionEl.querySelector('#rk-draw')!.addEventListener('click', () => {
      this.resetWork();
      this.cb.onDraw();
    });
  }

  /** 정렬 버튼은 내 차례일 때도 아닐 때도 같은 자리에 있다 */
  private wireSort(): void {
    this.actionEl.querySelector('#rk-sort')?.addEventListener('click', () => {
      this.sortMode = this.sortMode === 'color' ? 'number' : 'color';
      saveSortMode(this.sortMode);
      this.boardKey = ''; // 다음 프레임에 손패를 다시 깐다
    });
  }

  private resetWork(): void {
    const s = this.last;
    if (!s) return;
    this.work = s.table.map((set) => set.slice());
    this.hand = s.myHand.slice();
    this.picked = [];
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
  /**
   * 고른 타일들을 목적지로 옮긴다 (고른 순서 그대로 나란히).
   *
   * 여러 장을 한꺼번에 옮길 때 자리 계산이 까다롭다 — 하나씩 빼내면 뒤 타일의 자리가
   * 계속 당겨지기 때문이다. 그래서 **빼내기 전에** "이 타일 앞에 넣는다" 는 기준점을
   * 잡아두고, 다 빼낸 뒤 그 기준점을 다시 찾아 거기에 끼운다.
   */
  private move(ids: number[], to: Spot | 'new', insertAt: number): void {
    if (ids.length === 0) return;
    // 테이블에 원래 있던 타일은 손패로 못 간다 (가져가기 금지)
    if (to !== 'new' && to.kind === 'hand' && ids.some((id) => this.serverTableIds.has(id))) {
      this.showReject('테이블 타일은 손으로 가져올 수 없어요');
      return;
    }

    // 기준점 — 목적지 조합에서 insertAt 자리에 있던 타일 id (끝이면 undefined)
    const targetIdx = to !== 'new' && to.kind === 'set' ? to.index : -1;
    const anchorId = targetIdx >= 0 ? this.work[targetIdx]?.[insertAt]?.id : undefined;

    const moving: Tile[] = [];
    for (const id of ids) {
      const f = this.findTile(id);
      if (!f) continue;
      if (f.from.kind === 'hand') this.hand.splice(f.pos, 1);
      else this.work[f.from.index]!.splice(f.pos, 1);
      moving.push(f.tile);
    }
    if (moving.length === 0) return;

    if (to === 'new') {
      this.work.push(moving);
    } else if (to.kind === 'hand') {
      this.hand.push(...moving);
    } else {
      const set = this.work[to.index];
      if (!set) {
        this.work.push(moving);
      } else {
        // 기준점이 같이 옮겨졌으면(= 더 이상 없음) 맨 뒤에 붙인다
        const at = anchorId === undefined ? set.length
          : (() => { const i = set.findIndex((t) => t.id === anchorId); return i < 0 ? set.length : i; })();
        set.splice(at, 0, ...moving);
      }
    }
    // 빈 조합은 치운다
    this.work = this.work.filter((set) => set.length > 0);
    this.picked = [];
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

  /** 드래그 중 "여기에 놓인다" 표시. 직전 대상에서 떼고 새 대상에 붙인다 */
  private markOver(el: HTMLElement | null): void {
    if (this.overEl === el) return;
    this.overEl?.classList.remove('is-over');
    this.overEl = el;
    el?.classList.add('is-over');
  }

  private wireDropZones(): void {
    // --- 탭 → 탭 ---
    this.root.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const tileEl = el.closest<HTMLElement>('[data-tile]');
      if (tileEl && tileEl.classList.contains('is-movable')) {
        const id = Number(tileEl.dataset['tile']);
        // 이미 고른 타일을 다시 누르면 선택 해제 (내려온다)
        if (this.picked.includes(id)) {
          this.picked = this.picked.filter((x) => x !== id);
          this.boardKey = '';
          return;
        }
        // 고른 게 있고 이 타일이 테이블에 있으면 → "이 타일 앞" 이 목적지
        const t = this.targetFrom(tileEl);
        if (this.picked.length > 0 && t && t.to !== 'new' && t.to.kind === 'set') {
          const setEl = tileEl.closest<HTMLElement>('[data-set]')!;
          const r = tileEl.getBoundingClientRect();
          this.move(this.picked, t.to, this.insertIndexAt(setEl, r.left + 1));
          return;
        }
        // 그 외엔 선택에 추가 (여러 장을 모아서 한 번에 옮긴다)
        this.picked.push(id);
        this.boardKey = '';
        return;
      }
      if (this.picked.length === 0) return;
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
      // 고른 묶음 중 하나를 끌면 묶음째 옮긴다. 아니면 그 한 장만 (선택은 버린다)
      if (!this.picked.includes(this.dragging)) this.picked = [];
      e.dataTransfer?.setData('text/plain', String(this.dragging));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    this.root.addEventListener('dragover', (e) => {
      if (this.dragging === null) return;
      const t = this.targetFrom(e.target as HTMLElement);
      if (!t) { this.markOver(null); return; }
      e.preventDefault(); // 여기에 놓을 수 있다는 뜻
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.markOver(t.el);
    });
    this.root.addEventListener('drop', (e) => {
      if (this.dragging === null) return;
      this.markOver(null);
      const t = this.targetFrom(e.target as HTMLElement);
      if (!t) { this.dragging = null; return; }
      e.preventDefault();
      const at = t.to !== 'new' && t.to.kind === 'set'
        ? this.insertIndexAt(t.el, e.clientX) : 0;
      const ids = this.picked.includes(this.dragging) ? this.picked.slice() : [this.dragging];
      this.move(ids, t.to, at);
      this.dragging = null;
    });
    this.root.addEventListener('dragend', () => { this.dragging = null; this.markOver(null); });
  }
}

/**
 * 손패를 어떤 순서로 볼지는 취향이라 판이 끝나도 들고 간다.
 * 매판 색깔순으로 되돌아가면 숫자순으로 보는 사람은 매번 다시 눌러야 한다.
 */
const SORT_KEY = 'hoax:rkSort';

function loadSortMode(): 'color' | 'number' {
  try {
    return localStorage.getItem(SORT_KEY) === 'number' ? 'number' : 'color';
  } catch {
    return 'color';
  }
}

function saveSortMode(mode: 'color' | 'number'): void {
  try {
    localStorage.setItem(SORT_KEY, mode);
  } catch {
    /* 사생활 보호 모드 등 — 못 저장하면 이번 판만 유지되는 것뿐이라 무시 */
  }
}

const SORT_BTN = (mode: 'color' | 'number'): string =>
  `<button class="rk-btn ghost" id="rk-sort">${mode === 'color' ? '숫자순' : '색깔순'}</button>`;

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
/* 새 조합 자리 — 작으면 눈에 안 띄어서 엉뚱하게 남의 조합 위에 떨어뜨리게 된다.
   남는 가로폭을 다 먹게 해서 "여기가 빈 자리" 임이 바로 보이게 했다. */
.rk-newset{display:flex;align-items:center;justify-content:center;
  flex:1 1 220px;min-width:200px;min-height:60px;
  padding:8px 14px;border:2px dashed var(--teal-300);border-radius:var(--radius-md);
  background:rgba(63,179,162,.06);
  font-size:12.5px;font-weight:800;color:var(--accent);}

/* 끌고 온 타일이 지금 어디에 떨어질지 — 받는 쪽을 직접 밝힌다 */
.rk-set.is-over,.rk-newset.is-over{border-color:var(--accent);
  background:var(--accent-soft);box-shadow:0 0 0 3px rgba(63,179,162,.22);}
.rk-newset:hover{border-color:var(--accent);background:rgba(63,179,162,.12);}

/* 타일 */
.rk-tile{font:inherit;font-weight:900;font-size:17px;width:34px;height:46px;flex:0 0 auto;
  display:flex;align-items:center;justify-content:center;border-radius:7px;
  background:#fffdf6;border:2px solid #e4dcc8;color:#333;cursor:default;
  box-shadow:0 1px 2px rgba(0,0,0,.12);padding:0;}
/* 네 색 — 숫자만 칠하면 34px 타일에서 빨강/주황, 파랑/검정이 잘 안 갈린다.
   테두리와 바탕까지 같은 계열로 물들여서 멀리서도 색 덩어리로 읽히게 했다.
   빨강은 더 깊게, 주황은 더 노랗게 밀어 둘 사이를 벌렸다. */
.rk-tile.c-red{color:#c62828;border-color:#e2928b;background:#fff0ee;}
.rk-tile.c-blue{color:#1b57c0;border-color:#9ab5e8;background:#edf3fe;}
.rk-tile.c-black{color:#26262b;border-color:#a6a6b0;background:#f1f1f4;}
.rk-tile.c-orange{color:#d9820a;border-color:#eec472;background:#fff6e0;}
.rk-tile.is-joker{padding:0;}
.rk-joker{width:26px;height:26px;display:block;}
.rk-tile.is-movable{cursor:grab;}
.rk-tile.is-movable:hover{transform:translateY(-2px);box-shadow:0 3px 7px rgba(0,0,0,.18);}
/* 고른 타일. 두 번째 줄은 마우스가 그 위에 있을 때도 들린 채로 두려고 쓴다 —
   :hover 규칙이 선택자 우선순위에서 이겨서, 막 누른 타일만 안 올라가 보였다 */
.rk-tile.is-picked,
.rk-tile.is-movable.is-picked:hover{outline:3px solid var(--accent);outline-offset:1px;
  transform:translateY(-11px);box-shadow:0 7px 12px rgba(42,148,136,.35);z-index:1;}

.rk-pickinfo.is-bad{color:var(--danger);}
.rk-notice{flex:0 0 auto;font-size:12.5px;font-weight:700;color:var(--text-muted);
  text-align:center;}
.rk-notice.is-bad{color:var(--danger);}
.rk-notice[hidden]{display:none;}

.rk-actions{flex:0 0 auto;display:flex;gap:6px;justify-content:center;align-items:center;}
.rk-hint{font-size:12.5px;color:var(--text-muted);}
.rk-pickinfo{font-size:12px;font-weight:800;color:var(--accent);margin-right:4px;}
/* 첫 등록 점수 — 30 넘기면 초록으로 바뀜다 */
.rk-meldscore{font-size:12.5px;font-weight:900;color:var(--text-muted);
  background:var(--bg-inset);border:1px solid var(--border-soft);
  padding:3px 10px;border-radius:var(--radius-full);margin-right:4px;}
.rk-meldscore.is-ok{color:var(--mint-500);border-color:var(--mint-300);background:var(--mint-100);}
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
