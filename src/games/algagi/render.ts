/**
 * 알까기 Canvas 렌더러
 *
 * 레이아웃 (800×400 논리 좌표):
 *   ┌─────────────────────────┬───────────────────────┐
 *   │                         │  🎯 OOO 차례          │
 *   │     보드 (360×360)      │  ─────────────────    │
 *   │     (20,20)~(380,380)   │   P0: 5개  P1: 4개    │
 *   │     정사각, 그리드       │   P2: 4개  P3: 4개    │
 *   │                         │  ─────────────────    │
 *   │                         │  안내 텍스트          │
 *   └─────────────────────────┴───────────────────────┘
 *
 * 알: 솔리드 단색 원 + 얇은 stroke + 위쪽 하이라이트 (CLAUDE.md 금기: 젤리 느낌 / 그라데이션 X)
 * 차례인 플레이어 알들: 외곽에 펄스 ring
 * 드래그 중: 발사 방향 화살표 (드래그 반대) + 세기 시각화
 */

import { fitContain, fitScreenToLogical, fitView } from '../_shared/canvasFit';
import {
  BOARD_HALF,
  STONE_RADIUS,
  MAX_FLICK_SPEED,
  FLICK_SPEED_PER_PX,
  type AlgagiGame,
  type PlayerIndex,
  type Stone,
} from './rules';

const CANVAS_W = 800;
const CANVAS_H = 400;

/** 보드 중심 (canvas 논리 좌표). 보드 정사각형의 정중앙 */
const BOARD_CX = 200;
const BOARD_CY = 200;

/** 우측 패널 영역 */
const PANEL_X = 420;
const PANEL_W = 360;
const PANEL_PAD = 16;

/** 색 팔레트 — HANDOFF 규약 */
const COLORS = {
  bg: '#fff9fd',
  boardFill: '#fff9e8',           // 크림 — 바둑판 느낌
  boardBorder: '#6e5872',         // 짙은 라벤더 — 절벽 외곽
  gridLine: 'rgba(110, 88, 114, 0.18)',
  gridStarPoint: 'rgba(110, 88, 114, 0.55)',

  // 플레이어 알 색 (0=호스트~3=마지막 게스트)
  playerFill: ['#6ed9b3', '#ff6b9e', '#b89aff', '#ffd454'] as const,
  playerStroke: ['#2e8a70', '#c93d73', '#7a5fc7', '#c49a1f'] as const,
  playerDeep: ['#1f6a55', '#a82a5c', '#5a3da3', '#8e6f10'] as const,

  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  cardBg: '#faf5ff',
  cardBorder: '#d9c7ff',
  accentPink: '#ff5a92',
  accentLavender: '#9c7aeb',

  dragLine: 'rgba(255, 90, 146, 0.85)',
  dragArrow: '#ff5a92',
  dragWeak: '#86e8c4',
  dragStrong: '#ff5a92',

  endOverlay: 'rgba(54, 36, 56, 0.65)',
} as const;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

// ============================================
// 입력 보조 — 캔버스 좌표 ↔ 보드 좌표
// ============================================

/** Canvas 의 마우스 픽셀 좌표 → 보드 중심 기준 논리 좌표.
 *  rect = canvas.getBoundingClientRect(). e.clientX/Y - rect.left/top 로 미리 빼서 전달. */
export function canvasToBoard(
  px: number, py: number,
  rect: DOMRect,
): { x: number; y: number } {
  // canvas 픽셀 → 논리 좌표 800×400 (레터박스 역변환 — render 와 동일 계산)
  const v = fitView(rect.width, rect.height, CANVAS_W, CANVAS_H);
  const { x: sx, y: sy } = fitScreenToLogical(v, px, py);
  return { x: sx - BOARD_CX, y: sy - BOARD_CY };
}

/** 보드 좌표가 보드 사각형 안에 있는지 */
export function isInsideBoard(boardX: number, boardY: number): boolean {
  return (
    boardX >= -BOARD_HALF && boardX <= BOARD_HALF &&
    boardY >= -BOARD_HALF && boardY <= BOARD_HALF
  );
}

/** 주어진 보드 좌표에서 가장 가까운 살아있는 알 (반지름 안에 있을 때만). 없으면 null. */
export function pickStoneAt(stones: Stone[], boardX: number, boardY: number): Stone | null {
  let best: Stone | null = null;
  let bestDistSq = STONE_RADIUS * STONE_RADIUS;
  for (const s of stones) {
    if (!s.alive) continue;
    const dx = s.x - boardX;
    const dy = s.y - boardY;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestDistSq) {
      bestDistSq = d2;
      best = s;
    }
  }
  return best;
}

// ============================================
// Renderer
// ============================================

