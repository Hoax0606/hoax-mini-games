/**
 * 배틀 테트리스 Canvas 렌더러
 *
 * 레이아웃 (800×400 논리 좌표):
 *   ┌─────────────────────────────────────────────────────┐
 *   │  HOLD    │     MAIN FIELD       │ NEXT (×2)         │
 *   │  [4×4]   │     10 × 20          │ [4×4] [4×4]       │
 *   │          │     cell 18px        │                   │
 *   │  LINES   │                      │ VS                │
 *   │  123     │                      │ [mini][mini][mini]│
 *   │  ▓▓▓ (가 │                      │                   │
 *   │  비지)   │                      │                   │
 *   └─────────────────────────────────────────────────────┘
 *
 * 자기 필드는 cell 18px, 상대 미니뷰는 cell 5px로 4배 축소.
 * 탑아웃된 상대는 미니뷰 위에 "OUT" 오버레이.
 */

import { PIECES, forEachMino, type PieceId, type PieceState } from './pieces';
import { FIELD_WIDTH, FIELD_HEIGHT, dropDistance, type Cell, type Field } from './field';
import type { EngineState } from './engine';

// ============================================
// 레이아웃 상수
// ============================================

const CANVAS_W = 800;
const CANVAS_H = 400;

/** 메인 필드 셀 크기 (px, 논리 좌표) */
const CELL = 18;
const FIELD_PX_W = CELL * FIELD_WIDTH;   // 180
const FIELD_PX_H = CELL * FIELD_HEIGHT;  // 360
const FIELD_X = Math.round((CANVAS_W - FIELD_PX_W) / 2); // 310
const FIELD_Y = 20;

/** HOLD 박스 — 좌측 상단 */
const HOLD_CELL = 18;
const HOLD_W = HOLD_CELL * 4;
const HOLD_X = 50;
const HOLD_Y = 40;

/** NEXT 박스들 — 우측 상단 */
const NEXT_CELL = 18;
const NEXT_W = NEXT_CELL * 4;
const NEXT_X = 530;
const NEXT_Y0 = 40;
const NEXT_GAP = 10;

/** 상대 미니뷰 — 우측 하단 */
const OPP_CELL = 5;
const OPP_W = OPP_CELL * FIELD_WIDTH;    // 50
const OPP_H = OPP_CELL * FIELD_HEIGHT;   // 100
const OPP_X0 = 530;
const OPP_Y0 = 235;
const OPP_GAP = 18;

const COLORS = {
  bg: '#fff9fd',
  gridLine: '#eee4f7',
  boxBg: '#faf5ff',
  boxBorder: '#d9c7ff',
  fieldBorder: '#b89aff',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  garbage: '#a8a4b0',
  garbageStroke: '#6a6670',
  ghost: 'rgba(74, 58, 74, 0.18)',
  toppedOverlay: 'rgba(200, 190, 210, 0.75)',
  gaugeGarbage: '#ff5a92',
  labelAccent: '#9c7aeb',
} as const;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

// ============================================
// 상대 스냅샷 타입 — index.ts가 채워 넣음
// ============================================

export interface OpponentSnapshot {
  peerId: string;
  nickname: string;
  field: Field;
  toppedOut: boolean;
  linesCleared: number;
}

// ============================================
// Renderer
// ============================================

export interface TetrisRendererArgs {
  canvas: HTMLCanvasElement;
}

