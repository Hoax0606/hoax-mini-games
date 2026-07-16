/**
 * 라면가게 렌더러.
 *
 * 논리 좌표 800×400 고정 + 균일 스케일 + 레터박스(draw-quiz 방식). 월드(손님/냄비/토핑 타일)는
 * 논리 좌표, HUD(타이머·매출)는 스크린 좌표(fortress 트릭 — 레터박스 안 잘림).
 * 냄비/토핑 히트박스는 논리 좌표라 screenToLogical 로 역변환해 판정한다. 손님은 클릭 대상 아님
 * (완성 냄비를 클릭하면 주문 맞는 손님에게 자동 배달).
 */

import { TOPPING_BY_ID, type ToppingId } from './defs';
import { OVERCOOK_MS, type Customer, type Pot } from './rules';

const LOGICAL_W = 800;
const LOGICAL_H = 400;
const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

const C = {
  bg: '#fff5ee',
  counter: '#f3d9b8',
  counterEdge: '#d9b483',
  seatEmpty: '#e8dccb',
  custBody: '#ffd9a8',
  custBodyStroke: '#d9a86a',
  bubble: '#ffffff',
  bubbleBorder: '#e3d3c0',
  potBody: '#8a8f99',
  potBodyDark: '#6b7079',
  water: '#8fd0ee',
  cook: '#e8b96a',
  ready: '#f0c674',
  readyGlow: '#ffe9a8',
  burnt: '#5c4632',
  noodle: '#f6e6b8',
  ringBg: '#e7dccd',
  ringFill: '#ff82ac',
  ringWarn: '#ff5a92',
  tile: '#ffffff',
  tileBorder: '#e3d3c0',
  tileArmed: '#ff6b9e',
  text: '#5a4636',
  textLight: '#fffaf3',
  money: '#2e9e6b',
  hudCard: 'rgba(255,255,255,0.92)',
  hudBorder: '#f0c9a8',
} as const;

/** 손님 좌석 레이아웃 — 상단 가로 정렬(HUD 아래). render/index(팝업) 공용. */
export function seatLayout(seats: number): { x: number; y: number; r: number }[] {
  const r = 28;
  const y = 116;
  // 인원 많으면 간격 좁혀 화면 안에 (양끝 여백 60)
  const gap = Math.min(150, (LOGICAL_W - 120) / Math.max(1, seats));
  const out: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < seats; i++) {
    const x = LOGICAL_W / 2 + (i - (seats - 1) / 2) * gap;
    out.push({ x, y, r });
  }
  return out;
}

/** 냄비 레이아웃 — 중앙 가로 정렬. render/hitTest 공용. */
export function potLayout(count: number): { x: number; y: number; r: number }[] {
  const r = 44;
  const gap = Math.min(150, (LOGICAL_W - 120) / Math.max(1, count));
  const y = 226;
  const out: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < count; i++) {
    const x = LOGICAL_W / 2 + (i - (count - 1) / 2) * gap;
    out.push({ x, y, r });
  }
  return out;
}

/** 토핑 타일 레이아웃 (하단 7개). render/hitTest 공용. */
export function toppingLayout(): { id: ToppingId; x: number; y: number; w: number; h: number }[] {
  const ids: ToppingId[] = ['egg', 'green', 'dumpling', 'cheese', 'kimchi', 'sprout', 'shrimp'];
  const gap = 8;
  const margin = 24;
  const w = (LOGICAL_W - margin * 2 - gap * (ids.length - 1)) / ids.length;
  const h = 58;
  const y = 328;
  return ids.map((id, i) => ({ id, x: margin + i * (w + gap), y, w, h }));
}

export interface MoneyPopup {
  x: number;
  y: number;
  text: string;
  good: boolean;
  start: number;
}

export interface RenderState {
  pots: Pot[];
  customers: Customer[];
  seats: number;
  earnings: number;
  remainMs: number;
  totalMs: number;
  boilMs: number;
  armedTopping: ToppingId | null;
  isSpectator: boolean;
  gameTime: number;
  now: number;
  popups: MoneyPopup[];
  ended: boolean;
}