export interface RenderState {
  game: AlgagiGame;
  /** 내 peerId — 차례 비교, 우승 카드 강조용 */
  myPeerId: string;
  /** 관전자면 입력 안 함 */
  isSpectator: boolean;
  /** 드래그 중인 알 (자기 차례 + 자기 알). null = 드래그 X */
  dragStoneId: number | null;
  /** 드래그 시작 시 마우스 보드 좌표 (= 알 위치) */
  dragStartX: number;
  dragStartY: number;
  /** 현재 마우스 보드 좌표 (드래그 중일 때만 의미). null = 마우스 밖 */
  mouseBoardX: number | null;
  mouseBoardY: number | null;
}

export interface AlgagiRendererArgs {
  canvas: HTMLCanvasElement;
}

export class AlgagiRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;

  constructor(args: AlgagiRendererArgs) {
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
    // 캔버스가 아직 레이아웃 안 됐으면(폭/높이 0) 아무것도 안 그림 —
    //   안 그러면 clearRect 로 지운 뒤 아무것도 못 그려 흰 페이지가 비쳐 보임.
    if (rect.width === 0 || rect.height === 0) return;

    // 균일 스케일+레터박스 (비율 유지 → 안 찌부러짐)
    fitContain(ctx, this.canvas, CANVAS_W, CANVAS_H, COLORS.bg);

    // 2) 보드
    this.drawBoard();

    // 3) 알들 + 차례 펄스
    const now = performance.now();
    this.drawStones(state.game, now);

    // 4) 드래그 가이드 (자기 차례 + 알 잡고 드래그 중일 때만)
    if (state.dragStoneId !== null && state.mouseBoardX !== null && state.mouseBoardY !== null) {
      this.drawDragGuide(
        state.game.stones[state.dragStoneId],
        state.mouseBoardX,
        state.mouseBoardY,
      );
    }

    // 5) 우측 패널
    this.drawPanel(state);

    // 6) 게임 종료 오버레이
    if (state.game.phase === 'ended') {
      this.drawEndOverlay(state);
    }
  }

  // ============================================
  // 보드
  // ============================================

  private drawBoard(): void {
    const ctx = this.ctx;
    const left = BOARD_CX - BOARD_HALF;
    const top = BOARD_CY - BOARD_HALF;
    const size = BOARD_HALF * 2;

    // 보드 배경 (크림)
    ctx.fillStyle = COLORS.boardFill;
    ctx.fillRect(left, top, size, size);

    // 그리드 — 9 분할 (10x10 칸)
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = 0.8;
    const divisions = 9;
    const step = size / divisions;
    ctx.beginPath();
    for (let i = 1; i < divisions; i++) {
      const x = left + step * i;
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + size);
      const y = top + step * i;
      ctx.moveTo(left, y);
      ctx.lineTo(left + size, y);
    }
    ctx.stroke();

    // 별점 (바둑판 화점) — 중앙 + 4 모서리 인근
    ctx.fillStyle = COLORS.gridStarPoint;
    const starPoints: Array<[number, number]> = [
      [BOARD_CX, BOARD_CY],
      [left + step * 3, top + step * 3],
      [left + step * 6, top + step * 3],
      [left + step * 3, top + step * 6],
      [left + step * 6, top + step * 6],
    ];
    for (const [px, py] of starPoints) {
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 보드 외곽 (낭떠러지 — 짙은 라벤더)
    ctx.strokeStyle = COLORS.boardBorder;
    ctx.lineWidth = 3;
    ctx.strokeRect(left - 1, top - 1, size + 2, size + 2);
  }

  // ============================================
  // 알들
  // ============================================

  private drawStones(game: AlgagiGame, nowMs: number): void {
    const ctx = this.ctx;
    const currentTurn = game.phase === 'aiming' ? game.currentTurn : -1;

    // 차례 펄스 알파 (0.4 ~ 1.0 사이)
    const pulse = 0.7 + 0.3 * Math.sin(nowMs / 280);

    for (const s of game.stones) {
      if (!s.alive) continue;
      const cx = BOARD_CX + s.x;
      const cy = BOARD_CY + s.y;

      // 보드 경계 밖으로 나간 정도 — 절벽으로 "떨어지는" 연출(축소 + 페이드).
      //   경계(±BOARD_HALF) 초과분 0~46px 동안 크기 1→0.25, 투명도 1→0 으로.
      const outDist = Math.max(
        0,
        Math.abs(s.x) - BOARD_HALF,
        Math.abs(s.y) - BOARD_HALF,
      );
      let scale = 1;
      let alpha = 1;
      if (outDist > 0) {
        const t = Math.min(1, outDist / 46);
        scale = 1 - t * 0.75;
        alpha = 1 - t;
      }
      if (alpha <= 0.02) continue; // 거의 다 떨어진 알은 생략

      // 차례 펄스 ring (자기 차례 + 그 사람 알만, 보드 안에 있을 때만)
      if (s.owner === currentTurn && outDist === 0) {
        ctx.strokeStyle = `rgba(255, 90, 146, ${pulse})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, STONE_RADIUS + 5, 0, Math.PI * 2);
        ctx.stroke();
      }

      this.drawStoneBody(cx, cy, s.owner, scale, alpha);
    }
  }

  /** 알 본체 — 솔리드 단색 + 얇은 stroke + 위쪽 안쪽 하이라이트 (CLAUDE.md 규약).
   *  scale/alpha 로 절벽 낙하 연출 표현. */
  private drawStoneBody(cx: number, cy: number, owner: PlayerIndex, scale = 1, alpha = 1): void {
    const ctx = this.ctx;
    const fill = COLORS.playerFill[owner];
    const stroke = COLORS.playerStroke[owner];
    const r = STONE_RADIUS * scale;

    ctx.save();
    ctx.globalAlpha = alpha;

    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 위쪽 안쪽 하이라이트 (반투명 흰색 호)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy - 1, r - 3, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();

    ctx.restore();
  }

  // ============================================
  // 드래그 가이드 (조준선)
  // ============================================

  private drawDragGuide(stone: Stone | undefined, mouseBoardX: number, mouseBoardY: number): void {
    if (!stone || !stone.alive) return;
    const ctx = this.ctx;
    const sx = BOARD_CX + stone.x;
    const sy = BOARD_CY + stone.y;
    const mx = BOARD_CX + mouseBoardX;
    const my = BOARD_CY + mouseBoardY;

    // 드래그 벡터 = (마우스 - 알). 발사 방향은 반대.
    const dx = mx - sx;
    const dy = my - sy;
    const dragLen = Math.hypot(dx, dy);
    if (dragLen < 4) return; // 너무 짧으면 가이드 X

    // 발사 속도 추정 (시각 표시용) — 0~1 정규화
    const speedEstimate = Math.min(dragLen * FLICK_SPEED_PER_PX, MAX_FLICK_SPEED);
    const strength = speedEstimate / MAX_FLICK_SPEED;

    // 드래그 라인 (알 → 마우스): 약한 점선
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = `rgba(140, 110, 150, 0.55)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(mx, my);
    ctx.stroke();
    ctx.setLineDash([]);

    // 발사 방향 화살표 (알 → 반대 방향)
    // 색은 세기에 따라 민트 → 핑크 그라데이션 (강할수록 위험)
    const arrowColor = lerpHex(COLORS.dragWeak, COLORS.dragStrong, strength);
    const ax = sx - dx;
    const ay = sy - dy;
    ctx.strokeStyle = arrowColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ax, ay);
    ctx.stroke();
    ctx.lineCap = 'butt';

    // 화살촉 (V 자)
    const angle = Math.atan2(-dy, -dx);
    const headLen = 10;
    const headWing = Math.PI / 7;
    ctx.fillStyle = arrowColor;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(
      ax - Math.cos(angle - headWing) * headLen,
      ay - Math.sin(angle - headWing) * headLen,
    );
    ctx.lineTo(
      ax - Math.cos(angle + headWing) * headLen,
      ay - Math.sin(angle + headWing) * headLen,
    );
    ctx.closePath();
    ctx.fill();

    // 세기 텍스트 (선택 — 디버그/시각 명확성)
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pct = Math.round(strength * 100);
    ctx.fillText(`${pct}%`, (sx + ax) / 2, (sy + ay) / 2 - 12);
  }

  // ============================================
  // 우측 패널
  // ============================================

  private drawPanel(state: RenderState): void {
    const ctx = this.ctx;
    const game = state.game;

    // 현재 차례 카드 (위)
    const turnCardY = 20;
    const turnCardH = 76;
    this.drawCard(PANEL_X, turnCardY, PANEL_W, turnCardH, COLORS.accentLavender);

    if (game.phase === 'ended') {
      ctx.fillStyle = '#fff';
      ctx.font = `800 16px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🏁 게임 종료', PANEL_X + PANEL_W / 2, turnCardY + turnCardH / 2);
    } else {
      const cur = game.players.find((p) => p.index === game.currentTurn);
      const isMine = cur?.peerId === state.myPeerId;
      ctx.fillStyle = '#fff';
      ctx.font = `700 13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🎯 현재 차례', PANEL_X + PANEL_W / 2, turnCardY + 22);

      ctx.font = `900 22px ${FONT}`;
      const label = isMine ? `${cur?.nickname ?? '?'} (나)` : (cur?.nickname ?? '?');
      ctx.fillText(label, PANEL_X + PANEL_W / 2, turnCardY + 50);
    }

    // 플레이어 점수 그리드 (2×2 또는 한 줄)
    const scoresY = turnCardY + turnCardH + 12;
    const cols = game.players.length <= 2 ? 1 : 2;
    const rows = Math.ceil(game.players.length / cols);
    const cellW = (PANEL_W - PANEL_PAD * (cols + 1)) / cols;
    const cellH = 56;

    for (let i = 0; i < game.players.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = PANEL_X + PANEL_PAD + col * (cellW + PANEL_PAD);
      const cy = scoresY + row * (cellH + 10);
      this.drawPlayerScoreCard(game.players[i]!, cx, cy, cellW, cellH, state.myPeerId);
    }

    // 안내 텍스트 (아래)
    const hintY = scoresY + rows * (cellH + 10) + 18;
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `500 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (state.isSpectator) {
      ctx.fillText('👀 관전 중', PANEL_X + PANEL_W / 2, hintY);
    } else if (game.phase === 'aiming') {
      const cur = game.players.find((p) => p.index === game.currentTurn);
      if (cur?.peerId === state.myPeerId) {
        ctx.fillText('자기 알을 클릭하고 드래그해서 튕겨요', PANEL_X + PANEL_W / 2, hintY);
        ctx.fillText('(반대 방향으로 발사)', PANEL_X + PANEL_W / 2, hintY + 16);
      } else {
        ctx.fillText('상대 차례 — 잠시 기다려요', PANEL_X + PANEL_W / 2, hintY);
      }
    } else if (game.phase === 'resolving') {
      ctx.fillText('굴러가는 중', PANEL_X + PANEL_W / 2, hintY);
    }
  }

  private drawPlayerScoreCard(
    p: AlgagiGame['players'][number],
    x: number, y: number, w: number, h: number,
    myPeerId: string,
  ): void {
    const ctx = this.ctx;
    const isMe = p.peerId === myPeerId;
    const isDead = p.liveCount === 0;

    // 카드 배경
    ctx.fillStyle = isDead ? '#f3eef0' : COLORS.cardBg;
    this.fillRoundRect(x, y, w, h, 10);
    ctx.strokeStyle = isMe ? COLORS.accentPink : COLORS.cardBorder;
    ctx.lineWidth = isMe ? 2 : 1;
    this.strokeRoundRect(x, y, w, h, 10);

    // 알 아이콘 (왼쪽)
    const iconX = x + 18;
    const iconY = y + h / 2;
    this.drawStoneBody(iconX, iconY, p.index);

    // 닉네임 + 알 개수
    ctx.fillStyle = isDead ? COLORS.textMuted : COLORS.textMain;
    ctx.font = `700 13px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const nickShown = p.nickname.length > 8 ? p.nickname.slice(0, 7) + '…' : p.nickname;
    ctx.fillText(nickShown + (isMe ? ' (나)' : ''), x + 38, y + 18);

    ctx.fillStyle = isDead ? COLORS.textMuted : COLORS.accentLavender;
    ctx.font = `900 18px ${FONT}`;
    if (isDead) {
      ctx.fillText('OUT', x + 38, y + 40);
    } else {
      ctx.fillText(`${p.liveCount}개`, x + 38, y + 40);
    }
  }

  // ============================================
  // 게임 종료 오버레이
  // ============================================

  private drawEndOverlay(state: RenderState): void {
    const ctx = this.ctx;

    // 보드 영역만 어둡게 (패널은 그대로 보이게)
    ctx.fillStyle = COLORS.endOverlay;
    ctx.fillRect(BOARD_CX - BOARD_HALF, BOARD_CY - BOARD_HALF, BOARD_HALF * 2, BOARD_HALF * 2);

    const winner = state.game.players.find((p) => p.peerId === state.game.winnerPeerId);
    const iWon = state.game.winnerPeerId === state.myPeerId;
    const isDraw = state.game.winnerPeerId === null;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = `900 60px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(isDraw ? '⚖️' : '🏆', BOARD_CX, BOARD_CY - 32);

    ctx.font = `900 28px ${FONT}`;
    ctx.fillStyle = iWon ? COLORS.accentPink : isDraw ? '#fff' : '#fff';
    const title = isDraw ? '무승부' : iWon ? '승리!' : `${winner?.nickname ?? '?'} 승리`;
    ctx.fillText(title, BOARD_CX, BOARD_CY + 24);
  }

  // ============================================
  // 헬퍼
  // ============================================

  private drawCard(x: number, y: number, w: number, h: number, fill: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    this.fillRoundRect(x, y, w, h, 12);
  }

  private fillRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
    ctx.fill();
  }

  private strokeRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
    ctx.stroke();
  }
}

// ============================================
// 색 유틸 — drag 세기 표시용 hex 보간
// ============================================

function lerpHex(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bch = Math.round(ab + (bb - ab) * t);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bch.toString(16).padStart(2, '0')}`;
}
