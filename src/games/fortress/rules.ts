/**
 * 포트리스 게임 상태 + 포대/데미지/승패 (순수 로직).
 *
 * 지형은 seed 로 생성하고 크레이터를 순차 적용해 동기화하므로(terrain.ts),
 * 여기서는 높이맵을 인자로 받아 포대 y·데미지만 계산한다.
 */

import { terrainTopAt, mapWidthForPlayers } from './terrain';

export type FortIndex = 0 | 1 | 2 | 3 | 4 | 5;

export interface Fort {
  /** 포대 고유 id (턴/HP 식별). 한 플레이어가 여러 포대를 가질 수 있음 */
  id: number;
  ownerPeerId: string;
  ownerNickname: string;
  /** 소유자 순번 (0~5) — 색 구분용 */
  ownerIndex: FortIndex;
  /** 지형 위 x 위치 (고정). y 는 지형에서 계산 */
  x: number;
  hp: number;
  alive: boolean;
}

export type GamePhase = 'aiming' | 'firing' | 'ended';

export interface FortressGame {
  /** 지형 생성 seed */
  seed: number;
  /** 지형 논리 폭 (인원 비례 — 많을수록 넓음) */
  terrainWidth: number;
  forts: Fort[];
  /** 현재 바람 가속 (px/s², +오른쪽). 턴마다 갱신 */
  wind: number;
  /** 현재 차례 포대 id (살아있는 포대 순환) */
  currentTurn: number;
  phase: GamePhase;
  turnCount: number;
  winnerPeerIds: string[];
  /**
   * 플레이어별 특수 무기 잔탄. peerId → 무기 → 남은 발수.
   * normal(일반탄)은 키 없음 = 무제한. 한 명이 포대 여러 개여도 탄약은 공유(플레이어 단위).
   */
  ammo: Record<string, Partial<Record<WeaponId, number>>>;
}

export const FORT_HP = 100;
/** 포대 몸통이 지면 위로 솟은 높이 (중심 y = 지면top - 이 값) */
export const FORT_RISE = 7;
/** 폭발 피해 반경 (직격일수록 큰 피해) — 일반탄 기본값 */
export const BLAST_RADIUS = 62;
/** 직격 최대 피해 — 일반탄 기본값 */
export const MAX_DAMAGE = 42;
/** 지형 크레이터 반경 — 일반탄 기본값 */
export const CRATER_RADIUS = 34;

// ============================================
// 무기 정의
// ============================================

export type WeaponId = 'normal' | 'big' | 'split' | 'guided' | 'bombard' | 'grenade';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  icon: string;
  /** 폭발 반경 */
  blastRadius: number;
  /** 직격 최대 데미지 */
  maxDamage: number;
  /** 지형 크레이터 반경 */
  craterRadius: number;
  /** true 면 바람 무시(유도탄) */
  ignoreWind?: boolean;
  /** 정점에서 분열하는 무기(분열탄) */
  split?: boolean;
  /** 퓨즈 시간(ms). 있으면 지형에 튕기며 이 시간 뒤 폭발(수류탄) */
  fuseMs?: number;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  // 데미지는 HP 100 기준 "직격 ~3방에 처치" 밸런스. 반경/크레이터는 유지.
  normal:  { id: 'normal',  name: '일반탄', icon: '💣', blastRadius: 62, maxDamage: 42, craterRadius: 34 },
  big:     { id: 'big',     name: '대형탄', icon: '💥', blastRadius: 90, maxDamage: 54, craterRadius: 50 },
  guided:  { id: 'guided',  name: '유도탄', icon: '🛰️', blastRadius: 62, maxDamage: 42, craterRadius: 34, ignoreWind: true },
  bombard: { id: 'bombard', name: '폭격탄', icon: '☄️', blastRadius: 55, maxDamage: 36, craterRadius: 60 },
  split:   { id: 'split',   name: '분열탄', icon: '✴️', blastRadius: 42, maxDamage: 27, craterRadius: 24, split: true },
  grenade: { id: 'grenade', name: '수류탄', icon: '🧨', blastRadius: 58, maxDamage: 40, craterRadius: 32, fuseMs: 3000 },
};

