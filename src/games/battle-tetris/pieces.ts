/**
 * 7 테트로미노 정의 + SRS 회전 시스템 + 7-bag 랜덤
 *
 * ── 좌표계 ──
 *   필드: field[row][col], row 0이 맨 위(스폰 지점), row 19가 맨 아래.
 *   piece.x = col, piece.y = row. 아래로 갈수록 y 증가.
 *   shape는 4x4 비트맵: shape[r][c]이 1이면 그 위치에 블록 있음.
 *
 * ── SRS (Super Rotation System) 간단 설명 ──
 *   현대 테트리스 표준 회전. 회전 시 기본 자리가 막혀 있으면
 *   wall-kick 테이블의 대안 offset을 순서대로 시도해 통하는 곳으로 살짝 밀며 회전한다.
 *   덕분에 벽이나 블록에 붙은 상태에서도 회전이 잘 되고 T-spin 같은 고급기가 가능해짐.
 *
 *   rotation 상태:
 *     0 = 스폰 (기본), 1 = R (시계방향 한 번), 2 = 180도, 3 = L (반시계 한 번)
 *
 *   SRS 위키(tetris.wiki)의 kick offset은 "+y = up" 관습.
 *   이 코드는 +y = down이라 적용 시 dy 부호를 뒤집는다 (piece.y - dy).
 */

// ============================================
// 타입
// ============================================

export type PieceId = 'I' | 'O' | 'T' | 'L' | 'J' | 'S' | 'Z';
export type Rotation = 0 | 1 | 2 | 3;

/** 4x4 bitmap. 1 = 블록, 0 = 빈칸 */
export type Shape = ReadonlyArray<ReadonlyArray<0 | 1>>;

export interface PieceDef {
  id: PieceId;
  color: string;
  stroke: string;
  /** 0 / R / 2 / L 네 회전 상태의 shape */
  shapes: readonly [Shape, Shape, Shape, Shape];
}

/** 현재 놓여있는 피스의 인스턴스 */
export interface PieceState {
  id: PieceId;
  /** 좌상단 col (shape[0][0]의 x 좌표) */
  x: number;
  /** 좌상단 row (shape[0][0]의 y 좌표) */
  y: number;
  rotation: Rotation;
}

// ============================================
// 색상 팔레트 (파스텔, 에어하키와 통일)
// ============================================

const COLORS: Record<PieceId, { fill: string; stroke: string }> = {
  I: { fill: '#86d4ee', stroke: '#5dafd2' }, // 시안
  O: { fill: '#ffd876', stroke: '#c9a01f' }, // 노랑
  T: { fill: '#b89aff', stroke: '#9c7aeb' }, // 라벤더
  L: { fill: '#ffb386', stroke: '#e08047' }, // 오렌지
  J: { fill: '#86a5ee', stroke: '#5a7fd1' }, // 파랑
  S: { fill: '#86e8c4', stroke: '#5dc9a7' }, // 민트
  Z: { fill: '#ff82ac', stroke: '#ff5a92' }, // 핑크
};

// ============================================
// 테트로미노 모양 (4x4, 각 회전 상태)
// ============================================

/** Shape 리터럴을 짧게 쓰기 위한 헬퍼 (가독성) */
const _ = 0, X = 1;

/** I 피스 — SRS 표준: 4x4 내 위치 */
const I_SHAPES: readonly [Shape, Shape, Shape, Shape] = [
  // 0 (스폰): 가로 한 줄
  [[_, _, _, _], [X, X, X, X], [_, _, _, _], [_, _, _, _]],
  // R (CW): 세로 한 줄 (오른쪽)
  [[_, _, X, _], [_, _, X, _], [_, _, X, _], [_, _, X, _]],
  // 2
  [[_, _, _, _], [_, _, _, _], [X, X, X, X], [_, _, _, _]],
  // L (CCW): 세로 한 줄 (왼쪽)
  [[_, X, _, _], [_, X, _, _], [_, X, _, _], [_, X, _, _]],
];

/** O 피스 — 회전해도 모양 같음 */
const O_SHAPES: readonly [Shape, Shape, Shape, Shape] = [
  [[_, X, X, _], [_, X, X, _], [_, _, _, _], [_, _, _, _]],
  [[_, X, X, _], [_, X, X, _], [_, _, _, _], [_, _, _, _]],
  [[_, X, X, _], [_, X, X, _], [_, _, _, _], [_, _, _, _]],
  [[_, X, X, _], [_, X, X, _], [_, _, _, _], [_, _, _, _]],
];

const T_SHAPES: readonly [Shape, Shape, Shape, Shape] = [
  [[_, X, _, _], [X, X, X, _], [_, _, _, _], [_, _, _, _]],
  [[_, X, _, _], [_, X, X, _], [_, X, _, _], [_, _, _, _]],
  [[_, _, _, _], [X, X, X, _], [_, X, _, _], [_, _, _, _]],
  [[_, X, _, _], [X, X, _, _], [_, X, _, _], [_, _, _, _]],
];

