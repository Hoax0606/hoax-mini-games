/**
 * 오목 보드 상태 & 판정 로직 (순수 함수만)
 *
 * 규칙 (Henry 확정):
 *   - 보드: 15×15 또는 19×19 (방 옵션)
 *   - 선공(B=호스트) / 후공(W=게스트) 번갈아
 *   - 가로/세로/대각선 **정확히 5목** 완성 시 승
 *   - **장목 금수**: 두면 6개 이상 연속되는 자리는 양쪽 모두 금수 (둘 수 없음)
 *   - 렌주룰의 3-3 / 4-4는 적용 안 함 (단순화)
 *
 * 좌표계:
 *   (x, y) — x는 column(0~size-1), y는 row(0~size-1)
 *   board[y][x] 로 접근
 *
 * mutability:
 *   성능 위해 board 배열은 mutate. "한 수 두기"는 isLegal 확인 후 외부에서 직접 `board[y][x] = stone`.
 *   checkWin / isLegal 같은 판정 함수는 board를 건드리지 않음 (순수).
 */

// ============================================
// 타입
// ============================================

export type BoardSize = 15 | 19;

/** B = 흑(호스트·선공), W = 백(게스트·후공), null = 빈칸 */
export type Stone = 'B' | 'W' | null;

export type Board = Stone[][];

export interface Move {
  x: number;
  y: number;
  stone: 'B' | 'W';
}

export interface WinInfo {
  /** 5목을 이루는 돌 5개의 좌표 (render 하이라이트용) */
  stones: Array<{ x: number; y: number }>;
  direction: 'horizontal' | 'vertical' | 'diag_down' | 'diag_up';
}

// ============================================
// 생성
// ============================================

export function createEmptyBoard(size: BoardSize): Board {
  const board: Board = [];
  for (let y = 0; y < size; y++) {
    board.push(new Array<Stone>(size).fill(null));
  }
  return board;
}

// ============================================
// 방향 탐색 유틸
// ============================================

/** 4방향 (+반대방향은 이 배열에서 생략해서 중복 카운트 방지) */
const DIRS: Array<{ dx: number; dy: number; name: WinInfo['direction'] }> = [
  { dx: 1, dy: 0,  name: 'horizontal' },
  { dx: 0, dy: 1,  name: 'vertical' },
  { dx: 1, dy: 1,  name: 'diag_down' },
  { dx: 1, dy: -1, name: 'diag_up' },
];

function inBounds(board: Board, x: number, y: number): boolean {
  return y >= 0 && y < board.length && x >= 0 && x < board.length;
}

/**
 * (x, y)에 stone이 놓여있다고 가정(또는 실제로 놓여있음)하고
 * (dx, dy) 방향 + 반대방향으로 **연속된 같은 색** 개수를 센다 (본인 포함).
 */
function countInLine(
  board: Board,
  x: number,
  y: number,
  stone: 'B' | 'W',
  dx: number,
  dy: number,
): number {
  const { len } = analyzeLine(board, x, y, stone, dx, dy);
  return len;
}

/**
 * 한 방향의 연속 길이 + 양 끝이 비어있는지(= "열린") 정보를 반환.
 * 금수(3-3, 4-4) 판정의 기본 블록.
 *
 * - `len`: (x, y) 자기 포함한 연속 같은 색 개수 (정방향+역방향 합)
 * - `openEnds`: 0/1/2 — 연속 구간 양 끝 중 몇 개가 비어있는가
 *   · 2 = "열린 N" (양쪽 다 빔 → 다음 턴에 확장 가능)
 *   · 1 = "닫힌 N" (한쪽 막힘)
 *   · 0 = 양쪽 다 막힘 (확장 불가)
 */
function analyzeLine(
  board: Board,
  x: number,
  y: number,
  stone: 'B' | 'W',
  dx: number,
  dy: number,
): { len: number; openEnds: number } {
  // 정방향으로 연속 같은 색 개수 + 그 다음 칸
  let fwd = 0;
  let fx = x + dx, fy = y + dy;
  while (inBounds(board, fx, fy) && board[fy]![fx] === stone) {
    fwd++;
    fx += dx; fy += dy;
  }
  const fwdOpen = inBounds(board, fx, fy) && board[fy]![fx] === null;

  // 역방향
  let bwd = 0;
  let bx = x - dx, by = y - dy;
  while (inBounds(board, bx, by) && board[by]![bx] === stone) {
    bwd++;
    bx -= dx; by -= dy;
  }
  const bwdOpen = inBounds(board, bx, by) && board[by]![bx] === null;

  return {
    len: fwd + 1 + bwd,
    openEnds: (fwdOpen ? 1 : 0) + (bwdOpen ? 1 : 0),
  };
}

