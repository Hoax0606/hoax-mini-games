/**
 * 반응속도 게임 Canvas 렌더러
 *
 * 레이아웃 (800×400):
 *   ┌──────────────────────────────────────────┐
 *   │   Round 2 / 5                    182ms   │  ← 라운드 표시 + 평균
 *   │                                          │
 *   │            ┌──────────────┐              │
 *   │            │              │              │
 *   │            │   큰 원      │              │  ← 상태별 색:
 *   │            │              │              │     빨강 = 대기 중 (클릭 X)
 *   │            └──────────────┘              │     초록 = GO! (클릭!)
 *   │                                          │     회색 = 결과 표시
 *   │        상태 안내 텍스트                   │
 *   │                                          │
 *   │  [상대1] [상대2] [상대3]  미니뷰           │
 *   └──────────────────────────────────────────┘
 */

import { fitContain } from '../_shared/canvasFit';

const CANVAS_W = 800;
const CANVAS_H = 400;
const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

const COLORS = {
  bg: '#fff9fd',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  // 상태별 원 색
  waitFill: '#ff82ac',     waitStroke: '#c93d73',  // 빨강 (클릭 X)
  goFill: '#86e8c4',       goStroke: '#2e8a70',    // 초록 (클릭!)
  resultFill: '#d9c7ff',   resultStroke: '#9c7aeb',// 보라 (결과)
  foulFill: '#ff6b83',     foulStroke: '#c9304e',  // 실격 — 흰 글씨 가독되게 또렷한 코랄레드
  oppCardBg: '#faf5ff',
  oppCardBorder: '#d9c7ff',
  gold: '#ffc24d',         // 최고 등급(번개)
} as const;

// ============================================
// 모션 헬퍼 (apple-design: 순간 전환 스냅 + 결과 팝)
// ============================================

const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** easeOutBack — 살짝 오버슈트(팝) */
function easeOutBack(t: number): number {
  if (t >= 1) return 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}
/** easeOut(제곱) */
function easeOut(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - (1 - c) * (1 - c);
}
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 반응속도 등급 — ms별 라벨 + 색 (빠를수록 화려) */
function speedTier(ms: number): { label: string; color: string } {
  if (ms < 180) return { label: '⚡ 번개!', color: COLORS.gold };
  if (ms < 250) return { label: '아주 빠름', color: COLORS.goStroke };
  if (ms < 350) return { label: '좋아요', color: COLORS.resultStroke };
  return { label: '느긋', color: COLORS.waitStroke };
}

/** 현재 라운드 상태. index.ts 의 Phase 와 매칭 */
export type ReflexPhase =
  | { kind: 'idle' }                                // 첫 화면 (안내)
  | { kind: 'waiting' }                             // 빨강 (랜덤 대기 중)
  | { kind: 'go' }                                  // 초록 (클릭!)
  | { kind: 'result'; ms: number }                  // 클릭 성공 후 결과 표시
  | { kind: 'foul' }                                // 빨강 때 눌렀을 때 실격
  | { kind: 'done'; finalAvgMs: number; foulCount: number }; // 5라운드 완료

/** 상대 미니뷰에 표시할 라이브 phase. 'idle' = 아직 시작 안 함 / 정보 없음 */
export type OpponentPhase = 'idle' | 'waiting' | 'go' | 'result' | 'foul' | 'done';

export interface OpponentState {
  peerId: string;
  nickname: string;
  roundsDone: number;
  avgMs: number;
  foulCount: number;
  /** 5라운드 모두 완료? */
  finished: boolean;
  /** 라이브 phase — 빨강/초록/결과 색깔로 미니뷰에 표시 */
  phase: OpponentPhase;
  /** result phase 일 때 직전 라운드 ms (있으면 카드에 잠깐 표시) */
  lastMs?: number;
}

export interface RenderState {
  phase: ReflexPhase;
  currentRound: number;   // 1~5
  totalRounds: number;    // 5
  myAvgMs: number;        // 진행 중 평균
  myFoulCount: number;
  opponents: OpponentState[];
}

export interface ReflexRendererArgs {
  canvas: HTMLCanvasElement;
}

