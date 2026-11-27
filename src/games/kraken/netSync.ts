/**
 * 노 터치 크라켄 네트워크 프로토콜
 *
 * 클라 → 호스트:  kr:hello / kr:flip(남의 카드 한 장 지목)
 * 호스트 → 클라:  kr:sync(판 상태) / kr:end
 *
 * ⚠️ sync 는 **사람마다 다르게** 보낸다 (호스트의 maskFor).
 *    - 역할(role): 자기 것만. 남의 역할은 게임이 끝나야 채워진다.
 *    - 내 손패 구성(myCounts): 보물 몇 장·크라켄 유무만. **어느 카드가 뭔지는 본인에게도 안 보낸다**
 *      (원작에서 자기 카드를 보고 다시 섞기 때문 — rules.ts 주석 참고).
 *    - 관전자에게는 전부 열어서 보낸다 (신 시점).
 */

import type { GameMessage, GameResult } from '../types';
import type { CardKind, Role } from './rules';

const T_HELLO = 'kr:hello';
const T_SYNC = 'kr:sync';
const T_FLIP = 'kr:flip';
const T_END = 'kr:end';

export type KrPhase = 'play' | 'over';

export interface SyncSeat {
  peerId: string;
  nickname: string;
  /** 아직 안 뒤집힌 카드 수 (= 클릭할 수 있는 뒷면 카드 개수) */
  hidden: number;
  /** 이번 라운드에 이 사람 앞에서 공개된 카드들 (라운드가 넘어가면 비워진다) */
  opened: CardKind[];
  /** 연결이 끊긴 사람 */
  gone: boolean;
  /** 역할 — 본인·관전자·게임 종료 후에만 채워진다. 그 외에는 null */
  role: Role | null;
  /** 이 사람 손패 구성 — 본인·관전자·게임 종료 후에만. 어느 카드인지는 끝까지 안 알려준다 */
  counts: { treasure: number; kraken: number } | null;
}

export interface SyncPayload {
  seats: SyncSeat[];
  /** 1 ~ 4 */
  round: number;
  /** 이번 라운드에 남은 뒤집기 횟수 */
  actionsLeft: number;
  /** 지금 뒤집을 사람의 peerId */
  turn: string;
  phase: KrPhase;
  /** 지금까지 공개된 누적 집계 (라운드가 넘어가도 유지 — 공개된 카드는 판에서 빠진다) */
  found: { treasure: number; futile: number; kraken: number };
  /** 찾아야 할 보물 총 개수 (= 시작 인원수) */
  totalTreasure: number;
  /** 턴 마감 시각(Date.now 기준). 0 이면 무제한 */
  deadline: number;
  news: string;
  winner: Role | null;
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
  if (!p || !Array.isArray(p.seats)) return null;
  const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);
  return {
    seats: p.seats as SyncSeat[],
    round: num(p.round, 1),
    actionsLeft: num(p.actionsLeft, 0),
    turn: typeof p.turn === 'string' ? p.turn : '',
    phase: p.phase === 'over' ? 'over' : 'play',
    found: {
      treasure: num(p.found?.treasure, 0),
      futile: num(p.found?.futile, 0),
      kraken: num(p.found?.kraken, 0),
    },
    totalTreasure: num(p.totalTreasure, 0),
    deadline: num(p.deadline, 0),
    news: typeof p.news === 'string' ? p.news : '',
    winner: p.winner === 'crew' || p.winner === 'pirate' ? p.winner : null,
  };
}

/** target 의 뒷면 카드 중 index 번째를 뒤집겠다는 요청 */
export function encodeFlip(from: string, target: string, index: number): GameMessage {
  return { type: T_FLIP, payload: { from, target, index } };
}
export function decodeFlip(msg: GameMessage): { from: string; target: string; index: number } | null {
  if (msg.type !== T_FLIP) return null;
  const p = msg.payload as Record<string, unknown> | null;
  if (!p || typeof p['from'] !== 'string' || typeof p['target'] !== 'string') return null;
  if (typeof p['index'] !== 'number') return null;
  return { from: p['from'] as string, target: p['target'] as string, index: p['index'] as number };
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
