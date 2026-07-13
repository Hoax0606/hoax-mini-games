/**
 * 알까기 네트워크 프로토콜
 *
 * 동기화 전략 — **호스트 authoritative** (에어하키와 유사):
 *   1. 호스트가 물리 시뮬레이션 단독 실행
 *   2. 시뮬레이션 진행 중 ~10Hz 로 ag:state 전체 broadcast → 게스트는 받은 state 로 렌더만
 *   3. 자기 차례 게스트가 알 튕기면 ag:flick 송신 → 호스트가 받아 적용
 *   4. 게임 종료 시 호스트가 per-peer ag:end 송신
 *
 * 관전자 합류:
 *   ag:hello → 호스트가 ag:sync 로 현재 game state 전송 (target 지정)
 *
 * 메시지 타입:
 *   - ag:hello   게스트/관전자 → 호스트 (peerId)
 *   - ag:sync    호스트 → target (전체 AlgagiGame)
 *   - ag:flick   현재 턴 플레이어 → 호스트 (알 ID + 초기 vx/vy)
 *   - ag:state   호스트 → 전체 (시뮬레이션 중 game snapshot ~10Hz)
 *   - ag:end     호스트 → 각 peer (per-peer GameResult)
 */

import type { GameMessage, GameResult } from '../types';
import type { AlgagiGame } from './rules';

const T_HELLO = 'ag:hello';
const T_SYNC = 'ag:sync';
const T_FLICK = 'ag:flick';
const T_STATE = 'ag:state';
const T_END = 'ag:end';

/**
 * 수신한 game 스냅샷이 최소한의 구조를 갖췄는지 검증.
 *
 * 왜: 깨지거나 잘린 payload 를 그대로 this.game 에 넣으면, 렌더가 game.stones /
 *   game.players 를 순회하다 throw → 캔버스가 흰 배경만 칠한 채 멈춰 "흰 화면"이 됨.
 *   여기서 걸러 잘못된 스냅샷은 무시(적용 안 함)하도록 방어한다.
 */
function isValidGame(g: unknown): g is AlgagiGame {
  if (!g || typeof g !== 'object') return false;
  const o = g as Record<string, unknown>;
  return Array.isArray(o.stones) && Array.isArray(o.players);
}

// ============================================
// hello — 게스트/관전자가 호스트에게 "현재 상태 줘"
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

// ============================================
// sync — 호스트가 target 에게 현재 게임 상태 전송 (합류 시점)
// ============================================

export function encodeSync(game: AlgagiGame): GameMessage {
  return { type: T_SYNC, payload: game };
}

export function decodeSync(msg: GameMessage): AlgagiGame | null {
  if (msg.type !== T_SYNC) return null;
  return isValidGame(msg.payload) ? msg.payload : null;
}

// ============================================
// flick — 현재 턴 플레이어가 호스트에게 "이 알을 (vx, vy) 로 튕긴다"
// ============================================

export interface FlickPayload {
  /** 알 인덱스 (Stone.id) */
  stoneId: number;
  /** 초기 속도 (px/s) */
  vx: number;
  vy: number;
}

export function encodeFlick(p: FlickPayload): GameMessage {
  return { type: T_FLICK, payload: p };
}

export function decodeFlick(msg: GameMessage): FlickPayload | null {
  if (msg.type !== T_FLICK) return null;
  const p = msg.payload as Partial<FlickPayload> | null;
  if (!p) return null;
  if (typeof p.stoneId !== 'number') return null;
  if (typeof p.vx !== 'number' || typeof p.vy !== 'number') return null;
  return { stoneId: p.stoneId, vx: p.vx, vy: p.vy };
}

// ============================================
// state — 호스트가 시뮬레이션 중 game snapshot broadcast (10Hz)
// ============================================
// payload = { game, impulse }. impulse 는 이 broadcast 까지 누적된 최대 충돌 강도.
// 0 이면 충돌 없음. 게스트가 임계값 이상이면 SFX 재생 (호스트와 동기화).

export interface StatePayload {
  game: AlgagiGame;
  /** 직전 broadcast 이후 발생한 최대 충돌 impulse. 0 이면 충돌 없음. */
  impulse: number;
}

export function encodeState(game: AlgagiGame, impulse = 0): GameMessage {
  return { type: T_STATE, payload: { game, impulse } };
}

export function decodeState(msg: GameMessage): StatePayload | null {
  if (msg.type !== T_STATE) return null;
  const p = msg.payload as Partial<StatePayload> | null;
  if (!p || !isValidGame(p.game)) return null;
  return { game: p.game, impulse: typeof p.impulse === 'number' ? p.impulse : 0 };
}

// ============================================
// end — 호스트가 각 peer 에 per-peer 결과 전송
// ============================================

export function encodeEnd(result: GameResult): GameMessage {
  return { type: T_END, payload: result };
}

export function decodeEnd(msg: GameMessage): GameResult | null {
  if (msg.type !== T_END) return null;
  const p = msg.payload as Partial<GameResult> | null;
  if (!p) return null;
  const w = p.winner;
  if (w !== 'me' && w !== 'opponent' && w !== null) return null;
  return {
    winner: w,
    summary: (p.summary ?? {}) as Record<string, unknown>,
  };
}
