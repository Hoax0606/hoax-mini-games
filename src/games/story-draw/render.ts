/**
 * 스토리텔링 렌더러 — 전체 캔버스 1패널 그림 + 직전 컷 유령 + 슬라이드쇼.
 *
 * 그림 엔진은 draw-quiz 개선판과 동일 구조(오프스크린 누적 레이어 + flood fill + 스포이드).
 * story-draw 는 도화지가 캔버스 전체라 좌표계가 단순(논리 = 레이어 = 종이).
 *   - draw 모드: 흰 종이 → 직전 컷(유령, 옅게) → 현재 컷(레이어) → 진행 중 stroke → HUD
 *   - reveal 모드: 컷 하나를 크게 + 제시어/그린이 표시 (슬라이드쇼)
 */

import type { StrokeData } from './rules';

export const CANVAS_W = 760;
export const CANVAS_H = 480;

/** 논리 좌표가 도화지(캔버스) 안인지 */
export function isCanvasReady(x: number, y: number): boolean {
  return x >= 0 && x <= CANVAS_W && y >= 0 && y <= CANVAS_H;
}

const COLORS = {
  bg: '#fff9fd',
  paper: '#ffffff',
  paperBorder: '#d9c7ff',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  accentPink: '#ff5a92',
  accentLavender: '#9c7aeb',
  barBg: '#f0e8ff',
  barFill: '#ff82ac',
  barWarn: '#ff5a92',
  dim: 'rgba(250, 245, 255, 0.86)',
} as const;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

/** 그림판 팔레트 (도구 UI 와 공유). 흰색은 지우개라 넣지 않음 */
export const PALETTE = [
  '#1c1820', '#8a8a8a', '#c9c2cf',
  '#ff5a92', '#e2245e', '#ff9ec4',
  '#ff8a3c', '#ffb12e', '#ffe45c',
  '#2eb872', '#6ed9b3',
  '#2e6fd9', '#5b9cff', '#86c9ff',
  '#7a5fc7', '#b89aff',
  '#8b5a2b',
] as const;
/** 굵기 5단계 */
export const WIDTHS = [2, 4, 7, 12, 20] as const;
/** 지우개 굵기 */
export const ERASE_WIDTH = 26;

export interface RenderState {
  mode: 'draw' | 'reveal';
  /** draw: 현재 컷 stroke / reveal: 보여줄 컷 stroke */
  strokes: StrokeData[];
  // ── draw 모드 ──
  liveStroke?: StrokeData | null;
  /** 직전 컷 (옅게 깔아줌). 턴 0 이면 없음 */
  ghost?: StrokeData[] | null;
  /** 턴 0 제시어 (그 외엔 null) */
  promptText?: string | null;
  turn?: number;
  totalTurns?: number;
  timeLeftMs?: number;
  durationMs?: number;
  /** 내가 제출하고 다른 사람 기다리는 중 */
  submitted?: boolean;
  submittedCount?: number;
  totalPlayers?: number;
  /** 관전자 — 그리지 않고 대기 */
  spectator?: boolean;
  /** 아직 호스트 상태를 못 받은 연결 중 */
  connecting?: boolean;
  // ── reveal 모드 ──
  /** 표지 슬라이드 (제시어만 크게) */
  isCoverSlide?: boolean;
  title?: string;         // 책 제시어
  ownerNickname?: string; // 책 주인
  drawerNickname?: string;// 이 컷 그린 사람
  cutIndex?: number;      // 1-base
  cutTotal?: number;
}

export interface StoryRendererArgs {
  canvas: HTMLCanvasElement;
}

