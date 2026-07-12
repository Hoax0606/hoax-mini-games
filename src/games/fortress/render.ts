/**
 * 포트리스 Canvas 렌더러 (사이드뷰)
 *
 * 레이어(아래→위): 하늘 배경 → 지형(흙) → 포대 + HP바 → 궤적 포탄 →
 *                    조준 가이드(내 차례) → 상단 HUD(턴·바람) → 종료 오버레이
 *
 * 조준 UI: 알까기/다트와 동일한 "드래그 반대 방향 발사" 규약.
 */

import { terrainTopAt, TERRAIN_HEIGHT } from './terrain';
import { MAX_WIND } from './physics';
import { fortCenterY, FORT_HP, type FortressGame } from './rules';

const CANVAS_H = 400;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

/** 포대 색 — 플레이어별 (algagi 와 같은 팔레트 계열) */
const FILL = ['#6ed9b3', '#ff6b9e', '#b89aff', '#ffd454', '#5b9cff', '#ffb12e'] as const;
const STROKE = ['#2e8a70', '#c93d73', '#7a5fc7', '#c49a1f', '#3f78c9', '#c47f1a'] as const;

const COLORS = {
  skyTop: '#ffe9f2',
  skyBot: '#e6f7ff',
  soil: '#d8b89a',
  soilDark: '#b8946e',
  soilEdge: '#8a6a4a',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  accentPink: '#ff5a92',
  hpBack: 'rgba(74,58,74,0.18)',
  hpFill: '#6ed9b3',
  hpLow: '#ff5a92',
  projectile: '#4a3a4a',
  aimLine: 'rgba(255,90,146,0.85)',
  hudBg: 'rgba(255,255,255,0.82)',
  endOverlay: 'rgba(54,36,56,0.6)',
} as const;

// ============================================
// 좌표 변환
// ============================================

// 좌표 변환은 논리 폭이 가변이라 Renderer.screenToLogical 메서드로 이동
//   (uniform scale + letterbox offset 을 render 시점에 저장해 역변환).

// ============================================
// Renderer
// ============================================

export interface RenderState {
  game: FortressGame;
  hm: number[];
  myPeerId: string;
  isSpectator: boolean;
  /** 날아가는 포탄 (없으면 null) */
  projectile: { x: number; y: number } | null;
  /** 내 차례 드래그 조준 중 — 포대 기준 + 현재 마우스 (논리 좌표) */
  aim: { fromX: number; fromY: number; mx: number; my: number } | null;
  now: number;
}

export interface FortressRendererArgs {
  canvas: HTMLCanvasElement;
}

