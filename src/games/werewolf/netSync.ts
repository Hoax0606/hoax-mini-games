/**
 * 한밤의 늑대인간 — 네트워크 프로토콜 (호스트 authoritative)
 *
 * 클라 → 호스트:  ww:hello / ww:ready / ww:act / ww:chat / ww:vote
 * 호스트 → 클라:  ww:sync(공개상태) / ww:role(내 처음 역할) /
 *                ww:nightInfo(내가 밤에 본 것, targeted) / ww:end
 *
 * 비밀(역할·밤에 본 정보)은 sync 에 안 담고 각 peer 에게만 targeted 로 보낸다.
 * 밤 정보(nightInfo)는 유실 대비로 호스트가 peer 별 목록을 보관 → hello 오면 재전송.
 */

import type { GameMessage, GameResult } from '../types';
import type { PublicState, Role } from './rules';

const T_HELLO = 'ww:hello';
const T_SYNC = 'ww:sync';
const T_ROLE = 'ww:role';
const T_READY = 'ww:ready';
const T_ACT = 'ww:act';
const T_NIGHTINFO = 'ww:nightInfo';
const T_CHAT = 'ww:chat';
const T_VOTE = 'ww:vote';
const T_END = 'ww:end';

// ============================================
// 밤 행동 (플레이어 → 호스트)
// ============================================

/**
 * 밤 행동 페이로드. 역할별로 모양이 다른 discriminated union.
 * (switch (action.kind) 안에서 각 필드 타입이 자동으로 좁혀짐)
 */
export type NightAction =
  | { kind: 'doppelCopy'; target: string }           // 도플갱어: 복사할 상대 지목
  | { kind: 'wolfConfirm' }                          // 늑대(다중): 동료 확인만
  | { kind: 'wolfPeek'; center: number }             // 늑대(혼자): 가운데 1장 지목해서 봄
  | { kind: 'seerPlayer'; target: string }           // 예언자: 플레이어 카드 1장
  | { kind: 'seerCenter'; centers: number[] }        // 예언자: 가운데 2장 (index 2개)
  | { kind: 'robber'; target: string }               // 강도: 대상과 카드 교환
  | { kind: 'troublemaker'; a: string; b: string }   // 말썽쟁이: 두 사람 카드 교환
  | { kind: 'drunk'; center: number }                // 주정뱅이: 가운데 1장과 교환
  | { kind: 'insomniacConfirm' }                     // 불면증: 최종 카드 확인
  | { kind: 'skip' };                                // 시간초과/행동 포기

// ============================================
// 밤 정보 (호스트 → 플레이어, targeted)
// ============================================

/** 내가 밤에 본 것. 클라이언트는 이걸 "밤 메모" 목록에 쌓아둔다. */
export type NightInfo =
  | { kind: 'wolves'; peerIds: string[]; solo: boolean }        // 늑대 동료 목록(+혼자 여부)
  | { kind: 'peeked'; center: number; role: Role }             // 가운데 1장을 봄 (혼자 늑대/주정뱅이 아님)
  | { kind: 'seerPlayer'; target: string; role: Role }         // 예언자: 본 플레이어 카드
  | { kind: 'seerCenter'; cards: { center: number; role: Role }[] } // 예언자: 본 가운데 카드들
  | { kind: 'robbed'; target: string; newRole: Role }          // 강도: 뺏어와서 바뀐 내 카드
  | { kind: 'insomniac'; role: Role }                          // 수면증: 최종 내 카드
  | { kind: 'minionWolves'; peerIds: string[] }                // 하수인: 늑대 목록(늑대는 하수인 모름)
  | { kind: 'masons'; peerIds: string[]; solo: boolean }       // 메이슨: 동료 메이슨(+혼자 여부)
  | { kind: 'doppelCopied'; target: string; role: Role };      // 도플갱어: 복사한 대상/직업