export class TetrisRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;

  constructor(args: TetrisRendererArgs) {
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

  /** 매 프레임 호출.
   *
   * opts.spectator = true 일 땐 "나" 관점의 UI(메인 필드/HOLD/NEXT/STATS)를 그리지 않고
   * 해당 영역에 "관전 중" 오버레이만 둔다. 상대 미니뷰는 계속 그린다 (최대 4명까지).
   */
  render(
    me: EngineState,
    opponents: OpponentSnapshot[],
    opts: { spectator?: boolean } = {},
  ): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 논리 좌표 800×400 → 실제 픽셀
    const sx = (rect.width * dpr) / CANVAS_W;
    const sy = (rect.height * dpr) / CANVAS_H;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);

    // 전체 배경
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    if (opts.spectator) {
      // 관전자: 메인 필드/HOLD/NEXT/STATS 자리에 안내 오버레이
      this.drawSpectatorCenter();
    } else {
      // 메인 필드 + 현재 피스 + 고스트
      this.drawField(me.field, FIELD_X, FIELD_Y, CELL);
      if (me.currentPiece && !me.toppedOut) {
        this.drawGhost(me.field, me.currentPiece);
        this.drawPiece(me.currentPiece, FIELD_X, FIELD_Y, CELL);
      }
      // 필드 테두리
      ctx.strokeStyle = COLORS.fieldBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(FIELD_X - 1, FIELD_Y - 1, FIELD_PX_W + 2, FIELD_PX_H + 2);

      // 탑아웃 오버레이
      if (me.toppedOut) {
        ctx.fillStyle = COLORS.toppedOverlay;
        ctx.fillRect(FIELD_X, FIELD_Y, FIELD_PX_W, FIELD_PX_H);
        ctx.fillStyle = COLORS.gaugeGarbage;
        ctx.font = `900 28px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('GAME OVER', FIELD_X + FIELD_PX_W / 2, FIELD_Y + FIELD_PX_H / 2);
      }

      // 좌측: HOLD + STATS
      this.drawHoldBox(me.holdPiece, me.holdUsed);
      this.drawStats(me);

      // 우측: NEXT
      this.drawNextBoxes(me.nextPieces);
    }

    // 상대 미니뷰는 양쪽 모드 모두 그림. 관전자일 땐 최대 4명까지.
    this.drawOpponents(opponents, opts.spectator ?? false);
  }

  /** 관전자 모드 중앙 오버레이 — 메인/HOLD/NEXT 자리에 "👀 관전 중" 안내 */
  private drawSpectatorCenter(): void {
    const ctx = this.ctx;
    // 외곽 카드 배경 (메인 필드 영역과 얼추 같은 위치)
    const cardX = 60;
    const cardY = 60;
    const cardW = 450;
    const cardH = 280;
    ctx.fillStyle = COLORS.boxBg;
    ctx.fillRect(cardX, cardY, cardW, cardH);
    ctx.strokeStyle = COLORS.boxBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(cardX, cardY, cardW, cardH);

    ctx.fillStyle = COLORS.textMain;
    ctx.font = `900 44px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('👀', cardX + cardW / 2, cardY + cardH / 2 - 30);

    ctx.fillStyle = COLORS.labelAccent;
    ctx.font = `800 28px ${FONT}`;
    ctx.fillText('관전 중', cardX + cardW / 2, cardY + cardH / 2 + 30);

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `500 13px ${FONT}`;
    ctx.fillText('오른쪽에서 플레이어들의 경기를 지켜보세요', cardX + cardW / 2, cardY + cardH / 2 + 62);
  }

  // ============================================
  // 필드 / 피스
  // ============================================

  private drawField(field: Field, x0: number, y0: number, cellSize: number): void {
    const ctx = this.ctx;
    const w = cellSize * FIELD_WIDTH;
    const h = cellSize * FIELD_HEIGHT;

    // 배경
    ctx.fillStyle = COLORS.boxBg;
    ctx.fillRect(x0, y0, w, h);

    // 격자
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = 0.5;
    for (let i = 1; i < FIELD_WIDTH; i++) {
      const x = x0 + i * cellSize;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + h);
      ctx.stroke();
    }
    for (let i = 1; i < FIELD_HEIGHT; i++) {
      const y = y0 + i * cellSize;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + w, y);
      ctx.stroke();
    }

    // 고정된 블록
    for (let r = 0; r < FIELD_HEIGHT; r++) {
      const row = field[r];
      if (!row) continue;
      for (let c = 0; c < FIELD_WIDTH; c++) {
        const cell = row[c];
        if (cell !== null && cell !== undefined) {
          this.drawCell(cell, x0 + c * cellSize, y0 + r * cellSize, cellSize);
        }
      }
    }
  }

  /** 한 셀을 그림. cell은 PieceId 또는 'G'(가비지) */
  private drawCell(cell: Cell, x: number, y: number, size: number): void {
    const ctx = this.ctx;
    if (cell === null) return;

    let fill: string;
    let stroke: string;
    if (cell === 'G') {
      fill = COLORS.garbage;
      stroke = COLORS.garbageStroke;
    } else {
      const def = PIECES[cell];
      fill = def.color;
      stroke = def.stroke;
    }

    ctx.fillStyle = fill;
    ctx.fillRect(x + 0.5, y + 0.5, size - 1, size - 1);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    // 상단 내부 하이라이트 (파스텔 광택)
    if (size >= 12) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect(x + 2, y + 2, size - 4, Math.max(1, size * 0.2));
    }
  }

  private drawPiece(piece: PieceState, x0: number, y0: number, cellSize: number): void {
    const shape = PIECES[piece.id].shapes[piece.rotation];
    forEachMino(shape, (dx, dy) => {
      const col = piece.x + dx;
      const row = piece.y + dy;
      if (row >= 0) {
        this.drawCell(piece.id, x0 + col * cellSize, y0 + row * cellSize, cellSize);
      }
    });
  }

  /** 고스트 피스: 하드드롭 시 착지할 위치를 반투명으로 표시 */
  private drawGhost(field: Field, piece: PieceState): void {
    const dist = dropDistance(field, piece);
    if (dist === 0) return; // 이미 바닥이면 생략
    const ctx = this.ctx;
    const shape = PIECES[piece.id].shapes[piece.rotation];
    ctx.fillStyle = COLORS.ghost;
    forEachMino(shape, (dx, dy) => {
      const col = piece.x + dx;
      const row = piece.y + dist + dy;
      if (row >= 0) {
        ctx.fillRect(
          FIELD_X + col * CELL + 1,
          FIELD_Y + row * CELL + 1,
          CELL - 2,
          CELL - 2,
        );
      }
    });
  }

  // ============================================
  // HOLD / NEXT / STATS
  // ============================================

  private drawHoldBox(holdPiece: PieceId | null, used: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('HOLD', HOLD_X, HOLD_Y - 8);

    ctx.fillStyle = COLORS.boxBg;
    ctx.fillRect(HOLD_X, HOLD_Y, HOLD_W, HOLD_W);
    ctx.strokeStyle = COLORS.boxBorder;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(HOLD_X, HOLD_Y, HOLD_W, HOLD_W);

    if (holdPiece) {
      ctx.globalAlpha = used ? 0.4 : 1;
      this.drawPieceInBox(holdPiece, HOLD_X, HOLD_Y, HOLD_CELL);
      ctx.globalAlpha = 1;
    }
  }

  private drawNextBoxes(nextPieces: PieceId[]): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('NEXT', NEXT_X, NEXT_Y0 - 8);

    for (let i = 0; i < nextPieces.length; i++) {
      const y = NEXT_Y0 + i * (NEXT_W + NEXT_GAP);
      ctx.fillStyle = COLORS.boxBg;
      ctx.fillRect(NEXT_X, y, NEXT_W, NEXT_W);
      ctx.strokeStyle = COLORS.boxBorder;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(NEXT_X, y, NEXT_W, NEXT_W);
      this.drawPieceInBox(nextPieces[i]!, NEXT_X, y, NEXT_CELL);
    }
  }

  /** 4x4 박스 안에 피스 shape(rotation 0)을 중앙정렬로 그림 */
  private drawPieceInBox(pieceId: PieceId, x0: number, y0: number, cellSize: number): void {
    const shape = PIECES[pieceId].shapes[0];
    // shape의 bounding box 찾기
    let minC = 4, maxC = -1, minR = 4, maxR = -1;
    forEachMino(shape, (dx, dy) => {
      if (dx < minC) minC = dx;
      if (dx > maxC) maxC = dx;
      if (dy < minR) minR = dy;
      if (dy > maxR) maxR = dy;
    });
    const boxPx = cellSize * 4;
    const bw = (maxC - minC + 1) * cellSize;
    const bh = (maxR - minR + 1) * cellSize;
    const offX = x0 + (boxPx - bw) / 2 - minC * cellSize;
    const offY = y0 + (boxPx - bh) / 2 - minR * cellSize;

    forEachMino(shape, (dx, dy) => {
      this.drawCell(pieceId, offX + dx * cellSize, offY + dy * cellSize, cellSize);
    });
  }

  private drawStats(me: EngineState): void {
    const ctx = this.ctx;
    const x = HOLD_X;
    const y = HOLD_Y + HOLD_W + 30;

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('LINES', x, y);

    ctx.fillStyle = COLORS.textMain;
    ctx.font = `800 32px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(me.totalLinesCleared), x, y + 34);

    // 받을 가비지 게이지 (공격 대기 중)
    if (me.pendingGarbage > 0) {
      ctx.fillStyle = COLORS.gaugeGarbage;
      ctx.font = `700 11px ${FONT}`;
      ctx.fillText('INCOMING', x, y + 66);
      const gaugeW = Math.min(me.pendingGarbage * 12, HOLD_W);
      ctx.fillRect(x, y + 72, gaugeW, 8);
      ctx.strokeStyle = '#c93d73';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y + 72, HOLD_W, 8);
    }
  }

  // ============================================
  // 상대 미니뷰
  // ============================================

  private drawOpponents(opponents: OpponentSnapshot[], spectator: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(spectator ? 'PLAYERS' : 'VS', OPP_X0, OPP_Y0 - 8);

    // 관전자는 상대가 없고 '플레이어 전원'이라 최대 4명까지 표시 (4인 게임 기준)
    const maxShow = spectator ? 4 : 3;
    const count = Math.min(opponents.length, maxShow);
    for (let i = 0; i < count; i++) {
      const opp = opponents[i]!;
      const x = OPP_X0 + i * (OPP_W + OPP_GAP);
      const y = OPP_Y0;

      // 배경
      ctx.fillStyle = COLORS.boxBg;
      ctx.fillRect(x, y, OPP_W, OPP_H);

      // 블록들 (테두리 없이 fill만 — 5px 수준이라 가독성 위해)
      for (let r = 0; r < FIELD_HEIGHT; r++) {
        const row = opp.field[r];
        if (!row) continue;
        for (let c = 0; c < FIELD_WIDTH; c++) {
          const cell = row[c];
          if (cell === null || cell === undefined) continue;
          const fill = cell === 'G' ? COLORS.garbage : PIECES[cell].color;
          ctx.fillStyle = fill;
          ctx.fillRect(x + c * OPP_CELL, y + r * OPP_CELL, OPP_CELL, OPP_CELL);
        }
      }

      // 테두리
      ctx.strokeStyle = COLORS.boxBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, OPP_W, OPP_H);

      // 닉네임
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `700 10px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(truncate(opp.nickname, 7), x + OPP_W / 2, y + OPP_H + 14);

      // 탑아웃 오버레이
      if (opp.toppedOut) {
        ctx.fillStyle = COLORS.toppedOverlay;
        ctx.fillRect(x, y, OPP_W, OPP_H);
        ctx.fillStyle = COLORS.gaugeGarbage;
        ctx.font = `900 14px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('OUT', x + OPP_W / 2, y + OPP_H / 2);
      }
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
