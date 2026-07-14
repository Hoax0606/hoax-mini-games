/**
 * 알까기 — 순수 상태 정의 + 보드/물리 상수
 *
 * 게임 컨셉:
 *   바둑판 모양의 정사각 보드 위에 각 플레이어 알을 배치.
 *   자기 차례에 자기 알 한 개를 마우스로 튕겨 (드래그 반대 방향 발사),
 *   다른 플레이어 알을 판 밖으로 떨어뜨림. 최후 1인 승.
 *
 * 좌표계:
 *   보드 중심이 (0, 0). 한 변 길이 BOARD_SIZE 의 정사각형.
 *   ±BOARD_HALF (= BOARD_SIZE/2) 를 넘어가면 "절벽 밖" = 알 제거.
 *
 * 시뮬레이션:
 *   - 호스트 authoritative 60Hz 시뮬레이션 + 10Hz state broadcast
 *   - 매 틱 (dt) 마다 알 위치 += 속도, 속도 *= 마찰계수
 *   - 알끼리 충돌 = 탄성 (운동량 보존, 원형 강체)
 *   - 모든 알 속도 < REST_SPEED 면 turn 종료
 */

// ============================================
// 보드 상수
// ============================================

/** 보드 한 변 길이 (논리 좌표). 정사각형 중앙이 (0, 0).
 *  canvas 세로(400)가 정사각 보드의 한계라 상하 여백 6px 만 남기고 최대치까지. */
export const BOARD_SIZE = 388;
export const BOARD_HALF = BOARD_SIZE / 2; // 194

/** 알 반지름 (논리 좌표). 보드 대비 알을 작게 해서 여유 공간 ↑
 *  (예전 12 → 10: 알 대비 보드 넓어져 한 번에 우르르 안 나가고 조준 여유) */
export const STONE_RADIUS = 10;

/** 마찰 계수 — 매 초당 속도가 (1 - FRICTION) 배로 감소.
 *  값이 클수록 빨리 멈춤. 0.85 ~ 0.95 사이가 자연스러움. */
export const FRICTION_PER_SEC = 1.6; // 초당 e^-1.6 ≈ 0.20 배로 감소

/** 이 속도 미만은 정지로 간주 (px/s) */
export const REST_SPEED = 8;

/** 알 튕길 때 최대 초기 속도 (px/s) — 드래그 거리 기반으로 클램프 */
export const MAX_FLICK_SPEED = 900;

/** 드래그 거리(px) → 속도(px/s) 변환 배수. 짧은 거리도 빠르게 튕길 수 있게. */
export const FLICK_SPEED_PER_PX = 6;

// ============================================
// 타입
// ============================================

/** 0~3. 호스트=0, 게스트들 입장 순서 = 1,2,3 */
export type PlayerIndex = 0 | 1 | 2 | 3;

export interface Stone {
  /** 보드 내 고유 ID (참조용) */
  id: number;
  /** 소유 플레이어 (0~3) */
  owner: PlayerIndex;
  /** 위치 (보드 중심 기준 px) */
  x: number;
  y: number;
  /** 속도 (px/s) */
  vx: number;
  vy: number;
  /** false 면 화면 밖으로 나갔거나 제거된 알 (렌더/충돌 모두 skip) */
  alive: boolean;
}

export interface PlayerMeta {
  /** PeerJS peerId. 호스트는 자기 myPeerId */
  peerId: string;
  nickname: string;
  index: PlayerIndex;
  /** 살아있는 알 수 = stones.filter(s => s.owner===idx && s.alive).length */
  liveCount: number;
}

export type GamePhase =
  /** 누가 알 튕기는 입력 받는 단계 */
  | 'aiming'
  /** 알들이 움직이는 시뮬레이션 단계 (모두 멈출 때까지) */
  | 'resolving'
  /** 게임 종료 */
  | 'ended';

