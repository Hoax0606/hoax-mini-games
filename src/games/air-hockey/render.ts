/**
 * 에어하키 Canvas 렌더링 + 파티클 이펙트
 *
 * 역할:
 *   - GameState를 받아서 필드/말렛/퍽을 그림
 *   - PhysicsEvent를 받아서 파티클 이펙트(골/충돌/끼임리셋) 생성
 *   - phase별 오버레이(GOAL! / 카운트다운)
 *
 * 의도적으로 제외한 것:
 *   - 점수·닉네임 표시 → 캔버스 밖 DOM이 담당 (gameScreen.ts에서 처리)
 *   - 입력 처리 → 게임 스크린이 mouse/key listener 붙임
 *
 * 좌표계:
 *   - 논리 좌표: 800 x 400 (physics.ts와 동일)
 *   - 실제 캔버스 픽셀: CSS 크기 × devicePixelRatio
 *   - render()가 매 프레임 transform으로 매핑
 */

import {
  FIELD,
  CENTER_X,
  GOAL_Y_MIN,
  GOAL_Y_MAX,
  type GameState,
  type PhysicsEvent,
  type Side,
  type Vec2,
} from './physics';

// Canvas는 CSS 변수 직접 못 쓰므로 팔레트를 여기에 박음 (theme.css와 동기)
const COLORS = {
  tableBg: '#d1ecff',
  tableBgGradientEnd: '#b8dfff',
  tableBorder: '#86c9ff',
  centerLine: '#86c9ff',
  goalZone: 'rgba(255, 168, 199, 0.25)',
  goalLine: '#ff82ac',

  puckFill: '#ffd6e4',
  puckStroke: '#ff5a92',
  puckHeart: '#ff5a92',

  hostBody: '#ff82ac',
  hostStroke: '#ff5a92',
  hostInner: '#ffd6e4',

  guestBody: '#b89aff',
  guestStroke: '#9c7aeb',
  guestInner: '#e5d9ff',

  overlayBg: 'rgba(255, 255, 255, 0.55)',
  goalText: '#ff5a92',
  countdownText: '#4a3a4a',
} as const;

const GOAL_PARTICLE_COLORS = ['#ff5a92', '#ff82ac', '#b89aff', '#86e8c4', '#ffeec2'];

const FONT_SANS = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

// ============================================
// 파티클
// ============================================

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 남은 수명 (프레임) */
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

// ============================================
// Renderer
// ============================================

export interface RendererArgs {
  canvas: HTMLCanvasElement;
}

interface TrailDot {
  x: number;
  y: number;
  alpha: number; // 매 프레임 0.82 배로 감쇠
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private resizeObserver: ResizeObserver;
  /** 퍽 잔상 (최근 ~12프레임) — 빠를수록 꼬리 길게 보임 */
  private puckTrail: TrailDot[] = [];
  /** 화면 흔들림 상태 — 골 시 트리거됨 */
  private shakeFrames = 0;
  private shakeIntensity = 0;

  constructor(args: RendererArgs) {
    this.canvas = args.canvas;
    const ctx = args.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context를 가져올 수 없어요');
    this.ctx = ctx;

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  /** CSS 크기 × devicePixelRatio로 캔버스 내부 해상도 조정 */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
  }

