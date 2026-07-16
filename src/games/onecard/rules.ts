/**
 * 원카드(우노류) 순수 로직 — 카드/덱/유효성/턴 진행/승패.
 *
 * 호스트 authoritative: 호스트가 덱(뽑을더미)·버린더미·전원 손패를 단독 보관하고 검증한다.
 * 여기 함수들은 그 호스트 로직이 쓰는 순수 헬퍼. 게스트는 공개 상태(handCounts/top/color/turn)만 받는다.
 *
 * 규칙(확정):
 *   - 색 or 숫자 or 기호 일치 시 냄. 색바꾸기(wild)/+4(wild4)는 아무 때나.
 *   - 못 내면 1장 뽑고, 그게 낼 수 있으면 내거나 패스(표준 우노).
 *   - 건너뛰기/방향바꾸기(2인이면 skip처럼)/ +2 / +4 효과.
 *   - 손패 다 비우면 완료(finished 순서=순위). 최후 1명 남으면 그 사람 꼴등, 게임 종료.
 */

export type Color = 'r' | 'b' | 'g' | 'y';
export type CardColor = Color | 'w'; // w = 와일드(색 없음)
export type NumberKind = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
export type ActionKind = 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4';
export type CardKind = NumberKind | ActionKind;

export interface Card {
  color: CardColor;
  kind: CardKind;
}

export const COLORS: Color[] = ['r', 'b', 'g', 'y'];

export function isWild(card: Card): boolean {
  return card.kind === 'wild' || card.kind === 'wild4';
}

/**
 * 공격카드 스택 받아치기 가능 여부.
 *   - +2 스택은 +2 또는 +4 로 받아칠 수 있음 (+4 가 상위)
 *   - +4 스택은 +4 로만 받아칠 수 있음 (+2 로는 방어 불가)
 */
export function canCounter(played: CardKind, pending: 'draw2' | 'wild4' | null): boolean {
  if (!pending) return false;
  if (pending === 'draw2') return played === 'draw2' || played === 'wild4';
  return played === 'wild4';
}

/** 표준 108장 덱 생성 (미셔플). */
export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const color of COLORS) {
    deck.push({ color, kind: '0' });
    for (let n = 1; n <= 9; n++) {
      deck.push({ color, kind: String(n) as NumberKind });
      deck.push({ color, kind: String(n) as NumberKind });
    }
    for (const a of ['skip', 'reverse', 'draw2'] as ActionKind[]) {
      deck.push({ color, kind: a });
      deck.push({ color, kind: a });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'w', kind: 'wild' });
    deck.push({ color: 'w', kind: 'wild4' });
  }
  return deck;
}

/** Fisher-Yates 제자리 셔플 (호스트만 — Math.random OK, 손패는 비공개라 seed 동기화 불필요). */
export function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

/**
 * 이 카드를 지금 낼 수 있는지.
 * @param activeColor 현재 활성 색 (와일드로 바뀔 수 있음)
 * @param topKind 버린더미 맨 위 카드의 kind (숫자/기호 일치 비교용)
 */
export function canPlay(card: Card, activeColor: Color, topKind: CardKind): boolean {
  if (isWild(card)) return true;
  if (card.color === activeColor) return true;
  if (card.kind === topKind) return true;
  return false;
}

/** 손패에 낼 수 있는 카드가 하나라도 있는지 (뽑기 강제 판정용) */
export function hasPlayable(hand: Card[], activeColor: Color, topKind: CardKind): boolean {
  return hand.some((c) => canPlay(c, activeColor, topKind));
}

/** 첫 시작 카드로 쓸 수 있는 카드인지 (와일드/특수는 시작 카드로 부적절 → 숫자만) */
export function isPlainNumber(card: Card): boolean {
  return card.color !== 'w' && !['skip', 'reverse', 'draw2', 'wild', 'wild4'].includes(card.kind);
}

// ============================================
// 턴 진행
// ============================================

/**
 * order(고정 좌석 순서) 에서 idx 다음으로 "완료 안 한" 좌석을 dir 방향으로 steps 만큼 이동.
 * finished 에 든 peerId 는 건너뜀. (skip 카드는 steps=2)
 */
export function advanceTurn(
  order: string[],
  idx: number,
  dir: 1 | -1,
  finished: Set<string>,
  steps: number,
): number {
  const n = order.length;
  let i = idx;
  let moved = 0;
  // 살아있는 좌석 기준으로 steps 칸 이동
  for (let guard = 0; guard < n * 4 && moved < steps; guard++) {
    i = (i + dir + n) % n;
    if (!finished.has(order[i]!)) moved++;
  }
  return i;
}
