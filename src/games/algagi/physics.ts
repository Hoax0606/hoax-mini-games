/**
 * 알까기 물리 시뮬레이션
 *
 * 모델:
 *   - 알 = 원형 강체 (같은 질량, 같은 반지름)
 *   - 마찰 = 지수 감쇠. 매 틱 속도 *= exp(-FRICTION_PER_SEC * dt)
 *   - 알 vs 알 = 탄성 충돌 (운동량 보존, 약간의 에너지 손실)
 *   - 알 vs 벽 = 없음. 알까기는 절벽 밖으로 떨어짐.
 *     보드 밖 알 제거는 rules.ts 의 resolveTurnEnd 에서 일괄 처리.
 *
 * 호출 패턴 (engine 루프):
 *   while (phase === 'resolving') {
 *     stepPhysics(stones, dt);
 *     if (allAtRest(stones)) {
 *       resolveTurnEnd(game);
 *       break;
 *     }
 *   }
 *
 * 결정론성:
 *   같은 초기 상태 + 같은 dt 시퀀스 → 같은 결과.
 *   네트워크 동기화는 호스트 시뮬레이션 후 state broadcast 라
 *   엄밀한 결정론은 필요 없음 (수신 측은 받은 state 로 렌더만).
 */

import {
  type Stone,
  STONE_RADIUS,
  FRICTION_PER_SEC,
  REST_SPEED,
  MAX_FLICK_SPEED,
  FLICK_SPEED_PER_PX,
} from './rules';

/** 충돌 시 에너지 보존율. 1 = 완전 탄성, 0.95 = 약간 손실 */
const RESTITUTION = 0.95;

// ============================================
// 메인 스텝
// ============================================

/**
 * 한 시뮬레이션 틱 진행 (dt 초).
 *  1) 살아있는 알 마찰 적용 + 임계 속도 미만은 0 으로 떨어뜨림
 *  2) 위치 적분 (x += vx * dt)
 *  3) 모든 살아있는 알 쌍에 대해 충돌 처리
 */
export function stepPhysics(stones: Stone[], dt: number): void {
  const drag = Math.exp(-FRICTION_PER_SEC * dt);

  for (const s of stones) {
    if (!s.alive) continue;

    // 마찰
    s.vx *= drag;
    s.vy *= drag;

    // 작은 속도는 0 으로 — 떨림 / 미세 진동 방지
    if (Math.hypot(s.vx, s.vy) < REST_SPEED) {
      s.vx = 0;
      s.vy = 0;
    }

    // 위치 적분
    s.x += s.vx * dt;
    s.y += s.vy * dt;
  }

  // 모든 살아있는 알 쌍 충돌 검사. O(n²) 지만 알 수 최대 ~20 이라 무시 가능.
  for (let i = 0; i < stones.length; i++) {
    const a = stones[i]!;
    if (!a.alive) continue;
    for (let j = i + 1; j < stones.length; j++) {
      const b = stones[j]!;
      if (!b.alive) continue;
      collidePair(a, b);
    }
  }
}

/** 두 알의 탄성 충돌 처리. overlap 보정 + normal 방향 속도 반사. */
function collidePair(a: Stone, b: Stone): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distSq = dx * dx + dy * dy;
  const minDist = STONE_RADIUS * 2;
  if (distSq >= minDist * minDist) return;

  const dist = Math.sqrt(distSq);
  if (dist < 1e-6) {
    // 정확히 같은 위치 — 임의 방향으로 살짝 분리해 다음 틱에서 해소되도록.
    a.x -= STONE_RADIUS;
    b.x += STONE_RADIUS;
    return;
  }

  const nx = dx / dist;
  const ny = dy / dist;

  // 위치 overlap 보정 — 두 알을 절반씩 normal 방향으로 분리
  const overlap = (minDist - dist) / 2;
  a.x -= nx * overlap;
  a.y -= ny * overlap;
  b.x += nx * overlap;
  b.y += ny * overlap;

  // 상대 속도의 normal 성분
  const relVx = b.vx - a.vx;
  const relVy = b.vy - a.vy;
  const velAlongNormal = relVx * nx + relVy * ny;

  // 이미 멀어지고 있다면 (positional overlap 만 있고 운동 충돌은 아님) skip
  if (velAlongNormal > 0) return;

  // 같은 질량 두 강체의 1D 탄성 충돌: impulse j = -(1+e) * v_rel · n / 2
  const j = -(1 + RESTITUTION) * velAlongNormal / 2;

  a.vx -= j * nx;
  a.vy -= j * ny;
  b.vx += j * nx;
  b.vy += j * ny;
}

// ============================================
// 정지 판정
// ============================================

/** 모든 살아있는 알이 정지(속도 = 0) 상태인지 — turn 종료 판정. */
export function allAtRest(stones: Stone[]): boolean {
  for (const s of stones) {
    if (!s.alive) continue;
    if (s.vx !== 0 || s.vy !== 0) return false;
  }
  return true;
}

// ============================================
// 알 튕기기 (드래그 → 초기 속도)
// ============================================

/**
 * 드래그 벡터(드래그 시작점에서 현재 마우스 위치까지) → 알 초기 속도.
 * 발사 방향은 드래그 반대 (활시위 당기듯). 최대 속도 클램프.
 *
 * @param dragDx 드래그 x 변위 (현재 - 시작)
 * @param dragDy 드래그 y 변위 (현재 - 시작)
 */
export function dragToVelocity(dragDx: number, dragDy: number): { vx: number; vy: number } {
  let vx = -dragDx * FLICK_SPEED_PER_PX;
  let vy = -dragDy * FLICK_SPEED_PER_PX;
  const speed = Math.hypot(vx, vy);
  if (speed > MAX_FLICK_SPEED) {
    const scale = MAX_FLICK_SPEED / speed;
    vx *= scale;
    vy *= scale;
  }
  return { vx, vy };
}

/** 알에 초기 속도 적용. flick 시점에 호출. */
export function applyFlick(stone: Stone, vx: number, vy: number): void {
  stone.vx = vx;
  stone.vy = vy;
}
