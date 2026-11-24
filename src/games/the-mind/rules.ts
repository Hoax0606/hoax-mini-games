/**
 * 더 마인드 — 순수 규칙 모듈 (DOM·네트워크 없음)
 *
 * 1~100 카드를 나눠 갖고 **말 한 마디 없이** 작은 숫자부터 순서대로 낸다.
 * 내가 낸 카드보다 작은 카드를 누가 들고 있었으면 실수 — 그 카드들은 공개되고 생명이 깎인다.
 * 전원이 손을 비우면 레벨 클리어, 다음 레벨은 한 장씩 더.
 *
 * 이 게임의 유일한 정보 채널은 **침묵의 길이**다.
 * 그래서 규칙에 타이머가 없다. 언제 내든 자유고, 그 눈치가 게임 전부다.
 */

/** 카드는 1~100, 중복 없음 */
export const DECK_MAX = 100;

/** 생명·수리검 상한 — 보너스가 계속 쌓이면 긴장이 사라진다 */
export const MAX_LIVES = 5;
export const MAX_STARS = 3;

export interface MindPlayer {
  peerId: string;
  nickname: string;
  /** 오름차순으로 들고 있는 카드. 남에게 보낼 땐 빈 배열로 지운다 */
  cards: number[];
  /** 남은 장수 — 카드를 가려도 몇 장인지는 모두가 안다 */
  left: number;
  /** 이번 판에 직접 낸 카드 수 (결과 화면용) */
  played: number;
  /** 지금 수리검을 쓰자고 손들었나 */
  wantsStar: boolean;
  /** 레벨 시작 준비를 눌렀나 */
  ready: boolean;
}

/** 목표 레벨 — 방 옵션. 여기까지 클리어하면 이긴다 */
export function parseGoal(raw: string | undefined): number {
  const n = Number(raw);
  return n === 5 || n === 8 || n === 12 ? n : 8;
}

/**
 * 시작 생명 = 인원수.
 * 원작 그대로다. 사람이 많을수록 어긋날 구석도 많아지니 그만큼 여유를 준다.
 */
export function startLives(playerCount: number): number {
  return Math.max(2, Math.min(MAX_LIVES, playerCount));
}

/** 레벨을 깬 보상. 2·5·8 레벨은 생명, 3·6·9 레벨은 수리검 (원작 규칙) */
export function bonusFor(clearedLevel: number): { lives: number; stars: number } {
  return {
    lives: clearedLevel === 2 || clearedLevel === 5 || clearedLevel === 8 ? 1 : 0,
    stars: clearedLevel === 3 || clearedLevel === 6 || clearedLevel === 9 ? 1 : 0,
  };
}

/** 인원수 × 레벨 만큼 서로 다른 카드를 뽑아 사람별로 나눠준다 (각자 오름차순) */
export function dealCards(playerCount: number, perPlayer: number): number[][] {
  const deck: number[] = [];
  for (let i = 1; i <= DECK_MAX; i++) deck.push(i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  const hands: number[][] = [];
  for (let p = 0; p < playerCount; p++) {
    hands.push(deck.slice(p * perPlayer, (p + 1) * perPlayer).sort((a, b) => a - b));
  }
  return hands;
}

/**
 * 낸 카드보다 작은 카드를 들고 있던 사람들 — 실수의 피해자들.
 * 낸 본인은 이미 손에서 뺀 뒤라 자연히 빠진다.
 */
export function lowerCardsThan(
  players: readonly MindPlayer[], card: number,
): { peerId: string; nickname: string; cards: number[] }[] {
  const out: { peerId: string; nickname: string; cards: number[] }[] = [];
  for (const p of players) {
    const lower = p.cards.filter((c) => c < card);
    if (lower.length > 0) out.push({ peerId: p.peerId, nickname: p.nickname, cards: lower });
  }
  return out;
}

/** 손에 카드가 남은 사람이 아무도 없으면 레벨 클리어 */
export function isLevelClear(players: readonly MindPlayer[]): boolean {
  return players.every((p) => p.left === 0);
}

/** 수리검은 **전원이 손들어야** 터진다. 한 명이라도 빼면 안 쓴다 (원작 규칙) */
export function allWantStar(players: readonly MindPlayer[]): boolean {
  const alive = players.filter((p) => p.left > 0);
  return alive.length > 0 && alive.every((p) => p.wantsStar);
}

export function allReady(players: readonly MindPlayer[]): boolean {
  return players.length > 0 && players.every((p) => p.ready);
}
