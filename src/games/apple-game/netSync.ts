/**
 * 사과 게임 네트워크 프로토콜
 *
 * 메시지 3종:
 *   ag:seed   — 호스트가 게임 시작 직후 1회 broadcast. 게스트가 이걸 받아야 동일한 보드 생성.
 *   ag:score  — 각자 주기적(2Hz) 자기 점수 broadcast. 상대 랭킹 실시간 반영용.
 *   ag:end    — 호스트가 2분 타이머 종료 시 시점별 랭킹 결과를 각 게스트에게 전송.
 *
 * 점수는 각자 로컬 권위(authoritative): 누가 어떤 영역을 터트렸는지 굳이 동기화하지 않고
 * 각자 자기 보드에서 독립 플레이. 2분 끝나면 점수만 수집해서 랭킹.
 */

import type { GameMessage, GameResult } from '../types';

const T_HELLO = 'ag:hello';
const T_SEED = 'ag:seed';
const T_SCORE = 'ag:score';
const T_END = 'ag:end';

// ============================================
// Hello — 게스트/관전자가 "나 진입 완료, seed 줘" 를 호스트에게 요청
// ============================================
// 호스트의 "loop 첫 틱에서 seed broadcast" 는 게스트가 아직 game.load() 중이면 놓침 →
// 빈 보드 상태로 최대 5초(재전송 주기) 대기. hello 핸드셰이크로 즉시 해결.

export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}

export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return { peerId: p.peerId };
}

// ============================================
// 시드
// ============================================

export function encodeSeed(seed: number): GameMessage {
  return { type: T_SEED, payload: { seed } };
}

export function decodeSeed(msg: GameMessage): { seed: number } | null {
  if (msg.type !== T_SEED) return null;
  const p = msg.payload as { seed?: unknown } | null;
  if (!p || typeof p.seed !== 'number') return null;
  return { seed: p.seed >>> 0 };
}

// ============================================
// 점수 스냅샷
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
// 종료 (호스트 → 각 게스트)
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
