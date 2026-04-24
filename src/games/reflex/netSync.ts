/**
 * 반응속도 게임 네트워크 프로토콜
 *
 * 각자 자기 라운드를 독립 실행하고 결과만 공유하는 구조라 메시지가 아주 단순:
 *   - rx:round_done   각 플레이어가 한 라운드 끝날 때 평균 업데이트 broadcast
 *   - rx:player_done  어떤 플레이어가 5라운드 전부 끝났음 (호스트 집계 트리거)
 *   - rx:end          호스트가 전원 완료 감지 후 최종 순위 broadcast (per-peer 결과)
 *
 * 호스트 판정:
 *   모든 플레이어가 rx:player_done 을 보내면 (또는 자기 자신 완료 포함),
 *   평균 반응속도 오름차순 정렬 → rankings → 각 peer 에게 자기 시점 GameResult.
 */

import type { GameMessage, GameResult } from '../types';

const T_ROUND_DONE = 'rx:round_done';
const T_PLAYER_DONE = 'rx:player_done';
const T_END = 'rx:end';

// --- 라운드 중간 점수 (상대 미니뷰용) ---

export interface RoundDonePayload {
  peerId: string;
  /** 지금까지 완료한 라운드 수 (1~5) */
  roundsDone: number;
  /** 현재까지 성공한 라운드의 평균 ms */
  avgMs: number;
  /** 실격(빨강 상태에서 클릭) 라운드 수 */
  foulCount: number;
}

export function encodeRoundDone(p: RoundDonePayload): GameMessage {
  return { type: T_ROUND_DONE, payload: p };
}

export function decodeRoundDone(msg: GameMessage): RoundDonePayload | null {
  if (msg.type !== T_ROUND_DONE) return null;
  const p = msg.payload as Partial<RoundDonePayload> | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return {
    peerId: p.peerId,
    roundsDone: typeof p.roundsDone === 'number' ? p.roundsDone : 0,
    avgMs: typeof p.avgMs === 'number' ? p.avgMs : 0,
    foulCount: typeof p.foulCount === 'number' ? p.foulCount : 0,
  };
}

// --- 플레이어 5라운드 전부 완료 ---

export interface PlayerDonePayload {
  peerId: string;
  /** 최종 평균 ms (성공 라운드 기준). 실패만 했으면 Infinity 대신 -1. */
  finalAvgMs: number;
  foulCount: number;
}

export function encodePlayerDone(p: PlayerDonePayload): GameMessage {
  return { type: T_PLAYER_DONE, payload: p };
}

export function decodePlayerDone(msg: GameMessage): PlayerDonePayload | null {
  if (msg.type !== T_PLAYER_DONE) return null;
  const p = msg.payload as Partial<PlayerDonePayload> | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return {
    peerId: p.peerId,
    finalAvgMs: typeof p.finalAvgMs === 'number' ? p.finalAvgMs : -1,
    foulCount: typeof p.foulCount === 'number' ? p.foulCount : 0,
  };
}

// --- 최종 종료 (호스트 → per-peer) ---

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
