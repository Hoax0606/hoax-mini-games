/**
 * 다트 Canvas 렌더러
 *
 * 레이아웃 (800×400 논리 좌표):
 *   ┌──────────────────────────────┬─────────────────┐
 *   │                              │ MODE: 301        │
 *   │      ⭕️ 다트보드              │ ───────────     │
 *   │     중심(260,190)             │ ▶ 현재 차례      │
 *   │     반지름 165                │   Henry          │
 *   │                              │   남은: 247      │
 *   │                              │   [T20][0][_]   │
 *   │      ⊕ 드래그 시작점          │ ─ 다른 플레이어  │
 *   │      (260, 380)              │   TT      198   │
 *   └──────────────────────────────┴─────────────────┘
 *
 * 다트보드 색 (파스텔 테마):
 *   - Single 영역: 세그먼트 짝/홀 교차 (크림 / 라벤더)
 *   - Double/Triple 링: 세그먼트 짝/홀 교차 (핑크 / 민트)
 *   - Bull: 민트 테두리 + 핑크 중심
 */

import { fitContain, fitScreenToLogical, type FitView } from '../_shared/canvasFit';
import {
  hitScore,
  BOARD_RATIOS,
  SEGMENTS,
  type HitResult,
} from './board';

// ============================================
// 레이아웃 상수
// ============================================

const CANVAS_W = 800;
const CANVAS_H = 400;

/** 다트보드 중심 + 반지름 (Double 링 바깥).
 *  Canvas 의 수직 중앙(200)에 위치 — 위/아래 여유 각 ~50px 로 대칭.
 *  pickup 설명 문구는 canvas 밖 HTML 힌트(.darts-hint)로 옮겼고, pickup dart 만
 *  보드 아래에 떠 있는다. pickup 아래로 드래그하는 windup 은 window 레벨 mousemove 라
 *  canvas 밖으로 나가도 정상 추적된다. */
export const BOARD_CX = 220;
export const BOARD_CY = 200;
export const BOARD_R = 136;

/** 우측 점수판 영역 — index.ts 도 hit-test 에 쓰므로 export */
export const PANEL_X = 440;
const PANEL_W = 340;

// ============================================
// 색 팔레트 (다른 게임들과 같은 파스텔 톤)
// ============================================

const COLORS = {
  bg: '#fff9fd',

  // 다트보드 번호 링 — 실제 다트판 참고해 얇은 플럼 링(방사 그라데이션은 drawBoard 에서).
  boardOuterRing: '#2a2238',
  boardOuterRingStroke: '#160f22',

  // Single 세그먼트 배경 (짝/홀 교차) — 실제 보드의 흑↔백 고대비: 흰색 ↔ 진한 플럼.
  //  singleDark 를 밝게 올리면(예: #6a5a80) 전체가 더 화사해짐 — 대비/밝기 취향 조절용 상수.
  singleLight: '#ffffff',
  singleDark: '#463a58',

  // Cricket 모드에서 비활성(1~14) 세그먼트 색 — 어둡게 톤다운
  inactiveSingleA: '#5a525a',
  inactiveSingleB: '#4a424a',
  inactiveRingA:   '#6b5a64',
  inactiveRingB:   '#5a4d56',

  // Double / Triple 링 색 (짝/홀) — "리워드 링"이라 또렷하게 (채도 살짝 ↑)
  ringPink: '#ff4d89',
  ringMint: '#3fd398',

  // 세그먼트 구분선(스파이더) — 실제 보드의 금속 와이어처럼 raised 느낌(어두운 바탕 + 은색 코어 + 교차 스터드)
  segBorder: '#1c1820',
  wireDark: 'rgba(0, 0, 0, 0.4)',
  wireLight: 'rgba(226, 229, 240, 0.85)',
  wireStud: '#e8ecf2',

  // Bull
  outerBull: '#86e8c4',
  outerBullStroke: '#2e8a70',
  innerBull: '#ff82ac',
  innerBullStroke: '#c93d73',

  // 숫자 라벨 — 어두운 외곽 링 위에 올라가므로 밝은 크림색
  segNumber: '#fff6e4',

  // 다트 색 — 꽂힌 다트/날아가는 다트 공용
  dartShaft: '#fdf6ec',
  dartShaftStroke: '#8a7a8a',
  dartTip: '#1c1820',        // 검정 팁 복원
  dartFlight1: '#b89aff',
  dartFlight2: '#ff82ac',

  // 패널 (다른 게임들과 동일)
  panelBg: '#faf5ff',
  panelBorder: '#d9c7ff',

  // 현재 플레이어 카드 — 노랑 → pink (사과 게임 내 점수 카드와 통일)
  currentCardBg: '#ffe4ee',
  currentCardStroke: '#ff6b9e',
  currentCardAccent: '#ff5a92',

  // Bust 상태 카드 — 톤 낮춘 붉은색
  bustCardBg: '#ffdede',
  bustCardStroke: '#ff6b6b',
  bustCardAccent: '#ff5a5a',

  // 다른 플레이어 row 카드 (사과 게임 플레이어 목록 스타일)
  otherRowBg: '#faf5ff',
  otherRowBorder: '#e9dfff',

  // 3다트 슬롯
  slotBgEmpty: '#f3ecff',
  slotBgFilled: '#ffffff',
  slotBorderEmpty: '#d9c7ff',
  slotBorderFilled: '#b89aff',

  // 텍스트
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  textAccent: '#9c7aeb',
  textWin: '#2e8a70',

  // 게임 오버 오버레이 (배경 더 파스텔)
  overlayBg: 'rgba(255, 249, 253, 0.92)',
  overlayTitle: '#4a3a4a',

  // BUST 배너 (과녁 위 큰 경고) — 톤 다운
  bustBannerBg: 'rgba(255, 107, 107, 0.9)',
  bustBannerStroke: '#ff5a5a',
} as const;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

// ============================================
// 모션 상수 / 헬퍼 (apple-design: 스프링 팝 + materialize)
// ============================================

const POP_MS = 300;        // 다트 착탄 / 슬롯 채움 팝
const SCOREPOP_MS = 850;   // 폭발 점수 팝 (떠올랐다 페이드)
const MATERIALIZE_MS = 240; // 배너 / 게임오버 오버레이 등장

const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** easeOutBack — 착수 momentum 느낌의 살짝 오버슈트 */
function easeOutBack(t: number): number {
  if (t >= 1) return 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}
/** easeOut(제곱) — materialize/상승용 */
function easeOut(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - (1 - c) * (1 - c);
}
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ============================================
// 외부 타입
// ============================================

export type DartsMode = '101' | '201' | '301' | 'countup' | 'low-countup' | 'cricket';
export type X01Variant = 'normal' | 'hard';

