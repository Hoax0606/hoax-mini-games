/**
 * 배틀 테트리스 필드 (10×20 그리드) + 충돌/라인 클리어/가비지 주입
 *
 * 좌표계:
 *   field[row][col], row 0이 맨 위 (스폰 지점), row 19가 맨 아래.
 *   Cell은 null(빈칸), PieceId(피스에서 온 블록), 'G'(가비지)
 *
 * mutability:
 *   성능 + 간결성을 위해 mutable 설계. 외부에서 스냅샷이 필요하면 JSON 복제.
 */

import { PIECES, forEachMino, type PieceId, type PieceState } from './pieces';

export const FIELD_WIDTH = 10;
export const FIELD_HEIGHT = 20;

/** 한 칸. null=빈칸, PieceId=고정된 피스 블록, 'G'=가비지(공격으로 받은) 블록 */
export type Cell = PieceId | 'G' | null;
export type Field = Cell[][];

// ============================================
// 생성
// ============================================

export function createEmptyField(): Field {
  const field: Field = [];
  for (let r = 0; r < FIELD_HEIGHT; r++) {
    field.push(newEmptyRow());
  }
  return field;
}

function newEmptyRow(): Cell[] {
  return new Array<Cell>(FIELD_WIDTH).fill(null);
}

// ============================================
// 충돌 판정
// ============================================

/**
 * 피스를 현재 필드에 두면 충돌하는지.
 * - 필드 밖으로 나가는 경우 (좌우/아래)
 * - 기존 블록과 겹치는 경우
 *
 * 위쪽(row < 0)은 스폰 직후 4x4 shape의 빈 row에서 발생할 수 있으므로 충돌로 안 친다.
 */
export function collides(field: Field, piece: PieceState): boolean {
  const shape = PIECES[piece.id].shapes[piece.rotation];
  let hit = false;
  forEachMino(shape, (dx, dy) => {
    if (hit) return;
    const col = piece.x + dx;
    const row = piece.y + dy;
    // 위쪽은 허용 (spawn 전 invisible 영역)
    if (row < 0) return;
    // 좌우 벽 / 바닥 / 기존 블록
    if (col < 0 || col >= FIELD_WIDTH || row >= FIELD_HEIGHT) {
      hit = true;
      return;
    }
    if (field[row]![col] !== null) {
      hit = true;
    }
  });
  return hit;
}

// ============================================
// 피스 고정 (lock) — shape의 각 블록을 필드에 새김
// ============================================

export function placePiece(field: Field, piece: PieceState): void {
  const shape = PIECES[piece.id].shapes[piece.rotation];
  forEachMino(shape, (dx, dy) => {
    const col = piece.x + dx;
    const row = piece.y + dy;
    if (row >= 0 && row < FIELD_HEIGHT && col >= 0 && col < FIELD_WIDTH) {
      field[row]![col] = piece.id;
    }
  });
}

// ============================================
// 라인 클리어 — 가득 찬 row 제거, 위 row들이 내려옴
// ============================================

/**
 * 가득 찬 라인을 모두 제거하고 상단에 빈 라인 채움.
 * 반환값: 제거된 라인 수 (공격 가비지 산출용)
 */
export function clearFullLines(field: Field): number {
  // 가득 차지 않은(=하나라도 null 있는) row만 살린다
  const survivors = field.filter((row) => row.some((cell) => cell === null));
  const cleared = FIELD_HEIGHT - survivors.length;
  if (cleared === 0) return 0;

  // 위쪽에 빈 row 추가해서 높이 맞춤
  const padded: Field = [];
  for (let i = 0; i < cleared; i++) padded.push(newEmptyRow());
  padded.push(...survivors);

  // 원본 필드 교체 (참조 유지 — mutate)
  for (let i = 0; i < FIELD_HEIGHT; i++) {
    field[i] = padded[i]!;
  }
  return cleared;
}

// ============================================
// 가비지 주입 — 아래에 N개 방해 라인 삽입 (위 블록은 N칸 위로 밀림)
// ============================================

/**
 * 하단에 count개의 가비지 라인을 삽입. 각 라인은 랜덤 위치에 구멍 1칸.
 * 연속 가비지는 같은 구멍 위치를 공유하면 더 전략적이지만, 여기선 라인마다 독립 랜덤.
 *
 * 반환값: "탑아웃" 여부 (맨 위 라인에 블록이 있었는데 더 위로 밀려나간 경우).
 *
 * 주의: 이 함수는 현재 떠 있는 피스(currentPiece)는 건드리지 않는다.
 *   엔진에서 가비지 주입 전후로 피스 y 좌표 조정 + collides 재검증 필요.
 */
export function injectGarbage(field: Field, count: number): boolean {
  if (count <= 0) return false;

  let toppedOut = false;

  for (let i = 0; i < count; i++) {
    // 제일 위 행이 사라지면서(=위로 밀려나감) 이미 블록이 있었다면 탑아웃
    const topRow = field.shift();
    if (topRow && topRow.some((cell) => cell !== null)) {
      toppedOut = true;
    }
    // 가비지 row 생성 (구멍 1칸 랜덤)
    const holeCol = Math.floor(Math.random() * FIELD_WIDTH);
    const garbageRow: Cell[] = [];
    for (let c = 0; c < FIELD_WIDTH; c++) {
      garbageRow.push(c === holeCol ? null : 'G');
    }
    field.push(garbageRow);
  }

  return toppedOut;
}

// ============================================
// 유틸
// ============================================

/** 피스의 "하드 드롭" 후 착지 y 좌표 계산 (고스트 피스용) */
export function dropDistance(field: Field, piece: PieceState): number {
  let dy = 0;
  while (!collides(field, { ...piece, y: piece.y + dy + 1 })) {
    dy++;
  }
  return dy;
}

/** 필드 깊은 복제 (네트워크 전송 스냅샷용) */
export function cloneField(field: Field): Field {
  return field.map((row) => row.slice());
}
