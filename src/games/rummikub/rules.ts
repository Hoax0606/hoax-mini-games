/**
 * 루미큐브 — 순수 규칙 모듈 (DOM·네트워크 없음)
 *
 * 타일 106장: 1~13 × 4색 × 2벌(104) + 조커 2장.
 * 각자 14장으로 시작해서 손패를 먼저 비우면 이긴다.
 *
 * 조합은 두 가지뿐이다.
 *   그룹 — 같은 숫자, 색이 전부 다른 3~4장
 *   런   — 같은 색, 연속된 숫자 3장 이상 (13 다음에 1은 없다)
 *
 * 이 게임의 전부는 **테이블 조작**이다. 남이 깔아둔 조합도 마음대로 쪼개고 붙여서
 * 내 타일을 끼워넣을 수 있고, 턴을 끝낼 때 테이블 전체가 유효하기만 하면 된다.
 * 그래서 검증은 "한 조합이 유효한가" 와 "타일이 사라지거나 생기지 않았나" 두 축으로 간다.
 *
 * 조커는 어떤 타일로도 쓴다. 점수를 셀 때만 "대체한 숫자" 가 얼마인지 따져야 해서
 * 유효성 검사와 점수 계산이 같은 자리 찾기 로직을 공유한다.
 */

export type TileColor = 'red' | 'blue' | 'black' | 'orange';

export const COLORS: TileColor[] = ['red', 'blue', 'black', 'orange'];
export const MAX_NUM = 13;
/** 한 사람이 처음에 받는 타일 수 */
export const START_HAND = 14;
/** 첫 등록에 필요한 최소 점수 */
export const FIRST_MELD_MIN = 30;
/** 조합 최소 길이 */
export const MIN_SET = 3;

export interface Tile {
  /** 덱 안에서 유일. 같은 모양이 두 장 있어서 id 로만 구분된다 */
  id: number;
  /** 조커면 색은 의미 없다 (표시용으로만 씀) */
  color: TileColor;
  /** 1~13. 조커는 0 */
  num: number;
  joker: boolean;
}

/** 테이블에 깔린 조합 하나 (놓인 순서 그대로) */
export type TileSet = Tile[];