const L_SHAPES: readonly [Shape, Shape, Shape, Shape] = [
  [[_, _, X, _], [X, X, X, _], [_, _, _, _], [_, _, _, _]],
  [[_, X, _, _], [_, X, _, _], [_, X, X, _], [_, _, _, _]],
  [[_, _, _, _], [X, X, X, _], [X, _, _, _], [_, _, _, _]],
  [[X, X, _, _], [_, X, _, _], [_, X, _, _], [_, _, _, _]],
];

const J_SHAPES: readonly [Shape, Shape, Shape, Shape] = [
  [[X, _, _, _], [X, X, X, _], [_, _, _, _], [_, _, _, _]],
  [[_, X, X, _], [_, X, _, _], [_, X, _, _], [_, _, _, _]],
  [[_, _, _, _], [X, X, X, _], [_, _, X, _], [_, _, _, _]],
  [[_, X, _, _], [_, X, _, _], [X, X, _, _], [_, _, _, _]],
];

const S_SHAPES: readonly [Shape, Shape, Shape, Shape] = [
  [[_, X, X, _], [X, X, _, _], [_, _, _, _], [_, _, _, _]],
  [[_, X, _, _], [_, X, X, _], [_, _, X, _], [_, _, _, _]],
  [[_, _, _, _], [_, X, X, _], [X, X, _, _], [_, _, _, _]],
  [[X, _, _, _], [X, X, _, _], [_, X, _, _], [_, _, _, _]],
];

const Z_SHAPES: readonly [Shape, Shape, Shape, Shape] = [
  [[X, X, _, _], [_, X, X, _], [_, _, _, _], [_, _, _, _]],
  [[_, _, X, _], [_, X, X, _], [_, X, _, _], [_, _, _, _]],
  [[_, _, _, _], [X, X, _, _], [_, X, X, _], [_, _, _, _]],
  [[_, X, _, _], [X, X, _, _], [X, _, _, _], [_, _, _, _]],
];

// ============================================
// 최종 PieceDef 테이블
// ============================================

export const PIECES: Record<PieceId, PieceDef> = {
  I: { id: 'I', color: COLORS.I.fill, stroke: COLORS.I.stroke, shapes: I_SHAPES },
  O: { id: 'O', color: COLORS.O.fill, stroke: COLORS.O.stroke, shapes: O_SHAPES },
  T: { id: 'T', color: COLORS.T.fill, stroke: COLORS.T.stroke, shapes: T_SHAPES },
  L: { id: 'L', color: COLORS.L.fill, stroke: COLORS.L.stroke, shapes: L_SHAPES },
  J: { id: 'J', color: COLORS.J.fill, stroke: COLORS.J.stroke, shapes: J_SHAPES },
  S: { id: 'S', color: COLORS.S.fill, stroke: COLORS.S.stroke, shapes: S_SHAPES },
  Z: { id: 'Z', color: COLORS.Z.fill, stroke: COLORS.Z.stroke, shapes: Z_SHAPES },
};

export const ALL_PIECE_IDS: readonly PieceId[] = ['I', 'O', 'T', 'L', 'J', 'S', 'Z'];

// ============================================
// SRS Wall-Kick 테이블
// ============================================
// 각 offset은 [dx, dy] 튜플. +dx = 오른쪽, +dy = 위 (SRS 위키 convention).
// 실제 적용 시 piece.y에는 **-dy**를 더한다 (이 코드의 y+ = down이라).
// 키 포맷: "from->to" (예: "0->1" = 0에서 R로 시계회전)

type Kick = readonly [number, number];
type KickSet = readonly Kick[];

/** J / L / S / T / Z 공용 SRS 킥 테이블 */
const KICKS_JLSTZ: Record<string, KickSet> = {
  '0->1': [[0, 0], [-1, 0], [-1, +1], [0, -2], [-1, -2]],
  '1->0': [[0, 0], [+1, 0], [+1, -1], [0, +2], [+1, +2]],
  '1->2': [[0, 0], [+1, 0], [+1, -1], [0, +2], [+1, +2]],
  '2->1': [[0, 0], [-1, 0], [-1, +1], [0, -2], [-1, -2]],
  '2->3': [[0, 0], [+1, 0], [+1, +1], [0, -2], [+1, -2]],
  '3->2': [[0, 0], [-1, 0], [-1, -1], [0, +2], [-1, +2]],
  '3->0': [[0, 0], [-1, 0], [-1, -1], [0, +2], [-1, +2]],
  '0->3': [[0, 0], [+1, 0], [+1, +1], [0, -2], [+1, -2]],
};

