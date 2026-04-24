/**
 * 오목 Canvas 렌더러
 *
 * 레이아웃 (800×400 논리 좌표):
 *   ┌──────────────┬──────────────────┬──────────────┐
 *   │              │                  │              │
 *   │ [흑돌 아이콘]│                  │ [백돌 아이콘]│
 *   │  호스트닉네임│   보드 360×360   │  게스트닉네임│
 *   │              │   (격자+돌)       │              │
 *   │  ⏱ 30 (링)  │                  │  ⏱ 30 (링)  │
 *   │              │                  │              │
 *   │  "내 차례"   │                  │              │
 *   │              │                  │              │
 *   └──────────────┴──────────────────┴──────────────┘
 *
 * 15×15 와 19×19 모두 지원 — getLayout(size) 가 cell 크기/여백을 계산.
 */

import type { Board, BoardSize, Stone, WinInfo } from './board';

// ============================================
// 레이아웃 상수
// ============================================

const CANVAS_W = 800;
const CANVAS_H = 400;

/** 보드 프레임 — 중앙 정사각 360×360 */
const FRAME_X = 220;
const FRAME_Y = 20;
const FRAME_SIZE = 360;

/** 플레이어 카드 */
const CARD_W = 170;
const CARD_H = 260;
const CARD_Y = 70;
const CARD_LEFT_X = 25;
const CARD_RIGHT_X = CANVAS_W - CARD_LEFT_X - CARD_W; // 605

/** 별점 (화점) 교차점 좌표 — 표준 바둑판 규약 */
const STAR_POINTS_15: ReadonlyArray<[number, number]> = [
  [3, 3], [3, 7], [3, 11],
  [7, 3], [7, 7], [7, 11],
  [11, 3], [11, 7], [11, 11],
];
const STAR_POINTS_19: ReadonlyArray<[number, number]> = [
  [3, 3], [3, 9], [3, 15],
  [9, 3], [9, 9], [9, 15],
  [15, 3], [15, 9], [15, 15],
];

const COLORS = {
  bg: '#fff9fd',
  boardFill: '#fff9e8',
  boardBorder: '#d9c7ff',
  gridLine: '#c4b4d8',
  starPoint: '#9c7aeb',

  blackStone: '#3a2a3a',
  blackStroke: '#1a0a1a',
  whiteStone: '#fafaf5',   // 거의 흰색, 아주 살짝 따뜻 (실제 바둑알 백돌 느낌)
  whiteStroke: '#a89c86',  // 회색-카키 톤 (기존 노란 테두리 완화)

  lastMoveRing: '#ff5a92',
  winGlow: 'rgba(255, 90, 146, 0.45)',

  cardBg: '#faf5ff',
  cardBgActive: '#fff3c5',
  cardBorder: '#d9c7ff',
  cardBorderActive: '#c9a01f',

  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',

  timerRing: '#9c7aeb',
  timerWarning: '#ff5a92',
  timerTrack: '#e5d9ff',

  overlayBg: 'rgba(255, 255, 255, 0.75)',
  overlayTitle: '#4a3a4a',
} as const;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

// ============================================
// 보드 좌표 변환
// ============================================

function getLayout(size: BoardSize): {
  offsetX: number;
  offsetY: number;
  cell: number;
  stoneR: number;
} {
  // 15×15면 cell=22 (14간격×22=308), 19×19면 cell=18 (18간격×18=324). 프레임 360 안에 중앙 정렬.
  const cell = size === 15 ? 22 : 18;
  const stoneR = size === 15 ? 9.5 : 7.5;
  const gridPx = cell * (size - 1);
  const offsetX = FRAME_X + (FRAME_SIZE - gridPx) / 2;
  const offsetY = FRAME_Y + (FRAME_SIZE - gridPx) / 2;
  return { offsetX, offsetY, cell, stoneR };
}

/** 교차점 (x, y) → 픽셀 (px, py) */
function cellToPixel(x: number, y: number, layout: ReturnType<typeof getLayout>): { px: number; py: number } {
  return {
    px: layout.offsetX + x * layout.cell,
    py: layout.offsetY + y * layout.cell,
  };
}

// ============================================
// Renderer
// ============================================

