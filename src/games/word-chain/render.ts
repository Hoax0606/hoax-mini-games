/**
 * 끝말잇기 Canvas 렌더러 (끄투 참조 재설계)
 *
 * 레이아웃 (800×400 논리 좌표):
 *   ┌──────────────────────────────────────────────────────┐
 *   │ ▬▬▬▬▬▬▬▬ 타이머 가로 바 (줄어듦) ▬▬▬▬▬▬        24s   │
 *   ├───────────┬──────────────────────────┬───────────────┤
 *   │ 플레이어   │      공[원]  (이전 단어)  │  지나온 단어   │
 *   │ 세로 리스트│         ↓                │  (프로스티드)  │
 *   │ 현재차례   │      [ 원 · 역 ]  요구글자│               │
 *   │ 핑크 채움  │      두음법칙 표식        │               │
 *   └───────────┴──────────────────────────┴───────────────┘
 *
 *   HTML <input> 은 canvas 외부 하단에 별도 마운트 — index.ts 담당.
 */

import {
  type WordChainGame,
  allowedStartLetters,
  getTurnTimeMs,
} from './rules';
import { fitContain } from '../_shared/canvasFit';

const CANVAS_W = 800;
const CANVAS_H = 400;

// 3열 레이아웃 좌표
const PLX = 18;                 // 좌: 플레이어 리스트
const PLW = 176;
const HX = PLX + PLW + 16;      // 중앙: 히어로 (210)
const HW = 360;
const RX = HX + HW + 14;        // 우: 히스토리 (584)
const RW = CANVAS_W - RX - 18;  // 198

const COLORS = {
  bg: '#fff9fd',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  pink: '#ff5a92',
  pinkSoft: '#ffa8c7',
  lavender: '#9c7aeb',
  timerTrack: '#f0e8ff',

  // 프로스티드 카드(반투명)
  cardFill: 'rgba(255, 255, 255, 0.62)',
  cardLine: 'rgba(216, 199, 255, 0.7)',
  cardActiveFill: 'rgba(255, 240, 246, 0.9)',
  cardDeadFill: 'rgba(240, 236, 240, 0.5)',

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
  /** performance.now() — 타이머/애니 계산 */
  now: number;
}

export interface WordChainRendererArgs {
  canvas: HTMLCanvasElement;
}

