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
 *  과녁 아래에 windup (마우스 아래로 당기기) 공간을 충분히 남기기 위해
 *  CY 를 위로 올리고 R 을 약간 줄임. */
export const BOARD_CX = 260;
export const BOARD_CY = 150;
export const BOARD_R = 138;

/** 우측 점수판 영역 — index.ts 도 hit-test 에 쓰므로 export */
export const PANEL_X = 440;
const PANEL_W = 340;

// ============================================
// 색 팔레트 (다른 게임들과 같은 파스텔 톤)
// ============================================

const COLORS = {
  bg: '#fff9fd',
  boardOutline: '#2a1e2e',
  boardOutlineInner: '#3a2a3a',

  // Single 세그먼트 배경 (짝/홀 교차)
  singleCream: '#fff6e4',
  singleLavender: '#e9dfff',

  // Double / Triple 링 색 (짝/홀)
  ringPink: '#ff82ac',
  ringMint: '#86e8c4',

  // 세그먼트 구분선
  segBorder: '#3a2a3a',

  // Bull
  outerBull: '#86e8c4',
  outerBullStroke: '#2e8a70',
  innerBull: '#ff82ac',
  innerBullStroke: '#c93d73',

  // 숫자 라벨 — 어두운 바깥 링 위에 올라가므로 밝은 크림색
  segNumber: '#fff6e4',

  // 다트 색 — 꽂힌 다트/날아가는 다트 공용
  dartShaft: '#fdf6ec',
  dartShaftStroke: '#8a7a8a',
  dartTip: '#3a2a3a',
  dartFlight1: '#b89aff',
  dartFlight2: '#ff82ac',

  // 패널
  panelBg: '#faf5ff',
  panelBorder: '#d9c7ff',

  // 텍스트
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  textAccent: '#9c7aeb',
  textWin: '#2e8a70',

  // 게임 오버 오버레이
  overlayBg: 'rgba(255, 255, 255, 0.8)',
  overlayTitle: '#4a3a4a',
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

    // 반투명 빨간 원 배경
    ctx.fillStyle = 'rgba(214, 59, 59, 0.88)';
    ctx.strokeStyle = '#a42020';
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
    ctx.fillText('이번 턴 점수 원복', cx, cy + 18);
  }

  // ============================================
  // 다트보드 그리기
  // ============================================

  private drawBoard(): void {
    const ctx = this.ctx;

    // 외곽 어두운 링 (다트보드 테두리)
    ctx.fillStyle = COLORS.boardOutline;
    ctx.beginPath();
    ctx.arc(BOARD_CX, BOARD_CY, BOARD_R * 1.08, 0, Math.PI * 2);
    ctx.fill();

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

    // 세그먼트 번호 라벨 (바깥 dark ring 위에)
    ctx.fillStyle = COLORS.segNumber;
    ctx.font = `900 15px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelR = BOARD_R * 1.045;
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

  /** 한 다트 그리기 — (x, y) 는 tip(꽂힌 끝) 좌표 */
  private drawDart(tipX: number, tipY: number, rotation: number, scale = 1): void {
    const ctx = this.ctx;
    // 기본 크기 배율 — 호출자가 주는 scale 에 일괄 곱해서 전체적으로 다트가 잘 보이게.
    // 모든 호출자 비율 (stuck=1, held=1.15, pickup=1.25 등) 은 그대로 유지됨.
    const BASE = 1.35;
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(rotation);
    ctx.scale(scale * BASE, scale * BASE);

    // 다트 몸통 (tip에서 반대 방향으로 뻗음)
    // tip 위치가 원점. 다트는 위쪽으로 뻗은 모양.
    // 팁
    ctx.fillStyle = COLORS.dartTip;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-2, -4);
    ctx.lineTo(2, -4);
    ctx.closePath();
    ctx.fill();

    // 샤프트
    ctx.fillStyle = COLORS.dartShaft;
    ctx.strokeStyle = COLORS.dartShaftStroke;
    ctx.lineWidth = 0.5;
    ctx.fillRect(-1.2, -22, 2.4, 18);
    ctx.strokeRect(-1.2, -22, 2.4, 18);

    // 플라이트 (뒷깃 2개)
    ctx.fillStyle = COLORS.dartFlight1;
    ctx.beginPath();
    ctx.moveTo(-1.2, -22);
    ctx.lineTo(-7, -18);
    ctx.lineTo(-1.2, -14);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = COLORS.dartFlight2;
    ctx.beginPath();
    ctx.moveTo(1.2, -22);
    ctx.lineTo(7, -18);
    ctx.lineTo(1.2, -14);
    ctx.closePath();
    ctx.fill();

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
    const px = 260;
    const py = 315;
    // 팁이 과녁 쪽 (위) 을 살짝 향하도록 기울임
    const rotation = Math.PI * 0.92;
    ctx.save();
    ctx.globalAlpha = 0.85;
    this.drawDart(px, py, rotation, 1.25);
    ctx.restore();

    // 힌트 텍스트 (다트 아래 — 이 밑이 실제 windup 영역)
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('클릭 → 아래로 당겼다가 위로 휘둘러 던지기', px, py + 34);
  }

  // ============================================
  // 우측 패널 (점수판)
  // ============================================

  private drawRightPanel(state: DartsRenderState): void {
    const ctx = this.ctx;
    // 패널 배경
    ctx.fillStyle = COLORS.panelBg;
    ctx.fillRect(PANEL_X, 20, PANEL_W, CANVAS_H - 40);
    ctx.strokeStyle = COLORS.panelBorder;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(PANEL_X, 20, PANEL_W, CANVAS_H - 40);

    const cx = PANEL_X + PANEL_W / 2;
    let y = 36;

    // 모드 라벨
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('MODE', cx, y);
    y += 16;
    ctx.fillStyle = COLORS.textAccent;
    ctx.font = `900 20px ${FONT}`;
    ctx.fillText(state.modeLabel, cx, y);
    y += 14;

    // 라운드 정보
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 12px ${FONT}`;
    const roundText = state.maxRounds
      ? `Round ${state.round} / ${state.maxRounds}`
      : `Round ${state.round}`;
    ctx.fillText(roundText, cx, y);
    y += 14;

    // 구분선
    ctx.strokeStyle = COLORS.panelBorder;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(PANEL_X + 16, y);
    ctx.lineTo(PANEL_X + PANEL_W - 16, y);
    ctx.stroke();
    ctx.setLineDash([]);
    y += 12;

    // 현재 플레이어 블록
    const cur = state.players[state.currentPlayerIdx];
    if (cur) {
      this.drawCurrentPlayerBlock(cur, PANEL_X + 16, y, PANEL_W - 32, state.mode);
      y += 120;
    }

    // Cricket 전용: 현재 플레이어의 타겟별 마크 현황
    if (state.mode === 'cricket' && cur?.cricketMarks) {
      this.drawCricketMarksRow(PANEL_X + 16, y, PANEL_W - 32, cur.cricketMarks);
      y += 36;
    }

    // 구분선
    ctx.strokeStyle = COLORS.panelBorder;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(PANEL_X + 16, y);
    ctx.lineTo(PANEL_X + PANEL_W - 16, y);
    ctx.stroke();
    ctx.setLineDash([]);
    y += 10;

    // 다른 플레이어 목록
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('다른 플레이어', PANEL_X + 16, y);
    y += 14;

    for (let i = 0; i < state.players.length; i++) {
      if (i === state.currentPlayerIdx) continue;
      const p = state.players[i]!;
      this.drawOtherPlayerRow(p, PANEL_X + 16, y, PANEL_W - 32);
      y += 22;
    }
  }

  private drawCurrentPlayerBlock(
    p: PlayerDisplay,
    x: number,
    y: number,
    w: number,
    mode: DartsMode,
  ): void {
    const ctx = this.ctx;
    // bust 상태면 빨간 카드로 강하게 강조. 아니면 기본 노란 카드.
    const bust = p.bustThisTurn === true;
    ctx.fillStyle = bust ? '#ffd4d4' : '#fff3c5';
    ctx.fillRect(x, y, w, 110);
    ctx.strokeStyle = bust ? '#d63b3b' : '#c9a01f';
    ctx.lineWidth = bust ? 3 : 2;
    ctx.strokeRect(x, y, w, 110);

    // "현재 차례" 라벨 (bust 면 BUST! 로 교체)
    ctx.fillStyle = bust ? '#d63b3b' : '#c9a01f';
    ctx.font = bust ? `900 13px ${FONT}` : `800 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(bust ? '💥 BUST! · 점수 원복' : '▶ 지금 차례', x + 10, y + 18);

    // 닉네임
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `800 17px ${FONT}`;
    ctx.fillText(truncate(p.nickname, 10), x + 10, y + 38);

    // 주요 값 (남은 점수 / 총점)
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 11px ${FONT}`;
    ctx.fillText(p.primaryLabel, x + 10, y + 58);

    ctx.fillStyle = COLORS.textMain;
    ctx.font = `900 26px ${FONT}`;
    ctx.fillText(String(p.primaryValue), x + 10, y + 82);

    // 이번 턴 3다트 슬롯
    const slotY = y + 92;
    const slotW = 28;
    const slotGap = 4;
    const slotsTotalW = slotW * 3 + slotGap * 2;
    const slotStartX = x + w - 10 - slotsTotalW;
    // Low Count-up 만 슬롯 위에 ×1/×2/×3 배수 배지 노출
    const showMultiplierBadges = mode === 'low-countup';
    for (let i = 0; i < 3; i++) {
      const sx = slotStartX + i * (slotW + slotGap);
      const hit = p.throwsThisRound[i];

      if (showMultiplierBadges) {
        ctx.fillStyle = '#9c7aeb';
        ctx.font = `900 10px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(`×${i + 1}`, sx + slotW / 2, slotY - 20);
      }

      ctx.fillStyle = hit ? '#fff' : '#f0e6ff';
      ctx.strokeStyle = hit ? '#9c7aeb' : '#d9c7ff';
      ctx.lineWidth = 1;
      ctx.fillRect(sx, slotY - 16, slotW, 20);
      ctx.strokeRect(sx, slotY - 16, slotW, 20);
      if (hit) {
        ctx.fillStyle = COLORS.textMain;
        ctx.font = `900 11px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(hit.label, sx + slotW / 2, slotY - 2);
      }
    }
  }

  private drawOtherPlayerRow(p: PlayerDisplay, x: number, y: number, w: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `600 13px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(truncate(p.nickname, 11), x, y + 12);

    // Cricket 모드면 close 한 타겟 수를 괄호로 부연 (예: "점수 · 4/7")
    let rightText: string;
    if (p.cricketMarks) {
      const closed = Object.values(p.cricketMarks).filter((m) => m >= 3).length;
      rightText = `${p.primaryValue} · ${closed}/7`;
    } else {
      rightText = p.finished ? '✓ ' + p.primaryValue : String(p.primaryValue);
    }

    ctx.fillStyle = p.finished ? COLORS.textWin : COLORS.textMain;
    ctx.font = `800 13px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(rightText, x + w, y + 12);
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
