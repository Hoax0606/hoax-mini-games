/**
 * 포트리스 포탄 물리 — 중력 + 바람 받는 포물선.
 *
 * 좌표: y 아래가 +. 위로 쏘려면 vy 음수.
 *
 * **구간별 해석식(piecewise-analytic)**:
 *   포탄의 위치를 매 프레임 dt 누적(Euler)이 아니라, "구간 시작 후 경과시간 t 의
 *   닫힌 수식"으로 직접 계산한다. 프레임레이트/렉과 무관하게 궤적이 100% 동일 →
 *   호스트·게스트가 같은 경로를 그리고 같은 착탄점에 수렴. 누적 부동소수 오차도 없음.
 *
 *   한 구간(FlightSeg) = 등가속 포물선. 속도가 바뀌는 사건(분열탄 분열, 수류탄 튕김)
 *   때만 그 지점을 원점으로 새 구간을 시작한다(그래서 "구간별").
 *
 * 결정론적: 같은 (구간 시작상태, wind) + 같은 스텝수 → 같은 궤적.
 *   최종 착탄 판정/피해는 호스트가 확정해 broadcast (부동소수 미세오차 대비).
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

/**
 * 한 비행 구간 — 등가속 포물선. 위치/속도가 이 원점 상태 + 경과시간 t 의 수식으로 결정.
 * 속도가 바뀌는 사건(분열/튕김) 때 그 지점으로 새 구간을 만든다.
 */
export interface FlightSeg {
  /** 구간 시작 좌표 */
  x0: number;
  y0: number;
  /** 구간 시작 속도 */
  vx0: number;
  vy0: number;
  /** 이 구간의 바람 가속(px/s²). 유도탄은 0 */
  wind: number;
}

/** 구간 시작 후 t초 위치 (해석식). x = x0 + vx0·t + ½·wind·t², y = y0 + vy0·t + ½·g·t² */
export function segPos(seg: FlightSeg, t: number): { x: number; y: number } {
  return {
    x: seg.x0 + seg.vx0 * t + 0.5 * seg.wind * t * t,
    y: seg.y0 + seg.vy0 * t + 0.5 * GRAVITY * t * t,
  };
}

/** 구간 시작 후 t초 속도 (해석식). 분열 분산·튕김 반사·수류탄 굴림 계산에 쓴다. */
export function segVel(seg: FlightSeg, t: number): { vx: number; vy: number } {
  return { vx: seg.vx0 + seg.wind * t, vy: seg.vy0 + GRAVITY * t };
}
