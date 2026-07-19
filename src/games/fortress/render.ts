/**
 * 포트리스 Canvas 렌더러 (사이드뷰)
 *
 * 레이어(아래→위): 하늘 배경 → 지형(흙) → 포대 + HP바 → 궤적 포탄 →
 *                    조준 가이드(내 차례) → 상단 HUD(턴·바람) → 종료 오버레이
 *
 * 조준 UI: 알까기/다트와 동일한 "드래그 반대 방향 발사" 규약.
 */

import { terrainTopAt, TERRAIN_HEIGHT } from './terrain';
import { MAX_WIND, MIN_POWER, MAX_POWER, segPos } from './physics';
import { FORT_HP, type FortressGame, type WeaponId } from './rules';


const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

/** 한 화면에 보여줄 최대 월드 가로 폭(논리 px). 화면이 이보다 넓어도 이만큼만 확대해 보여줌
 *  → 포대가 충분히 크게 보이고, 맵이 이보다 넓으면 가로 스크롤이 생긴다. */
const MAX_VIEW_W = 820;

/** 포대 색 — 플레이어별 (최대 10인). 서로 구분되는 10색 */
const FILL = [
  '#6ed9b3', '#ff6b9e', '#b89aff', '#ffd454', '#5b9cff',
  '#ffb12e', '#ff8a5b', '#7ed957', '#e07aff', '#4fd0d9',
] as const;
const STROKE = [
  '#2e8a70', '#c93d73', '#7a5fc7', '#c49a1f', '#3f78c9',
  '#c47f1a', '#c95f34', '#4e9e33', '#9a3fc4', '#2f9aa1',
] as const;

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
  /** 카메라가 가로로 따라갈 월드 x (현재 포대/날아가는 포탄). 없으면 맵 중앙 */
  focusX?: number;
  /** 유도탄 조준 중 타겟 위치(레티클 + 조준선). 없으면 null */
  guidedTarget?: { x: number; y: number } | null;
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
  /** 카메라 좌측 월드 x (부드러운 따라가기용, 시각 전용). null=아직 초기화 전 */
  private camLeft: number | null = null;

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
    if (rect.width === 0 || rect.height === 0) return; // 높이 0 이면 scale=0 → NaN 오염 방지
    const dpr = window.devicePixelRatio || 1;
    const logicalW = state.game.terrainWidth;

    // 스케일: 세로를 화면에 채우되, 화면이 너무 넓으면 MAX_VIEW_W 만큼만 보이도록 더 확대(줌인).
    //   → 포대가 크게 보이고 넓은 맵은 가로 스크롤. 세로가 넘치면 지형 바닥 기준 정렬(위 하늘만 잘림).
    const scale = Math.max(rect.height / TERRAIN_HEIGHT, rect.width / MAX_VIEW_W);
    const viewW = rect.width / scale; // 화면에 보이는 월드 가로 폭
    let targetLeft: number;
    if (viewW >= logicalW) {
      targetLeft = (logicalW - viewW) / 2; // 좁은 맵 → 가운데(양옆 레터박스)
    } else {
      const focus = state.focusX ?? logicalW / 2;
      targetLeft = Math.max(0, Math.min(logicalW - viewW, focus - viewW / 2));
    }
    // 부드러운 따라가기(시각 전용 — 시뮬 결정론과 무관). 비정상값이면 즉시 스냅해 복구.
    if (this.camLeft === null || !Number.isFinite(this.camLeft)) this.camLeft = targetLeft;
    else this.camLeft += (targetLeft - this.camLeft) * 0.18;

    // 세로 정렬: 월드 높이가 화면보다 크면 바닥(지형) 기준(위 하늘 잘림), 작으면 가운데.
    const worldHpx = TERRAIN_HEIGHT * scale;
    const offY = worldHpx <= rect.height ? (rect.height - worldHpx) / 2 : (rect.height - worldHpx);

    // screenToLogical 역변환용 오프셋은 '흔들림 제외'(안 그러면 클릭이 shake만큼 튀어 타겟 오조준).
    this.scaleCss = scale;
    this.offXCss = -this.camLeft * scale;
    this.offYCss = offY;
    // 그리기용 오프셋엔 착탄 흔들림(shake) 추가 (시각 전용)
    const shake = this.explosionShake(state.explosions, state.now);
    const drawOffX = this.offXCss + shake;
    const drawOffY = this.offYCss + shake * 0.7;

    // 전체 배경(레터박스 여백) 채우기
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#efe7f2';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // 논리 좌표계로 전환 (물리픽셀 = CSS × dpr)
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, drawOffX * dpr, drawOffY * dpr);

    this.drawSky(logicalW, state.now);
    this.drawWind(logicalW, state.game.wind, state.now);
    this.drawTerrain(state.hm);
    this.drawForts(state);
    this.drawShells(state.shells, state.flyingWeapon);
    this.drawExplosions(state.explosions, state.now);
    this.drawDamagePops(state.damagePops, state.now);
    if (state.aim) this.drawAim(state.aim, state.game.wind);
    if (state.guidedTarget) this.drawGuidedTarget(state);

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
    const ridge = (): void => {
      ctx.beginPath();
      ctx.moveTo(0, hm[0]!);
      for (let x = 1; x < w; x++) ctx.lineTo(x, hm[x]!);
    };
    // 흙 본체 (3단 그라데이션)
    ridge();
    ctx.lineTo(w, TERRAIN_HEIGHT);
    ctx.lineTo(0, TERRAIN_HEIGHT);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 150, 0, TERRAIN_HEIGHT);
    g.addColorStop(0, '#e0c3a2');
    g.addColorStop(0.5, '#cda67f');
    g.addColorStop(1, '#b0855f');
    ctx.fillStyle = g;
    ctx.fill();
    // 자갈 텍스처 (은은한 점) — 지면 아래에만
    ctx.fillStyle = 'rgba(138,106,74,0.15)';
    for (let i = 0; i < 46; i++) {
      const px = (i * 173) % w;
      const py = hm[Math.floor(px)]! + 30 + ((i * 97) % 160);
      if (py < TERRAIN_HEIGHT - 4) {
        ctx.beginPath();
        ctx.ellipse(px, py, 3 + ((i * 7) % 4), 2 + ((i * 5) % 3), 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 잔디 밴드 — 능선 따라 3겹(진→연→진 라인)
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ridge(); ctx.strokeStyle = '#8bcf8e'; ctx.lineWidth = 13; ctx.stroke();
    ridge(); ctx.strokeStyle = '#a6e0a3'; ctx.lineWidth = 7; ctx.stroke();
    ridge(); ctx.strokeStyle = '#7cc47f'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    // 잔디 뭉치 — 능선 위로 삐죽
    ctx.strokeStyle = '#7cc47f';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let x = 16; x < w; x += 34) {
      const gy = hm[x]!;
      ctx.beginPath();
      ctx.moveTo(x, gy - 1); ctx.lineTo(x - 3, gy - 8);
      ctx.moveTo(x, gy - 1); ctx.lineTo(x, gy - 10);
      ctx.moveTo(x, gy - 1); ctx.lineTo(x + 3, gy - 8);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
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
    const hullW = 28, hullH = 10, treadH = 8, turretR = 8.5;
    const treadTop = baseY - treadH;
    const hullTop = treadTop - hullH;
    const pivotY = hullTop - turretR * 0.3; // 포신 회전 중심(포탑 근처)

    // 바닥 그림자
    ctx.fillStyle = 'rgba(90,74,82,0.2)';
    ctx.beginPath();
    ctx.ellipse(x, baseY + 1, hullW * 0.6, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // 궤도 (짙은 캡슐 + 상단 하이라이트 + 바퀴)
    ctx.fillStyle = '#4a3b44';
    this.roundRect(x - hullW / 2 - 3, treadTop, hullW + 6, treadH, treadH / 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    this.roundRect(x - hullW / 2 - 1, treadTop + 1, hullW + 2, 2.2, 1.1);
    ctx.fill();
    ctx.fillStyle = '#9a8a92';
    for (let i = 0; i < 5; i++) {
      const wx = x - hullW / 2 + 2 + (i * (hullW - 4)) / 4;
      ctx.beginPath();
      ctx.arc(wx, treadTop + treadH / 2, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 포신 — 포탑보다 먼저(뿌리가 뒤로). 그라데이션 대신 색+상단 하이라이트+머즐.
    ctx.save();
    ctx.translate(x, pivotY);
    ctx.rotate(barrelAngle);
    ctx.fillStyle = stroke;
    this.roundRect(0, -3, 18, 6, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    this.roundRect(1, -2.6, 15, 1.6, 0.8);
    ctx.fill();
    ctx.fillStyle = stroke;
    this.roundRect(16, -3.6, 3.5, 7.2, 1.8); // 머즐
    ctx.fill();
    ctx.restore();

    // 차체 (솔리드 + 하단 안쪽 그림자 + 상단 하이라이트)
    ctx.fillStyle = fill;
    this.roundRect(x - hullW / 2, hullTop, hullW, hullH, 5);
    ctx.fill();
    ctx.save();
    this.roundRect(x - hullW / 2, hullTop, hullW, hullH, 5);
    ctx.clip();
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(x - hullW / 2, hullTop + hullH * 0.55, hullW, hullH);
    ctx.restore();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    this.roundRect(x - hullW / 2, hullTop, hullW, hullH, 5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    this.roundRect(x - hullW / 2 + 4, hullTop + 2.5, hullW - 13, 2.6, 1.3);
    ctx.fill();

    // 포탑 (돔 반원 + 하이라이트)
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, hullTop, turretR, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.ellipse(x - 3, hullTop - 3, 2.8, 1.7, -0.4, 0, Math.PI * 2);
    ctx.fill();
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
      if (now < e.start) continue; // 아직 시작 안 한 시차 폭발(에어스트라이크)
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

  /** 유도탄 락온 타겟 레티클 (조준은 드래그로 하므로 조준선/안내문 없음) */
  private drawGuidedTarget(state: RenderState): void {
    const t = state.guidedTarget!;
    const ctx = this.ctx;
    // 회전하는 레티클 (핑크 원 + 십자) — "락온" 느낌
    ctx.save();
    ctx.strokeStyle = COLORS.accentPink;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    const pulse = 1 + Math.sin(state.now / 260) * 0.06;
    const r = 16 * pulse;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(t.x - r - 7, t.y); ctx.lineTo(t.x - r + 3, t.y);
    ctx.moveTo(t.x + r - 3, t.y); ctx.lineTo(t.x + r + 7, t.y);
    ctx.moveTo(t.x, t.y - r - 7); ctx.lineTo(t.x, t.y - r + 3);
    ctx.moveTo(t.x, t.y + r - 3); ctx.lineTo(t.x, t.y + r + 7);
    ctx.stroke();
    ctx.restore();
  }

  private drawAim(aim: NonNullable<RenderState['aim']>, wind: number): void {
    const ctx = this.ctx;
    // 드래그 = (마우스 - 포대). 발사 방향은 그 반대.
    const dx = aim.mx - aim.fromX;
    const dy = aim.my - aim.fromY;
    const len = Math.hypot(dx, dy);
    if (len < 4) return;

    // 짧은 궤적 미리보기 — 실제 물리(중력+바람)로 앞부분만, 페이드(착탄점은 안 보여줘 실력 유지)
    const speed = MIN_POWER + (MAX_POWER - MIN_POWER) * aim.power01;
    const seg = { x0: aim.fromX, y0: aim.fromY, vx0: (-dx / len) * speed, vy0: (-dy / len) * speed, wind: Number.isFinite(wind) ? wind : 0 };
    for (let i = 1; i <= 7; i++) {
      const p = segPos(seg, i * 0.05);
      ctx.globalAlpha = 0.85 - i * 0.1;
      ctx.fillStyle = COLORS.accentPink;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

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

    // 상단 중앙 HUD 카드 — 좌: 차례(플레이어 색 점) / 우: 바람(화살표·물결). 폭은 이름 길이에 맞춤.
    const cur = g.forts.find((f) => f.id === g.currentTurn);
    const isMyTurn = !!cur && cur.ownerPeerId === state.myPeerId && g.phase === 'aiming' && !state.isSpectator;
    const turnLabel = g.phase === 'ended' ? '게임 종료'
      : g.phase === 'firing' ? '발사 중'
      : isMyTurn ? '내 차례' : `${cur?.ownerNickname ?? '?'} 차례`;

    const boxY = 10, boxH = 44, midY = boxY + boxH / 2;
    ctx.font = `800 14.5px ${FONT}`;
    const turnW = ctx.measureText(turnLabel).width;
    let boxW = Math.max(210, turnW + 150);   // 좌(점+이름) + 구분선 + 바람(≈102)
    boxW = Math.min(boxW, logicalW - 24);
    const boxX = (logicalW - boxW) / 2;

    // 카드 (세로 그라데이션 + 소프트 그림자 + 상단 하이라이트 + 핑크 테두리)
    ctx.save();
    ctx.shadowColor = 'rgba(150,110,140,0.22)';
    ctx.shadowBlur = 13;
    ctx.shadowOffsetY = 4;
    const bg = ctx.createLinearGradient(0, boxY, 0, boxY + boxH);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(1, '#fff4f9');
    ctx.fillStyle = bg;
    this.roundRect(boxX, boxY, boxW, boxH, 16);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#ffd0e0';
    ctx.lineWidth = 1.5;
    this.roundRect(boxX, boxY, boxW, boxH, 16);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    this.roundRect(boxX + 2, boxY + 1.5, boxW - 4, boxH - 4, 14);
    ctx.stroke();

    // 좌: 플레이어 색 점 + 차례 (내 차례면 핑크)
    ctx.textBaseline = 'middle';
    const dotCol = FILL[cur?.ownerIndex ?? 0] ?? FILL[0];
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(boxX + 19, midY, 5, 0, Math.PI * 2);
    ctx.fillStyle = dotCol;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = isMyTurn ? COLORS.accentPink : COLORS.textMain;
    ctx.font = `800 14.5px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(turnLabel, boxX + 32, midY + 0.5);

    // 구분선
    const divX = boxX + boxW - 102;
    ctx.strokeStyle = 'rgba(120,80,140,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(divX, boxY + 10);
    ctx.lineTo(divX, boxY + boxH - 10);
    ctx.stroke();

    // 우: 바람 (라벨 + 화살표 1~4개 / 무풍 물결)
    const gcy = midY, gx = divX + 12;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('바람', gx, gcy);
    const wind = Number.isFinite(g.wind) ? g.wind : 0;
    const mag = Math.min(1, Math.abs(wind) / MAX_WIND), dir = wind >= 0 ? 1 : -1;
    const cx0 = gx + 36, step = 10;
    if (mag < 0.06) {
      // 무풍 — 잔잔한 물결
      ctx.strokeStyle = 'rgba(150,140,165,0.6)';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      const wx = cx0 - 4, ww = 26;
      ctx.beginPath();
      ctx.moveTo(wx, gcy);
      ctx.quadraticCurveTo(wx + ww * 0.17, gcy - 4, wx + ww * 0.34, gcy);
      ctx.quadraticCurveTo(wx + ww * 0.5, gcy + 4, wx + ww * 0.66, gcy);
      ctx.quadraticCurveTo(wx + ww * 0.83, gcy - 4, wx + ww, gcy);
      ctx.stroke();
      ctx.lineCap = 'butt';
    } else {
      const count = Math.min(4, 1 + Math.round(mag * 3)); // 1~4
      const g0 = cx0 - 8, g1 = cx0 + (count - 1) * step + 10;
      const grad = ctx.createLinearGradient(dir > 0 ? g0 : g1, 0, dir > 0 ? g1 : g0, 0);
      grad.addColorStop(0, '#ffc4d8');
      grad.addColorStop(1, '#ff4f8b');
      ctx.fillStyle = grad;
      ctx.strokeStyle = grad;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2.4;
      for (let i = 0; i < count; i++) {
        const px = cx0 + i * step;
        const s = 0.8 + (dir > 0 ? i : count - 1 - i) * 0.12;
        const aw = 8 * s, ah = 6.5 * s;
        ctx.beginPath();
        if (dir > 0) { ctx.moveTo(px - aw / 2, gcy - ah); ctx.lineTo(px + aw / 2, gcy); ctx.lineTo(px - aw / 2, gcy + ah); }
        else { ctx.moveTo(px + aw / 2, gcy - ah); ctx.lineTo(px - aw / 2, gcy); ctx.lineTo(px + aw / 2, gcy + ah); }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.lineJoin = 'miter';
    }

    // 관전 배지
    if (state.isSpectator) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `600 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('관전 중', logicalW / 2, boxY + boxH + 14);
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
