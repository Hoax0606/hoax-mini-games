/**
 * 아발론 — 네트워크 프로토콜 (호스트 authoritative)
 *
 * 클라 → 호스트:  av:hello / av:ready / av:pickTeam / av:vote / av:questCard / av:assassin / av:chat
 * 호스트 → 클라:  av:sync(공개상태) / av:role(내 역할) / av:info(내 밤 지식, targeted) / av:end
 *
 * 비밀(역할·밤 지식)은 sync 에 안 담고 각 peer 에게만 targeted 로 보낸다.
 * 밤 지식(info)은 유실 대비로 호스트가 peer 별로 보관 → hello 오면 재전송.
 */

import type { GameMessage, GameResult } from '../types';
import type { PublicState, Role, Knowledge, Vote, QuestCard } from './rules';

const T_HELLO = 'av:hello';
const T_SYNC = 'av:sync';
const T_ROLE = 'av:role';
const T_INFO = 'av:info';
const T_READY = 'av:ready';
const T_PICK = 'av:pickTeam';
const T_VOTE = 'av:vote';
const T_QUEST = 'av:questCard';
const T_ASSASSIN = 'av:assassin';
const T_CHAT = 'av:chat';
const T_END = 'av:end';

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
// role (호스트 → 플레이어: 내 역할)
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
// info (호스트 → 플레이어: 내 밤 지식, targeted)
// ============================================
export function encodeInfo(info: Knowledge): GameMessage {
  return { type: T_INFO, payload: { info } };
}
export function decodeInfo(msg: GameMessage): { info: Knowledge } | null {
  if (msg.type !== T_INFO) return null;
  const p = msg.payload as { info?: unknown } | null;
  const info = p?.info as { kind?: unknown } | null;
  if (!info || typeof info.kind !== 'string') return null;
  return { info: info as Knowledge };
}

// ============================================
// ready (플레이어 → 호스트: deal 페이즈 역할 확인 완료)
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
// pickTeam (리더 → 호스트: 원정대 확정)
// ============================================
export function encodePickTeam(from: string, team: string[]): GameMessage {
  return { type: T_PICK, payload: { from, team } };
}
export function decodePickTeam(msg: GameMessage): { from: string; team: string[] } | null {
  if (msg.type !== T_PICK) return null;
  const p = msg.payload as { from?: unknown; team?: unknown } | null;
  if (!p || typeof p.from !== 'string' || !Array.isArray(p.team)) return null;
  if (!p.team.every((t) => typeof t === 'string')) return null;
  return { from: p.from, team: p.team as string[] };
}

// ============================================
// vote (플레이어 → 호스트: 원정대 찬반)
// ============================================
export function encodeVote(from: string, vote: Vote): GameMessage {
  return { type: T_VOTE, payload: { from, vote } };
}
export function decodeVote(msg: GameMessage): { from: string; vote: Vote } | null {
  if (msg.type !== T_VOTE) return null;
  const p = msg.payload as { from?: unknown; vote?: unknown } | null;
  if (!p || typeof p.from !== 'string') return null;
  if (p.vote !== 'approve' && p.vote !== 'reject') return null;
  return { from: p.from, vote: p.vote };
}

// ============================================
// questCard (원정대원 → 호스트: 성공/실패 카드)
// ============================================
export function encodeQuestCard(from: string, card: QuestCard): GameMessage {
  return { type: T_QUEST, payload: { from, card } };
}
export function decodeQuestCard(msg: GameMessage): { from: string; card: QuestCard } | null {
  if (msg.type !== T_QUEST) return null;
  const p = msg.payload as { from?: unknown; card?: unknown } | null;
  if (!p || typeof p.from !== 'string') return null;
  if (p.card !== 'success' && p.card !== 'fail') return null;
  return { from: p.from, card: p.card };
}

// ============================================
// assassin (암살자 → 호스트: 멀린 지목)
// ============================================
export function encodeAssassin(from: string, target: string): GameMessage {
  return { type: T_ASSASSIN, payload: { from, target } };
}
export function decodeAssassin(msg: GameMessage): { from: string; target: string } | null {
  if (msg.type !== T_ASSASSIN) return null;
  const p = msg.payload as { from?: unknown; target?: unknown } | null;
  if (!p || typeof p.from !== 'string' || typeof p.target !== 'string') return null;
  return { from: p.from, target: p.target };
}

// ============================================
// chat (플레이어 → 호스트: 토론 한 줄)
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
