/**
 * 스토리텔링 네트워크 프로토콜 — 호스트 authoritative.
 *
 * 메시지:
 *   sd:hello     게스트 → 호스트. 합류/재동기 요청
 *   sd:sync      호스트 → target. 현재 게임 전체 상태(책/컷 포함) — 합류·복구용
 *   sd:turn      호스트 → 전체. 새 턴 시작 — 각 좌석의 배정(책/제시어 or 직전컷 유령)
 *   sd:progress  그리는 사람 → 호스트. 진행 중 stroke (타임아웃 시에도 컷 보존)
 *   sd:done      그리는 사람 → 호스트. 이번 컷 최종 제출
 *   sd:reveal    호스트 → 전체. 모든 책(완성 이야기) — 슬라이드쇼 감상 시작
 *   sd:end       호스트 → 전체. 게임 종료(승패 없음, GameResult winner=null)
 *
 * 타이머: sd:turn 의 turnStartedAt 은 호스트 시계. 각 클라는 "수신 시각"을 기준으로
 *   durationMs 카운트다운 → cross-clock 오차 없이 각자 정확히 셈 (그림퀴즈와 동일 전략).
 */

import type { GameMessage, GameResult } from '../types';
import type { StoryDrawGame, StoryBook, StoryPhase, StrokeData } from './rules';

const T_HELLO = 'sd:hello';
const T_SYNC = 'sd:sync';
const T_TICK = 'sd:tick';
const T_TURN = 'sd:turn';
const T_PROGRESS = 'sd:progress';
const T_DONE = 'sd:done';
const T_REVEAL = 'sd:reveal';
const T_END = 'sd:end';

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

// ── sync (전체 상태) ──
export function encodeSync(game: StoryDrawGame): GameMessage {
  return { type: T_SYNC, payload: { game } };
}
export function decodeSync(msg: GameMessage): { game: StoryDrawGame } | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as { game?: unknown } | null;
  if (!p || !p.game || !Array.isArray((p.game as StoryDrawGame).books)) return null;
  return { game: p.game as StoryDrawGame };
}

// ── tick (경량 주기 broadcast) ──
// 무거운 sync(책/컷 stroke 전체)를 2.5초마다 broadcast 하면 호스트 업링크가 폭주해 핑이 튄다.
// 주기 broadcast 는 turn/phase 만 담은 tick 으로 하고, 뒤처진 클라만 hello 로 전체 sync 를 target 요청.
export function encodeTick(turn: number, phase: StoryPhase): GameMessage {
  return { type: T_TICK, payload: { turn, phase } };
}
export function decodeTick(msg: GameMessage): { turn: number; phase: StoryPhase } | null {
  if (msg.type !== T_TICK) return null;
  const p = msg.payload as { turn?: unknown; phase?: unknown } | null;
  if (!p || typeof p.turn !== 'number' || typeof p.phase !== 'string') return null;
  return { turn: p.turn, phase: p.phase as StoryPhase };
}

// ── turn (새 턴 배정) ──
export interface SeatAssignment {
  seat: number;
  bookIndex: number;
  /** 턴 0 — 제시어 */
  prompt?: string;
  /** 턴 >0 — 직전 컷 stroke (옅게 깔아줄 유령) */
  ghost?: StrokeData[];
}
export interface TurnPayload {
  turn: number;
  durationMs: number;
  turnStartedAt: number;
  assignments: SeatAssignment[];
}
export function encodeTurn(p: TurnPayload): GameMessage {
  return { type: T_TURN, payload: p };
}
export function decodeTurn(msg: GameMessage): TurnPayload | null {
  if (msg.type !== T_TURN) return null;
  const p = msg.payload as Partial<TurnPayload> | null;
  if (!p || !Array.isArray(p.assignments)) return null;
  return {
    turn: typeof p.turn === 'number' ? p.turn : 0,
    durationMs: typeof p.durationMs === 'number' ? p.durationMs : 60000,
    turnStartedAt: typeof p.turnStartedAt === 'number' ? p.turnStartedAt : 0,
    assignments: p.assignments as SeatAssignment[],
  };
}

// ── progress / done (그리는 사람 → 호스트) ──
export interface CutPayload {
  peerId: string;
  nickname: string;
  bookIndex: number;
  turn: number;
  strokes: StrokeData[];
}
function encodeCut(type: string, p: CutPayload): GameMessage {
  return { type, payload: p };
}
function decodeCut(type: string, msg: GameMessage): CutPayload | null {
  if (msg.type !== type) return null;
  const p = msg.payload as Partial<CutPayload> | null;
  if (!p || typeof p.bookIndex !== 'number' || !Array.isArray(p.strokes)) return null;
  return {
    peerId: typeof p.peerId === 'string' ? p.peerId : '',
    nickname: typeof p.nickname === 'string' ? p.nickname : '',
    bookIndex: p.bookIndex,
    turn: typeof p.turn === 'number' ? p.turn : 0,
    strokes: p.strokes as StrokeData[],
  };
}
export const encodeProgress = (p: CutPayload): GameMessage => encodeCut(T_PROGRESS, p);
export const decodeProgress = (msg: GameMessage): CutPayload | null => decodeCut(T_PROGRESS, msg);
export const encodeDone = (p: CutPayload): GameMessage => encodeCut(T_DONE, p);
export const decodeDone = (msg: GameMessage): CutPayload | null => decodeCut(T_DONE, msg);

// ── reveal (슬라이드쇼용 전체 책) ──
export function encodeReveal(books: StoryBook[]): GameMessage {
  return { type: T_REVEAL, payload: { books } };
}
export function decodeReveal(msg: GameMessage): { books: StoryBook[] } | null {
  if (msg.type !== T_REVEAL) return null;
  const p = msg.payload as { books?: unknown } | null;
  if (!p || !Array.isArray(p.books)) return null;
  return { books: p.books as StoryBook[] };
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
