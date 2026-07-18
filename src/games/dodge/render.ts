/**
 * 똥 피하기 렌더러 — 좌측 플레이 필드 + 우측 생존현황 패널. (apple-design 리디자인)
 *   필드: 흰 배경 + 떨어지는 똥(Fluent 이모지 실루엣 Path2D) + 캐릭터(민트 공, 발/팔/얼굴) + HUD
 *   패널: 생존 N/전체 + 전원 목록(상태점 · 이름 폭맞춤 말줄임 · 생존시간)
 *   오버레이: 아웃/관전 (프로스티드 카드 + 캐릭터, 이모지 없음)
 *
 * 똥·캐릭터는 이모지 대신 캔버스로 직접 그린다(프로젝트 방침: UI는 아이콘/도형, 이모지 X).
 *   똥 실루엣은 Fluent Emoji Flat 의 몸통 패스를 그대로 사용(얼굴 제거) → "진짜 똥 모양" 보장.
 */

import { FIELD_W, FIELD_H, PLAYER_W, PLAYER_H, PLAYER_Y, fallerY, type Faller } from './rules';
import type { StandingEntry } from './netSync';

const CANVAS_W = 800;
const CANVAS_H = 480;
const PANEL_X = FIELD_W;             // 560
const PANEL_W = CANVAS_W - FIELD_W;  // 240

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;
const COLORS = {
  bg: '#fff9fd',
  field: '#fffdff',
  fieldBorder: '#e6d8ff',
  panelBg: '#faf5ff',
  panelLine: 'rgba(216,199,255,0.5)',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  accent: '#ff5a92',
  lavender: '#9c7aeb',
  mintLo: '#6ed9b3',
  gaugeBg: '#f0e8ff',
  gaugeFill: '#6ed9b3',
  gaugeWarn: '#ffb12e',
  rowMe: '#fff0f6',
  cardFrost: 'rgba(255,255,255,0.82)',
  cheek: '#f4a0a8',
} as const;

