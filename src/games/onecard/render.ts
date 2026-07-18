/**
 * 원카드 Canvas 렌더러. 논리 800×400 + 균일 레터박스(canvasFit 공용).
 *
 * 배치:
 *   상단  — 상대 플레이어들(닉/카드수/차례 하이라이트/완료 순위)
 *   중앙  — 뽑을더미(클릭 뽑기) · 버린더미 맨위 카드 · 활성색 · 방향 화살표
 *   하단  — 내 손패(클릭해서 냄). 카드 많으면 겹쳐서 표시
 *   오버레이 — 와일드 낼 때 4색 선택
 */

import { fitContain, fitScreenToLogical, type FitView } from '../_shared/canvasFit';
import { isWild, type Card, type Color } from './rules';
import type { OneCardPublic } from './netSync';

const W = 800;
const H = 400;
const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

const CARD_COLOR: Record<string, string> = {
  r: '#ff6b81', b: '#5b9be6', g: '#57c777', y: '#f2c94c', w: '#3a3242',
};
const C = {
  bg: '#fff5fb',
  cardFace: '#ffffff',
  cardBack: '#b89aff',
  text: '#4a3a4a',
  muted: '#9a8a9a',
  turnHi: '#ff5a92',
  mint: '#5cc9a2',
  frost: 'rgba(255,255,255,0.66)',
  frostLine: 'rgba(216,199,255,0.8)',
  panel: '#faf5ff',
  panelBorder: '#e0d0f0',
  drawPile: '#9c7aeb',
} as const;

/** 카드 기호 라벨 */
function cardLabel(card: Card): string {
  switch (card.kind) {
    case 'skip': return '⊘';
    case 'reverse': return '⇄';
    case 'draw2': return '+2';
    case 'wild': return '색';
    case 'wild4': return '+4';
    default: return card.kind; // 숫자
  }
}

export interface RenderState {
  pub: OneCardPublic;
  myPeerId: string;
  myHand: Card[];
  isSpectator: boolean;
  /** 와일드 색 선택 대기 중이면 그 카드 인덱스, 아니면 -1 */
  wildPickIndex: number;
  /** 내 차례 남은 시간(ms) — 손패 위 타이머 바 */
  turnRemainMs: number;
  now: number;
}

type Hit =
  | { kind: 'card'; index: number }
  | { kind: 'draw' }
  | { kind: 'color'; color: Color }
  | { kind: 'surrender' };

const SURRENDER_RECT = { x: 10, y: 372, w: 74, h: 22 };

const HAND_Y = 316;
const HAND_CARD_W = 56;
const HAND_CARD_H = 78;
const DRAW_RECT = { x: 250, y: 150, w: 66, h: 92 };
const DISCARD_RECT = { x: 400, y: 150, w: 74, h: 100 };