export interface PlayerDisplay {
  peerId: string;
  nickname: string;
  /** 모드별 "주요 표시값" — render 편의상 이미 계산된 숫자 (없으면 0) */
  primaryValue: number;
  /** "남은 점수" / "총점" / "평균" 등 primaryValue 앞에 붙일 라벨 */
  primaryLabel: string;
  /** 이번 라운드 3다트 히트 (0~3개). 남은 슬롯은 빈칸 표시 */
  throwsThisRound: HitResult[];
  /** 완주/탈락 등의 상태 */
  finished: boolean;
  /** Cricket 전용: 섹터별 마크 수 (0~3) — 있으면 세그먼트 표 표시 */
  cricketMarks?: Record<string, number>;
  /** X01: 이번 턴 bust 여부 (표시 강조용) */
  bustThisTurn?: boolean;
  /** 완료된 각 턴에서 얻은 점수 히스토리 — "라운드별 점수" 표시용 */
  roundScores?: number[];
}

/**
 * 날아가는 다트 — index.ts 가 매 프레임 물리(속도+중력) 계산해서
 * 현재 위치(x, y)와 회전만 여기 넣어준다. render 는 그 좌표에 그대로 그려줌.
 */
export interface FlyingDart {
  /** 현재 위치 (canvas 논리 좌표) */
  x: number;
  y: number;
  /** 현재 회전 각도 (rad). 진행 방향 기반으로 index.ts 가 계산 */
  rotation: number;
}

export interface StuckDart {
  /** 과녁 중심 기준 상대 좌표 */
  localX: number;
  localY: number;
  /** 꽂힐 때 회전 각도 */
  rotation: number;
  /** 히트 결과 — 시각적 효과용 (예: miss면 보드 밖) */
  hit: HitResult;
  /** 시각적 fade-in 진행도 (0~1). 새로 꽂힌 다트는 살짝 커지면서 등장 */
  freshness: number;
}

export interface DartsRenderState {
  mode: DartsMode;
  x01Variant?: X01Variant;
  /** 상단에 보여줄 모드 라벨 (예: "301 (Normal)") */
  modeLabel: string;

  /** 현재 라운드. 1-based */
  round: number;
  /** (Count-up 등) 총 라운드. undefined면 표시 안 함 */
  maxRounds?: number;

  /** 플레이어 목록 (현재 차례 포함) */
  players: PlayerDisplay[];
  /** 현재 차례 인덱스 (players 배열 기준) */
  currentPlayerIdx: number;
  /** "나"의 인덱스 (players 배열 기준). 관전자는 null. 내 점수 카드 고정 표시용. */
  myPlayerIdx: number | null;

  /** 과녁에 꽂혀 있는 다트들 (보통 최근 라운드만 표시) */
  stuckDarts: StuckDart[];
  /** 마지막 다트가 꽂힌 로컬 시각(performance.now) — 착탄/슬롯 팝 애니 전용. 네트워크 동기화 X, 0=정착 */
  lastStuckLandedAt: number;
  /** 방금 꽂힌 다트의 폭발 점수 팝 (잠깐 떠올랐다 사라짐). null=없음 */
  scorePop: { x: number; y: number; score: number; kind: HitResult['kind']; at: number } | null;
  /** 날아가는 중인 다트 (있으면) */
  flyingDart: FlyingDart | null;
  /** 마우스로 들고 있는 다트 (드래그 중). 커서 따라다님 */
  heldDart: FlyingDart | null;

  /** 내 차례가 맞는지 — 입력 활성화 여부 (index.ts 쪽에서만 사용) */
  isMyTurn: boolean;
  /** 관전자면 드래그 UI 전부 숨김 */
  isSpectator: boolean;

  /** 게임 종료 오버레이 정보 */
  gameOver: { winnerNickname: string | null; subtitle: string } | null;
}

// ============================================
// Renderer
// ============================================

export interface DartsRendererArgs {
  canvas: HTMLCanvasElement;
}

