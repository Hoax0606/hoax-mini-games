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

  // 다트보드 외곽 링 — 실제 다트판다운 검정 느낌(완전 #000 말고 살짝 따뜻한 차콜).
  boardOuterRing: '#1c1820',
  boardOuterRingStroke: '#0f0b12',

  // Single 세그먼트 배경 (짝/홀 교차)
  singleCream: '#fff6e4',
  singleLavender: '#e9dfff',

  // Double / Triple 링 색 (짝/홀) — 다른 게임과 같은 pink/mint 팔레트 재사용
  ringPink: '#ff82ac',
  ringMint: '#86e8c4',

  // 세그먼트 구분선(스파이더) — 외곽 링과 같은 톤
  segBorder: '#1c1820',

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
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: (canvasPx / rect.width) * CANVAS_W,
      y: (canvasPy / rect.height) * CANVAS_H,
    };
  }

  // ============================================
  // 메인 render
  // ============================================

  render(state: DartsRenderState): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 논리 좌표 800×400 → 실제 픽셀 변환
    const sx = (rect.width * dpr) / CANVAS_W;
    const sy = (rect.height * dpr) / CANVAS_H;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);

    // 배경
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // 다트보드
    this.drawBoard();

    // 과녁에 꽂힌 다트들
    for (const d of state.stuckDarts) {
      this.drawDart(BOARD_CX + d.localX, BOARD_CY + d.localY, d.rotation, 1 + (1 - d.freshness) * 0);
    }

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
    this.drawRightPanel(state);

    // BUST 배너 — 현재 플레이어가 bust 상태면 과녁 위에 크게 표시
    const curDisplay = state.players[state.currentPlayerIdx];
    if (curDisplay?.bustThisTurn && !state.gameOver) {
      this.drawBustBanner();
    }

    // 게임 종료 오버레이
    if (state.gameOver) {
      this.drawGameOverOverlay(state);
    }
  }

  /** 과녁 상단에 큰 "BUST!" 배너 — 턴 원복 시 1.4초 정도 노출 */
  private drawBustBanner(): void {
    const ctx = this.ctx;
    const cx = BOARD_CX;
    const cy = BOARD_CY;

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
    ctx.fillText('💥 BUST!', cx, cy - 8);

    ctx.fillStyle = 'rgba(255, 240, 240, 0.95)';
    ctx.font = `700 13px ${FONT}`;
    ctx.fillText('이번 턴 턴 무효', cx, cy + 18);
  }

  // ============================================
  // 다트보드 그리기
  // ============================================

  private drawBoard(): void {
    const ctx = this.ctx;

    // 외곽 라벤더 링 — 숫자가 이 링 안에 들어가야 하므로 두껍게(1.10 배).
    ctx.fillStyle = COLORS.boardOuterRing;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, BOARD_R * 1.10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.boardOuterRingStroke;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 20개 세그먼트 렌더: Single outer → Triple ring → Single inner 역순으로 큰 것부터
    const SEG_ARC = Math.PI / 10;
    const HALF = SEG_ARC / 2;

    for (let i = 0; i < 20; i++) {
      // 12시 방향이 i=0 (세그먼트 20). 각 세그먼트 중심 각도 = -π/2 + i * SEG_ARC
      // arc start/end 는 각도 범위.
      const centerAngle = -Math.PI / 2 + i * SEG_ARC;
      const startA = centerAngle - HALF;
      const endA = centerAngle + HALF;
      const isEven = i % 2 === 0;

      // 1) 바깥 single (Triple 바깥 ~ Double 안쪽)
      this.fillRing(
        startA, endA,
        BOARD_R * BOARD_RATIOS.TRIPLE_OUTER,
        BOARD_R * BOARD_RATIOS.DOUBLE_INNER,
        isEven ? COLORS.singleCream : COLORS.singleLavender,
      );
      // 2) Double 링
      this.fillRing(
        startA, endA,
        BOARD_R * BOARD_RATIOS.DOUBLE_INNER,
        BOARD_R * BOARD_RATIOS.DOUBLE_OUTER,
        isEven ? COLORS.ringPink : COLORS.ringMint,
      );
      // 3) Triple 링
      this.fillRing(
        startA, endA,
        BOARD_R * BOARD_RATIOS.TRIPLE_INNER,
        BOARD_R * BOARD_RATIOS.TRIPLE_OUTER,
        isEven ? COLORS.ringPink : COLORS.ringMint,
      );
      // 4) 안쪽 single (Bull 밖 ~ Triple 안쪽)
      this.fillRing(
        startA, endA,
        BOARD_R * BOARD_RATIOS.OUTER_BULL_OUTER,
        BOARD_R * BOARD_RATIOS.TRIPLE_INNER,
        isEven ? COLORS.singleCream : COLORS.singleLavender,
      );
    }

    // 세그먼트 경계선 (스파이더)
    ctx.strokeStyle = COLORS.segBorder;
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 20; i++) {
      const angle = -Math.PI / 2 + i * SEG_ARC - HALF;
      const x0 = BOARD_CX + Math.cos(angle) * BOARD_R * BOARD_RATIOS.OUTER_BULL_OUTER;
      const y0 = BOARD_CY + Math.sin(angle) * BOARD_R * BOARD_RATIOS.OUTER_BULL_OUTER;
      const x1 = BOARD_CX + Math.cos(angle) * BOARD_R * BOARD_RATIOS.DOUBLE_OUTER;
      const y1 = BOARD_CY + Math.sin(angle) * BOARD_R * BOARD_RATIOS.DOUBLE_OUTER;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // Bull
    ctx.fillStyle = COLORS.outerBull;
    ctx.strokeStyle = COLORS.outerBullStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, BOARD_R * BOARD_RATIOS.OUTER_BULL_OUTER, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = COLORS.innerBull;
    ctx.strokeStyle = COLORS.innerBullStroke;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, BOARD_R * BOARD_RATIOS.BULL_OUTER, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 세그먼트 번호 라벨 — 외곽 라벤더 링(1.0~1.10) 중앙에 안정적으로 위치.
    // 폰트 13 + labelR 1.050 이면 숫자가 링 안쪽에 완전히 들어감.
    ctx.fillStyle = COLORS.segNumber;
    ctx.font = `900 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelR = BOARD_R * 1.050;
    for (let i = 0; i < 20; i++) {
      const centerAngle = -Math.PI / 2 + i * SEG_ARC;
      const x = BOARD_CX + Math.cos(centerAngle) * labelR;
      const y = BOARD_CY + Math.sin(centerAngle) * labelR;
      ctx.fillText(String(SEGMENTS[i]), x, y);
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

  private drawRightPanel(state: DartsRenderState): void {
    const ctx = this.ctx;
    // 패널 배경 — radius 있는 라운드 박스처럼 자연스럽게
    ctx.fillStyle = COLORS.panelBg;
    ctx.fillRect(PANEL_X, 20, PANEL_W, CANVAS_H - 40);
    ctx.strokeStyle = COLORS.panelBorder;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(PANEL_X, 20, PANEL_W, CANVAS_H - 40);

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
      this.drawMyPlayerBlock(me, innerX, y, innerW, state.mode, isMyTurn);
      y += 120 + 10;

      // 2-a) 내 라운드별 점수 히스토리 한 줄 (Cricket 제외 — 마크가 더 중요)
      if (state.mode !== 'cricket' && me.roundScores && me.roundScores.length > 0) {
        this.drawRoundHistoryLine(innerX, y, innerW, me.roundScores);
        y += 20 + 4;
      }
      // 다음 "다른 플레이어" 섹션과 시각적 분리를 위한 공통 여백
      // (히스토리 유무와 무관하게 라벨이 위 셀/카드와 떨어지도록)
      y += 14;
    } else {
      // 관전자 — 내 카드 없으므로 현재 차례 플레이어 카드를 대신 표시
      const cur = state.players[state.currentPlayerIdx];
      if (cur) {
        this.drawMyPlayerBlock(cur, innerX, y, innerW, state.mode, true);
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
      ctx.fillText('👥 다른 플레이어', innerX, y);
      y += 14;

      for (let i = 0; i < state.players.length; i++) {
        if (i === myIdx) continue;
        const p = state.players[i]!;
        const isActive = i === state.currentPlayerIdx;
        this.drawOtherPlayerRow(p, innerX, y, innerW, isActive);
        y += DartsRenderer.OTHER_ROW_H + 4;
      }
    }
  }

  /**
   * 상단 헤더 카드 — 🎯 모드명 (좌상) + Round N/M (우상) + 현재 차례 플레이어 (하).
   * 내가 차례가 아닐 때 현재 누구 차례인지 헤더로 알려줌 ("내 카드"가 고정되어 있어 메인 카드만 봐서는 모름).
   */
  private drawModeHeaderCard(x: number, y: number, w: number, state: DartsRenderState): void {
    const ctx = this.ctx;
    const h = 48;

    // 카드 배경 (연한 라벤더)
    ctx.fillStyle = '#f0e8ff';
    ctx.strokeStyle = '#c7b3f0';
    ctx.lineWidth = 1.2;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    // 상단 라인 — 모드명 (좌) + Round (우)
    ctx.fillStyle = COLORS.textAccent;
    ctx.font = `900 18px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`🎯 ${state.modeLabel}`, x + 12, y + 22);

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
  ): void {
    const ctx = this.ctx;
    const H = 120;
    const cx = x + w / 2; // 카드 가로 중앙 — 큰 숫자/3다트 슬롯 가운데 정렬에 사용

    const bust = p.bustThisTurn === true;

    // 배경: bust > myTurn > rest. myTurn 아니면 카드 전체를 조금 더 옅게 (배경색은 동일하되 stroke/accent 를 톤다운).
    ctx.fillStyle = bust ? COLORS.bustCardBg : COLORS.currentCardBg;
    ctx.fillRect(x, y, w, H);
    ctx.strokeStyle = bust
      ? COLORS.bustCardStroke
      : isMyTurn ? COLORS.currentCardStroke : '#f0b8d0'; // 내 턴 아닐 땐 부드러운 핑크 테두리
    ctx.lineWidth = bust ? 3 : (isMyTurn ? 2 : 1.2);
    ctx.strokeRect(x, y, w, H);

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
    ctx.fillText(labelText, x + 10, y + 18);

    // 닉네임 (우측 상단)
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `800 16px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(truncate(p.nickname, 10), x + w - 10, y + 18);

    // 큰 숫자 (가운데 정렬로 임팩트 강조)
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `900 34px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.primaryValue), cx, y + 54);

    // primaryLabel — 큰 숫자 아래 작게 (가운데)
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 11px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(p.primaryLabel, cx, y + 80);

    // 이번 턴 3다트 슬롯 — 카드 하단 가운데 정렬, kind 별 색 강조
    const slotW = 38;
    const slotGap = 8;
    const slotH = 28;
    const slotsTotalW = slotW * 3 + slotGap * 2;
    const slotStartX = cx - slotsTotalW / 2;
    const slotTopY = y + H - slotH - 4;    // 카드 하단에서 4px 여유
    const showMultiplierBadges = mode === 'low-countup';

    for (let i = 0; i < 3; i++) {
      const sx = slotStartX + i * (slotW + slotGap);
      const hit = p.throwsThisRound[i];

      // Low Count-up 은 각 슬롯에 ×1/×2/×3 배수 배지 (슬롯 위)
      if (showMultiplierBadges) {
        ctx.fillStyle = COLORS.textAccent;
        ctx.font = `900 9px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(`×${i + 1}`, sx + slotW / 2, slotTopY - 4);
      }

      this.drawDartSlot(sx, slotTopY, slotW, slotH, hit);
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
  ): void {
    const ctx = this.ctx;
    const radius = 6;

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
  }

  /** 한 row 의 전체 높이 (drawRightPanel 의 y 증가량과 일치해야 함) */
  private static readonly OTHER_ROW_H = 30;

  /**
   * 내 점수 카드 아래 한 줄짜리 라운드 히스토리.
   *   [R1·60] [R2·42] [R3·80] … (최근 몇 개까지만)
   * 카드 폭 맞춰 4~5칸 정도 들어감.
   */
  private drawRoundHistoryLine(x: number, y: number, w: number, scores: readonly number[]): void {
    const ctx = this.ctx;
    const maxShow = 5;
    const recent = scores.slice(-maxShow);
    const n = recent.length;
    if (n === 0) return;

    const totalGap = 4 * (n - 1);
    const cellW = Math.floor((w - totalGap) / n);
    const h = 20;

    // 시작 라운드 번호 (이전 턴 기록이니 scores.length 가 곧 끝난 턴 수)
    const startRound = scores.length - n + 1;

    for (let i = 0; i < n; i++) {
      const sx = x + i * (cellW + 4);
      const score = recent[i]!;

      // 배경 카드 (연한 라벤더 grid)
      ctx.fillStyle = '#f7f1ff';
      ctx.strokeStyle = '#e2d4f2';
      ctx.lineWidth = 1;
      ctx.fillRect(sx, y, cellW, h);
      ctx.strokeRect(sx, y, cellW, h);

      // 좌측 R 라벨
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `700 9px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`R${startRound + i}`, sx + 5, y + h / 2);

      // 우측 점수 숫자
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `800 12px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(String(score), sx + cellW - 5, y + h / 2);
    }
  }

  private drawOtherPlayerRow(
    p: PlayerDisplay,
    x: number, y: number, w: number,
    isActive = false,
  ): void {
    const ctx = this.ctx;
    const h = DartsRenderer.OTHER_ROW_H;

    // 카드형 배경 — 현재 차례면 라벤더 강조
    ctx.fillStyle = isActive ? '#f0e8ff' : COLORS.otherRowBg;
    ctx.strokeStyle = isActive ? '#b89aff' : COLORS.otherRowBorder;
    ctx.lineWidth = isActive ? 1.5 : 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    const midY = y + h / 2;

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

  private drawGameOverOverlay(state: DartsRenderState): void {
    const ctx = this.ctx;
    const go = state.gameOver!;
    // 과녁 영역만 덮기 (패널은 그대로)
    ctx.fillStyle = COLORS.overlayBg;
    ctx.fillRect(0, 0, PANEL_X - 10, CANVAS_H);

    const cx = (PANEL_X - 10) / 2;
    const cy = CANVAS_H / 2;

    ctx.fillStyle = COLORS.overlayTitle;
    ctx.font = `900 36px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(go.winnerNickname ? `${truncate(go.winnerNickname, 10)} 승!` : '종료', cx, cy - 10);

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(go.subtitle, cx, cy + 24);
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
