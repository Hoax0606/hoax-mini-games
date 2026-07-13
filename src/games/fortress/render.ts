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
import { FORT_HP, type FortressGame } from './rules';

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
  grass: '#9fd6a0',
  tread: '#5a4a52',
  wheel: '#8a7a82',
  stone: '#c9c2cf',
  stoneStroke: '#8a7a8a',
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
  /** 내 차례 드래그 조준 중 — 포대 기준 + 현재 마우스 (논리 좌표) + 파워(0~1) */
  aim: { fromX: number; fromY: number; mx: number; my: number; power01: number } | null;
  now: number;
  /** 현재 aiming 턴 시작 시각 (클라 로컬). 남은 시간 표시용 */
  turnStartedAt: number;
  /** 한 턴 제한 시간(ms) */
  turnTimeMs: number;
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
    // 지면 윗선 — 흙 가장자리 위에 풀색 라인 덧그려 "땅" 느낌
    const topLine = (): void => {
      ctx.beginPath();
      ctx.moveTo(0, hm[0]!);
      for (let x = 1; x < w; x++) ctx.lineTo(x, hm[x]!);
      ctx.stroke();
    };
    ctx.strokeStyle = COLORS.soilEdge;
    ctx.lineWidth = 3;
    topLine();
    ctx.strokeStyle = COLORS.grass;
    ctx.lineWidth = 2;
    topLine();
  }

  private drawForts(state: RenderState): void {
    const ctx = this.ctx;
    const center = state.game.terrainWidth / 2;
    const currentTurn = state.game.phase === 'aiming' ? state.game.currentTurn : -1;
    for (const f of state.game.forts) {
      const baseY = terrainTopAt(state.hm, f.x); // 지면 top — 탱크를 이 위로 쌓아 올림
      if (!f.alive) {
        this.drawTombstone(f.x, baseY);
        // 죽은 소유자 이름 — 묘비 위 (연한 회색)
        const deadNick = f.ownerNickname.length > 6 ? f.ownerNickname.slice(0, 5) + '…' : f.ownerNickname;
        ctx.fillStyle = COLORS.textMuted;
        ctx.font = `500 11px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(deadNick, f.x, baseY - 26);
        continue;
      }
      const fill = FILL[f.ownerIndex] ?? FILL[0];
      const stroke = STROKE[f.ownerIndex] ?? STROKE[0];

      // 포신 각도 (Canvas 좌표계 = y 아래로 +).
      let barrelAngle: number;
      if (f.id === currentTurn && state.aim) {
        // 내 차례 조준 중 — 발사 방향 = 드래그 반대
        const dx = state.aim.mx - state.aim.fromX;
        const dy = state.aim.my - state.aim.fromY;
        barrelAngle = Math.atan2(-dy, -dx);
      } else {
        // 대기 — 맵 중앙 쪽으로 약 34° 올려 조준
        const dirX = f.x <= center ? 1 : -1;
        barrelAngle = Math.atan2(-Math.sin(0.6), dirX * Math.cos(0.6));
      }

      // 차례 표시 = 남은 시간만큼 남는 링. 시계방향(12시부터)으로 점점 줄어듦.
      if (f.id === currentTurn) {
        const remain = Math.max(0, state.turnTimeMs - (state.now - state.turnStartedAt));
        const ratio = Math.min(1, remain / state.turnTimeMs);
        const r = 21;
        const cyRing = baseY - 12;
        // 배경 트랙 (옅게)
        ctx.strokeStyle = 'rgba(255,90,146,0.16)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(f.x, cyRing, r, 0, Math.PI * 2);
        ctx.stroke();
        // 남은 시간 arc
        const start = -Math.PI / 2; // 12시 방향
        ctx.strokeStyle = ratio <= 0.25 ? 'rgba(255,90,146,0.95)' : 'rgba(255,90,146,0.75)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(f.x, cyRing, r, start, start + ratio * Math.PI * 2);
        ctx.stroke();
        ctx.lineCap = 'butt';
      }

      this.drawTank(f.x, baseY, fill, stroke, barrelAngle);

      // HP 바 (탱크 위)
      const barW = 30;
      const barX = f.x - barW / 2;
      const barY = baseY - 40;
      ctx.fillStyle = COLORS.hpBack;
      ctx.fillRect(barX, barY, barW, 5);
      const ratio = Math.max(0, f.hp / FORT_HP);
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

  /**
   * 미니 심플 탱크 (모양 A). baseY = 지면 top.
   * 아래→위로 궤도 → 차체 → 포탑을 쌓고, 포탑 중앙에서 포신을 barrelAngle 로 회전.
   * barrelAngle 은 Canvas 좌표(y 아래+) 기준 라디안.
   */
  private drawTank(x: number, baseY: number, fill: string, stroke: string, barrelAngle: number): void {
    const ctx = this.ctx;
    const hullW = 24, hullH = 8, treadH = 7, turretW = 13, turretH = 7;
    const treadTop = baseY - treadH;
    const hullTop = treadTop - hullH;
    const turretTop = hullTop - turretH;
    const pivotY = turretTop + turretH / 2; // 포신 회전 중심 = 포탑 중앙

    // 궤도 + 바퀴 점
    ctx.fillStyle = COLORS.tread;
    this.roundRect(x - hullW / 2 - 2, treadTop, hullW + 4, treadH, 3.5);
    ctx.fill();
    ctx.fillStyle = COLORS.wheel;
    for (let i = 0; i < 4; i++) {
      const wx = x - hullW / 2 + 3 + (i * (hullW - 6)) / 3;
      ctx.beginPath();
      ctx.arc(wx, treadTop + treadH / 2, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 포신 — 포탑보다 먼저 그려 뿌리가 포탑 뒤로 들어가게. pivot 기준 회전.
    ctx.save();
    ctx.translate(x, pivotY);
    ctx.rotate(barrelAngle);
    ctx.fillStyle = stroke;
    this.roundRect(0, -2.5, 15, 5, 2.5);
    ctx.fill();
    ctx.restore();

    // 차체
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    this.roundRect(x - hullW / 2, hullTop, hullW, hullH, 3);
    ctx.fill();
    ctx.stroke();

    // 포탑
    this.roundRect(x - turretW / 2, turretTop, turretW, turretH, 3);
    ctx.fill();
    ctx.stroke();
  }

  /** 파괴된 포대 — 묘비 (둥근 윗부분 슬랩 + 작은 십자) */
  private drawTombstone(x: number, baseY: number): void {
    const ctx = this.ctx;
    const hw = 8; // 반폭
    // 슬랩 (아래 직선 → 위 반원)
    ctx.beginPath();
    ctx.moveTo(x - hw, baseY);
    ctx.lineTo(x - hw, baseY - 13);
    ctx.arc(x, baseY - 13, hw, Math.PI, 0); // 둥근 머리
    ctx.lineTo(x + hw, baseY);
    ctx.closePath();
    ctx.fillStyle = COLORS.stone;
    ctx.fill();
    ctx.strokeStyle = COLORS.stoneStroke;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // 십자 각인
    ctx.strokeStyle = COLORS.stoneStroke;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, baseY - 18);
    ctx.lineTo(x, baseY - 8);
    ctx.moveTo(x - 4, baseY - 15);
    ctx.lineTo(x + 4, baseY - 15);
    ctx.stroke();
  }

  private drawProjectile(p: { x: number; y: number }): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.projectile;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawAim(aim: NonNullable<RenderState['aim']>): void {
    const ctx = this.ctx;
    // 드래그 = (마우스 - 포대). 발사 방향은 그 반대.
    const dx = aim.mx - aim.fromX;
    const dy = aim.my - aim.fromY;
    const len = Math.hypot(dx, dy);
    if (len < 4) return;

    // 뒤로 당기는 점선 (드래그 방향)
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(140,110,150,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(aim.fromX, aim.fromY);
    ctx.lineTo(aim.mx, aim.my);
    ctx.stroke();
    ctx.setLineDash([]);

    // 파워 원뿔 — 포신에서 발사 방향으로. 길이·폭 = 파워, 색 노랑→빨강 그라데이션.
    const ux = -dx / len, uy = -dy / len;      // 발사 방향 단위벡터
    const nx = -uy, ny = ux;                    // 수직
    const L = 18 + aim.power01 * 60;            // 원뿔 길이
    const halfW = 4 + aim.power01 * 7;          // 끝단 반폭 (파워 클수록 넓게)
    const fx = aim.fromX + ux * L, fy = aim.fromY + uy * L;
    const grad = ctx.createLinearGradient(aim.fromX, aim.fromY, fx, fy);
    grad.addColorStop(0, '#ffd454'); // 뿌리 노랑
    grad.addColorStop(1, '#ff3b3b'); // 끝 빨강
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(aim.fromX + nx * 3, aim.fromY + ny * 3);   // 뿌리(살짝 폭)
    ctx.lineTo(fx + nx * halfW, fy + ny * halfW);          // 끝 위
    ctx.lineTo(fx - nx * halfW, fy - ny * halfW);          // 끝 아래
    ctx.lineTo(aim.fromX - nx * 3, aim.fromY - ny * 3);
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
    // 좌: 현재 차례 (타이머는 탱크 주위 링으로 표시하므로 여기선 이름만)
    const cur = g.forts.find((f) => f.id === g.currentTurn);
    const turnLabel = g.phase === 'ended' ? '게임 종료'
      : g.phase === 'firing' ? '발사 중…'
      : `${cur?.ownerNickname ?? '?'} 차례`;
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 13px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(`🎯 ${turnLabel}`, boxX + 14, 25);

    // 우: 바람 — 방향(▶/◀) 삼각형을 세기만큼 반복
    const wind = g.wind;
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 13px ${FONT}`;
    if (Math.abs(wind) < 6) {
      ctx.fillText('바람 무풍', boxX + boxW - 14, 25);
    } else {
      const count = 1 + Math.round(Math.min(1, Math.abs(wind) / MAX_WIND) * 3); // 1~4개
      const tri = (wind >= 0 ? '▶' : '◀').repeat(count);
      ctx.fillText(`바람 ${tri}`, boxX + boxW - 14, 25);
    }

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
