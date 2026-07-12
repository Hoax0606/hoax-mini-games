/**
 * 포트리스 게임 상태 + 포대/데미지/승패 (순수 로직).
 *
 * 지형은 seed 로 생성하고 크레이터를 순차 적용해 동기화하므로(terrain.ts),
 * 여기서는 높이맵을 인자로 받아 포대 y·데미지만 계산한다.
 */

import { terrainTopAt, TERRAIN_WIDTH } from './terrain';

export type FortIndex = 0 | 1 | 2 | 3 | 4 | 5;

export interface Fort {
  peerId: string;
  nickname: string;
  index: FortIndex;
  /** 지형 위 x 위치 (고정). y 는 지형에서 계산 */
  x: number;
  hp: number;
  alive: boolean;
}

export type GamePhase = 'aiming' | 'firing' | 'ended';

export interface FortressGame {
  /** 지형 생성 seed */
  seed: number;
  forts: Fort[];
  /** 현재 바람 가속 (px/s², +오른쪽). 턴마다 갱신 */
  wind: number;
  currentTurn: FortIndex;
  phase: GamePhase;
  turnCount: number;
  winnerPeerIds: string[];
}

export const FORT_HP = 100;
/** 포대 몸통이 지면 위로 솟은 높이 (중심 y = 지면top - 이 값) */
export const FORT_RISE = 7;
/** 폭발 피해 반경 (직격일수록 큰 피해) */
export const BLAST_RADIUS = 62;
/** 직격 최대 피해 */
export const MAX_DAMAGE = 52;
/** 지형 크레이터 반경 */
export const CRATER_RADIUS = 34;

// ============================================
// 초기화
// ============================================

/** 포대를 지형 폭에 균등 배치 (양 끝 여백). */
function layoutFortX(n: number): number[] {
  const margin = 70;
  const span = TERRAIN_WIDTH - margin * 2;
  if (n === 1) return [TERRAIN_WIDTH / 2];
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(margin + (span * i) / (n - 1));
  return xs;
}

export function createInitialGame(
  players: Array<{ peerId: string; nickname: string }>,
  seed: number,
  wind: number,
): FortressGame {
  if (players.length < 2 || players.length > 6) {
    throw new Error(`포트리스는 2~6인만 지원해요 (현재 ${players.length}인)`);
  }
  const xs = layoutFortX(players.length);
  const forts: Fort[] = players.map((p, i) => ({
    peerId: p.peerId,
    nickname: p.nickname,
    index: i as FortIndex,
    x: xs[i]!,
    hp: FORT_HP,
    alive: true,
  }));
  return {
    seed,
    forts,
    wind,
    currentTurn: 0,
    phase: 'aiming',
    turnCount: 0,
    winnerPeerIds: [],
  };
}

// ============================================
// 포대 위치 / 턴
// ============================================

/** 포대 중심 y — 지형 top 위로 FORT_RISE 만큼 솟음 */
export function fortCenterY(hm: number[], fort: Fort): number {
  return terrainTopAt(hm, fort.x) - FORT_RISE;
}

/** 다음 턴 — 현재 다음으로 살아있는 포대 */
export function getNextTurn(game: FortressGame): FortIndex {
  const alive = game.forts.filter((f) => f.alive).map((f) => f.index);
  if (alive.length === 0) return 0;
  const cur = alive.indexOf(game.currentTurn);
  const next = cur === -1 ? 0 : (cur + 1) % alive.length;
  return alive[next]!;
}

// ============================================
// 착탄 피해
// ============================================

export interface BlastResult {
  /** 각 포대 index → 갱신된 hp */
  hp: Record<number, number>;
  /** 이번 착탄으로 게임이 끝났는지 */
  ended: boolean;
}

/**
 * 착탄점(cx, cy) 폭발 피해 적용 (호스트). 거리 비례 데미지 + 사망/승패 판정.
 * 크레이터(지형 파괴)는 호출부에서 terrain.carveCrater 로 별도 처리.
 */
export function applyBlast(game: FortressGame, hm: number[], cx: number, cy: number): BlastResult {
  for (const f of game.forts) {
    if (!f.alive) continue;
    const fy = fortCenterY(hm, f);
    const d = Math.hypot(f.x - cx, fy - cy);
    if (d < BLAST_RADIUS) {
      const dmg = Math.round(MAX_DAMAGE * (1 - d / BLAST_RADIUS));
      f.hp = Math.max(0, f.hp - dmg);
      if (f.hp <= 0) f.alive = false;
    }
  }

  const hp: Record<number, number> = {};
  for (const f of game.forts) hp[f.index] = f.hp;

  const survivors = game.forts.filter((f) => f.alive);
  let ended = false;
  if (survivors.length <= 1) {
    ended = true;
    game.phase = 'ended';
    game.winnerPeerIds = survivors.map((f) => f.peerId); // 0명이면 무승부(빈 배열)
  }
  return { hp, ended };
}

/** 다음 턴/바람으로 진행 (착탄 후, 게임 안 끝났을 때). */
export function advanceTurn(game: FortressGame, nextWind: number, now: number): void {
  void now;
  game.currentTurn = getNextTurn(game);
  game.wind = nextWind;
  game.phase = 'aiming';
  game.turnCount++;
}
