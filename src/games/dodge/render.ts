/**
 * 똥 피하기 렌더러 — 좌측 플레이 필드 + 우측 생존현황 패널.
 *   필드: 흰 배경 + 떨어지는 💩(이모지) + 캐릭터(민트 블롭, 대시 시 잔상) + HUD(생존시간·대시 게이지)
 *   패널: 전원 생존시간/아웃 목록 (인원 맞춰 행 높이 자동)
 *   오버레이: 시작 카운트다운 / 사망 대기 / 관전
 */

import { FIELD_W, FIELD_H, PLAYER_W, PLAYER_H, PLAYER_Y, fallerY, type Faller } from './rules';
import type { StandingEntry } from './netSync';

const CANVAS_W = 800;
const CANVAS_H = 480;
const PANEL_X = FIELD_W;          // 560
const PANEL_W = CANVAS_W - FIELD_W; // 240

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;
const COLORS = {
  bg: '#fff9fd',
  field: '#ffffff',
  fieldBorder: '#d9c7ff',
  panelBg: '#faf5ff',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  accent: '#ff5a92',
  lavender: '#9c7aeb',
  playerFill: '#86e8c4',
  playerStroke: '#2e8a70',
  gaugeBg: '#f0e8ff',
  gaugeFill: '#6ed9b3',
  gaugeWarn: '#ffb12e',
  dim: 'rgba(250,245,255,0.86)',
  rowMe: '#fff0f6',
} as const;

export interface RenderState {
  phase: 'playing' | 'dead';
  t: number;                 // 경과 초 (낙하물 위치용)
  fallers: Faller[];
  playerX: number;
  facing: -1 | 1;
  dashing: boolean;
  dashReady01: number;       // 0..1 (1=쿨다운 완료)
  myAliveMs: number;
  standings: StandingEntry[];
  myPeerId: string;
  isSpectator: boolean;
  connecting?: boolean;
}

