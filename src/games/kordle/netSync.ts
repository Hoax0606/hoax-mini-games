/**
 * 꼬들 네트워크 프로토콜 (호스트 authoritative)
 *
 * 클라 → 호스트:  kd:hello / kd:setword(출제) / kd:guess(추측)
 * 호스트 → 클라:  kd:sync(전체 공개 상태) / kd:mine(내 추측 복원, target) /
 *                kd:rejected(거절 사유, target) / kd:end(per-peer 결과)
 *
 * **다른 사람 추측 단어는 공개 상태에 안 담는다.** 색(Mark)만 담아서 보낸다.
 * 안 그러면 남의 추측을 베껴서 정답에 접근할 수 있다.
 * 자기 추측 글자는 각 클라가 로컬에 들고 있고(자기가 친 거라서),
 * 재접속해서 날아간 경우에만 kd:mine 으로 호스트가 되돌려준다.
 */

import type { GameMessage, GameResult } from '../types';
import type { Mark, Phase, JamoLen } from './rules';

const T_HELLO = 'kd:hello';
const T_SETWORD = 'kd:setword';
const T_GUESS = 'kd:guess';
const T_SYNC = 'kd:sync';
const T_MINE = 'kd:mine';
const T_REJECTED = 'kd:rejected';
const T_END = 'kd:end';

// ============================================
// 공개 상태
// ============================================

/** 한 사람의 공개 진행 상황 — 추측 글자는 빠져 있고 색만 있다 */
export interface PublicPlayer {
  peerId: string;
  nickname: string;
  /** 시도별 채점 결과. marks.length 가 곧 시도 횟수 */
  marks: Mark[][];
  solved: boolean;
  failed: boolean;
  /** 끝낸 사람만 숫자, 진행 중이면 null */
  elapsedMs: number | null;
  /** 이번 라운드 점수 (reveal 에서 확정) */
  roundScore: number;
  /** 누적 총점 */
  total: number;
}

export interface KdPublic {
  phase: Phase;
  /** 1부터 */
  round: number;
  /** 0 이면 무제한 */
  totalRounds: number;
  jamoLen: JamoLen;
  /** 이번 라운드 출제자. 1인 모드(랜덤 출제)면 null */
  setterPeerId: string | null;
  players: PublicPlayer[];
  /** reveal / ended 에서만 채워진다. 그 전엔 null (정답 유출 방지) */
  answer: string | null;
}

// ============================================
// 클라 → 호스트
// ============================================

export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return { peerId: p.peerId };
}

// 플랫폼이 game_msg.from 을 게임 모듈에 넘기지 않으므로 송신자를 payload 에 담는다
// (라이어 게임·가짜 화가와 동일한 규약).
export function encodeSetWord(from: string, word: string): GameMessage {
  return { type: T_SETWORD, payload: { from, word } };
}
export function decodeSetWord(msg: GameMessage): { from: string; word: string } | null {
  if (msg.type !== T_SETWORD) return null;
  const p = msg.payload as { from?: unknown; word?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.word !== 'string') return null;
  return { from: p.from, word: p.word };
}

export function encodeGuess(from: string, word: string): GameMessage {
  return { type: T_GUESS, payload: { from, word } };
}
export function decodeGuess(msg: GameMessage): { from: string; word: string } | null {
  if (msg.type !== T_GUESS) return null;
  const p = msg.payload as { from?: unknown; word?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.word !== 'string') return null;
  return { from: p.from, word: p.word };
}

// ============================================
// 호스트 → 클라
// ============================================

export function encodeSync(pub: KdPublic): GameMessage {
  return { type: T_SYNC, payload: pub };
}
export function decodeSync(msg: GameMessage): KdPublic | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<KdPublic> | null;
  if (!p || !Array.isArray(p.players) || typeof p.round !== 'number') return null;
  return p as KdPublic;
}

/** 재접속한 사람에게 자기 추측 글자를 되돌려준다 (색은 sync 에 이미 있음) */
export function encodeMine(round: number, guesses: readonly string[]): GameMessage {
  return { type: T_MINE, payload: { round, guesses } };
}
export function decodeMine(msg: GameMessage): { round: number; guesses: string[] } | null {
  if (msg.type !== T_MINE) return null;
  const p = msg.payload as { round?: unknown; guesses?: unknown } | null;
  if (!p || typeof p.round !== 'number' || !Array.isArray(p.guesses)) return null;
  return { round: p.round, guesses: p.guesses.filter((g): g is string => typeof g === 'string') };
}

export function encodeRejected(message: string): GameMessage {
  return { type: T_REJECTED, payload: { message } };
}
export function decodeRejected(msg: GameMessage): { message: string } | null {
  if (msg.type !== T_REJECTED) return null;
  const p = msg.payload as { message?: unknown } | null;
  if (!p || typeof p.message !== 'string') return null;
  return { message: p.message };
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
