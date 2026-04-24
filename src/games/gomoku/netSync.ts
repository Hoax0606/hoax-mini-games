/**
 * 오목 네트워크 프로토콜
 *
 * 호스트 authoritative 설계:
 *   - 수 둘 때: 게스트는 호스트에게 `go:request_move`로 의사 전달
 *   - 호스트는 검증(내 턴? 합법?) 후 `go:move` broadcast (호스트 본인 수 포함)
 *   - 각 클라이언트는 `go:move` 받으면 로컬 board[y][x] 갱신 + 승리 판정
 *   - 호스트만 최종 판정권. `go:end` broadcast (per-peer 시점별 결과)
 *
 * 타이머:
 *   - 각 클라이언트가 로컬 타이머(30초)를 돌리되, 실제 시간초과 판정은 호스트만.
 *   - 호스트가 time up 감지 → go:end(reason='timeout') broadcast
 *
 * 관전자/늦게 들어온 게스트 초기 동기화:
 *   - 새로 들어온 쪽이 `go:hello` 송신 → 호스트가 그 peer에게 `go:sync` target 전송
 *   - 그 후로는 일반 `go:move` 따라가면 됨
 */

import type { GameMessage, GameResult } from '../types';
import type { Board } from './board';

const T_REQUEST = 'go:request_move';
const T_MOVE = 'go:move';
const T_SYNC = 'go:sync';
const T_HELLO = 'go:hello';
const T_END = 'go:end';

// ============================================
// Request Move (게스트 → 호스트)
// ============================================

export function encodeRequestMove(x: number, y: number): GameMessage {
  return { type: T_REQUEST, payload: { x, y } };
}

export function decodeRequestMove(msg: GameMessage): { x: number; y: number } | null {
  if (msg.type !== T_REQUEST) return null;
  const p = msg.payload as { x?: number; y?: number } | null;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  return { x: p.x, y: p.y };
}

// ============================================
// Move Accepted (호스트 → 전체 broadcast)
// ============================================

export interface MovePayload {
  x: number;
  y: number;
  stone: 'B' | 'W';
  /** 이번 수의 순번 (1부터). 중복 적용 방어용 */
  moveNumber: number;
}

export function encodeMove(x: number, y: number, stone: 'B' | 'W', moveNumber: number): GameMessage {
  return { type: T_MOVE, payload: { x, y, stone, moveNumber } };
}

export function decodeMove(msg: GameMessage): MovePayload | null {
  if (msg.type !== T_MOVE) return null;
  const p = msg.payload as Partial<MovePayload> | null;
  if (!p) return null;
  if (typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  if (p.stone !== 'B' && p.stone !== 'W') return null;
  if (typeof p.moveNumber !== 'number') return null;
  return { x: p.x, y: p.y, stone: p.stone, moveNumber: p.moveNumber };
}

// ============================================
// Sync (호스트 → 특정 peer, 초기 동기화)
// ============================================

export interface SyncPayload {
  board: Board;
  currentTurn: 'B' | 'W';
  moveNumber: number;
  /** 이번 턴이 시작된 이후 경과된 ms (호스트 기준) */
  turnElapsedMs: number;
  lastMove: { x: number; y: number } | null;
}

export function encodeSync(p: SyncPayload): GameMessage {
  return { type: T_SYNC, payload: p };
}

export function decodeSync(msg: GameMessage): SyncPayload | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<SyncPayload> | null;
  if (!p || !Array.isArray(p.board)) return null;
  if (p.currentTurn !== 'B' && p.currentTurn !== 'W') return null;
  if (typeof p.moveNumber !== 'number') return null;
  if (typeof p.turnElapsedMs !== 'number') return null;
  const lm = p.lastMove;
  const lastMove = lm && typeof lm.x === 'number' && typeof lm.y === 'number'
    ? { x: lm.x, y: lm.y }
    : null;
  return {
    board: p.board as Board,
    currentTurn: p.currentTurn,
    moveNumber: p.moveNumber,
    turnElapsedMs: p.turnElapsedMs,
    lastMove,
  };
}

// ============================================
// Hello (게스트/관전자 초기 동기화 요청)
// ============================================

export function encodeHello(): GameMessage {
  return { type: T_HELLO, payload: {} };
}

export function isHello(msg: GameMessage): boolean {
  return msg.type === T_HELLO;
}

// ============================================
// End (호스트 → 전체 broadcast, peer마다 시점별 result)
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
