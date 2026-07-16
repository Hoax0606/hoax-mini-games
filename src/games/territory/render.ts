/**
 * 땅따먹기 렌더러. 논리 800×400 + 균일 레터박스. 격자 40×20, 셀 20px.
 * 영토(옅은 색) · 꼬리(진한 반투명) · 머리(진한 사각+테두리) · HUD(내 영토·순위·타이머).
 * 입력은 방향키(index) 라 캔버스 히트테스트 없음.
 */

import { fitContain } from '../_shared/canvasFit';
import { GW, GH, PLAYER_COLORS } from './rules';
import type { TerritorySnap } from './netSync';

const W = 800;
const H = 400;
const CELL = W / GW; // 20
const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;
const BG = '#f4f0f7';
const GRID_LINE = 'rgba(120,100,130,0.06)';

export interface RenderState {
  snap: TerritorySnap;
  myPeerId: string;
  now: number;
}

export class TerritoryRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 컨텍스트를 가져올 수 없어요');
    this.ctx = ctx;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
  }

  destroy(): void { this.ro.disconnect(); }

  render(state: RenderState): void {
    const ctx = this.ctx;
    fitContain(ctx, this.canvas, W, H, BG);
    const snap = state.snap;

    // 영토
    const grid = snap.grid;
    for (let i = 0; i < grid.length; i++) {
      const ch = grid[i]!;
      if (ch === '.') continue;
      const owner = ch.charCodeAt(0) - 48;
      const col = PLAYER_COLORS[owner % PLAYER_COLORS.length];
      if (!col) continue;
      const x = (i % GW) * CELL, y = ((i / GW) | 0) * CELL;
      ctx.fillStyle = col.terr;
      ctx.fillRect(x, y, CELL, CELL);
    }

    // 격자선 (옅게)
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= GW; x++) { ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, H); }
    for (let y = 0; y <= GH; y++) { ctx.moveTo(0, y * CELL); ctx.lineTo(W, y * CELL); }
    ctx.stroke();

    // 꼬리 (진한 반투명)
    snap.trails.forEach((trail, pi) => {
      const col = PLAYER_COLORS[pi % PLAYER_COLORS.length];
      if (!col || !snap.players[pi]?.alive) return;
      ctx.fillStyle = col.solid;
      ctx.globalAlpha = 0.55;
      for (const c of trail) {
        const x = (c % GW) * CELL, y = ((c / GW) | 0) * CELL;
        ctx.fillRect(x, y, CELL, CELL);
      }
      ctx.globalAlpha = 1;
    });

    // 머리
    snap.players.forEach((p, pi) => {
      if (!p.alive) return;
      const col = PLAYER_COLORS[pi % PLAYER_COLORS.length];
      if (!col) return;
      const x = p.x * CELL, y = p.y * CELL;
      ctx.fillStyle = col.solid;
      ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
      // 내 머리 흰 테두리 강조
      if (p.peerId === state.myPeerId) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
      }
    });

    this.drawHUD(ctx, state);
  }

  private drawHUD(ctx: CanvasRenderingContext2D, state: RenderState): void {
    const snap = state.snap;
    const me = snap.players.find((p) => p.peerId === state.myPeerId);
    const myIdx = snap.players.findIndex((p) => p.peerId === state.myPeerId);
    // 순위 계산 (영토 내림차순)
    const sorted = [...snap.players].sort((a, b) => b.score - a.score);
    const myRank = me ? sorted.findIndex((p) => p.peerId === me.peerId) + 1 : 0;
    const total = GW * GH;

    // 좌상단 내 영토/순위 카드
    if (me) {
      const col = PLAYER_COLORS[myIdx % PLAYER_COLORS.length]!;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      this.roundRect(ctx, 10, 8, 190, 34, 10);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = col.solid;
      ctx.font = `900 15px ${FONT}`;
      const pct = ((me.score / total) * 100).toFixed(1);
      ctx.fillText(`내 땅 ${pct}%  ·  ${myRank}/${snap.players.length}위`, 20, 26);
      if (!me.alive) {
        ctx.fillStyle = '#e5484d';
        ctx.font = `800 12px ${FONT}`;
        ctx.textAlign = 'right';
        ctx.fillText('부활 중…', 196, 26);
      }
    }

    // 우상단 타이머
    const remainSec = Math.ceil(snap.remainMs / 1000);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    this.roundRect(ctx, W - 92, 8, 82, 34, 10);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = remainSec <= 10 ? '#e5484d' : '#4a3a4a';
    ctx.font = `900 17px ${FONT}`;
    const m = Math.floor(remainSec / 60), s = remainSec % 60;
    ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, W - 51, 26);
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
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
