/**
 * 다트 네트워크 프로토콜
 *
 * 동기화 전략 — **결정론적 시뮬레이션 + 투척 이벤트 브로드캐스트**:
 *   1. 모든 클라이언트가 rules.ts 로 같은 초기 상태를 만든다 (seeds 순서 동일).
 *   2. 현재 차례 플레이어가 다트를 던지면 그 초기속도 + 위치를 브로드캐스트.
 *   3. 받는 쪽은 같은 파라미터로 로컬 물리 시뮬레이션 → 같은 착지점 → 같은 hit → 같은 state 갱신.
 *   4. state 가 결정론적으로 같게 유지되어 추가 동기화 불필요.
 *
 * 메시지:
 *   - dart:throw   투척자 → 전체. 초기속도 + 시작 위치. 다른 클라이언트가 flight 재생.
 *   - dart:end     호스트 → 각 피어. per-peer GameResult (내 시점 승패 반영).
 *                  비호스트는 이 메시지 받아 ctx.endGame 호출.
 *
 * 왜 투척자는 자기 msg 를 다시 처리하지 않는가:
 *   투척자는 로컬에서 startFlight 를 즉시 호출함. 브로드캐스트한 msg 가 호스트 릴레이
 *   때문에 자기 자신에게도 돌아올 수 있으니, 수신 측에서 peerId === myPeerId 면 드랍.
 */

import type { GameMessage, GameResult } from '../types';

const T_THROW = 'dart:throw';
const T_END = 'dart:end';

// --- 투척 이벤트 ---

export interface ThrowPayload {
  /** 투척한 플레이어 peerId */
  peerId: string;
  /** 릴리스 시작 위치 (논리 좌표) */
  fromX: number;
  fromY: number;
  /** 릴리스 속도 (px / ms). 중력은 상수라 별도 전송 X */
  vx: number;
  vy: number;
}

export function encodeThrow(p: ThrowPayload): GameMessage {
  return { type: T_THROW, payload: p };
}

export function decodeThrow(msg: GameMessage): ThrowPayload | null {
  if (msg.type !== T_THROW) return null;
  const p = msg.payload as Partial<ThrowPayload> | null;
  if (!p || typeof p.peerId !== 'string') return null;
  if (typeof p.fromX !== 'number' || typeof p.fromY !== 'number') return null;
  if (typeof p.vx !== 'number' || typeof p.vy !== 'number') return null;
  return {
    peerId: p.peerId,
    fromX: p.fromX,
    fromY: p.fromY,
    vx: p.vx,
    vy: p.vy,
  };
}

// --- 종료 이벤트 (호스트 → per-peer) ---

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
