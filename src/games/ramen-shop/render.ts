/**
 * 라면가게 렌더러.
 *
 * 논리 좌표 800×400 고정 + 균일 스케일 + 레터박스(draw-quiz 방식) → 캔버스 비율 달라도 안 눌림.
 * 월드(냄비/토핑 타일)는 논리 좌표, HUD(타이머·매출)는 스크린 좌표에 그린다(fortress 트릭 — 레터박스에
 * 안 잘리게). 냄비 클릭/토핑 타일 히트박스도 논리 좌표라 screenToLogical 로 역변환해 판정한다.
 */

import { TOPPING_BY_ID, type ToppingId } from './defs';
import { OVERCOOK_MS, type Pot } from './rules';

const LOGICAL_W = 800;
const LOGICAL_H = 400;
const FONT = `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`;

const C = {
  bg: '#fff5ee',
  counter: '#f3d9b8',
  counterEdge: '#d9b483',
  potBody: '#8a8f99',
  potBodyDark: '#6b7079',
  potRim: '#b8bdc7',
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
};

/** 냄비 레이아웃 — 개수에 맞춰 가로 중앙 정렬. render/hitTest 공용. */
export function potLayout(count: number): { x: number; y: number; r: number }[] {
  const r = 50;
  const gap = 156;
  const y = 176;
  const out: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < count; i++) {
    const x = LOGICAL_W / 2 + (i - (count - 1) / 2) * gap;
    out.push({ x, y, r });
  }
  return out;
}

