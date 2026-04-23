/**
 * 에어하키 네트워크 동기화 프로토콜
 *
 * 역할 분담:
 *   - 호스트: 매 프레임 GameState + 이벤트를 게스트에게 push (authoritative)
 *   - 게스트: 매 프레임 자기 말렛 목표 좌표를 호스트에게 push
 *
 * 이 파일은 순수 "직렬화 계층":
 *   - GameMessage 포맷으로 인코딩/디코딩만 담당
 *   - 실제 송수신 루프는 index.ts(GameModule)에 있음
 *   - 플랫폼의 NetworkMessage로의 래핑은 GameContext.sendToPeer가 알아서 처리
 *
 * 메시지 종류 3가지:
 *   'state' : host → guest  (상태 스냅샷 + 이벤트들)
 *   'input' : guest → host  (게스트 말렛 목표 위치)
 *   'end'   : host → guest  (게임 종료 + 결과)
 *
 * 왜 PhysicsEvent도 같이 보내는가?
 *   파티클 이펙트(골 폭발, 벽/말렛 충돌 등)는 이벤트 단위로 트리거됨.
 *   상태 diff만 봐도 일부 추정은 가능하지만, 정확한 타이밍/위치는 이벤트로 받는 게 정답.
 */

import type { GameMessage, GameResult } from '../types';
import type { GameState, PhysicsEvent, Vec2 } from './physics';

const TYPE_STATE = 'ah:state';
const TYPE_INPUT = 'ah:input';
const TYPE_END = 'ah:end';

// ============================================
// 호스트 → 게스트: 상태 스냅샷
// ============================================

export function encodeState(state: GameState, events: readonly PhysicsEvent[]): GameMessage {
  return {
    type: TYPE_STATE,
    payload: { state, events },
  };
}

export interface StatePayload {
  state: GameState;
  events: PhysicsEvent[];
}

export function decodeState(msg: GameMessage): StatePayload | null {
  if (msg.type !== TYPE_STATE) return null;
  const p = msg.payload as Partial<StatePayload> | null;
  if (!p || typeof p !== 'object' || !p.state) return null;
  return {
    state: p.state as GameState,
    events: Array.isArray(p.events) ? p.events : [],
  };
}

// ============================================
// 게스트 → 호스트: 말렛 입력
// ============================================

export function encodeInput(target: Vec2): GameMessage {
  return {
    type: TYPE_INPUT,
    payload: { target },
  };
}

export function decodeInput(msg: GameMessage): Vec2 | null {
  if (msg.type !== TYPE_INPUT) return null;
  const p = msg.payload as { target?: Vec2 } | null;
  const t = p?.target;
  if (!t || typeof t.x !== 'number' || typeof t.y !== 'number') return null;
  return { x: t.x, y: t.y };
}

// ============================================
// 호스트 → 게스트: 게임 종료
// ============================================

/**
 * 호스트 시점의 결과(winner: 'me' = 호스트)를 게스트용으로 뒤집어서 인코딩한다.
 * 게스트가 받으면 자기 시점으로 바로 읽을 수 있음.
 */
export function encodeEndForOpponent(myResult: GameResult): GameMessage {
  const flipped: GameResult = {
    winner:
      myResult.winner === 'me' ? 'opponent' :
      myResult.winner === 'opponent' ? 'me' :
      null,
    summary: myResult.summary,
  };
  return {
    type: TYPE_END,
    payload: flipped,
  };
}

export function decodeEnd(msg: GameMessage): GameResult | null {
  if (msg.type !== TYPE_END) return null;
  const p = msg.payload as Partial<GameResult> | null;
  if (!p || typeof p !== 'object') return null;
  // winner는 'me' | 'opponent' | null
  const w = p.winner;
  if (w !== 'me' && w !== 'opponent' && w !== null) return null;
  return {
    winner: w,
    summary: (p.summary ?? {}) as Record<string, unknown>,
  };
}