export interface RenderState {
  board: Board;
  boardSize: BoardSize;
  /** 현재 둘 차례 */
  currentTurn: 'B' | 'W';
  /** 내가 두는 색 — 관전자면 null */
  mySide: 'B' | 'W' | null;
  /** 마지막 놓인 수 (없으면 null) */
  lastMove: { x: number; y: number } | null;
  /** 승리 라인 정보 (결정됐을 때) */
  winInfo: WinInfo | null;
  /** 현재 마우스 hover 교차점 — 내 차례 + 빈칸 + 합법일 때만 넣음 */
  hoverCell: { x: number; y: number; legal: boolean } | null;
  /** 타이머 (남은 초) — 현재 차례 쪽에만 적용 */
  timerSeconds: number;
  /** 타이머 비율 (0~1, 1=가득) */
  timerRatio: number;

  hostNickname: string;
  guestNickname: string;
  myRole: 'host' | 'guest' | 'spectator';

  /** 게임 종료 정보 (승리 / 타임아웃 / 무승부) */
  gameOver: {
    winner: 'B' | 'W' | null; // null = 무승부
    reason: 'five' | 'timeout' | 'draw' | 'resign';
  } | null;
}

export interface GomokuRendererArgs {
  canvas: HTMLCanvasElement;
}