export class DartsRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private view: FitView = { scale: 1, offX: 0, offY: 0 };
  /** materialize 시작 시각(렌더러 자체 캡처) — 상태가 처음 나타난 프레임 기록 */
  private gameOverShownAt = 0;
  private bustShownAt = 0;

  constructor(args: DartsRendererArgs) {
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

  /** 캔버스 이벤트 픽셀 좌표 → 논리 좌표 (800x400 기준) */
  canvasToLogical(canvasPx: number, canvasPy: number): { x: number; y: number } {
    return fitScreenToLogical(this.view, canvasPx, canvasPy);
  }

  // ============================================
  // 메인 render
  // ============================================

  render(state: DartsRenderState): void {
    const ctx = this.ctx;
    const now = performance.now();
    // 균일 스케일+레터박스 (비율 유지 → 안 찌부러짐)
    this.view = fitContain(ctx, this.canvas, CANVAS_W, CANVAS_H, COLORS.bg);

    // 다트보드
    this.drawBoard(state.mode);

    // 과녁에 꽂힌 다트들 — 마지막(방금 꽂힌) 다트만 스프링 팝 + 임팩트 링
    const lastIdx = state.stuckDarts.length - 1;
    const popActive = state.lastStuckLandedAt > 0 && !prefersReducedMotion;
    const popT = popActive ? clamp01((now - state.lastStuckLandedAt) / POP_MS) : 1;
    for (let i = 0; i < state.stuckDarts.length; i++) {
      const d = state.stuckDarts[i]!;
      const px = BOARD_CX + d.localX;
      const py = BOARD_CY + d.localY;
      if (i === lastIdx && popActive && popT < 1) {
        // 임팩트 링 (착탄 순간 퍼지는 링)
        ctx.strokeStyle = `rgba(255, 90, 146, ${(1 - popT) * 0.7})`;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(px, py, 4 + popT * 18, 0, Math.PI * 2);
        ctx.stroke();
      }
      this.drawDart(px, py, d.rotation, i === lastIdx ? easeOutBack(popT) : 1);
    }

    // 폭발 점수 팝 — 방금 꽂힌 점수가 튀어오르며 페이드
    if (state.scorePop) this.drawScorePop(state.scorePop, now);

    // 날아가는 다트 (있으면) — 좌표는 index.ts 물리 계산값 그대로 사용
    if (state.flyingDart) {
      const f = state.flyingDart;
      this.drawDart(f.x, f.y, f.rotation);
    }

    // 들고 있는 다트 (마우스 따라다니는 중)
    if (state.heldDart) {
      const h = state.heldDart;
      this.drawDart(h.x, h.y, h.rotation, 1.15);
    }

    // 집기 대기 다트 — 내 차례인데 아직 안 집었고 이번 턴 3발 다 안 썼으면 표시
    const canPickUp =
      state.isMyTurn &&
      !state.isSpectator &&
      !state.gameOver &&
      !state.flyingDart &&
      !state.heldDart &&
      (state.players[state.currentPlayerIdx]?.throwsThisRound.length ?? 0) < 3;
    if (canPickUp) {
      this.drawPickupDart();
    }

    // 우측 패널
    this.drawRightPanel(state, now);

    // BUST 배너 — 현재 플레이어가 bust 상태면 과녁 위에 크게 표시 (materialize)
    const curDisplay = state.players[state.currentPlayerIdx];
    if (curDisplay?.bustThisTurn && !state.gameOver) {
      if (this.bustShownAt === 0) this.bustShownAt = now;
      this.drawBustBanner(now);
    } else {
      this.bustShownAt = 0;
    }

    // 게임 종료 오버레이 (materialize)
    if (state.gameOver) {
      if (this.gameOverShownAt === 0) this.gameOverShownAt = now;
      this.drawGameOverOverlay(state, now);
    } else {
      this.gameOverShownAt = 0;
    }
  }

  /** 방금 꽂힌 다트의 점수를 임팩트 지점에서 크게 띄워 올렸다가 페이드 (Darts of Fury식 폭발 점수) */
  private drawScorePop(pop: NonNullable<DartsRenderState['scorePop']>, now: number): void {
    const age = (now - pop.at) / SCOREPOP_MS;
    if (age >= 1 || age < 0) return;
    const ctx = this.ctx;
    const rise = prefersReducedMotion ? 0 : -30 * easeOut(clamp01(age));
    const grow = prefersReducedMotion ? 1 : 0.6 + 0.6 * easeOut(clamp01(age * 2));
    const alpha = 1 - clamp01((age - 0.6) / 0.4); // 뒤쪽 40% 구간에 페이드아웃
    const color =
      pop.kind === 'triple' ? COLORS.ringPink
        : pop.kind === 'double' ? COLORS.ringMint
          : (pop.kind === 'inner-bull' || pop.kind === 'outer-bull') ? COLORS.innerBull
            : COLORS.textAccent;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(pop.x, pop.y + rise);
    ctx.scale(grow, grow);
    ctx.font = `900 30px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 흰 외곽선으로 어떤 배경 위에서도 또렷하게
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.strokeText(String(pop.score), 0, 0);
    ctx.fillStyle = color;
    ctx.fillText(String(pop.score), 0, 0);
    ctx.restore();
  }

  /** 프로스티드 카드 — 반투명 흰색 + 소프트 섀도 + 라운드. 활성은 핑크 링. (패널 전반 통일) */
  private frostedCard(
    x: number, y: number, w: number, h: number,
    opt: { active?: boolean; radius?: number; fill?: string; line?: string; danger?: boolean } = {},
  ): void {
    const ctx = this.ctx;
    const r = opt.radius ?? 14;
    ctx.save();
    ctx.shadowColor = opt.danger
      ? 'rgba(255, 90, 90, 0.28)'
      : opt.active ? 'rgba(255, 90, 146, 0.22)' : 'rgba(120, 80, 140, 0.15)';
    ctx.shadowBlur = opt.active || opt.danger ? 15 : 9;
    ctx.shadowOffsetY = opt.active || opt.danger ? 6 : 4;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = opt.fill ?? 'rgba(255, 255, 255, 0.6)';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.strokeStyle = opt.danger ? COLORS.bustCardStroke : opt.active ? COLORS.currentCardStroke : (opt.line ?? COLORS.panelBorder);
    ctx.lineWidth = opt.active || opt.danger ? 2.4 : 1.2;
    ctx.stroke();
  }

  /** 과녁 상단에 큰 "BUST!" 배너 — 턴 원복 시 1.4초 정도 노출 (materialize: 페이드+스케일) */
  private drawBustBanner(now: number): void {
    const ctx = this.ctx;
    const cx = BOARD_CX;
    const cy = BOARD_CY;

    const raw = this.bustShownAt > 0 ? clamp01((now - this.bustShownAt) / MATERIALIZE_MS) : 1;
    const t = prefersReducedMotion ? 1 : easeOut(raw);
    const scale = prefersReducedMotion ? 1 : 0.86 + 0.14 * t;

    ctx.save();
    ctx.globalAlpha = t;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

    // 반투명 경고 배경 — 빨강 톤 다운 (파스텔 전반과 덜 충돌)
    ctx.fillStyle = COLORS.bustBannerBg;
    ctx.strokeStyle = COLORS.bustBannerStroke;
    ctx.lineWidth = 3;
    const bw = 220;
    const bh = 72;
    ctx.beginPath();
    ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 14);
    ctx.fill();
    ctx.stroke();

    // 큰 BUST 텍스트
    ctx.fillStyle = '#fff';
    ctx.font = `900 38px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BUST!', cx, cy - 8);

    ctx.fillStyle = 'rgba(255, 240, 240, 0.95)';
    ctx.font = `700 13px ${FONT}`;
    ctx.fillText('이번 턴 무효', cx, cy + 18);

    ctx.restore();
  }

  // ============================================
  // 다트보드 그리기
  // ============================================

  private drawBoard(mode: DartsMode): void {
    const ctx = this.ctx;
    const R = BOARD_R;
    const RING_OUTER = R * 1.085; // 번호 링 바깥 — 실제 보드 참고해 얇게
    const SEG_ARC = Math.PI / 10;
    const HALF = SEG_ARC / 2;
    const isCricket = mode === 'cricket';

    // 0) 아레나 글로우 — 보드 뒤 은은한 스포트라이트(디지털 다트게임 "빅스크린 아레나" 느낌)
    const glow = ctx.createRadialGradient(BOARD_CX, BOARD_CY, R * 0.2, BOARD_CX, BOARD_CY, R * 1.5);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.5)');
    glow.addColorStop(0.6, 'rgba(255, 255, 255, 0.1)');
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, R * 1.5, 0, Math.PI * 2);
    ctx.fill();

    // 1) 번호 링 — 드롭섀도로 보드를 배경에서 띄우고, 플럼 방사 그라데이션
    ctx.save();
    ctx.shadowColor = 'rgba(90, 60, 110, 0.32)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 9;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, RING_OUTER, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.boardOuterRing;
    ctx.fill();
    ctx.restore();
    const ringGrad = ctx.createRadialGradient(
      BOARD_CX, BOARD_CY - RING_OUTER * 0.3, R * 0.5, BOARD_CX, BOARD_CY, RING_OUTER,
    );
    ringGrad.addColorStop(0, '#3a3048');
    ringGrad.addColorStop(1, '#221a30');
    ctx.fillStyle = ringGrad;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, RING_OUTER, 0, Math.PI * 2);
    ctx.fill();
    // 링 안쪽 밝은 엣지(베젤에 빛 걸리는 느낌)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, R * 1.003, 0, Math.PI * 2);
    ctx.stroke();

    // 2) 20개 세그먼트 — 크림 ↔ 플럼 고대비. Cricket 비활성(1~14)은 어두운 톤.
    for (let i = 0; i < 20; i++) {
      const centerAngle = -Math.PI / 2 + i * SEG_ARC;
      const startA = centerAngle - HALF;
      const endA = centerAngle + HALF;
      const isEven = i % 2 === 0;
      const segNum = SEGMENTS[i]!;
      const inactive = isCricket && (segNum < 15 || segNum > 20);

      const singleColor = inactive
        ? (isEven ? COLORS.inactiveSingleA : COLORS.inactiveSingleB)
        : (isEven ? COLORS.singleLight : COLORS.singleDark);
      const ringColor = inactive
        ? (isEven ? COLORS.inactiveRingA : COLORS.inactiveRingB)
        : (isEven ? COLORS.ringPink : COLORS.ringMint);

      this.fillRing(startA, endA, R * BOARD_RATIOS.TRIPLE_OUTER, R * BOARD_RATIOS.DOUBLE_INNER, singleColor);
      this.fillRing(startA, endA, R * BOARD_RATIOS.DOUBLE_INNER, R * BOARD_RATIOS.DOUBLE_OUTER, ringColor);
      this.fillRing(startA, endA, R * BOARD_RATIOS.TRIPLE_INNER, R * BOARD_RATIOS.TRIPLE_OUTER, ringColor);
      this.fillRing(startA, endA, R * BOARD_RATIOS.OUTER_BULL_OUTER, R * BOARD_RATIOS.TRIPLE_INNER, singleColor);
    }

    // 3) 깊이 셰이딩 — 살짝 오목한 접시처럼(상단 하이라이트 + 가장자리 음영). 파스텔 안 죽게 약하게.
    const depth = ctx.createRadialGradient(
      BOARD_CX, BOARD_CY - R * 0.3, R * 0.05, BOARD_CX, BOARD_CY, R * BOARD_RATIOS.DOUBLE_OUTER,
    );
    depth.addColorStop(0, 'rgba(255, 255, 255, 0.12)');
    depth.addColorStop(0.5, 'rgba(20, 10, 25, 0.03)');
    depth.addColorStop(1, 'rgba(20, 10, 25, 0.16)');
    ctx.fillStyle = depth;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, R * BOARD_RATIOS.DOUBLE_OUTER, 0, Math.PI * 2);
    ctx.fill();

    // 4) 스파이더 — raised 금속 와이어: 어두운 바탕선 위에 은색 코어선을 겹쳐 그림.
    //    세그먼트 경계(방사) + 링 경계(원)를 실제 보드처럼 모두 그림.
    const drawSpider = (style: string, lw: number): void => {
      ctx.strokeStyle = style;
      ctx.lineWidth = lw;
      for (let i = 0; i < 20; i++) {
        const angle = -Math.PI / 2 + i * SEG_ARC - HALF;
        ctx.beginPath();
        ctx.moveTo(
          BOARD_CX + Math.cos(angle) * R * BOARD_RATIOS.OUTER_BULL_OUTER,
          BOARD_CY + Math.sin(angle) * R * BOARD_RATIOS.OUTER_BULL_OUTER,
        );
        ctx.lineTo(
          BOARD_CX + Math.cos(angle) * R * BOARD_RATIOS.DOUBLE_OUTER,
          BOARD_CY + Math.sin(angle) * R * BOARD_RATIOS.DOUBLE_OUTER,
        );
        ctx.stroke();
      }
      for (const f of [BOARD_RATIOS.DOUBLE_OUTER, BOARD_RATIOS.DOUBLE_INNER, BOARD_RATIOS.TRIPLE_OUTER, BOARD_RATIOS.TRIPLE_INNER]) {
        ctx.beginPath();
        ctx.arc(BOARD_CX, BOARD_CY, R * f, 0, Math.PI * 2);
        ctx.stroke();
      }
    };
    drawSpider(COLORS.wireDark, 2);
    drawSpider(COLORS.wireLight, 0.9);
    // 교차 스터드 (더블/트리플 링과 세그먼트 경계가 만나는 점)
    ctx.fillStyle = COLORS.wireStud;
    for (let i = 0; i < 20; i++) {
      const angle = -Math.PI / 2 + i * SEG_ARC - HALF;
      for (const f of [BOARD_RATIOS.DOUBLE_OUTER, BOARD_RATIOS.TRIPLE_OUTER]) {
        ctx.beginPath();
        ctx.arc(BOARD_CX + Math.cos(angle) * R * f, BOARD_CY + Math.sin(angle) * R * f, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 5) Bull — 민트(25) + 핑크(50). 이너 불에 작은 하이라이트.
    ctx.fillStyle = COLORS.outerBull;
    ctx.strokeStyle = COLORS.outerBullStroke;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, R * BOARD_RATIOS.OUTER_BULL_OUTER, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.innerBull;
    ctx.strokeStyle = COLORS.innerBullStroke;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, R * BOARD_RATIOS.BULL_OUTER, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const bullHi = ctx.createRadialGradient(
      BOARD_CX - R * 0.015, BOARD_CY - R * 0.02, 0, BOARD_CX, BOARD_CY, R * BOARD_RATIOS.OUTER_BULL_OUTER,
    );
    bullHi.addColorStop(0, 'rgba(255, 255, 255, 0.45)');
    bullHi.addColorStop(0.6, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = bullHi;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, R * BOARD_RATIOS.OUTER_BULL_OUTER, 0, Math.PI * 2);
    ctx.fill();

    // 6) 번호 — 얇은 링 위, 살짝 그림자로 또렷하게. Cricket 비활성은 흐리게.
    ctx.font = `900 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelR = R * 1.043;
    for (let i = 0; i < 20; i++) {
      const centerAngle = -Math.PI / 2 + i * SEG_ARC;
      const x = BOARD_CX + Math.cos(centerAngle) * labelR;
      const y = BOARD_CY + Math.sin(centerAngle) * labelR;
      const segNum = SEGMENTS[i]!;
      const inactive = isCricket && (segNum < 15 || segNum > 20);
      ctx.fillStyle = inactive ? 'rgba(255, 244, 224, 0.35)' : COLORS.segNumber;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 2;
      ctx.fillText(String(segNum), x, y);
      ctx.shadowBlur = 0;
    }
  }

  /**
   * 부채꼴 링(annulus sector) 하나 그리기.
   * startA/endA: 시작/끝 각도 (라디안, atan2 기준).
   * rInner/rOuter: 안/바깥 반지름.
   */
  private fillRing(
    startA: number,
    endA: number,
    rInner: number,
    rOuter: number,
    fill: string,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, rOuter, startA, endA);
    ctx.arc(BOARD_CX, BOARD_CY, rInner, endA, startA, true);
    ctx.closePath();
    ctx.fill();
  }

  // ============================================
  // 다트 (꽂힌 / 날아가는)
  // ============================================

  /** 한 다트 그리기 — (tipX, tipY) 는 팁(꽂힌 끝) 좌표. rotation 라디안.
   *  좌표 관습: 회전 전 다트는 "위쪽(-y)으로 뻗어있다". 팁이 원점, 아래로 플라이트.
   *
   *  구조 (실제 다트처럼 4단):
   *    팁     0 ~ -6    — 가는 금속 침
   *    배럴   -6 ~ -16  — 손잡이(두꺼운 부분), grip 라인 3개
   *    샤프트 -16 ~ -21 — 배럴과 플라이트 연결 얇은 막대
   *    플라이트 -21 ~ -29 — 양쪽 곡선 날개(라벤더/핑크) + 중앙 스파인
   */
  private drawDart(tipX: number, tipY: number, rotation: number, scale = 1): void {
    const ctx = this.ctx;
    const BASE = 1.35;
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(rotation);
    ctx.scale(scale * BASE, scale * BASE);

    // === 1. 팁 (steel point) ===
    ctx.fillStyle = COLORS.dartTip;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-1.3, -6);
    ctx.lineTo(1.3, -6);
    ctx.closePath();
    ctx.fill();

    // === 2. 배럴 (barrel) — 두꺼운 중앙부, 팁보다 짙은 보라/차콜 ===
    const barrelMaxX = 2.8;
    ctx.fillStyle = '#6e5872';
    ctx.strokeStyle = '#3a2a3a';
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    ctx.moveTo(-1.3, -6);
    ctx.lineTo(-barrelMaxX, -7.5);
    ctx.lineTo(-barrelMaxX, -14.5);
    ctx.lineTo(-1.3, -16);
    ctx.lineTo(1.3, -16);
    ctx.lineTo(barrelMaxX, -14.5);
    ctx.lineTo(barrelMaxX, -7.5);
    ctx.lineTo(1.3, -6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 배럴 grip 라인 3개 (실제 다트 손잡이 요철 느낌)
    ctx.strokeStyle = 'rgba(30, 22, 32, 0.55)';
    ctx.lineWidth = 0.35;
    for (let i = 0; i < 3; i++) {
      const y = -8.5 - i * 2;
      ctx.beginPath();
      ctx.moveTo(-barrelMaxX + 0.3, y);
      ctx.lineTo(barrelMaxX - 0.3, y);
      ctx.stroke();
    }

    // 배럴 좌측에 살짝 하이라이트 (금속 광택)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(-barrelMaxX + 0.4, -14.5, 0.8, 6.5);

    // === 3. 샤프트 — 배럴과 플라이트 연결 얇은 막대 ===
    ctx.fillStyle = COLORS.dartShaft;
    ctx.strokeStyle = COLORS.dartShaftStroke;
    ctx.lineWidth = 0.3;
    ctx.fillRect(-0.7, -21, 1.4, 5);
    ctx.strokeRect(-0.7, -21, 1.4, 5);

    // === 4. 플라이트 — 양쪽 곡선 날개 ===
    const fTipY = -21;   // 플라이트 앞(좁은 쪽) = 샤프트와 만나는 지점
    const fBaseY = -29;  // 플라이트 뒤(넓은 쪽)
    const fWidth = 7;

    // 왼쪽 (라벤더)
    ctx.fillStyle = COLORS.dartFlight1;
    ctx.strokeStyle = 'rgba(90, 74, 106, 0.35)';
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(0, fTipY);
    ctx.quadraticCurveTo(-fWidth - 1.5, fTipY - 1.5, -fWidth, fBaseY);
    ctx.lineTo(0, fBaseY + 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 오른쪽 (핑크)
    ctx.fillStyle = COLORS.dartFlight2;
    ctx.beginPath();
    ctx.moveTo(0, fTipY);
    ctx.quadraticCurveTo(fWidth + 1.5, fTipY - 1.5, fWidth, fBaseY);
    ctx.lineTo(0, fBaseY + 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 플라이트 중앙 스파인 (양쪽 깃 만나는 뼈대)
    ctx.strokeStyle = 'rgba(60, 50, 70, 0.45)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, fTipY);
    ctx.lineTo(0, fBaseY + 1);
    ctx.stroke();

    ctx.restore();
  }

  // ============================================
  // 집기 대기 다트 (pickup hint)
  // ============================================

  /**
   * 과녁 아래쪽에 "들 준비된 다트"를 표시. 반투명 + 부드러운 펄스 없이 단순.
   * 위치/회전은 고정 — 집은 뒤에 바로 커서로 옮겨지기 때문에 자리 표시용.
   */
  private drawPickupDart(): void {
    const ctx = this.ctx;
    const px = 220;
    const py = 375; // 보드 아래 — windup 영역(여기서 아래로 드래그) 위에 떠 있음
    // 팁이 과녁 쪽 (위) 을 살짝 향하도록 기울임
    const rotation = Math.PI * 0.92;
    ctx.save();
    ctx.globalAlpha = 0.85;
    this.drawDart(px, py, rotation, 1.25);
    ctx.restore();
    // 설명 문구는 canvas 밖 HTML 힌트(.darts-hint) 로 분리됨 — 여기선 다트만 렌더.
  }

  // ============================================
  // 우측 패널 (점수판)
  // ============================================

  private drawRightPanel(state: DartsRenderState, now: number): void {
    const ctx = this.ctx;
    // 패널 배경 — 프로스티드 유리(반투명 + 소프트 섀도 + 라운드)
    this.frostedCard(PANEL_X, 20, PANEL_W, CANVAS_H - 40, {
      radius: 18,
      fill: 'rgba(255, 255, 255, 0.45)',
      line: 'rgba(216, 199, 255, 0.6)',
    });

    const INNER_PAD = 14;
    const innerX = PANEL_X + INNER_PAD;
    const innerW = PANEL_W - INNER_PAD * 2;

    let y = 32;

    // 1) 헤더 카드 — 🎯 모드 + Round + 현재 차례 플레이어
    this.drawModeHeaderCard(innerX, y, innerW, state);
    y += 48 + 12;

    // 2) "내" 점수 카드 — 관전자가 아니면 항상 내 정보 고정 표시
    //    내가 차례면 핑크 강조 + "▶ 지금 차례", 아니면 연한 톤 + "내 점수"
    const myIdx = state.myPlayerIdx;
    const me = myIdx !== null ? state.players[myIdx] : null;
    const isMyTurn = myIdx !== null && myIdx === state.currentPlayerIdx;

    if (me) {
      this.drawMyPlayerBlock(me, innerX, y, innerW, state.mode, isMyTurn, now, state.lastStuckLandedAt);
      y += 120 + 10;

      // 2-a) 내 라운드별 점수 히스토리 (Cricket 제외 — 마크가 더 중요)
      if (state.mode !== 'cricket' && me.roundScores && me.roundScores.length > 0) {
        const histH = this.drawRoundHistory(innerX, y, innerW, me.roundScores);
        y += histH + 4;
      }
      // 다음 "다른 플레이어" 섹션과 시각적 분리를 위한 공통 여백
      // (히스토리 유무와 무관하게 라벨이 위 셀/카드와 떨어지도록)
      y += 14;
    } else {
      // 관전자 — 내 카드 없으므로 현재 차례 플레이어 카드를 대신 표시
      const cur = state.players[state.currentPlayerIdx];
      if (cur) {
        this.drawMyPlayerBlock(cur, innerX, y, innerW, state.mode, true, now, state.lastStuckLandedAt);
        y += 120 + 12;
      }
    }

    // 3) Cricket 전용 — "내" 타겟별 마크 (관전자면 현재 차례 마크)
    const cricketSource = me ?? state.players[state.currentPlayerIdx];
    if (state.mode === 'cricket' && cricketSource?.cricketMarks) {
      this.drawCricketMarksRow(innerX, y, innerW, cricketSource.cricketMarks);
      y += 36 + 12;
    }

    // 4) 다른 플레이어 섹션 — 나 제외 전체. 현재 차례인 사람에게 ▶ 배지.
    const othersCount = state.players.length - (me ? 1 : 0);
    if (othersCount > 0) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `700 11px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('다른 플레이어', innerX, y);
      y += 14;

      const others: { p: PlayerDisplay; i: number }[] = [];
      for (let i = 0; i < state.players.length; i++) {
        if (i === myIdx) continue;
        others.push({ p: state.players[i]!, i });
      }
      // 5명 이상이면 세로로 다 못 담아 → 2열 간단 행(닉+점수). 그 이하는 기존 상세 행.
      if (others.length > 4) {
        const colGap = 8;
        const colW = (innerW - colGap) / 2;
        const rowH = 22;
        others.forEach((o, k) => {
          const col = k % 2;
          const row = Math.floor(k / 2);
          const cx = innerX + col * (colW + colGap);
          const cy = y + row * (rowH + 4);
          this.drawOtherCompactRow(o.p, cx, cy, colW, rowH, o.i === state.currentPlayerIdx);
        });
      } else {
        for (const o of others) {
          const rowH = this.drawOtherPlayerRow(o.p, innerX, y, innerW, o.i === state.currentPlayerIdx, state.mode);
          y += rowH + 4;
        }
      }
    }
  }

  /** 다인원용 간단 행 — 닉 + 대표 점수만 (2열 그리드). 크리켓 마크는 생략. */
  private drawOtherCompactRow(
    p: PlayerDisplay, x: number, y: number, w: number, h: number, isActive: boolean,
  ): void {
    const ctx = this.ctx;
    this.frostedCard(x, y, w, h, {
      radius: 9,
      active: isActive,
      fill: isActive ? 'rgba(240, 232, 255, 0.75)' : 'rgba(255, 255, 255, 0.5)',
      line: 'rgba(233, 223, 255, 0.8)',
    });
    const midY = y + h / 2;
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText((isActive ? '▶ ' : '') + truncate(p.nickname, 5), x + 6, midY);
    ctx.fillStyle = p.finished ? COLORS.textWin : COLORS.textAccent;
    ctx.font = `800 12px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(String(p.primaryValue), x + w - 6, midY);
  }

  /**
   * 상단 헤더 카드 — 🎯 모드명 (좌상) + Round N/M (우상) + 현재 차례 플레이어 (하).
   * 내가 차례가 아닐 때 현재 누구 차례인지 헤더로 알려줌 ("내 카드"가 고정되어 있어 메인 카드만 봐서는 모름).
   */
  private drawModeHeaderCard(x: number, y: number, w: number, state: DartsRenderState): void {
    const ctx = this.ctx;
    const h = 48;

    // 카드 배경 (프로스티드 라벤더)
    this.frostedCard(x, y, w, h, {
      radius: 12,
      fill: 'rgba(240, 232, 255, 0.7)',
      line: 'rgba(184, 154, 255, 0.5)',
    });

    // 상단 라인 — 모드명 (좌) + Round (우)
    ctx.fillStyle = COLORS.textAccent;
    ctx.font = `900 18px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(state.modeLabel, x + 12, y + 22);

    const roundText = state.maxRounds
      ? `Round ${state.round} / ${state.maxRounds}`
      : `Round ${state.round}`;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(roundText, x + w - 12, y + 22);

    // 하단 라인 — 현재 차례 플레이어 표시
    const cur = state.players[state.currentPlayerIdx];
    if (cur) {
      const isMe = state.myPlayerIdx !== null && state.myPlayerIdx === state.currentPlayerIdx;
      ctx.fillStyle = isMe ? '#ff5a92' : COLORS.textMain;
      ctx.font = `700 11px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(`▶ ${truncate(cur.nickname, 12)}${isMe ? ' (나)' : ''} 차례`, x + 12, y + 40);
    }
  }

  /**
   * 점수 카드 — 기준이 "나"(항상 고정 표시). isMyTurn=true 면 핑크 강조 + "지금 차례",
   * 아니면 연한 톤 + "내 점수" 라벨. bust 가 있으면 최우선으로 붉은 카드.
   *
   * 관전자일 경우 호출부가 "현재 차례 플레이어"를 대신 넘기므로 p 가 누구여도 렌더 OK.
   */
  private drawMyPlayerBlock(
    p: PlayerDisplay,
    x: number,
    y: number,
    w: number,
    mode: DartsMode,
    isMyTurn: boolean,
    now: number,
    lastStuckLandedAt: number,
  ): void {
    const ctx = this.ctx;
    const H = 120;
    const cx = x + w / 2; // 카드 가로 중앙 — 큰 숫자/3다트 슬롯 가운데 정렬에 사용

    const bust = p.bustThisTurn === true;
    // 활성(내 차례) 카드는 살짝 위로 리프트(apple-design: 활성 상태를 형태로도 표현). bust 면 리프트 X.
    const lift = isMyTurn && !bust ? -4 : 0;
    const cardY = y + lift;

    // 배경 — 프로스티드. bust=붉은 danger / 내 차례=핑크 활성 링 / 그 외=연한 핑크
    this.frostedCard(x, cardY, w, H, {
      radius: 16,
      active: isMyTurn && !bust,
      danger: bust,
      fill: bust
        ? 'rgba(255, 222, 222, 0.82)'
        : isMyTurn ? 'rgba(255, 240, 246, 0.8)' : 'rgba(255, 240, 246, 0.55)',
    });

    // 상단 라벨 — bust / 지금 차례 / 내 점수
    ctx.fillStyle = bust
      ? COLORS.bustCardAccent
      : isMyTurn ? COLORS.currentCardAccent : '#d9689a';
    ctx.font = bust ? `900 12px ${FONT}` : `800 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const labelText = bust
      ? '💥 BUST! · 턴 무효'
      : isMyTurn ? '▶ 지금 내 차례' : '📊 내 점수';
    ctx.fillText(labelText, x + 10, cardY + 18);

    // 닉네임 (우측 상단)
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `800 16px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(truncate(p.nickname, 10), x + w - 10, cardY + 18);

    // 큰 숫자 (가운데 정렬로 임팩트 강조)
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `900 34px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.primaryValue), cx, cardY + 54);

    // primaryLabel — 큰 숫자 아래 작게 (가운데)
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 11px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(p.primaryLabel, cx, cardY + 80);

    // 이번 턴 3다트 슬롯 — 카드 하단 가운데 정렬, kind 별 색 강조
    const slotW = 38;
    const slotGap = 8;
    const slotH = 28;
    const slotsTotalW = slotW * 3 + slotGap * 2;
    const slotStartX = cx - slotsTotalW / 2;
    const slotTopY = cardY + H - slotH - 4;    // 카드 하단에서 4px 여유
    const showMultiplierBadges = mode === 'low-countup';

    // 방금 채워진 슬롯(현재 던진 사람의 마지막 다트)만 팝
    const lastFilledIdx = p.throwsThisRound.length - 1;
    const slotPop =
      isMyTurn && lastStuckLandedAt > 0 && !prefersReducedMotion
        ? easeOutBack(clamp01((now - lastStuckLandedAt) / POP_MS))
        : 1;

    for (let i = 0; i < 3; i++) {
      const sx = slotStartX + i * (slotW + slotGap);
      const hit = p.throwsThisRound[i];

      // Low Count-up 은 각 슬롯에 ×1/×2/×3 배수 배지 (슬롯 위)
      if (showMultiplierBadges) {
        ctx.fillStyle = COLORS.textAccent;
        ctx.font = `900 11px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        // 슬롯 위 충분히 띄워서 슬롯 라운드 모서리와 안 겹치게
        ctx.fillText(`×${i + 1}`, sx + slotW / 2, slotTopY - 8);
      }

      this.drawDartSlot(sx, slotTopY, slotW, slotH, hit, i === lastFilledIdx ? slotPop : 1);
    }
  }

  /**
   * 3다트 슬롯 하나. kind 별 색/배지로 구분해서 한 눈에 어떤 점수였는지 알 수 있게.
   *   - Triple: 핑크 강조 border + 상단 'T' 배지
   *   - Double: 민트 강조 border + 상단 'D' 배지
   *   - Bull/Inner Bull: 핑크 채움 + 흰 글씨
   *   - Single: 일반 라벤더 border
   *   - Miss: 회색 + 'MISS'
   *   - 비어있음: 연한 라벤더 점선
   */
  private drawDartSlot(
    sx: number, sy: number, w: number, h: number,
    hit: HitResult | undefined,
    scale = 1,
  ): void {
    const ctx = this.ctx;
    const radius = 6;

    // 채움 팝 — 슬롯 중심 기준 스케일
    const scaled = scale !== 1;
    if (scaled) {
      const midX = sx + w / 2;
      const midY = sy + h / 2;
      ctx.save();
      ctx.translate(midX, midY);
      ctx.scale(scale, scale);
      ctx.translate(-midX, -midY);
    }

    if (!hit) {
      // 빈 슬롯 — 점선 border + 가운데 옅은 '·'
      ctx.fillStyle = COLORS.slotBgEmpty;
      ctx.beginPath();
      ctx.roundRect(sx, sy, w, h, radius);
      ctx.fill();
      ctx.strokeStyle = COLORS.slotBorderEmpty;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.roundRect(sx + 0.5, sy + 0.5, w - 1, h - 1, radius);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(156, 122, 235, 0.25)';
      ctx.font = `900 14px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('·', sx + w / 2, sy + h / 2);
      if (scaled) ctx.restore();
      return;
    }

    // kind 별 스타일
    // 타입을 명시적으로 string 으로 — COLORS 가 `as const` 라 리터럴 타입으로 좁혀지면
    // switch 안에서 다른 색 문자열을 못 할당하게 됨.
    let fill: string = COLORS.slotBgFilled;
    let border: string = COLORS.slotBorderFilled;
    let labelColor: string = COLORS.textMain;
    let badge: string | null = null;
    let badgeColor: string = COLORS.textAccent;

    switch (hit.kind) {
      case 'triple':
        border = '#ff5a92';
        badge = 'T';
        badgeColor = '#ff5a92';
        break;
      case 'double':
        border = '#2e8a70';
        badge = 'D';
        badgeColor = '#2e8a70';
        break;
      case 'inner-bull':
        fill = '#ff82ac';
        border = '#c93d73';
        labelColor = '#fff';
        badge = 'BULL';
        badgeColor = '#fff';
        break;
      case 'outer-bull':
        fill = '#ffd9e6';
        border = '#ff82ac';
        labelColor = '#c93d73';
        break;
      case 'miss':
        fill = '#eeeaf0';
        border = '#b8b0be';
        labelColor = '#8a7a8a';
        break;
      case 'single':
      default:
        // 기본값 유지 (라벤더 border, 흰 fill, 본문색 label)
        break;
    }

    // 슬롯 박스
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(sx, sy, w, h, radius);
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(sx + 0.75, sy + 0.75, w - 1.5, h - 1.5, radius);
    ctx.stroke();

    // 상단 배지 (Triple/Double/Bull)
    if (badge) {
      ctx.fillStyle = badgeColor;
      ctx.font = `900 8px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(badge, sx + w / 2, sy + 9);
    }

    // 메인 라벨 — 점수(=실제 가산 값)를 크게.
    // Low Count-up 같은 모드에서도 "이번 다트가 얼마였는지"를 직관적으로.
    const mainText = hit.kind === 'miss' ? 'MISS' : String(hit.score);
    const mainY = badge ? sy + h / 2 + 4 : sy + h / 2;
    ctx.fillStyle = labelColor;
    ctx.font = hit.kind === 'miss' ? `900 10px ${FONT}` : `900 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mainText, sx + w / 2, mainY);

    if (scaled) ctx.restore();
  }

  /** 한 row 의 전체 높이 (drawRightPanel 의 y 증가량과 일치해야 함) */
  private static readonly OTHER_ROW_H = 30;

  /**
   * 내 점수 카드 아래 라운드별 점수 그리드.
   *   각 칸 = R번호 + 정확한 점수 + 칸 뒤 옅은 크기 막대. 모든 라운드 표시(유실 없음).
   *   라운드가 많아지면(X01 은 상한 없음) 열 수를 늘려 최대 3줄로 높이를 묶는다.
   *   반환값 = 실제 그린 높이 (호출부 y 진행에 사용).
   */
  private drawRoundHistory(x: number, y: number, w: number, scores: readonly number[]): number {
    const ctx = this.ctx;
    const n = scores.length;
    if (n === 0) return 0;

    // 라운드 수에 따라 줄 수 적응: 5↓=1줄, 12↓=2줄, 그 이상=3줄. 열 수는 거기서 역산.
    const maxRows = n <= 5 ? 1 : n <= 12 ? 2 : 3;
    const perRow = Math.ceil(n / maxRows);
    const rows = Math.ceil(n / perRow);
    const cellGap = 6;
    const rowGap = 6;
    const cellH = 26;
    const cellW = (w - cellGap * (perRow - 1)) / perRow;

    for (let i = 0; i < n; i++) {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const cx = x + col * (cellW + cellGap);
      const cy = y + row * (cellH + rowGap);
      const last = i === n - 1;

      // 칸 배경 (반투명 흰색 — 칸이 많아 그림자는 생략해 깔끔하게)
      ctx.beginPath();
      ctx.roundRect(cx, cy, cellW, cellH, 6);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
      ctx.fill();

      // 테두리 (최근 라운드 = 핑크 강조)
      ctx.beginPath();
      ctx.roundRect(cx, cy, cellW, cellH, 6);
      ctx.strokeStyle = last ? COLORS.currentCardStroke : 'rgba(216, 199, 255, 0.7)';
      ctx.lineWidth = last ? 2 : 1;
      ctx.stroke();

      // R번호 (좌상단 작게)
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `700 8px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`R${i + 1}`, cx + 4, cy + 3);

      // 점수 (우측 중앙, 크게)
      ctx.fillStyle = last ? COLORS.currentCardStroke : COLORS.textMain;
      ctx.font = `900 13px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(scores[i]!), cx + cellW - 4, cy + cellH / 2 + 2);
    }

    return rows * cellH + (rows - 1) * rowGap;
  }

  private drawOtherPlayerRow(
    p: PlayerDisplay,
    x: number, y: number, w: number,
    isActive: boolean,
    mode: DartsMode,
  ): number {
    const ctx = this.ctx;
    // Cricket 모드에선 미니 마크 행을 행 안에 포함시키려고 행을 더 크게 잡음.
    //   상단(닉네임/점수) 28px + 하단(7타겟 마크) 28px = 56px
    const isCricket = mode === 'cricket' && !!p.cricketMarks;
    const h = isCricket ? 56 : DartsRenderer.OTHER_ROW_H;

    // 카드형 배경 — 현재 차례면 라벤더 강조 (프로스티드)
    this.frostedCard(x, y, w, h, {
      radius: 10,
      active: isActive,
      fill: isActive ? 'rgba(240, 232, 255, 0.75)' : 'rgba(255, 255, 255, 0.5)',
      line: 'rgba(233, 223, 255, 0.8)',
    });

    // Cricket 이면 상단 28px 영역의 중앙, 아니면 행 전체의 중앙에 텍스트 베이스라인.
    const topRowH = isCricket ? 28 : h;
    const midY = y + topRowH / 2;

    // 닉네임 (세로 중앙 정렬). isActive 면 앞에 ▶ 배지.
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 13px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const nameLabel = (isActive ? '▶ ' : '') + truncate(p.nickname, isActive ? 8 : 10);
    ctx.fillText(nameLabel, x + 10, midY);

    // Cricket 모드면 close 한 타겟 수를 괄호로 부연
    let rightText: string;
    if (p.cricketMarks) {
      const closed = Object.values(p.cricketMarks).filter((m) => m >= 3).length;
      rightText = `${p.primaryValue} · ${closed}/7`;
    } else {
      rightText = p.finished ? '✓ ' + p.primaryValue : String(p.primaryValue);
    }

    ctx.fillStyle = p.finished ? COLORS.textWin : COLORS.textAccent;
    ctx.font = `800 14px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(rightText, x + w - 10, midY);

    // Cricket 모드 — 하단에 7타겟 마크 미니 표시
    if (isCricket && p.cricketMarks) {
      this.drawCricketMarksRow(x + 4, y + 28, w - 8, p.cricketMarks);
    }

    return h;
  }

  /**
   * Cricket 타겟(15~20 + Bull) 별 마크(●○○ ~ ●●●) 미니 표.
   * 한 행에 7개 타겟. 각 타겟 = 라벨 + 아래 dot 3개.
   */
  private drawCricketMarksRow(
    x: number, y: number, w: number,
    marks: Record<string, number>,
  ): void {
    const ctx = this.ctx;
    const targets: { key: string; label: string }[] = [
      { key: '15', label: '15' },
      { key: '16', label: '16' },
      { key: '17', label: '17' },
      { key: '18', label: '18' },
      { key: '19', label: '19' },
      { key: '20', label: '20' },
      { key: 'bull', label: 'B' },
    ];
    const cellW = w / targets.length;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      const cx = x + cellW * i + cellW / 2;
      const m = marks[t.key] ?? 0;
      const closed = m >= 3;

      // 라벨 (15~20 / B). close 된 타겟은 민트색으로 하이라이트
      ctx.fillStyle = closed ? COLORS.textWin : COLORS.textMuted;
      ctx.font = `800 10px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(t.label, cx, y + 10);

      // 3개 dot (찬 만큼 채운 원, 나머지는 빈 원)
      const dotR = 2.4;
      const dotGap = 7;
      const dotsStartX = cx - dotGap;
      for (let d = 0; d < 3; d++) {
        const dx = dotsStartX + dotGap * d;
        const dy = y + 22;
        ctx.beginPath();
        ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
        if (d < m) {
          ctx.fillStyle = closed ? COLORS.outerBull : COLORS.innerBull;
          ctx.fill();
        } else {
          ctx.strokeStyle = COLORS.panelBorder;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
  }

  // ============================================
  // 게임 종료 오버레이
  // ============================================

  private drawGameOverOverlay(state: DartsRenderState, now: number): void {
    const ctx = this.ctx;
    const go = state.gameOver!;

    // materialize: 딤 배경 페이드 + 텍스트 살짝 확대
    const raw = this.gameOverShownAt > 0 ? clamp01((now - this.gameOverShownAt) / MATERIALIZE_MS) : 1;
    const t = prefersReducedMotion ? 1 : easeOut(raw);
    const cx = (PANEL_X - 10) / 2;
    const cy = CANVAS_H / 2;

    // 과녁 영역만 덮기 (패널은 그대로). 알파를 진행도에 비례.
    ctx.fillStyle = `rgba(255, 249, 253, ${0.92 * t})`;
    ctx.fillRect(0, 0, PANEL_X - 10, CANVAS_H);

    const scale = prefersReducedMotion ? 1 : 0.92 + 0.08 * t;
    ctx.save();
    ctx.globalAlpha = t;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

    ctx.fillStyle = COLORS.overlayTitle;
    ctx.font = `900 36px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(go.winnerNickname ? `${truncate(go.winnerNickname, 10)} 승!` : '종료', cx, cy - 10);

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(go.subtitle, cx, cy + 24);
    ctx.restore();
  }
}

// ============================================
// 유틸 (board.ts 와 공유하는 헬퍼를 render-only로 export)
// ============================================

/** 캔버스 논리 좌표 → 과녁 중심 기준 상대 좌표 + 히트 판정까지 (편의) */
export function logicalToHit(lx: number, ly: number): HitResult {
  return hitScore(lx - BOARD_CX, ly - BOARD_CY, BOARD_R);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
