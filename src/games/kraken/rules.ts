/**
 * 노 터치 크라켄 — 순수 규칙 (네트워크·DOM 없음)
 *
 * 원작 《Don't Mess with Cthulhu》. 원작의 핵심 두 가지를 그대로 옮겼다:
 *
 *  1) 역할 토큰을 **인원보다 많이** 섞어서 인원수만큼만 나눠준다.
 *     남는 토큰은 아무도 안 보고 빼버린다 → 해적이 몇 명인지 끝까지 확신할 수 없다.
 *     (3인판은 토큰 5개 중 3개만 쓰므로 운 나쁘면 전원이 탐험대일 수도 있다. 원작 옵션 규칙 그대로.)
 *
 *  2) 각자 자기 카드를 보고 구성을 말한 뒤 **자기 앞에서 섞는다**.
 *     그래서 본인도 어느 카드가 보물인지 모른다. 이게 없으면
 *     "내 보물 여기 있어" 하고 짚어줄 수 있어서 게임이 성립하지 않는다.
 *     → 구현에선 "내 손패의 구성(보물 몇 장·크라켄 유무)만 본인에게 알려주고,
 *        카드 한 장 한 장의 정체는 본인에게도 안 보낸다" 로 표현된다.
 */

/** 카드 종류 — 꽝 / 보물 / 크라켄 */
export type CardKind = 'futile' | 'treasure' | 'kraken';

/** 역할 — 탐험대(보물을 다 찾아야 승) / 해적(크라켄이 나오거나 시간 끌면 승) */
export type Role = 'crew' | 'pirate';

export const ROLE_LABEL: Record<Role, string> = {
  crew: '탐험대',
  pirate: '해적',
};

export const KIND_LABEL: Record<CardKind, string> = {
  futile: '꽝',
  treasure: '보물',
  kraken: '크라켄',
};

/** 총 라운드 수. 4라운드를 다 버티면 해적 승리 */
export const ROUNDS = 4;

/** 1라운드에 나눠주는 카드 수. 라운드가 갈수록 한 장씩 줄어든다 (5 → 4 → 3 → 2) */
export const HAND_START = 5;

/** 해당 라운드에 1인당 받는 카드 수 */
export function handSizeForRound(round: number): number {
  return Math.max(1, HAND_START - (round - 1));
}

export interface Setup {
  /** 토큰 더미에 넣는 탐험대 토큰 수 (인원수보다 많을 수 있다) */
  crewTokens: number;
  /** 토큰 더미에 넣는 해적 토큰 수 */
  pirateTokens: number;
  /** 꽝 카드 수 */
  futile: number;
  /** 보물 카드 수 = 인원수 */
  treasure: number;
}

/**
 * 인원별 구성 (원작 공식표 그대로).
 *
 *            3인   4인   5인   6인
 *  탐험대     3     3     4     4     ← 토큰 더미에 넣는 수
 *  해적       2     2     2     2
 *  꽝        11    15    19    23
 *  보물       3     4     5     6     ← 항상 인원수와 같다
 *  크라켄     1     1     1     1
 *
 * 카드 총합은 항상 인원 × 5 라서 꽝은 계산으로 뽑아낸다.
 */
export function setupFor(players: number): Setup {
  const n = Math.max(3, Math.min(6, players));
  return {
    crewTokens: n <= 4 ? 3 : 4,
    pirateTokens: 2,
    treasure: n,
    futile: n * HAND_START - n - 1,
  };
}

/** 제자리 섞기가 아니라 새 배열을 돌려준다 (호출부에서 원본을 그대로 두고 싶을 때가 많아서) */
export function shuffle<T>(src: readonly T[]): T[] {
  const a = src.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 섞인 카드 더미 (인원 × 5장) */
export function buildDeck(players: number): CardKind[] {
  const s = setupFor(players);
  const deck: CardKind[] = [];
  for (let i = 0; i < s.treasure; i++) deck.push('treasure');
  for (let i = 0; i < s.futile; i++) deck.push('futile');
  deck.push('kraken');
  return shuffle(deck);
}

/**
 * 역할 배분. 더미를 섞어서 **앞에서 인원수만큼만** 쓴다 — 나머지는 안 본 채로 버린다.
 * 그래서 해적이 1명일 수도, 2명일 수도 있다 (3인판은 0명도 가능).
 */
export function dealRoles(players: number): Role[] {
  const s = setupFor(players);
  const pool: Role[] = [];
  for (let i = 0; i < s.crewTokens; i++) pool.push('crew');
  for (let i = 0; i < s.pirateTokens; i++) pool.push('pirate');
  return shuffle(pool).slice(0, players);
}
