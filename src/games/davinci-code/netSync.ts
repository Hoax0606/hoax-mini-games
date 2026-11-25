/**
 * 다빈치 코드 네트워크 프로토콜
 *
 * 게스트 → 호스트   dv:hello / dv:place / dv:guess / dv:continue / dv:reveal
 * 호스트 → 게스트   dv:sync / dv:end
 *
 * 게스트는 **의도만** 보낸다. 맞았는지 틀렸는지, 누구 차례인지는 전부 호스트가 정한다.
 * 게스트가 판정하면 각자 다른 판을 보게 되고, 숫자를 들고 있지도 않아서 애초에 못 한다.
 *
 * ⚠️ sync 는 사람마다 다르다. rules.maskFor 로 가린 뒤 1:1 로 보낸다.
 *    남의 닫힌 숫자가 한 번이라도 새면 게임이 통째로 무너진다.
 */

import type { GameMessage, GameResult } from '../types';
import type { MaskedTile } from './rules';

const T_HELLO = 'dv:hello';
const T_DRAW = 'dv:draw';
const T_PLACE = 'dv:place';
const T_GUESS = 'dv:guess';
const T_CONTINUE = 'dv:continue';
const T_REVEAL = 'dv:reveal';
const T_SYNC = 'dv:sync';
const T_END = 'dv:end';

/**
 * 판의 단계.
 *   place    조커를 어디에 넣을지 고르는 중 (해당하는 사람만)
 *   draw     뽑기 대기 (풀이 비면 건너뛴다)
 *   guess    상대 타일을 지목하는 중
 *   continue 맞힌 뒤 계속할지 멈출지 고르는 중
 *   reveal   풀이 빈 채로 틀려서, 내 타일 중 하나를 고르는 중
 *   done     끝
 */
export type Phase = 'place' | 'draw' | 'guess' | 'continue' | 'reveal' | 'done';

/** 가려진 플레이어 한 명 (sync 안에 들어가는 형태) */
export interface SyncPlayer {
  peerId: string;
  nickname: string;
  out: boolean;
  tiles: MaskedTile[];
}

export interface SyncPayload {
  phase: Phase;
  /** 지금 차례인 사람 */
  turnPeerId: string;
  players: SyncPlayer[];
  /** 풀에 남은 장수 */
  poolLeft: number;
  /**
   * 내가 방금 뽑은 타일. 받는 사람 것만 채워 보내고 남의 것은 null 로 비운다
   * (뽑은 타일이 뭔지 보이면 그 턴이 통째로 무의미해진다).
   */
  myDrawn: { num: number; color: 'black' | 'white' } | null;
  /** 한 줄 소식. "영희 님이 민수 님의 3을 맞혔어요" 같은 것 */
  news: string;
  /** 제한 시간(초). 0 이면 무제한 */
  turnLimit: number;
  /** 이 턴이 시작된 시각(Date.now). 남은 시간은 각자 계산한다 */
  turnStartedAt: number;
}

/** 끝 — 플랫폼 GameResult 를 사람별로 만들어 그대로 보낸다 */
export type EndPayload = GameResult;

// ---- 게스트 → 호스트 ----

/** 들어왔거나 재연결했다. 호스트가 이걸 받으면 그 사람 몫 sync 를 다시 보낸다 */
export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  return p && typeof p.peerId === 'string' ? { peerId: p.peerId } : null;
}

/** 풀에서 한 장 뽑겠다 */
export function encodeDraw(from: string): GameMessage {
  return { type: T_DRAW, payload: { from } };
}
export function decodeDraw(msg: GameMessage): { from: string } | null {
  if (msg.type !== T_DRAW) return null;
  const p = msg.payload as { from?: unknown } | null;
  return p && typeof p.from === 'string' ? { from: p.from } : null;
}

/** 조커를 index 자리에 넣겠다 */
export function encodePlace(from: string, index: number): GameMessage {
  return { type: T_PLACE, payload: { from, index } };
}
export function decodePlace(msg: GameMessage): { from: string; index: number } | null {
  if (msg.type !== T_PLACE) return null;
  const p = msg.payload as { from?: unknown; index?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.index !== 'number') return null;
  return { from: p.from, index: p.index };
}

/** targetPeerId 의 tileIndex 번째 타일이 num 이라고 본다 */
export function encodeGuess(
  from: string, targetPeerId: string, tileIndex: number, num: number,
): GameMessage {
  return { type: T_GUESS, payload: { from, targetPeerId, tileIndex, num } };
}
export function decodeGuess(
  msg: GameMessage,
): { from: string; targetPeerId: string; tileIndex: number; num: number } | null {
  if (msg.type !== T_GUESS) return null;
  const p = msg.payload as
    { from?: unknown; targetPeerId?: unknown; tileIndex?: unknown; num?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.targetPeerId !== 'string') return null;
  if (typeof p.tileIndex !== 'number' || typeof p.num !== 'number') return null;
  return { from: p.from, targetPeerId: p.targetPeerId, tileIndex: p.tileIndex, num: p.num };
}

/** 맞힌 뒤: 계속 맞힐지(true) 멈출지(false) */
export function encodeContinue(from: string, go: boolean): GameMessage {
  return { type: T_CONTINUE, payload: { from, go } };
}
export function decodeContinue(msg: GameMessage): { from: string; go: boolean } | null {
  if (msg.type !== T_CONTINUE) return null;
  const p = msg.payload as { from?: unknown; go?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.go !== 'boolean') return null;
  return { from: p.from, go: p.go };
}

/** 풀이 빈 채로 틀렸을 때, 공개할 내 타일 고르기 */
export function encodeReveal(from: string, index: number): GameMessage {
  return { type: T_REVEAL, payload: { from, index } };
}
export function decodeReveal(msg: GameMessage): { from: string; index: number } | null {
  if (msg.type !== T_REVEAL) return null;
  const p = msg.payload as { from?: unknown; index?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.index !== 'number') return null;
  return { from: p.from, index: p.index };
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

export function encodeEnd(p: EndPayload): GameMessage {
  return { type: T_END, payload: p };
}
export function decodeEnd(msg: GameMessage): EndPayload | null {
  if (msg.type !== T_END) return null;
  const p = msg.payload as EndPayload | null;
  return p && typeof p === 'object' && 'summary' in p ? p : null;
}