/** 똥 몸통 실루엣 — Fluent Emoji Flat(pile-of-poo)의 body path (viewBox 32, 얼굴 제거) */
const POO_PATH = new Path2D(
  'M22.072 6.66c.126 1.058-.063 1.734-.309 2.133c2.029.56 3.879 1.974 4.743 3.82c.625 1.532.66 3.359.192 5.027C29.18 18.847 31 21.547 31 24.429c0 3.722-2.723 6.399-6.574 6.624v.016H9.03v-.004C4.26 30.95 2 27.75 2 24.023c0-2.494 2.149-5.47 4.549-6.49c-.002-.22.02-.387.056-.512c-.929-1.88.021-3.78.618-4.5l.227-.294l.01-.013c.83-1.083 1.331-1.736 4.895-3.279c3.887-1.683 5.269-3.336 5.8-4.006c.146-.184.281-.425.42-.672c.366-.652.763-1.358 1.478-1.245c.987.156 1.761 1.465 2.02 3.647',
);
// 패스 몸통 bbox ≈ x[2,31] y[4.6,31] → 중심(16.5,17.8), 높이 ~26.4

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
    const offX = (rect.width - CANVAS_W * scale) / 2;
    const offY = (rect.height - CANVAS_H * scale) / 2;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offX * dpr, offY * dpr);

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

  // ============================================
  // 필드
  // ============================================

  private drawField(s: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.field;
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, FIELD_W, FIELD_H);
    ctx.clip();

    // 낙하물(똥) — 떨어지며 아주 살짝 흔들
    for (const f of s.fallers) {
      const y = fallerY(f, s.t);
      if (y > FIELD_H || y + f.size < 0) continue;
      const rot = Math.sin(s.t * 1.8 + f.x * 0.05) * 0.1;
      this.drawPoop(f.x + f.size / 2, y + f.size / 2, f.size * 1.06, rot);
    }

    if (!s.isSpectator) this.drawPlayer(s);
    ctx.restore();

    // 필드 테두리
    ctx.strokeStyle = COLORS.fieldBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, FIELD_W - 2, FIELD_H - 2);

    if (!s.isSpectator) this.drawHud(s);

    // 시작 직후 조작 힌트
    if (!s.isSpectator && s.phase === 'playing' && s.t < 2.5) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.lavender;
      ctx.font = `700 15px ${FONT}`;
      ctx.fillText('← → 이동 · Space 대시', FIELD_W / 2, 74);
    }

    // 오버레이
    if (s.isSpectator) this.drawCenterCard('spectate', '다들 피하는 중');
    else if (s.phase === 'dead') {
      this.drawCenterCard('dead', `생존 ${(s.myAliveMs / 1000).toFixed(1)}초 · 다른 사람 기다리는 중`);
    }
  }

  // ── 똥: Fluent 실루엣 Path2D ──
  private drawPoop(cx: number, cy: number, s: number, rot: number): void {
    const ctx = this.ctx;
    const k = s / 26.4;
    ctx.save();
    // 바닥 그림자
    ctx.fillStyle = 'rgba(120,80,140,0.1)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + s * 0.48, s * 0.4, s * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(k, k);
    ctx.translate(-16.5, -17.8);
    const g = ctx.createLinearGradient(0, 5, 0, 31);
    g.addColorStop(0, '#b9834d');
    g.addColorStop(0.55, '#a06b3c');
    g.addColorStop(1, '#82542e');
    ctx.fillStyle = g;
    ctx.fill(POO_PATH);
    ctx.lineWidth = 1.1; // path 좌표계 → k배 확대돼 화면상 적당한 굵기
    ctx.strokeStyle = '#67432c';
    ctx.lineJoin = 'round';
    ctx.stroke(POO_PATH);
    // 하이라이트 하나
    ctx.save();
    ctx.clip(POO_PATH);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.ellipse(9.5, 15, 3.6, 2.5, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  // ── 캐릭터: 민트 공 + 발/팔 + 얼굴(대시 잔상, 아웃=X눈) ──
  private drawPlayer(s: RenderState): void {
    this.drawChar(s.playerX + PLAYER_W / 2, PLAYER_Y + PLAYER_H / 2, s.facing, s.dashing, false);
  }

  private drawChar(cx: number, cy: number, facing: -1 | 1, dashing: boolean, dead: boolean): void {
    const ctx = this.ctx;
    const r = dashing ? 18.5 : 17;
    // 그림자
    ctx.fillStyle = 'rgba(120,80,140,0.13)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + r + 4, r * 1.05, 3.6, 0, 0, Math.PI * 2);
    ctx.fill();
    // 대시 잔상
    if (dashing) {
      for (let i = 1; i <= 2; i++) {
        ctx.globalAlpha = 0.15 * (3 - i);
        ctx.fillStyle = COLORS.mintLo;
        ctx.beginPath();
        ctx.arc(cx - facing * 9 * i, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // 발
    ctx.fillStyle = '#49bd97';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + side * r * 0.5, cy + r + 1, 4.6, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // 팔
    ctx.fillStyle = '#54c6a0';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + side * (r - 0.5), cy + r * 0.32, 3.6, 5.2, side * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    // 몸통 (방사 그라데이션 공)
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.45, r * 0.15, cx, cy, r);
    g.addColorStop(0, '#bef6e5');
    g.addColorStop(0.6, '#7fe0bd');
    g.addColorStop(1, '#5cc9a2');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    // 아래쪽 안쪽 그림자
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    const ing = ctx.createLinearGradient(0, cy - r * 0.2, 0, cy + r);
    ing.addColorStop(0, 'rgba(30,110,85,0)');
    ing.addColorStop(1, 'rgba(30,110,85,0.24)');
    ctx.fillStyle = ing;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
    // 하이라이트
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.35, cy - r * 0.45, r * 0.32, r * 0.2, -0.5, 0, Math.PI * 2);
    ctx.fill();
    // 외곽선
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#2e8a70';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    // 얼굴 (바라보는 방향으로 살짝)
    this.drawFace(cx + facing * 1.5, cy + 1, 5, 3, dead);
  }

  private drawFace(cx: number, ey: number, sp: number, er: number, dead: boolean): void {
    const ctx = this.ctx;
    // 볼터치
    ctx.fillStyle = COLORS.cheek;
    ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.ellipse(cx - sp - er * 0.9, ey + er * 1.3, er * 1.05, er * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + sp + er * 0.9, ey + er * 1.3, er * 1.05, er * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    if (dead) {
      ctx.strokeStyle = '#3a2e34';
      ctx.lineWidth = er * 0.62;
      ctx.lineCap = 'round';
      for (const side of [-1, 1]) {
        const c = cx + side * sp;
        ctx.beginPath();
        ctx.moveTo(c - er * 0.75, ey - er * 0.75); ctx.lineTo(c + er * 0.75, ey + er * 0.75);
        ctx.moveTo(c + er * 0.75, ey - er * 0.75); ctx.lineTo(c - er * 0.75, ey + er * 0.75);
        ctx.stroke();
      }
      return;
    }
    // 눈 + 캐치라이트
    ctx.fillStyle = '#3a2e34';
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(cx + side * sp, ey, er, er * 1.18, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#fff';
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + side * sp - er * 0.32, ey - er * 0.5, er * 0.42, 0, Math.PI * 2); ctx.fill(); }
    // 입 (작은 웃음)
    ctx.strokeStyle = '#3a2e34';
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, ey + er * 1.85, er * 0.7, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
  }

  private drawHud(s: RenderState): void {
    const ctx = this.ctx;
    // 시계 글리프 + 생존시간
    const gx = 16, gy = 24;
    ctx.strokeStyle = COLORS.lavender;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(gx + 7, gy, 7.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(gx + 7, gy); ctx.lineTo(gx + 7, gy - 4); ctx.moveTo(gx + 7, gy); ctx.lineTo(gx + 10, gy + 2); ctx.stroke();
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `800 20px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${(s.myAliveMs / 1000).toFixed(1)}초`, gx + 22, gy);

    // 대시 게이지
    const bx = 16, by = 44, bw = 124, bh = 9;
    ctx.fillStyle = COLORS.gaugeBg;
    this.roundRect(bx, by, bw, bh, 4.5); ctx.fill();
    ctx.fillStyle = s.dashReady01 >= 1 ? COLORS.gaugeFill : COLORS.gaugeWarn;
    this.roundRect(bx, by, bw * s.dashReady01, bh, 4.5); ctx.fill();
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(s.dashReady01 >= 1 ? '대시 준비됨 (Space)' : '대시 충전 중', bx, by + bh + 4);
  }

  // ── 프로스티드 중앙 카드 (아웃 / 관전) ──
  private drawCenterCard(kind: 'dead' | 'spectate', sub: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(250,245,255,0.55)';
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);
    const cw = 320, ch = 176, cx = (FIELD_W - cw) / 2, cy = (FIELD_H - ch) / 2;
    ctx.shadowColor = 'rgba(120,80,140,0.22)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = COLORS.cardFrost;
    this.roundRect(cx, cy, cw, ch, 24); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    this.roundRect(cx, cy, cw, ch, 24); ctx.stroke();

    const mcx = FIELD_W / 2;
    if (kind === 'dead') {
      this.drawChar(mcx, cy + 48, 1, false, true); // 내 캐릭터 X눈
      ctx.fillStyle = COLORS.accent;
      ctx.font = `900 30px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('아웃!', mcx, cy + 108);
    } else {
      ctx.globalAlpha = 0.5;
      this.drawChar(mcx, cy + 48, 1, false, false);
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.lavender;
      ctx.font = `900 28px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('관전 중', mcx, cy + 108);
    }
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `500 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sub, mcx, cy + 140);
    ctx.restore();
  }

  // ============================================
  // 우측 패널
  // ============================================

  private drawPanel(s: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.panelBg;
    ctx.fillRect(PANEL_X, 0, PANEL_W, CANVAS_H);
    ctx.strokeStyle = COLORS.panelLine;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PANEL_X + 0.5, 0); ctx.lineTo(PANEL_X + 0.5, CANVAS_H); ctx.stroke();

    const aliveN = s.standings.filter((e) => !e.dead).length;
    // 헤더: 생존 N / 전체
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `800 15px ${FONT}`;
    ctx.fillText('생존', PANEL_X + 16, 26);
    const lw = ctx.measureText('생존 ').width;
    ctx.fillStyle = COLORS.mintLo;
    ctx.font = `900 15px ${FONT}`;
    ctx.fillText(`${aliveN}`, PANEL_X + 16 + lw, 26);
    const nw = ctx.measureText(`${aliveN}`).width;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 13px ${FONT}`;
    ctx.fillText(` / ${s.standings.length}`, PANEL_X + 16 + lw + nw, 26);

    // 정렬: 생존자(생존시간 큰 순) → 사망자(생존시간 큰 순)
    const sorted = [...s.standings].sort((a, b) => {
      if (a.dead !== b.dead) return a.dead ? 1 : -1;
      return b.aliveMs - a.aliveMs;
    });

    const y0 = 48;
    const avail = CANVAS_H - y0 - 12;
    const rowH = Math.max(22, Math.min(38, avail / Math.max(1, sorted.length)));
    const fs = rowH >= 30 ? 14 : rowH >= 26 ? 13 : 12;
    const rowX = PANEL_X + 8, rowW = PANEL_W - 16;

    sorted.forEach((e, i) => {
      const y = y0 + i * rowH;
      const isMe = e.peerId === s.myPeerId;
      const cy = y + rowH / 2;
      if (isMe) {
        ctx.fillStyle = COLORS.rowMe;
        this.roundRect(rowX, y + 2, rowW, rowH - 4, 9); ctx.fill();
        ctx.strokeStyle = 'rgba(255,90,146,0.35)';
        ctx.lineWidth = 1;
        this.roundRect(rowX, y + 2, rowW, rowH - 4, 9); ctx.stroke();
      }
      // 상태점: 생존=민트 채움, 아웃=회색 링
      const dotX = rowX + 14;
      if (e.dead) {
        ctx.strokeStyle = COLORS.textMuted;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(dotX, cy, 4.2, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.fillStyle = COLORS.mintLo;
        ctx.beginPath(); ctx.arc(dotX, cy, 4.6, 0, Math.PI * 2); ctx.fill();
      }
      // 생존시간 (우측)
      const timeStr = `${(e.aliveMs / 1000).toFixed(1)}s`;
      ctx.font = `800 ${fs}px ${FONT}`;
      const tw = ctx.measureText(timeStr).width;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = e.dead ? COLORS.textMuted : COLORS.lavender;
      ctx.fillText(timeStr, rowX + rowW - 8, cy);
      // 이름 (폭 맞춰 말줄임)
      const nameX = dotX + 12;
      const nameMax = rowW - (nameX - rowX) - tw - 20;
      ctx.textAlign = 'left';
      ctx.font = `${isMe ? 800 : 600} ${fs}px ${FONT}`;
      ctx.fillStyle = e.dead ? COLORS.textMuted : COLORS.textMain;
      ctx.fillText(this.ellipsize(e.nickname + (isMe ? ' (나)' : ''), nameMax), nameX, cy);
    });
  }

  /** 폭 맞춰 말줄임 (현재 ctx.font 기준) */
  private ellipsize(text: string, maxW: number): string {
    const ctx = this.ctx;
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
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
