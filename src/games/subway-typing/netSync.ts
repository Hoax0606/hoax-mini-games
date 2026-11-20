/**
 * 지하철 타자 네트워크 프로토콜
 *
 * 클라 → 호스트:  sb:hello / sb:progress(역 하나 통과할 때마다) / sb:done(완주)
 * 호스트 → 클라:  sb:start(노선·구간) / sb:standings(전원 진행 현황) / sb:end
 *
 * 타이핑은 각자 로컬에서 굴러간다 — 키 입력을 호스트로 넘기면 지연 때문에 손맛이 죽는다.
 * 호스트는 진행 보고를 모아 순위만 판정한다(똥 피하기와 같은 구조).
 * 친구끼리 하는 게임이라 조작 방지는 신경 쓰지 않는다.
 */

import type { GameMessage, GameResult } from '../types';

const T_HELLO = 'sb:hello';
const T_START = 'sb:start';
const T_PROGRESS = 'sb:progress';
const T_DONE = 'sb:done';
const T_STANDINGS = 'sb:standings';
const T_END = 'sb:end';

/** 호스트가 정한 이번 판의 운행 */
export interface StartPayload {
  /** 'kr' = 수도권, 'jp' = 도쿄. 게스트는 이걸로 어느 데이터에서 코스를 만들지 정한다 */
  region: 'kr' | 'jp';
  lineName: string;
  /** 'down' = 배열 정방향, 'up' = 역방향 */
  dir: 'down' | 'up';
  /** 호스트가 출발 신호를 보낸 시각 기준 카운트다운 ms */
  countdownMs: number;
}

export interface Standing {
  peerId: string;
  nickname: string;
  index: number;
  chars: number;
  mistakes: number;
  /** 완주 시간. 아직이면 null */
  timeMs: number | null;
}

export function encodeHello(peerId: string): GameMessage {
  return { type: T_HELLO, payload: { peerId } };
}
export function decodeHello(msg: GameMessage): { peerId: string } | null {
  if (msg.type !== T_HELLO) return null;
  const p = msg.payload as { peerId?: unknown } | null;
  return p && typeof p.peerId === 'string' ? { peerId: p.peerId } : null;
}

export function encodeStart(p: StartPayload): GameMessage {
  return { type: T_START, payload: p };
}
export function decodeStart(msg: GameMessage): StartPayload | null {
  if (msg.type !== T_START) return null;
  const p = msg.payload as Partial<StartPayload> | null;
  if (!p || typeof p.lineName !== 'string') return null;
  return {
    // 예전 버전이 보낸 payload 엔 region 이 없다 → 수도권으로 본다
    region: p.region === 'jp' ? 'jp' : 'kr',
    lineName: p.lineName,
    dir: p.dir === 'up' ? 'up' : 'down',
    countdownMs: typeof p.countdownMs === 'number' ? p.countdownMs : 3000,
  };
}

export function encodeProgress(from: string, index: number, chars: number, mistakes: number): GameMessage {
  return { type: T_PROGRESS, payload: { from, index, chars, mistakes } };
}
export function decodeProgress(
  msg: GameMessage,
): { from: string; index: number; chars: number; mistakes: number } | null {
  if (msg.type !== T_PROGRESS) return null;
  const p = msg.payload as Record<string, unknown> | null;
  if (!p || typeof p['from'] !== 'string' || typeof p['index'] !== 'number') return null;
  return {
    from: p['from'] as string,
    index: p['index'] as number,
    chars: typeof p['chars'] === 'number' ? (p['chars'] as number) : 0,
    mistakes: typeof p['mistakes'] === 'number' ? (p['mistakes'] as number) : 0,
  };
}

export function encodeDone(from: string, timeMs: number, chars: number, mistakes: number): GameMessage {
  return { type: T_DONE, payload: { from, timeMs, chars, mistakes } };
}
export function decodeDone(
  msg: GameMessage,
): { from: string; timeMs: number; chars: number; mistakes: number } | null {
  if (msg.type !== T_DONE) return null;
  const p = msg.payload as Record<string, unknown> | null;
  if (!p || typeof p['from'] !== 'string' || typeof p['timeMs'] !== 'number') return null;
  return {
    from: p['from'] as string,
    timeMs: p['timeMs'] as number,
    chars: typeof p['chars'] === 'number' ? (p['chars'] as number) : 0,
    mistakes: typeof p['mistakes'] === 'number' ? (p['mistakes'] as number) : 0,
  };
}

export function encodeStandings(list: Standing[]): GameMessage {
  return { type: T_STANDINGS, payload: { list } };
}
export function decodeStandings(msg: GameMessage): Standing[] | null {
  if (msg.type !== T_STANDINGS) return null;
  const p = msg.payload as { list?: unknown } | null;
  return p && Array.isArray(p.list) ? (p.list as Standing[]) : null;
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