/** I 피스 전용 SRS 킥 테이블 (길이 4라 특수함) */
const KICKS_I: Record<string, KickSet> = {
  '0->1': [[0, 0], [-2, 0], [+1, 0], [-2, -1], [+1, +2]],
  '1->0': [[0, 0], [+2, 0], [-1, 0], [+2, +1], [-1, -2]],
  '1->2': [[0, 0], [-1, 0], [+2, 0], [-1, +2], [+2, -1]],
  '2->1': [[0, 0], [+1, 0], [-2, 0], [+1, -2], [-2, +1]],
  '2->3': [[0, 0], [+2, 0], [-1, 0], [+2, +1], [-1, -2]],
  '3->2': [[0, 0], [-2, 0], [+1, 0], [-2, -1], [+1, +2]],
  '3->0': [[0, 0], [+1, 0], [-2, 0], [+1, -2], [-2, +1]],
  '0->3': [[0, 0], [-1, 0], [+2, 0], [-1, +2], [+2, -1]],
};

/** O 피스는 회전해도 모양 동일 → kick 불필요 (제자리 회전만) */
const KICKS_O: KickSet = [[0, 0]];

/**
 * 특정 피스의 회전 시 wall-kick offset 목록 반환.
 * engine이 이 순서대로 시도해서 첫 번째로 통과하는 위치로 이동.
 */
export function getKicks(pieceId: PieceId, from: Rotation, to: Rotation): KickSet {
  if (pieceId === 'O') return KICKS_O;
  const key = `${from}->${to}`;
  if (pieceId === 'I') return KICKS_I[key] ?? [[0, 0]];
  return KICKS_JLSTZ[key] ?? [[0, 0]];
}

// ============================================
// 7-bag 랜덤 생성기
// ============================================

/**
 * "7-bag" 랜덤: I/O/T/L/J/S/Z 각 1개씩 셔플된 가방에서 하나씩 꺼냄.
 * 가방이 비면 새 가방(새 셔플)으로 채움. 덕분에 같은 피스가 14번 연속 나오는 일이 없고
 * 14개마다 7종 각각 2번씩 나와서 공정함.
 *
 * 각 플레이어가 로컬로 실행 → seed 공유 없음 (자기 순서는 자기만 알면 됨)
 */
export class PieceBag {
  private queue: PieceId[] = [];

  /** 다음 피스를 꺼냄 (큐에서 제거) */
  next(): PieceId {
    this.ensure(1);
    return this.queue.shift()!;
  }

  /** 큐 앞부분을 count개만큼 미리보기 (제거하지 않음). 넥스트 프리뷰용. */
  peek(count: number): PieceId[] {
    this.ensure(count);
    return this.queue.slice(0, count);
  }

  /** 큐 길이가 최소 need가 되도록 새 가방을 뒤에 붙임 */
  private ensure(need: number): void {
    while (this.queue.length < need) {
      const fresh: PieceId[] = ['I', 'O', 'T', 'L', 'J', 'S', 'Z'];
      shuffleInPlace(fresh);
      this.queue.push(...fresh);
    }
  }
}

/** Fisher-Yates in-place shuffle */
function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

// ============================================
// 유틸 — shape 순회
// ============================================

/**
 * shape 내의 실제 블록이 있는 셀들을 순회.
 * callback(dx, dy): shape 좌상단 기준 offset.
 */
export function forEachMino(
  shape: Shape,
  callback: (dx: number, dy: number) => void,
): void {
  for (let r = 0; r < shape.length; r++) {
    const row = shape[r]!;
    for (let c = 0; c < row.length; c++) {
      if (row[c] === 1) callback(c, r);
    }
  }
}

/** 피스 스폰 위치 (표준 SRS: 중앙 상단)
 *
 * y = -1 로 스폰하는 이유 (버그 수정):
 *   대부분의 피스 shape는 row 0에 블록이 있어서, y=0 스폰이면
 *   필드 맨 위 한 줄이라도 차 있으면 즉시 탑아웃 됐다. 현대 테트리스 가이드라인은
 *   상단 hidden buffer 2줄에서 스폰하는데, 여기선 간단히 y=-1로 해서
 *   shape row 0의 블록은 field row -1(범위 밖)에 위치 → collides()의
 *   "row < 0 은 허용" 규칙 덕에 충돌 검사를 통과한다. 첫 프레임엔 살짝
 *   걸쳐 보이다가 중력으로 자연스럽게 내려오면서 다 보임.
 */
export function spawnPosition(pieceId: PieceId): PieceState {
  // 모든 피스 x=3 (4x4 shape 좌상단 기준 → col 3~6, 10열 필드의 중앙).
  // O는 shape이 [_,X,X,_]이라 실제 블록은 col 4,5열에 떨어짐.
  return { id: pieceId, x: 3, y: -1, rotation: 0 };
}
