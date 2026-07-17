/**
 * 배틀 테트리스 Canvas 렌더러
 *
 * 레이아웃 (논리폭은 인원수에 따라 가변, 높이는 420 고정):
 *   ┌──────────────────────────────────────────────────────┐
 *   │ HOLD │ ▏      MAIN FIELD       │ NEXT  │  상대 그리드   │
 *   │[4×4] │ ▏      10 × 24          │[2조각]│ [mini][mini]  │
 *   │      │ ▏      cell 16px        │       │ [mini][mini]  │
 *   └──────────────────────────────────────────────────────┘
 *
 * - 필드 오른쪽 끝에 붙은 얇은 바 = 받을 가비지 경고 게이지.
 * - 우측 상대 그리드는 살아있는 상대 수만큼만 폭을 차지 → 솔로면 아예 숨겨
 *   빈 공간이 안 생긴다(논리폭 W를 매 프레임 계산해 fitContain에 넘김).
 * - "지운 줄(LINES)"은 게임 끝나고 결과창에서 보여주므로 인게임 HUD에선 뺐다.
 */

import { PIECES, forEachMino, type PieceId, type PieceState } from './pieces';
import { FIELD_WIDTH, FIELD_HEIGHT, dropDistance, type Cell, type Field } from './field';
import type { EngineState } from './engine';
import { fitContain } from '../_shared/canvasFit';

// ============================================
// 레이아웃 상수 (논리 좌표)
// ============================================

/** 메인 필드 셀 크기. 24행 × 16px = 384px. */
const CELL = 16;
const FIELD_W_PX = CELL * FIELD_WIDTH;   // 160
const FIELD_H_PX = CELL * FIELD_HEIGHT;  // 384
const MARGIN = 18;
const CANVAS_H = FIELD_H_PX + MARGIN * 2; // 420 (고정)

/** 관전자 2×2~4×3 격자 모드의 논리폭 (고정, 넓게). */
const SPEC_W = 660;

const HOLD_CELL = 16;
const HOLD_BOX = HOLD_CELL * 4;  // 64
const NEXT_CELL = 15;
const NEXT_BOX_W = NEXT_CELL * 4; // 60
/** NEXT 직사각형 하나에 다음 2조각을 세로로. */
const NEXT_PIECE_H = NEXT_CELL * 4;      // 60
const NEXT_INNER_GAP = 10;
const NEXT_BOX_H = NEXT_PIECE_H * 2 + NEXT_INNER_GAP; // 130

// 고정 x 위치 (HOLD → 필드 → NEXT 까지는 인원수와 무관하게 고정)
const HOLD_X = MARGIN;                          // 18
const GARBAGE_BAR_W = 6;
const FIELD_X = HOLD_X + HOLD_BOX + 22;          // 104
// 필드 오른쪽 끝(+3)에 가비지 바를 붙이므로 NEXT 는 바 폭만큼 더 띄운다
const NEXT_X = FIELD_X + FIELD_W_PX + GARBAGE_BAR_W + 16; // 286
const OPP_AREA_X = NEXT_X + NEXT_BOX_W + 22;      // 368