export interface AlgagiGame {
  /** 현재 차례인 플레이어 인덱스. 'ended' 면 무의미 */
  currentTurn: PlayerIndex;
  /** 0=대기, 1=알 튕긴 후 시뮬레이션 진행 중 */
  phase: GamePhase;
  /** 보드 위 모든 알 (제거된 알도 alive=false 로 보존 — 인덱스 안정성) */
  stones: Stone[];
  /** 참가자 메타 — index 순으로 정렬 */
  players: PlayerMeta[];
  /** 누적 턴 수 (통계용) */
  turnCount: number;
  /** 게임 종료 시 우승자 peerId. 무승부 (전원 동시 제거) 면 null */
  winnerPeerId: string | null;
}

// ============================================
// 초기 배치
// ============================================

/**
 * 인원수 별 알 개수.
 *  - 2인: 5개씩 (상/하 한 줄)
 *  - 3인: 4개씩 (위/좌/우 변)
 *  - 4인: 4개씩 (상/하/좌/우 변)
 */
export function getStoneCountPerPlayer(playerCount: 2 | 3 | 4): number {
  return playerCount === 2 ? 5 : 4;
}

/**
 * 초기 알 배치 좌표 (보드 중심 기준).
 *
 * 배치 전략:
 *   2인: P0 = 하단 가로 한 줄, P1 = 상단 가로 한 줄
 *   3인: P0 = 하단, P1 = 좌측, P2 = 우측 (삼각 배치)
 *   4인: P0 = 하단, P1 = 좌측, P2 = 상단, P3 = 우측 (시계 반대 방향)
 *
 * 절벽까지 약 30px 여유. 한 줄에 5개면 간격 (BOARD_SIZE - 60) / 4 ≈ 75px.
 */
export function initialStonePositions(
  playerCount: 2 | 3 | 4,
): Array<{ owner: PlayerIndex; x: number; y: number }> {
  const stonesPerPlayer = getStoneCountPerPlayer(playerCount);
  const out: Array<{ owner: PlayerIndex; x: number; y: number }> = [];

  // 변(edge) 위에 알을 일렬로 배치할 때, 절벽으로부터 마진
  const EDGE_MARGIN = 36;
  // 변을 따라 늘어놓을 때 모서리(코너)에서 떨어뜨리는 마진.
  //   EDGE_MARGIN 만 쓰면 3·4인에서 인접한 두 변의 끝 알이 같은 코너 좌표에 겹쳐
  //   "내 알이 몇 개 안 보이다가 첫 충돌 후 분리되며 나타나는" 버그가 났음.
  //   알 지름(STONE_RADIUS*2=24)보다 충분히 크게 잡아 코너 충돌을 원천 차단.
  const CORNER_MARGIN = 64;
  const lineSpan = BOARD_SIZE - CORNER_MARGIN * 2;
  const gap = lineSpan / (stonesPerPlayer - 1);

  /** 한 변 위에 stonesPerPlayer 개를 일렬로 — edgeAxis: 'h'(가로) | 'v'(세로),
   *  edgePos: 변 자체의 좌표 (가로 변이면 y, 세로 변이면 x) */
  const layEdge = (
    owner: PlayerIndex,
    edgeAxis: 'h' | 'v',
    edgePos: number,
  ): void => {
    for (let i = 0; i < stonesPerPlayer; i++) {
      const along = -BOARD_HALF + CORNER_MARGIN + gap * i;
      if (edgeAxis === 'h') {
        out.push({ owner, x: along, y: edgePos });
      } else {
        out.push({ owner, x: edgePos, y: along });
      }
    }
  };

  if (playerCount === 2) {
    layEdge(0, 'h',  BOARD_HALF - EDGE_MARGIN); // 하단
    layEdge(1, 'h', -BOARD_HALF + EDGE_MARGIN); // 상단
  } else if (playerCount === 3) {
    layEdge(0, 'h',  BOARD_HALF - EDGE_MARGIN); // 하단
    layEdge(1, 'v', -BOARD_HALF + EDGE_MARGIN); // 좌측
    layEdge(2, 'v',  BOARD_HALF - EDGE_MARGIN); // 우측
  } else {
    layEdge(0, 'h',  BOARD_HALF - EDGE_MARGIN); // 하단
    layEdge(1, 'v', -BOARD_HALF + EDGE_MARGIN); // 좌측
    layEdge(2, 'h', -BOARD_HALF + EDGE_MARGIN); // 상단
    layEdge(3, 'v',  BOARD_HALF - EDGE_MARGIN); // 우측
  }

  return out;
}

