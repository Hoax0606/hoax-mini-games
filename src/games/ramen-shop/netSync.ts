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

const T_SCORE = 'rs:score';
const T_END = 'rs:end';

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
