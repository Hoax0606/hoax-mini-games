/**
 * 스페이스 크루 — 순수 규칙
 *
 * 네트워크도 화면도 모른다. 덱을 만들고, 트릭 승자를 정하고, 임무 완료와 실패를
 * 판정하는 것만 한다. 이 게임에서 제일 틀리기 쉬운 건 "따라가기 강제"와
 * "실패 조건"이라, 연결 없이도 그대로 불러볼 수 있게 떼어놨다.
 */

/** 색 4종 + 로켓(트럼프) */
export type Suit = 'pink' | 'blue' | 'green' | 'yellow' | 'rocket';

export const COLOR_SUITS: Suit[] = ['pink', 'blue', 'green', 'yellow'];
/** 색 카드는 1~9, 로켓은 1~4 */
export const COLOR_MAX = 9;
export const ROCKET_MAX = 4;

export interface Card {
  suit: Suit;
  num: number;
}

/** 임무 — 이 카드가 든 트릭을 담당자가 이겨야 한다. 로켓엔 임무가 없다 */
export interface Task {
  card: Card;
  /** 담당자 peerId. 아직 안 고른 임무는 null */
  ownerId: string | null;
  /** 순서 토큰. null 이면 순서 제약 없음. 작은 수부터 완료해야 한다 */
  order: number | null;
  done: boolean;
}

export function sameCard(a: Card, b: Card): boolean {
  return a.suit === b.suit && a.num === b.num;
}

export function cardKey(c: Card): string {
  return `${c.suit}${c.num}`;
}

/** 40장 — 색 4종 × 1~9 + 로켓 1~4 */
export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of COLOR_SUITS) {
    for (let n = 1; n <= COLOR_MAX; n++) deck.push({ suit, num: n });
  }
  for (let n = 1; n <= ROCKET_MAX; n++) deck.push({ suit: 'rocket', num: n });
  return deck;
}

/** Fisher-Yates. 호스트만 부른다(딜러가 한 명이어야 패가 안 갈린다) */
export function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * 인원별 분배 장수.
 * 40장이 3으로 안 나눠떨어져서 3인만 14/13/13 이 된다.
 * 14장 받은 사람은 마지막 트릭 뒤에 1장이 남는데, 그건 쓰지 않고 버린다
 * (트릭을 한 번 더 돌리면 다른 사람이 낼 카드가 없다).
 */
export function dealCounts(playerCount: number): number[] {
  if (playerCount === 3) return [14, 13, 13];
  const each = Math.floor(40 / playerCount);
  return Array.from({ length: playerCount }, () => each);
}

/** 이 미션에서 돌릴 트릭 수 = 가장 적게 받은 사람의 장수 */
export function trickCount(playerCount: number): number {
  return Math.min(...dealCounts(playerCount));
}

/** 손패 정렬 — 색끼리 모으고 숫자 오름차순. 로켓이 맨 뒤 */
const SUIT_ORDER: Suit[] = ['pink', 'blue', 'green', 'yellow', 'rocket'];
export function sortHand(hand: Card[]): Card[] {
  return hand.slice().sort((a, b) => {
    const s = SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit);
    return s !== 0 ? s : a.num - b.num;
  });
}

/** 로켓 4를 받은 사람이 사령관. 매 미션 다시 섞으므로 매번 바뀐다 */
export function commanderOf(hands: Record<string, Card[]>): string | null {
  for (const [peerId, hand] of Object.entries(hands)) {
    if (hand.some((c) => c.suit === 'rocket' && c.num === ROCKET_MAX)) return peerId;
  }
  return null;
}

/**
 * 지금 낼 수 있는 카드.
 * 선 색을 가지고 있으면 **반드시** 그 색만. 없으면 아무거나(로켓 포함).
 * 이 게임에서 제일 자주 헷갈리는 규칙이라 한 곳에 모아둔다.
 */
export function legalPlays(hand: Card[], led: Suit | null): Card[] {
  if (led === null) return hand.slice(); // 리드는 아무거나
  const follow = hand.filter((c) => c.suit === led);
  return follow.length > 0 ? follow : hand.slice();
}

export function canPlay(hand: Card[], led: Suit | null, card: Card): boolean {
  return legalPlays(hand, led).some((c) => sameCard(c, card));
}

/**
 * 트릭 승자의 인덱스.
 * 로켓이 하나라도 있으면 그 중 가장 높은 로켓. 없으면 선 색 중 가장 높은 숫자.
 * 선 색도 로켓도 아닌 카드는 아무리 높아도 못 이긴다.
 */