export interface RamenRendererArgs {
  canvas: HTMLCanvasElement;
}

export class RamenRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private scale = 1;
  private offX = 0;
  private offY = 0;

  constructor(args: RamenRendererArgs) {
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

  screenToLogical(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.offX) / this.scale, y: (py - this.offY) / this.scale };
  }

  hitTest(x: number, y: number, potCount: number): { kind: 'pot'; id: number } | { kind: 'topping'; id: ToppingId } | null {
    const pots = potLayout(potCount);
    for (let i = 0; i < pots.length; i++) {
      const p = pots[i]!;
      if (Math.hypot(x - p.x, y - p.y) <= p.r + 6) return { kind: 'pot', id: i };
    }
    for (const t of toppingLayout()) {
      if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return { kind: 'topping', id: t.id };
    }
    return null;
  }

  render(state: RenderState): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const scale = Math.min(rect.width / LOGICAL_W, rect.height / LOGICAL_H);
    this.scale = scale;
    this.offX = (rect.width - LOGICAL_W * scale) / 2;
    this.offY = (rect.height - LOGICAL_H * scale) / 2;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, this.offX * dpr, this.offY * dpr);

    this.drawBackground(ctx);
    this.drawSeats(ctx, state);
    if (!state.isSpectator) {
      for (let i = 0; i < state.pots.length; i++) this.drawPot(ctx, state, i);
      this.drawToppingTiles(ctx, state);
    } else {
      ctx.fillStyle = C.text;
      ctx.font = `800 20px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('👀 관전 중 — 각자 자기 가게를 운영해요', LOGICAL_W / 2, 268);
    }
    this.drawPopups(ctx, state);
    // HUD 도 논리 좌표에 그린다(모든 요소가 함께 스케일 → 해상도 달라도 안 겹침/안 잘림).
    // 좌측 상단 매출 / 우측 상단 타이머 → 중앙 상단(손님 주문 말풍선)과 안 겹침.
    this.drawHUD(ctx, state);
  }

  // ── 배경 ──
  private drawBackground(ctx: CanvasRenderingContext2D): void {
    // 손님 카운터(좌석 아래 띠)
    ctx.fillStyle = C.counter;
    ctx.fillRect(0, 150, LOGICAL_W, 12);
    ctx.fillStyle = C.counterEdge;
    ctx.fillRect(0, 150, LOGICAL_W, 4);
    // 조리대(냄비 아래 띠)
    ctx.fillStyle = C.counter;
    ctx.fillRect(0, 268, LOGICAL_W, 34);
    ctx.fillStyle = C.counterEdge;
    ctx.fillRect(0, 268, LOGICAL_W, 5);
  }

  // ── 손님 좌석 ──
  private drawSeats(ctx: CanvasRenderingContext2D, state: RenderState): void {
    const seats = seatLayout(state.seats);
    const bySeat = new Map<number, Customer>();
    for (const c of state.customers) if (c.state === 'waiting') bySeat.set(c.seatIndex, c);

    for (let i = 0; i < seats.length; i++) {
      const s = seats[i]!;
      const cust = bySeat.get(i);
      if (!cust) {
        // 빈 좌석 — 점선 동그라미
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = C.seatEmpty;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      // 인내심 링
      const remain = Math.max(0, cust.patienceMs - (state.gameTime - cust.seatedGt));
      const ratio = remain / cust.patienceMs;
      this.drawRing(ctx, s.x, s.y, s.r + 6, ratio, ratio < 0.3 ? C.ringWarn : C.ringFill);

      // 손님 머리(단순 원)
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = C.custBody;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = C.custBodyStroke;
      ctx.stroke();
      // 표정 (인내심 낮으면 찡그림)
      ctx.fillStyle = C.text;
      ctx.font = `18px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ratio < 0.3 ? '😣' : '🙂', s.x, s.y + 1);

      // 주문 말풍선 (좌석 위)
      this.drawOrderBubble(ctx, s.x, s.y - s.r - 26, cust);
    }
  }

  private drawOrderBubble(ctx: CanvasRenderingContext2D, cx: number, cy: number, cust: Customer): void {
    const toppings = cust.order.toppings;
    const icons = toppings.length === 0 ? ['🍜'] : toppings.map((t) => TOPPING_BY_ID[t].icon);
    const label = toppings.length === 0 ? '기본' : '';
    const iconStr = icons.join(' ');
    ctx.font = `18px ${FONT}`;
    const w = Math.max(52, ctx.measureText(iconStr + label).width + 22);
    const h = 30;
    this.roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 9);
    ctx.fillStyle = C.bubble;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = C.bubbleBorder;
    ctx.stroke();
    // 말풍선 꼬리
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy + h / 2 - 1);
    ctx.lineTo(cx + 5, cy + h / 2 - 1);
    ctx.lineTo(cx, cy + h / 2 + 7);
    ctx.closePath();
    ctx.fillStyle = C.bubble;
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (toppings.length === 0) {
      ctx.font = `700 14px ${FONT}`;
      ctx.fillStyle = C.text;
      ctx.fillText('🍜 기본', cx, cy);
    } else {
      ctx.font = `18px ${FONT}`;
      ctx.fillText(iconStr, cx, cy);
    }
  }

  // ── 냄비 ──
  private drawPot(ctx: CanvasRenderingContext2D, state: RenderState, idx: number): void {
    const layout = potLayout(state.pots.length)[idx]!;
    const pot = state.pots[idx]!;
    const { x, y, r } = layout;

    if (pot.state === 'cooking') {
      const ratio = Math.min(1, (state.gameTime - pot.cookStartGt) / Math.max(1, state.boilMs));
      this.drawRing(ctx, x, y, r + 9, ratio, C.ringFill);
    }
    if (pot.state === 'ready') {
      const left = Math.max(0, 1 - (state.gameTime - pot.readyGt) / OVERCOOK_MS);
      this.drawRing(ctx, x, y, r + 9, left, left < 0.3 ? C.ringWarn : C.readyGlow);
    }

    ctx.fillStyle = C.potBodyDark;
    ctx.fillRect(x - r - 11, y - 4, 11, 8);
    ctx.fillRect(x + r, y - 4, 11, 8);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = pot.state === 'overcooked' ? C.burnt : C.potBody;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = pot.state === 'overcooked' ? '#3d2e1f' : C.potBodyDark;
    ctx.stroke();

    const ir = r - 8;
    if (pot.state === 'water') {
      this.fillCircle(ctx, x, y, ir, C.water);
    } else if (pot.state === 'cooking') {
      this.fillCircle(ctx, x, y, ir, C.cook);
      this.drawNoodle(ctx, x, y, ir, state.now);
      this.drawBubbles(ctx, x, y, ir, state.now);
    } else if (pot.state === 'ready') {
      this.fillCircle(ctx, x, y, ir, C.ready);
      this.drawNoodle(ctx, x, y, ir, 0);
      this.drawToppingDots(ctx, x, y, ir, pot.toppings);
      this.drawSteam(ctx, x, y - r, state.now);
    } else if (pot.state === 'overcooked') {
      this.fillCircle(ctx, x, y, ir, '#7a5c3a');
      ctx.fillStyle = C.textLight;
      ctx.font = `900 18px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('불음', x, y);
    }

    ctx.fillStyle = C.text;
    ctx.font = `700 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(this.potHint(pot), x, y + r + 12);
  }

  private potHint(pot: Pot): string {
    switch (pot.state) {
      case 'empty': return '클릭 → 물';
      case 'water': return '클릭 → 면';
      case 'cooking': return '끓는 중';
      case 'ready': return '토핑 후 배달';
      case 'overcooked': return '클릭 → 버리기';
    }
  }

  private drawToppingTiles(ctx: CanvasRenderingContext2D, state: RenderState): void {
    for (const t of toppingLayout()) {
      const def = TOPPING_BY_ID[t.id];
      const armed = state.armedTopping === t.id;
      this.roundRect(ctx, t.x, t.y, t.w, t.h, 10);
      ctx.fillStyle = C.tile;
      ctx.fill();
      ctx.lineWidth = armed ? 3.5 : 2;
      ctx.strokeStyle = armed ? C.tileArmed : C.tileBorder;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `24px ${FONT}`;
      ctx.fillText(def.icon, t.x + t.w / 2, t.y + 22);
      ctx.fillStyle = C.text;
      ctx.font = `700 12px ${FONT}`;
      ctx.fillText(`${def.name} +${def.price}`, t.x + t.w / 2, t.y + t.h - 13);
    }
  }

  private drawPopups(ctx: CanvasRenderingContext2D, state: RenderState): void {
    for (const p of state.popups) {
      const t = Math.min(1, (state.now - p.start) / 900);
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = p.good ? C.money : C.ringWarn;
      ctx.font = `900 18px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, p.x, p.y - t * 34);
      ctx.globalAlpha = 1;
    }
  }

  // ── HUD (논리 좌표, 좌상단 매출 / 우상단 타이머 — 중앙 상단 말풍선과 안 겹침) ──
  private drawHUD(ctx: CanvasRenderingContext2D, state: RenderState): void {
    // 매출 카드 (좌상단)
    const cardW = 176;
    const cardH = 34;
    this.roundRect(ctx, 12, 8, cardW, cardH, 12);
    ctx.fillStyle = C.hudCard;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.hudBorder;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.money;
    ctx.font = `900 20px ${FONT}`;
    ctx.fillText(`💰 ${state.earnings.toLocaleString()}원`, 24, 8 + cardH / 2);

    // 타이머 링 (우상단)
    const rcx = LOGICAL_W - 40;
    const rcy = 32;
    const rr = 22;
    const ratio = state.totalMs > 0 ? Math.max(0, state.remainMs / state.totalMs) : 0;
    const remainSec = Math.ceil(state.remainMs / 1000);
    ctx.strokeStyle = C.ringBg;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(rcx, rcy, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = remainSec <= 10 ? C.ringWarn : C.ringFill;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(rcx, rcy, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = remainSec <= 10 ? C.ringWarn : C.text;
    ctx.font = `900 15px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.max(0, remainSec)), rcx, rcy);
  }

  // ── 그리기 헬퍼 ──
  private drawRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, ratio: number, color: string): void {
    ctx.strokeStyle = C.ringBg;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, ratio)));
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  private fillCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  private drawNoodle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, now: number): void {
    ctx.strokeStyle = C.noodle;
    ctx.lineWidth = 2.5;
    const wobble = now ? Math.sin(now / 160) * 2 : 0;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * 6, y - r * 0.5);
      ctx.quadraticCurveTo(x + i * 6 + wobble, y, x + i * 6, y + r * 0.5);
      ctx.stroke();
    }
  }

  private drawBubbles(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, now: number): void {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 4; i++) {
      const ph = (now / 600 + i * 0.27) % 1;
      const bx = x + Math.sin(i * 2.1) * r * 0.5;
      const by = y + r * 0.4 - ph * r * 0.9;
      ctx.beginPath();
      ctx.arc(bx, by, 2 + (1 - ph) * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawToppingDots(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, toppings: ToppingId[]): void {
    toppings.forEach((tid, i) => {
      const ang = -Math.PI / 2 + (i - (toppings.length - 1) / 2) * 0.7;
      const dx = x + Math.cos(ang) * r * 0.5;
      const dy = y + Math.sin(ang) * r * 0.5;
      ctx.beginPath();
      ctx.arc(dx, dy, 6, 0, Math.PI * 2);
      ctx.fillStyle = TOPPING_BY_ID[tid].color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(90,70,54,0.4)';
      ctx.stroke();
    });
  }

  private drawSteam(ctx: CanvasRenderingContext2D, x: number, topY: number, now: number): void {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3;
    for (let i = -1; i <= 1; i++) {
      const ph = (now / 700 + i * 0.3) % 1;
      const sx = x + i * 12;
      ctx.globalAlpha = 0.6 * (1 - ph);
      ctx.beginPath();
      ctx.moveTo(sx, topY - ph * 14);
      ctx.quadraticCurveTo(sx + Math.sin(now / 300 + i) * 6, topY - 10 - ph * 14, sx, topY - 22 - ph * 14);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
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
