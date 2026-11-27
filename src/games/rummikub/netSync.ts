/**
 * 루미큐브 네트워크 프로토콜
 *
 * 게스트 → 호스트  rk:hello / rk:commit(테이블 제안) / rk:draw(한 장 가져오기)
 * 호스트 → 게스트  rk:sync / rk:reject(퇴짜 사유) / rk:end
 *
 * 턴 중의 드래그는 **전부 로컬**이다. 중간 상태를 실시간으로 중계하지 않는다.
 *   · 실제 보드게임도 남이 손에 쥐고 고민하는 건 안 보인다
 *   · 조작 한 번에 메시지 하나씩 보내면 트래픽도, 되돌리기 처리도 지저분해진다
 * 대신 턴을 끝낼 때 **테이블 전체**를 보내고 호스트가 한 번에 검증한다.
 *
 * ⚠️ sync 는 사람마다 다르다. 손패는 받는 사람 것만 실물로 보내고
 *    나머지는 장수만 알려준다. 남의 패가 보이면 게임이 성립하지 않는다.
 */

import type { GameMessage, GameResult } from '../types';
import type { Tile, TileSet } from './rules';

const T_HELLO = 'rk:hello';
const T_SYNC = 'rk:sync';
const T_COMMIT = 'rk:commit';
const T_DRAW = 'rk:draw';
const T_REJECT = 'rk:reject';
const T_END = 'rk:end';

export interface SyncPlayer {
  peerId: string;
  nickname: string;
  /** 손패 장수 (실물은 본인에게만) */
  handCount: number;
  /** 첫 등록(30점)을 마쳤나 */
  melded: boolean;
  /** 연결이 끊겨 건너뛰는 중 */
  gone: boolean;
}

export interface SyncPayload {
  players: SyncPlayer[];
  /** 지금 차례. 끝났으면 null */
  turnPeerId: string | null;
  /** 테이블에 깔린 조합들 */
  table: TileSet[];
  /** 받는 사람의 손패 (여기만 실물) */
  myHand: Tile[];
  /** 더미에 남은 장수 */
  poolLeft: number;
  /** 턴이 끝나는 시각(Date.now 기준). 0 이면 무제한 */
  turnDeadline: number;
  /** 한 줄 소식 */
  news: string;
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
  if (!p || !Array.isArray(p.players) || !Array.isArray(p.table)) return null;
  return {
    players: p.players as SyncPlayer[],
    turnPeerId: typeof p.turnPeerId === 'string' ? p.turnPeerId : null,
    table: p.table as TileSet[],
    myHand: Array.isArray(p.myHand) ? (p.myHand as Tile[]) : [],
    poolLeft: typeof p.poolLeft === 'number' ? p.poolLeft : 0,
    turnDeadline: typeof p.turnDeadline === 'number' ? p.turnDeadline : 0,
    news: typeof p.news === 'string' ? p.news : '',
  };
}

/** 이 테이블로 턴을 끝내겠다 */
export function encodeCommit(from: string, table: TileSet[]): GameMessage {
  return { type: T_COMMIT, payload: { from, table } };
}
export function decodeCommit(msg: GameMessage): { from: string; table: TileSet[] } | null {
  if (msg.type !== T_COMMIT) return null;
  const p = msg.payload as { from?: unknown; table?: unknown } | null;
  if (!p || typeof p.from !== 'string' || !Array.isArray(p.table)) return null;
  return { from: p.from, table: p.table as TileSet[] };
}

/** 낼 게 없다 — 한 장 가져가고 턴 종료 */
export function encodeDraw(from: string): GameMessage {
  return { type: T_DRAW, payload: { from } };
}
export function decodeDraw(msg: GameMessage): { from: string } | null {
  if (msg.type !== T_DRAW) return null;
  const p = msg.payload as { from?: unknown } | null;
  return p && typeof p.from === 'string' ? { from: p.from } : null;
}

/** 퇴짜 — 보낸 사람에게만. 테이블은 그대로 두고 사유만 알려준다 */
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