// ============================================
// hello (게스트 → 호스트: 합류/상태 재요청)
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
// sync (호스트 → 전체: 공개 상태)
// ============================================
export function encodeSync(state: PublicState): GameMessage {
  return { type: T_SYNC, payload: state };
}
export function decodeSync(msg: GameMessage): PublicState | null {
  if (msg.type !== T_SYNC) return null;
  const p = msg.payload as Partial<PublicState> | null;
  if (!p || !Array.isArray(p.players) || typeof p.phase !== 'string') return null;
  return p as PublicState;
}

// ============================================
// role (호스트 → 플레이어: 내가 처음 받은 카드)
// ============================================
export function encodeRole(role: Role): GameMessage {
  return { type: T_ROLE, payload: { role } };
}
export function decodeRole(msg: GameMessage): { role: Role } | null {
  if (msg.type !== T_ROLE) return null;
  const p = msg.payload as { role?: unknown } | null;
  if (!p || typeof p.role !== 'string') return null;
  return { role: p.role as Role };
}

// ============================================
// ready (플레이어 → 호스트: deal 페이즈 카드 확인 완료)
// ============================================
export function encodeReady(from: string): GameMessage {
  return { type: T_READY, payload: { from } };
}
export function decodeReady(msg: GameMessage): { from: string } | null {
  if (msg.type !== T_READY) return null;
  const p = msg.payload as { from?: unknown } | null;
  if (!p || typeof p.from !== 'string') return null;
  return { from: p.from };
}

// ============================================
// act (플레이어 → 호스트: 밤 행동)
// ============================================
export function encodeAct(from: string, action: NightAction): GameMessage {
  return { type: T_ACT, payload: { from, action } };
}
export function decodeAct(msg: GameMessage): { from: string; action: NightAction } | null {
  if (msg.type !== T_ACT) return null;
  const p = msg.payload as { from?: unknown; action?: unknown } | null;
  if (!p || typeof p.from !== 'string') return null;
  const a = p.action as { kind?: unknown } | null;
  if (!a || typeof a.kind !== 'string') return null;
  return { from: p.from, action: a as NightAction };
}

// ============================================
// nightInfo (호스트 → 플레이어: 내가 본 것, targeted)
// ============================================
export function encodeNightInfo(info: NightInfo): GameMessage {
  return { type: T_NIGHTINFO, payload: { info } };
}
export function decodeNightInfo(msg: GameMessage): { info: NightInfo } | null {
  if (msg.type !== T_NIGHTINFO) return null;
  const p = msg.payload as { info?: unknown } | null;
  const info = p?.info as { kind?: unknown } | null;
  if (!info || typeof info.kind !== 'string') return null;
  return { info: info as NightInfo };
}

// ============================================
// chat (플레이어 → 호스트: 낮 토론 한 줄)
// ============================================
export function encodeChat(from: string, nickname: string, text: string): GameMessage {
  return { type: T_CHAT, payload: { from, nickname, text } };
}
export function decodeChat(msg: GameMessage): { from: string; nickname: string; text: string } | null {
  if (msg.type !== T_CHAT) return null;
  const p = msg.payload as { from?: unknown; nickname?: unknown; text?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.nickname !== 'string' || typeof p.text !== 'string') return null;
  return { from: p.from, nickname: p.nickname, text: p.text };
}

// ============================================
// vote (플레이어 → 호스트)
// ============================================
export function encodeVote(from: string, target: string): GameMessage {
  return { type: T_VOTE, payload: { from, target } };
}
export function decodeVote(msg: GameMessage): { from: string; target: string } | null {
  if (msg.type !== T_VOTE) return null;
  const p = msg.payload as { from?: unknown; target?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.target !== 'string') return null;
  return { from: p.from, target: p.target };
}

// ============================================
// end (호스트 → 각 peer)
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
  return { winner: w, summary: (p.summary ?? {}) as Record<string, unknown> };
}
