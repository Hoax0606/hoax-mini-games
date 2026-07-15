/**
 * 똥 피하기 네트워크 프로토콜 — 호스트 authoritative(순위/종료 판정).
 *
 *   dg:hello      게스트 → 호스트. 합류/재동기 요청
 *   dg:start      호스트 → 전체. 게임 시작 — 낙하 패턴 모드 + (동일 모드용)시드
 *   dg:hb         클라 → 호스트. 하트비트(내 생존시간 / 사망 여부). 주기 + 사망 즉시
 *   dg:standings  호스트 → 전체. 전원 생존현황 스냅샷 (옆 패널 표시용)
 *   dg:end        호스트 → 전체. 최종 결과 (per-peer)
 *
 * 각 클라는 dg:start 수신 시각을 t=0 으로 자기 시계 카운트업.
 *   낙하물은 시드+t 의 순수 함수라 동일 모드면 전원 동일 패턴(cross-clock 무관).
 */

import type { GameMessage, GameResult } from '../types';
import type { DodgeMode } from './rules';

const T_HELLO = 'dg:hello';
const T_START = 'dg:start';
const T_HB = 'dg:hb';
const T_STANDINGS = 'dg:standings';
const T_END = 'dg:end';

// ── hello ──
export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return { peerId: p.peerId };
}

// ── start ──
export interface StartPayload {
  mode: DodgeMode;
  /** 동일 모드에서 전원이 쓸 시드. 랜덤 모드에선 각자 자기 시드 생성(무시) */
  seed: number;
}
export function encodeStart(p: StartPayload): GameMessage {
  return { type: T_START, payload: p };
}
export function decodeStart(msg: GameMessage): StartPayload | null {
  if (msg.type !== T_START) return null;
  const p = msg.payload as Partial<StartPayload> | null;
  if (!p) return null;
  return {
    mode: p.mode === 'random' ? 'random' : 'same',
    seed: typeof p.seed === 'number' ? p.seed : 1,
  };
}

// ── heartbeat (클라 → 호스트) ──
export interface HbPayload {
  peerId: string;
  aliveMs: number;
  dead: boolean;
}
export function encodeHeartbeat(p: HbPayload): GameMessage {
  return { type: T_HB, payload: p };
}
export function decodeHeartbeat(msg: GameMessage): HbPayload | null {
  if (msg.type !== T_HB) return null;
  const p = msg.payload as Partial<HbPayload> | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return {
    peerId: p.peerId,
    aliveMs: typeof p.aliveMs === 'number' ? p.aliveMs : 0,
    dead: p.dead === true,
  };
}

// ── standings (호스트 → 전체) ──
export interface StandingEntry {
  peerId: string;
  nickname: string;
  aliveMs: number;
  dead: boolean;
}
export function encodeStandings(entries: StandingEntry[]): GameMessage {
  return { type: T_STANDINGS, payload: { entries } };
}
export function decodeStandings(msg: GameMessage): StandingEntry[] | null {
  if (msg.type !== T_STANDINGS) return null;
  const p = msg.payload as { entries?: unknown } | null;
  if (!p || !Array.isArray(p.entries)) return null;
  return p.entries as StandingEntry[];
}

// ── end ──
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
