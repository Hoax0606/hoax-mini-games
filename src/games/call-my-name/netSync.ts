/**
 * 양세찬 게임 네트워크 프로토콜
 *
 * 클라 → 호스트:  cn:hello / cn:guess(정답 말하기) / cn:pass(내 차례 넘기기)
 * 호스트 → 클라:  cn:sync(진행 상황) / cn:end
 *
 * ⚠️ sync 는 **사람마다 다르게** 보낸다. 받는 사람 자기 단어만 빈 문자열로 지워서 보낸다.
 *    전원에게 같은 걸 뿌리면 개발자도구로 자기 단어를 볼 수 있어서 게임이 성립하지 않는다.
 *    (다른 게임들은 조작 방지를 신경 쓰지 않지만, 여기선 자기 단어를 모르는 게 게임 전부다.)
 */

import type { GameMessage, GameResult } from '../types';
import type { PlayerState } from './rules';

const T_HELLO = 'cn:hello';
const T_SYNC = 'cn:sync';
const T_GUESS = 'cn:guess';
const T_PASS = 'cn:pass';
const T_END = 'cn:end';

export interface SyncPayload {
  players: PlayerState[];
  /** 지금 차례인 사람. 전원이 맞혔으면 null */
  turnPeerId: string | null;
  /** 주제 이름 (전원 공개) */
  theme: string;
  /** 최근 일어난 일 — 화면 아래 기록으로 보여준다 */
  log: string[];
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
  return {
    players: p.players as PlayerState[],
    turnPeerId: typeof p.turnPeerId === 'string' ? p.turnPeerId : null,
    theme: typeof p.theme === 'string' ? p.theme : '',
    log: Array.isArray(p.log) ? (p.log as string[]) : [],
  };
}

export function encodeGuess(from: string, word: string): GameMessage {
  return { type: T_GUESS, payload: { from, word } };
}
export function decodeGuess(msg: GameMessage): { from: string; word: string } | null {
  if (msg.type !== T_GUESS) return null;
  const p = msg.payload as Record<string, unknown> | null;
  if (!p || typeof p['from'] !== 'string' || typeof p['word'] !== 'string') return null;
  return { from: p['from'] as string, word: p['word'] as string };
}

export function encodePass(from: string): GameMessage {
  return { type: T_PASS, payload: { from } };
}
export function decodePass(msg: GameMessage): { from: string } | null {
  if (msg.type !== T_PASS) return null;
  const p = msg.payload as { from?: unknown } | null;
  return p && typeof p.from === 'string' ? { from: p.from } : null;
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