/** 랜덤 배분 대상 특수 무기 풀 (5종 중 각 플레이어 2종). */
export const SPECIAL_POOL: WeaponId[] = ['big', 'guided', 'bombard', 'split', 'grenade'];

/** 랜덤 모드: 무기당 배분 발수 */
export const AMMO_PER_WEAPON = 3;
/** 랜덤 모드: 플레이어당 특수 무기 종류 수 */
export const SPECIALS_PER_PLAYER = 3;
/** 전체 모드: 특수 전부 지급, 무기당 발수 */
export const AMMO_ALL_MODE = 2;

export type WeaponMode = 'random' | 'all';

/**
 * 플레이어별 특수 무기 잔탄 초기화. (호스트가 만들어 sync 하므로 랜덤 OK)
 *   - random(기본): 특수 풀에서 랜덤 3종 × 3발.
 *   - all: 특수 전부(5종) × 2발.
 */
export function assignLoadouts(peerIds: string[], mode: WeaponMode = 'random'): FortressGame['ammo'] {
  const ammo: FortressGame['ammo'] = {};
  for (const pid of peerIds) {
    const inv: Partial<Record<WeaponId, number>> = {};
    if (mode === 'all') {
      for (const w of SPECIAL_POOL) inv[w] = AMMO_ALL_MODE;
    } else {
      const shuffled = [...SPECIAL_POOL].sort(() => Math.random() - 0.5);
      for (const w of shuffled.slice(0, SPECIALS_PER_PLAYER)) inv[w] = AMMO_PER_WEAPON;
    }
    ammo[pid] = inv;
  }
  return ammo;
}

/** 해당 플레이어가 이 무기를 쏠 수 있는지 (normal 무제한, 특수는 잔탄>0) */
export function hasAmmo(game: FortressGame, peerId: string, w: WeaponId): boolean {
  if (w === 'normal') return true;
  return (game.ammo[peerId]?.[w] ?? 0) > 0;
}

/** 무기 발사 시 잔탄 1 차감 (normal 은 no-op). 모든 클라가 fr:fire 재생 시 호출해 동기 유지. */
export function spendAmmo(game: FortressGame, peerId: string, w: WeaponId): void {
  if (w === 'normal') return;
  const inv = game.ammo[peerId];
  if (inv && typeof inv[w] === 'number') inv[w] = Math.max(0, inv[w]! - 1);
}

// ============================================
// 초기화
// ============================================

/** 포대를 지형 폭에 균등 배치 (양 끝 여백). */
function layoutFortX(n: number, width: number): number[] {
  const margin = 70;
  const span = width - margin * 2;
  if (n === 1) return [width / 2];
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(margin + (span * i) / (n - 1));
  return xs;
}

export function createInitialGame(
  players: Array<{ peerId: string; nickname: string }>,
  seed: number,
  wind: number,
  fortsPerPlayer = 1,
  weaponMode: WeaponMode = 'random',
): FortressGame {
  if (players.length < 2 || players.length > 6) {
    throw new Error(`포트리스는 2~6인만 지원해요 (현재 ${players.length}인)`);
  }
  const perPlayer = Math.max(1, Math.min(3, fortsPerPlayer));
  const total = players.length * perPlayer;
  const terrainWidth = mapWidthForPlayers(players.length);
  const xs = layoutFortX(total, terrainWidth);

  // 라운드로빈 배치: 좌→우로 P0,P1,...,P0,P1,... — 같은 소유자 포대가 흩어져 균형
  const forts: Fort[] = [];
  let fid = 0;
  for (let k = 0; k < perPlayer; k++) {
    for (let pi = 0; pi < players.length; pi++) {
      forts.push({
        id: fid,
        ownerPeerId: players[pi]!.peerId,
        ownerNickname: players[pi]!.nickname,
        ownerIndex: pi as FortIndex,
        x: xs[fid]!,
        hp: FORT_HP,
        alive: true,
      });
      fid++;
    }
  }
  // x 순으로 정렬하고 id 재부여(턴이 좌→우 순서로 자연스럽게)
  forts.sort((a, b) => a.x - b.x);
  forts.forEach((f, i) => { f.id = i; });

  return {
    seed,
    terrainWidth,
    forts,
    wind,
    currentTurn: 0,
    phase: 'aiming',
    turnCount: 0,
    winnerPeerIds: [],
    ammo: assignLoadouts([...new Set(players.map((p) => p.peerId))], weaponMode),
  };
}

