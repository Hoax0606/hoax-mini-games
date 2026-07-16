/**
 * 원카드 네트워크 프로토콜 (호스트 authoritative).
 *
 *   oc:hello   게스트 → 호스트. 합류/재동기 요청
 *   oc:sync    호스트 → (target 또는 전체). 공개 상태 전체
 *   oc:hand    호스트 → target. 그 사람의 비공개 손패(카드 실물)
 *   oc:play    현재 턴 게스트 → 호스트. 낼 카드(+와일드면 선택색)
 *   oc:draw    현재 턴 게스트 → 호스트. 1장 뽑기
 *   oc:pass    현재 턴 게스트 → 호스트. 뽑은 뒤 안 내고 넘김
 *   oc:end     호스트 → 각 peer. per-peer 결과
 *
 * 손패(실물)는 oc:hand 로 각자에게만 전송 → 남의 카드는 장수(handCounts)만 공개.
 */

import type { GameMessage, GameResult } from '../types';
import type { Card, Color } from './rules';

export interface OneCardPublic {
  players: Array<{ peerId: string; nickname: string }>;
  /** 고정 좌석 순서 (peerId) */
  order: string[];
  handCounts: Record<string, number>;
  discardTop: Card;
  activeColor: Color;
  /** order 내 현재 차례 인덱스 */
  currentTurn: number;
  direction: 1 | -1;
  drawPileCount: number;
  /** 손패 다 비운 순서(=상위 순위) */
  finished: string[];
  /** 기권한 사람들 (턴에서 빠짐. 최종 순위는 남은 카드 수로) */
  outPeers: string[];
  phase: 'playing' | 'ended';
  /** 현재 턴 플레이어가 이미 1장 뽑아서 이제 "패스 가능" 상태인지(뽑은 카드 낼지 패스할지) */
  awaitingPostDraw: boolean;
  /** 누적된 공격카드 벌칙 장수(중첩). 0이면 스택 없음 → 현재 턴은 같은 종류로 받아치거나 이만큼 뽑아야 함 */
  pendingDraw: number;
  /** 누적 스택 종류 ('draw2'|'wild4'|null) — 받아치기는 같은 종류만 */
  pendingKind: 'draw2' | 'wild4' | null;
  /** 턴 제한시간(ms). 각 클라는 currentTurn 바뀔 때 로컬 시계로 카운트다운 */
  turnMs: number;
  /** 최근 행동 안내 문구 (UI 토스트) */
  lastAction: string;
}

const T_HELLO = 'oc:hello';
const T_SYNC = 'oc:sync';
const T_HAND = 'oc:hand';
const T_PLAY = 'oc:play';
const T_DRAW = 'oc:draw';
const T_PASS = 'oc:pass';
const T_SURRENDER = 'oc:surrender';
const T_END = 'oc:end';

// hello
export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  return p && typeof p.peerId === 'string' ? { peerId: p.peerId } : null;
}

// sync
export function encodeSync(pub: OneCardPublic): GameMessage {
  return { type: T_SYNC, payload: pub };
}
export function decodeSync(msg: GameMessage): OneCardPublic | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<OneCardPublic> | null;
  if (!p || !p.discardTop || !Array.isArray(p.order)) return null;
  return {
    ...(p as OneCardPublic),
    outPeers: Array.isArray(p.outPeers) ? (p.outPeers as string[]) : [],
    pendingDraw: typeof p.pendingDraw === 'number' ? p.pendingDraw : 0,
    pendingKind: p.pendingKind === 'draw2' || p.pendingKind === 'wild4' ? p.pendingKind : null,
    turnMs: typeof p.turnMs === 'number' ? p.turnMs : 20000,
  };
}

// hand (비공개 손패)
export function encodeHand(cards: Card[]): GameMessage {
  return { type: T_HAND, payload: { cards } };
}
export function decodeHand(msg: GameMessage): Card[] | null {
  if (msg.type !== T_HAND) return null;
  const p = msg.payload as { cards?: unknown } | null;
  return p && Array.isArray(p.cards) ? (p.cards as Card[]) : null;
}

// play (카드 실물 + 와일드 선택색). from = 송신자 peerId(호스트가 현재 턴 검증용)
export interface PlayPayload {
  from: string;
  card: Card;
  /** 와일드/+4 일 때 고른 색. 아니면 무시 */
  chosenColor?: Color;
}
export function encodePlay(p: PlayPayload): GameMessage {
  return { type: T_PLAY, payload: p };
}
export function decodePlay(msg: GameMessage): PlayPayload | null {
  if (msg.type !== T_PLAY) return null;
  const p = msg.payload as Partial<PlayPayload> | null;
  if (!p || !p.card || typeof p.card.kind !== 'string' || typeof p.from !== 'string') return null;
  return { from: p.from, card: p.card as Card, chosenColor: p.chosenColor };
}

// draw / pass (from = 송신자 peerId)
export function encodeDraw(from: string): GameMessage { return { type: T_DRAW, payload: { from } }; }
export function decodeDraw(msg: GameMessage): { from: string } | null {
  if (msg.type !== T_DRAW) return null;
  const p = msg.payload as { from?: unknown } | null;
  return p && typeof p.from === 'string' ? { from: p.from } : null;
}
export function encodePass(from: string): GameMessage { return { type: T_PASS, payload: { from } }; }
export function decodePass(msg: GameMessage): { from: string } | null {
  if (msg.type !== T_PASS) return null;
  const p = msg.payload as { from?: unknown } | null;
  return p && typeof p.from === 'string' ? { from: p.from } : null;
}
export function encodeSurrender(from: string): GameMessage { return { type: T_SURRENDER, payload: { from } }; }
export function decodeSurrender(msg: GameMessage): { from: string } | null {
  if (msg.type !== T_SURRENDER) return null;
  const p = msg.payload as { from?: unknown } | null;
  return p && typeof p.from === 'string' ? { from: p.from } : null;
}

// end
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
