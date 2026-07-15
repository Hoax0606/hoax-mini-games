/**
 * 라면가게 재료 정의 테이블.
 *
 * 라면은 한 종류(면). 손님 주문은 "어떤 토핑을 올렸나"로 갈린다.
 * 순수 데이터만 — 렌더(색/이모지)와 로직(가격/주문생성/매칭)이 공유한다.
 * 새 토핑은 이 배열에만 추가하면 주문 생성·정산·UI 가 자동 반영.
 */

export type ToppingId = 'egg' | 'green' | 'dumpling' | 'cheese' | 'kimchi' | 'sprout' | 'shrimp';

export interface ToppingDef {
  id: ToppingId;
  name: string;
  /** 토핑 추가금(원) */
  price: number;
  /** 그릇 위 토핑 점 색 (canvas 하드코드 — 팔레트 범주 안에서) */
  color: string;
  icon: string;
}

/** 라면 기본가(면만) */
export const RAMEN_PRICE = 3000;

/** 토핑 7종 — 주문에 0~2개 섞여 나온다. */
export const TOPPINGS: ToppingDef[] = [
  { id: 'egg',      name: '계란',   price: 700,  color: '#ffe08a', icon: '🥚' },
  { id: 'green',    name: '파',     price: 400,  color: '#86e8c4', icon: '🌿' },
  { id: 'dumpling', name: '만두',   price: 900,  color: '#f0d9a8', icon: '🥟' },
  { id: 'cheese',   name: '치즈',   price: 800,  color: '#ffb845', icon: '🧀' },
  { id: 'kimchi',   name: '김치',   price: 600,  color: '#e5624d', icon: '🌶️' },
  { id: 'sprout',   name: '콩나물', price: 500,  color: '#b6e06a', icon: '🌱' },
  { id: 'shrimp',   name: '새우',   price: 1000, color: '#ff9e88', icon: '🦐' },
];

export const TOPPING_BY_ID: Record<ToppingId, ToppingDef> =
  Object.fromEntries(TOPPINGS.map((t) => [t.id, t])) as Record<ToppingId, ToppingDef>;
