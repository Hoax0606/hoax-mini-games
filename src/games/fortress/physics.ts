/**
 * 포트리스 포탄 물리 — 중력 + 바람 받는 포물선.
 *
 * 좌표: y 아래가 +. 위로 쏘려면 vy 음수.
 * 결정론적: 같은 (시작좌표, vx, vy, wind) → 같은 궤적 → 모든 클라 착탄점 수렴.
 *   각 클라가 stepProjectile 로 궤적을 애니메이션하고, 최종 착탄 판정/피해는
 *   호스트가 확정해 broadcast (부동소수 미세오차 대비).
 */

/** 중력 가속도 (px/s²) */
export const GRAVITY = 520;
/** 발사 파워 → 속도 범위 (px/s). 드래그 세기로 이 사이 보간 */
export const MIN_POWER = 220;
export const MAX_POWER = 900;
/** 바람 가속도 최대치 (px/s²). 턴마다 -MAX~+MAX 랜덤 */
export const MAX_WIND = 130;

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * 각도(라디안, 0=오른쪽 수평 / +위쪽) + 파워(0~1) → 초기 속도.
 * @param angleRad 발사 각도. 화면 기준 위로 쏘면 양의 각.
 * @param power01  0~1 정규화 세기
 */
export function launchVelocity(angleRad: number, power01: number): { vx: number; vy: number } {
  const speed = MIN_POWER + (MAX_POWER - MIN_POWER) * Math.max(0, Math.min(1, power01));
  return {
    vx: Math.cos(angleRad) * speed,
    vy: -Math.sin(angleRad) * speed, // 위(+각도)면 vy 음수
  };
}

/** 포탄 한 스텝 진행 (dt 초). windAccel = 바람 가속(px/s², +는 오른쪽). mutate. */
export function stepProjectile(p: Projectile, windAccel: number, dt: number): void {
  p.vx += windAccel * dt;
  p.vy += GRAVITY * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}
