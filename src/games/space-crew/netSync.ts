/**
 * 스페이스 크루 네트워크 프로토콜
 *
 * 게스트 → 호스트   sc:hello / sc:pickTask / sc:play / sc:comm / sc:next
 * 호스트 → 게스트   sc:sync / sc:end
 *
 * 게스트는 **의도만** 보낸다. 트릭 승자, 임무 완료, 실패는 전부 호스트가 정한다.
 * 게스트에겐 남의 손패가 없어서 애초에 판정이 불가능하다.
 *
 * ⚠️ sync 는 사람마다 다르다. 내 손패만 숫자가 들어있고, 남은 **장수만** 보낸다.
 *    공개된 통신 카드는 모두가 봐야 하니 그대로 담는다.
 *    한 번이라도 남의 손패가 새면 이 게임은 성립하지 않는다.
 */

import type { GameMessage, GameResult } from '../types';
import type { Card, CommSlot, Suit } from './rules';
import type { OrderMode } from './missions';

const T_HELLO = 'sc:hello';
const T_PICK = 'sc:pickTask';
const T_PLAY = 'sc:play';
const T_COMM = 'sc:comm';
const T_NEXT = 'sc:next';
const T_SYNC = 'sc:sync';
const T_END = 'sc:end';

/**
 * 판의 단계.
 *   brief   미션 조건 보여주는 중 (전원 준비 대기)
 *   pick    임무를 고르는 중 (사령관부터 시계방향)
 *   play    트릭 진행 중
 *   over    미션 끝 (성공/실패) — 다음 미션 또는 재도전 대기
 */
export type Phase = 'brief' | 'pick' | 'play' | 'over';

/** 남이 보는 통신 공개물 */
export interface CommView {
  peerId: string;
  card: Card;
  /** 데드존 미션이면 null — 카드만 보이고 위치 정보는 없다 */
  slot: CommSlot | null;
  /** 공개한 카드를 이미 냈으면 true (토큰이 빨강으로 뒤집힌 상태) */
  spent: boolean;
}

export interface SyncTask {
  card: Card;
  ownerId: string | null;
  order: number | null;
  done: boolean;
}

export interface SyncPlayer {
  peerId: string;
  nickname: string;
  /** 남은 손패 장수. 숫자는 안 보낸다 */
  handCount: number;
  /** 아직 통신을 안 썼는가 */
  commLeft: boolean;
}

export interface SyncPayload {
  phase: Phase;
  /** 미션 번호와 조건 */
  mission: number;
  taskCount: number;
  orderMode: OrderMode;
  commBlockTricks: number;
  deadZone: boolean;
  commBanned: boolean;

  players: SyncPlayer[];
  commanderId: string;
  /** 지금 행동할 차례인 사람 (pick/play 단계에서 의미 있음) */
  turnPeerId: string;

  /** 받는 사람의 손패. 여기만 숫자가 들어간다 */
  myHand: Card[];
  /**
   * 관전자에게만 채워 보내는 전원 손패 (신 시점).
   * ⚠️ 플레이어에게는 절대 채우지 않는다 — 남의 패가 보이면 협동 게임이 무너진다.
   */
  specHands?: { peerId: string; nickname: string; cards: Card[] }[];
  /** 아직 아무도 안 고른 임무 + 이미 배정된 임무 전부 */
  tasks: SyncTask[];
  /** 지금 트릭에 깔린 카드들 (낸 순서) */
  trick: { peerId: string; card: Card }[];
  /** 지금 트릭의 선 색. 아직 아무도 안 냈으면 null */
  led: Suit | null;
  /** 몇 번째 트릭인가 (1부터) */
  trickNo: number;
  trickTotal: number;
  /** 공개된 통신들 */
  comms: CommView[];

  /** 미션 결과 — phase 가 over 일 때만 */
  result: null | { ok: boolean; reason: string };
  news: string;
}

// ---- 게스트 → 호스트 ----

export function encodeHello(from: string): GameMessage {
  return { type: T_HELLO, payload: { from } };
}
export function decodeHello(msg: GameMessage): { from: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { from?: unknown } | null;
  return p && typeof p.from === 'string' ? { from: p.from } : null;
}

/** 공개된 임무 중 index 번째를 내가 맡겠다 */
export function encodePickTask(from: string, index: number): GameMessage {
  return { type: T_PICK, payload: { from, index } };
}
export function decodePickTask(msg: GameMessage): { from: string; index: number } | null {
  if (msg.type !== T_PICK) return null;
  const p = msg.payload as { from?: unknown; index?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.index !== 'number') return null;
  return { from: p.from, index: p.index };
}

export function encodePlay(from: string, card: Card): GameMessage {
  return { type: T_PLAY, payload: { from, card } };
}
export function decodePlay(msg: GameMessage): { from: string; card: Card } | null {
  if (msg.type !== T_PLAY) return null;
  const p = msg.payload as { from?: unknown; card?: Card } | null;
  if (!p || typeof p.from !== 'string' || !p.card) return null;
  return { from: p.from, card: p.card };
}

/** 통신 — 카드와 토큰 위치. 데드존이면 slot 은 무시된다 */
export function encodeComm(from: string, card: Card, slot: CommSlot): GameMessage {
  return { type: T_COMM, payload: { from, card, slot } };
}
export function decodeComm(msg: GameMessage): { from: string; card: Card; slot: CommSlot } | null {
  if (msg.type !== T_COMM) return null;
  const p = msg.payload as { from?: unknown; card?: Card; slot?: unknown } | null;
  if (!p || typeof p.from !== 'string' || !p.card) return null;
  if (p.slot !== 'top' && p.slot !== 'middle' && p.slot !== 'bottom') return null;
  return { from: p.from, card: p.card, slot: p.slot };
}

/**
 * 다음으로 넘어가자 — brief 단계의 "시작", over 단계의 "다음 미션 / 다시 도전".
 * go 가 false 면 "그만하기"(결과 화면으로).
 */
export function encodeNext(from: string, go: boolean): GameMessage {
  return { type: T_NEXT, payload: { from, go } };
}
export function decodeNext(msg: GameMessage): { from: string; go: boolean } | null {
  if (msg.type !== T_NEXT) return null;
  const p = msg.payload as { from?: unknown; go?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.go !== 'boolean') return null;
  return { from: p.from, go: p.go };
}

// ---- 호스트 → 게스트 ----

export function encodeSync(p: SyncPayload): GameMessage {
  return { type: T_SYNC, payload: p };
}
export function decodeSync(msg: GameMessage): SyncPayload | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as SyncPayload | null;
  return p && Array.isArray(p.players) ? p : null;
}

/** 끝 — 플랫폼 GameResult 를 사람별로 만들어 그대로 보낸다 */
export type EndPayload = GameResult;

export function encodeEnd(p: EndPayload): GameMessage {
  return { type: T_END, payload: p };
}
export function decodeEnd(msg: GameMessage): EndPayload | null {
  if (msg.type !== T_END) return null;
  const p = msg.payload as EndPayload | null;
  return p && typeof p === 'object' && 'summary' in p ? p : null;
}
