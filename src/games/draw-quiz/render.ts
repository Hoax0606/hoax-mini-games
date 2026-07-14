/**
 * 그림 퀴즈 Canvas 렌더러
 *
 * 레이아웃 (800×400 논리 좌표):
 *   ┌──────────────────────────────┬────────────────────┐
 *   │                              │  🕒 60   R 2/4      │
 *   │     그림 영역                 │  ─────────────────  │
 *   │     (흰 도화지)               │  제시어: _ _ _      │
 *   │     0~DRAW_W                  │  ─────────────────  │
 *   │                              │  점수판             │
 *   │                              │  OOO  120           │
 *   └──────────────────────────────┴────────────────────┘
 *
 * stroke 누적:
 *   render 는 game state + strokes 배열을 받아 매 프레임 전체 다시 그림.
 *   stroke 가 많아지면 비효율적이지만 한 라운드 그림이라 수백 개 수준 — 무시 가능.
 *   (성능 이슈 시 offscreen canvas 캐싱 가능. 일단 단순하게.)
 *
 * 그리기 도구 UI(펜/색/굵기/지우개/전체지우기) 는 canvas 외부 HTML — index.ts 가 마운트.
 */

import {
  type DrawQuizGame,
  ROUND_DURATION_MS,
} from './rules';
import type { StrokeData } from './netSync';

const CANVAS_W = 800;
const CANVAS_H = 400;

/** 그림 영역 (좌측). 우측은 정보 패널. */
export const DRAW_X = 0;
export const DRAW_Y = 0;
export const DRAW_W = 560;
export const DRAW_H = 400;

const PANEL_X = DRAW_W;
const PANEL_W = CANVAS_W - DRAW_W;

const COLORS = {
  bg: '#fff9fd',
  paper: '#ffffff',
  paperBorder: '#d9c7ff',
  panelBg: '#faf5ff',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  accentPink: '#ff5a92',
  accentLavender: '#9c7aeb',
  timerRingBg: '#f0e8ff',
  timerRingFill: '#ff82ac',
  timerRingWarn: '#ff5a92',
  scoreMe: '#ff5a92',
  scoreRow: '#fff5f8',
  drawerBadge: '#6ed9b3',
} as const;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

/** 그림판 팔레트 (도구 UI 와 공유). 흰색은 지우개라 넣지 않음 */
export const PALETTE = [
  '#1c1820', '#8a8a8a', '#c9c2cf', // 검정/회색/연회색
  '#ff5a92', '#e2245e', '#ff9ec4', // 핑크/빨강/연핑크
  '#ff8a3c', '#ffb12e', '#ffe45c', // 주황/노랑/연노랑
  '#2eb872', '#6ed9b3',            // 초록/민트
  '#2e6fd9', '#5b9cff', '#86c9ff', // 파랑/하늘/연하늘
  '#7a5fc7', '#b89aff',            // 보라/라벤더
  '#8b5a2b',                        // 갈색
] as const;
/** 굵기 5단계 */
export const WIDTHS = [2, 4, 7, 12, 20] as const;

// ============================================
// 좌표 변환 — 마우스 픽셀 → 그림 논리 좌표 (0~DRAW_W, 0~DRAW_H)
// ============================================

export function canvasToDraw(px: number, py: number, rect: DOMRect): { x: number; y: number } {
  const x = px * (CANVAS_W / rect.width);
  const y = py * (CANVAS_H / rect.height);
  return { x, y };
}

export function isInDrawArea(x: number, y: number): boolean {
  return x >= DRAW_X && x <= DRAW_X + DRAW_W && y >= DRAW_Y && y <= DRAW_Y + DRAW_H;
}

// ============================================
// Renderer
// ============================================

export interface RenderState {
  game: DrawQuizGame;
  myPeerId: string;
  isSpectator: boolean;
  /** 완료된 stroke 들 */
  strokes: StrokeData[];
  /** 현재 그리는 중인 미완성 stroke (출제자 본인 로컬 프리뷰) */
  liveStroke: StrokeData | null;
  now: number;
  /** 후보 단어 (출제자 choosing 단계에서만). 비출제자는 빈 배열 */
  candidates: string[];
  /** 라운드 결과 단계에서 공개되는 정답 */
  revealedWord: string | null;
}

