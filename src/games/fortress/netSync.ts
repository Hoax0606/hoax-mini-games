/**
 * 포트리스 네트워크 프로토콜 (호스트 authoritative + 결정론적 궤적 재생)
 *
 *   fr:hello   게스트/관전자 → 호스트. 합류 동기화 요청
 *   fr:sync    호스트 → target. 전체 game + 지금까지의 크레이터 목록(지형 복원용)
 *   fr:fire    발사자 → 전체. 각도/파워/시작좌표/바람 — 각 클라가 같은 궤적 애니 재생
 *   fr:impact  호스트 → 전체. 착탄점 + 크레이터 반경 + 각 포대 HP + 다음 턴/바람 (확정)
 *   fr:end     호스트 → 각 peer. per-peer GameResult
 */

import type { GameMessage, GameResult } from '../types';
import type { FortressGame, WeaponId } from './rules';

const T_HELLO = 'fr:hello';
const T_SYNC = 'fr:sync';
const T_FIRE = 'fr:fire';
const T_IMPACT = 'fr:impact';
const T_END = 'fr:end';
const T_MOVE = 'fr:move';

export interface Crater {
  cx: number;
  cy: number;
  r: number;
}

// --- hello ---
export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  if (!p || typeof p.peerId !== 'string') return null;
  return { peerId: p.peerId };
}

// --- sync (game + 크레이터 목록) ---
export interface SyncPayload {
  game: FortressGame;
  craters: Crater[];
}
export function encodeSync(p: SyncPayload): GameMessage {
  return { type: T_SYNC, payload: p };
}
export function decodeSync(msg: GameMessage): SyncPayload | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<SyncPayload> | null;
  if (!p || !p.game || !Array.isArray(p.craters)) return null;
  return { game: p.game as FortressGame, craters: p.craters as Crater[] };
}

// --- fire (발사 파라미터) ---
export interface FirePayload {
  /** 발사한 포대 id — 차례 검증 + 소유자 탄약 차감에 사용 */
  fromFortId: number;
  startX: number;
  startY: number;
  angleRad: number;
  power01: number;
  wind: number;
  /** 발사 무기 종류 */
  weapon: WeaponId;
}
export function encodeFire(p: FirePayload): GameMessage {
  return { type: T_FIRE, payload: p };
}
export function decodeFire(msg: GameMessage): FirePayload | null {
  if (msg.type !== T_FIRE) return null;
  const p = msg.payload as Partial<FirePayload> | null;
  if (!p) return null;
  if (typeof p.startX !== 'number' || typeof p.startY !== 'number') return null;
  if (typeof p.angleRad !== 'number' || typeof p.power01 !== 'number') return null;
  if (typeof p.wind !== 'number' || typeof p.fromFortId !== 'number') return null;
  // weapon 누락(구버전)이면 normal 로 간주
  const weapon = (typeof p.weapon === 'string' ? p.weapon : 'normal') as WeaponId;
  return { ...(p as FirePayload), weapon };
}

// --- impact (착탄 확정) ---
export interface ImpactPayload {
  /** 이번 착탄의 폭발 목록 (분열탄은 여러 개, 나머지는 1개, 크레이터 없으면 빈 배열) */
  blasts: Crater[];
  /** 포대 id → 갱신 hp */
  hp: Record<number, number>;
  ended: boolean;
  /** 게임 안 끝났을 때 다음 턴 포대 id/바람 */
  nextTurn: number | -1;
  nextWind: number;
  /** 끝났을 때 우승자 peerId 들 (공동 우승/무승부 표현) */
  winnerPeerIds: string[];
}
export function encodeImpact(p: ImpactPayload): GameMessage {
  return { type: T_IMPACT, payload: p };
}
export function decodeImpact(msg: GameMessage): ImpactPayload | null {
  if (msg.type !== T_IMPACT) return null;
  const p = msg.payload as Partial<ImpactPayload> | null;
  if (!p || !Array.isArray(p.blasts)) return null;
  return {
    blasts: p.blasts as Crater[],
    hp: (p.hp ?? {}) as Record<number, number>,
    ended: p.ended === true,
    nextTurn: typeof p.nextTurn === 'number' ? p.nextTurn : -1,
    nextWind: typeof p.nextWind === 'number' ? p.nextWind : 0,
    winnerPeerIds: Array.isArray(p.winnerPeerIds) ? (p.winnerPeerIds as string[]) : [],
  };
}

// --- move (현재 턴 포대 좌우 이동) ---
export interface MovePayload {
  fromFortId: number;
  /** 갱신된 x 위치 */
  x: number;
}
export function encodeMove(p: MovePayload): GameMessage {
  return { type: T_MOVE, payload: p };
}
export function decodeMove(msg: GameMessage): MovePayload | null {
  if (msg.type !== T_MOVE) return null;
  const p = msg.payload as Partial<MovePayload> | null;
  if (!p || typeof p.fromFortId !== 'number' || typeof p.x !== 'number') return null;
  return { fromFortId: p.fromFortId, x: p.x };
}

// --- end ---
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
