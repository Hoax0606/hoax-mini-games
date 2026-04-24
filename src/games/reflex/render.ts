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
  foulFill: '#ffc9dd',     foulStroke: '#a82a5c',  // 실격
  oppCardBg: '#faf5ff',
  oppCardBorder: '#d9c7ff',
} as const;

/** 현재 라운드 상태. index.ts 의 Phase 와 매칭 */
export type ReflexPhase =
  | { kind: 'idle' }                                // 첫 화면 (안내)
  | { kind: 'waiting' }                             // 빨강 (랜덤 대기 중)
  | { kind: 'go' }                                  // 초록 (클릭!)
  | { kind: 'result'; ms: number }                  // 클릭 성공 후 결과 표시
  | { kind: 'foul' }                                // 빨강 때 눌렀을 때 실격
  | { kind: 'done'; finalAvgMs: number; foulCount: number }; // 5라운드 완료

export interface OpponentState {
  peerId: string;
  nickname: string;
  roundsDone: number;
  avgMs: number;
  foulCount: number;
  /** 5라운드 모두 완료? */
  finished: boolean;
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

    // 상단 상태 바: 라운드 + 내 평균
    this.drawStatusBar(state);

    // 중앙 큰 원
    this.drawTargetCircle(state.phase);

    // 안내 텍스트
    this.drawGuidanceText(state.phase);

