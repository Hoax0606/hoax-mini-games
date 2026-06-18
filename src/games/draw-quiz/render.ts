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

/** 그림판 6색 팔레트 (도구 UI 와 공유) */
export const PALETTE = ['#1c1820', '#ff5a92', '#ffb12e', '#6ed9b3', '#5b9cff', '#b89aff'] as const;
/** 굵기 3단계 */
export const WIDTHS = [3, 6, 12] as const;

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
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const sx = (rect.width * dpr) / CANVAS_W;
    const sy = (rect.height * dpr) / CANVAS_H;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);

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

    // stroke 그리기 — clip 으로 도화지 밖 넘침 방지
    ctx.save();
    ctx.beginPath();
    ctx.rect(DRAW_X, DRAW_Y, DRAW_W, DRAW_H);
    ctx.clip();

    for (const s of state.strokes) this.drawStroke(s);
    if (state.liveStroke) this.drawStroke(state.liveStroke);

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

  private drawStroke(s: StrokeData): void {
    if (s.points.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    if (s.erase) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.strokeStyle = s.color;
    }
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const p0 = s.points[0]!;
    ctx.moveTo(p0.x, p0.y);
    if (s.points.length === 1) {
      // 점 하나 — 작은 원
      ctx.lineTo(p0.x + 0.1, p0.y + 0.1);
    } else {
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i]!.x, s.points[i]!.y);
      }
    }
    ctx.stroke();
    ctx.restore();
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
      // 글자수만 _ _ _
      const len = game.currentWord.length || 0;
      ctx.fillText('_ '.repeat(len).trim(), ringCx, wordY + 26);
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
