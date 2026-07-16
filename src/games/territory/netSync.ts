/**
 * 땅따먹기 네트워크 프로토콜 (호스트 authoritative, ~8Hz 스냅샷).
 *
 *   ds:hello  게스트 → 호스트. 합류/재동기
 *   ds:sync   호스트 → 전체. 스냅샷(격자+플레이어+꼬리+타이머)
 *   ds:dir    게스트 → 호스트. 방향 입력 (from = 송신자)
 *   ds:end    호스트 → 각 peer. per-peer 결과
 *
 * 격자는 800칸 → 문자열 1칸=1문자('.'=빈칸, '0'..'5'=소유자 인덱스)로 압축.
 */

import type { GameMessage, GameResult } from '../types';
import { GW, GH } from './rules';

export interface SnapPlayer {
  peerId: string;
  nick: string;
  x: number;
  y: number;
  dir: number;
  alive: boolean;
  score: number;
}
export interface TerritorySnap {
  /** 길이 GW*GH 문자열. '.'=빈칸, 그 외 '0'..'5'=소유자 인덱스 */
  grid: string;
  players: SnapPlayer[];
  /** 플레이어별 꼬리 칸 인덱스 배열 (players 와 같은 순서) */
  trails: number[][];
  phase: 'playing' | 'ended';
  remainMs: number;
  totalMs: number;
}

const T_HELLO = 'ds:hello';
const T_SYNC = 'ds:sync';
const T_DIR = 'ds:dir';
const T_END = 'ds:end';

export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  return p && typeof p.peerId === 'string' ? { peerId: p.peerId } : null;
}

/** 격자 number[] → 문자열 */
export function gridToStr(terr: number[]): string {
  let s = '';
  for (let i = 0; i < terr.length; i++) s += terr[i]! < 0 ? '.' : String(terr[i]);
  return s;
}
/** 문자열 → 격자 number[] */
export function strToGrid(s: string): number[] {
  const g = new Array<number>(GW * GH).fill(-1);
  for (let i = 0; i < g.length && i < s.length; i++) {
    const ch = s[i]!;
    g[i] = ch === '.' ? -1 : ch.charCodeAt(0) - 48;
  }
  return g;
}

export function encodeSync(snap: TerritorySnap): GameMessage {
  return { type: T_SYNC, payload: snap };
}
export function decodeSync(msg: GameMessage): TerritorySnap | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<TerritorySnap> | null;
  if (!p || typeof p.grid !== 'string' || !Array.isArray(p.players)) return null;
  return {
    grid: p.grid,
    players: p.players as SnapPlayer[],
    trails: Array.isArray(p.trails) ? (p.trails as number[][]) : [],
    phase: p.phase === 'ended' ? 'ended' : 'playing',
    remainMs: typeof p.remainMs === 'number' ? p.remainMs : 0,
    totalMs: typeof p.totalMs === 'number' ? p.totalMs : 1,
  };
}

export function encodeDir(from: string, dir: number): GameMessage {
  return { type: T_DIR, payload: { from, dir } };
}
export function decodeDir(msg: GameMessage): { from: string; dir: number } | null {
  if (msg.type !== T_DIR) return null;
  const p = msg.payload as { from?: unknown; dir?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.dir !== 'number') return null;
  return { from: p.from, dir: p.dir };
}

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