export class GomokuRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;

  constructor(args: GomokuRendererArgs) {
    this.canvas = args.canvas;
    const ctx = args.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 컨텍스트를 가져올 수 없어요');
    this.ctx = ctx;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
  }

  destroy(): void {
    this.ro.disconnect();
  }

  /**
   * 마우스 이벤트의 캔버스 내 픽셀 좌표 → 가장 가까운 교차점 (x, y).
   * 교차점과의 거리가 cell의 40% 이상이면 null (오클릭 방지).
   */
  canvasToCell(
    canvasPx: number,
    canvasPy: number,
    boardSize: BoardSize,
  ): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // 캔버스 → 논리 800×400
    const lx = (canvasPx / rect.width) * CANVAS_W;
    const ly = (canvasPy / rect.height) * CANVAS_H;

    const layout = getLayout(boardSize);
    const rawX = (lx - layout.offsetX) / layout.cell;
    const rawY = (ly - layout.offsetY) / layout.cell;
    const x = Math.round(rawX);
    const y = Math.round(rawY);
    if (x < 0 || x >= boardSize || y < 0 || y >= boardSize) return null;
    // 거리 체크
    const dx = rawX - x;
    const dy = rawY - y;
    if (dx * dx + dy * dy > 0.4 * 0.4) return null;
    return { x, y };
  }

  render(state: RenderState): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const sx = (rect.width * dpr) / CANVAS_W;
    const sy = (rect.height * dpr) / CANVAS_H;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);

    // 1) 배경
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // 2) 플레이어 카드 (좌=호스트=흑, 우=게스트=백)
    const isGameOver = state.gameOver !== null;
    this.drawPlayerCard({
      x: CARD_LEFT_X,
      nickname: state.hostNickname,
      stone: 'B',
      isMe: state.myRole === 'host',
      isActive: !isGameOver && state.currentTurn === 'B',
      timerSeconds: state.currentTurn === 'B' ? state.timerSeconds : 30,
      timerRatio: state.currentTurn === 'B' ? state.timerRatio : 1,
    });
    this.drawPlayerCard({
      x: CARD_RIGHT_X,
      nickname: state.guestNickname,
      stone: 'W',
      isMe: state.myRole === 'guest',
      isActive: !isGameOver && state.currentTurn === 'W',
      timerSeconds: state.currentTurn === 'W' ? state.timerSeconds : 30,
      timerRatio: state.currentTurn === 'W' ? state.timerRatio : 1,
    });

    // 3) 보드 프레임 + 격자 + 별점
    this.drawBoardFrame();
    this.drawGrid(state.boardSize);
    this.drawStarPoints(state.boardSize);

    // 4) 돌들
    this.drawStones(state.board, state.boardSize);

    // 5) 마지막 수 빨간 링
    if (state.lastMove) {
      this.drawLastMoveRing(state.lastMove.x, state.lastMove.y, state.boardSize);
    }

    // 6) hover 프리뷰 (내 차례 때만)
    if (state.hoverCell && !isGameOver) {
      this.drawHoverPreview(
        state.hoverCell.x,
        state.hoverCell.y,
        state.currentTurn,
        state.boardSize,
        state.hoverCell.legal,
      );
    }

    // 7) 승리 하이라이트 (펄스 glow)
    if (state.winInfo) {
      this.drawWinHighlight(state.winInfo, state.boardSize);
    }

    // 8) 게임 종료 오버레이
    if (state.gameOver) {
      this.drawGameOverOverlay(state);
    }
  }

  // ============================================
  // 보드
  // ============================================

  private drawBoardFrame(): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.boardFill;
    ctx.fillRect(FRAME_X, FRAME_Y, FRAME_SIZE, FRAME_SIZE);
    ctx.strokeStyle = COLORS.boardBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(FRAME_X, FRAME_Y, FRAME_SIZE, FRAME_SIZE);
  }

  private drawGrid(size: BoardSize): void {
    const ctx = this.ctx;
    const layout = getLayout(size);
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    // 세로선 size개
    for (let i = 0; i < size; i++) {
      const x = layout.offsetX + i * layout.cell;
      ctx.moveTo(x, layout.offsetY);
      ctx.lineTo(x, layout.offsetY + layout.cell * (size - 1));
    }
    // 가로선 size개
    for (let i = 0; i < size; i++) {
      const y = layout.offsetY + i * layout.cell;
      ctx.moveTo(layout.offsetX, y);
      ctx.lineTo(layout.offsetX + layout.cell * (size - 1), y);
    }
    ctx.stroke();
  }

  private drawStarPoints(size: BoardSize): void {
    const ctx = this.ctx;
    const layout = getLayout(size);
    const points = size === 15 ? STAR_POINTS_15 : STAR_POINTS_19;
    ctx.fillStyle = COLORS.starPoint;
    for (const [x, y] of points) {
      const { px, py } = cellToPixel(x, y, layout);
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawStones(board: Board, size: BoardSize): void {
    const layout = getLayout(size);
    for (let y = 0; y < size; y++) {
      const row = board[y];
      if (!row) continue;
      for (let x = 0; x < size; x++) {
        const stone = row[x];
        if (!stone) continue;
        const { px, py } = cellToPixel(x, y, layout);
        this.drawStone(px, py, stone, layout.stoneR);
      }
    }
  }

  private drawStone(px: number, py: number, stone: 'B' | 'W', r: number): void {
    const ctx = this.ctx;
    const fill = stone === 'B' ? COLORS.blackStone : COLORS.whiteStone;
    const stroke = stone === 'B' ? COLORS.blackStroke : COLORS.whiteStroke;

    // 약간의 그림자 느낌
    ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.beginPath();
    ctx.arc(px + 0.7, py + 1.3, r, 0, Math.PI * 2);
    ctx.fill();

    // 본체
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 상단 하이라이트 (광택)
    if (stone === 'B') {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    }
    ctx.beginPath();
    ctx.ellipse(px - r * 0.28, py - r * 0.34, r * 0.42, r * 0.2, -0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawLastMoveRing(x: number, y: number, size: BoardSize): void {
    const ctx = this.ctx;
    const layout = getLayout(size);
    const { px, py } = cellToPixel(x, y, layout);
    ctx.strokeStyle = COLORS.lastMoveRing;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, layout.stoneR + 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawHoverPreview(
    x: number, y: number,
    stone: 'B' | 'W',
    size: BoardSize,
    legal: boolean,
  ): void {
    const ctx = this.ctx;
    const layout = getLayout(size);
    const { px, py } = cellToPixel(x, y, layout);

    if (!legal) {
      // 금수 자리 X 마크
      ctx.strokeStyle = COLORS.lastMoveRing;
      ctx.lineWidth = 2.5;
      const r = layout.stoneR * 0.7;
      ctx.beginPath();
      ctx.moveTo(px - r, py - r);
      ctx.lineTo(px + r, py + r);
      ctx.moveTo(px + r, py - r);
      ctx.lineTo(px - r, py + r);
      ctx.stroke();
      return;
    }

    // 합법 자리: 반투명 내 돌 프리뷰
    ctx.globalAlpha = 0.4;
    this.drawStone(px, py, stone, layout.stoneR);
    ctx.globalAlpha = 1;
  }

  private drawWinHighlight(winInfo: WinInfo, size: BoardSize): void {
    const ctx = this.ctx;
    const layout = getLayout(size);
    const pulse = (Math.sin(performance.now() / 180) + 1) / 2;

    for (const s of winInfo.stones) {
      const { px, py } = cellToPixel(s.x, s.y, layout);
      ctx.fillStyle = COLORS.winGlow;
      ctx.beginPath();
      ctx.arc(px, py, layout.stoneR + 4 + pulse * 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ============================================
  // 플레이어 카드
  // ============================================

  private drawPlayerCard(args: {
    x: number;
    nickname: string;
    stone: 'B' | 'W';
    isMe: boolean;
    isActive: boolean;
    timerSeconds: number;
    timerRatio: number;
  }): void {
    const ctx = this.ctx;
    const { x, nickname, stone, isMe, isActive, timerSeconds, timerRatio } = args;

    // 카드 배경
    ctx.fillStyle = isActive ? COLORS.cardBgActive : COLORS.cardBg;
    ctx.fillRect(x, CARD_Y, CARD_W, CARD_H);
    ctx.strokeStyle = isActive ? COLORS.cardBorderActive : COLORS.cardBorder;
    ctx.lineWidth = isActive ? 2.5 : 1.5;
    ctx.strokeRect(x, CARD_Y, CARD_W, CARD_H);

    // 돌 아이콘
    const stoneR = 22;
    const stoneCx = x + CARD_W / 2;
    const stoneCy = CARD_Y + 42;
    this.drawStone(stoneCx, stoneCy, stone, stoneR);

    // "흑 / 백" 라벨
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(stone === 'B' ? '흑 (선공)' : '백 (후공)', stoneCx, CARD_Y + 86);

    // 닉네임 (+ "나" 표시)
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `800 17px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(truncate(nickname, 9), stoneCx, CARD_Y + 116);

    if (isMe) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `700 11px ${FONT}`;
      ctx.fillText('(나)', stoneCx, CARD_Y + 134);
    }

    // 타이머 링
    const timerCx = stoneCx;
    const timerCy = CARD_Y + 180;
    const timerR = 28;
    // 트랙
    ctx.strokeStyle = COLORS.timerTrack;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(timerCx, timerCy, timerR, 0, Math.PI * 2);
    ctx.stroke();
    // 프로그레스 (활성 카드만 채색, 비활성은 무채색)
    const warning = timerRatio < 0.2;
    const ringColor = isActive
      ? (warning ? COLORS.timerWarning : COLORS.timerRing)
      : COLORS.timerTrack;
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + Math.PI * 2 * Math.max(0, Math.min(1, timerRatio));
    ctx.beginPath();
    ctx.arc(timerCx, timerCy, timerR, startAngle, endAngle);
    ctx.stroke();
    ctx.lineCap = 'butt';
    // 남은 초 숫자
    ctx.fillStyle = isActive ? (warning ? COLORS.timerWarning : COLORS.textMain) : COLORS.textMuted;
    ctx.font = `900 20px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.max(0, Math.ceil(timerSeconds))), timerCx, timerCy + 1);

    // 차례 표시
    ctx.fillStyle = isActive ? COLORS.cardBorderActive : COLORS.textMuted;
    ctx.font = `700 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(isActive ? (isMe ? '내 차례' : '상대 차례') : '대기', stoneCx, CARD_Y + 238);
  }

  // ============================================
  // 게임 종료 오버레이
  // ============================================

  private drawGameOverOverlay(state: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.overlayBg;
    ctx.fillRect(FRAME_X, FRAME_Y, FRAME_SIZE, FRAME_SIZE);

    let title = '';
    let sub = '';
    const go = state.gameOver!;
    if (go.winner === null) {
      title = '무승부';
      sub = '보드가 가득 찼어요';
    } else {
      const winnerNick = go.winner === 'B' ? state.hostNickname : state.guestNickname;
      title = `${truncate(winnerNick, 8)} 승!`;
      switch (go.reason) {
        case 'five': sub = '5목 완성'; break;
        case 'timeout': sub = '상대 시간초과'; break;
        case 'resign': sub = '상대 포기'; break;
        case 'draw': sub = ''; break;
      }
    }

    ctx.fillStyle = COLORS.overlayTitle;
    ctx.font = `900 42px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, FRAME_X + FRAME_SIZE / 2, FRAME_Y + FRAME_SIZE / 2 - 10);

    if (sub) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `600 16px ${FONT}`;
      ctx.fillText(sub, FRAME_X + FRAME_SIZE / 2, FRAME_Y + FRAME_SIZE / 2 + 26);
    }
  }
}

// ============================================
// 유틸
// ============================================

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Stone 타입은 외부에서 사용 안 함 — 타입 사용 방지용 import 참조는 RenderState.board의 Board 제너릭 통해서만.
// 여기서 다시 export 하지 않아 unused 경고 방지를 위해 type-only re-export 생략.
export type { Stone };