  /**
   * 마우스 이벤트의 캔버스 내 좌표 → 논리 좌표(800x400)로 변환.
   * 입력 처리 쪽(gameScreen)이 사용.
   */
  canvasToLogical(canvasX: number, canvasY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: (canvasX / rect.width) * FIELD.WIDTH,
      y: (canvasY / rect.height) * FIELD.HEIGHT,
    };
  }

  /** 매 프레임 호출 */
  render(state: GameState, events: readonly PhysicsEvent[]): void {
    this.processEvents(events);
    this.updateParticles();
    this.updatePuckTrail(state.puck);
    // 골 이벤트가 오면 화면 흔들림 시작
    if (events.some((e) => e.kind === 'goal')) {
      this.triggerShake(16, 30);
    }

    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const pxW = rect.width * dpr;
    const pxH = rect.height * dpr;

    // 화면 클리어
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 논리 좌표계(800x400)로 transform + 화면 흔들림 오프셋 (픽셀 단위)
    const scaleX = pxW / FIELD.WIDTH;
    const scaleY = pxH / FIELD.HEIGHT;
    const { shakeX, shakeY } = this.nextShakeOffset();
    ctx.setTransform(scaleX, 0, 0, scaleY, shakeX, shakeY);

    this.drawField(ctx);
    this.drawMallet(ctx, state.mallets.host, 'host');
    this.drawMallet(ctx, state.mallets.guest, 'guest');
    // 궤적은 퍽 바로 아래에 그려 자연스럽게 "꼬리" 느낌
    this.drawPuckTrail(ctx);
    this.drawPuck(ctx, state.puck);
    this.drawParticles(ctx);
    this.drawPhaseOverlay(ctx, state);
  }

  // ============================================
  // 퍽 궤적 / 화면 흔들림
  // ============================================

  private updatePuckTrail(puck: { x: number; y: number }): void {
    // 기존 점들 alpha 감쇠
    for (const t of this.puckTrail) t.alpha *= 0.82;
    // 앞쪽에 새 점 추가 (최신이 앞)
    this.puckTrail.unshift({ x: puck.x, y: puck.y, alpha: 1 });
    // 오래된 건 제거
    if (this.puckTrail.length > 14) this.puckTrail.pop();
  }

  private drawPuckTrail(ctx: CanvasRenderingContext2D): void {
    // 뒤쪽(오래된)부터 그려서 최신 점이 위에 오게
    for (let i = this.puckTrail.length - 1; i >= 0; i--) {
      const t = this.puckTrail[i]!;
      const alpha = t.alpha * 0.42;
      if (alpha < 0.03) continue;
      const sizeRatio = 0.45 + 0.55 * (1 - i / this.puckTrail.length);
      ctx.fillStyle = `rgba(255, 107, 158, ${alpha})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, FIELD.PUCK_RADIUS * sizeRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private triggerShake(intensity: number, frames: number): void {
    // 더 강한 흔들림이 이미 진행 중이면 덮어쓰지 않음
    if (this.shakeFrames > 0 && this.shakeIntensity >= intensity) return;
    this.shakeFrames = frames;
    this.shakeIntensity = intensity;
  }

  private nextShakeOffset(): { shakeX: number; shakeY: number } {
    if (this.shakeFrames <= 0) return { shakeX: 0, shakeY: 0 };
    const decay = this.shakeFrames / 30; // 1 → 0로 감쇠
    const mag = this.shakeIntensity * decay;
    const shakeX = (Math.random() - 0.5) * mag;
    const shakeY = (Math.random() - 0.5) * mag;
    this.shakeFrames--;
    return { shakeX, shakeY };
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.particles.length = 0;
    this.puckTrail.length = 0;
  }

  // ============================================
  // 이벤트 → 파티클
  // ============================================

  private processEvents(events: readonly PhysicsEvent[]): void {
    for (const ev of events) {
      switch (ev.kind) {
        case 'mallet_hit':
          this.spawnMalletHit(ev.x, ev.y, ev.intensity);
          break;
        case 'wall_hit':
          this.spawnWallHit(ev.x, ev.y);
          break;
        case 'goal':
          // 득점한 쪽의 반대편 골대 = 퍽이 들어간 위치
          this.spawnGoalBurst(
            ev.side === 'host' ? FIELD.WIDTH : 0,
            FIELD.HEIGHT / 2,
          );
          break;
      }
    }
  }

  private spawnMalletHit(x: number, y: number, intensity: number): void {
    const count = 4 + Math.floor(intensity * 6);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.8 + Math.random() * 2;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        maxLife: 18 + Math.random() * 8,
        color: '#ffffff',
        size: 1.5 + Math.random() * 1.5,
      });
    }
  }

  private spawnWallHit(x: number, y: number): void {
    for (let i = 0; i < 3; i++) {
      const angle = Math.random() * Math.PI * 2;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * 0.8,
        vy: Math.sin(angle) * 0.8,
        life: 1,
        maxLife: 12,
        color: '#ffc9dd',
        size: 1.2,
      });
    }
  }

  private spawnGoalBurst(x: number, y: number): void {
    for (let i = 0; i < 36; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 4.5;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        maxLife: 40 + Math.random() * 20,
        color: GOAL_PARTICLE_COLORS[Math.floor(Math.random() * GOAL_PARTICLE_COLORS.length)]!,
        size: 2.5 + Math.random() * 3,
      });
    }
  }

  private updateParticles(): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.x += p.vx;
      p.y += p.vy;
      // 약한 감속 + 중력 없음 (공중이 아니라 바닥이라 가정)
      p.vx *= 0.94;
      p.vy *= 0.94;
      p.life -= 1 / p.maxLife;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ============================================
  // 필드 / 말렛 / 퍽 그리기
  // ============================================

  private drawField(ctx: CanvasRenderingContext2D): void {
    // 배경 그라데이션
    const grad = ctx.createLinearGradient(0, 0, 0, FIELD.HEIGHT);
    grad.addColorStop(0, COLORS.tableBg);
    grad.addColorStop(1, COLORS.tableBgGradientEnd);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, FIELD.WIDTH, FIELD.HEIGHT);

    // 테두리
    ctx.strokeStyle = COLORS.tableBorder;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, FIELD.WIDTH - 3, FIELD.HEIGHT - 3);

    // 골 영역 하이라이트 (양쪽)
    ctx.fillStyle = COLORS.goalZone;
    ctx.fillRect(0, GOAL_Y_MIN, 12, GOAL_Y_MAX - GOAL_Y_MIN);
    ctx.fillRect(FIELD.WIDTH - 12, GOAL_Y_MIN, 12, GOAL_Y_MAX - GOAL_Y_MIN);

    // 골 라인 (핑크 굵은 세로선)
    ctx.strokeStyle = COLORS.goalLine;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(2, GOAL_Y_MIN);
    ctx.lineTo(2, GOAL_Y_MAX);
    ctx.moveTo(FIELD.WIDTH - 2, GOAL_Y_MIN);
    ctx.lineTo(FIELD.WIDTH - 2, GOAL_Y_MAX);
    ctx.stroke();

    // 센터라인 (점선)
    ctx.strokeStyle = COLORS.centerLine;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(CENTER_X, 8);
    ctx.lineTo(CENTER_X, FIELD.HEIGHT - 8);
    ctx.stroke();
    ctx.setLineDash([]);

    // 중앙 원
    ctx.strokeStyle = COLORS.centerLine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(CENTER_X, FIELD.HEIGHT / 2, 42, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawMallet(ctx: CanvasRenderingContext2D, mallet: { x: number; y: number }, side: Side): void {
    const isHost = side === 'host';
    // 호스트 = 민트, 게스트 = 노랑 (파스텔 팔레트 유지)
    const body       = isHost ? '#6ed9b3' : '#ffd454';
    const bodyDark   = isHost ? '#2e8a70' : '#c49a1f';
    const bodyDeep   = isHost ? '#1f6a55' : '#8e6f10';
    const knobMid    = isHost ? '#a8f0d5' : '#ffe58a';
    const knobTop    = isHost ? '#d4f9ea' : '#fff3c5';
    const r = FIELD.MALLET_RADIUS;

    ctx.save();
    ctx.translate(mallet.x, mallet.y);

    // ---- 베이스 원반 옆면 (살짝 아래 오프셋된 어두운 원) — 두께감 ----
    ctx.fillStyle = bodyDeep;
    ctx.beginPath();
    ctx.arc(0, r * 0.12, r, 0, Math.PI * 2);
    ctx.fill();

    // ---- 베이스 원반 윗면 (솔리드 단색) ----
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // ---- 윗면 테두리 (또렷한 원반 실루엣) ----
    ctx.strokeStyle = bodyDark;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    // ---- 손잡이 (중앙 그립) ----
    // 손잡이 밑바닥 음영 링
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, r * 0.02, r * 0.48, 0, Math.PI * 2);
    ctx.stroke();

    // 손잡이 측면 (중간 톤)
    ctx.fillStyle = knobMid;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
    ctx.fill();

    // 손잡이 상단 (밝은 톤, 살짝 위로 오프셋)
    ctx.fillStyle = knobTop;
    ctx.beginPath();
    ctx.arc(0, -1, r * 0.36, 0, Math.PI * 2);
    ctx.fill();

    // 손잡이 테두리
    ctx.strokeStyle = bodyDark;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
    ctx.stroke();

    // ---- 얇은 상단 크레센트 — 미세 반사광 ----
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, -r * 0.1, r * 0.82, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();

    ctx.restore();
  }

  private drawPuck(ctx: CanvasRenderingContext2D, puck: { x: number; y: number }): void {
    const r = FIELD.PUCK_RADIUS;
    ctx.save();
    ctx.translate(puck.x, puck.y);

    // 바닥 그림자
    ctx.fillStyle = 'rgba(150, 50, 90, 0.22)';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.2, r * 0.88, r * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();

    // 옆면 (아래쪽으로 살짝 오프셋된 진한 핑크)
    ctx.fillStyle = '#c93d73';
    ctx.beginPath();
    ctx.arc(0, r * 0.12, r, 0, Math.PI * 2);
    ctx.fill();

    // 윗면 (밝은 핑크 솔리드 단색)
    ctx.fillStyle = '#ff6b9e';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // 윗면 테두리
    ctx.strokeStyle = '#a82a5c';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    // 중앙 동심원 — 퍽 상판 디테일
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
    ctx.stroke();

    // 얇은 상단 크레센트 — 미세 반사광
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, -r * 0.08, r * 0.78, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();

    ctx.restore();
  }

  // ============================================
  // Phase 오버레이
  // ============================================

  private drawPhaseOverlay(ctx: CanvasRenderingContext2D, state: GameState): void {
    if (state.phase === 'goal_pause') {
      ctx.fillStyle = COLORS.overlayBg;
      ctx.fillRect(0, 0, FIELD.WIDTH, FIELD.HEIGHT);

      ctx.fillStyle = COLORS.goalText;
      ctx.font = `900 72px ${FONT_SANS}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GOAL!', FIELD.WIDTH / 2, FIELD.HEIGHT / 2);
    }
  }
}
