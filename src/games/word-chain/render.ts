/**
 * 끝말잇기 Canvas 렌더러
 *
 * 레이아웃 (800×400 논리 좌표):
 *   ┌──────────────────────────────┬────────────────────┐
 *   │                              │  🕒 30 (타이머 ring)│
 *   │  마지막 단어  →  ?(시작 글자) │  ─────────────────  │
 *   │  (큰 글씨)                    │  단어 히스토리      │
 *   │                              │  (최근 8개)         │
 *   ├──────────────────────────────┤                     │
 *   │  플레이어 카드 (생존/탈락)     │                     │
 *   └──────────────────────────────┴────────────────────┘
 *
 *   HTML <input> 은 canvas 외부 (parentElement) 하단에 별도 마운트 — index.ts 가 담당.
 */

import {
  type WordChainGame,
  allowedStartLetters,
  getTurnTimeMs,
} from './rules';
import { fitContain } from '../_shared/canvasFit';

const CANVAS_W = 800;
const CANVAS_H = 400;

const PANEL_X = 530;
const PANEL_W = 250;

const COLORS = {
  bg: '#fff9fd',
  cardBg: '#faf5ff',
  cardBorder: '#d9c7ff',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  accentPink: '#ff5a92',
  accentLavender: '#9c7aeb',
  accentMint: '#6ed9b3',
  timerRingBg: '#f0e8ff',
  timerRingFill: '#ff82ac',
  timerRingWarn: '#ff5a92',

  playerActive: '#ff5a92',
  playerAlive: '#b89aff',
  playerDead: '#c8bccc',

  historyAlt1: '#fff5f8',
  historyAlt2: '#f0e8ff',

  endOverlay: 'rgba(54, 36, 56, 0.7)',
} as const;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

// ============================================
// Renderer
// ============================================

export interface RenderState {
  game: WordChainGame;
  myPeerId: string;
  isSpectator: boolean;
  /** performance.now() — 타이머 ring 계산 */
  now: number;
}

export interface WordChainRendererArgs {
  canvas: HTMLCanvasElement;
}