/** 새 게임 시작 시 호출 — players 메타와 초기 stones 채워 반환. */
export function createInitialGame(
  players: Array<{ peerId: string; nickname: string }>,
): AlgagiGame {
  const playerCount = players.length;
  if (playerCount < 2 || playerCount > 4) {
    throw new Error(`알까기는 2~4인만 지원해요 (현재 ${playerCount}인)`);
  }
  const pc = playerCount as 2 | 3 | 4;

  const positions = initialStonePositions(pc);
  const stones: Stone[] = positions.map((p, i) => ({
    id: i,
    owner: p.owner,
    x: p.x,
    y: p.y,
    vx: 0,
    vy: 0,
    alive: true,
  }));

  const stonesPerPlayer = getStoneCountPerPlayer(pc);
  const playerMetas: PlayerMeta[] = players.map((p, idx) => ({
    peerId: p.peerId,
    nickname: p.nickname,
    index: idx as PlayerIndex,
    liveCount: stonesPerPlayer,
  }));

  return {
    currentTurn: 0,
    phase: 'aiming',
    stones,
    players: playerMetas,
    turnCount: 0,
    winnerPeerId: null,
  };
}

// ============================================
// 턴 / 승패 판정
// ============================================

/** 살아있는(알 ≥ 1) 플레이어 인덱스 목록 — turn 순서 결정용 */
export function getAlivePlayerIndices(game: AlgagiGame): PlayerIndex[] {
  return game.players
    .filter((p) => p.liveCount > 0)
    .map((p) => p.index);
}

/**
 * 다음 턴 플레이어 — 현재 좌석 "다음 위치"부터 한 바퀴 돌며 처음 살아있는 사람.
 * 현재 플레이어가 자기 마지막 알을 없애 사망해도(과거 alive.indexOf(-1)→0 으로
 * 최저 인덱스로 점프해 뒤 사람을 건너뛰던 버그) 좌석 순서를 유지한다.
 */
export function getNextTurn(game: AlgagiGame): PlayerIndex {
  const n = game.players.length;
  if (n === 0) return 0;
  for (let step = 1; step <= n; step++) {
    const cand = ((game.currentTurn + step) % n) as PlayerIndex;
    const p = game.players.find((pp) => pp.index === cand);
    if (p && p.liveCount > 0) return cand;
  }
  return game.currentTurn; // 살아있는 사람 없음(이론상 무승부) — 호출부에서 종료 판정
}

/**
 * 시뮬레이션이 끝나는 시점(모든 알 정지)에 호출.
 * 떨어진 알 alive=false 처리 + liveCount 갱신 + 승패 판정 + 다음 턴 진행.
 *
 * 반환값: 게임이 이 호출에서 종료됐는지 (= phase === 'ended')
 */
export function resolveTurnEnd(game: AlgagiGame): boolean {
  // 절벽 밖 알 제거
  for (const s of game.stones) {
    if (!s.alive) continue;
    if (
      s.x < -BOARD_HALF || s.x > BOARD_HALF ||
      s.y < -BOARD_HALF || s.y > BOARD_HALF
    ) {
      s.alive = false;
    }
  }

  // liveCount 재계산
  for (const p of game.players) {
    p.liveCount = game.stones.filter((s) => s.alive && s.owner === p.index).length;
  }

  // 승패 판정
  const survivors = game.players.filter((p) => p.liveCount > 0);
  if (survivors.length === 0) {
    // 동시 다 떨어짐 — 무승부
    game.phase = 'ended';
    game.winnerPeerId = null;
    return true;
  }
  if (survivors.length === 1) {
    game.phase = 'ended';
    game.winnerPeerId = survivors[0]!.peerId;
    return true;
  }

  // 게임 계속 — 다음 턴
  game.currentTurn = getNextTurn(game);
  game.phase = 'aiming';
  game.turnCount++;
  return false;
}