/** 토핑 타일 레이아웃 (하단 4개). render/hitTest 공용. */
export function toppingLayout(): { id: ToppingId; x: number; y: number; w: number; h: number }[] {
  const ids: ToppingId[] = ['egg', 'green', 'dumpling', 'cheese'];
  const w = 96;
  const h = 68;
  const gap = 18;
  const total = ids.length * w + (ids.length - 1) * gap;
  const startX = (LOGICAL_W - total) / 2;
  const y = 306;
  return ids.map((id, i) => ({ id, x: startX + i * (w + gap), y, w, h }));
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
  earnings: number;
  /** 남은 영업시간(ms) */
  remainMs: number;
  totalMs: number;
  /** 현재 끓는 시간(ms) — 화력 반영값. 끓기 게이지 계산용 */
  boilMs: number;
  /** 장전된 토핑 (다음 ready 클릭 시 추가). 없으면 null */
  armedTopping: ToppingId | null;
  isSpectator: boolean;
  /** 게임시간(ms) — 조리 진행/불음 판정 */
  gameTime: number;
  /** performance.now — 김/애니메이션용 */
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

  /** 스크린(CSS px, canvas 기준) → 논리 좌표 역변환 */
  screenToLogical(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.offX) / this.scale, y: (py - this.offY) / this.scale };
  }

  /** 논리 좌표 (x,y) 가 무엇을 눌렀는지 */
  hitTest(x: number, y: number, potCount: number): { kind: 'pot'; id: number } | { kind: 'topping'; id: ToppingId } | null {
    const pots = potLayout(potCount);
    for (const p of pots) {
      if (Math.hypot(x - p.x, y - p.y) <= p.r + 6) return { kind: 'pot', id: pots.indexOf(p) };
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

    // ── 레터박스 스케일 ──
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const scale = Math.min(rect.width / LOGICAL_W, rect.height / LOGICAL_H);
    this.scale = scale;
    this.offX = (rect.width - LOGICAL_W * scale) / 2;
    this.offY = (rect.height - LOGICAL_H * scale) / 2;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, this.offX * dpr, this.offY * dpr);

    // ── 월드 (논리 좌표) ──
    this.drawBackground(ctx);
    if (!state.isSpectator) {
      for (let i = 0; i < state.pots.length; i++) this.drawPot(ctx, state, i);
      this.drawToppingTiles(ctx, state);
    } else {
      this.drawSpectatorNote(ctx);
    }
    this.drawPopups(ctx, state);

    // ── HUD (스크린 좌표) ──
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawHUD(ctx, state, rect.width);
  }

  // ============================================
  // 월드
  // ============================================

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    // 조리대(카운터) — 냄비가 놓인 띠
    ctx.fillStyle = C.counter;
    ctx.fillRect(0, 226, LOGICAL_W, 60);
    ctx.fillStyle = C.counterEdge;
    ctx.fillRect(0, 226, LOGICAL_W, 6);
  }

  private drawPot(ctx: CanvasRenderingContext2D, state: RenderState, idx: number): void {
    const layout = potLayout(state.pots.length)[idx]!;
    const pot = state.pots[idx]!;
    const { x, y, r } = layout;

    // 끓기 게이지 링 (cooking)
    if (pot.state === 'cooking') {
      const ratio = Math.min(1, (state.gameTime - pot.cookStartGt) / Math.max(1, state.boilMs));
      this.drawRing(ctx, x, y, r + 10, ratio, C.ringFill);
    }
    // 불음 경고 링 (ready → overcook 카운트다운, 남은 비율)
    if (pot.state === 'ready') {
      const left = Math.max(0, 1 - (state.gameTime - pot.readyGt) / OVERCOOK_MS);
      this.drawRing(ctx, x, y, r + 10, left, left < 0.3 ? C.ringWarn : C.readyGlow);
    }

    // 냄비 손잡이
    ctx.fillStyle = C.potBodyDark;
    ctx.fillRect(x - r - 12, y - 4, 12, 8);
    ctx.fillRect(x + r, y - 4, 12, 8);

    // 냄비 몸통 (원형)
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = pot.state === 'overcooked' ? C.burnt : C.potBody;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = pot.state === 'overcooked' ? '#3d2e1f' : C.potBodyDark;
    ctx.stroke();

    // 내용물
    const ir = r - 9;
    if (pot.state === 'water') {
      this.fillCircle(ctx, x, y, ir, C.water);
    } else if (pot.state === 'cooking') {
      this.fillCircle(ctx, x, y, ir, C.cook);
      this.drawNoodleHint(ctx, x, y, ir, state.now);
      this.drawBubbles(ctx, x, y, ir, state.now);
    } else if (pot.state === 'ready') {
      this.fillCircle(ctx, x, y, ir, C.ready);
      this.drawNoodleHint(ctx, x, y, ir, 0);
      this.drawToppingDots(ctx, x, y, ir, pot.toppings);
      this.drawSteam(ctx, x, y - r, state.now);
    } else if (pot.state === 'overcooked') {
      this.fillCircle(ctx, x, y, ir, '#7a5c3a');
      ctx.fillStyle = C.textLight;
      ctx.font = `900 20px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('불음', x, y);
    }

    // 상태 라벨 (냄비 아래)
    ctx.fillStyle = C.text;
    ctx.font = `700 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(this.potHint(pot), x, y + r + 14);
  }

  private potHint(pot: Pot): string {
    switch (pot.state) {
      case 'empty': return '클릭 → 물';
      case 'water': return '클릭 → 면';
      case 'cooking': return '끓는 중…';
      case 'ready': return '클릭 → 판매!';
      case 'overcooked': return '클릭 → 버리기';
    }
  }

  private drawToppingTiles(ctx: CanvasRenderingContext2D, state: RenderState): void {
    for (const t of toppingLayout()) {
      const def = TOPPING_BY_ID[t.id];
      const armed = state.armedTopping === t.id;
      this.roundRect(ctx, t.x, t.y, t.w, t.h, 12);
      ctx.fillStyle = C.tile;
      ctx.fill();
      ctx.lineWidth = armed ? 3.5 : 2;
      ctx.strokeStyle = armed ? C.tileArmed : C.tileBorder;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `26px ${FONT}`;
      ctx.fillText(def.icon, t.x + t.w / 2, t.y + 26);
      ctx.fillStyle = C.text;
      ctx.font = `700 13px ${FONT}`;
      ctx.fillText(`${def.name} +${def.price}`, t.x + t.w / 2, t.y + t.h - 15);
    }
    // 안내
    ctx.fillStyle = '#a48b73';
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('토핑 클릭 → 장전 후 완성된 냄비 클릭 시 추가', LOGICAL_W / 2, 306 + 68 + 8);
  }

  private drawSpectatorNote(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = C.text;
    ctx.font = `800 22px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('👀 관전 중 — 각자 자기 가게를 운영해요', LOGICAL_W / 2, LOGICAL_H / 2);
  }

  private drawPopups(ctx: CanvasRenderingContext2D, state: RenderState): void {
    for (const p of state.popups) {
      const age = state.now - p.start;
      const t = Math.min(1, age / 900);
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = p.good ? C.money : C.ringWarn;
      ctx.font = `900 20px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, p.x, p.y - t * 40);
      ctx.globalAlpha = 1;
    }
  }

  // ============================================
  // HUD (스크린 좌표, CSS px)
  // ============================================

  private drawHUD(ctx: CanvasRenderingContext2D, state: RenderState, w: number): void {
    // 매출 카드 (중앙 상단)
    const cardW = 200;
    const cardH = 46;
    const cx = w / 2 - cardW / 2;
    this.roundRect(ctx, cx, 12, cardW, cardH, 14);
    ctx.fillStyle = C.hudCard;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.hudBorder;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.money;
    ctx.font = `900 24px ${FONT}`;
    ctx.fillText(`💰 ${state.earnings.toLocaleString()}원`, w / 2, 12 + cardH / 2);

    // 타이머 링 (좌측 상단)
    const ringCx = 46;
    const ringCy = 46;
    const ringR = 28;
    const ratio = state.totalMs > 0 ? Math.max(0, state.remainMs / state.totalMs) : 0;
    const remainSec = Math.ceil(state.remainMs / 1000);
    ctx.strokeStyle = C.ringBg;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(ringCx, ringCy, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = remainSec <= 10 ? C.ringWarn : C.ringFill;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(ringCx, ringCy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = remainSec <= 10 ? C.ringWarn : C.text;
    ctx.font = `900 18px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.max(0, remainSec)), ringCx, ringCy);
  }

  // ============================================
  // 그리기 헬퍼
  // ============================================

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

  private drawNoodleHint(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, now: number): void {
    // 면발 몇 가닥 (cooking 이면 살짝 흔들림)
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
      ctx.arc(dx, dy, 7, 0, Math.PI * 2);
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
