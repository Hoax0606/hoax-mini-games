/**
 * 에어하키 물리 시뮬레이션
 *
 * 이 파일은 "순수" 상태 변경 로직만 담당:
 *   - DOM 접근 없음
 *   - Canvas 없음
 *   - 네트워크 없음
 *   → render.ts, netSync.ts 가 이걸 조립해서 씀.
 *
 * 좌표계:
 *   - 논리적 필드는 800 x 400 (가로형 테이블). 실제 캔버스 픽셀과 분리.
 *   - render.ts 가 캔버스 크기에 맞게 스케일 적용.
 *
 * 호스트 authoritative:
 *   - stepPhysics()는 호스트만 실행.
 *   - 게스트는 호스트가 보내준 GameState를 그대로 받아서 렌더만 함.
 *
 * 끼임 방지:
 *   - 퍽 속도가 MIN_STUCK_SPEED 미만으로 STUCK_FRAMES 만큼 지속되면
 *     자동으로 중앙 리셋. (벽/말렛 사이 구석에 끼는 상황 방어)
 */

// ============================================
// 필드 / 물리 상수
// ============================================

export const FIELD = {
  WIDTH: 800,
  HEIGHT: 400,
  PUCK_RADIUS: 14,
  MALLET_RADIUS: 24,
  /** 골대 세로 폭 (중앙 기준 ±GOAL_WIDTH/2) */
  GOAL_WIDTH: 130,
} as const;

/** 골대 Y 범위 — 이 사이에 퍽이 들어오면 득점 */
export const GOAL_Y_MIN = FIELD.HEIGHT / 2 - FIELD.GOAL_WIDTH / 2;
export const GOAL_Y_MAX = FIELD.HEIGHT / 2 + FIELD.GOAL_WIDTH / 2;

/** 진영 경계 (중앙선 x좌표) */
export const CENTER_X = FIELD.WIDTH / 2;

export const PHYSICS = {
  /** 60 FPS 고정 가정. 네트워크 동기화 단순화를 위해 가변 dt 안 씀 */
  FIXED_DT: 1 / 60,

  /** 퍽 마찰 — 매 프레임 이 비율로 속도가 감쇠 */
  FRICTION_PER_FRAME: 0.996,
  /** 벽 반사 시 속도 유지율 (1이면 완전 탄성) */
  WALL_BOUNCE_DAMPING: 0.99,
  /** 말렛 충돌마다 퍽 속도에 곱해지는 가속 계수 — 치면 칠수록 빨라지는 느낌 */
  MALLET_HIT_ACCEL: 1.08,
  /** 말렛 속도가 퍽에 전달되는 비율 */
  MALLET_MOMENTUM_FACTOR: 0.55,

  MAX_PUCK_SPEED: 1400,       // pixel/sec
  MALLET_MAX_SPEED: 1400,     // 입력 튐 방지용 상한

  /** 끼임 판정 — 속도가 이보다 느린 상태가 STUCK_FRAMES 만큼 지속 시 리셋 */
  MIN_STUCK_SPEED: 12,
  STUCK_FRAMES: 180,          // 3초 @ 60fps

  /** 골 후 "GOAL!" 이펙트 재생 시간. 이 시간 끝나면 곧바로 playing 상태로 복귀 */
  GOAL_PAUSE_FRAMES: 90,      // 1.5초
} as const;

// ============================================
// 타입
// ============================================

export interface Vec2 { x: number; y: number; }

