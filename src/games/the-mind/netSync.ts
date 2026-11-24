/**
 * 더 마인드 네트워크 프로토콜
 *
 * 클라 → 호스트:  tm:hello / tm:ready(레벨 시작 준비) / tm:play(카드 내기) / tm:star(수리검 손들기)
 * 호스트 → 클라:  tm:sync(판 상태) / tm:end
 *
 * ⚠️ sync 는 **사람마다 다르게** 보낸다. 받는 사람 자기 카드만 채워 보내고 남의 카드는 지운다.
 *    남의 숫자가 보이면 게임이 통째로 무너진다 (모르는 게 전부인 게임이라서).
 *    장수(left)는 가리지 않는다 — 원래 테이블에서도 몇 장 남았는지는 다 보인다.
 */

import type { GameMessage, GameResult } from '../types';
import type { MindPlayer, NewsLine } from './rules';

const T_HELLO = 'tm:hello';
const T_SYNC = 'tm:sync';
const T_READY = 'tm:ready';
const T_PLAY = 'tm:play';
const T_STAR = 'tm:star';
const T_END = 'tm:end';

export type Phase = 'ready' | 'play' | 'done';

export interface SyncPayload {
  phase: Phase;
  level: number;
  goal: number;
  lives: number;
  stars: number;
  players: MindPlayer[];
  /** 지금까지 제대로 나온 카드 (마지막이 가장 최근). 화면 표시용이라 뒤쪽만 보낸다 */
  pile: number[];
  /** 실수·수리검으로 버려진 카드 */
  burned: number[];
  news: NewsLine;
}

export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  return p && typeof p.peerId === 'string' ? { peerId: p.peerId } : null;
}

export function encodeSync(p: SyncPayload): GameMessage {
  return { type: T_SYNC, payload: p };
}
export function decodeSync(msg: GameMessage): SyncPayload | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<SyncPayload> | null;
  if (!p || !Array.isArray(p.players)) return null;
  const phase: Phase = p.phase === 'play' || p.phase === 'done' ? p.phase : 'ready';
  const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);
  const arr = (v: unknown): number[] => (Array.isArray(v) ? (v as number[]) : []);
  return {
    phase,
    level: num(p.level, 1),
    goal: num(p.goal, 8),
    lives: num(p.lives, 0),
    stars: num(p.stars, 0),
    players: p.players as MindPlayer[],
    pile: arr(p.pile),
    burned: arr(p.burned),
    news: isNews(p.news) ? p.news : { text: '', bad: false },
  };
}

function isNews(v: unknown): v is NewsLine {
  return !!v && typeof (v as NewsLine).text === 'string';
}

export function encodeReady(from: string): GameMessage {
  return { type: T_READY, payload: { from } };
}
export function decodeReady(msg: GameMessage): { from: string } | null {
  if (msg.type !== T_READY) return null;
  const p = msg.payload as { from?: unknown } | null;
  return p && typeof p.from === 'string' ? { from: p.from } : null;
}

export function encodePlay(from: string, card: number): GameMessage {
  return { type: T_PLAY, payload: { from, card } };
}
export function decodePlay(msg: GameMessage): { from: string; card: number } | null {
  if (msg.type !== T_PLAY) return null;
  const p = msg.payload as Record<string, unknown> | null;
  if (!p || typeof p['from'] !== 'string' || typeof p['card'] !== 'number') return null;
  return { from: p['from'] as string, card: p['card'] as number };
}

export function encodeStar(from: string, on: boolean): GameMessage {
  return { type: T_STAR, payload: { from, on } };
}
export function decodeStar(msg: GameMessage): { from: string; on: boolean } | null {
  if (msg.type !== T_STAR) return null;
  const p = msg.payload as Record<string, unknown> | null;
  if (!p || typeof p['from'] !== 'string') return null;
  return { from: p['from'] as string, on: p['on'] === true };
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
