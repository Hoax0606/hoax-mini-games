/**
 * 양세찬 게임 네트워크 프로토콜
 *
 * 클라 → 호스트:  cn:hello / cn:ask(질문) / cn:ans(대답) / cn:guess(정답 말하기) / cn:pass(넘기기)
 * 호스트 → 클라:  cn:sync(진행 상황) / cn:end
 *
 * 질문·대답도 호스트를 거친다. 서로 직접 보내면 star 토폴로지라 전달이 안 되기도 하고,
 * 무엇보다 **모두가 같은 순서로 같은 대화를 봐야** 한다 (누가 뭘 물었는지가 게임의 전부라서).
 *
 * ⚠️ sync 는 **사람마다 다르게** 보낸다. 받는 사람 자기 단어만 빈 문자열로 지워서 보낸다.
 *    전원에게 같은 걸 뿌리면 개발자도구로 자기 단어를 볼 수 있어서 게임이 성립하지 않는다.
 *    (다른 게임들은 조작 방지를 신경 쓰지 않지만, 여기선 자기 단어를 모르는 게 게임 전부다.)
 */

import type { GameMessage, GameResult } from '../types';
import type { FeedEntry, PlayerState } from './rules';

const T_HELLO = 'cn:hello';
const T_SYNC = 'cn:sync';
const T_ASK = 'cn:ask';
const T_ANS = 'cn:ans';
const T_GUESS = 'cn:guess';
const T_PASS = 'cn:pass';
const T_END = 'cn:end';

export interface SyncPayload {
  players: PlayerState[];
  /** 지금 차례인 사람(= 질문권을 가진 사람). 전원이 맞혔으면 null */
  turnPeerId: string | null;
  /** 주제 이름 (전원 공개). '랜덤' 으로 시작했어도 여기엔 확정된 주제가 담긴다 */
  theme: string;
  /** 질문·대답·알림이 시간순으로 쌓인 대화 */
  feed: FeedEntry[];
  /** 이번 차례에 질문을 이미 했나 — 한 차례에 한 번만 물어볼 수 있다 */
  asked: boolean;
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
    feed: Array.isArray(p.feed) ? (p.feed as FeedEntry[]) : [],
    asked: p.asked === true,
  };
}

/** 질문과 대답은 모양이 같아서 인코더를 공유한다 */
function encodeSay(type: string, from: string, text: string): GameMessage {
  return { type, payload: { from, text } };
}
function decodeSay(msg: GameMessage, type: string): { from: string; text: string } | null {
  if (msg.type !== type) return null;
  const p = msg.payload as Record<string, unknown> | null;
  if (!p || typeof p['from'] !== 'string' || typeof p['text'] !== 'string') return null;
  return { from: p['from'] as string, text: p['text'] as string };
}

export function encodeAsk(from: string, text: string): GameMessage {
  return encodeSay(T_ASK, from, text);
}
export function decodeAsk(msg: GameMessage): { from: string; text: string } | null {
  return decodeSay(msg, T_ASK);
}

export function encodeAnswer(from: string, text: string): GameMessage {
  return encodeSay(T_ANS, from, text);
}
export function decodeAnswer(msg: GameMessage): { from: string; text: string } | null {
  return decodeSay(msg, T_ANS);
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