export class FortressRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;

  // 마지막 render 의 논리→화면 변환 (screenToLogical 역변환용, CSS 픽셀 기준)
  private scaleCss = 1;
  private offXCss = 0;
  private offYCss = 0;

  /** 화면(rect 내 CSS 픽셀) 좌표 → 게임 논리 좌표 */
  screenToLogical(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.offXCss) / this.scaleCss, y: (py - this.offYCss) / this.scaleCss };
  }

  constructor(args: FortressRendererArgs) {
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
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const logicalW = state.game.terrainWidth;

    // uniform scale + letterbox — 논리(logicalW × 400)를 화면에 왜곡 없이 담기
    const scale = Math.min(rect.width / logicalW, rect.height / TERRAIN_HEIGHT);
    this.scaleCss = scale;
    this.offXCss = (rect.width - logicalW * scale) / 2;
    this.offYCss = (rect.height - TERRAIN_HEIGHT * scale) / 2;

    // 전체 배경(레터박스 여백) 채우기
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#efe7f2';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // 논리 좌표계로 전환 (물리픽셀 = CSS × dpr)
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, this.offXCss * dpr, this.offYCss * dpr);

    this.drawSky(logicalW);
    this.drawTerrain(state.hm);
    this.drawForts(state);
    if (state.projectile) this.drawProjectile(state.projectile);
    if (state.aim) this.drawAim(state.aim);
    this.drawHUD(state, logicalW);
    if (state.game.phase === 'ended') this.drawEndOverlay(state, logicalW);
  }

  private drawSky(logicalW: number): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, TERRAIN_HEIGHT);
    g.addColorStop(0, COLORS.skyTop);
    g.addColorStop(1, COLORS.skyBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, logicalW, TERRAIN_HEIGHT);
  }

  private drawTerrain(hm: number[]): void {
    const ctx = this.ctx;
    const w = hm.length;
    ctx.beginPath();
    ctx.moveTo(0, hm[0]!);
    for (let x = 1; x < w; x++) ctx.lineTo(x, hm[x]!);
    ctx.lineTo(w, TERRAIN_HEIGHT);
    ctx.lineTo(0, TERRAIN_HEIGHT);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 150, 0, TERRAIN_HEIGHT);
    g.addColorStop(0, COLORS.soil);
    g.addColorStop(1, COLORS.soilDark);
    ctx.fillStyle = g;
    ctx.fill();
    // 지면 윗선 (풀/가장자리 강조)
    ctx.strokeStyle = COLORS.soilEdge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, hm[0]!);
    for (let x = 1; x < w; x++) ctx.lineTo(x, hm[x]!);
    ctx.stroke();
  }

  private drawForts(state: RenderState): void {
    const ctx = this.ctx;
    const currentTurn = state.game.phase === 'aiming' ? state.game.currentTurn : -1;
    for (const f of state.game.forts) {
      if (!f.alive) {
        // 파괴된 포대 — 지면에 작은 잔해 표시
        const y = terrainTopAt(state.hm, f.x);
        ctx.fillStyle = 'rgba(74,58,74,0.35)';
        ctx.font = `14px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('💥', f.x, y);
        continue;
      }
      const cy = fortCenterY(state.hm, f);
      const fill = FILL[f.ownerIndex] ?? FILL[0];
      const stroke = STROKE[f.ownerIndex] ?? STROKE[0];

      // 차례 표시 펄스
      if (f.id === currentTurn) {
        const pulse = 0.6 + 0.4 * Math.sin(state.now / 260);
        ctx.strokeStyle = `rgba(255,90,146,${pulse})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(f.x, cy, 18, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 포대 몸통 (반원 돔)
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(f.x, cy, 11, Math.PI, 0);
      ctx.lineTo(f.x + 11, cy + 5);
      ctx.lineTo(f.x - 11, cy + 5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // HP 바 (포대 위)
      const barW = 30;
      const barX = f.x - barW / 2;
      const barY = cy - 26;
      ctx.fillStyle = COLORS.hpBack;
      ctx.fillRect(barX, barY, barW, 5);
      const ratio = f.hp / FORT_HP;
      ctx.fillStyle = ratio <= 0.3 ? COLORS.hpLow : COLORS.hpFill;
      ctx.fillRect(barX, barY, barW * ratio, 5);

      // 닉네임 (내 포대면 강조)
      const isMe = f.ownerPeerId === state.myPeerId;
      ctx.fillStyle = isMe ? COLORS.accentPink : COLORS.textMuted;
      ctx.font = `${isMe ? 700 : 500} 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const nick = f.ownerNickname.length > 6 ? f.ownerNickname.slice(0, 5) + '…' : f.ownerNickname;
      ctx.fillText(nick + (isMe ? ' (나)' : ''), f.x, barY - 3);
    }
  }

  private drawProjectile(p: { x: number; y: number }): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.projectile;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawAim(aim: { fromX: number; fromY: number; mx: number; my: number }): void {
    const ctx = this.ctx;
    // 드래그 = (마우스 - 포대). 발사 방향은 반대.
    const dx = aim.mx - aim.fromX;
    const dy = aim.my - aim.fromY;
    if (Math.hypot(dx, dy) < 4) return;
    const ax = aim.fromX - dx;
    const ay = aim.fromY - dy;

    // 드래그 라인 (뒤로 당김)
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(140,110,150,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(aim.fromX, aim.fromY);
    ctx.lineTo(aim.mx, aim.my);
    ctx.stroke();
    ctx.setLineDash([]);

    // 발사 방향 화살표
    ctx.strokeStyle = COLORS.aimLine;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(aim.fromX, aim.fromY);
    ctx.lineTo(ax, ay);
    ctx.stroke();
    ctx.lineCap = 'butt';
    const ang = Math.atan2(ay - aim.fromY, ax - aim.fromX);
    const hl = 10;
    ctx.fillStyle = COLORS.aimLine;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - Math.cos(ang - 0.4) * hl, ay - Math.sin(ang - 0.4) * hl);
    ctx.lineTo(ax - Math.cos(ang + 0.4) * hl, ay - Math.sin(ang + 0.4) * hl);
    ctx.closePath();
    ctx.fill();
  }

  private drawHUD(state: RenderState, logicalW: number): void {
    const ctx = this.ctx;
    const g = state.game;

    // 상단 중앙 HUD 박스
    const boxW = 240;
    const boxX = (logicalW - boxW) / 2;
    ctx.fillStyle = COLORS.hudBg;
    this.roundRect(boxX, 8, boxW, 34, 10);
    ctx.fill();

    ctx.textBaseline = 'middle';
    // 좌: 현재 차례
    const cur = g.forts.find((f) => f.id === g.currentTurn);
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 13px ${FONT}`;
    ctx.textAlign = 'left';
    const turnLabel = g.phase === 'ended' ? '게임 종료'
      : g.phase === 'firing' ? '발사 중…'
      : `${cur?.ownerNickname ?? '?'} 차례`;
    ctx.fillText(`🎯 ${turnLabel}`, boxX + 14, 25);

    // 우: 바람 (화살표 + 세기)
    const wind = g.wind;
    const windStr = Math.min(1, Math.abs(wind) / MAX_WIND);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 12px ${FONT}`;
    const arrow = wind >= 0 ? '▶' : '◀';
    const bars = '●'.repeat(1 + Math.round(windStr * 3));
    ctx.fillText(`바람 ${arrow}${bars}`, boxX + boxW - 14, 25);

    // 관전 배지
    if (state.isSpectator) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `600 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('👀 관전 중', logicalW / 2, 56);
    }
  }

  private drawEndOverlay(state: RenderState, logicalW: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.endOverlay;
    ctx.fillRect(0, 0, logicalW, CANVAS_H);
    const winners = state.game.winnerPeerIds;
    const iWon = winners.includes(state.myPeerId);
    const isDraw = winners.length === 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 56px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(isDraw ? '⚖️' : '🏆', logicalW / 2, CANVAS_H / 2 - 26);
    ctx.font = `900 26px ${FONT}`;
    ctx.fillStyle = iWon ? COLORS.accentPink : '#fff';
    const winNames = [...new Set(state.game.forts
      .filter((f) => winners.includes(f.ownerPeerId))
      .map((f) => f.ownerNickname))]
      .join(', ');
    const title = isDraw ? '무승부' : iWon ? (winners.length >= 2 ? '공동 우승!' : '승리!') : `${winNames} 승리`;
    ctx.fillText(title, logicalW / 2, CANVAS_H / 2 + 26);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
