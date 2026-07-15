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
import { fitContain } from '../_shared/canvasFit';

// ============================================
// 레이아웃 상수
// ============================================

const CANVAS_W = 800;
const CANVAS_H = 400;

/** 메인 필드 셀 크기 (px, 논리 좌표).
 *  FIELD_HEIGHT 24 × CELL 15 = 360px 로 CANVAS_H(400) 안에 상하 여백 20px씩. */
const CELL = 15;
const FIELD_PX_W = CELL * FIELD_WIDTH;   // 150
const FIELD_PX_H = CELL * FIELD_HEIGHT;  // 360
const FIELD_X = Math.round((CANVAS_W - FIELD_PX_W) / 2);
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
// 6인까지 가로 한 줄에 들어가도록 미니뷰 셀 크기/간격 축소 (기존 5px × 4명 → 4px × 6명)
const OPP_CELL = 4;
const OPP_W = OPP_CELL * FIELD_WIDTH;    // 40
const OPP_H = OPP_CELL * FIELD_HEIGHT;   // 80
const OPP_X0 = 510;
const OPP_Y0 = 235;
const OPP_GAP = 8;

// 관전자 격자는 인원(최대 10)에 맞춰 drawSpectatorGrid 에서 cols×rows·셀 크기를 동적 계산.

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
  // 언브레이커블 — 어두운 차콜로 일반 가비지와 시각 구분 (이건 못 깨는 줄임을 명확히)
  unbreakable: '#3a3640',
  unbreakableStroke: '#1c1820',
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
   * 전체 캔버스를 2×2 격자로 잡아 최대 4명의 필드를 동시 표시한다.
   */
  render(
    me: EngineState,
    opponents: OpponentSnapshot[],
    opts: { spectator?: boolean } = {},
  ): void {
    const ctx = this.ctx;

    // 균일 스케일+레터박스 (비율 유지 → 안 찌부러짐)
    fitContain(ctx, this.canvas, CANVAS_W, CANVAS_H, COLORS.bg);

    if (opts.spectator) {
      // 관전자 모드: 캔버스 전체를 2×2 격자로 4명 표시 (미니뷰 대신)
      this.drawSpectatorGrid(opponents);
      return;
    }

    // === 플레이어 모드: 메인 필드 + HOLD/NEXT + 미니뷰 ===
    // spawn y=-1 라 piece 의 윗줄(shape row 0)이 보드 밖(row -1)에 위치하는데,
    // stroke / 격자 라인이 보드 위쪽으로 1~2px 새어 나가는 걸 막기 위해 clip 적용.
    ctx.save();
    ctx.beginPath();
    ctx.rect(FIELD_X, FIELD_Y, FIELD_PX_W, FIELD_PX_H);
    ctx.clip();

    this.drawField(me.field, FIELD_X, FIELD_Y, CELL);
    if (me.currentPiece && !me.toppedOut) {
      this.drawGhost(me.field, me.currentPiece);
      this.drawPiece(me.currentPiece, FIELD_X, FIELD_Y, CELL);
    }

    ctx.restore();

    // 필드 테두리 (clip 밖에서 그려야 테두리 자체는 보드 외곽에 정상 표시됨)
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

    // 좌측: HOLD + STATS, 우측: NEXT, 우하: 상대 미니뷰
    this.drawHoldBox(me.holdPiece, me.holdUsed);
    this.drawStats(me);
    this.drawNextBoxes(me.nextPieces);
    this.drawOpponents(opponents, false);
  }

  /** 관전자 2×2 격자 — 캔버스 전체를 4분할해 최대 4명 풀사이즈 미니 필드 표시.
   *  빈 슬롯은 점선 placeholder. */
  private drawSpectatorGrid(opponents: OpponentSnapshot[]): void {
    // 인원(최대 10)에 맞춰 격자 크기 자동 — 예: 4명 2×2, 6명 3×2, 9명 3×3, 10명 4×3
    const count = Math.max(1, Math.min(opponents.length, 10));
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const slotW = CANVAS_W / cols;
    const slotH = CANVAS_H / rows;
    const headerH = 20;
    // 슬롯 안에 필드가 들어가는 최대 셀 크기 (닉 헤더 공간 남김)
    const cell = Math.max(2, Math.floor(Math.min(
      (slotW - 16) / FIELD_WIDTH,
      (slotH - headerH - 10) / FIELD_HEIGHT,
    )));
    for (let i = 0; i < cols * rows; i++) {
      const slotX = (i % cols) * slotW;
      const slotY = Math.floor(i / cols) * slotH;
      const opp = opponents[i];
      if (!opp) this.drawSpecEmptySlot(slotX, slotY, slotW, slotH);
      else this.drawSpecPlayerSlot(opp, slotX, slotY, slotW, slotH, cell, headerH);
    }
  }

  private drawSpecEmptySlot(slotX: number, slotY: number, slotW: number, slotH: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = COLORS.boxBorder;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(slotX + 8, slotY + 8, slotW - 16, slotH - 16);
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('빈 자리', slotX + slotW / 2, slotY + slotH / 2);
  }

  private drawSpecPlayerSlot(
    opp: OpponentSnapshot,
    slotX: number, slotY: number, slotW: number, slotH: number,
    cell: number, headerH: number,
  ): void {
    const ctx = this.ctx;
    const fieldW = cell * FIELD_WIDTH;
    const fieldH = cell * FIELD_HEIGHT;
    const fieldX = slotX + (slotW - fieldW) / 2;
    const fieldY = slotY + headerH;
    const small = slotW < 250;

    // 닉네임 (필드 위 헤더)
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 ${small ? 11 : 14}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const maxNick = small ? 8 : 14;
    const nickShown = opp.nickname.length > maxNick ? opp.nickname.slice(0, maxNick - 1) + '…' : opp.nickname;
    ctx.fillText(nickShown, slotX + slotW / 2, slotY + headerH / 2 + 2);

    // 필드 (clip)
    ctx.save();
    ctx.beginPath();
    ctx.rect(fieldX, fieldY, fieldW, fieldH);
    ctx.clip();
    this.drawField(opp.field, fieldX, fieldY, cell);
    ctx.restore();

    ctx.strokeStyle = COLORS.fieldBorder;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(fieldX - 1, fieldY - 1, fieldW + 2, fieldH + 2);

    if (opp.toppedOut) {
      ctx.fillStyle = COLORS.toppedOverlay;
      ctx.fillRect(fieldX, fieldY, fieldW, fieldH);
      ctx.fillStyle = COLORS.gaugeGarbage;
      ctx.font = `900 ${small ? 15 : 22}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('OUT', fieldX + fieldW / 2, fieldY + fieldH / 2);
    }
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
    } else if (cell === 'U') {
      fill = COLORS.unbreakable;
      stroke = COLORS.unbreakableStroke;
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

    // 최대 9명(10인) 모두 표시. 6명↑이면 셀 축소 + 2행 그리드로 우측 영역에 다 담는다.
    const count = Math.min(opponents.length, 9);
    const many = count > 5;
    const cell = many ? 3 : OPP_CELL;      // 3px or 4px
    const w = cell * FIELD_WIDTH;          // 30 or 40
    const h = cell * FIELD_HEIGHT;         // 60 or 80
    const gap = many ? 6 : OPP_GAP;
    const labelH = 16;
    const perRow = many ? Math.ceil(count / 2) : count; // 6명↑ 2행 분할

    for (let i = 0; i < count; i++) {
      const opp = opponents[i]!;
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x = OPP_X0 + col * (w + gap);
      const y = OPP_Y0 + row * (h + labelH + gap);

      // 배경
      ctx.fillStyle = COLORS.boxBg;
      ctx.fillRect(x, y, w, h);

      // 블록들 (테두리 없이 fill만)
      for (let r = 0; r < FIELD_HEIGHT; r++) {
        const frow = opp.field[r];
        if (!frow) continue;
        for (let c = 0; c < FIELD_WIDTH; c++) {
          const cval = frow[c];
          if (cval === null || cval === undefined) continue;
          const fill =
            cval === 'G' ? COLORS.garbage :
            cval === 'U' ? COLORS.unbreakable :
            PIECES[cval].color;
          ctx.fillStyle = fill;
          ctx.fillRect(x + c * cell, y + r * cell, cell, cell);
        }
      }

      // 테두리
      ctx.strokeStyle = COLORS.boxBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);

      // 닉네임
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `700 ${many ? 9 : 10}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(truncate(opp.nickname, many ? 5 : 7), x + w / 2, y + h + 12);

      // 탑아웃 오버레이
      if (opp.toppedOut) {
        ctx.fillStyle = COLORS.toppedOverlay;
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = COLORS.gaugeGarbage;
        ctx.font = `900 ${many ? 11 : 14}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('OUT', x + w / 2, y + h / 2);
      }
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
