/**
 * 라이어 게임 Canvas 렌더러.
 *
 * 세로 구성: 상단 배너(라운드/페이즈/주제) → 내 역할 카드 → 힌트 피드 → 점수판.
 * phase==='result' 이면 위에 라운드 결과 오버레이.
 * 논리 좌표 = CSS 픽셀(rect 기준), devicePixelRatio 로 스케일.
 */

import type { LiarGame } from './rules';
import { HINT_PASSES } from './rules';
import type { RolePayload } from './netSync';

const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

const C = {
  bg: '#fff9fd',
  banner: '#f0e8ff',
  bannerText: '#4a3a4a',
  category: '#ffe4ee',
  categoryText: '#c93d73',
  myCardCitizen: '#e0fff4',
  myCardCitizenStroke: '#86e8c4',
  myCardLiar: '#ffe4ee',
  myCardLiarStroke: '#ff5a92',
  cardText: '#4a3a4a',
  muted: '#8a7a8a',
  hintName: '#7a5fc7',
  hintText: '#4a3a4a',
  hintBubble: '#f6f2fb',
  turnHi: '#ff5a92',
  chip: '#ffffff',
  chipStroke: '#ffc9dd',
  chipMe: '#ffe4ee',
  liarMark: '#ff5a92',
  overlay: 'rgba(54,36,56,0.72)',
  accent: '#ff5a92',
  win: '#86e8c4',
} as const;

export interface RenderState {
  game: LiarGame;
  myPeerId: string;
  isSpectator: boolean;
  /** 내 역할/제시어 (lg:role 로 받음). 없으면 아직 배정 전/관전자 */
  myRole: RolePayload | null;
  /** 결과 페이즈 투표 내역 (lg:reveal). 없으면 미공개 */
  revealVotes: Record<string, string> | null;
  now: number;
}

export interface LiarRendererArgs {
  canvas: HTMLCanvasElement;
}