const COLORS = {
  bg: '#fff7fb',
  gridLine: '#efe6f7',
  fieldBg: '#faf5ff',
  panelFill: 'rgba(255, 255, 255, 0.62)',
  panelBorder: '#e2d3f2',
  fieldBorder: '#c3a9f0',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  garbage: '#a8a4b0',
  garbageStroke: '#6a6670',
  // 언브레이커블 — 어두운 차콜로 일반 가비지와 시각 구분 (이건 못 깨는 줄임을 명확히)
  unbreakable: '#3a3640',
  unbreakableStroke: '#1c1820',
  ghost: 'rgba(74, 58, 74, 0.16)',
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

/** 우측 상대 그리드 배치 정보 (인원수로 계산). */
interface OppLayout {
  cols: number;
  rows: number;
  areaW: number;
  count: number;
}

/** 살아있는(표시할) 상대 수로 우측 그리드 폭/열 계산. 0명이면 null(=숨김). */
function computeOppLayout(count: number): OppLayout | null {
  if (count <= 0) return null;
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);
  // 열 수에 따라 우측 영역 폭 고정 — 셀 크기는 이 안에서 자동으로 맞춤
  const areaW = cols === 1 ? 132 : cols === 2 ? 188 : 240;
  return { cols, rows, areaW, count };
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
  // 방금 공격받아 올라온 방해줄 강조 플래시 (index.ts가 flashGarbage로 트리거)
  private flashRows = 0;
  private flashStart = 0;

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

  /** 방금 바닥에서 올라온 방해줄 count개를 잠깐 핑크로 강조. index.ts의 garbage 이벤트에서 호출. */
  flashGarbage(count: number): void {
    this.flashRows = Math.min(count, FIELD_HEIGHT);
    this.flashStart = performance.now();
  }

  /** 매 프레임 호출.
   *
   * opts.spectator = true 일 땐 "나" 관점 UI를 그리지 않고 전체 캔버스를
   * 격자로 잡아 모든 플레이어 필드를 동시 표시한다.
   */
  render(
    me: EngineState,
    opponents: OpponentSnapshot[],
    opts: { spectator?: boolean } = {},
  ): void {
    const ctx = this.ctx;

    if (opts.spectator) {
      fitContain(ctx, this.canvas, SPEC_W, CANVAS_H, COLORS.bg);
      this.drawSpectatorGrid(opponents, SPEC_W, CANVAS_H);
      return;
    }

    // === 플레이어 모드 ===
    const count = Math.min(opponents.length, 9);
    const opp = computeOppLayout(count);
    // 상대가 있으면 우측 그리드 폭까지, 없으면 NEXT 까지만 → 솔로 시 빈 공간 없음
    const logicalW = opp
      ? OPP_AREA_X + opp.areaW + MARGIN
      : NEXT_X + NEXT_BOX_W + MARGIN;

    fitContain(ctx, this.canvas, logicalW, CANVAS_H, COLORS.bg);

    // 필드 (clip — spawn 시 보드 밖으로 새는 stroke 방지)
    ctx.save();
    ctx.beginPath();
    ctx.rect(FIELD_X, MARGIN, FIELD_W_PX, FIELD_H_PX);
    ctx.clip();
    this.drawField(me.field, FIELD_X, MARGIN, CELL);
    if (me.currentPiece && !me.toppedOut) {
      this.drawGhost(me.field, me.currentPiece, FIELD_X, MARGIN);
      this.drawPiece(me.currentPiece, FIELD_X, MARGIN, CELL);
    }
    ctx.restore();

    // 필드 테두리 — 스택이 천장 근처면 빨갛게 경고
    const danger = !me.toppedOut && this.stackNearTop(me.field);
    ctx.save();
    if (danger) {
      ctx.strokeStyle = COLORS.gaugeGarbage;
      ctx.lineWidth = 3;
      ctx.shadowColor = 'rgba(255, 90, 146, 0.6)';
      ctx.shadowBlur = 10;
    } else {
      ctx.strokeStyle = COLORS.fieldBorder;
      ctx.lineWidth = 2;
    }
    this.roundStroke(FIELD_X - 1, MARGIN - 1, FIELD_W_PX + 2, FIELD_H_PX + 2, 8);
    ctx.restore();

    // 방금 올라온 방해줄 플래시 (필드 영역 안이라 clip 불필요)
    this.drawGarbageFlash();

    // 탑아웃 오버레이
    if (me.toppedOut) {
      ctx.fillStyle = COLORS.toppedOverlay;
      ctx.fillRect(FIELD_X, MARGIN, FIELD_W_PX, FIELD_H_PX);
      ctx.fillStyle = COLORS.gaugeGarbage;
      ctx.font = `900 28px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GAME OVER', FIELD_X + FIELD_W_PX / 2, MARGIN + FIELD_H_PX / 2);
    }

    this.drawHoldBox(me.holdPiece, me.holdUsed);
    this.drawGarbageBar(me.pendingGarbage);
    this.drawNextBox(me.nextPieces);
    if (opp) this.drawOpponents(opponents, opp);
  }

  // ============================================
  // 관전자 격자
  // ============================================

  /** 관전자: 캔버스 전체를 인원수에 맞춘 격자로 나눠 모든 필드 표시. */
  private drawSpectatorGrid(opponents: OpponentSnapshot[], W: number, H: number): void {
    const count = Math.max(1, Math.min(opponents.length, 10));
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const slotW = W / cols;
    const slotH = H / rows;
    const headerH = 20;
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
    ctx.strokeStyle = COLORS.panelBorder;
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

    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 ${small ? 11 : 14}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const maxNick = small ? 8 : 14;
    const nickShown = opp.nickname.length > maxNick ? opp.nickname.slice(0, maxNick - 1) + '…' : opp.nickname;
    ctx.fillText(nickShown, slotX + slotW / 2, slotY + headerH / 2 + 2);

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

    ctx.fillStyle = COLORS.fieldBg;
    ctx.fillRect(x0, y0, w, h);

    // 빈 칸 격자선 (옅게) — 블록 자체는 칸마다 나뉜 둥근 입체
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

  /** 한 셀을 그림. cell은 PieceId, 'G'(가비지), 'U'(언브레이커블) */
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

    // 모서리 살짝만 둥글린 또렷한 블록. 얇은 여백으로 칸 구분 + 진한 외곽선으로 경계 확실히.
    const r = Math.max(1.5, size * 0.14);
    const inset = size >= 12 ? 0.75 : 0.5; // 셀 사이 얇은 여백 → 블록 분리
    const bx = x + inset, by = y + inset, bs = size - inset * 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bs, bs, r);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (size >= 12) {
      // 상단 하이라이트 (빛 받는 면)
      ctx.beginPath();
      ctx.roundRect(bx + 1.5, by + 1.5, bs - 3, bs * 0.3, r * 0.7);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
      ctx.fill();
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

  /** 고스트 피스: 하드드롭 착지 위치를 반투명으로 표시 */
  private drawGhost(field: Field, piece: PieceState, fieldX: number, fieldY: number): void {
    const dist = dropDistance(field, piece);
    if (dist === 0) return;
    const ctx = this.ctx;
    const shape = PIECES[piece.id].shapes[piece.rotation];
    ctx.fillStyle = COLORS.ghost;
    forEachMino(shape, (dx, dy) => {
      const col = piece.x + dx;
      const row = piece.y + dist + dy;
      if (row >= 0) {
        ctx.fillRect(fieldX + col * CELL + 1, fieldY + row * CELL + 1, CELL - 2, CELL - 2);
      }
    });
  }

  // ============================================
  // HOLD / NEXT / 가비지 바
  // ============================================

  /** 프로스티드풍 패널(반투명 흰 라운드 박스). */
  private drawPanel(x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 12);
    ctx.fillStyle = COLORS.panelFill;
    ctx.fill();
    ctx.strokeStyle = COLORS.panelBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** 방금 올라온 방해줄을 0.5초간 핑크로 페이드아웃 강조 (필드 하단 flashRows줄). */
  private drawGarbageFlash(): void {
    if (this.flashRows <= 0) return;
    const DUR = 500;
    const t = (performance.now() - this.flashStart) / DUR;
    if (t >= 1) { this.flashRows = 0; return; }
    const ctx = this.ctx;
    const h = this.flashRows * CELL;
    const y = MARGIN + FIELD_H_PX - h;
    ctx.save();
    ctx.fillStyle = `rgba(255, 90, 146, ${(1 - t) * 0.6})`;
    ctx.fillRect(FIELD_X, y, FIELD_W_PX, h);
    // 올라온 경계선을 밝게 한 줄
    ctx.strokeStyle = `rgba(255, 120, 170, ${(1 - t) * 0.9})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(FIELD_X, y + 1);
    ctx.lineTo(FIELD_X + FIELD_W_PX, y + 1);
    ctx.stroke();
    ctx.restore();
  }

  /** 상단 3행 안에 고정 블록이 있으면 "위험"(천장 근처). */
  private stackNearTop(field: Field): boolean {
    for (let r = 0; r < 3; r++) {
      const row = field[r];
      if (row && row.some((c) => c !== null && c !== undefined)) return true;
    }
    return false;
  }

  private roundStroke(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.stroke();
  }

  private drawLabel(text: string, x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `800 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y);
  }

  private drawHoldBox(holdPiece: PieceId | null, used: boolean): void {
    const ctx = this.ctx;
    this.drawLabel('HOLD', HOLD_X + 2, MARGIN - 5);
    this.drawPanel(HOLD_X, MARGIN, HOLD_BOX, HOLD_BOX);
    if (holdPiece) {
      ctx.globalAlpha = used ? 0.35 : 1;
      this.drawPieceInBox(holdPiece, HOLD_X, MARGIN, HOLD_CELL);
      ctx.globalAlpha = 1;
    }
  }

  private drawNextBox(nextPieces: PieceId[]): void {
    this.drawLabel('NEXT', NEXT_X + 2, MARGIN - 5);
    this.drawPanel(NEXT_X, MARGIN, NEXT_BOX_W, NEXT_BOX_H);
    // 직사각형 하나에 다음 2조각을 세로로
    for (let i = 0; i < Math.min(2, nextPieces.length); i++) {
      const y = MARGIN + i * (NEXT_PIECE_H + NEXT_INNER_GAP);
      this.drawPieceInBox(nextPieces[i]!, NEXT_X, y, NEXT_CELL);
    }
  }

  /** 받을 가비지 경고 — 필드 오른쪽 끝에 딱 붙는 얇은 세로 바(아래→위로 차오름). */
  private drawGarbageBar(pending: number): void {
    const ctx = this.ctx;
    const x = FIELD_X + FIELD_W_PX + 3;
    const top = MARGIN;
    const full = FIELD_H_PX;
    // 트랙
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    ctx.beginPath();
    ctx.roundRect(x, top, GARBAGE_BAR_W, full, 3);
    ctx.fill();
    if (pending > 0) {
      const h = Math.min(full, (full / FIELD_HEIGHT) * pending);
      ctx.fillStyle = COLORS.gaugeGarbage;
      ctx.beginPath();
      ctx.roundRect(x, top + full - h, GARBAGE_BAR_W, h, 3);
      ctx.fill();
    }
  }

  /** 4×4 영역에 피스 shape(rotation 0)을 중앙정렬로 그림 */
  private drawPieceInBox(pieceId: PieceId, x0: number, y0: number, cellSize: number): void {
    const shape = PIECES[pieceId].shapes[0];
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

  // ============================================
  // 상대 미니 그리드 (우측)
  // ============================================

  private drawOpponents(opponents: OpponentSnapshot[], opp: OppLayout): void {
    const ctx = this.ctx;
    this.drawLabel(`상대 ${opp.count}명`, OPP_AREA_X + 2, MARGIN - 5);

    const gap = 8;
    const labelH = 14;
    const slotW = (opp.areaW - (opp.cols - 1) * gap) / opp.cols;
    const slotH = (FIELD_H_PX - (opp.rows - 1) * gap) / opp.rows;
    // 슬롯 안에 필드가 다 들어가는 최대 셀 크기 (닉 라벨 공간 남김)
    const cell = Math.max(2, Math.floor(Math.min(
      slotW / FIELD_WIDTH,
      (slotH - labelH) / FIELD_HEIGHT,
    )));
    const fieldW = cell * FIELD_WIDTH;
    const fieldH = cell * FIELD_HEIGHT;

    for (let i = 0; i < opp.count; i++) {
      const o = opponents[i]!;
      const col = i % opp.cols;
      const row = Math.floor(i / opp.cols);
      const slotX = OPP_AREA_X + col * (slotW + gap);
      const slotY = MARGIN + row * (slotH + gap);
      const fx = slotX + (slotW - fieldW) / 2;
      const fy = slotY + labelH;

      // 닉네임
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `700 10px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(truncate(o.nickname, cell < 8 ? 5 : 7), slotX + slotW / 2, slotY + 10);

      // 필드 배경 + 블록 (작아서 테두리 없이 fill만)
      ctx.fillStyle = COLORS.fieldBg;
      ctx.fillRect(fx, fy, fieldW, fieldH);
      for (let r = 0; r < FIELD_HEIGHT; r++) {
        const frow = o.field[r];
        if (!frow) continue;
        for (let c = 0; c < FIELD_WIDTH; c++) {
          const cval = frow[c];
          if (cval === null || cval === undefined) continue;
          ctx.fillStyle =
            cval === 'G' ? COLORS.garbage :
            cval === 'U' ? COLORS.unbreakable :
            PIECES[cval].color;
          ctx.fillRect(fx + c * cell, fy + r * cell, cell, cell);
        }
      }
      ctx.strokeStyle = COLORS.panelBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(fx, fy, fieldW, fieldH);

      if (o.toppedOut) {
        ctx.fillStyle = COLORS.toppedOverlay;
        ctx.fillRect(fx, fy, fieldW, fieldH);
        ctx.fillStyle = COLORS.gaugeGarbage;
        ctx.font = `900 ${cell < 8 ? 12 : 15}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('OUT', fx + fieldW / 2, fy + fieldH / 2);
      }
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