export interface Puck {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Mallet {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type Side = 'host' | 'guest';

/**
 * 게임의 전체 상태. 호스트가 소유하고 매 프레임 게스트에게 스냅샷으로 전송.
 */
export interface GameState {
  puck: Puck;
  mallets: { host: Mallet; guest: Mallet };
  score: { host: number; guest: number };
  /**
   * 'playing': 정상 플레이 (퍽은 치기 전까지 정지)
   * 'goal_pause': 골 직후 정지 (GOAL! 이펙트 재생)
   */
  phase: 'playing' | 'goal_pause';
  phaseTimer: number;
  stuckTimer: number;
  /** 직전에 실점한 쪽. 재개 시 이 쪽에서 서브 (실점한 쪽 반대로 퍽이 움직임) */
  lastScoredOn: Side | null;
}

/** 매 프레임 stepPhysics가 반환하는 이벤트. render/sound가 소비 */
export type PhysicsEvent =
  | { kind: 'goal'; side: Side }                                        // 득점한 쪽
  | { kind: 'stuck_reset' }                                              // 끼임 리셋 발생
  | { kind: 'wall_hit'; x: number; y: number }
  | { kind: 'mallet_hit'; side: Side; x: number; y: number; intensity: number };

// ============================================
// 초기화
// ============================================

export function createInitialState(): GameState {
  return {
    puck: { x: CENTER_X, y: FIELD.HEIGHT / 2, vx: 0, vy: 0 },
    mallets: {
      host:  { x: FIELD.WIDTH * 0.20, y: FIELD.HEIGHT / 2, vx: 0, vy: 0 },
      guest: { x: FIELD.WIDTH * 0.80, y: FIELD.HEIGHT / 2, vx: 0, vy: 0 },
    },
    score: { host: 0, guest: 0 },
    // 바로 플레이 가능한 상태. 퍽은 정지 상태로 중앙에 있다가 누군가 칠 때 움직임
    phase: 'playing',
    phaseTimer: 0,
    stuckTimer: 0,
    lastScoredOn: null,
  };
}

// ============================================
// 프레임 업데이트 (호스트만 호출)
// ============================================

export interface FrameInputs {
  /** 호스트 말렛이 따라갈 목표 위치 (논리 좌표계) */
  hostTarget: Vec2;
  /** 게스트 말렛 목표 위치 (네트워크로 받은 최신 값) */
  guestTarget: Vec2;
}

/**
 * 한 프레임 시뮬레이션. state를 직접 mutate하고, 발생 이벤트들을 반환.
 */
export function stepPhysics(state: GameState, inputs: FrameInputs): PhysicsEvent[] {
  const events: PhysicsEvent[] = [];

  // 1) 말렛은 어느 phase든 항상 움직임 (대기 중에도 말렛 움직임 보여야 자연스러움)
  updateMallet(state.mallets.host, inputs.hostTarget, 'host');
  updateMallet(state.mallets.guest, inputs.guestTarget, 'guest');

  // 2) phase 별 처리
  if (state.phase === 'goal_pause') {
    state.phaseTimer--;
    if (state.phaseTimer <= 0) {
      resetAfterGoal(state);
    }
    return events; // 골 이펙트 구간엔 퍽 물리 안 돌림
  }

  // phase === 'playing'

  // 3) 퍽 이동
  state.puck.x += state.puck.vx * PHYSICS.FIXED_DT;
  state.puck.y += state.puck.vy * PHYSICS.FIXED_DT;

  // 4) 마찰
  state.puck.vx *= PHYSICS.FRICTION_PER_FRAME;
  state.puck.vy *= PHYSICS.FRICTION_PER_FRAME;

  // 5) 벽 / 골 판정
  const goal = handleWallsAndGoals(state, events);
  if (goal) {
    events.push(goal);
    state.score[goal.side]++;
    state.phase = 'goal_pause';
    state.phaseTimer = PHYSICS.GOAL_PAUSE_FRAMES;
    // 실점한 쪽 = 득점한 쪽의 반대
    state.lastScoredOn = goal.side === 'host' ? 'guest' : 'host';
    return events;
  }

  // 6) 말렛 충돌
  handleMalletCollision(state, 'host', events);
  handleMalletCollision(state, 'guest', events);

  // 7) 끼임 감지 (속도 기반)
  const speed = Math.hypot(state.puck.vx, state.puck.vy);
  if (speed < PHYSICS.MIN_STUCK_SPEED) {
    state.stuckTimer++;
    if (state.stuckTimer >= PHYSICS.STUCK_FRAMES) {
      state.puck.x = CENTER_X;
      state.puck.y = FIELD.HEIGHT / 2;
      state.puck.vx = 0;
      state.puck.vy = 0;
      state.stuckTimer = 0;
      events.push({ kind: 'stuck_reset' });
    }
  } else {
    state.stuckTimer = 0;
  }

  // 8) 최대 속도 상한
  clampSpeed(state.puck, PHYSICS.MAX_PUCK_SPEED);

  return events;
}

// ============================================
// 말렛 업데이트 (입력 → 물리 위치)
// ============================================

function updateMallet(mallet: Mallet, target: Vec2, side: Side): void {
  // 진영 제약: 호스트는 왼쪽, 게스트는 오른쪽 (중앙선 넘지 못함)
  const minX = side === 'host'
    ? FIELD.MALLET_RADIUS
    : CENTER_X + FIELD.MALLET_RADIUS;
  const maxX = side === 'host'
    ? CENTER_X - FIELD.MALLET_RADIUS
    : FIELD.WIDTH - FIELD.MALLET_RADIUS;
  const minY = FIELD.MALLET_RADIUS;
  const maxY = FIELD.HEIGHT - FIELD.MALLET_RADIUS;

  const clampedX = clamp(target.x, minX, maxX);
  const clampedY = clamp(target.y, minY, maxY);

  // 속도 = 위치 변화량 / dt
  let vx = (clampedX - mallet.x) / PHYSICS.FIXED_DT;
  let vy = (clampedY - mallet.y) / PHYSICS.FIXED_DT;

  // 순간 이동 방지: 최대 속도로 제한
  const speed = Math.hypot(vx, vy);
  if (speed > PHYSICS.MALLET_MAX_SPEED) {
    const scale = PHYSICS.MALLET_MAX_SPEED / speed;
    vx *= scale;
    vy *= scale;
    mallet.x += vx * PHYSICS.FIXED_DT;
    mallet.y += vy * PHYSICS.FIXED_DT;
  } else {
    mallet.x = clampedX;
    mallet.y = clampedY;
  }
  mallet.vx = vx;
  mallet.vy = vy;
}

// ============================================
// 벽 / 골 충돌
// ============================================

function handleWallsAndGoals(
  state: GameState,
  events: PhysicsEvent[],
): { kind: 'goal'; side: Side } | null {
  const p = state.puck;

  // 위/아래
  if (p.y < FIELD.PUCK_RADIUS) {
    p.y = FIELD.PUCK_RADIUS;
    p.vy = -p.vy * PHYSICS.WALL_BOUNCE_DAMPING;
    events.push({ kind: 'wall_hit', x: p.x, y: p.y });
  } else if (p.y > FIELD.HEIGHT - FIELD.PUCK_RADIUS) {
    p.y = FIELD.HEIGHT - FIELD.PUCK_RADIUS;
    p.vy = -p.vy * PHYSICS.WALL_BOUNCE_DAMPING;
    events.push({ kind: 'wall_hit', x: p.x, y: p.y });
  }

  // 왼쪽 (호스트 진영) 벽/골
  if (p.x < FIELD.PUCK_RADIUS) {
    if (p.y >= GOAL_Y_MIN && p.y <= GOAL_Y_MAX) {
      // 왼쪽 골대로 들어감 = 게스트 득점
      return { kind: 'goal', side: 'guest' };
    }
    p.x = FIELD.PUCK_RADIUS;
    p.vx = -p.vx * PHYSICS.WALL_BOUNCE_DAMPING;
    events.push({ kind: 'wall_hit', x: p.x, y: p.y });
  }

  // 오른쪽 (게스트 진영) 벽/골
  if (p.x > FIELD.WIDTH - FIELD.PUCK_RADIUS) {
    if (p.y >= GOAL_Y_MIN && p.y <= GOAL_Y_MAX) {
      // 오른쪽 골대 = 호스트 득점
      return { kind: 'goal', side: 'host' };
    }
    p.x = FIELD.WIDTH - FIELD.PUCK_RADIUS;
    p.vx = -p.vx * PHYSICS.WALL_BOUNCE_DAMPING;
    events.push({ kind: 'wall_hit', x: p.x, y: p.y });
  }

  return null;
}

// ============================================
// 말렛 ↔ 퍽 충돌
// ============================================

function handleMalletCollision(state: GameState, side: Side, events: PhysicsEvent[]): void {
  const puck = state.puck;
  const mallet = state.mallets[side];

  const dx = puck.x - mallet.x;
  const dy = puck.y - mallet.y;
  const distSq = dx * dx + dy * dy;
  const minDist = FIELD.PUCK_RADIUS + FIELD.MALLET_RADIUS;

  if (distSq >= minDist * minDist) return;

  const dist = Math.sqrt(distSq) || 0.001; // 0 나눗셈 방지
  const nx = dx / dist;
  const ny = dy / dist;

  // 겹침 해소: 퍽을 말렛 바깥쪽으로 밀어냄
  const overlap = minDist - dist;
  puck.x += nx * overlap;
  puck.y += ny * overlap;

  // 법선 속도 성분만 반사 (말렛 방향으로 가던 속도를 튕겨냄)
  const vn = puck.vx * nx + puck.vy * ny;
  if (vn < 0) {
    puck.vx -= 2 * vn * nx;
    puck.vy -= 2 * vn * ny;
  }

  // 말렛 움직임을 퍽에 실어줌 (밀어치기 효과)
  puck.vx += mallet.vx * PHYSICS.MALLET_MOMENTUM_FACTOR;
  puck.vy += mallet.vy * PHYSICS.MALLET_MOMENTUM_FACTOR;

  // 매 충돌마다 가속 (실제 에어하키 느낌)
  puck.vx *= PHYSICS.MALLET_HIT_ACCEL;
  puck.vy *= PHYSICS.MALLET_HIT_ACCEL;

  clampSpeed(puck, PHYSICS.MAX_PUCK_SPEED);

  const intensity = Math.min(1, Math.hypot(puck.vx, puck.vy) / PHYSICS.MAX_PUCK_SPEED);
  events.push({ kind: 'mallet_hit', side, x: puck.x, y: puck.y, intensity });
}

// ============================================
// 서브 / 골 후 재배치
// ============================================

function resetAfterGoal(state: GameState): void {
  // 실점한 쪽 앞에 퍽 배치 (그 쪽이 먼저 가서 칠 수 있도록)
  const scoredOn = state.lastScoredOn ?? 'host';
  state.puck.x = scoredOn === 'host' ? FIELD.WIDTH * 0.30 : FIELD.WIDTH * 0.70;
  state.puck.y = FIELD.HEIGHT / 2;
  state.puck.vx = 0;
  state.puck.vy = 0;

  // 말렛은 강제로 옮기지 않음. goal_pause 동안 updateMallet 이 매 프레임
  // 호출되므로 말렛은 이미 각 플레이어의 현재 커서 위치를 따라다녔음.
  // 여기서 고정 좌표로 snap 하면 재개 직후 말렛이 MAX_SPEED 로 커서까지 "zoom"
  // 하는 버그가 생기므로 건드리지 말 것. 속도만 0 으로 초기화해서 퍽 충돌 초기화.
  state.mallets.host.vx = 0;
  state.mallets.host.vy = 0;
  state.mallets.guest.vx = 0;
  state.mallets.guest.vy = 0;

  // 카운트다운 없이 바로 플레이 재개 — 퍽은 정지, 치기 전까진 가만히 있음
  state.phase = 'playing';
  state.phaseTimer = 0;
  state.stuckTimer = 0;
}

// ============================================
// 유틸
// ============================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampSpeed(obj: { vx: number; vy: number }, max: number): void {
  const s = Math.hypot(obj.vx, obj.vy);
  if (s > max) {
    const k = max / s;
    obj.vx *= k;
    obj.vy *= k;
  }
}
