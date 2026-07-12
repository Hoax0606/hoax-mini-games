/**
 * 끝말잇기 네트워크 프로토콜
 *
 * 동기화 전략 — **호스트 authoritative**:
 *   1. 호스트가 game state 단독 보관. 자기 차례 게스트가 wc:submit 송신
 *   2. 호스트 검증 → 통과면 wc:accepted broadcast / 실패면 wc:rejected 만 송신자에게
 *   3. 호스트가 30초 타이머 감시 → 타임아웃 시 wc:timeout broadcast
 *   4. 게임 종료 시 wc:end per-peer 송신
 *   5. 관전자 합류: wc:hello → 호스트 wc:sync (전체 state)
 *
 * 메시지:
 *   wc:hello     게스트/관전자 → 호스트 (peerId)
 *   wc:sync      호스트 → target (전체 WordChainGame)
 *   wc:submit    현재 턴 게스트 → 호스트 (단어)
 *   wc:accepted  호스트 → 전체 (단어 + 다음 currentTurn)
 *   wc:rejected  호스트 → 송신자 (사유 + 메시지)
 *   wc:timeout   호스트 → 전체 (탈락한 플레이어 인덱스)
 *   wc:end       호스트 → 각 peer (per-peer GameResult)
 */

import type { GameMessage, GameResult } from '../types';
import type { WordChainGame, PlayerIndex, SubmitResult } from './rules';

const T_HELLO = 'wc:hello';
const T_SYNC = 'wc:sync';
const T_SUBMIT = 'wc:submit';
const T_ACCEPTED = 'wc:accepted';
const T_REJECTED = 'wc:rejected';
const T_TIMEOUT = 'wc:timeout';
const T_END = 'wc:end';

// --- hello ---

export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return { peerId: p.peerId };
}

// --- sync ---

export function encodeSync(game: WordChainGame): GameMessage {
  // Set 은 JSON 직렬화 시 사라지므로 usedWords 는 배열로 변환해 전송 후 수신 측에서 복원
  const serializable = { ...game, usedWords: [...game.usedWords] };
  return { type: T_SYNC, payload: serializable };
}
export function decodeSync(msg: GameMessage): WordChainGame | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as (Omit<WordChainGame, 'usedWords'> & { usedWords?: string[] }) | null;
  if (!p) return null;
  return { ...p, usedWords: new Set(p.usedWords ?? []) };
}

// --- submit (게스트 → 호스트) ---

export function encodeSubmit(word: string): GameMessage {
  return { type: T_SUBMIT, payload: { word } };
}
export function decodeSubmit(msg: GameMessage): { word: string } | null {
  if (msg.type !== T_SUBMIT) return null;
  const p = msg.payload as { word?: unknown } | null;
  if (!p || typeof p.word !== 'string') return null;
  return { word: p.word };
}

// --- accepted (호스트 → 전체): 새 단어 + 다음 turn ---

export interface AcceptedPayload {
  word: string;
  byPeerId: string;
  byNickname: string;
  nextTurn: PlayerIndex;
  /** 다음 턴 시작 시각 (호스트의 performance.now). 게스트는 자기 시계 기준으로만 사용. */
  turnStartedAt: number;
}
export function encodeAccepted(p: AcceptedPayload): GameMessage {
  return { type: T_ACCEPTED, payload: p };
}
export function decodeAccepted(msg: GameMessage): AcceptedPayload | null {
  if (msg.type !== T_ACCEPTED) return null;
  const p = msg.payload as Partial<AcceptedPayload> | null;
  if (!p) return null;
  if (typeof p.word !== 'string') return null;
  if (typeof p.byPeerId !== 'string') return null;
  if (typeof p.byNickname !== 'string') return null;
  if (typeof p.nextTurn !== 'number') return null;
  if (typeof p.turnStartedAt !== 'number') return null;
  return p as AcceptedPayload;
}

// --- rejected (호스트 → 송신자만): 사유 안내 ---

export interface RejectedPayload {
  reason: Exclude<SubmitResult, { ok: true }>['reason'];
  message: string;
}
export function encodeRejected(p: RejectedPayload): GameMessage {
  return { type: T_REJECTED, payload: p };
}
export function decodeRejected(msg: GameMessage): RejectedPayload | null {
  if (msg.type !== T_REJECTED) return null;
  const p = msg.payload as Partial<RejectedPayload> | null;
  if (!p || typeof p.message !== 'string') return null;
  const r = p.reason;
  if (r !== 'invalid' && r !== 'wrongStart' && r !== 'duplicate' && r !== 'notInDict') return null;
  return { reason: r, message: p.message };
}

// --- timeout (호스트 → 전체): 누가 타임아웃으로 탈락했는지 ---

export interface TimeoutPayload {
  /** 탈락한 플레이어 인덱스 */
  victimIndex: PlayerIndex;
  /** 다음 턴 (게임 안 끝났을 때만 유효). 끝났으면 -1 */
  nextTurn: PlayerIndex | -1;
  turnStartedAt: number;
  /** 이 타임아웃으로 게임이 끝났을 때(nextTurn===-1) 우승자 peerId.
   *  게스트가 종료 오버레이를 올바르게(승/패) 그리도록 즉시 전달 — 없으면 무승부로 오표시됨. */
  winnerPeerId?: string | null;
}
export function encodeTimeout(p: TimeoutPayload): GameMessage {
  return { type: T_TIMEOUT, payload: p };
}
export function decodeTimeout(msg: GameMessage): TimeoutPayload | null {
  if (msg.type !== T_TIMEOUT) return null;
  const p = msg.payload as Partial<TimeoutPayload> | null;
  if (!p) return null;
  if (typeof p.victimIndex !== 'number') return null;
  if (typeof p.nextTurn !== 'number') return null;
  if (typeof p.turnStartedAt !== 'number') return null;
  return {
    victimIndex: p.victimIndex,
    nextTurn: p.nextTurn,
    turnStartedAt: p.turnStartedAt,
    winnerPeerId: typeof p.winnerPeerId === 'string' ? p.winnerPeerId : null,
  };
}

// --- end (호스트 → per-peer) ---

export function encodeEnd(result: GameResult): GameMessage {
  return { type: T_END, payload: result };
}
export function decodeEnd(msg: GameMessage): GameResult | null {
  if (msg.type !== T_END) return null;
  const p = msg.payload as Partial<GameResult> | null;
  if (!p) return null;
  const w = p.winner;
  if (w !== 'me' && w !== 'opponent' && w !== null) return null;
  return { winner: w, summary: (p.summary ?? {}) as Record<string, unknown> };
}