    // 상대 미니뷰 (하단)
    this.drawOpponents(state.opponents);
  }

  private drawStatusBar(state: RenderState): void {
    const ctx = this.ctx;

    // 왼쪽: Round 표시
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 12px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('ROUND', 28, 28);

    ctx.fillStyle = COLORS.textMain;
    ctx.font = `900 24px ${FONT}`;
    ctx.fillText(`${state.currentRound} / ${state.totalRounds}`, 28, 54);

    // 오른쪽: 내 평균
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 12px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText('내 평균', CANVAS_W - 28, 28);

    ctx.fillStyle = COLORS.textMain;
    ctx.font = `900 24px ${FONT}`;
    const avgText = state.myAvgMs > 0 ? `${Math.round(state.myAvgMs)}ms` : '-';
    ctx.fillText(avgText, CANVAS_W - 28, 54);

    if (state.myFoulCount > 0) {
      ctx.fillStyle = COLORS.foulStroke;
      ctx.font = `700 11px ${FONT}`;
      ctx.fillText(`실격 ${state.myFoulCount}회`, CANVAS_W - 28, 72);
    }
  }

  private drawTargetCircle(phase: ReflexPhase): void {
    const ctx = this.ctx;
    const cx = CANVAS_W / 2;
    const cy = 190;
    const r = 85;

    let fill: string, stroke: string;
    switch (phase.kind) {
      case 'idle':    fill = COLORS.resultFill; stroke = COLORS.resultStroke; break;
      case 'waiting': fill = COLORS.waitFill;   stroke = COLORS.waitStroke; break;
      case 'go':      fill = COLORS.goFill;     stroke = COLORS.goStroke; break;
      case 'result':  fill = COLORS.resultFill; stroke = COLORS.resultStroke; break;
      case 'foul':    fill = COLORS.foulFill;   stroke = COLORS.foulStroke; break;
      case 'done':    fill = COLORS.resultFill; stroke = COLORS.resultStroke; break;
    }

    // GO 상태: 주변 펄스 링 (시선 끌기)
    if (phase.kind === 'go') {
      const pulse = (Math.sin(performance.now() / 120) + 1) / 2;
      ctx.strokeStyle = `rgba(134, 232, 196, ${0.3 + pulse * 0.2})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 14 + pulse * 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r + 24 + pulse * 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 본체
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 상단 광택
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.3, cy - r * 0.4, r * 0.45, r * 0.2, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // 원 내부 심볼
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    switch (phase.kind) {
      case 'idle': {
        ctx.font = `800 18px ${FONT}`;
        ctx.fillText('클릭해서 시작', cx, cy);
        break;
      }
      case 'waiting': {
        ctx.font = `900 44px ${FONT}`;
        ctx.fillText('⏳', cx, cy);
        break;
      }
      case 'go': {
        ctx.font = `900 42px ${FONT}`;
        ctx.fillText('지금!', cx, cy);
        break;
      }
      case 'result': {
        ctx.font = `900 32px ${FONT}`;
        ctx.fillStyle = COLORS.textMain;
        ctx.fillText(`${phase.ms}ms`, cx, cy - 5);
        ctx.font = `700 13px ${FONT}`;
        ctx.fillStyle = COLORS.textMuted;
        ctx.fillText('다음 라운드 자동 시작', cx, cy + 26);
        break;
      }
      case 'foul': {
        ctx.font = `900 32px ${FONT}`;
        ctx.fillText('너무 빨라요!', cx, cy - 5);
        ctx.font = `700 13px ${FONT}`;
        ctx.fillText('실격 처리', cx, cy + 22);
        break;
      }
      case 'done': {
        ctx.font = `900 22px ${FONT}`;
        ctx.fillStyle = COLORS.textMain;
        ctx.fillText('끝!', cx, cy - 18);
        ctx.font = `900 28px ${FONT}`;
        ctx.fillText(
          phase.finalAvgMs > 0 ? `평균 ${Math.round(phase.finalAvgMs)}ms` : '전부 실격',
          cx, cy + 12,
        );
        break;
      }
    }
  }

  private drawGuidanceText(phase: ReflexPhase): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `500 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let msg = '';
    switch (phase.kind) {
      case 'idle':    msg = '🚀 준비되면 원을 클릭하세요'; break;
      case 'waiting': msg = '빨간 동안은 절대 누르지 마세요'; break;
      case 'go':      msg = '초록! 지금 빨리 클릭!'; break;
      case 'result':  msg = '잠깐… 다음 라운드 대기 중'; break;
      case 'foul':    msg = '다음 라운드 대기 중'; break;
      case 'done':    msg = '상대의 결과를 기다려요'; break;
    }
    ctx.fillText(msg, CANVAS_W / 2, 308);
  }

  private drawOpponents(opponents: OpponentState[]): void {
    const ctx = this.ctx;
    if (opponents.length === 0) return;

    const cardW = 150;
    const cardH = 54;
    const gap = 14;
    const totalW = opponents.length * cardW + (opponents.length - 1) * gap;
    const startX = (CANVAS_W - totalW) / 2;
    const y = 330;

    for (let i = 0; i < opponents.length; i++) {
      const opp = opponents[i]!;
      const x = startX + i * (cardW + gap);

      // 카드 배경
      ctx.fillStyle = COLORS.oppCardBg;
      ctx.fillRect(x, y, cardW, cardH);
      ctx.strokeStyle = opp.finished ? COLORS.goStroke : COLORS.oppCardBorder;
      ctx.lineWidth = opp.finished ? 2 : 1.2;
      ctx.strokeRect(x, y, cardW, cardH);

      // 닉네임
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `700 13px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(truncate(opp.nickname, 10), x + 10, y + 18);

      // 진행도
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `600 11px ${FONT}`;
      ctx.fillText(`${opp.roundsDone}/5 라운드`, x + 10, y + 33);

      // 평균
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `900 16px ${FONT}`;
      ctx.textAlign = 'right';
      const avgText = opp.avgMs > 0 ? `${Math.round(opp.avgMs)}ms` : '-';
      ctx.fillText(avgText, x + cardW - 10, y + 27);

      // 완료 뱃지
      if (opp.finished) {
        ctx.fillStyle = COLORS.goStroke;
        ctx.font = `700 10px ${FONT}`;
        ctx.textAlign = 'right';
        ctx.fillText('✓ 완료', x + cardW - 10, y + 44);
      }

      // 실격 표시
      if (opp.foulCount > 0) {
        ctx.fillStyle = COLORS.foulStroke;
        ctx.font = `600 10px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.fillText(`실격 ${opp.foulCount}`, x + 10, y + 46);
      }
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
