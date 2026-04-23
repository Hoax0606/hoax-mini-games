/**
 * 배틀 테트리스 네트워크 프로토콜
 *
 * 메시지 4종:
 *   bt:state    — 자기 필드 상태 스냅샷 (10Hz broadcast, 상대 미니뷰용)
 *   bt:garbage  — 특정 peer에게 가비지 공격 (target 지정)
 *   bt:topped   — 탑아웃 알림 (broadcast, 랭킹 집계용)
 *   bt:end      — 게임 종료 + 결과 (호스트 → 각 게스트, 시점별)
 *
 * 각 게임은 자기 필드를 로컬에서 완전히 시뮬레이션하므로
 * 에어하키처럼 60Hz state sync가 불필요. 10Hz로도 관전용으론 충분.
 */

import type { GameMessage, GameResult } from '../types';
import type { Field } from './field';

const T_STATE = 'bt:state';
const T_GARBAGE = 'bt:garbage';
const T_TOPPED = 'bt:topped';
const T_END = 'bt:end';

// ============================================
// 상태 스냅샷 (필드 + 탑아웃 여부 + 라인 수)
// ============================================

export interface StateSnapshotPayload {
  /** 송신자 peerId — GameMessage 자체엔 from 정보가 없어서 payload에 포함 */
  peerId: string;
  field: Field;
  toppedOut: boolean;
  linesCleared: number;
}

export function encodeStateSnapshot(
  peerId: string,
  field: Field,
  toppedOut: boolean,
  linesCleared: number,
): GameMessage {
  return { type: T_STATE, payload: { peerId, field, toppedOut, linesCleared } };
}

export function decodeStateSnapshot(msg: GameMessage): StateSnapshotPayload | null {
  if (msg.type !== T_STATE) return null;
  const p = msg.payload as Partial<StateSnapshotPayload> | null;
  if (!p || typeof p.peerId !== 'string' || !Array.isArray(p.field)) return null;
  return {
    peerId: p.peerId,
    field: p.field as Field,
    toppedOut: p.toppedOut === true,
    linesCleared: typeof p.linesCleared === 'number' ? p.linesCleared : 0,
  };
}

// ============================================
// 가비지 공격
// ============================================

export function encodeGarbageAttack(count: number): GameMessage {
  return { type: T_GARBAGE, payload: { count } };
}

export function decodeGarbageAttack(msg: GameMessage): { count: number } | null {
  if (msg.type !== T_GARBAGE) return null;
  const p = msg.payload as { count?: number } | null;
  if (!p || typeof p.count !== 'number' || p.count < 0) return null;
  return { count: Math.floor(p.count) };
}

// ============================================
// 탑아웃 알림
// ============================================

export function encodeToppedOut(peerId: string): GameMessage {
  return { type: T_TOPPED, payload: { peerId } };
}

export function decodeToppedOut(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_TOPPED) return null;
  const p = msg.payload as { peerId?: string } | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return { peerId: p.peerId };
}

// ============================================
// 게임 종료 (호스트 → 게스트)
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
