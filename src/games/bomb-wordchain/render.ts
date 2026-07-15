/**
 * 폭탄 돌리기 끝말잇기 Canvas 렌더러.
 *
 * word-chain 렌더 레이아웃 재사용하되, 우측 상단 "타이머 링" 대신 **폭탄**을 그린다.
 * 폭탄 남은시간은 숨김 → 정확한 카운트다운 없이 도화선 스파크가 타들어가는 연출로 긴장감만.
 * 현재 차례(=폭탄 든 사람) 카드에 💣 강조. 종료 시 폭탄 든 1명이 패배.
 */

import { allowedStartLetters, type WordChainGame } from '../word-chain/rules';
import { fitContain } from '../_shared/canvasFit';

const CANVAS_W = 800;
const CANVAS_H = 400;
const PANEL_X = 530;
const PANEL_W = 250;

const COLORS = {
  bg: '#fff9fd',
  cardBg: '#faf5ff',
  textMain: '#4a3a4a',
  textMuted: '#8a7a8a',
  accentPink: '#ff5a92',
  playerActive: '#ff5a92',
  playerAlive: '#b89aff',
  playerDead: '#c8bccc',
  historyAlt1: '#fff5f8',
  historyAlt2: '#f0e8ff',
  bomb: '#3a3242',
  bombHi: '#5c5468',
  fuse: '#c99a5a',
  spark: '#ffb845',
  sparkHot: '#ff5a92',
  endOverlay: 'rgba(54, 36, 56, 0.72)',
} as const;

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

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
    // 균일 스케일+레터박스 (비율 유지 → 안 찌부러짐)
    fitContain(ctx, this.canvas, CANVAS_W, CANVAS_H, COLORS.bg);

    this.drawWordCenter(state);
    this.drawPlayerCards(state);
    this.drawRightPanel(state);

    if (state.game.phase === 'ended') this.drawEndOverlay(state);
  }

  // ── 좌측: 마지막 단어 + 다음 시작 글자 ──
  private drawWordCenter(state: RenderState): void {
    const ctx = this.ctx;
    const cx = PANEL_X / 2;
    const cy = 130;
    const game = state.game;
    const lastWord = game.history[game.history.length - 1]!;

    ctx.fillStyle = COLORS.textMain;
    ctx.font = `900 56px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lastWord.word, cx, cy);

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText(
      lastWord.byPeerId === '' ? '🎲 시작 단어' : `${lastWord.byNickname} 님이 냈어요`,
      cx, cy - 50,
    );

    const lastChar = lastWord.word[lastWord.word.length - 1]!;
    const allowed = [...allowedStartLetters(lastChar)];
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 16px ${FONT}`;
    ctx.fillText('▼ 다음 시작', cx, cy + 50);
    ctx.fillStyle = COLORS.accentPink;
    ctx.font = `900 40px ${FONT}`;
    ctx.fillText(allowed.join(' / '), cx, cy + 90);
  }

  // ── 좌측 하단: 플레이어 카드 (폭탄 홀더 강조) ──
  private drawPlayerCards(state: RenderState): void {
    const ctx = this.ctx;
    const game = state.game;
    const n = game.players.length;
    const cardH = 60;
    const gap = n <= 4 ? 12 : 8;
    const availW = PANEL_X - 24;
    const cardW = Math.min(110, (availW - (n - 1) * gap) / n);
    const startY = 310;
    const totalW = n * cardW + (n - 1) * gap;
    const startX = (PANEL_X - totalW) / 2;

    for (let i = 0; i < n; i++) {
      const p = game.players[i]!;
      const x = startX + i * (cardW + gap);
      const y = startY;
      const holdsBomb = game.phase === 'aiming' && p.index === game.currentTurn;
      const isMe = p.peerId === state.myPeerId;
      const isLoser = game.phase === 'ended' && p.peerId === state.loserPeerId;

      ctx.fillStyle = isLoser ? '#f3eef0' : COLORS.cardBg;
      this.fillRoundRect(x, y, cardW, cardH, 12);
      ctx.strokeStyle = isLoser ? COLORS.playerDead : holdsBomb ? COLORS.playerActive : COLORS.playerAlive;
      ctx.lineWidth = holdsBomb ? 2.5 : 1.5;
      this.strokeRoundRect(x, y, cardW, cardH, 12);

      const isNarrow = cardW < 95;
      const maxNick = isNarrow ? 4 : 6;
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `700 ${isNarrow ? 12 : 14}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const nick = p.nickname.length > maxNick ? p.nickname.slice(0, maxNick - 1) + '…' : p.nickname;
      ctx.fillText(nick + (isMe ? ' (나)' : ''), x + cardW / 2, y + 22);

      if (isLoser) {
        ctx.fillStyle = COLORS.accentPink;
        ctx.font = `800 13px ${FONT}`;
        ctx.fillText('💥 폭발', x + cardW / 2, y + 42);
      } else if (holdsBomb) {
        ctx.fillStyle = COLORS.accentPink;
        ctx.font = `800 13px ${FONT}`;
        ctx.fillText('💣 들고있음', x + cardW / 2, y + 42);
      } else {
        ctx.fillStyle = COLORS.textMuted;
        ctx.font = `500 12px ${FONT}`;
        ctx.fillText('대기', x + cardW / 2, y + 42);
      }
    }
  }

  // ── 우측 패널: 폭탄 + 히스토리 ──
  private drawRightPanel(state: RenderState): void {
    const ctx = this.ctx;
    const game = state.game;
    const cx = PANEL_X + PANEL_W / 2;
    const cy = 66;

    // 폭탄 몸통 (약하게 두근거림 — 남은시간과 무관한 연출)
    const pulse = game.phase === 'aiming' ? 1 + Math.sin(state.now / 260) * 0.05 : 1;
    const r = 26 * pulse;
    ctx.beginPath();
    ctx.arc(cx, cy + 4, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.bomb;
    ctx.fill();
    // 하이라이트
    ctx.beginPath();
    ctx.arc(cx - r * 0.35, cy + 4 - r * 0.35, r * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.bombHi;
    ctx.fill();
    // 심지 꼭지
    ctx.fillStyle = COLORS.bomb;
    ctx.fillRect(cx - 4, cy - r - 4, 8, 8);

    // 도화선 + 스파크 (타들어가는 연출)
    if (game.phase === 'aiming') {
      const fx = cx + 2;
      const fy = cy - r - 4;
      ctx.strokeStyle = COLORS.fuse;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.quadraticCurveTo(fx + 16, fy - 18, fx + 6, fy - 30);
      ctx.stroke();
      // 스파크 (깜빡)
      const spark = (Math.sin(state.now / 90) + 1) / 2;
      ctx.beginPath();
      ctx.arc(fx + 6, fy - 30, 4 + spark * 3, 0, Math.PI * 2);
      ctx.fillStyle = spark > 0.5 ? COLORS.sparkHot : COLORS.spark;
      ctx.fill();
    }

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = `700 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(game.phase === 'aiming' ? '언제 터질지 몰라요!' : '💥', cx, cy + 34);

    // 히스토리
    const histY0 = 120;
    ctx.fillStyle = COLORS.textMain;
    ctx.font = `700 14px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`📜 단어 (전체 ${game.history.length})`, PANEL_X + 10, histY0);

    const histX = PANEL_X + 10;
    const histY = histY0 + 24;
    const rowH = 28;
    const visible = game.history.slice(-8);
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i]!;
      const y = histY + i * rowH;
      ctx.fillStyle = i % 2 === 0 ? COLORS.historyAlt1 : COLORS.historyAlt2;
      this.fillRoundRect(histX, y, PANEL_W - 20, rowH - 4, 6);
      ctx.fillStyle = COLORS.textMain;
      ctx.font = `700 14px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(entry.word, histX + 10, y + (rowH - 4) / 2);
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = `500 11px ${FONT}`;
      ctx.textAlign = 'right';
      const author = entry.byPeerId === '' ? '시작' : entry.byNickname;
      const authorShown = author.length > 6 ? author.slice(0, 5) + '…' : author;
      ctx.fillText(authorShown, histX + PANEL_W - 30, y + (rowH - 4) / 2);
    }
  }

  // ── 종료 오버레이 ──
  private drawEndOverlay(state: RenderState): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.endOverlay;
    ctx.fillRect(0, 0, PANEL_X, CANVAS_H);

    const loser = state.game.players.find((p) => p.peerId === state.loserPeerId);
    const iLost = state.loserPeerId === state.myPeerId;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 60px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText('💥', PANEL_X / 2, CANVAS_H / 2 - 30);

    ctx.font = `900 26px ${FONT}`;
    ctx.fillStyle = iLost ? COLORS.accentPink : '#fff';
    const title = iLost
      ? '펑! 내가 폭탄을 들고 있었다…'
      : `${loser?.nickname ?? '?'} 폭발! 나는 살았다`;
    ctx.fillText(title, PANEL_X / 2, CANVAS_H / 2 + 28);
  }

  private fillRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }

  private strokeRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.stroke();
  }
}
