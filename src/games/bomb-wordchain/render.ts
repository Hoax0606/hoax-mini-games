/**
 * 폭탄 돌리기 끝말잇기 Canvas 렌더러 (끝말잇기 재설계 참조 · apple-design)
 *
 * word-chain 렌더 레이아웃을 그대로 이식하되, 상단 "타이머 바"는 없앤다.
 * 폭탄 게임은 남은시간을 숨기는 게 핵심(언제 터질지 모름) → 정확한 카운트다운 대신
 * 우측 상단에 **폭탄 일러스트 + 도화선 스파크**로 긴장감만 준다.
 *
 * 레이아웃 (800×400 논리 좌표):
 *   ┌───────────┬──────────────────────────┬───────────────┐
 *   │ 플레이어   │      이전 단어 (꼬리 핑크) │   💣 폭탄      │
 *   │ 세로 리스트│         ↓                │  "언제 터질지" │
 *   │ 폭탄 홀더  │      [ 요구 글자 칩 ]     │  ─────────    │
 *   │ 핑크 채움  │      두음법칙 표식        │  지나온 단어   │
 *   └───────────┴──────────────────────────┴───────────────┘
 *
 * HTML <input> 은 canvas 외부 하단에 별도 마운트 — index.ts 담당.
 */

import { allowedStartLetters, type WordChainGame } from '../word-chain/rules';
import { fitContain } from '../_shared/canvasFit';

const CANVAS_W = 800;
const CANVAS_H = 400;

// 3열 레이아웃 좌표 (word-chain 과 동일)
const PLX = 18;                 // 좌: 플레이어 리스트
const PLW = 176;
const HX = PLX + PLW + 16;      // 중앙: 히어로 (210)
const HW = 360;
const RX = HX + HW + 14;        // 우: 폭탄 + 히스토리 (584)
const RW = CANVAS_W - RX - 18;  // 198

const COLORS = {
  bg: '#fff9fd',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  pink: '#ff5a92',
  pinkSoft: '#ffa8c7',
  lavender: '#9c7aeb',

  // 프로스티드 카드(반투명) — word-chain 과 동일
  cardFill: 'rgba(255, 255, 255, 0.62)',
  cardLine: 'rgba(216, 199, 255, 0.7)',
  cardActiveFill: 'rgba(255, 240, 246, 0.9)',
  cardDeadFill: 'rgba(240, 236, 240, 0.5)',

  // 폭탄
  bomb: '#3a3242',
  bombHi: '#5c5468',
  fuse: '#c99a5a',
  spark: '#ffb845',
  sparkHot: '#ff5a92',

  endScrim: 'rgba(54, 36, 56, 0.62)',
} as const;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

// ============================================
// 모션 헬퍼 (apple-design: 등장 팝 + 부드러운 전환)
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
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const NEW_WORD_MS = 320; // 새 단어 등장 / 요구 글자 칩 전환

// ============================================
// Renderer
// ============================================

export interface RenderState {
  game: WordChainGame;
  myPeerId: string;
  isSpectator: boolean;
  /** 폭발로 패배한 사람 peerId (phase==='ended' 일 때만 유효) */
  loserPeerId: string | null;
  now: number;
}

export interface BombRendererArgs {
  canvas: HTMLCanvasElement;
}

