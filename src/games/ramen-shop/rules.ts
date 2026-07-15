/**
 * 라면가게 순수 로직 — 타입/상수, 냄비 상태, 손님/주문/정산, 업그레이드.
 *
 * DOM/캔버스/네트워크 의존 없음. 런타임 가변 상태(냄비·손님 현재값)는 index.ts 가 들고,
 * 이 파일은 "규칙"만 제공한다.
 *
 * 컨셉(확정): 손님이 와서 특정 토핑 조합의 라면을 주문. 물→면→끓이기로 만들고 주문에 맞는
 * 토핑을 올려 그 손님에게 서빙 → 매출. 인내심 다 되면 손님은 화내며 떠남(매출 0).
 * 손님 흐름은 각 가게 독립 랜덤(seed 동기화 없음). 종료 시 매출 많은 사람 승.
 */

import { RAMEN_PRICE, TOPPINGS, type ToppingId } from './defs';

// ============================================
// 타입
// ============================================

export type PotState = 'empty' | 'water' | 'cooking' | 'ready' | 'overcooked';

export interface Pot {
  id: number;
  state: PotState;
  /** 완성 그릇에 올린 토핑 (ready 상태에서 추가) */
  toppings: ToppingId[];
  /** cooking 진입 시각(gameTime, ms). 다른 상태에선 0 */
  cookStartGt: number;
  /** ready 진입 시각(gameTime, ms). overcook 판정용. 다른 상태에선 0 */
  readyGt: number;
}

/** 손님 주문 — 올려야 할 토핑 집합(0~2개). 빈 배열이면 기본 라면. */
export interface Order {
  toppings: ToppingId[];
}

export type CustomerState = 'waiting' | 'served' | 'left';

export interface Customer {
  id: number;
  order: Order;
  /** 앉은 좌석 index */
  seatIndex: number;
  /** 인내심 총량(ms) */
  patienceMs: number;
  /** 착석 시각(gameTime). 인내심은 이때부터 감소 */
  seatedGt: number;
  state: CustomerState;
}

export interface Upgrades {
  /** 동시 사용 냄비 수 (2→4) */
  pots: number;
  /** 화력 레벨 (0~2). 끓는시간 배율 */
  firepower: number;
  /** 동시 좌석 수 (3→5) */
  seats: number;
}

export type UpgradeKind = 'pots' | 'firepower' | 'seats';

// ============================================
// 상수 (타이밍/경제)
// ============================================

export const BOIL_MS = 4500;
/** ready 후 방치 허용 창(ms). 넘기면 overcooked(불음 → 폐기, 매출 0) */
export const OVERCOOK_MS = 6000;
export const FIREPOWER_MULT = [1.0, 0.78, 0.62];

/** 주문 토핑 최대 개수 */
export const MAX_ORDER_TOPPINGS = 2;
/** 손님 입장 간격(ms) 범위 (좌석 나면 이 간격 뒤 다음 손님) */
export const SPAWN_MIN_MS = 2200;
export const SPAWN_MAX_MS = 4200;
/** 인내심(ms) 범위 — 끓이는 시간 고려해 넉넉히 */
export const PATIENCE_MIN_MS = 17000;
export const PATIENCE_MAX_MS = 27000;

export const START_POTS = 2;
export const MAX_POTS = 4;
export const START_SEATS = 3;
export const MAX_SEATS = 5;

export const UPGRADE_COST = {
  pots: [5000, 9000],
  firepower: [4500, 8000],
  seats: [6000, 11000],
} as const;

// ============================================
// 초기화
// ============================================

export function initialUpgrades(): Upgrades {
  return { pots: START_POTS, firepower: 0, seats: START_SEATS };
}

export function initialPots(count: number): Pot[] {
  const pots: Pot[] = [];
  for (let i = 0; i < count; i++) {
    pots.push({ id: i, state: 'empty', toppings: [], cookStartGt: 0, readyGt: 0 });
  }
  return pots;
}

// ============================================
// 손님 / 주문 (각 가게 로컬 랜덤)
// ============================================

/** 랜덤 주문 — 토핑 0~2개(중복 없음) */
export function randomOrder(): Order {
  const count = Math.floor(Math.random() * (MAX_ORDER_TOPPINGS + 1));
  const pool = TOPPINGS.map((t) => t.id);
  const toppings: ToppingId[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    toppings.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
  }
  return { toppings };
}

/** 랜덤 인내심(ms) */
export function randomPatienceMs(): number {
  return PATIENCE_MIN_MS + Math.floor(Math.random() * (PATIENCE_MAX_MS - PATIENCE_MIN_MS + 1));
}

/** 다음 손님 입장까지 랜덤 간격(ms) */
export function randomSpawnGapMs(): number {
  return SPAWN_MIN_MS + Math.floor(Math.random() * (SPAWN_MAX_MS - SPAWN_MIN_MS + 1));
}

// ============================================
// 매칭 / 정산
// ============================================

/** 완성 그릇이 주문과 일치하는지 — 토핑 "집합"이 정확히 같아야 함 */
export function bowlMatchesOrder(pot: Pot, order: Order): boolean {
  if (pot.toppings.length !== order.toppings.length) return false;
  const need = new Set(order.toppings);
  for (const t of pot.toppings) if (!need.has(t)) return false;
  return true;
}

/** 주문 기본 가격(라면 + 토핑 추가금) */
export function orderBasePrice(order: Order): number {
  let sum = RAMEN_PRICE;
  for (const t of order.toppings) sum += TOPPINGS.find((d) => d.id === t)?.price ?? 0;
  return sum;
}

/**
 * 정상 서빙 매출 = 기본가 + 팁. 팁은 남은 인내심 비율에 비례(빨리 줄수록 후함).
 * @param remainRatio 0~1 (남은 인내심 / 총 인내심)
 */
export function servePayment(order: Order, remainRatio: number): number {
  const base = orderBasePrice(order);
  const tip = Math.round(base * 0.5 * Math.max(0, Math.min(1, remainRatio)));
  return base + tip;
}

// ============================================
// 업그레이드
// ============================================

/** 다음 단계 비용. 이미 최대면 null */
export function nextUpgradeCost(up: Upgrades, kind: UpgradeKind): number | null {
  if (kind === 'pots') {
    return up.pots >= MAX_POTS ? null : UPGRADE_COST.pots[up.pots - START_POTS] ?? null;
  }
  if (kind === 'seats') {
    return up.seats >= MAX_SEATS ? null : UPGRADE_COST.seats[up.seats - START_SEATS] ?? null;
  }
  return up.firepower >= FIREPOWER_MULT.length - 1 ? null : UPGRADE_COST.firepower[up.firepower] ?? null;
}

/** 냄비 끓는 시간(ms) — 화력 반영 */
export function boilTimeMs(up: Upgrades): number {
  return BOIL_MS * (FIREPOWER_MULT[up.firepower] ?? 1);
}
