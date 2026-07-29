/**
 * 가짜 화가 — 네트워크 프로토콜 (호스트 authoritative)
 *
 * 클라 → 호스트:  fa:hello / fa:stroke / fa:vote / fa:guess
 * 호스트 → 클라:  fa:sync(공개상태) / fa:role(내 역할·제시어, targeted) /
 *                fa:stroke(전원에 획 브로드캐스트) / fa:reveal / fa:end
 *
 * 비밀(역할/제시어)은 sync 에 안 담고 fa:role 로 각 peer 에게만 전달.
 * 그림(strokes)은 공유라 fa:sync 에 전체 포함(지각 합류 복구) + 매 획마다 fa:stroke 브로드캐스트.
 */

import type { GameMessage, GameResult } from '../types';
import type { FakeArtistGame, StrokeData, Role } from './rules';

const T_HELLO = 'fa:hello';
const T_SYNC = 'fa:sync';
const T_ROLE = 'fa:role';
const T_STROKE = 'fa:stroke';
const T_VOTE = 'fa:vote';
const T_GUESS = 'fa:guess';
const T_REVEAL = 'fa:reveal';
const T_END = 'fa:end';

// ── hello (게스트 → 호스트) ──
export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return { peerId: p.peerId };
}

// ── sync (호스트 → 전체: 공개 상태 전체) ──
export function encodeSync(game: FakeArtistGame): GameMessage {
  return { type: T_SYNC, payload: game };
}
export function decodeSync(msg: GameMessage): FakeArtistGame | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<FakeArtistGame> | null;
  if (!p || !Array.isArray(p.players) || !Array.isArray(p.order) || typeof p.phase !== 'string') return null;
  return p as FakeArtistGame;
}

// ── role (호스트 → 플레이어: 내 역할·제시어, targeted) ──
export interface RolePayload {
  role: Role;          // 'fake' | 'citizen'
  word: string;        // 내 제시어 ('' = 마피아, 모름)
  category: string;
  color: string;       // 내 펜 색
  round: number;       // 이 역할이 발급된 라운드 (stale 검사)
}
export function encodeRole(p: RolePayload): GameMessage {
  return { type: T_ROLE, payload: p };
}
export function decodeRole(msg: GameMessage): RolePayload | null {
  if (msg.type !== T_ROLE) return null;
  const p = msg.payload as Partial<RolePayload> | null;
  if (!p || (p.role !== 'fake' && p.role !== 'citizen')) return null;
  return {
    role: p.role,
    word: typeof p.word === 'string' ? p.word : '',
    category: typeof p.category === 'string' ? p.category : '',
    color: typeof p.color === 'string' ? p.color : '#1c1820',
    round: typeof p.round === 'number' ? p.round : 0,
  };
}

// ── stroke (드로어 → 호스트, 그리고 호스트 → 전체): 한 획 ──
export function encodeStroke(from: string, stroke: StrokeData): GameMessage {
  return { type: T_STROKE, payload: { from, stroke } };
}
export function decodeStroke(msg: GameMessage): { from: string; stroke: StrokeData } | null {
  if (msg.type !== T_STROKE) return null;
  const p = msg.payload as { from?: unknown; stroke?: unknown } | null;
  if (!p || typeof p.from !== 'string') return null;
  const s = p.stroke as Partial<StrokeData> | null;
  if (!s || !Array.isArray(s.points)) return null;
  return {
    from: p.from,
    stroke: {
      points: s.points as StrokeData['points'],
      color: typeof s.color === 'string' ? s.color : '#1c1820',
      width: typeof s.width === 'number' ? s.width : 4,
      tool: 'pen',
      shape: 'free',
    },
  };
}

// ── vote (플레이어 → 호스트) ──
export function encodeVote(from: string, target: string): GameMessage {
  return { type: T_VOTE, payload: { from, target } };
}
export function decodeVote(msg: GameMessage): { from: string; target: string } | null {
  if (msg.type !== T_VOTE) return null;
  const p = msg.payload as { from?: unknown; target?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.target !== 'string') return null;
  return { from: p.from, target: p.target };
}

// ── guess (마피아 → 호스트: 제시어 추측) ──
export function encodeGuess(from: string, word: string): GameMessage {
  return { type: T_GUESS, payload: { from, word } };
}
export function decodeGuess(msg: GameMessage): { from: string; word: string } | null {
  if (msg.type !== T_GUESS) return null;
  const p = msg.payload as { from?: unknown; word?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.word !== 'string') return null;
  return { from: p.from, word: p.word };
}

// ── reveal (호스트 → 전체: 결과 시 개별 투표 내역) ──
export function encodeReveal(votes: Record<string, string>): GameMessage {
  return { type: T_REVEAL, payload: { votes } };
}
export function decodeReveal(msg: GameMessage): { votes: Record<string, string> } | null {
  if (msg.type !== T_REVEAL) return null;
  const p = msg.payload as { votes?: unknown } | null;
  if (!p || typeof p.votes !== 'object' || p.votes === null) return null;
  return { votes: p.votes as Record<string, string> };
}

// ── end (호스트 → 각 peer) ──
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