export class ReflexRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  /** phase 가 바뀐 로컬 시각 — 원 팝/스냅/흔들림 애니 기준(렌더러 자체 감지) */
  private lastPhaseKind = '';
  private phaseAt = 0;

  constructor(args: ReflexRendererArgs) {
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
    const now = performance.now();
    // phase 전환 감지 → 애니 시작점 기록 (GO 스냅/결과 팝/실격 흔들림용)
    if (state.phase.kind !== this.lastPhaseKind) {
      this.lastPhaseKind = state.phase.kind;
      this.phaseAt = now;
    }
    // 균일 스케일+레터박스 (비율 유지 → 안 찌부러짐)
    fitContain(ctx, this.canvas, CANVAS_W, CANVAS_H, COLORS.bg);

    // 상단 상태 바: 라운드 + 내 평균
    this.drawStatusBar(state);

    // 중앙 큰 원 (상태·안내를 원 안에서 다 보여줌 — 아래 별도 안내 텍스트 없앰)
    // 상대가 없으면(혼자) 하단이 비므로 원을 살짝 내려 세로 중앙에 맞춤
    const circleCy = state.opponents.length > 0 ? 190 : 212;
    this.drawTargetCircle(state.phase, now, circleCy);

    // 상대 미니뷰 (하단)
    this.drawOpponents(state.opponents, now);
  }

  /** 프로스티드 필/카드 (반투명 흰색 + 소프트 섀도 + 라운드) */
  private frosted(x: number, y: number, w: number, h: number, radius: number, active = false): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = active ? 'rgba(255, 90, 146, 0.2)' : 'rgba(120, 80, 140, 0.14)';
    ctx.shadowBlur = active ? 13 : 8;
    ctx.shadowOffsetY = active ? 5 : 3;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.strokeStyle = active ? COLORS.goStroke : 'rgba(216, 199, 255, 0.7)';
    ctx.lineWidth = active ? 2 : 1;
    ctx.stroke();
  }

  private drawStatusBar(state: RenderState): void {
    const ctx = this.ctx;
    const y = 18;

    // 왼쪽: ROUND 필 (내용 크기에 맞춤)
    this.drawStatPill(24, y, 'ROUND', `${state.currentRound} / ${state.totalRounds}`, false);

    // 오른쪽: 내 평균 필 (오른쪽 끝 정렬)
    const avgText = state.myAvgMs > 0 ? `${Math.round(state.myAvgMs)}ms` : '—';
    const avgW = this.statPillWidth('평균', avgText);
    const avgX = CANVAS_W - 24 - avgW;
    this.drawStatPill(avgX, y, '평균', avgText, false);

    // 실격 — 평균 필 아래, 오른쪽 끝 정렬된 빨간 칩 (떠다니지 않게)
    if (state.myFoulCount > 0) {
      const label = `✕ 실격 ${state.myFoulCount}`;
      ctx.font = `800 11px ${FONT}`;
      const cw = ctx.measureText(label).width + 22;
      const ch = 22;
      const cxp = CANVAS_W - 24 - cw;
      const cyp = y + 26 + 8;
      ctx.beginPath();
      ctx.roundRect(cxp, cyp, cw, ch, ch / 2);
      ctx.fillStyle = 'rgba(201, 48, 78, 0.12)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(201, 48, 78, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = COLORS.foulStroke;
      ctx.font = `800 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cxp + cw / 2, cyp + ch / 2 + 0.5);
    }
  }

  /** 상태 필 내부 콘텐츠 폭 계산 (라벨 + 값 한 줄) */
  private statPillWidth(label: string, value: string): number {
    const ctx = this.ctx;
    const padX = 12, gap = 6;
    ctx.font = `800 10px ${FONT}`;
    const lw = ctx.measureText(label).width;
    ctx.font = `900 13px ${FONT}`;
    const vw = ctx.measureText(value).width;
    return padX * 2 + lw + gap + vw;
  }

  /** 프로스티드 상태 필 — [라벨(muted)] [값(bold)] 한 줄, 작고 내용 크기에 맞춘 폭 (실격 칩과 톤 통일) */
  private drawStatPill(x: number, y: number, label: string, value: string, active: boolean): void {
    const ctx = this.ctx;
    const padX = 12, gap = 6, h = 26;
    ctx.font = `800 10px ${FONT}`;
    const lw = ctx.measureText(label).width;
    ctx.font = `900 13px ${FONT}`;
    const vw = ctx.measureText(value).width;
    const w = padX * 2 + lw + gap + vw;

    this.frosted(x, y, w, h, h / 2, active);

    const midY = y + h / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `800 10px ${FONT}`;
    ctx.fillText(label, x + padX, midY + 0.5);
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `900 13px ${FONT}`;
    ctx.fillText(value, x + padX + lw + gap, midY);
  }

  private drawTargetCircle(phase: ReflexPhase, now: number, cy: number): void {
    const ctx = this.ctx;
    const cx = CANVAS_W / 2;
    const r = 92;
    const age = now - this.phaseAt;

    // 색 (result 는 등급 색)
    let fill: string, stroke: string;
    switch (phase.kind) {
      case 'idle':    fill = COLORS.resultFill; stroke = COLORS.resultStroke; break;
      case 'waiting': fill = COLORS.waitFill;   stroke = COLORS.waitStroke; break;
      case 'go':      fill = COLORS.goFill;     stroke = COLORS.goStroke; break;
      case 'result':  fill = speedTier(phase.ms).color; stroke = 'rgba(0,0,0,0.1)'; break;
      case 'foul':    fill = COLORS.foulFill;   stroke = COLORS.foulStroke; break;
      case 'done':    fill = COLORS.resultFill; stroke = COLORS.resultStroke; break;
    }

    // 모션 변수 (reduced-motion 이면 정지 상태)
    let scale = 1;
    let shakeX = 0;
    if (!prefersReducedMotion) {
      if (phase.kind === 'waiting') {
        scale = 1 + Math.sin(now / 420) * 0.012; // 대기 브리딩(긴장감)
      } else if (phase.kind === 'go') {
        scale = 0.9 + 0.15 * easeOut(clamp01(age / 220)); // 초록 순간 전환 스냅
      } else if (phase.kind === 'result') {
        scale = 0.8 + 0.2 * easeOutBack(clamp01(age / 300)); // 결과 팝
      } else if (phase.kind === 'foul') {
        shakeX = Math.sin(age / 22) * Math.max(0, 1 - age / 500) * 10; // 실격 흔들림
      }
    }

    // GO 확산 플래시 링 (반응 신호를 눈에 확 꽂기)
    if (phase.kind === 'go' && !prefersReducedMotion) {
      const ft = clamp01(age / 420);
      if (ft < 1) {
        ctx.strokeStyle = `rgba(46, 138, 112, ${(1 - ft) * 0.6})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, r + ft * 70, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // 실격 진입 빨간 확산 플래시 (실수 신호)
    if (phase.kind === 'foul' && !prefersReducedMotion) {
      const ft = clamp01(age / 420);
      if (ft < 1) {
        ctx.strokeStyle = `rgba(201, 48, 78, ${(1 - ft) * 0.6})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, r + ft * 60, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 본체 (드롭섀도로 띄우고, 젤리 광택 대신 은은한 방사 하이라이트)
    ctx.save();
    ctx.translate(cx + shakeX, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    ctx.save();
    ctx.shadowColor = 'rgba(90, 60, 110, 0.22)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
    // 테두리 — 파스텔 톤에 맞춰 연하게 (반투명 + 얇게)
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    const hi = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.38, r * 0.05, cx - r * 0.3, cy - r * 0.38, r * 0.9);
    hi.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
    hi.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = hi;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 원 내부 텍스트
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    switch (phase.kind) {
      case 'idle': {
        ctx.fillStyle = '#fff';
        ctx.font = `800 20px ${FONT}`;
        ctx.fillText('시작', cx, cy);
        break;
      }
      case 'waiting': {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.font = `800 24px ${FONT}`;
        ctx.fillText('준비', cx, cy);
        break;
      }
      case 'go': {
        ctx.fillStyle = '#fff';
        ctx.font = `900 46px ${FONT}`;
        ctx.fillText('지금!', cx, cy);
        break;
      }
      case 'result': {
        const tier = speedTier(phase.ms);
        ctx.fillStyle = COLORS.textMain;
        ctx.font = `900 46px ${FONT}`;
        ctx.fillText(`${phase.ms}`, cx, cy - 8);
        ctx.font = `700 13px ${FONT}`;
        ctx.fillText('ms', cx, cy + 18);
        ctx.fillStyle = tier.color;
        ctx.font = `900 16px ${FONT}`;
        ctx.fillText(tier.label, cx, cy + 40);
        break;
      }
      case 'foul': {
        ctx.fillStyle = '#fff';
        ctx.font = `900 34px ${FONT}`;
        ctx.fillText('✕', cx, cy - 30);
        ctx.font = `900 24px ${FONT}`;
        ctx.fillText('너무 빨라요', cx, cy + 4);
        ctx.font = `700 12px ${FONT}`;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fillText('실격', cx, cy + 30);
        break;
      }
      case 'done': {
        ctx.fillStyle = '#fff';
        ctx.font = `800 20px ${FONT}`;
        ctx.fillText('완료!', cx, cy - 20);
        ctx.font = `900 28px ${FONT}`;
        ctx.fillText(
          phase.finalAvgMs > 0 ? `평균 ${Math.round(phase.finalAvgMs)}ms` : '모두 실격',
          cx, cy + 10,
        );
        break;
      }
    }
  }

  private drawOpponents(opponents: OpponentState[], now: number): void {
    const ctx = this.ctx;
    const n = opponents.length;
    if (n === 0) return;

    const margin = 18;
    const gap = n > 5 ? 6 : 12;
    // 10인(최대 상대 9명)까지 한 줄에 들어가게 카드 폭을 화면 폭에 맞춰 축소
    const cardW = Math.min(150, (CANVAS_W - margin * 2 - gap * (n - 1)) / n);
    const cardH = 58;
    const compact = cardW < 112; // 좁으면 이름/속도/판수를 세로로 스택
    const totalW = n * cardW + (n - 1) * gap;
    const startX = (CANVAS_W - totalW) / 2;
    const y = 326;

    for (let i = 0; i < n; i++) {
      const opp = opponents[i]!;
      const x = startX + i * (cardW + gap);
      const st = oppPhaseStyle(opp);
      const emphasize = opp.phase === 'go' || opp.finished;

      // 프로스티드 카드
      ctx.save();
      ctx.shadowColor = 'rgba(120, 80, 140, 0.13)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 3;
      ctx.beginPath();
      ctx.roundRect(x, y, cardW, cardH, 12);
      ctx.fillStyle = st.bg;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.roundRect(x, y, cardW, cardH, 12);
      ctx.strokeStyle = emphasize ? st.dot : 'rgba(216, 199, 255, 0.7)';
      ctx.lineWidth = emphasize ? 2 : 1.1;
      ctx.stroke();

      // phase 인디케이터 점 + GO 펄스
      ctx.fillStyle = st.dot;
      ctx.beginPath();
      ctx.arc(x + 12, y + 16, 5, 0, Math.PI * 2);
      ctx.fill();
      if (opp.phase === 'go') {
        const pulse = (Math.sin(now / 140) + 1) / 2;
        ctx.strokeStyle = `rgba(46, 138, 112, ${0.35 + pulse * 0.4})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x + 12, y + 16, 7 + pulse * 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 왼쪽 정렬 기준 컬럼 — 이름/속도/판수를 모두 여기 맞춤
      const lx = x + 22;

      // 이름
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `700 ${compact ? 11 : 13}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncate(opp.nickname, compact ? 4 : 8), lx, y + 16);

      // 속도 값 (result=직전 ms 강조 / else 평균)
      const isRes = opp.phase === 'result' && typeof opp.lastMs === 'number' && opp.lastMs > 0;
      const valTxt = isRes ? `${opp.lastMs}ms` : (opp.avgMs > 0 ? `${Math.round(opp.avgMs)}ms` : '-');
      ctx.fillStyle = isRes ? COLORS.resultStroke : COLORS.textMain;
      let dotsY: number;
      if (compact) {
        // 좁음: 속도도 왼쪽 컬럼(lx)에 → 이름·속도·판수 셋 다 좌측 정렬로 스택
        ctx.font = `900 13px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.fillText(valTxt, lx, y + 32);
        dotsY = y + 46;
      } else {
        // 넓음: 이름 옆(우)에 속도, 아래 한 줄에 판수
        ctx.font = `900 15px ${FONT}`;
        ctx.textAlign = 'right';
        ctx.fillText(valTxt, x + cardW - 12, y + 16);
        dotsY = y + 40;
      }

      // 판수 = 5칸 라운드 점 (lx 정렬 — 이름/속도와 좌측 맞춤)
      const dotR = compact ? 2.4 : 3;
      const dgap = compact ? 7 : 9.5;
      for (let d = 0; d < 5; d++) {
        ctx.beginPath();
        ctx.arc(lx + dotR + d * dgap, dotsY, dotR, 0, Math.PI * 2);
        if (d < opp.roundsDone) {
          ctx.fillStyle = opp.finished ? COLORS.goStroke : COLORS.resultStroke;
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(180, 160, 210, 0.6)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // 우측 하단 — 완료 ✓ / 실격 수
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      if (opp.finished) {
        ctx.fillStyle = COLORS.goStroke;
        ctx.font = `800 11px ${FONT}`;
        ctx.fillText('✓', x + cardW - 12, dotsY);
      } else if (opp.foulCount > 0) {
        ctx.fillStyle = COLORS.foulStroke;
        ctx.font = `700 9px ${FONT}`;
        ctx.fillText(`실격 ${opp.foulCount}`, x + cardW - 10, dotsY);
      }
    }
  }
}

/** opponent.phase → 인디케이터 점 색 + 프로스티드 카드 배경(반투명) */
function oppPhaseStyle(opp: OpponentState): { dot: string; bg: string } {
  if (opp.finished) return { dot: COLORS.goStroke, bg: 'rgba(230, 255, 245, 0.7)' };
  switch (opp.phase) {
    case 'waiting': return { dot: COLORS.waitFill,     bg: 'rgba(255, 240, 245, 0.7)' };
    case 'go':      return { dot: COLORS.goFill,       bg: 'rgba(230, 255, 245, 0.8)' };
    case 'result':  return { dot: COLORS.resultStroke, bg: 'rgba(245, 237, 255, 0.7)' };
    case 'foul':    return { dot: COLORS.foulStroke,   bg: 'rgba(255, 230, 230, 0.75)' };
    case 'idle':
    case 'done':
    default:        return { dot: '#cfc0e0',           bg: 'rgba(255, 255, 255, 0.5)' };
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
