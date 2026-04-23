/**
 * 사과 게임 Canvas 렌더러
 *
 * 레이아웃 (800×400 논리 좌표):
 *   ┌───────────────────────────────────────────────────┐
 *   │  [좌측 패널]     │ [10×17 보드]       │ [우측 패널] │
 *   │  ⏱ 1:23          │                     │ 랭킹       │
 *   │  내 점수 42       │  ● ● ● ● ● ● ● ● ● ● │ 🥇 홍 50   │
 *   │                  │  ● ● ● ● ● ● ● ● ● ● │ 🥈 김 42   │
 *   │  (힌트 텍스트)    │  ...               │ 🥉 이 30   │
 *   └───────────────────────────────────────────────────┘
 *
 * 드래그 중 선택 박스 색:
 *   - 합 < 10: 연분홍 (기본)
 *   - 합 = 10: 민트 (정답 시그널)
 *   - 합 > 10: 연주황 (초과 경고)
 *   → 플레이어가 시각적으로 바로 인식하도록 상태별 색 변경
 */

import { BOARD_COLS, BOARD_ROWS, type Board, type Rect } from './board';

// ============================================
// 레이아웃 상수
// ============================================

const CANVAS_W = 800;
const CANVAS_H = 400;

/** 보드 한 칸 크기 (논리 px) — 17×10 배치에서 가독성 고려 */
export const CELL = 30;
const BOARD_PX_W = CELL * BOARD_COLS;  // 510 (17 * 30)
const BOARD_PX_H = CELL * BOARD_ROWS;  // 300 (10 * 30)
const BOARD_X = Math.round((CANVAS_W - BOARD_PX_W) / 2);  // 145
const BOARD_Y = Math.round((CANVAS_H - BOARD_PX_H) / 2);  // 50

const APPLE_RADIUS = CELL / 2 - 3; // 12

const LEFT_PANEL_X = 18;
const RIGHT_PANEL_X = 665;
const PANEL_Y = 40;
/** 우측 랭킹 row 너비 — 좁아진 우측 패널에 맞춤 */
const RANK_ROW_W = 125;

const COLORS = {
  bg: '#fff9fd',
  boardBg: '#fff5ee',
  boardBorder: '#ffc9dd',
  gridLine: 'rgba(255, 201, 221, 0.4)',
  appleFill: '#ff8a9f',
  appleStroke: '#c04058',
  appleHighlight: 'rgba(255, 255, 255, 0.45)',
  appleNumber: '#fff',
  appleStem: '#8b5a2b',    // 꼭지(줄기) 갈색
  appleLeaf: '#86e8c4',    // 잎 민트 (썸네일과 통일)
  appleLeafStroke: '#5dc9a7',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  accent: '#ff5a92',
  timerUrgent: '#ff5a92',
  // 드래그 선택 박스 (합 정보 노출 안 함 — 단일 중립 색)
  selNeutral: { fill: 'rgba(255, 130, 172, 0.18)', stroke: '#ff6b9e' },
} as const;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

// ============================================
// 렌더 입력 타입
// ============================================

export interface RenderState {
  board: Board;
  /** 드래그 중 선택 영역. 없으면 null (드래그 안 하는 중) */
  dragRect: Rect | null;
  /** 남은 시간 (ms). 0 이하면 게임 종료 상태 */
  remainingMs: number;
  myScore: number;
  myNickname: string;
  /** 나 제외한 플레이어 목록 (순위 계산은 이 레벨에서 하지 않음 — index.ts 가 정렬) */
  otherPlayers: Array<{ nickname: string; score: number; peerId: string }>;
  /** 관전자 뷰 여부 — 내 점수 영역 대신 "관전 중" 표시 */
  isSpectator: boolean;
  /** 게임 종료 후 오버레이 표시 */
  gameEnded: boolean;
}

// ============================================
// Renderer
// ============================================

export interface AppleRendererArgs {
  canvas: HTMLCanvasElement;
}

