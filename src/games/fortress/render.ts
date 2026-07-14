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
import { FORT_HP, type FortressGame, type WeaponId } from './rules';


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
  /** 날아가는 포탄들 (분열탄은 여러 개). fuseLeft 는 수류탄 카운트다운(ms) */
  shells: { x: number; y: number; fuseLeft: number }[];
  /** 현재 날아가는 무기 종류 (포탄 색/수류탄 퓨즈 표시용) */
  flyingWeapon: WeaponId;
  /** 폭발 이펙트 (확장 후 페이드) */
  explosions: { x: number; y: number; r: number; start: number }[];
  /** 데미지 숫자 팝업 */
  damagePops: { x: number; y: number; dmg: number; start: number }[];
  /** 포대별 마지막 피격 시각 (탱크 플래시) */
  fortHitAt: Record<number, number>;
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
    // 착탄 직후 화면 흔들림 (타격 피드백)
    const shake = this.explosionShake(state.explosions, state.now);
    this.offXCss = (rect.width - logicalW * scale) / 2 + shake;
    this.offYCss = (rect.height - TERRAIN_HEIGHT * scale) / 2 + shake * 0.7;

    // 전체 배경(레터박스 여백) 채우기
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#efe7f2';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // 논리 좌표계로 전환 (물리픽셀 = CSS × dpr)
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, this.offXCss * dpr, this.offYCss * dpr);

    this.drawSky(logicalW, state.now);
    this.drawWind(logicalW, state.game.wind, state.now);
    this.drawTerrain(state.hm);
    this.drawForts(state);
    this.drawShells(state.shells, state.flyingWeapon);
    this.drawExplosions(state.explosions, state.now);
    this.drawDamagePops(state.damagePops, state.now);
    if (state.aim) this.drawAim(state.aim);

    // HUD/종료 오버레이는 화면 좌표(캔버스 기준)로 — 레터박스에 밀려 잘리지 않게
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawHUD(state, rect.width);
    if (state.game.phase === 'ended') this.drawEndOverlay(state, rect.width, rect.height);
  }

  private drawSky(logicalW: number, now: number): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, TERRAIN_HEIGHT);
    g.addColorStop(0, COLORS.skyTop);
    g.addColorStop(1, COLORS.skyBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, logicalW, TERRAIN_HEIGHT);

    // 천천히 흐르는 구름 (파스텔 흰 뭉게)
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    const clouds = [
      { bx: 0.12, y: 44, r: 20 }, { bx: 0.42, y: 74, r: 16 },
      { bx: 0.66, y: 36, r: 22 }, { bx: 0.9, y: 82, r: 15 },
    ];
    const span = logicalW + 160;
    for (const c of clouds) {
      const cx = ((c.bx * logicalW + now * 0.008) % span + span) % span - 80;
      this.puff(cx, c.y, c.r);
    }
  }

  private puff(cx: number, cy: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.arc(cx + r * 1.1, cy + 4, r * 0.8, 0, Math.PI * 2);
    ctx.arc(cx - r, cy + 5, r * 0.75, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 바람 파티클 — 바람 방향으로 흐르는 옅은 선. 세기 클수록 많고 빠름 */
  private drawWind(logicalW: number, wind: number, now: number): void {
    const strength = Math.min(1, Math.abs(wind) / MAX_WIND);
    if (strength < 0.06) return;
    const ctx = this.ctx;
    const dir = wind >= 0 ? 1 : -1;
    const count = Math.round(strength * 14);
    const speed = 40 + strength * 130;
    const len = 8 + strength * 16;
    const span = logicalW + 60;
    ctx.strokeStyle = `rgba(150,160,180,${0.12 + strength * 0.16})`;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    for (let i = 0; i < count; i++) {
      const x = (((i * 137 + now * speed * 0.001 * dir) % span) + span) % span - 30;
      const y = 30 + ((i * 53) % 250);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - dir * len, y);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
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
        const deadNick = f.ownerNickname;
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

      // 피격 플래시 — 최근 맞았으면 흰 광 (200ms)
      const hitAt = state.fortHitAt[f.id];
      if (hitAt && state.now - hitAt < 200) {
        ctx.fillStyle = `rgba(255,255,255,${0.6 * (1 - (state.now - hitAt) / 200)})`;
        ctx.beginPath();
        ctx.arc(f.x, baseY - 11, 17, 0, Math.PI * 2);
        ctx.fill();
      }

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
      ctx.fillText(f.ownerNickname + (isMe ? ' (나)' : ''), f.x, barY - 3);
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

  private drawShells(shells: RenderState['shells'], weapon: WeaponId): void {
    const ctx = this.ctx;
    const isGrenade = weapon === 'grenade';
    for (const s of shells) {
      ctx.fillStyle = isGrenade ? '#5a7a3a' : COLORS.projectile; // 수류탄은 올리브색
      ctx.beginPath();
      ctx.arc(s.x, s.y, isGrenade ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      // 수류탄: 남은 퓨즈 초를 포탄 위에 작게 표시 (따라다님)
      if (isGrenade && s.fuseLeft !== Infinity && s.fuseLeft > 0) {
        ctx.fillStyle = COLORS.accentPink;
        ctx.font = `700 11px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(String(Math.ceil(s.fuseLeft / 1000)), s.x, s.y - 8);
      }
    }
  }

  /** 착탄 직후 화면 흔들림 크기(px) — 가장 최근 폭발 기준 220ms 감쇠 */
  private explosionShake(list: RenderState['explosions'], now: number): number {
    let mag = 0;
    for (const e of list) {
      const age = now - e.start;
      if (age >= 0 && age < 220) {
        const m = 9 * (1 - age / 220) * Math.min(1, e.r / 60);
        if (m > mag) mag = m;
      }
    }
    return mag === 0 ? 0 : (Math.random() * 2 - 1) * mag;
  }

  /** 데미지 숫자 팝업 — 위로 뜨며 페이드 (900ms) */
  private drawDamagePops(list: RenderState['damagePops'], now: number): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of list) {
      const t = Math.min(1, (now - d.start) / 900);
      const y = d.y - t * 26;
      ctx.globalAlpha = 1 - t;
      ctx.font = `900 ${16 + Math.min(8, d.dmg / 8)}px ${FONT}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(`-${d.dmg}`, d.x, y);
      ctx.fillStyle = '#ff3b3b';
      ctx.fillText(`-${d.dmg}`, d.x, y);
    }
    ctx.globalAlpha = 1;
  }

  /** 폭발 이펙트 — 확장하는 노랑 링 + 주황 글로우 + 초반 흰 플래시, 480ms 페이드 */
  private drawExplosions(list: RenderState['explosions'], now: number): void {
    const ctx = this.ctx;
    for (const e of list) {
      const t = Math.min(1, Math.max(0, (now - e.start) / 480));
      const rad = e.r * (0.35 + 0.85 * t);
      // 주황 글로우
      ctx.globalAlpha = (1 - t) * 0.5;
      ctx.fillStyle = '#ff9a3c';
      ctx.beginPath();
      ctx.arc(e.x, e.y, rad, 0, Math.PI * 2);
      ctx.fill();
      // 노랑 링
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffd454';
      ctx.beginPath();
      ctx.arc(e.x, e.y, rad, 0, Math.PI * 2);
      ctx.stroke();
      // 초반 흰 플래시 코어
      if (t < 0.45) {
        ctx.globalAlpha = 1 - t / 0.45;
        ctx.fillStyle = '#fff7e6';
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r * 0.3 * (1 - t), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
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
    // 끝을 바깥으로 볼록하게 — 삼각형 대신 둥근 마감
    ctx.quadraticCurveTo(fx + ux * halfW * 1.4, fy + uy * halfW * 1.4, fx - nx * halfW, fy - ny * halfW);
    ctx.lineTo(aim.fromX - nx * 3, aim.fromY - ny * 3);
    ctx.closePath();
    ctx.fill();
  }

  private drawHUD(state: RenderState, logicalW: number): void {
    const ctx = this.ctx;
    const g = state.game;

    // 상단 중앙 HUD 박스 — 불투명 + 테두리 + 그림자로 밝은 하늘에 묻히지 않게
    const boxW = 260;
    const boxX = (logicalW - boxW) / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(150,110,140,0.28)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#ffffff';
    this.roundRect(boxX, 10, boxW, 36, 11);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffc9dd';
    this.roundRect(boxX, 10, boxW, 36, 11);
    ctx.stroke();

    ctx.textBaseline = 'middle';
    // 좌: 현재 차례 (타이머는 탱크 주위 링으로 표시하므로 여기선 이름만)
    const cur = g.forts.find((f) => f.id === g.currentTurn);
    const turnLabel = g.phase === 'ended' ? '게임 종료'
      : g.phase === 'firing' ? '발사 중…'
      : `${cur?.ownerNickname ?? '?'} 차례`;
    const midY = 28; // 박스(10~46) 중앙
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 13px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(`🎯 ${turnLabel}`, boxX + 14, midY);

    // 우: 바람 — "바람" 라벨 + 방향(▶/◀) 삼각형(핑크, 세기만큼)
    const wind = g.wind;
    ctx.textAlign = 'right';
    ctx.font = `700 13px ${FONT}`;
    if (Math.abs(wind) < 6) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.fillText('바람 무풍', boxX + boxW - 14, midY);
    } else {
      const count = 1 + Math.round(Math.min(1, Math.abs(wind) / MAX_WIND) * 3); // 1~4개
      const tri = (wind >= 0 ? '▶' : '◀').repeat(count);
      ctx.fillStyle = COLORS.accentPink;
      ctx.fillText(`바람 ${tri}`, boxX + boxW - 14, midY);
    }

    // 관전 배지
    if (state.isSpectator) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `600 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('👀 관전 중', logicalW / 2, 60);
    }
  }

  private drawEndOverlay(state: RenderState, screenW: number, screenH: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.endOverlay;
    ctx.fillRect(0, 0, screenW, screenH);
    const winners = state.game.winnerPeerIds;
    const iWon = winners.includes(state.myPeerId);
    const isDraw = winners.length === 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 56px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(isDraw ? '⚖️' : '🏆', screenW / 2, screenH / 2 - 26);
    ctx.font = `900 26px ${FONT}`;
    ctx.fillStyle = iWon ? COLORS.accentPink : '#fff';
    const winNames = [...new Set(state.game.forts
      .filter((f) => winners.includes(f.ownerPeerId))
      .map((f) => f.ownerNickname))]
      .join(', ');
    const title = isDraw ? '무승부' : iWon ? (winners.length >= 2 ? '공동 우승!' : '승리!') : `${winNames} 승리`;
    ctx.fillText(title, screenW / 2, screenH / 2 + 26);
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