export class WordChainRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  /** 히스토리 길이가 바뀐(=새 단어) 로컬 시각 — 등장 팝 애니용. 렌더러 자체 감지 */
  private lastHistLen = -1;
  private addAt = 0;

  constructor(args: WordChainRendererArgs) {
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

    this.drawTimerBar(state, now);
    this.drawPlayers(state);
    this.drawHero(state, now);
    this.drawHistory(state, now);

    if (state.game.phase === 'ended') {
      this.drawEndOverlay(state);
    }
  }

  // ============================================
  // 상단: 타이머 가로 바
  // ============================================

  private drawTimerBar(state: RenderState, now: number): void {
    const ctx = this.ctx;
    const game = state.game;
    const x = 20, y = 18, w = CANVAS_W - 40, h = 8;

    const turnTime = getTurnTimeMs(game.history.length);
    const elapsed = game.phase === 'aiming' ? Math.max(0, now - game.turnStartedAt) : 0;
    const remaining = Math.max(0, turnTime - elapsed);
    const ratio = game.phase === 'aiming' ? remaining / turnTime : 1;
    const sec = Math.ceil(remaining / 1000);
    const warn = game.phase === 'aiming' && sec <= 5;

    // 트랙
    this.roundRect(x, y, w, h, h / 2);
    ctx.fillStyle = COLORS.timerTrack;
    ctx.fill();
    // 진행(남은 시간)
    const fw = Math.max(h, w * ratio);
    this.roundRect(x, y, fw, h, h / 2);
    ctx.fillStyle = warn ? COLORS.pink : COLORS.pinkSoft;
    ctx.fill();
    // 남은 시간은 바 자체로 표시 — 숫자 없음
  }

  // ============================================
  // 좌: 플레이어 세로 리스트 (현재 차례 핑크 채움, 닉 전체 표시)
  // ============================================

  private drawPlayers(state: RenderState): void {
    const ctx = this.ctx;
    const game = state.game;
    const n = game.players.length;

    const top = 44, bottom = 388, gap = 6;
    const rowH = Math.min(34, Math.max(24, (bottom - top - (n - 1) * gap) / n));
    const fs = rowH < 28 ? 12 : 13;

    for (let i = 0; i < n; i++) {
      const p = game.players[i]!;
      const y = top + i * (rowH + gap);
      const active = game.phase === 'aiming' && p.index === game.currentTurn && p.alive;
      const dead = !p.alive;
      const isMe = p.peerId === state.myPeerId;

      // 행 배경 (프로스티드) — 현재 차례 = 핑크 채움
      ctx.save();
      ctx.shadowColor = active ? 'rgba(255, 90, 146, 0.25)' : 'rgba(120, 80, 140, 0.1)';
      ctx.shadowBlur = active ? 10 : 5;
      ctx.shadowOffsetY = active ? 4 : 2;
      this.roundRect(PLX, y, PLW, rowH, rowH / 2.4);
      ctx.fillStyle = active ? COLORS.pink : dead ? COLORS.cardDeadFill : COLORS.cardFill;
      ctx.fill();
      ctx.restore();
      if (!active) {
        this.roundRect(PLX, y, PLW, rowH, rowH / 2.4);
        ctx.strokeStyle = COLORS.cardLine;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 현재 차례 흰 점
      let tx = PLX + 12;
      if (active) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.beginPath();
        ctx.arc(PLX + 13, y + rowH / 2, 3.5, 0, Math.PI * 2);
        ctx.fill();
        tx = PLX + 23;
      }

      // 닉네임 (전체 표시)
      ctx.fillStyle = active ? '#fff' : dead ? COLORS.textMuted : COLORS.textMain;
      ctx.font = `800 ${fs}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.nickname + (isMe ? ' (나)' : ''), tx, y + rowH / 2);

      // 탈락 = 가로줄
      if (dead) {
        ctx.strokeStyle = COLORS.textMuted;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(tx, y + rowH / 2);
        ctx.lineTo(PLX + PLW - 12, y + rowH / 2);
        ctx.stroke();
      }
    }
  }

  // ============================================
  // 중앙: 이전 단어 → 요구 글자 (두음법칙 대안 포함)
  // ============================================

  private drawHero(state: RenderState, now: number): void {
    const ctx = this.ctx;
    const game = state.game;
    const cx = HX + HW / 2;

    const last = game.history[game.history.length - 1]!;
    const word = last.word;
    const head = word.slice(0, -1);
    const tail = word[word.length - 1]!;

    // 새 단어 등장 팝(스케일)
    const appT = prefersReducedMotion ? 1 : clamp01((now - this.addAt) / NEW_WORD_MS);

    // 이전 단어 (작게, 맥락) — 꼬리 음절 핑크
    ctx.save();
    const wordScale = 0.85 + 0.15 * easeOutBack(appT);
    ctx.translate(cx, 108);
    ctx.scale(wordScale, wordScale);
    ctx.translate(-cx, -108);
    ctx.font = `900 38px ${FONT}`;
    ctx.textBaseline = 'middle';
    const hw = ctx.measureText(head).width;
    const tw = ctx.measureText(tail).width;
    const tot = hw + tw;
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

    // 요구 글자 칩 (두음법칙이면 대안 글자 포함)
    const allowed = [...allowedStartLetters(tail)];
    const reqTxt = allowed.join(' · ');
    const chipSc = prefersReducedMotion ? 1 : 0.72 + 0.28 * easeOutBack(appT);
    ctx.font = `900 40px ${FONT}`;
    const rw = ctx.measureText(reqTxt).width;
    const chipW = Math.max(80, rw + 52);
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

    // 두음법칙 표식 (대안이 2개 이상일 때만)
    if (allowed.length > 1) {
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `700 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('두음법칙 · 둘 중 아무거나', cx, chipY + chipH + 18);
    }
  }

  // ============================================
  // 우: 지나온 단어 리스트
  // ============================================

  private drawHistory(state: RenderState, now: number): void {
    const ctx = this.ctx;
    const game = state.game;
    const y0 = 54, rowH = 30, gap = 6, maxRows = 9;
    const visible = game.history.slice(-maxRows);

    // 총 개수 (작게)
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
  // 종료 오버레이 (전체 스크림 + 중앙 결과)
  // ============================================

  private drawEndOverlay(state: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.endScrim;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const winner = state.game.players.find((p) => p.peerId === state.game.winnerPeerId);
    const iWon = state.game.winnerPeerId === state.myPeerId;
    const isDraw = state.game.winnerPeerId === null;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 56px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(isDraw ? '⚖️' : '🏆', CANVAS_W / 2, CANVAS_H / 2 - 28);

    ctx.font = `900 30px ${FONT}`;
    ctx.fillStyle = iWon ? COLORS.pink : '#fff';
    const title = isDraw ? '무승부' : iWon ? '승리!' : `${winner?.nickname ?? '?'} 승리`;
    ctx.fillText(title, CANVAS_W / 2, CANVAS_H / 2 + 26);
  }

  // ============================================
  // 헬퍼
  // ============================================

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