export class StoryDrawRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private scale = 1;
  private offX = 0;
  private offY = 0;

  // 현재 컷 누적 레이어(증분) — 그리는 중 성능용
  private layer: HTMLCanvasElement | null = null;
  private layerCtx: CanvasRenderingContext2D | null = null;
  private committedCount = 0;
  private lastStrokesRef: StrokeData[] | null = null;

  // 직전 컷(유령) 레이어 — 참조 바뀔 때만 재구성(정적)
  private ghostLayer: HTMLCanvasElement | null = null;
  private ghostCtx: CanvasRenderingContext2D | null = null;
  private lastGhostRef: StrokeData[] | null = null;

  constructor(args: StoryRendererArgs) {
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

  /** 화면(CSS 픽셀) → 논리 좌표 */
  screenToLogical(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.offX) / this.scale, y: (py - this.offY) / this.scale };
  }

  render(state: RenderState): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // 균일 스케일 + 레터박스 (찌부러짐 방지)
    const scale = Math.min(rect.width / CANVAS_W, rect.height / CANVAS_H);
    this.scale = scale;
    this.offX = (rect.width - CANVAS_W * scale) / 2;
    this.offY = (rect.height - CANVAS_H * scale) / 2;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, this.offX * dpr, this.offY * dpr);

    if (state.connecting) { this.drawConnecting(); return; }
    if (state.mode === 'reveal') this.drawReveal(state);
    else this.drawDrawing(state);
  }

  private drawConnecting(): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    this.drawPaperBorder();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText('연결 중', CANVAS_W / 2, CANVAS_H / 2);
  }

  // ============================================
  // draw 모드
  // ============================================

  private drawDrawing(state: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, CANVAS_W, CANVAS_H);
    ctx.clip();

    // 직전 컷 유령 (옅게)
    if (state.ghost && state.ghost.length > 0) {
      this.syncGhost(state.ghost);
      if (this.ghostLayer) {
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.drawImage(this.ghostLayer, 0, 0);
        ctx.restore();
      }
    }

    // 현재 컷
    this.syncLayer(state.strokes);
    if (this.layer) ctx.drawImage(this.layer, 0, 0);
    if (state.liveStroke && state.liveStroke.tool !== 'fill') {
      this.drawStrokeOn(ctx, state.liveStroke, false);
    }
    ctx.restore();

    // 종이 테두리
    ctx.strokeStyle = COLORS.paperBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, CANVAS_W - 2, CANVAS_H - 2);

    this.drawHud(state);
    if (state.submitted) this.drawWaitingOverlay(state);
  }

  /** 상단 HUD — 진행/타이머 + 제시어 or 이어그리기 안내 */
  private drawHud(state: RenderState): void {
    const ctx = this.ctx;
    // 타이머 바 (상단)
    const dur = state.durationMs ?? 60000;
    const left = Math.max(0, state.timeLeftMs ?? 0);
    const frac = dur > 0 ? Math.max(0, Math.min(1, left / dur)) : 0;
    const barW = 260, barH = 10, barX = (CANVAS_W - barW) / 2, barY = 14;
    ctx.fillStyle = COLORS.barBg;
    this.roundRect(barX, barY, barW, barH, 5); ctx.fill();
    ctx.fillStyle = left <= 10000 ? COLORS.barWarn : COLORS.barFill;
    this.roundRect(barX, barY, barW * frac, barH, 5); ctx.fill();

    ctx.font = `600 13px ${FONT}`;
    ctx.fillStyle = COLORS.textMuted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${(state.turn ?? 0) + 1} / ${state.totalTurns ?? 1} 컷`, barX, barY + barH + 14);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.ceil(left / 1000)}초`, barX + barW, barY + barH + 14);

    // 제시어 배너 (턴 0) or 이어그리기 안내
    ctx.textAlign = 'center';
    if (state.promptText) {
      const label = `제시어  “${state.promptText}”`;
      ctx.font = `700 20px ${FONT}`;
      const w = ctx.measureText(label).width + 36;
      const bx = (CANVAS_W - w) / 2, by = 44, bh = 34;
      ctx.fillStyle = '#fff0f6';
      this.roundRect(bx, by, w, bh, 12); ctx.fill();
      ctx.strokeStyle = COLORS.accentPink; ctx.lineWidth = 1.5;
      this.roundRect(bx, by, w, bh, 12); ctx.stroke();
      ctx.fillStyle = COLORS.accentPink;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, CANVAS_W / 2, by + bh / 2 + 1);
    } else {
      ctx.font = `600 14px ${FONT}`;
      ctx.fillStyle = COLORS.accentLavender;
      ctx.textBaseline = 'middle';
      ctx.fillText('✎ 옅게 보이는 직전 그림을 이어서 그려요', CANVAS_W / 2, 56);
    }
  }

  private drawWaitingOverlay(state: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.dim;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.accentPink;
    ctx.font = `700 28px ${FONT}`;
    ctx.fillText(state.spectator ? '관전 중 👀' : '제출 완료! ✅', CANVAS_W / 2, CANVAS_H / 2 - 16);
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `500 16px ${FONT}`;
    // 제출 수는 호스트만 정확히 알아서 그때만 (게스트는 숫자 없이 안내만)
    const countTxt = state.totalPlayers
      ? `  (${state.submittedCount ?? 0}/${state.totalPlayers})`
      : '';
    const base = state.spectator ? '모두 그리는 중이에요' : '다른 친구들을 기다리는 중';
    ctx.fillText(base + countTxt, CANVAS_W / 2, CANVAS_H / 2 + 18);
  }

  // ============================================
  // reveal 모드 (슬라이드쇼)
  // ============================================

  private drawReveal(state: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    if (state.isCoverSlide) {
      // 표지 — "OO님의 이야기" + 제시어
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `600 22px ${FONT}`;
      ctx.fillText(`${state.ownerNickname ?? ''} 님의 이야기`, CANVAS_W / 2, CANVAS_H / 2 - 40);
      ctx.fillStyle = COLORS.accentPink;
      ctx.font = `800 40px ${FONT}`;
      ctx.fillText(`“${state.title ?? ''}”`, CANVAS_W / 2, CANVAS_H / 2 + 12);
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `500 15px ${FONT}`;
      ctx.fillText('과연 어떻게 변했을까요?', CANVAS_W / 2, CANVAS_H / 2 + 58);
      this.drawPaperBorder();
      return;
    }

    // 컷 그림
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, CANVAS_W, CANVAS_H); ctx.clip();
    this.syncLayer(state.strokes);
    if (this.layer) ctx.drawImage(this.layer, 0, 0);
    ctx.restore();
    this.drawPaperBorder();

    // 상단 제시어 (작게)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(`제시어  “${state.title ?? ''}”`, CANVAS_W / 2, 12);

    // 하단 그린이 + 진행
    const cutIdx = state.cutIndex ?? 1;
    const cutTot = state.cutTotal ?? 1;
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = COLORS.accentLavender;
    ctx.font = `700 16px ${FONT}`;
    ctx.fillText(`✏️ ${state.drawerNickname ?? ''}  ·  ${cutIdx} / ${cutTot} 컷`, CANVAS_W / 2, CANVAS_H - 12);
  }

  private drawPaperBorder(): void {
    const ctx = this.ctx;
    ctx.strokeStyle = COLORS.paperBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, CANVAS_W - 2, CANVAS_H - 2);
  }

  // ============================================
  // 그림 엔진 (오프스크린 누적 레이어)
  // ============================================

  private ensureLayers(): void {
    if (!this.layer) {
      const c = document.createElement('canvas');
      c.width = CANVAS_W; c.height = CANVAS_H;
      this.layer = c; this.layerCtx = c.getContext('2d');
    }
    if (!this.ghostLayer) {
      const c = document.createElement('canvas');
      c.width = CANVAS_W; c.height = CANVAS_H;
      this.ghostLayer = c; this.ghostCtx = c.getContext('2d');
    }
  }

  /** 현재 컷 — 참조 바뀜/줄어듦이면 전체 재구성, 늘어난 만큼만 증분 commit */
  private syncLayer(strokes: StrokeData[]): void {
    this.ensureLayers();
    const lc = this.layerCtx;
    if (!lc) return;
    if (strokes !== this.lastStrokesRef || strokes.length < this.committedCount) {
      lc.clearRect(0, 0, CANVAS_W, CANVAS_H);
      this.committedCount = 0;
      for (const s of strokes) this.commitStroke(lc, s);
      this.committedCount = strokes.length;
      this.lastStrokesRef = strokes;
    } else if (strokes.length > this.committedCount) {
      for (let i = this.committedCount; i < strokes.length; i++) this.commitStroke(lc, strokes[i]!);
      this.committedCount = strokes.length;
    }
  }

  /** 유령 컷 — 참조 바뀔 때만 통째 재구성(정적) */
  private syncGhost(strokes: StrokeData[]): void {
    this.ensureLayers();
    const gc = this.ghostCtx;
    if (!gc) return;
    if (strokes === this.lastGhostRef) return;
    gc.clearRect(0, 0, CANVAS_W, CANVAS_H);
    for (const s of strokes) this.commitStroke(gc, s);
    this.lastGhostRef = strokes;
  }

  private commitStroke(ctx: CanvasRenderingContext2D, s: StrokeData): void {
    if (s.tool === 'fill') {
      const p = s.points[0];
      if (p) this.floodFill(ctx, p.x, p.y, s.color);
      return;
    }
    this.drawStrokeOn(ctx, s, true);
  }

  /**
   * stroke 를 ctx 에 그린다.
   * @param onLayer true=누적 레이어(투명 배경, 지우개는 destination-out 로 진짜 투명)
   *                false=화면 live 미리보기(지우개는 종이색 덧칠)
   */
  private drawStrokeOn(ctx: CanvasRenderingContext2D, s: StrokeData, onLayer: boolean): void {
    if (s.points.length === 0 || s.tool === 'fill') return;
    const shape = s.shape ?? 'free';
    ctx.save();
    if (s.tool === 'eraser') {
      if (onLayer) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.fillStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.strokeStyle = COLORS.paper;
        ctx.fillStyle = COLORS.paper;
      }
    } else {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      if (s.tool === 'marker') ctx.globalAlpha = 0.4;
    }
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (shape !== 'free' && s.points.length >= 2) {
      const a = s.points[0]!;
      const b = s.points[s.points.length - 1]!;
      ctx.beginPath();
      if (shape === 'line') {
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      } else if (shape === 'rect') {
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else if (shape === 'ellipse') {
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        ctx.ellipse(cx, cy, Math.max(1, Math.abs(b.x - a.x) / 2), Math.max(1, Math.abs(b.y - a.y) / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    ctx.beginPath();
    const p0 = s.points[0]!;
    ctx.moveTo(p0.x, p0.y);
    if (s.points.length === 1) ctx.lineTo(p0.x + 0.1, p0.y + 0.1);
    else for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i]!.x, s.points[i]!.y);
    ctx.stroke();
    ctx.restore();
  }

  /** 채우기 — BFS flood fill (경계 tolerance 로 안티에일리어싱 대응) */
  private floodFill(ctx: CanvasRenderingContext2D, fx: number, fy: number, hex: string): void {
    const W = CANVAS_W, H = CANVAS_H;
    const sx = Math.round(fx), sy = Math.round(fy);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const si = (sy * W + sx) * 4;
    const sr = d[si]!, sg = d[si + 1]!, sb = d[si + 2]!, sa = d[si + 3]!;
    const [nr, ng, nb] = hexToRgb(hex);
    if (sa === 255 && Math.abs(sr - nr) < 4 && Math.abs(sg - ng) < 4 && Math.abs(sb - nb) < 4) return;
    const tol = 48;
    const seen = new Uint8Array(W * H);
    const stack: number[] = [sy * W + sx];
    while (stack.length) {
      const q = stack.pop()!;
      if (seen[q]) continue;
      seen[q] = 1;
      const i = q * 4;
      if (Math.abs(d[i]! - sr) > tol || Math.abs(d[i + 1]! - sg) > tol
        || Math.abs(d[i + 2]! - sb) > tol || Math.abs(d[i + 3]! - sa) > tol) continue;
      d[i] = nr; d[i + 1] = ng; d[i + 2] = nb; d[i + 3] = 255;
      const x = q % W, y = (q - x) / W;
      if (x > 0) stack.push(q - 1);
      if (x < W - 1) stack.push(q + 1);
      if (y > 0) stack.push(q - W);
      if (y < H - 1) stack.push(q + W);
    }
    ctx.putImageData(img, 0, 0);
  }

  /** 스포이드 — 현재 컷 레이어 픽셀 색. 투명(빈 곳)이면 흰색 */
  getPixelColor(x: number, y: number): string {
    this.ensureLayers();
    const lc = this.layerCtx;
    if (!lc) return '#000000';
    const sx = Math.round(x), sy = Math.round(y);
    if (sx < 0 || sy < 0 || sx >= CANVAS_W || sy >= CANVAS_H) return '#ffffff';
    const d = lc.getImageData(sx, sy, 1, 1).data;
    if (d[3]! < 10) return '#ffffff';
    return rgbToHex(d[0]!, d[1]!, d[2]!);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}

// ── 색 변환 헬퍼 ──
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  if (h.length !== 6) return [0, 0, 0];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
