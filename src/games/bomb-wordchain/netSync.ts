/**
 * 폭탄 돌리기 끝말잇기 네트워크 프로토콜 (호스트 authoritative).
 *
 * word-chain 과 거의 동일하나 timeout 메시지 없음(폭탄은 호스트 로컬 타이머 → 종료는 bw:end 로).
 * 폭탄 남은시간은 **절대 전송하지 않는다**(숨김값).
 *
 * 메시지:
 *   bw:hello     게스트 → 호스트 (peerId)
 *   bw:sync      호스트 → target (전체 WordChainGame 공개상태)
 *   bw:submit    현재 턴 게스트 → 호스트 (단어)
 *   bw:accepted  호스트 → 전체 (단어 + 다음 currentTurn)
 *   bw:rejected  호스트 → 송신자 (사유 + 메시지)
 *   bw:end       호스트 → 각 peer (per-peer GameResult, 폭탄 폭발 = 홀더 패배)
 */

import type { GameMessage, GameResult } from '../types';
import type { WordChainGame, PlayerIndex, SubmitResult } from '../word-chain/rules';

const T_HELLO = 'bw:hello';
const T_SYNC = 'bw:sync';
const T_SUBMIT = 'bw:submit';
const T_ACCEPTED = 'bw:accepted';
const T_REJECTED = 'bw:rejected';
const T_END = 'bw:end';

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

// --- sync (Set 은 배열로 직렬화) ---
export function encodeSync(game: WordChainGame): GameMessage {
  return { type: T_SYNC, payload: { ...game, usedWords: [...game.usedWords] } };
}
export function decodeSync(msg: GameMessage): WordChainGame | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as (Omit<WordChainGame, 'usedWords'> & { usedWords?: string[] }) | null;
  if (!p) return null;
  return { ...p, usedWords: new Set(p.usedWords ?? []) };
}

// --- submit ---
export function encodeSubmit(word: string): GameMessage {
  return { type: T_SUBMIT, payload: { word } };
}
export function decodeSubmit(msg: GameMessage): { word: string } | null {
  if (msg.type !== T_SUBMIT) return null;
  const p = msg.payload as { word?: unknown } | null;
  if (!p || typeof p.word !== 'string') return null;
  return { word: p.word };
}

// --- accepted ---
export interface AcceptedPayload {
  word: string;
  byPeerId: string;
  byNickname: string;
  nextTurn: PlayerIndex;
}
export function encodeAccepted(p: AcceptedPayload): GameMessage {
  return { type: T_ACCEPTED, payload: p };
}
export function decodeAccepted(msg: GameMessage): AcceptedPayload | null {
  if (msg.type !== T_ACCEPTED) return null;
  const p = msg.payload as Partial<AcceptedPayload> | null;
  if (!p) return null;
  if (typeof p.word !== 'string' || typeof p.byPeerId !== 'string'
    || typeof p.byNickname !== 'string' || typeof p.nextTurn !== 'number') return null;
  return p as AcceptedPayload;
}

// --- rejected ---
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

// --- end ---
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
