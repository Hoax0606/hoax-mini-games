/**
 * 라이어 게임 네트워크 프로토콜 (호스트 authoritative)
 *
 * 클라 → 호스트:  lg:hello / lg:hint / lg:vote / lg:guess
 * 호스트 → 클라:  lg:sync(전체 공개 상태) / lg:role(per-peer 비밀) /
 *                lg:reveal(라운드 결과 투표내역) / lg:rejected(힌트 거절, target) / lg:end
 *
 * 호스트는 상태가 바뀔 때마다 lg:sync 로 전체 공개 상태를 broadcast 한다.
 * 비밀(역할/제시어)은 sync 에 안 담고 라운드 시작 시 lg:role 로 각 peer 에 개별 전송.
 */

import type { GameMessage, GameResult } from '../types';
import type { LiarGame } from './rules';

const T_HELLO = 'lg:hello';
const T_SYNC = 'lg:sync';
const T_ROLE = 'lg:role';
const T_HINT = 'lg:hint';
const T_VOTE = 'lg:vote';
const T_GUESS = 'lg:guess';
const T_REVEAL = 'lg:reveal';
const T_REJECTED = 'lg:rejected';
const T_END = 'lg:end';

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

// --- sync (전체 공개 상태) ---
export function encodeSync(game: LiarGame): GameMessage {
  return { type: T_SYNC, payload: game };
}
export function decodeSync(msg: GameMessage): LiarGame | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<LiarGame> | null;
  if (!p || !Array.isArray(p.players) || !Array.isArray(p.order)) return null;
  return p as LiarGame;
}

// --- role (per-peer 비밀: 내 역할 + 내 단어 + 주제) ---
export interface RolePayload {
  /** 'liar' = 라이어(제시어 모름), 'citizen' = 시민(또는 바보 모드 라이어) */
  role: 'liar' | 'citizen';
  /** 내 제시어. 라이어(일반)는 빈 문자열 */
  word: string;
  category: string;
  /** 이 역할이 발급된 라운드 — sync 의 round 와 어긋나면 stale 로 판단해 재요청 */
  round: number;
}
export function encodeRole(p: RolePayload): GameMessage {
  return { type: T_ROLE, payload: p };
}
export function decodeRole(msg: GameMessage): RolePayload | null {
  if (msg.type !== T_ROLE) return null;
  const p = msg.payload as Partial<RolePayload> | null;
  if (!p || (p.role !== 'liar' && p.role !== 'citizen')) return null;
  return {
    role: p.role,
    word: typeof p.word === 'string' ? p.word : '',
    category: typeof p.category === 'string' ? p.category : '',
    round: typeof p.round === 'number' ? p.round : 0,
  };
}

// --- hint (플레이어 → 호스트) ---
// 플랫폼이 game_msg.from 을 게임 모듈에 넘기지 않으므로, 송신자 peerId 를 payload 에 담는다.
export function encodeHint(from: string, text: string): GameMessage {
  return { type: T_HINT, payload: { from, text } };
}
export function decodeHint(msg: GameMessage): { from: string; text: string } | null {
  if (msg.type !== T_HINT) return null;
  const p = msg.payload as { from?: unknown; text?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.text !== 'string') return null;
  return { from: p.from, text: p.text };
}

// --- vote (플레이어 → 호스트) ---
export function encodeVote(from: string, target: string): GameMessage {
  return { type: T_VOTE, payload: { from, target } };
}
export function decodeVote(msg: GameMessage): { from: string; target: string } | null {
  if (msg.type !== T_VOTE) return null;
  const p = msg.payload as { from?: unknown; target?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.target !== 'string') return null;
  return { from: p.from, target: p.target };
}

// --- guess (라이어 → 호스트) ---
export function encodeGuess(from: string, word: string): GameMessage {
  return { type: T_GUESS, payload: { from, word } };
}
export function decodeGuess(msg: GameMessage): { from: string; word: string } | null {
  if (msg.type !== T_GUESS) return null;
  const p = msg.payload as { from?: unknown; word?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.word !== 'string') return null;
  return { from: p.from, word: p.word };
}

// --- reveal (호스트 → 전체: 결과 공개용 투표 내역) ---
export function encodeReveal(votes: Record<string, string>): GameMessage {
  return { type: T_REVEAL, payload: { votes } };
}
export function decodeReveal(msg: GameMessage): { votes: Record<string, string> } | null {
  if (msg.type !== T_REVEAL) return null;
  const p = msg.payload as { votes?: unknown } | null;
  if (!p || typeof p.votes !== 'object' || p.votes === null) return null;
  return { votes: p.votes as Record<string, string> };
}

// --- rejected (호스트 → 힌트 송신자: 거절 사유) ---
export function encodeRejected(message: string): GameMessage {
  return { type: T_REJECTED, payload: { message } };
}
export function decodeRejected(msg: GameMessage): { message: string } | null {
  if (msg.type !== T_REJECTED) return null;
  const p = msg.payload as { message?: unknown } | null;
  if (!p || typeof p.message !== 'string') return null;
  return { message: p.message };
}

// --- end (호스트 → 각 peer) ---
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
