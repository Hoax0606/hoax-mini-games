/**
 * 라면가게 네트워크 프로토콜 (아주 얇음).
 *
 * 랜덤·주문이 없어 모두 동일한 빈 가게에서 시작 → seed 동기화 불필요.
 * 블라인드 경쟁이라 게임 중엔 트래픽 0. 메시지 2종뿐:
 *   rs:score — 각자 영업 종료 시점에 자기 최종 매출 1회 broadcast.
 *   rs:end   — 호스트가 매출 수집 후 각 피어에 per-peer 랭킹 결과 전송.
 *
 * 매출은 각자 로컬 권위(authoritative). 호스트는 종료 시 숫자만 모아 랭킹을 낸다.
 */

import type { GameMessage, GameResult } from '../types';

const T_CLOCK = 'rs:clock';
const T_SCORE = 'rs:score';
const T_END = 'rs:end';
const T_LIVE = 'rs:live';
const T_BOARD = 'rs:board';

// ============================================
// 시계 동기 (호스트 → 전체, 주기적)
// ============================================
// 각 클라가 자기 로컬 시작시각으로만 재면 로드·카운트다운 편차로 시작/종료가 어긋나 불공평.
// 호스트가 authoritative 남은시간을 주기 broadcast → 게스트가 자기 startedAt 을 거기 맞춘다.
export function encodeClock(remainMs: number): GameMessage {
  return { type: T_CLOCK, payload: { remainMs } };
}
export function decodeClock(msg: GameMessage): { remainMs: number } | null {
  if (msg.type !== T_CLOCK) return null;
  const p = msg.payload as { remainMs?: unknown } | null;
  if (!p || typeof p.remainMs !== 'number') return null;
  return { remainMs: Math.max(0, p.remainMs) };
}

// ============================================
// 최종 매출 (각 클라 → 전체, 영업 종료 시 1회)
// ============================================

export interface ScorePayload {
  peerId: string;
  score: number;
}

export function encodeScore(peerId: string, score: number): GameMessage {
  return { type: T_SCORE, payload: { peerId, score } };
}

export function decodeScore(msg: GameMessage): ScorePayload | null {
  if (msg.type !== T_SCORE) return null;
  const p = msg.payload as Partial<ScorePayload> | null;
  if (!p || typeof p.peerId !== 'string' || typeof p.score !== 'number') return null;
  return { peerId: p.peerId, score: Math.max(0, Math.floor(p.score)) };
}

// ============================================
// 중계용 실시간 매출 (각 클라 → 호스트 1:1, 호스트 → 관전자 1:1)
// ============================================
// 플레이어끼리는 여전히 블라인드다 — 실시간 매출은 호스트에게만 가고,
// 호스트는 그걸 모아 관전자에게만 뿌린다. 관전은 신 시점이니까.
export function encodeLive(peerId: string, score: number): GameMessage {
  return { type: T_LIVE, payload: { peerId, score } };
}
export function decodeLive(msg: GameMessage): ScorePayload | null {
  if (msg.type !== T_LIVE) return null;
  const p = msg.payload as Partial<ScorePayload> | null;
  if (!p || typeof p.peerId !== 'string' || typeof p.score !== 'number') return null;
  return { peerId: p.peerId, score: Math.max(0, Math.floor(p.score)) };
}

export interface BoardRow { peerId: string; nickname: string; score: number }
export function encodeBoard(rows: BoardRow[]): GameMessage {
  return { type: T_BOARD, payload: { rows } };
}
export function decodeBoard(msg: GameMessage): BoardRow[] | null {
  if (msg.type !== T_BOARD) return null;
  const p = msg.payload as { rows?: unknown } | null;
  return p && Array.isArray(p.rows) ? (p.rows as BoardRow[]) : null;
}

// ============================================
// 종료 (호스트 → 각 피어)
// ============================================

export function encodeEnd(result: GameResult): GameMessage {
  return { type: T_END, payload: result };
}

export function decodeEnd(msg: GameMessage): GameResult | null {
  if (msg.type !== T_END) return null;
  const p = msg.payload as Partial<GameResult> | null;
  if (!p) return null;
  const w = p.winner;
  if (w !== 'me' && w !== 'opponent' && w !== null) return null;
  return {
    winner: w,
    summary: (p.summary ?? {}) as Record<string, unknown>,
  };
}
