/**
 * 코드네임 네트워크 프로토콜
 *
 * 게스트 → 호스트  cd:hello / cd:hint(힌트) / cd:guess(카드 찍기) / cd:pass(턴 넘기기)
 * 호스트 → 게스트  cd:sync / cd:reject(힌트 퇴짜) / cd:end
 *
 * ⚠️ sync 는 사람마다 다르다. **스파이마스터와 관전자에게만** 색 배치를 보낸다.
 *    팀원에게 색을 보내면 개발자도구로 답을 다 볼 수 있어서 게임이 성립하지 않는다.
 *    공개된 카드의 색은 누구에게나 간다 (이미 뒤집힌 거라 숨길 이유가 없다).
 */

import type { GameMessage, GameResult } from '../types';
import type { Team } from './rules';

const T_HELLO = 'cd:hello';
const T_SYNC = 'cd:sync';
const T_HINT = 'cd:hint';
const T_GUESS = 'cd:guess';
const T_PASS = 'cd:pass';
const T_REJECT = 'cd:reject';
const T_END = 'cd:end';

/** 받는 사람 기준으로 가려진 카드 한 장 */
export interface MaskedCard {
  word: string;
  revealed: boolean;
  /** 공개됐거나 내가 스파이마스터(또는 관전자)일 때만 색이 온다 */
  color: 'red' | 'blue' | 'neutral' | 'assassin' | null;
}

export interface SyncPlayer {
  peerId: string;
  nickname: string;
  team: Team;
  spymaster: boolean;
  gone: boolean;
}

/** 지금 단계 — hint: 스파이마스터가 힌트를 쓰는 중, guess: 팀원이 찍는 중 */
export type CdPhase = 'hint' | 'guess' | 'over';

export interface SyncPayload {
  players: SyncPlayer[];
  cards: MaskedCard[];
  turnTeam: Team;
  phase: CdPhase;
  /** 지금 걸린 힌트. 없으면 null */
  hint: { word: string; count: number } | null;
  /** 이번 힌트로 더 찍을 수 있는 횟수 */
  guessesLeft: number;
  /** 팀별 남은 카드 수 (전원 공개 — 원작도 보드 옆에 숫자가 붙어 있다) */
  left: { red: number; blue: number };
  /** 턴이 끝나는 시각(Date.now). 0 이면 무제한 */
  deadline: number;
  news: string;
  /** 끝났을 때 이긴 팀 */
  winner: Team | null;
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
  if (!p || !Array.isArray(p.players) || !Array.isArray(p.cards)) return null;
  return {
    players: p.players as SyncPlayer[],
    cards: p.cards as MaskedCard[],
    turnTeam: p.turnTeam === 'blue' ? 'blue' : 'red',
    phase: p.phase === 'guess' || p.phase === 'over' ? p.phase : 'hint',
    hint: p.hint && typeof p.hint === 'object' ? (p.hint as { word: string; count: number }) : null,
    guessesLeft: typeof p.guessesLeft === 'number' ? p.guessesLeft : 0,
    left: p.left && typeof p.left === 'object'
      ? (p.left as { red: number; blue: number }) : { red: 0, blue: 0 },
    deadline: typeof p.deadline === 'number' ? p.deadline : 0,
    news: typeof p.news === 'string' ? p.news : '',
    winner: p.winner === 'red' || p.winner === 'blue' ? p.winner : null,
  };
}

export function encodeHint(from: string, word: string, count: number): GameMessage {
  return { type: T_HINT, payload: { from, word, count } };
}
export function decodeHint(msg: GameMessage): { from: string; word: string; count: number } | null {
  if (msg.type !== T_HINT) return null;
  const p = msg.payload as { from?: unknown; word?: unknown; count?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.word !== 'string' || typeof p.count !== 'number') return null;
  return { from: p.from, word: p.word, count: p.count };
}

export function encodeGuess(from: string, index: number): GameMessage {
  return { type: T_GUESS, payload: { from, index } };
}
export function decodeGuess(msg: GameMessage): { from: string; index: number } | null {
  if (msg.type !== T_GUESS) return null;
  const p = msg.payload as { from?: unknown; index?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.index !== 'number') return null;
  return { from: p.from, index: p.index };
}

export function encodePass(from: string): GameMessage {
  return { type: T_PASS, payload: { from } };
}
export function decodePass(msg: GameMessage): { from: string } | null {
  if (msg.type !== T_PASS) return null;
  const p = msg.payload as { from?: unknown } | null;
  return p && typeof p.from === 'string' ? { from: p.from } : null;
}

export function encodeReject(reason: string): GameMessage {
  return { type: T_REJECT, payload: { reason } };
}
export function decodeReject(msg: GameMessage): string | null {
  if (msg.type !== T_REJECT) return null;
  const p = msg.payload as { reason?: unknown } | null;
  return p && typeof p.reason === 'string' ? p.reason : null;
}

export function encodeEnd(result: GameResult): GameMessage {
  return { type: T_END, payload: result };
}
export function decodeEnd(msg: GameMessage): GameResult | null {
  if (msg.type !== T_END) return null;
  return (msg.payload ?? null) as GameResult | null;
}