export class DodgeRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private scale = 1;
  private offX = 0;
  private offY = 0;

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

  render(s: RenderState): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const scale = Math.min(rect.width / CANVAS_W, rect.height / CANVAS_H);
    this.scale = scale;
    this.offX = (rect.width - CANVAS_W * scale) / 2;
    this.offY = (rect.height - CANVAS_H * scale) / 2;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, this.offX * dpr, this.offY * dpr);

    if (s.connecting) { this.drawConnecting(); return; }

    this.drawField(s);
    this.drawPanel(s);
  }

  private drawConnecting(): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.field;
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 20px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('연결 중', FIELD_W / 2, FIELD_H / 2);
  }

  private drawField(s: RenderState): void {
    const ctx = this.ctx;
    // 도화지
    ctx.fillStyle = COLORS.field;
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, FIELD_W, FIELD_H);
    ctx.clip();

    // 낙하물 💩 (이모지)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of s.fallers) {
      const y = fallerY(f, s.t);
      if (y > FIELD_H || y + f.size < 0) continue;
      ctx.font = `${f.size}px ${FONT}`;
      ctx.fillText('💩', f.x + f.size / 2, y + f.size / 2);
    }

    // 캐릭터 (관전자는 안 그림)
    if (!s.isSpectator) this.drawPlayer(s);

    ctx.restore();

    // 필드 테두리
    ctx.strokeStyle = COLORS.fieldBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, FIELD_W - 2, FIELD_H - 2);

    // HUD (생존시간 + 대시 게이지)
    if (!s.isSpectator) this.drawHud(s);

    // 시작 직후 조작 힌트 (플랫폼 카운트다운엔 조작 안내가 없으니 여기서)
    if (!s.isSpectator && s.phase === 'playing' && s.t < 2.5) {
      const ctx = this.ctx;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.lavender;
      ctx.font = `700 15px ${FONT}`;
      ctx.fillText('← → 이동 · Space 대시', FIELD_W / 2, 74);
    }

    // 오버레이
    if (s.isSpectator) this.drawCenterMsg('👀 관전 중', '다들 피하는 중');
    else if (s.phase === 'dead') {
      this.drawCenterMsg('💀 아웃!', `생존 ${(s.myAliveMs / 1000).toFixed(1)}초 · 다른 사람 기다리는 중`);
    }
  }

  private drawPlayer(s: RenderState): void {
    const ctx = this.ctx;
    const x = s.playerX, y = PLAYER_Y;
    // 대시 잔상
    if (s.dashing) {
      for (let i = 1; i <= 2; i++) {
        ctx.globalAlpha = 0.22 * (3 - i);
        this.blob(x - s.facing * 12 * i, y);
      }
      ctx.globalAlpha = 1;
    }
    this.blob(x, y);
    // 눈 (바라보는 방향으로 살짝 치우침)
    ctx.fillStyle = '#1c1820';
    const eyeDx = s.facing * 2;
    ctx.beginPath(); ctx.arc(x + PLAYER_W / 2 - 7 + eyeDx, y + 15, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + PLAYER_W / 2 + 7 + eyeDx, y + 15, 3.2, 0, Math.PI * 2); ctx.fill();
  }

  private blob(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.playerFill;
    ctx.strokeStyle = COLORS.playerStroke;
    ctx.lineWidth = 2.5;
    this.roundRect(x, y, PLAYER_W, PLAYER_H, 14);
    ctx.fill();
    ctx.stroke();
  }

  private drawHud(s: RenderState): void {
    const ctx = this.ctx;
    // 생존시간
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `800 20px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`⏱ ${(s.myAliveMs / 1000).toFixed(1)}초`, 14, 12);

    // 대시 게이지
    const gx = 14, gy = 42, gw = 120, gh = 9;
    ctx.fillStyle = COLORS.gaugeBg;
    this.roundRect(gx, gy, gw, gh, 4.5); ctx.fill();
    ctx.fillStyle = s.dashReady01 >= 1 ? COLORS.gaugeFill : COLORS.gaugeWarn;
    this.roundRect(gx, gy, gw * s.dashReady01, gh, 4.5); ctx.fill();
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 11px ${FONT}`;
    ctx.fillText(s.dashReady01 >= 1 ? '대시 준비됨 (Space)' : '대시 충전 중', gx, gy + gh + 4);
  }

  private drawCenterMsg(title: string, sub: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.dim;
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.accent;
    ctx.font = `800 30px ${FONT}`;
    ctx.fillText(title, FIELD_W / 2, FIELD_H / 2 - 12);
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `500 15px ${FONT}`;
    ctx.fillText(sub, FIELD_W / 2, FIELD_H / 2 + 20);
  }

  private drawPanel(s: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.panelBg;
    ctx.fillRect(PANEL_X, 0, PANEL_W, CANVAS_H);

    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 14px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const aliveN = s.standings.filter((e) => !e.dead).length;
    ctx.fillText(`🏁 생존 ${aliveN}명`, PANEL_X + 14, 22);

    // 정렬: 생존자(aliveMs 큰 순) 먼저, 그 뒤 사망자(생존시간 큰 순)
    const sorted = [...s.standings].sort((a, b) => {
      if (a.dead !== b.dead) return a.dead ? 1 : -1;
      return b.aliveMs - a.aliveMs;
    });

    const y0 = 44;
    const avail = CANVAS_H - y0 - 12;
    const rowH = Math.max(20, Math.min(34, avail / Math.max(1, sorted.length)));
    const fontPx = rowH >= 28 ? 13 : 11;
    const rowX = PANEL_X + 8, rowW = PANEL_W - 16;

    sorted.forEach((e, i) => {
      const y = y0 + i * rowH;
      const isMe = e.peerId === s.myPeerId;
      if (isMe) {
        ctx.fillStyle = COLORS.rowMe;
        this.roundRect(rowX, y + 1, rowW, rowH - 3, 6); ctx.fill();
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `${isMe ? 700 : 500} ${fontPx}px ${FONT}`;
      ctx.fillStyle = e.dead ? COLORS.textMuted : COLORS.textMain;
      const nick = e.nickname.length > 7 ? e.nickname.slice(0, 6) + '…' : e.nickname;
      ctx.fillText(`${e.dead ? '💀' : '🟢'} ${nick}${isMe ? ' (나)' : ''}`, rowX + 6, y + rowH / 2);

      ctx.textAlign = 'right';
      ctx.fillStyle = e.dead ? COLORS.textMuted : COLORS.lavender;
      ctx.font = `800 ${fontPx}px ${FONT}`;
      ctx.fillText(`${(e.aliveMs / 1000).toFixed(1)}s`, rowX + rowW - 6, y + rowH / 2);
    });
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