export function trickWinnerIndex(plays: Card[], led: Suit): number {
  let best = -1;
  let bestIsRocket = false;
  let bestNum = -1;
  plays.forEach((c, i) => {
    const isRocket = c.suit === 'rocket';
    if (!isRocket && c.suit !== led) return; // 못 이기는 카드
    if (isRocket && !bestIsRocket) { best = i; bestIsRocket = true; bestNum = c.num; return; }
    if (isRocket !== bestIsRocket) return;   // 로켓 vs 색이면 위에서 이미 갈림
    if (c.num > bestNum) { best = i; bestNum = c.num; }
  });
  return best;
}

// ============================================
// 통신
// ============================================

export type CommSlot = 'top' | 'middle' | 'bottom';

/**
 * 이 카드를 공개할 수 있는 위치들.
 * 그 색 중 최고면 top, 최저면 bottom, 한 장뿐이면 middle.
 * 하나도 해당 안 되면 빈 배열 — 공개 자체가 불가능하다.
 * 로켓은 영구 금지라 항상 빈 배열.
 */
export function commSlotsFor(hand: Card[], card: Card): CommSlot[] {
  if (card.suit === 'rocket') return [];
  const same = hand.filter((c) => c.suit === card.suit);
  if (!same.some((c) => c.num === card.num)) return [];
  if (same.length === 1) return ['middle'];
  const max = Math.max(...same.map((c) => c.num));
  const min = Math.min(...same.map((c) => c.num));
  const slots: CommSlot[] = [];
  if (card.num === max) slots.push('top');
  if (card.num === min) slots.push('bottom');
  return slots;
}

/** 손패에서 공개 가능한 카드들 — 화면이 고를 수 있는 것만 보여주려고 */
export function communicableCards(hand: Card[]): Card[] {
  return hand.filter((c) => commSlotsFor(hand, c).length > 0);
}

// ============================================
// 임무 판정
// ============================================

export interface TrickOutcome {
  /** 이번 트릭으로 완료된 임무들 */
  completed: Task[];
  /** 실패 사유. null 이면 아직 진행 중 */
  failed: null | 'wrong-winner' | 'out-of-order';
  /** 남은 임무가 없으면 true */
  allDone: boolean;
}

/**
 * 트릭이 끝난 시점에 한 번에 판정한다.
 *
 * 1. 트릭 안의 카드 중 누군가의 임무에 해당하는 게 있는지 본다
 * 2. 그게 **이긴 사람의 임무가 아니면 즉시 실패**. 만회 기회는 없다
 * 3. 이긴 사람의 임무면 완료. 단 순서 토큰이 있으면 앞 순서가 다 끝나 있어야 한다
 *
 * 한 트릭에서 여러 임무가 동시에 완료될 수 있다. 그래서 완료 처리를 다 한 뒤에
 * 순서를 검사하면 안 되고, 작은 순서부터 차례로 보며 검사해야 한다.
 */
export function judgeTrick(tasks: Task[], trickCards: Card[], winnerId: string): TrickOutcome {
  const hit = tasks.filter((t) => !t.done && trickCards.some((c) => sameCard(c, t.card)));

  // 남의 임무 카드를 내가 가져간 경우 — 그 자리에서 끝
  if (hit.some((t) => t.ownerId !== winnerId)) {
    return { completed: [], failed: 'wrong-winner', allDone: false };
  }

  // 순서 토큰이 있는 임무는 앞 순서가 전부 끝나 있어야 한다.
  // 같은 트릭에서 1번과 2번이 함께 완료되는 건 정상이므로 작은 순서부터 처리한다.
  const completed: Task[] = [];
  for (const t of hit.slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99))) {
    if (t.order !== null) {
      const earlierLeft = tasks.some(
        (o) => o.order !== null && o.order < t.order! && !o.done && !completed.includes(o),
      );
      if (earlierLeft) return { completed: [], failed: 'out-of-order', allDone: false };
    }
    completed.push(t);
  }

  const allDone = tasks.every((t) => t.done || completed.includes(t));
  return { completed, failed: null, allDone };
}

/** 트릭을 다 쓰도록 남은 임무가 있으면 실패 */
export function outOfTricks(tasks: Task[]): boolean {
  return tasks.some((t) => !t.done);
}

/** 임무를 사람들에게 최대한 고르게 나눌 때, 다음에 고를 사람 (사령관부터 시계방향) */
export function nextTaskPicker(
  order: string[],
  commanderIndex: number,
  picked: number,
): string {
  return order[(commanderIndex + picked) % order.length]!;
}

/** 화면에 쓸 색 이름 */
export const SUIT_LABEL: Record<Suit, string> = {
  pink: '분홍',
  blue: '파랑',
  green: '초록',
  yellow: '노랑',
  rocket: '로켓',
};