// ============================================
// 포대 위치 / 턴
// ============================================

/** 포대 중심 y — 지형 top 위로 FORT_RISE 만큼 솟음 */
export function fortCenterY(hm: number[], fort: Fort): number {
  return terrainTopAt(hm, fort.x) - FORT_RISE;
}

/**
 * 다음 턴 — 현재 위치(포대 id, 좌→우 순) 다음으로 살아있는 포대 id.
 *
 * id 는 x 좌표 순으로 0,1,2… 부여돼 있어 "위치 순서" == "id 순서".
 * 현재 포대가 죽어(currentTurn 이 alive 목록에 없어도) id 기준으로 그 다음 위치를
 * 이어가므로 자폭 후에도 턴 순서가 왼쪽으로 튀지 않는다.
 * (예전엔 indexOf===-1 → alive[0] 로 점프해 순서가 깨지던 버그)
 */
export function getNextTurn(game: FortressGame): number {
  const alive = game.forts.filter((f) => f.alive).map((f) => f.id).sort((a, b) => a - b);
  if (alive.length === 0) return 0;
  // 현재 id 보다 큰 첫 살아있는 포대, 없으면 wrap 해서 가장 작은 살아있는 포대
  const nextGreater = alive.find((id) => id > game.currentTurn);
  return nextGreater !== undefined ? nextGreater : alive[0]!;
}

// ============================================
// 착탄 피해
// ============================================

export interface BlastResult {
  /** 각 포대 id → 갱신된 hp */
  hp: Record<number, number>;
  /** 이번 착탄으로 게임이 끝났는지 */
  ended: boolean;
}

/**
 * 착탄점(cx, cy) 폭발 피해 적용 (호스트). 거리 비례 데미지 + 사망/승패 판정.
 * 크레이터(지형 파괴)는 호출부에서 terrain.carveCrater 로 별도 처리.
 */
export function applyBlast(
  game: FortressGame,
  hm: number[],
  cx: number,
  cy: number,
  blastRadius: number = BLAST_RADIUS,
  maxDamage: number = MAX_DAMAGE,
): BlastResult {
  for (const f of game.forts) {
    if (!f.alive) continue;
    const fy = fortCenterY(hm, f);
    const d = Math.hypot(f.x - cx, fy - cy);
    if (d < blastRadius) {
      const dmg = Math.round(maxDamage * (1 - d / blastRadius));
      f.hp = Math.max(0, f.hp - dmg);
      if (f.hp <= 0) f.alive = false;
    }
  }

  const hp: Record<number, number> = {};
  for (const f of game.forts) hp[f.id] = f.hp;

  // 승패는 "살아있는 포대의 소유자" 단위 — 한 플레이어의 모든 포대가 부서지면 탈락
  const survivorOwners = [...new Set(game.forts.filter((f) => f.alive).map((f) => f.ownerPeerId))];
  let ended = false;
  if (survivorOwners.length <= 1) {
    ended = true;
    game.phase = 'ended';
    game.winnerPeerIds = survivorOwners; // 0명이면 무승부(빈 배열)
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