export class AppleRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;

  constructor(args: AppleRendererArgs) {
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
   * 캔버스 DOM 좌표 → 논리 좌표계 (800×400) 로 변환.
   * 마우스 이벤트 hit-test 용. index.ts 가 getBoundingClientRect 뺀 로컬 좌표를 넘긴다.
   */
  canvasToLogical(localX: number, localY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: (localX / rect.width) * CANVAS_W,
      y: (localY / rect.height) * CANVAS_H,
    };
  }

  /** 논리 좌표(x,y) → 격자 좌표(col,row). 보드 밖이면 null. */
  logicalToCell(x: number, y: number): { col: number; row: number } | null {
    if (x < BOARD_X || x >= BOARD_X + BOARD_PX_W) return null;
    if (y < BOARD_Y || y >= BOARD_Y + BOARD_PX_H) return null;
    const col = Math.floor((x - BOARD_X) / CELL);
    const row = Math.floor((y - BOARD_Y) / CELL);
    return { col, row };
  }

  /**
   * 논리 좌표 → 격자 좌표. 보드 밖이어도 가장 가까운 경계 셀로 스냅.
   * 드래그 중 커서가 보드 밖으로 나가도 선택 박스가 유지되도록 index.ts 에서 사용.
   */
  logicalToCellClamp(x: number, y: number): { col: number; row: number } {
    const col = clampInt(Math.floor((x - BOARD_X) / CELL), 0, BOARD_COLS - 1);
    const row = clampInt(Math.floor((y - BOARD_Y) / CELL), 0, BOARD_ROWS - 1);
    return { col, row };
  }

  /** 격자 좌표 → 논리 좌표 셀 중심 (사과 원 중심 잡을 때 사용) */
  cellCenter(col: number, row: number): { x: number; y: number } {
    return {
      x: BOARD_X + col * CELL + CELL / 2,
      y: BOARD_Y + row * CELL + CELL / 2,
    };
  }

  /** 매 프레임 호출 */
  render(state: RenderState): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 논리 좌표 → 실제 픽셀
    const sx = (rect.width * dpr) / CANVAS_W;
    const sy = (rect.height * dpr) / CANVAS_H;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);

    // 전체 배경
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // 보드
    this.drawBoardBackground();
    this.drawApples(state.board);

    // 드래그 선택 박스 (사과 위에, 결과 오버레이 아래)
    if (state.dragRect && !state.isSpectator) {
      this.drawSelection(state.dragRect);
    }

    // 관전자 오버레이 — 보드 전체를 덮고 "관전 중" 텍스트
    if (state.isSpectator) {
      this.drawSpectatorOverlay();
    }

    // 좌우 패널
    this.drawLeftPanel(state);
    this.drawRightPanel(state);

    // 게임 종료 오버레이
    if (state.gameEnded) {
      this.drawGameEndOverlay();
    }
  }

  private drawSpectatorOverlay(): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255, 245, 248, 0.88)';
    ctx.fillRect(BOARD_X, BOARD_Y, BOARD_PX_W, BOARD_PX_H);
    const cx = BOARD_X + BOARD_PX_W / 2;
    const cy = BOARD_Y + BOARD_PX_H / 2;
    ctx.fillStyle = COLORS.accent;
    ctx.font = `900 36px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('👀', cx, cy - 24);
    ctx.font = `900 24px ${FONT}`;
    ctx.fillText('관전 중', cx, cy + 14);
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `500 12px ${FONT}`;
    ctx.fillText('우측 랭킹을 확인하세요', cx, cy + 42);
  }

  // ============================================
  // 보드 / 사과
  // ============================================

  private drawBoardBackground(): void {
    const ctx = this.ctx;
    // 보드 배경
    ctx.fillStyle = COLORS.boardBg;
    ctx.fillRect(BOARD_X, BOARD_Y, BOARD_PX_W, BOARD_PX_H);
    // 격자 (얇게)
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = 0.5;
    for (let i = 1; i < BOARD_COLS; i++) {
      const x = BOARD_X + i * CELL;
      ctx.beginPath();
      ctx.moveTo(x, BOARD_Y);
      ctx.lineTo(x, BOARD_Y + BOARD_PX_H);
      ctx.stroke();
    }
    for (let i = 1; i < BOARD_ROWS; i++) {
      const y = BOARD_Y + i * CELL;
      ctx.beginPath();
      ctx.moveTo(BOARD_X, y);
      ctx.lineTo(BOARD_X + BOARD_PX_W, y);
      ctx.stroke();
    }
    // 보드 테두리
    ctx.strokeStyle = COLORS.boardBorder;
    ctx.lineWidth = 1.8;
    ctx.strokeRect(BOARD_X - 1, BOARD_Y - 1, BOARD_PX_W + 2, BOARD_PX_H + 2);
  }

  private drawApples(board: Board): void {
    const ctx = this.ctx;
    ctx.font = `800 16px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const bodyRadius = APPLE_RADIUS - 0.8;

    for (let r = 0; r < BOARD_ROWS; r++) {
      const row = board[r];
      if (!row) continue;
      for (let c = 0; c < BOARD_COLS; c++) {
        const v = row[c];
        if (v === null || v === undefined) continue;
        const { x, y } = this.cellCenter(c, r);

        // 몸통을 살짝 아래로 (꼭지/잎이 셀 안에 들어오도록)
        const cy = y + 1.5;

        // 몸통 — 약간 가로로 납작한 타원(실제 사과 비율 느낌)
        ctx.fillStyle = COLORS.appleFill;
        ctx.beginPath();
        ctx.ellipse(x, cy, bodyRadius, bodyRadius - 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = COLORS.appleStroke;
        ctx.lineWidth = 1;
        ctx.stroke();

        // 상단 중앙 움푹 들어간 느낌 — 몸통 색보다 살짝 어두운 작은 호
        ctx.fillStyle = COLORS.appleStroke;
        ctx.globalAlpha = 0.18;
        ctx.beginPath();
        ctx.ellipse(x, cy - bodyRadius + 0.8, 2.6, 1.3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // 꼭지(줄기) — 상단 중앙 짧은 갈색 막대
        ctx.fillStyle = COLORS.appleStem;
        ctx.beginPath();
        ctx.moveTo(x - 0.9, cy - bodyRadius - 2.8);
        ctx.lineTo(x + 0.9, cy - bodyRadius - 2.8);
        ctx.lineTo(x + 0.6, cy - bodyRadius + 0.6);
        ctx.lineTo(x - 0.6, cy - bodyRadius + 0.6);
        ctx.closePath();
        ctx.fill();

        // 잎 — 꼭지 옆 대각 타원 (민트)
        ctx.save();
        ctx.translate(x + 3, cy - bodyRadius - 1);
        ctx.rotate(-Math.PI / 5); // 좌상 방향으로 살짝 기울어진 잎
        ctx.fillStyle = COLORS.appleLeaf;
        ctx.beginPath();
        ctx.ellipse(0, 0, 3.8, 1.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = COLORS.appleLeafStroke;
        ctx.lineWidth = 0.7;
        ctx.stroke();
        ctx.restore();

        // 하이라이트 (좌상단 반투명 타원) — 광택 느낌
        ctx.fillStyle = COLORS.appleHighlight;
        ctx.beginPath();
        ctx.ellipse(
          x - bodyRadius * 0.35,
          cy - bodyRadius * 0.4,
          bodyRadius * 0.3,
          bodyRadius * 0.45,
          0, 0, Math.PI * 2,
        );
        ctx.fill();

        // 숫자
        ctx.fillStyle = COLORS.appleNumber;
        ctx.fillText(String(v), x, cy + 1);
      }
    }
  }

  // ============================================
  // 드래그 선택
  // ============================================

  private drawSelection(rect: Rect): void {
    const ctx = this.ctx;
    // 스포일러 방지: 합 숫자도, 합 상태별 색 힌트도 모두 제거. 항상 단일 연분홍.
    const style = COLORS.selNeutral;

    const x = BOARD_X + rect.cLo * CELL;
    const y = BOARD_Y + rect.rLo * CELL;
    const w = (rect.cHi - rect.cLo + 1) * CELL;
    const h = (rect.rHi - rect.rLo + 1) * CELL;

    ctx.fillStyle = style.fill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.setLineDash([]);
  }

  // ============================================
  // 좌측 패널 — 타이머 + 내 점수
  // ============================================

  private drawLeftPanel(state: RenderState): void {
    const ctx = this.ctx;

    // 타이머 라벨
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('⏱ 남은 시간', LEFT_PANEL_X, PANEL_Y);

    // 타이머 값 — mm:ss
    const urgent = state.remainingMs <= 30_000 && state.remainingMs > 0;
    ctx.fillStyle = urgent ? COLORS.timerUrgent : COLORS.textMain;
    ctx.font = `800 32px ${FONT}`;
    ctx.fillText(formatMs(state.remainingMs), LEFT_PANEL_X, PANEL_Y + 36);

    // 내 점수 (관전자는 "관전 중" 대체)
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    if (state.isSpectator) {
      ctx.fillText('MODE', LEFT_PANEL_X, PANEL_Y + 90);
      ctx.fillStyle = COLORS.accent;
      ctx.font = `800 22px ${FONT}`;
      ctx.fillText('👀 관전 중', LEFT_PANEL_X, PANEL_Y + 120);
    } else {
      ctx.fillText('내 점수', LEFT_PANEL_X, PANEL_Y + 90);
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `800 36px ${FONT}`;
      ctx.fillText(String(state.myScore), LEFT_PANEL_X, PANEL_Y + 130);

      // 힌트
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `500 11px ${FONT}`;
      ctx.fillText('드래그해서 합이 10인', LEFT_PANEL_X, PANEL_Y + 170);
      ctx.fillText('사과들을 묶어보세요', LEFT_PANEL_X, PANEL_Y + 186);
    }
  }

  // ============================================
  // 우측 패널 — 플레이어 이름만 (점수는 게임 중 비노출)
  // ============================================

  private drawRightPanel(state: RenderState): void {
    const ctx = this.ctx;

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('👥 플레이어', RIGHT_PANEL_X, PANEL_Y);

    // 이름 리스트 (나 + 상대). 관전자는 자기 자신은 목록에서 제외.
    const names: Array<{ nickname: string; isMe: boolean }> = [];
    if (!state.isSpectator) {
      names.push({ nickname: state.myNickname, isMe: true });
    }
    for (const p of state.otherPlayers) {
      names.push({ nickname: p.nickname, isMe: false });
    }

    const maxShow = 4;
    const top = names.slice(0, maxShow);
    const rowH = 32;
    const rowGap = 4;

    for (let i = 0; i < top.length; i++) {
      const row = top[i]!;
      const y = PANEL_Y + 16 + i * (rowH + rowGap);

      ctx.fillStyle = row.isMe ? '#ffe4ee' : '#faf5ff';
      ctx.strokeStyle = row.isMe ? '#ff6b9e' : '#d9c7ff';
      ctx.lineWidth = 1;
      ctx.fillRect(RIGHT_PANEL_X, y, RANK_ROW_W, rowH);
      ctx.strokeRect(RIGHT_PANEL_X, y, RANK_ROW_W, rowH);

      ctx.fillStyle = COLORS.textMain;
      ctx.font = `700 13px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const label = truncate(row.nickname, 7) + (row.isMe ? ' (나)' : '');
      ctx.fillText(label, RIGHT_PANEL_X + 10, y + rowH / 2);
    }

    if (names.length > maxShow) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `500 11px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`...외 ${names.length - maxShow}명`, RIGHT_PANEL_X, PANEL_Y + 16 + maxShow * (rowH + rowGap) + 14);
    }

    // 안내 문구 — 점수가 끝에 공개된다는 걸 알려줌
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `500 10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const noticeY = PANEL_Y + 16 + Math.min(names.length, maxShow) * (rowH + rowGap) + (names.length > maxShow ? 26 : 12);
    ctx.fillText('점수는 게임이 끝나면', RIGHT_PANEL_X, noticeY);
    ctx.fillText('공개돼요', RIGHT_PANEL_X, noticeY + 14);
  }

  // ============================================
  // 게임 종료 오버레이
  // ============================================

  private drawGameEndOverlay(): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255, 245, 248, 0.7)';
    ctx.fillRect(BOARD_X, BOARD_Y, BOARD_PX_W, BOARD_PX_H);
    ctx.fillStyle = COLORS.accent;
    ctx.font = `900 32px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TIME UP!', BOARD_X + BOARD_PX_W / 2, BOARD_Y + BOARD_PX_H / 2);
  }
}

// ============================================
// 유틸
// ============================================

/** ms → "m:ss" (음수/0 은 0:00) */
function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
