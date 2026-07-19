/**
 * 블루마블 네트워크 프로토콜 (호스트 authoritative).
 *
 *   bm:hello  게스트 → 호스트. 합류/재동기 요청
 *   bm:sync   호스트 → (target 또는 전체). 전체 상태(BMState). 비공개 정보 없음 → 통째로 공유
 *   bm:act    현재 차례 플레이어 → 호스트. 행동(주사위/구매·건설·인수 결정/카드/보관카드사용/턴종료)
 *   bm:end    호스트 → 각 peer. per-peer 결과
 *
 * 랜덤(주사위·카드)은 호스트만 굴리고 결과를 bm:sync 로 뿌린다.
 */

import type { GameMessage, GameResult } from '../types';
import type { BMState, BuildKind } from './rules';

const T_HELLO = 'bm:hello';
const T_SYNC = 'bm:sync';
const T_ACT = 'bm:act';
const T_END = 'bm:end';

/** 현재 차례 플레이어가 호스트에게 보내는 행동. by = 보낸 사람 peerId(호스트가 차례 검증) */
export type BMAction =
  | { kind: 'roll' }                          // 주사위 굴리기
  | { kind: 'desertPay' }                     // 무인도: 돈 내고 탈출
  | { kind: 'decision'; accept: boolean }     // 구매/인수 대기에 대한 예/아니오
  | { kind: 'build'; builds: BuildKind[] }    // 선택한 건물들 일괄 건설 후 턴 마무리(빈 배열 = 그냥 완료)
  | { kind: 'card'; keep: boolean }           // 황금열쇠: 보관(true) / 지금 사용(false)
  | { kind: 'useHeld'; cardId: number }       // 보관 카드 사용
  | { kind: 'pickCity'; tile: number }        // 올림픽 개최 / 출발 추가건설: 내 도시 선택
  | { kind: 'travelTo'; tile: number }        // 세계여행: 목적지 칸 선택
  | { kind: 'bonusPick'; choice: number }     // 오락실 2지선다 (0/1)
  | { kind: 'bonusStop' };                    // 오락실: 지금까지 딴 것 받고 종료

// ── hello ──
export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: string };
  return typeof p?.peerId === 'string' ? { peerId: p.peerId } : null;
}

// ── sync (전체 상태) ──
export function encodeSync(state: BMState): GameMessage {
  return { type: T_SYNC, payload: state };
}
export function decodeSync(msg: GameMessage): BMState | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<BMState> | null;
  if (!p || !Array.isArray(p.order) || !p.players) return null;
  return p as BMState;
}

// ── act (행동) ──
export function encodeAct(action: BMAction, by: string): GameMessage {
  return { type: T_ACT, payload: { ...action, by } };
}
export function decodeAct(msg: GameMessage): (BMAction & { by: string }) | null {
  if (msg.type !== T_ACT) return null;
  const p = msg.payload as (BMAction & { by?: string }) | null;
  if (!p || typeof p.by !== 'string' || typeof p.kind !== 'string') return null;
  return p as BMAction & { by: string };
}

// ── end (결과) ──
export function encodeEnd(result: GameResult): GameMessage {
  return { type: T_END, payload: result };
}
export function decodeEnd(msg: GameMessage): GameResult | null {
  if (msg.type !== T_END) return null;
  return msg.payload as GameResult;
}
