/**
 * 사과 게임 보드 — 10×17 격자
 *
 * 좌표계:
 *   board[row][col], row 0 = 맨 위, col 0 = 맨 왼쪽.
 *   각 셀은 1~9 숫자이거나 null (제거된 빈칸).
 *
 * mutability:
 *   성능·간결성 위해 mutable. tryClear 는 성공 시 원본 보드를 직접 수정한다.
 *
 * 왜 "중력 없음"?
 *   원형 사과 게임(Fruit Box) 규칙대로. 터진 자리는 빈 칸으로 남고 위 사과는 내려오지 않는다.
 *   덕분에 빈 칸을 경계로 삼아 합 10 묶음을 만드는 전략이 생긴다.
 */

import { createRng, randInt } from './rng';

export const BOARD_COLS = 17;
export const BOARD_ROWS = 10;
export const TOTAL_CELLS = BOARD_COLS * BOARD_ROWS; // 170 — 만점 상한

/** 한 칸. 1~9 숫자이거나 null(빈칸). */
export type Cell = number | null;
export type Board = Cell[][]; // [row][col]

// ============================================
// 생성
// ============================================

/**
 * 시드로 결정적인 보드 생성. 모든 플레이어가 같은 seed 를 받으면 동일한 보드가 나온다.
 *
 * MVP: 단순 랜덤 1~9. 이 보드가 "반드시 전부 클리어 가능한가" 는 보장하지 않는다.
 *   친구들끼리 테스트하면서 "보드가 너무 안 풀려" 피드백 나오면 그때 solvable 보장 알고리즘으로 개선.
 */
export function createBoard(seed: number): Board {
  const rng = createRng(seed);
  const board: Board = [];
  for (let r = 0; r < BOARD_ROWS; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < BOARD_COLS; c++) {
      row.push(randInt(rng, 9) + 1); // 1~9
    }
    board.push(row);
  }
  return board;
}

// ============================================
// 영역 합산 / 제거
// ============================================

/** 두 격자 좌표를 감싸는 직사각형 영역. 내부에서 정렬해 lo/hi 로 정리. */
export interface Rect {
  rLo: number;
  rHi: number;
  cLo: number;
  cHi: number;
}

/** 격자 좌표 두 개(드래그 시작/끝) 를 rect 로 정규화 + 보드 범위로 클램프. */
export function normalizeRect(r1: number, c1: number, r2: number, c2: number): Rect {
  const rLo = clamp(Math.min(r1, r2), 0, BOARD_ROWS - 1);
  const rHi = clamp(Math.max(r1, r2), 0, BOARD_ROWS - 1);
  const cLo = clamp(Math.min(c1, c2), 0, BOARD_COLS - 1);
  const cHi = clamp(Math.max(c1, c2), 0, BOARD_COLS - 1);
  return { rLo, rHi, cLo, cHi };
}

/** 영역 내 남아있는 사과들의 합 + 개수 (UI 힌트용 — 드래그 중 합 표시) */
export function sumRect(board: Board, rect: Rect): { sum: number; count: number } {
  let sum = 0;
  let count = 0;
  for (let r = rect.rLo; r <= rect.rHi; r++) {
    for (let c = rect.cLo; c <= rect.cHi; c++) {
      const v = board[r]![c];
      if (v !== null) {
        sum += v;
        count++;
      }
    }
  }
  return { sum, count };
}

/**
 * 드래그 영역을 확정했을 때 호출.
 * 합이 정확히 10 이고 사과 1개 이상이면 해당 칸들을 null 로 만들고 제거 수 반환.
 * 조건 안 맞으면 보드 변경 없이 0.
 */
export function tryClear(board: Board, rect: Rect): number {
  const { sum, count } = sumRect(board, rect);
  if (count === 0 || sum !== 10) return 0;

  for (let r = rect.rLo; r <= rect.rHi; r++) {
    for (let c = rect.cLo; c <= rect.cHi; c++) {
      board[r]![c] = null;
    }
  }
  return count;
}

// ============================================
// 유틸
// ============================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
