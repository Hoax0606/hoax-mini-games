/**
 * 라면가게 순수 로직 — 타입/상수, 냄비 상태·정산, 업그레이드 비용.
 *
 * DOM/캔버스/네트워크 의존 없음. 런타임 가변 상태(냄비 현재값)는 index.ts 가 들고,
 * 이 파일은 "규칙"만 제공한다.
 *
 * 컨셉(확정): 손님·주문·인내심 없음. 원작처럼 물→면→끓이기로 라면을 만들어 올리면
 * 즉시 팔려 매출이 오른다. 빠르게 많이 만들수록 매출↑. 종료 시 매출 많은 사람 승.
 * 랜덤 요소가 없어 모두 동일한 빈 가게에서 시작 → seed 동기화 불필요(공정).
 */

import { RAMEN_PRICE, TOPPINGS, type ToppingId } from './defs';

// ============================================
// 타입
// ============================================

export type PotState = 'empty' | 'water' | 'cooking' | 'ready' | 'overcooked';

export interface Pot {
  id: number;
  state: PotState;
  /** 완성 그릇에 올린 토핑 (ready 상태에서 추가, 매출 가산) */
  toppings: ToppingId[];
  /** cooking 진입 시각(gameTime, ms). 다른 상태에선 0 */
  cookStartGt: number;
  /** ready 진입 시각(gameTime, ms). overcook 판정용. 다른 상태에선 0 */
  readyGt: number;
}

export interface Upgrades {
  /** 동시 사용 냄비 수 (2→4) */
  pots: number;
  /** 화력 레벨 (0~2). 끓는시간 배율에 사용 */
  firepower: number;
}

export type UpgradeKind = 'pots' | 'firepower';

// ============================================
// 상수 (타이밍/경제)
// ============================================

/** 기본 끓는 시간(ms) — 화력 배율이 곱해진다 */
export const BOIL_MS = 4500;
/** ready 후 방치 허용 창(ms). 넘기면 overcooked(불음 → 버려야 함, 매출 0) */
export const OVERCOOK_MS = 6000;

/** 화력 레벨별 끓는시간 배율 (낮을수록 빨리 끓음) */
export const FIREPOWER_MULT = [1.0, 0.78, 0.62];

export const START_POTS = 2;
export const MAX_POTS = 4;

/**
 * 업그레이드 비용 — 현재 레벨(다음 단계로 갈 때) 기준.
 *   pots:  2→3 = COST[0], 3→4 = COST[1]
 *   firepower: 0→1 = COST[0], 1→2 = COST[1]
 */
export const UPGRADE_COST = {
  pots: [5000, 9000],
  firepower: [4500, 8000],
} as const;

// ============================================
// 초기화
// ============================================

export function initialUpgrades(): Upgrades {
  return { pots: START_POTS, firepower: 0 };
}

export function initialPots(count: number): Pot[] {
  const pots: Pot[] = [];
  for (let i = 0; i < count; i++) {
    pots.push({ id: i, state: 'empty', toppings: [], cookStartGt: 0, readyGt: 0 });
  }
  return pots;
}

// ============================================
// 정산
// ============================================

/** 완성 그릇 판매가 = 라면 기본가 + 올린 토핑 추가금 */
export function bowlPrice(pot: Pot): number {
  let sum = RAMEN_PRICE;
  for (const t of pot.toppings) sum += TOPPINGS.find((d) => d.id === t)?.price ?? 0;
  return sum;
}

// ============================================
// 업그레이드
// ============================================

/** 다음 단계 비용. 이미 최대면 null */
export function nextUpgradeCost(up: Upgrades, kind: UpgradeKind): number | null {
  if (kind === 'pots') {
    const lvl = up.pots - START_POTS; // 0,1
    return up.pots >= MAX_POTS ? null : UPGRADE_COST.pots[lvl] ?? null;
  }
  // firepower
  return up.firepower >= FIREPOWER_MULT.length - 1 ? null : UPGRADE_COST.firepower[up.firepower] ?? null;
}

/** 냄비 끓는 시간(ms) — 화력 반영 */
export function boilTimeMs(up: Upgrades): number {
  return BOIL_MS * (FIREPOWER_MULT[up.firepower] ?? 1);
}
