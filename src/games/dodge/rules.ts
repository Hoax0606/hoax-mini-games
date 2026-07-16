/**
 * 똥 피하기 — 규칙 / 결정론적 낙하물 생성.
 *
 * 핵심: 낙하물(💩)의 위치·속도는 "시드 + 경과시간 t"의 순수 함수라 프레임레이트와 무관.
 *   - 동일 모드: 호스트가 시드 1개 broadcast → 전원 같은 패턴(공정)
 *   - 랜덤 모드: 각 클라가 자기 시드 → 사람마다 다른 패턴
 * 캐릭터 이동/대시는 각자 로컬(플레이어 입력)이고, 죽음은 "내 캐릭터가 낙하물에 닿은 시각".
 *   낙하물이 전원 동일(동일 모드)이라 순수 실력 승부. 마지막 생존자 승, 순위는 생존시간.
 */

// ── 필드 / 캐릭터 ──
export const FIELD_W = 560;
export const FIELD_H = 480;
export const PLAYER_W = 34;
export const PLAYER_H = 38;
/** 캐릭터 상단 y (바닥에서 살짝 위) */
export const PLAYER_Y = FIELD_H - PLAYER_H - 10;
/** 이동 속도(px/s) — 좌우 홀드 */
export const MOVE_SPEED = 340;

// ── 대시 (좌우 짧은 고속 회피 + 쿨다운) ──
export const DASH_SPEED = 880;
export const DASH_DUR_MS = 160;
export const DASH_CD_MS = 1500;

// ── 낙하물 ──
export const FALLER_SIZE = 30;
/** 충돌 판정 여유(px) — 히트박스를 살짝 줄여 "닿을락 말락"은 안 죽게(재미) */
export const HIT_PADDING = 6;
/** 낙하 속도: base + 경과초 × accel + 지터 (시간 지날수록 빨라짐 — 가속 상향) */
const FALL_BASE = 230;
const FALL_ACCEL = 7.0;
const FALL_JITTER = 90;
/** 스폰 간격(초): start 에서 시작해 시간 지날수록 min 까지 촘촘 (더 빨리·더 촘촘하게) */
const SPAWN_START = 0.60;
const SPAWN_MIN = 0.14;
const SPAWN_RAMP = 0.011;
/** 첫 스폰까지 딜레이(초) — 시작하자마자 안 맞게 */
const FIRST_SPAWN_T = 0.6;
/** 동시 낙하 개수(버스트): 시간 지날수록 한 번에 여러 개 떨어짐. BURST_EVERY 초마다 +1, 상한 MAX_BURST */
const BURST_EVERY = 20;
const MAX_BURST = 4;

/** 호스트 안전장치 — 이 시간(ms) 지나면 강제 종료(생존시간 순위). 보통 그 전에 다 죽음. */
export const MAX_GAME_MS = 180_000;

export interface Faller {
  x: number;         // 좌상단 x (0..FIELD_W-size)
  size: number;
  spawnT: number;    // 스폰 시각(초)
  speed: number;     // px/s
}

/** 낙하물의 시각 t(초)에서의 y (좌상단). 화면 위(-size)에서 시작해 내려옴. */
export function fallerY(f: Faller, t: number): number {
  return -f.size + (t - f.spawnT) * f.speed;
}

/** Mulberry32 — 시드 하나로 결정론적 난수열 (사과게임과 같은 계열) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 시드 기반 낙하물 스트림. ensure(t) 로 t+lookahead 까지 필요한 만큼 생성해 fallers 에 누적.
 * 같은 시드 → 같은 순서로 rand 소비 → 완전히 동일한 낙하물 목록.
 */
export function createSpawner(seed: number): { fallers: Faller[]; ensure(t: number): void } {
  const rand = mulberry32(seed);
  const fallers: Faller[] = [];
  let nextT = FIRST_SPAWN_T;
  return {
    fallers,
    ensure(t: number): void {
      // 현재 시각 + 2초 앞까지 미리 생성 (렌더 룩어헤드)
      while (nextT <= t + 2) {
        // 시간 지날수록 한 번에 여러 개(버스트) — 똥 개수 점점 증가
        const burst = Math.min(MAX_BURST, 1 + Math.floor(nextT / BURST_EVERY));
        for (let b = 0; b < burst; b++) {
          const x = rand() * (FIELD_W - FALLER_SIZE);
          const speed = FALL_BASE + nextT * FALL_ACCEL + (rand() - 0.5) * FALL_JITTER;
          fallers.push({ x, size: FALLER_SIZE, spawnT: nextT, speed });
        }
        const interval = Math.max(SPAWN_MIN, SPAWN_START - nextT * SPAWN_RAMP);
        nextT += interval;
      }
    },
  };
}

/**
 * 캐릭터(좌상단 playerX, PLAYER_Y)가 시각 t 에 낙하물 중 하나라도 닿았는지.
 * AABB + HIT_PADDING(양쪽 여유)으로 살짝 관대하게.
 */
export function isHit(playerX: number, t: number, fallers: Faller[]): boolean {
  const pad = HIT_PADDING;
  const pl = playerX + pad, pr = playerX + PLAYER_W - pad;
  const pt = PLAYER_Y + pad, pb = PLAYER_Y + PLAYER_H - pad;
  for (const f of fallers) {
    const fy = fallerY(f, t);
    if (fy > FIELD_H || fy + f.size < 0) continue; // 화면 밖
    const fl = f.x + pad, fr = f.x + f.size - pad;
    const ft = fy + pad, fb = fy + f.size - pad;
    if (pl < fr && pr > fl && pt < fb && pb > ft) return true;
  }
  return false;
}

/** 낙하 패턴 모드 */
export type DodgeMode = 'same' | 'random';