export class BombRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  /** 히스토리 길이가 바뀐(=새 단어) 로컬 시각 — 등장 팝 애니용 */
  private lastHistLen = -1;
  private addAt = 0;

  constructor(args: BombRendererArgs) {
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
    const now = state.now;

    // 새 단어 감지 → 등장 팝 시작점
    if (state.game.history.length !== this.lastHistLen) {
      this.lastHistLen = state.game.history.length;
      this.addAt = now;
    }

    fitContain(ctx, this.canvas, CANVAS_W, CANVAS_H, COLORS.bg);

    this.drawPlayers(state);
    this.drawHero(state, now);
    this.drawBombAndHistory(state, now);

    if (state.game.phase === 'ended') this.drawEndOverlay(state);
  }

  // ============================================
  // 좌: 플레이어 세로 리스트 (폭탄 홀더 = 핑크 채움 + 흰 폭탄)
  // ============================================

  private drawPlayers(state: RenderState): void {
    const ctx = this.ctx;
    const game = state.game;
    const n = game.players.length;

    const top = 24, bottom = 388, gap = 6;
    const rowH = Math.min(34, Math.max(24, (bottom - top - (n - 1) * gap) / n));
    const fs = rowH < 28 ? 12 : 13;

    for (let i = 0; i < n; i++) {
      const p = game.players[i]!;
      const y = top + i * (rowH + gap);
      const holdsBomb = game.phase === 'aiming' && p.index === game.currentTurn;
      const isLoser = game.phase === 'ended' && p.peerId === state.loserPeerId;
      const isMe = p.peerId === state.myPeerId;

      // 행 배경 (프로스티드) — 폭탄 홀더 = 핑크 채움
      ctx.save();
      ctx.shadowColor = holdsBomb ? 'rgba(255, 90, 146, 0.25)' : 'rgba(120, 80, 140, 0.1)';
      ctx.shadowBlur = holdsBomb ? 10 : 5;
      ctx.shadowOffsetY = holdsBomb ? 4 : 2;
      this.roundRect(PLX, y, PLW, rowH, rowH / 2.4);
      ctx.fillStyle = holdsBomb ? COLORS.pink : isLoser ? COLORS.cardDeadFill : COLORS.cardFill;
      ctx.fill();
      ctx.restore();
      if (!holdsBomb) {
        this.roundRect(PLX, y, PLW, rowH, rowH / 2.4);
        ctx.strokeStyle = isLoser ? 'rgba(255, 90, 146, 0.5)' : COLORS.cardLine;
        ctx.lineWidth = isLoser ? 1.4 : 1;
        ctx.stroke();
      }

      // 폭탄 홀더 표식 — 흰 폭탄 글리프
      let tx = PLX + 12;
      if (holdsBomb) {
        this.drawBombGlyph(PLX + 15, y + rowH / 2, 5, 'rgba(255,255,255,0.95)');
        tx = PLX + 28;
      }

      // 닉네임 (전체 표시)
      ctx.fillStyle = holdsBomb ? '#fff' : isLoser ? COLORS.textMuted : COLORS.textMain;
      ctx.font = `800 ${fs}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.nickname + (isMe ? ' (나)' : ''), tx, y + rowH / 2);

      // 폭발 패자 = 가로줄
      if (isLoser) {
        ctx.strokeStyle = COLORS.pink;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(tx, y + rowH / 2);
        ctx.lineTo(PLX + PLW - 12, y + rowH / 2);
        ctx.stroke();
      }
    }
  }

  // ============================================
  // 중앙: 이전 단어 → 요구 글자 (word-chain 히어로와 동일)
  // ============================================

  private drawHero(state: RenderState, now: number): void {
    const ctx = this.ctx;
    const game = state.game;
    const cx = HX + HW / 2;

    const last = game.history[game.history.length - 1]!;
    const word = last.word;
    const head = word.slice(0, -1);
    const tail = word[word.length - 1]!;

    const appT = prefersReducedMotion ? 1 : clamp01((now - this.addAt) / NEW_WORD_MS);

    // 이전 단어 (꼬리 음절 핑크) — 등장 팝
    ctx.save();
    const wordScale = 0.85 + 0.15 * easeOutBack(appT);
    ctx.translate(cx, 108);
    ctx.scale(wordScale, wordScale);
    ctx.translate(-cx, -108);
    ctx.font = `900 38px ${FONT}`;
    ctx.textBaseline = 'middle';
    const hw = ctx.measureText(head).width;
    const tot = hw + ctx.measureText(tail).width;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.textMain;
    ctx.fillText(head, cx - tot / 2, 108);
    ctx.fillStyle = COLORS.pink;
    ctx.fillText(tail, cx - tot / 2 + hw, 108);
    ctx.restore();

    // 화살표
    ctx.fillStyle = COLORS.pinkSoft;
    ctx.font = `700 20px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('↓', cx, 150);

    // 요구 글자 칩 (두음법칙이면 대안 포함) — 핑크 팝
    const allowed = [...allowedStartLetters(tail)];
    const reqTxt = allowed.join(' · ');
    const chipSc = prefersReducedMotion ? 1 : 0.72 + 0.28 * easeOutBack(appT);
    ctx.font = `900 40px ${FONT}`;
    const chipW = Math.max(80, ctx.measureText(reqTxt).width + 52);
    const chipH = 66;
    const chipX = cx - chipW / 2;
    const chipY = 182;
    ctx.save();
    ctx.translate(cx, chipY + chipH / 2);
    ctx.scale(chipSc, chipSc);
    ctx.translate(-cx, -(chipY + chipH / 2));
    ctx.save();
    ctx.shadowColor = 'rgba(255, 90, 146, 0.3)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    this.roundRect(chipX, chipY, chipW, chipH, chipH / 2);
    ctx.fillStyle = COLORS.pink;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 40px ${FONT}`;
    ctx.fillText(reqTxt, cx, chipY + chipH / 2 + 1);
    ctx.restore();

    // 두음법칙 표식
    if (allowed.length > 1) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `700 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('두음법칙 · 둘 중 아무거나', cx, chipY + chipH + 18);
    }
  }

  // ============================================
  // 우: 폭탄 일러스트 + 지나온 단어 리스트
  // ============================================

  private drawBombAndHistory(state: RenderState, now: number): void {
    const ctx = this.ctx;
    const game = state.game;
    const rcx = RX + RW / 2;

    // ── 폭탄 (약하게 두근 + 도화선 스파크) ──
    // bcy=76, r=24 → 심지/도화선/스파크가 캔버스 상단(y=0) 밖으로 안 잘리게
    const bcy = 76;
    const pulse = game.phase === 'aiming' ? 1 + Math.sin(now / 260) * 0.05 : 1;
    const r = 24 * pulse;

    ctx.save();
    ctx.shadowColor = 'rgba(58, 50, 66, 0.35)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    ctx.beginPath();
    ctx.arc(rcx, bcy, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.bomb;
    ctx.fill();
    ctx.restore();
    // 하이라이트 (재질감)
    ctx.beginPath();
    ctx.arc(rcx - r * 0.34, bcy - r * 0.34, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.bombHi;
    ctx.fill();
    // 심지 꼭지
    ctx.fillStyle = COLORS.bomb;
    ctx.fillRect(rcx - 4, bcy - r - 3, 8, 7);

    // 도화선 + 스파크 (타들어가는 연출)
    if (game.phase === 'aiming') {
      const fx = rcx + 2;
      const fy = bcy - r - 3;
      ctx.strokeStyle = COLORS.fuse;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.quadraticCurveTo(fx + 16, fy - 18, fx + 6, fy - 30);
      ctx.stroke();
      const spark = (Math.sin(now / 90) + 1) / 2;
      ctx.save();
      ctx.shadowColor = COLORS.sparkHot;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(fx + 6, fy - 30, 4 + spark * 3, 0, Math.PI * 2);
      ctx.fillStyle = spark > 0.5 ? COLORS.sparkHot : COLORS.spark;
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(game.phase === 'aiming' ? '언제 터질지 몰라요!' : '펑!', rcx, bcy + r + 8);

    // ── 지나온 단어 리스트 ──
    const y0 = 140, rowH = 30, gap = 6;
    const maxRows = Math.floor((CANVAS_H - y0 - 8) / (rowH + gap));
    const visible = game.history.slice(-maxRows);

    // 총 개수 (작게, 우측)
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${game.history.length}단어`, RX + RW, y0 - 8);

    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i]!;
      const y = y0 + i * (rowH + gap);
      const isLast = i === visible.length - 1;
      const appT = isLast && !prefersReducedMotion ? clamp01((now - this.addAt) / NEW_WORD_MS) : 1;
      const dx = (1 - appT) * 8;

      ctx.save();
      ctx.globalAlpha = appT;
      this.roundRect(RX + dx, y, RW, rowH, 10);
      ctx.fillStyle = isLast ? COLORS.cardActiveFill : COLORS.cardFill;
      ctx.fill();
      this.roundRect(RX + dx, y, RW, rowH, 10);
      ctx.strokeStyle = isLast ? 'rgba(255, 90, 146, 0.5)' : COLORS.cardLine;
      ctx.lineWidth = isLast ? 1.6 : 1;
      ctx.stroke();

      ctx.fillStyle = COLORS.textMain;
      ctx.font = `800 14px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(entry.word, RX + dx + 12, y + rowH / 2);

      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `500 10px ${FONT}`;
      ctx.textAlign = 'right';
      const author = entry.byPeerId === '' ? '시작' : entry.byNickname;
      const shown = author.length > 5 ? author.slice(0, 5) : author;
      ctx.fillText(shown, RX + dx + RW - 10, y + rowH / 2);
      ctx.restore();
    }
  }

  // ============================================
  // 종료 오버레이 (전체 스크림 + 폭발 결과)
  // ============================================

  private drawEndOverlay(state: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.endScrim;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const loser = state.game.players.find((p) => p.peerId === state.loserPeerId);
    const iLost = state.loserPeerId === state.myPeerId;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 60px ${FONT}`;
    ctx.fillStyle = '#fff';
    // 💥 는 감정/반응 이모지 — 정책상 허용(폭발 연출)
    ctx.fillText('💥', CANVAS_W / 2, CANVAS_H / 2 - 30);

    ctx.font = `900 28px ${FONT}`;
    ctx.fillStyle = iLost ? COLORS.pink : '#fff';
    const title = iLost
      ? '펑! 내가 폭탄을 들고 있었다'
      : `${loser?.nickname ?? '?'} 폭발 · 나는 살았다`;
    ctx.fillText(title, CANVAS_W / 2, CANVAS_H / 2 + 28);
  }

  // ============================================
  // 헬퍼
  // ============================================

  /** 작은 폭탄 글리프 (플레이어 리스트 홀더 표식용) */
  private drawBombGlyph(cx: number, cy: number, r: number, color: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    // 몸통
    ctx.beginPath();
    ctx.arc(cx, cy + 1, r, 0, Math.PI * 2);
    ctx.fill();
    // 도화선
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.5, cy - r * 0.5);
    ctx.quadraticCurveTo(cx + r * 1.3, cy - r * 1.2, cx + r * 0.7, cy - r * 1.8);
    ctx.stroke();
    // 스파크
    ctx.beginPath();
    ctx.arc(cx + r * 0.7, cy - r * 1.9, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}