export class OneCardRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private view: FitView = { scale: 1, offX: 0, offY: 0 };
  /** 내 손패 카드들의 논리 사각형 (히트테스트용) */
  private handRects: { x: number; y: number; w: number; h: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 컨텍스트를 가져올 수 없어요');
    this.ctx = ctx;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
  }

  destroy(): void { this.ro.disconnect(); }

  /** 논리 좌표에서 무엇을 눌렀는지 */
  hitTest(sx: number, sy: number, state: RenderState): Hit | null {
    const { x, y } = fitScreenToLogical(this.view, sx, sy);
    // 와일드 색 선택 중이면 4색 버튼만
    if (state.wildPickIndex >= 0) {
      const btns = this.wildButtons();
      for (const b of btns) {
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { kind: 'color', color: b.color };
      }
      return null;
    }
    // 내 손패
    for (let i = this.handRects.length - 1; i >= 0; i--) {
      const r = this.handRects[i]!;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { kind: 'card', index: i };
    }
    // 뽑을더미
    if (x >= DRAW_RECT.x && x <= DRAW_RECT.x + DRAW_RECT.w && y >= DRAW_RECT.y && y <= DRAW_RECT.y + DRAW_RECT.h) {
      return { kind: 'draw' };
    }
    // 기권 버튼
    const s = SURRENDER_RECT;
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return { kind: 'surrender' };
    return null;
  }

  private wildButtons(): { color: Color; x: number; y: number; w: number; h: number }[] {
    const cols: Color[] = ['r', 'b', 'g', 'y'];
    const bw = 84, bh = 84, gap = 16;
    const total = cols.length * bw + (cols.length - 1) * gap;
    const startX = (W - total) / 2;
    const y = (H - bh) / 2;
    return cols.map((color, i) => ({ color, x: startX + i * (bw + gap), y, w: bw, h: bh }));
  }

  render(state: RenderState): void {
    const ctx = this.ctx;
    this.view = fitContain(ctx, this.canvas, W, H, C.bg);
    const pub = state.pub;

    this.drawOpponents(ctx, state);
    this.drawDrawPile(ctx, pub);
    this.drawDiscard(ctx, pub);
    this.drawDirection(ctx, pub);
    this.drawMyHand(ctx, state);
    this.drawTurnBanner(ctx, state);

    if (pub.lastAction) {
      ctx.fillStyle = C.muted;
      ctx.font = `600 13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pub.lastAction, W / 2, 286);
    }

    // 기권 버튼 (내가 아직 안 끝났고 관전 아니면)
    const iAmOut = pub.finished.includes(state.myPeerId) || pub.outPeers.includes(state.myPeerId);
    if (!state.isSpectator && pub.phase === 'playing' && !iAmOut) {
      const s = SURRENDER_RECT;
      this.roundRect(ctx, s.x, s.y, s.w, s.h, 7);
      ctx.fillStyle = '#f3e0e6';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#d99';
      ctx.stroke();
      ctx.fillStyle = '#b05068';
      ctx.font = `700 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('기권', s.x + s.w / 2, s.y + s.h / 2);
    }

    if (state.wildPickIndex >= 0) this.drawWildPicker(ctx);
    if (pub.phase === 'ended') this.drawEnd(ctx, state);
  }

  // ── 상대들 (상단 가로, 턴 순서대로 · 지금/다음 강조) ──
  private drawOpponents(ctx: CanvasRenderingContext2D, state: RenderState): void {
    const pub = state.pub;
    const len = pub.order.length;
    const myIdx = pub.order.indexOf(state.myPeerId);

    // 상대를 "내 다음부터" 진행 방향 순서로 나열 → 왼→오 = 턴 순서
    let ordered: string[];
    if (myIdx >= 0) {
      ordered = [];
      for (let c = 1; c < len; c++) {
        ordered.push(pub.order[(((myIdx + c * pub.direction) % len) + len) % len]!);
      }
    } else {
      ordered = pub.order.filter((pid) => pid !== state.myPeerId);
    }
    const n = ordered.length;
    if (n === 0) return;

    // 지금 차례 / 다음 차례(진행방향 + 완료자 건너뜀) 계산
    const fin = new Set(pub.finished);
    const stepActive = (from: number, dir: number): string => {
      let idx = from;
      for (let c = 0; c < len; c++) {
        idx = (idx + dir + len) % len;
        if (!fin.has(pub.order[idx]!)) return pub.order[idx]!;
      }
      return '';
    };
    const curPid = pub.phase === 'playing' ? pub.order[pub.currentTurn] ?? '' : '';
    const nextPid = pub.phase === 'playing' ? stepActive(pub.currentTurn, pub.direction) : '';

    const cw = Math.min(92, (W - 28) / n);
    const gap = Math.min(10, cw * 0.12);
    const cardW = cw - gap;
    const total = n * cw - gap;
    const startX = (W - total) / 2;
    const y = 14;
    const ch = 78;

    for (let i = 0; i < n; i++) {
      const pid = ordered[i]!;
      const p = pub.players.find((pp) => pp.peerId === pid);
      const x = startX + i * cw;
      const cx = x + cardW / 2;
      const isTurn = pid === curPid;
      const isNext = pid === nextPid && pid !== curPid;
      const finRank = pub.finished.indexOf(pid);
      const isOut = pub.outPeers.includes(pid);
      const done = finRank >= 0 || isOut;

      // 카드 배경 (프로스티드 / 지금=핑크 채움)
      ctx.save();
      ctx.shadowColor = isTurn ? 'rgba(255,90,146,0.28)' : 'rgba(120,80,140,0.1)';
      ctx.shadowBlur = isTurn ? 12 : 5;
      ctx.shadowOffsetY = isTurn ? 4 : 2;
      this.roundRect(ctx, x, y, cardW, ch, 14);
      ctx.fillStyle = isTurn ? C.turnHi : C.frost;
      ctx.fill();
      ctx.restore();
      if (!isTurn) {
        this.roundRect(ctx, x, y, cardW, ch, 14);
        ctx.strokeStyle = isNext ? C.mint : C.frostLine;
        ctx.lineWidth = isNext ? 2 : 1;
        ctx.stroke();
      }

      // 남은 카드 수 뱃지
      const bw = Math.min(34, cardW * 0.5);
      ctx.fillStyle = isTurn ? 'rgba(255,255,255,0.9)' : done ? C.muted : C.cardBack;
      this.roundRect(ctx, cx - bw / 2, y + 8, bw, 20, 5);
      ctx.fill();
      ctx.fillStyle = isTurn ? C.turnHi : '#fff';
      ctx.font = `800 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${pub.handCounts[pid] ?? 0}장`, cx, y + 18);

      // 닉네임 (폭 맞춰 말줄임)
      ctx.fillStyle = isTurn ? '#fff' : done ? C.muted : C.text;
      ctx.font = `${isTurn ? 800 : 600} 12px ${FONT}`;
      ctx.fillText(this.ellipsize(ctx, p?.nickname ?? '?', cardW - 10), cx, y + 42);

      // 상태 태그 (지금 / 다음만 · 완료·기권)
      ctx.font = `800 11px ${FONT}`;
      if (finRank >= 0) {
        ctx.fillStyle = C.muted;
        ctx.font = `700 11px ${FONT}`;
        ctx.fillText(`${finRank + 1}등`, cx, y + 62);
      } else if (isOut) {
        ctx.fillStyle = C.muted;
        ctx.font = `700 11px ${FONT}`;
        ctx.fillText('기권', cx, y + 62);
      } else if (isTurn) {
        ctx.fillStyle = '#fff';
        ctx.fillText('지금 차례', cx, y + 62);
      } else if (isNext) {
        ctx.fillStyle = C.mint;
        ctx.fillText('다음', cx, y + 62);
      }

      // 진행 화살표 (카드 사이)
      if (i < n - 1) {
        ctx.fillStyle = 'rgba(154,138,154,0.6)';
        ctx.font = `700 14px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('›', x + cardW + gap / 2, y + ch / 2);
      }
    }
  }

  /** 폭 맞춰 말줄임 (현재 ctx.font 기준) */
  private ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  private drawDrawPile(ctx: CanvasRenderingContext2D, pub: OneCardPublic): void {
    const r = DRAW_RECT;
    ctx.fillStyle = C.drawPile;
    this.roundRect(ctx, r.x, r.y, r.w, r.h, 9);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    this.roundRect(ctx, r.x + 5, r.y + 5, r.w - 10, r.h - 10, 7);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `800 15px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('뽑기', r.x + r.w / 2, r.y + r.h / 2 - 8);
    ctx.font = `600 11px ${FONT}`;
    ctx.fillText(`${pub.drawPileCount}장`, r.x + r.w / 2, r.y + r.h / 2 + 12);
  }

  private drawDiscard(ctx: CanvasRenderingContext2D, pub: OneCardPublic): void {
    const r = DISCARD_RECT;
    // 활성색 후광
    ctx.fillStyle = CARD_COLOR[pub.activeColor] ?? '#ccc';
    this.roundRect(ctx, r.x - 6, r.y - 6, r.w + 12, r.h + 12, 14);
    ctx.fill();
    this.drawCardFace(ctx, pub.discardTop, r.x, r.y, r.w, r.h);
  }

  private drawDirection(ctx: CanvasRenderingContext2D, pub: OneCardPublic): void {
    const bx = 560, by = 196;
    ctx.fillStyle = 'rgba(156,122,235,0.14)';
    ctx.beginPath();
    ctx.arc(bx, by, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.drawPile;
    ctx.font = `800 30px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pub.direction === 1 ? '↻' : '↺', bx, by + 1);
    ctx.fillStyle = C.muted;
    ctx.font = `700 11px ${FONT}`;
    ctx.fillText(pub.direction === 1 ? '시계 방향' : '반시계 방향', bx, by + 36);
  }

  // ── 내 손패 (하단, 클릭) ──
  private drawMyHand(ctx: CanvasRenderingContext2D, state: RenderState): void {
    this.handRects = [];
    if (state.isSpectator) {
      ctx.fillStyle = C.muted;
      ctx.font = `700 15px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('관전 중', W / 2, HAND_Y + HAND_CARD_H / 2);
      return;
    }
    const hand = state.myHand;
    const n = hand.length;
    if (n === 0) return;
    // 폭 초과 시 겹쳐서 (마지막 카드는 온전히 보이게)
    const full = n * HAND_CARD_W + (n - 1) * 6;
    const avail = W - 40;
    const step = full <= avail ? HAND_CARD_W + 6 : (avail - HAND_CARD_W) / (n - 1 || 1);
    const totalW = HAND_CARD_W + step * (n - 1);
    const startX = (W - totalW) / 2;
    const myTurn = state.pub.phase === 'playing' && state.pub.order[state.pub.currentTurn] === state.myPeerId;
    for (let i = 0; i < n; i++) {
      const x = startX + i * step;
      const y = HAND_Y;
      this.handRects.push({ x, y, w: HAND_CARD_W, h: HAND_CARD_H });
      this.drawCardFace(ctx, hand[i]!, x, y, HAND_CARD_W, HAND_CARD_H);
    }
    // 내 차례면 손패 위 "타이머 바" — 남은 시간만큼 줄어듦(빨강). 10% 이하 경고색.
    if (myTurn && state.pub.phase === 'playing') {
      const ratio = Math.max(0, Math.min(1, state.turnRemainMs / (state.pub.turnMs || 1)));
      const barY = HAND_Y - 9;
      ctx.fillStyle = '#eadff0';
      this.roundRect(ctx, startX, barY, totalW, 5, 2.5);
      ctx.fill();
      ctx.fillStyle = ratio < 0.25 ? '#e5484d' : C.turnHi;
      this.roundRect(ctx, startX, barY, totalW * ratio, 5, 2.5);
      ctx.fill();
    }
  }

  private drawTurnBanner(ctx: CanvasRenderingContext2D, state: RenderState): void {
    const pub = state.pub;
    if (pub.phase !== 'playing') return;
    const curId = pub.order[pub.currentTurn];
    const mine = curId === state.myPeerId && !state.isSpectator;
    const curNick = pub.players.find((p) => p.peerId === curId)?.nickname ?? '?';
    ctx.fillStyle = mine ? C.turnHi : C.text;
    ctx.font = `800 16px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let msg: string;
    if (pub.pendingDraw > 0) {
      msg = mine ? `누적 ${pub.pendingDraw}장` : `${curNick} · 누적 ${pub.pendingDraw}장`;
    } else {
      msg = mine ? '내 차례' : `${curNick} 차례`;
    }
    ctx.fillText(msg, W / 2, 118);
  }

  private drawWildPicker(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = 'rgba(40,30,50,0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.font = `800 18px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('색을 골라요', W / 2, H / 2 - 74);
    for (const b of this.wildButtons()) {
      ctx.fillStyle = CARD_COLOR[b.color]!;
      this.roundRect(ctx, b.x, b.y, b.w, b.h, 14);
      ctx.fill();
    }
  }

  private drawEnd(ctx: CanvasRenderingContext2D, state: RenderState): void {
    ctx.fillStyle = 'rgba(40,30,50,0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.font = `900 30px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('게임 종료!', W / 2, H / 2);
    void state;
  }

  // ── 카드 한 장 그리기 ──
  private drawCardFace(ctx: CanvasRenderingContext2D, card: Card, x: number, y: number, w: number, h: number): void {
    ctx.fillStyle = C.cardFace;
    this.roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    // 색 띠 (와일드는 4색 조각)
    if (isWild(card)) {
      const cols: Color[] = ['r', 'b', 'g', 'y'];
      cols.forEach((col, i) => {
        ctx.fillStyle = CARD_COLOR[col]!;
        ctx.beginPath();
        ctx.rect(x + 6 + (i % 2) * (w - 12) / 2, y + 6 + Math.floor(i / 2) * (h - 12) / 2, (w - 12) / 2, (h - 12) / 2);
        ctx.fill();
      });
    } else {
      ctx.fillStyle = CARD_COLOR[card.color] ?? '#ccc';
      this.roundRect(ctx, x + 5, y + 5, w - 10, h - 10, 6);
      ctx.fill();
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(74,58,74,0.3)';
    this.roundRect(ctx, x, y, w, h, 8);
    ctx.stroke();
    // 라벨
    ctx.fillStyle = '#fff';
    ctx.font = `900 ${Math.round(h * 0.32)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cardLabel(card), x + w / 2, y + h / 2);
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
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