// ============================================
// 합법성 (장목 금수)
// ============================================

/**
 * (x, y)에 stone을 둘 수 있는지.
 *
 * 금수 규칙 (Henry 확정: 렌주룰 없이, 양쪽 모두 적용):
 *   1. 장목 (6목 이상) — 정확히 5목만 승리라서 6목 이상은 무효
 *   2. 3-3 — 놓으면 "열린 3"이 두 방향 이상 생기는 수
 *      · 열린 3 = 양쪽이 비어있는 3연속 (다음 턴에 열린 4로 발전 가능)
 *   3. 4-4 — 놓으면 "4"가 두 방향 이상 생기는 수
 *      · 4 = 4연속 + 최소 한쪽 끝이 비어있음 (다음 턴에 5목 완성 위협)
 *
 * 예외: 이번 수로 **5목이 완성되면** 금수보다 승리 우선.
 *       (5가 완성되는 방향을 기준으로 3-3/4-4 체크 우회)
 *
 * 약식 판정:
 *   엄밀한 렌주룰은 "열린 3"을 재귀적으로 (다음 턴에 진짜 4가 될 수 있는지) 확인하지만,
 *   여기선 "연속 3 + 양쪽 빈칸" 단순 규칙으로 충분 — 캐주얼한 수준.
 */
export function isLegal(
  board: Board,
  x: number,
  y: number,
  stone: 'B' | 'W',
): boolean {
  if (!inBounds(board, x, y)) return false;
  if (board[y]![x] !== null) return false;

  // 방향별 분석 수집
  let threeCount = 0; // 열린 3 (openEnds=2, len=3)
  let fourCount = 0;  // 4 (openEnds>=1, len=4)
  let wouldWin = false;

  for (const { dx, dy } of DIRS) {
    const { len, openEnds } = analyzeLine(board, x, y, stone, dx, dy);
    // 정확히 5목 → 승리 수 (금수보다 우선)
    if (len === 5) {
      wouldWin = true;
    }
    // 장목 (6+) 금수
    if (len >= 6) {
      return false;
    }
    // 4-4 판정용: 4연속 + 한쪽이라도 빈칸 (연결 가능한 4)
    if (len === 4 && openEnds >= 1) {
      fourCount++;
    }
    // 3-3 판정용: 3연속 + 양쪽 다 빈칸 (열린 3)
    if (len === 3 && openEnds === 2) {
      threeCount++;
    }
  }

  // 승리 수는 금수 체크 스킵
  if (wouldWin) return true;

  if (threeCount >= 2) return false; // 3-3 금수
  if (fourCount >= 2) return false;  // 4-4 금수
  return true;
}

// ============================================
// 승리 판정
// ============================================

/**
 * 방금 (x, y)에 stone을 둔 뒤 승리했는지 판정.
 * **정확히 5목**인 경우만 승리 (6목 이상은 isLegal 단계에서 걸러짐).
 *
 * 반환: 5목 정보 (없으면 null)
 */
export function checkWin(
  board: Board,
  x: number,
  y: number,
  stone: 'B' | 'W',
): WinInfo | null {
  for (const { dx, dy, name } of DIRS) {
    const count = countInLine(board, x, y, stone, dx, dy);
    if (count === 5) {
      return {
        stones: collectLine(board, x, y, stone, dx, dy),
        direction: name,
      };
    }
  }
  return null;
}

/**
 * 5목 라인의 실제 돌 좌표 5개를 반환.
 * (x, y)에서 (dx, dy) 역방향으로 가다가 다른 색/빈칸 만나면 중단한 지점이 시작점.
 * 거기서 정방향으로 5개 수집.
 */
function collectLine(
  board: Board,
  x: number,
  y: number,
  stone: 'B' | 'W',
  dx: number,
  dy: number,
): Array<{ x: number; y: number }> {
  let sx = x, sy = y;
  while (true) {
    const nx = sx - dx;
    const ny = sy - dy;
    if (!inBounds(board, nx, ny) || board[ny]![nx] !== stone) break;
    sx = nx;
    sy = ny;
  }
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 5; i++) {
    out.push({ x: sx + dx * i, y: sy + dy * i });
  }
  return out;
}

// ============================================
// 기타
// ============================================

export function isBoardFull(board: Board): boolean {
  for (const row of board) {
    for (const cell of row) {
      if (cell === null) return false;
    }
  }
  return true;
}

/** 보드 깊은 복제 (네트워크 스냅샷/재시작용) */
export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}