/** 106장 덱 */
export function buildDeck(): Tile[] {
  const out: Tile[] = [];
  let id = 0;
  for (let copy = 0; copy < 2; copy++) {
    for (const color of COLORS) {
      for (let n = 1; n <= MAX_NUM; n++) out.push({ id: id++, color, num: n, joker: false });
    }
  }
  out.push({ id: id++, color: 'red', num: 0, joker: true });
  out.push({ id: id++, color: 'black', num: 0, joker: true });
  return out;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ============================================
// 조합 판정
// ============================================

/**
 * 런(같은 색 연속)으로 성립하는 시작 숫자를 찾는다. 없으면 null.
 *
 * 조커는 빈자리를 메우고 양 끝으로 늘릴 수도 있어서, "어디서 시작하는 L칸 창"
 * 안에 숫자들이 다 들어가는지를 본다. 1~13 밖으로는 못 나간다.
 */
function runStart(tiles: Tile[]): number | null {
  const nums = tiles.filter((t) => !t.joker);
  if (nums.length === 0) return null; // 조커만 3장 — 색을 정할 수 없어 런으로 안 친다
  const color = nums[0]!.color;
  if (nums.some((t) => t.color !== color)) return null;
  const seen = new Set<number>();
  for (const t of nums) {
    if (seen.has(t.num)) return null; // 같은 숫자 두 장은 런이 될 수 없다
    seen.add(t.num);
  }
  const L = tiles.length;
  const min = Math.min(...nums.map((t) => t.num));
  const max = Math.max(...nums.map((t) => t.num));
  const lo = Math.max(1, max - L + 1);
  const hi = Math.min(min, MAX_NUM - L + 1);
  return lo <= hi ? lo : null;
}

/** 그룹(같은 숫자, 색 전부 다름)인가 */
function isGroup(tiles: Tile[]): boolean {
  if (tiles.length > COLORS.length) return false;
  const nums = tiles.filter((t) => !t.joker);
  if (nums.length === 0) return false; // 조커만으로는 숫자를 정할 수 없다
  const n = nums[0]!.num;
  if (nums.some((t) => t.num !== n)) return false;
  const colors = new Set(nums.map((t) => t.color));
  return colors.size === nums.length; // 같은 색 중복 금지
}

/** 이 조합이 유효한가 */
export function validateSet(tiles: TileSet): boolean {
  if (tiles.length < MIN_SET) return false;
  return isGroup(tiles) || runStart(tiles) !== null;
}

/**
 * 조합 점수. 조커는 **대체한 숫자** 값으로 센다 (원작 규칙).
 * 유효하지 않으면 0.
 */
export function setScore(tiles: TileSet): number {
  if (tiles.length < MIN_SET) return 0;
  if (isGroup(tiles)) {
    const n = tiles.find((t) => !t.joker)!.num;
    return n * tiles.length; // 조커도 같은 숫자를 대신한다
  }
  const start = runStart(tiles);
  if (start === null) return 0;
  // 런은 시작값부터 1씩 올라간다 — 조커가 어디에 있든 그 자리 숫자를 갖는다
  let sum = 0;
  for (let i = 0; i < tiles.length; i++) sum += start + i;
  return sum;
}

/**
 * 조합을 보기 좋게 정렬한다 (턴을 끝낼 때 한 번).
 *
 * 유효성은 놓인 순서와 상관없다 — [12][13][조커] 도 조커를 11로 보면 맞는 조합이다.
 * 그런데 화면엔 12 13 ★ 로 보여서 14처럼 읽힌다. 그래서 확정할 때 숫자 순으로
 * 다시 깔아준다. 조커는 제가 대신하는 자리에 끼워 넣는다.
 */
export function normalizeSet(tiles: TileSet): TileSet {
  if (!validateSet(tiles)) return tiles;
  if (isGroup(tiles)) {
    const order = new Map(COLORS.map((c, i) => [c, i]));
    const nums = tiles.filter((t) => !t.joker)
      .sort((a, b) => (order.get(a.color) ?? 0) - (order.get(b.color) ?? 0));
    return [...nums, ...tiles.filter((t) => t.joker)];
  }
  const start = runStart(tiles)!;
  const byNum = new Map(tiles.filter((t) => !t.joker).map((t) => [t.num, t]));
  const jokers = tiles.filter((t) => t.joker);
  const out: Tile[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const want = start + i;
    const hit = byNum.get(want);
    out.push(hit ?? jokers.pop()!);
  }
  return out;
}

/** 테이블 전체가 유효한가 (조합 하나라도 깨지면 턴을 못 끝낸다) */
export function validateTable(table: TileSet[]): boolean {
  return table.every((s) => validateSet(s));
}

// ============================================
// 커밋 검증 — 호스트가 턴 끝에 한 번 돌린다
// ============================================

export interface CommitOk {
  ok: true;
  /** 이번 턴에 내 손패에서 테이블로 나간 타일들 */
  usedTileIds: number[];
}
export interface CommitNo {
  ok: false;
  reason: string;
}

function idsOf(table: TileSet[]): number[] {
  return table.flat().map((t) => t.id);
}

/**
 * 조합 하나를 비교용 문자열로 (첫 등록 때 "기존 조합 그대로인가" 를 보려고).
 *
 * **id 를 정렬해서** 쓴다. 놓인 순서는 비교에 넣으면 안 된다 —
 * 같은 타일을 그대로 둔 채 순서만 바뀌어도 "테이블을 건드렸다" 고 잘못 걸렸다.
 * 턴을 확정할 때 normalizeSet 이 조합을 다시 깔기 때문에 순서는 얼마든지 달라진다.
 */
function setKey(s: TileSet): string {
  return s.map((t) => t.id).sort((a, b) => a - b).join(',');
}

/**
 * 턴 종료 시 제안된 테이블이 규칙에 맞는지.
 *
 * 보는 것:
 *   1. 타일이 사라지거나 생기지 않았나 (= 기존 테이블 + 내 손패 일부여야 한다)
 *   2. 모든 조합이 유효한가
 *   3. 내 손패에서 최소 한 장은 나갔나 (아무것도 안 내면 그냥 한 장 가져가는 턴이다)
 *   4. 첫 등록이면 — 기존 조합은 손대지 않고, **내 타일만으로** 30점 이상
 *      (원작 규칙. 첫 등록 전엔 남의 조합을 못 건드린다)
 */
export function validateCommit(
  prevTable: TileSet[],
  nextTable: TileSet[],
  hand: Tile[],
  isFirstMeld: boolean,
): CommitOk | CommitNo {
  for (const s of nextTable) {
    if (s.length === 0) return { ok: false, reason: '빈 조합이 있어요' };
  }

  const nextIds = idsOf(nextTable);
  if (new Set(nextIds).size !== nextIds.length) {
    return { ok: false, reason: '같은 타일이 두 번 올라갔어요' };
  }

  const prevIds = new Set(idsOf(prevTable));
  const handIds = new Set(hand.map((t) => t.id));
  const used: number[] = [];
  for (const id of nextIds) {
    if (prevIds.has(id)) continue;
    if (handIds.has(id)) { used.push(id); continue; }
    return { ok: false, reason: '내 것이 아닌 타일이 올라갔어요' };
  }
  // 테이블에 있던 타일은 하나도 빠지면 안 된다 (가져가는 건 금지)
  const nextSet = new Set(nextIds);
  for (const id of prevIds) {
    if (!nextSet.has(id)) return { ok: false, reason: '테이블에서 타일을 가져갈 수 없어요' };
  }

  if (used.length === 0) return { ok: false, reason: '최소 한 장은 내야 해요' };

  const bad = nextTable.find((s) => !validateSet(s));
  if (bad) return { ok: false, reason: '아직 완성되지 않은 조합이 있어요' };

  if (isFirstMeld) {
    // 기존 조합이 그대로 남아 있어야 한다 (첫 등록 전엔 남의 조합 조작 금지)
    const prevKeys = prevTable.map(setKey).sort();
    const keptKeys = nextTable.map(setKey).filter((k) => prevKeys.includes(k)).sort();
    if (prevKeys.join('|') !== keptKeys.join('|')) {
      return { ok: false, reason: '첫 등록 때는 테이블을 건드릴 수 없어요' };
    }
    // 새로 깐 조합만 점수를 센다
    const usedSet = new Set(used);
    const fresh = nextTable.filter((s) => s.every((t) => usedSet.has(t.id)));
    const mixed = nextTable.some((s) =>
      !prevKeys.includes(setKey(s)) && s.some((t) => !usedSet.has(t.id)));
    if (mixed) return { ok: false, reason: '첫 등록 때는 테이블을 건드릴 수 없어요' };
    const score = fresh.reduce((sum, s) => sum + setScore(s), 0);
    if (score < FIRST_MELD_MIN) {
      return { ok: false, reason: `첫 등록은 ${FIRST_MELD_MIN}점 이상이어야 해요 (지금 ${score}점)` };
    }
  }

  return { ok: true, usedTileIds: used };
}

// ============================================
// 점수 · 정렬
// ============================================

/** 손패에 남은 타일 벌점 합. 조커는 30점 (원작) */
export function handPenalty(hand: Tile[]): number {
  return hand.reduce((sum, t) => sum + (t.joker ? 30 : t.num), 0);
}

/** 손패 정렬 — 색으로 묶고 숫자 순. 조커는 맨 뒤 */
export function sortByColor(hand: Tile[]): Tile[] {
  const order = new Map(COLORS.map((c, i) => [c, i]));
  return hand.slice().sort((a, b) => {
    if (a.joker !== b.joker) return a.joker ? 1 : -1;
    const ca = order.get(a.color) ?? 0;
    const cb = order.get(b.color) ?? 0;
    if (ca !== cb) return ca - cb;
    return a.num - b.num;
  });
}

/** 손패 정렬 — 숫자로 묶고 색 순. 조커는 맨 뒤 */
export function sortByNumber(hand: Tile[]): Tile[] {
  const order = new Map(COLORS.map((c, i) => [c, i]));
  return hand.slice().sort((a, b) => {
    if (a.joker !== b.joker) return a.joker ? 1 : -1;
    if (a.num !== b.num) return a.num - b.num;
    return (order.get(a.color) ?? 0) - (order.get(b.color) ?? 0);
  });
}