export class WordChainRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;

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

    // 균일 스케일+레터박스 (비율 유지 → 캔버스 비율 달라도 안 찌부러짐)
    fitContain(ctx, this.canvas, CANVAS_W, CANVAS_H, COLORS.bg);

    // 좌측: 마지막 단어 + 다음 시작 글자 (큰 글씨)
    this.drawWordCenter(state);

    // 좌측 하단: 플레이어 카드들
    this.drawPlayerCards(state);

    // 우측 패널: 타이머 + 히스토리
    this.drawRightPanel(state);

    // 종료 오버레이
    if (state.game.phase === 'ended') {
      this.drawEndOverlay(state);
    }
  }

  // ============================================
  // 좌측: 마지막 단어 + 시작 글자
  // ============================================

  private drawWordCenter(state: RenderState): void {
    const ctx = this.ctx;
    const cx = (PANEL_X) / 2; // 좌측 영역 중앙
    const cy = 130;

    const game = state.game;
    const lastWord = game.history[game.history.length - 1]!;

    // 마지막 단어 — 큰 글씨
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `900 56px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lastWord.word, cx, cy);

    // 누가 냈는지 (작게, 단어 위)
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText(
      lastWord.byPeerId === '' ? '🎲 시작 단어' : `${lastWord.byNickname} 님이 냈어요`,
      cx,
      cy - 50,
    );

    // 화살표 + 다음 시작 글자 후보
    const lastChar = lastWord.word[lastWord.word.length - 1]!;
    const allowed = [...allowedStartLetters(lastChar)];

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 16px ${FONT}`;
    ctx.fillText('▼ 다음 시작', cx, cy + 50);

    ctx.fillStyle = COLORS.accentPink;
    ctx.font = `900 40px ${FONT}`;
    ctx.fillText(allowed.join(' / '), cx, cy + 90);
  }

  // ============================================
  // 좌측 하단: 플레이어 카드 (생존/탈락)
  // ============================================

  private drawPlayerCards(state: RenderState): void {
    const ctx = this.ctx;
    const game = state.game;

    // 좌측 영역(0~PANEL_X) 가로폭 안에 N 명 들어가야 함.
    // 4명까지는 cardW 110 고정. 5~6명일 땐 동적 축소.
    const n = game.players.length;
    const cardH = 60;
    const gap = n <= 4 ? 12 : 8;
    const availW = PANEL_X - 24; // 좌우 여유 12px씩
    const maxCardW = 110;
    const fitCardW = (availW - (n - 1) * gap) / n;
    const cardW = Math.min(maxCardW, fitCardW);
    const startY = 310;
    const totalW = n * cardW + (n - 1) * gap;
    const startX = (PANEL_X - totalW) / 2;

    for (let i = 0; i < n; i++) {
      const p = game.players[i]!;
      const x = startX + i * (cardW + gap);
      const y = startY;
      const isMyTurn = game.phase === 'aiming' && p.index === game.currentTurn;
      const isMe = p.peerId === state.myPeerId;

      // 카드 배경
      ctx.fillStyle = p.alive ? COLORS.cardBg : '#f3eef0';
      this.fillRoundRect(x, y, cardW, cardH, 12);

      // 외곽선
      ctx.strokeStyle = !p.alive
        ? COLORS.playerDead
        : isMyTurn
          ? COLORS.playerActive
          : COLORS.playerAlive;
      ctx.lineWidth = isMyTurn ? 2.5 : 1.5;
      this.strokeRoundRect(x, y, cardW, cardH, 12);

      // 닉네임 — 카드 폭에 맞춰 3단계(일반/좁음/아주좁음)로 축약. 10인이면 tiny.
      const tiny = cardW < 62;      // 8~10인
      const isNarrow = cardW < 95;  // 6~7인
      const maxNick = tiny ? 3 : isNarrow ? 4 : 6;
      ctx.fillStyle = p.alive ? COLORS.textMain : COLORS.textMuted;
      ctx.font = `700 ${tiny ? 11 : isNarrow ? 12 : 14}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const nick = p.nickname.length > maxNick ? p.nickname.slice(0, maxNick - 1) + '…' : p.nickname;
      ctx.fillText(nick + (isMe && !tiny ? ' (나)' : ''), x + cardW / 2, y + 22);

      // 상태 — 좁으면 이모지만(글자 넘침 방지)
      if (!p.alive) {
        ctx.fillStyle = COLORS.textMuted;
        ctx.font = `800 13px ${FONT}`;
        ctx.fillText(tiny ? '💀' : '💀 탈락', x + cardW / 2, y + 42);
      } else if (isMyTurn) {
        ctx.fillStyle = COLORS.accentPink;
        ctx.font = `800 13px ${FONT}`;
        ctx.fillText(tiny ? '🎯' : '🎯 차례', x + cardW / 2, y + 42);
      } else {
        ctx.fillStyle = COLORS.textMuted;
        ctx.font = `500 12px ${FONT}`;
        ctx.fillText(tiny ? '·' : '대기', x + cardW / 2, y + 42);
      }
    }
  }

  // ============================================
  // 우측 패널: 타이머 + 히스토리
  // ============================================

  private drawRightPanel(state: RenderState): void {
    const ctx = this.ctx;
    const game = state.game;

    // 타이머 ring (상단)
    const ringCx = PANEL_X + PANEL_W / 2;
    const ringCy = 60;
    const ringR = 36;
    const turnTime = getTurnTimeMs(game.history.length);
    const elapsed = game.phase === 'aiming' ? Math.max(0, state.now - game.turnStartedAt) : 0;
    const remaining = Math.max(0, turnTime - elapsed);
    const ratio = remaining / turnTime;
    const remainSec = Math.ceil(remaining / 1000);

    // 배경 ring
    ctx.strokeStyle = COLORS.timerRingBg;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(ringCx, ringCy, ringR, 0, Math.PI * 2);
    ctx.stroke();

    // 진행 ring (남은 시간 비율)
    if (game.phase === 'aiming') {
      ctx.strokeStyle = remainSec <= 5 ? COLORS.timerRingWarn : COLORS.timerRingFill;
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(ringCx, ringCy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // 남은 초 텍스트
    ctx.fillStyle = remainSec <= 5 && game.phase === 'aiming' ? COLORS.accentPink : COLORS.textMain;
    ctx.font = `900 22px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(remainSec), ringCx, ringCy);

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 11px ${FONT}`;
    ctx.fillText('초 남음', ringCx, ringCy + 50);

    // 히스토리 헤더
    const histY0 = 120;
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 14px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`📜 단어 (전체 ${game.history.length})`, PANEL_X + 10, histY0);

    // 최근 8개만 (오래된 것이 위, 최근 것이 아래 — 또는 반대?)
    // 채팅처럼: 오래된 위, 최근 아래.
    const histX = PANEL_X + 10;
    const histY = histY0 + 24;
    const rowH = 28;
    const maxRows = 8;
    const visible = game.history.slice(-maxRows);

    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i]!;
      const y = histY + i * rowH;

      // 줄 배경 (alt)
      ctx.fillStyle = i % 2 === 0 ? COLORS.historyAlt1 : COLORS.historyAlt2;
      this.fillRoundRect(histX, y, PANEL_W - 20, rowH - 4, 6);

      // 단어
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `700 14px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(entry.word, histX + 10, y + (rowH - 4) / 2);

      // 닉네임 (우측 작게)
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `500 11px ${FONT}`;
      ctx.textAlign = 'right';
      const author = entry.byPeerId === '' ? '시작' : entry.byNickname;
      const authorShown = author.length > 6 ? author.slice(0, 5) + '…' : author;
      ctx.fillText(authorShown, histX + PANEL_W - 30, y + (rowH - 4) / 2);
    }
    // "더 있음" 개수는 헤더의 "(N)" 총계로 이미 표시되므로 별도 안내 X
    //   (이전엔 "+N개 더" 를 히스토리 첫 줄 위에 겹쳐 그려 헤더/단어와 겹치는 문제가 있었음)
  }

  // ============================================
  // 종료 오버레이
  // ============================================

  private drawEndOverlay(state: RenderState): void {
    const ctx = this.ctx;
    // 좌측 영역만 어둡게
    ctx.fillStyle = COLORS.endOverlay;
    ctx.fillRect(0, 0, PANEL_X, CANVAS_H);

    const winner = state.game.players.find((p) => p.peerId === state.game.winnerPeerId);
    const iWon = state.game.winnerPeerId === state.myPeerId;
    const isDraw = state.game.winnerPeerId === null;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 60px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(isDraw ? '⚖️' : '🏆', PANEL_X / 2, CANVAS_H / 2 - 30);

    ctx.font = `900 28px ${FONT}`;
    ctx.fillStyle = iWon ? COLORS.accentPink : '#fff';
    const title = isDraw ? '무승부' : iWon ? '승리!' : `${winner?.nickname ?? '?'} 승리`;
    ctx.fillText(title, PANEL_X / 2, CANVAS_H / 2 + 28);
  }

  // ============================================
  // 헬퍼
  // ============================================

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