export interface DrawQuizRendererArgs {
  canvas: HTMLCanvasElement;
}

export class DrawQuizRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  // 마지막 render 의 논리→화면 변환 (입력 역변환용, CSS 픽셀 기준)
  private scale = 1;
  private offX = 0;
  private offY = 0;

  // offscreen 누적 레이어 — 확정된 stroke 를 여기 그려두고 매 프레임 blit.
  //   채우기(flood fill)가 픽셀 조작이라 매 프레임 벡터 재렌더로는 불가 → 레이어 필수.
  private layer: HTMLCanvasElement | null = null;
  private layerCtx: CanvasRenderingContext2D | null = null;
  private committedCount = 0;
  private lastStrokesRef: StrokeData[] | null = null;

  /** 화면(rect 내 CSS 픽셀) 좌표 → 그림 논리 좌표 (0~CANVAS_W, 0~CANVAS_H) */
  screenToLogical(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.offX) / this.scale, y: (py - this.offY) / this.scale };
  }

  constructor(args: DrawQuizRendererArgs) {
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

  render(state: RenderState): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // 균일 스케일 + 레터박스 — 캔버스 박스 비율이 2:1 이 아니어도 안 눌리게(찌부러짐 방지)
    const scale = Math.min(rect.width / CANVAS_W, rect.height / CANVAS_H);
    this.scale = scale;
    this.offX = (rect.width - CANVAS_W * scale) / 2;
    this.offY = (rect.height - CANVAS_H * scale) / 2;
    // 레터박스 여백 배경
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, this.offX * dpr, this.offY * dpr);

    // 배경
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // 도화지 + 그림
    this.drawPaper(state);

    // 우측 패널
    this.drawPanel(state);
  }

  // ============================================
  // 도화지 + stroke
  // ============================================

  private drawPaper(state: RenderState): void {
    const ctx = this.ctx;

    // 흰 도화지
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(DRAW_X, DRAW_Y, DRAW_W, DRAW_H);

    // 확정 stroke 는 누적 레이어에서 blit, 진행 중(live) stroke 만 실시간 미리보기.
    //   clip 으로 도화지 밖 넘침 방지.
    ctx.save();
    ctx.beginPath();
    ctx.rect(DRAW_X, DRAW_Y, DRAW_W, DRAW_H);
    ctx.clip();

    this.syncLayer(state.strokes);
    if (this.layer) ctx.drawImage(this.layer, DRAW_X, DRAW_Y);
    // live stroke 는 아직 레이어에 없음 → 화면에만 임시로. 채우기는 미리보기 안 함(commit 시점에만).
    if (state.liveStroke && state.liveStroke.tool !== 'fill') {
      this.drawStrokeOn(ctx, state.liveStroke, false);
    }

    ctx.restore();

    // 도화지 테두리
    ctx.strokeStyle = COLORS.paperBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(DRAW_X + 1, DRAW_Y + 1, DRAW_W - 2, DRAW_H - 2);

    // 그림 영역 오버레이 — choosing / round_result 단계
    if (state.game.phase === 'choosing') {
      this.drawChoosingOverlay(state);
    } else if (state.game.phase === 'round_result' || state.game.phase === 'ended') {
      this.drawResultOverlay(state);
    }
  }

  // ---- offscreen 누적 레이어 관리 ----

  private ensureLayer(): void {
    if (this.layer) return;
    const c = document.createElement('canvas');
    c.width = DRAW_W;
    c.height = DRAW_H;
    this.layer = c;
    this.layerCtx = c.getContext('2d');
  }

  /**
   * state.strokes 를 레이어에 반영.
   *   - 배열 참조가 바뀌었거나(라운드 리셋/undo 로 새 배열) 길이가 줄었으면 전체 재구성.
   *   - 길이만 늘었으면 새로 추가된 stroke 만 증분 commit (매 프레임 전체 재렌더 방지 = 성능).
   */
  private syncLayer(strokes: StrokeData[]): void {
    this.ensureLayer();
    const lc = this.layerCtx;
    if (!lc) return;
    if (strokes !== this.lastStrokesRef || strokes.length < this.committedCount) {
      lc.clearRect(0, 0, DRAW_W, DRAW_H);
      this.committedCount = 0;
      for (const s of strokes) this.commitStroke(s);
      this.committedCount = strokes.length;
      this.lastStrokesRef = strokes;
    } else if (strokes.length > this.committedCount) {
      for (let i = this.committedCount; i < strokes.length; i++) this.commitStroke(strokes[i]!);
      this.committedCount = strokes.length;
    }
  }

  /** stroke 하나를 레이어에 확정 반영. 채우기는 flood fill, 나머지는 경로 렌더. */
  private commitStroke(s: StrokeData): void {
    const lc = this.layerCtx;
    if (!lc) return;
    if (s.tool === 'fill') {
      const p = s.points[0];
      if (p) this.floodFill(p.x, p.y, s.color);
      return;
    }
    this.drawStrokeOn(lc, s, true);
  }

  /**
   * stroke 를 임의 ctx 에 그린다.
   * @param onLayer true면 레이어(투명 배경)에 그림 → 지우개는 destination-out 로 진짜 투명 구멍.
   *                false면 화면(live 미리보기) → 지우개는 종이색으로 덧칠.
   */
  private drawStrokeOn(ctx: CanvasRenderingContext2D, s: StrokeData, onLayer: boolean): void {
    if (s.points.length === 0 || s.tool === 'fill') return;
    const shape = s.shape ?? 'free';
    ctx.save();

    if (s.tool === 'eraser') {
      if (onLayer) {
        ctx.globalCompositeOperation = 'destination-out'; // 레이어에서 실제로 뚫음
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.fillStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.strokeStyle = COLORS.paper; // 미리보기는 종이색
        ctx.fillStyle = COLORS.paper;
      }
    } else {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      if (s.tool === 'marker') ctx.globalAlpha = 0.4; // 형광펜 반투명
    }
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 도형 — 시작점~끝점 기준 (펜/마커만 도형 지원)
    if (shape !== 'free' && s.points.length >= 2) {
      const a = s.points[0]!;
      const b = s.points[s.points.length - 1]!;
      ctx.beginPath();
      if (shape === 'line') {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
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

    // 자유선
    ctx.beginPath();
    const p0 = s.points[0]!;
    ctx.moveTo(p0.x, p0.y);
    if (s.points.length === 1) {
      ctx.lineTo(p0.x + 0.1, p0.y + 0.1); // 점 하나
    } else {
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i]!.x, s.points[i]!.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 채우기(flood fill) — 레이어 픽셀을 BFS 로 칠한다.
   * 시작 픽셀과 색이 비슷한(tolerance 이내) 인접 픽셀을 이어서 새 색으로.
   * 안티에일리어싱 경계 때문에 약간의 tolerance 를 준다.
   */
  private floodFill(fx: number, fy: number, hex: string): void {
    const lc = this.layerCtx;
    if (!lc) return;
    const W = DRAW_W, H = DRAW_H;
    const sx = Math.round(fx), sy = Math.round(fy);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;

    const img = lc.getImageData(0, 0, W, H);
    const d = img.data;
    const si = (sy * W + sx) * 4;
    const sr = d[si]!, sg = d[si + 1]!, sb = d[si + 2]!, sa = d[si + 3]!;
    const [nr, ng, nb] = hexToRgb(hex);
    // 이미 목표색이면 무한루프 방지 위해 종료
    if (sa === 255 && Math.abs(sr - nr) < 4 && Math.abs(sg - ng) < 4 && Math.abs(sb - nb) < 4) return;

    const tol = 48;
    const seen = new Uint8Array(W * H);
    const stack: number[] = [sy * W + sx];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen[p]) continue;
      seen[p] = 1;
      const i = p * 4;
      if (
        Math.abs(d[i]! - sr) > tol ||
        Math.abs(d[i + 1]! - sg) > tol ||
        Math.abs(d[i + 2]! - sb) > tol ||
        Math.abs(d[i + 3]! - sa) > tol
      ) continue;
      d[i] = nr; d[i + 1] = ng; d[i + 2] = nb; d[i + 3] = 255;
      const x = p % W, y = (p - x) / W;
      if (x > 0) stack.push(p - 1);
      if (x < W - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - W);
      if (y < H - 1) stack.push(p + W);
    }
    lc.putImageData(img, 0, 0);
  }

  /** 스포이드 — 현재 레이어의 픽셀 색을 hex 로 반환. 투명(빈 도화지)이면 흰색. */
  getPixelColor(x: number, y: number): string {
    this.ensureLayer();
    const lc = this.layerCtx;
    if (!lc) return '#000000';
    const sx = Math.round(x), sy = Math.round(y);
    if (sx < 0 || sy < 0 || sx >= DRAW_W || sy >= DRAW_H) return '#ffffff';
    const d = lc.getImageData(sx, sy, 1, 1).data;
    if (d[3]! < 10) return '#ffffff'; // 투명 = 흰 도화지
    return rgbToHex(d[0]!, d[1]!, d[2]!);
  }

  /** 출제자 단어 선택 중 — 그림 영역에 안내 */
  private drawChoosingOverlay(state: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(250, 245, 255, 0.92)';
    ctx.fillRect(DRAW_X, DRAW_Y, DRAW_W, DRAW_H);

    const cx = DRAW_X + DRAW_W / 2;
    const isDrawer = state.game.drawerPeerId === state.myPeerId;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (isDrawer) {
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `800 22px ${FONT}`;
      ctx.fillText('🎨 그릴 단어를 골라요', cx, 80);
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `500 14px ${FONT}`;
      ctx.fillText('아래 버튼에서 하나 선택', cx, 110);
      // 후보 단어는 HTML 버튼으로 — index.ts. 여기선 안내만.
    } else {
      const drawer = state.game.players.find((p) => p.peerId === state.game.drawerPeerId);
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `800 22px ${FONT}`;
      ctx.fillText('✏️', cx, DRAW_H / 2 - 24);
      ctx.font = `700 18px ${FONT}`;
      ctx.fillText(`${drawer?.nickname ?? '출제자'} 님이`, cx, DRAW_H / 2 + 6);
      ctx.fillText('단어를 고르고 있어요…', cx, DRAW_H / 2 + 32);
    }
  }

  /** 라운드 결과 — 정답 공개 오버레이 */
  private drawResultOverlay(state: RenderState): void {
    if (!state.revealedWord) return;
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(54, 36, 56, 0.55)';
    ctx.fillRect(DRAW_X, DRAW_Y, DRAW_W, DRAW_H);

    const cx = DRAW_X + DRAW_W / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = `600 16px ${FONT}`;
    ctx.fillText('정답은', cx, DRAW_H / 2 - 36);
    ctx.fillStyle = COLORS.accentPink;
    ctx.font = `900 44px ${FONT}`;
    ctx.fillText(state.revealedWord, cx, DRAW_H / 2 + 8);

    if (state.game.phase === 'ended') {
      ctx.fillStyle = '#fff';
      ctx.font = `700 15px ${FONT}`;
      ctx.fillText('🏁 게임 종료!', cx, DRAW_H / 2 + 54);
    }
  }

  // ============================================
  // 우측 패널 — 타이머/제시어/점수
  // ============================================

  private drawPanel(state: RenderState): void {
    const ctx = this.ctx;
    const game = state.game;

    // 패널 배경
    ctx.fillStyle = COLORS.panelBg;
    ctx.fillRect(PANEL_X, 0, PANEL_W, CANVAS_H);

    // 타이머 ring + 라운드 (상단)
    const ringCx = PANEL_X + PANEL_W / 2;
    const ringCy = 50;
    const ringR = 30;
    const drawing = game.phase === 'drawing';
    const elapsed = drawing ? Math.max(0, state.now - game.turnStartedAt) : 0;
    const remaining = Math.max(0, ROUND_DURATION_MS - elapsed);
    const ratio = remaining / ROUND_DURATION_MS;
    const remainSec = Math.ceil(remaining / 1000);

    ctx.strokeStyle = COLORS.timerRingBg;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(ringCx, ringCy, ringR, 0, Math.PI * 2);
    ctx.stroke();

    if (drawing) {
      ctx.strokeStyle = remainSec <= 10 ? COLORS.timerRingWarn : COLORS.timerRingFill;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(ringCx, ringCy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    ctx.fillStyle = drawing && remainSec <= 10 ? COLORS.accentPink : COLORS.textMain;
    ctx.font = `900 18px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(drawing ? String(remainSec) : '–', ringCx, ringCy);

    // 라운드 표시
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 12px ${FONT}`;
    ctx.fillText(`라운드 ${game.round} / ${game.totalRounds}`, ringCx, ringCy + 44);

    // 제시어 영역 (글자수 또는 출제자 본인은 단어)
    const wordY = 120;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 12px ${FONT}`;
    ctx.fillText('제시어', ringCx, wordY);

    const isDrawer = game.drawerPeerId === state.myPeerId;
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `900 24px ${FONT}`;
    if (game.phase === 'round_result' || game.phase === 'ended') {
      ctx.fillText(state.revealedWord ?? '', ringCx, wordY + 26);
    } else if (isDrawer && game.currentWord) {
      ctx.fillText(game.currentWord, ringCx, wordY + 26);
    } else if (game.phase === 'drawing') {
      // 마스킹 단어 — '*' 는 _, 시간 임박에 공개된 글자는 그대로 표시
      const masked = [...game.currentWord].map((c) => (c === '*' ? '_' : c)).join(' ');
      ctx.fillText(masked, ringCx, wordY + 26);
    } else {
      ctx.fillText('···', ringCx, wordY + 26);
    }

    // 출제자 표시
    const drawer = game.players.find((p) => p.peerId === game.drawerPeerId);
    if (drawer && game.phase === 'drawing') {
      ctx.fillStyle = COLORS.drawerBadge;
      ctx.font = `700 12px ${FONT}`;
      ctx.fillText(`✏️ ${drawer.nickname}`, ringCx, wordY + 50);
    }

    // 점수판 (하단)
    this.drawScoreboard(state, 195);
  }

  private drawScoreboard(state: RenderState, y0: number): void {
    const ctx = this.ctx;
    const game = state.game;

    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 13px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏆 맞춘 개수', PANEL_X + 14, y0);

    // 점수 내림차순
    const sorted = [...game.players].sort((a, b) => b.score - a.score);
    const rowH = 26;
    const rowX = PANEL_X + 10;
    const rowW = PANEL_W - 20;

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i]!;
      const y = y0 + 16 + i * rowH;
      const isMe = p.peerId === state.myPeerId;
      const isDrawer = p.peerId === game.drawerPeerId;
      const isCorrect = game.correctThisRound.includes(p.peerId);

      // 행 배경
      ctx.fillStyle = isMe ? COLORS.scoreRow : 'transparent';
      if (isMe) this.fillRoundRect(rowX, y - rowH / 2 + 2, rowW, rowH - 4, 6);

      // 정답/출제자 마커
      let marker = '';
      if (isDrawer && game.phase === 'drawing') marker = '✏️';
      else if (isCorrect) marker = '✅';

      ctx.fillStyle = isMe ? COLORS.scoreMe : COLORS.textMain;
      ctx.font = `${isMe ? 700 : 500} 13px ${FONT}`;
      ctx.textAlign = 'left';
      const nick = p.nickname.length > 7 ? p.nickname.slice(0, 6) + '…' : p.nickname;
      ctx.fillText(`${marker}${nick}`, rowX + 8, y);

      ctx.fillStyle = COLORS.accentLavender;
      ctx.font = `800 13px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(String(p.score), rowX + rowW - 8, y);
    }

    // 관전 표시
    if (state.isSpectator) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `600 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('👀 관전 중', PANEL_X + PANEL_W / 2, CANVAS_H - 16);
    }
  }

  // ============================================
  // 헬퍼
  // ============================================

  private fillRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
    ctx.fill();
  }
}

// ============================================
// 색 변환 헬퍼 (flood fill / 스포이드용)
// ============================================

/** '#rrggbb' → [r,g,b] (0~255). 잘못된 값은 검정으로. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  if (h.length !== 6) return [0, 0, 0];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** [r,g,b] → '#rrggbb' */
function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