export class LiarRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;

  constructor(args: LiarRendererArgs) {
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
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = rect.width;
    const H = rect.height;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    const pad = 18;
    const g = state.game;

    // ---- 상단 배너 ----
    const bannerH = 42;
    this.roundRect(pad, pad, W - pad * 2, bannerH, 12);
    ctx.fillStyle = C.banner;
    ctx.fill();
    // 좌: 라운드
    ctx.fillStyle = C.bannerText;
    ctx.font = `800 15px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`라운드 ${g.round}/${g.totalRounds}`, pad + 14, pad + bannerH / 2);
    // 우: 주제 pill
    if (g.category) {
      ctx.font = `700 13px ${FONT}`;
      const label = `주제: ${g.category}`;
      const tw = ctx.measureText(label).width;
      const pillW = tw + 22;
      const pillX = W - pad - 14 - pillW;
      this.roundRect(pillX, pad + 8, pillW, bannerH - 16, 999);
      ctx.fillStyle = C.category;
      ctx.fill();
      ctx.fillStyle = C.categoryText;
      ctx.textAlign = 'left';
      ctx.fillText(label, pillX + 11, pad + bannerH / 2);
    }
    // 중앙: 페이즈 안내
    ctx.fillStyle = C.bannerText;
    ctx.font = `700 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(this.phaseText(state), W / 2, pad + bannerH / 2);

    let y = pad + bannerH + 12;

    // ---- 내 역할 카드 (관전자는 생략) ----
    if (!state.isSpectator && state.myRole) {
      const cardH = 58;
      const isLiar = state.myRole.role === 'liar';
      this.roundRect(pad, y, W - pad * 2, cardH, 12);
      ctx.fillStyle = isLiar ? C.myCardLiar : C.myCardCitizen;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = isLiar ? C.myCardLiarStroke : C.myCardCitizenStroke;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (isLiar) {
        ctx.fillStyle = C.liarMark;
        ctx.font = `800 18px ${FONT}`;
        ctx.fillText(`🤥 당신은 라이어! · 주제 "${state.myRole.category}"`, W / 2, y + cardH / 2);
      } else {
        ctx.fillStyle = C.cardText;
        ctx.font = `500 13px ${FONT}`;
        ctx.fillText('내 제시어', W / 2, y + 18);
        ctx.font = `800 22px ${FONT}`;
        ctx.fillText(state.myRole.word, W / 2, y + 39);
      }
      y += cardH + 12;
    }

    // ---- 점수판 (하단) ----
    const chipH = 46;
    const chipY = H - pad - chipH;
    this.drawScoreboard(state, pad, chipY, W - pad * 2, chipH);

    // ---- 힌트 피드 (배너~점수판 사이) ----
    this.drawHintFeed(state, pad, y, W - pad * 2, chipY - 12 - y);

    // ---- 결과 오버레이 ----
    if (g.phase === 'result') this.drawResultOverlay(state, W, H);
  }

  private phaseText(state: RenderState): string {
    const g = state.game;
    const nick = (pid: string): string => g.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    switch (g.phase) {
      case 'hint': {
        const cur = g.order[g.hintIndex];
        const mine = cur === state.myPeerId && !state.isSpectator;
        const who = mine ? '내 차례!' : `${nick(cur ?? '')} 차례`;
        return `💬 설명 ${g.hintPass}/${HINT_PASSES}바퀴 · ${who}`;
      }
      case 'vote':
        return '🗳️ 라이어를 지목하세요';
      case 'guess': {
        const acc = g.accusedPeerId ? nick(g.accusedPeerId) : '?';
        return `🎯 ${acc} 지목! 라이어가 제시어 추측 중…`;
      }
      case 'result':
        return '📢 라운드 결과';
      default:
        return '';
    }
  }

  private drawHintFeed(state: RenderState, x: number, y: number, w: number, h: number): void {
    if (h < 30) return;
    const ctx = this.ctx;
    const g = state.game;
    ctx.textBaseline = 'middle';
    const rowH = 26;
    const maxRows = Math.floor(h / rowH);
    const shown = g.hints.slice(-maxRows);
    let ry = y + rowH / 2;
    for (const hint of shown) {
      const isMe = hint.peerId === state.myPeerId;
      ctx.textAlign = 'left';
      ctx.font = `700 12px ${FONT}`;
      ctx.fillStyle = isMe ? C.accent : C.hintName;
      ctx.fillText(hint.nickname, x + 8, ry);
      ctx.font = `500 13px ${FONT}`;
      ctx.fillStyle = C.hintText;
      ctx.fillText(hint.text, x + 78, ry);
      ry += rowH;
    }
    if (g.hints.length === 0 && g.phase === 'hint') {
      ctx.textAlign = 'center';
      ctx.fillStyle = C.muted;
      ctx.font = `500 13px ${FONT}`;
      ctx.fillText('첫 설명을 기다리는 중…', x + w / 2, y + h / 2);
    }
  }

  private drawScoreboard(state: RenderState, x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    const g = state.game;
    const n = g.players.length;
    if (n === 0) return;
    const gap = 8;
    const chipW = (w - gap * (n - 1)) / n;
    const revealed = g.phase === 'result' && g.revealedLiarPeerId;
    for (let i = 0; i < n; i++) {
      const p = g.players[i]!;
      const cx = x + i * (chipW + gap);
      const isMe = p.peerId === state.myPeerId;
      const isTurn = g.phase === 'hint' && g.order[g.hintIndex] === p.peerId;
      const isLiar = revealed && p.peerId === g.revealedLiarPeerId;
      this.roundRect(cx, y, chipW, h, 10);
      ctx.fillStyle = isLiar ? C.myCardLiar : isMe ? C.chipMe : C.chip;
      ctx.fill();
      ctx.lineWidth = isTurn ? 2.5 : 1.5;
      ctx.strokeStyle = isTurn ? C.turnHi : isLiar ? C.liarMark : C.chipStroke;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = C.cardText;
      ctx.font = `700 12px ${FONT}`;
      ctx.fillText((isLiar ? '🤥 ' : '') + p.nickname + (isMe ? ' (나)' : ''), cx + chipW / 2, y + 15);
      ctx.font = `800 15px ${FONT}`;
      ctx.fillStyle = C.accent;
      ctx.fillText(`${g.scores[p.peerId] ?? 0}점`, cx + chipW / 2, y + 33);
    }
  }

  private drawResultOverlay(state: RenderState, W: number, H: number): void {
    const ctx = this.ctx;
    const g = state.game;
    ctx.fillStyle = C.overlay;
    ctx.fillRect(0, 0, W, H);
    const nick = (pid: string | null): string =>
      g.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = `800 20px ${FONT}`;
    ctx.fillText(`라이어는 ${nick(g.revealedLiarPeerId)} 였습니다!`, W / 2, H / 2 - 40);

    ctx.font = `700 16px ${FONT}`;
    ctx.fillStyle = g.liarWon ? C.liarMark : C.win;
    let line: string;
    if (g.liarWon === null) line = '';
    else if (g.liarWon) {
      line = g.liarGuess ? `라이어 역전승! (제시어 "${g.liarGuess}" 정답)` : '라이어 승리! (안 들킴)';
    } else {
      line = '시민 승리! 라이어를 잡았어요';
    }
    ctx.fillText(line, W / 2, H / 2);

    ctx.font = `500 13px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const next = g.round >= g.totalRounds ? '최종 결과로…' : '다음 라운드 준비 중…';
    ctx.fillText(next, W / 2, H / 2 + 36);
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
