/**
 * 라면가게 GameModule — 조립 파일.
 *
 * 아키텍처(사과게임 미러링):
 *   손님·주문 흐름은 각 가게 로컬 랜덤(seed 동기화 없음). 매출은 로컬 권위.
 *   게임 중 트래픽은 호스트 시계 broadcast(rs:clock)뿐. 종료 시 각자 최종 매출(rs:score) →
 *   호스트가 랭킹 집계(rs:end).
 *
 * 플레이:
 *   손님이 와서 특정 토핑 조합의 라면을 주문. 빈 냄비→물→면(끓기)→ready→주문 토핑 올리기→
 *   완성 냄비 클릭 시 "주문이 맞는" 손님에게 자동 배달(매출+팁). ready 방치 시 불음→클릭 폐기.
 *   손님 인내심(숨김 아님, 링)이 0 되면 화내며 떠남(매출 0). 빨리 줄수록 팁↑.
 *
 * 시간 기준: gameTime = now - startedAt. 냄비 끓기·손님 인내심 모두 gameTime 상대값이라
 *   일시정지/시계정렬은 startedAt 한 곳(+진행 냄비 보정)만 다루면 된다.
 */

import type { GameContext, GameMessage, GameModule, GameResult } from '../types';
import { sound } from '../../core/sound';
import { type ToppingId } from './defs';
import {
  boilTimeMs, bowlMatchesOrder, servePayment,
  randomOrder, randomPatienceMs, randomSpawnGapMs,
  initialPots, initialUpgrades, nextUpgradeCost,
  MAX_POTS, MAX_SEATS, OVERCOOK_MS, FIREPOWER_MULT,
  type Pot, type Customer, type Upgrades, type UpgradeKind,
} from './rules';
import { RamenRenderer, potLayout, seatLayout, type MoneyPopup } from './render';
import { decodeEnd, decodeScore, decodeClock, encodeEnd, encodeScore, encodeClock } from './netSync';

const FINISH_GRACE_MS = 1000;
const CLOCK_INTERVAL_MS = 1000;

interface PlayerRecord {
  peerId: string;
  nickname: string;
  score: number;
}

class RamenShopGame implements GameModule {
  private ctx!: GameContext;
  private renderer!: RamenRenderer;

  private myPeerId = '';
  private myNickname = '';
  private isHost = false;
  private isSpectator = false;

  private pots: Pot[] = [];
  private upgrades: Upgrades = initialUpgrades();
  private earnings = 0;
  private servedCount = 0;
  private missedCount = 0;
  private armedTopping: ToppingId | null = null;
  private popups: MoneyPopup[] = [];

  // 손님 (로컬 랜덤)
  private customers: Customer[] = [];
  private nextCustomerId = 1;
  /** 다음 손님 입장 예정 gameTime */
  private nextSpawnGt = 800;

  /** 나 제외 플레이어 최종 매출 (호스트 집계용) */
  private otherScores = new Map<string, PlayerRecord>();

  private durationMs = 180_000;
  private startedAt = 0;
  private lastClockAt = 0;
  /** 게스트: 호스트의 첫 시계(rs:clock)를 받아 영업 개시했는지. 그 전엔 손님·타이머 정지
   *  → 카운트다운 편차와 무관하게 호스트 시작에 맞춰 공정하게 개시. 호스트는 항상 true. */
  private clockSynced = false;

  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;
  private finishTimer: number | null = null;

  private paused = false;
  private pauseStart = 0;

  private upgradeBar: HTMLDivElement | null = null;

  // ============================================
  // GameModule
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.myNickname = ctx.myNickname;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    const dur = Number(ctx.roomOptions['duration']);
    this.durationMs = (Number.isFinite(dur) && dur > 0 ? dur : 180) * 1000;

    this.clockSynced = this.isHost; // 호스트는 시계 기준이라 즉시 개시. 게스트는 첫 clock 대기.
    this.upgrades = initialUpgrades();
    this.pots = initialPots(this.upgrades.pots);

    for (const p of ctx.players) {
      if (p.peerId === this.myPeerId || p.role !== 'player') continue;
      this.otherScores.set(p.peerId, { peerId: p.peerId, nickname: p.nickname, score: 0 });
    }

    this.renderer = new RamenRenderer({ canvas: ctx.canvas });
    ctx.canvas.style.cursor = 'pointer';
    if (!this.isSpectator) {
      ctx.canvas.addEventListener('mousedown', this.onDown);
      this.mountUpgradeBar();
    }

    sound.startBgm('apple-game');

    this.startedAt = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const clk = decodeClock(msg);
    if (clk) {
      if (!this.isHost && !this.paused && !this.gameFinished) {
        const newStart = performance.now() - (this.durationMs - clk.remainMs);
        const d = this.startedAt - newStart;
        if (d !== 0) {
          for (const pot of this.pots) {
            if (pot.cookStartGt > 0) pot.cookStartGt += d;
            if (pot.readyGt > 0) pot.readyGt += d;
          }
          for (const c of this.customers) c.seatedGt += d;
        }
        this.startedAt = newStart;
        this.clockSynced = true; // 호스트 첫 신호 도착 → 영업 개시
      }
      return;
    }

    const scoreMsg = decodeScore(msg);
    if (scoreMsg) {
      if (scoreMsg.peerId === this.myPeerId) return;
      const rec = this.otherScores.get(scoreMsg.peerId);
      if (rec) rec.score = scoreMsg.score;
      return;
    }

    const end = decodeEnd(msg);
    if (end) {
      if (this.isSpectator) return;
      this.gameFinished = true;
      this.ctx.endGame(end);
      return;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.gameFinished = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.finishTimer !== null) { clearTimeout(this.finishTimer); this.finishTimer = null; }
    this.ctx?.canvas?.removeEventListener('mousedown', this.onDown);
    this.upgradeBar?.remove();
    this.upgradeBar = null;
    this.renderer?.destroy();
    sound.stopBgm();
    if (this.ctx?.canvas) this.ctx.canvas.style.cursor = '';
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.pauseStart = performance.now();
    } else if (this.pauseStart > 0) {
      this.startedAt += performance.now() - this.pauseStart;
      this.pauseStart = 0;
    }
  }

  // ============================================
  // 루프
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;
    const now = performance.now();
    const gameTime = now - this.startedAt;
    // 아직 개시 전(게스트가 호스트 clock 대기)이면 타이머는 full 로 표시(카운트 안 함)
    const remainingMs = this.clockSynced ? Math.max(0, this.durationMs - gameTime) : this.durationMs;

    if (!this.gameFinished && !this.paused && !this.isSpectator && this.clockSynced) {
      this.stepPots(gameTime);
      this.stepCustomers(gameTime);
    }

    if (this.isHost && !this.paused && !this.gameFinished && now - this.lastClockAt > CLOCK_INTERVAL_MS) {
      this.lastClockAt = now;
      this.ctx.sendToPeer(encodeClock(remainingMs));
    }

    if (!this.gameFinished && this.clockSynced && remainingMs <= 0) {
      this.gameFinished = true;
      sound.play('tetris_topout');
      if (!this.isSpectator) this.ctx.sendToPeer(encodeScore(this.myPeerId, this.earnings));
      if (this.isHost) this.finishTimer = window.setTimeout(() => this.finishGame(), FINISH_GRACE_MS);
    }

    if (this.popups.length) this.popups = this.popups.filter((p) => now - p.start < 900);

    this.renderer.render({
      pots: this.pots,
      customers: this.customers,
      seats: this.upgrades.seats,
      earnings: this.earnings,
      remainMs: remainingMs,
      totalMs: this.durationMs,
      boilMs: boilTimeMs(this.upgrades),
      armedTopping: this.armedTopping,
      isSpectator: this.isSpectator,
      gameTime,
      now,
      popups: this.popups,
      ended: this.gameFinished,
    });
  };

  /** 냄비 진행 — cooking→ready, ready 방치→overcooked */
  private stepPots(gameTime: number): void {
    const boil = boilTimeMs(this.upgrades);
    for (const pot of this.pots) {
      if (pot.state === 'cooking' && gameTime - pot.cookStartGt >= boil) {
        pot.state = 'ready';
        pot.readyGt = gameTime;
      } else if (pot.state === 'ready' && gameTime - pot.readyGt >= OVERCOOK_MS) {
        pot.state = 'overcooked';
      }
    }
  }

  /** 손님 입장(빈 좌석 채움) + 인내심 만료 처리 */
  private stepCustomers(gameTime: number): void {
    // 인내심 만료 → 떠남 (매출 0)
    for (const c of this.customers) {
      if (c.state === 'waiting' && gameTime - c.seatedGt >= c.patienceMs) {
        c.state = 'left';
        this.missedCount++;
        const s = seatLayout(this.upgrades.seats)[c.seatIndex];
        if (s) this.popups.push({ x: s.x, y: s.y, text: '떠남 😡', good: false, start: performance.now() });
        sound.play('button_click');
      }
    }
    // 떠났거나 서빙 완료한 손님 제거 (좌석 즉시 반납)
    this.customers = this.customers.filter((c) => c.state === 'waiting');

    // 빈 좌석 있고 스폰 시각 지났으면 새 손님 착석
    if (this.customers.length < this.upgrades.seats && gameTime >= this.nextSpawnGt) {
      const used = new Set(this.customers.map((c) => c.seatIndex));
      let seat = -1;
      for (let s = 0; s < this.upgrades.seats; s++) { if (!used.has(s)) { seat = s; break; } }
      if (seat >= 0) {
        this.customers.push({
          id: this.nextCustomerId++,
          order: randomOrder(),
          patienceMs: randomPatienceMs(),
          seatIndex: seat,
          seatedGt: gameTime,
          state: 'waiting',
        });
        this.nextSpawnGt = gameTime + randomSpawnGapMs();
      }
    }
  }

  // ============================================
  // 입력
  // ============================================

  private onDown = (e: MouseEvent): void => {
    if (this.gameFinished || this.paused || this.isSpectator) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
    const hit = this.renderer.hitTest(x, y, this.pots.length);
    if (!hit) return;
    if (hit.kind === 'topping') {
      this.armedTopping = this.armedTopping === hit.id ? null : hit.id;
      sound.play('button_click');
      return;
    }
    this.handlePotClick(this.pots[hit.id]!);
  };

  private handlePotClick(pot: Pot): void {
    const gameTime = performance.now() - this.startedAt;
    switch (pot.state) {
      case 'empty':
        pot.state = 'water';
        sound.play('button_click');
        break;
      case 'water':
        pot.state = 'cooking';
        pot.cookStartGt = gameTime;
        sound.play('button_click');
        break;
      case 'cooking':
        break;
      case 'ready':
        if (this.armedTopping) {
          if (!pot.toppings.includes(this.armedTopping)) pot.toppings.push(this.armedTopping);
          this.armedTopping = null;
          sound.play('pop');
        } else {
          this.serve(pot, gameTime);
        }
        break;
      case 'overcooked':
        this.pushPotPopup(pot, '불음!', false);
        this.missedCount++;
        this.resetPot(pot);
        sound.play('button_click');
        break;
    }
  }

  /** 완성 냄비 → 주문이 맞는 대기 손님에게 배달. 없으면 거절 안내. */
  private serve(pot: Pot, gameTime: number): void {
    // 주문 일치 손님 중 인내심 가장 급한(적게 남은) 사람 우선
    let target: Customer | null = null;
    let bestRemain = Infinity;
    for (const c of this.customers) {
      if (c.state !== 'waiting' || !bowlMatchesOrder(pot, c.order)) continue;
      const remain = c.patienceMs - (gameTime - c.seatedGt);
      if (remain < bestRemain) { bestRemain = remain; target = c; }
    }
    if (!target) {
      this.pushPotPopup(pot, '주문 안 맞아요', false);
      sound.play('button_click');
      return;
    }
    const remainRatio = bestRemain / target.patienceMs;
    const price = servePayment(target.order, remainRatio);
    this.earnings += price;
    this.servedCount++;
    target.state = 'served';
    this.pushPotPopup(pot, `+${price.toLocaleString()}`, true);
    this.resetPot(pot);
    sound.play('goal');
    this.refreshUpgradeBar();
  }

  private resetPot(pot: Pot): void {
    pot.state = 'empty';
    pot.toppings = [];
    pot.cookStartGt = 0;
    pot.readyGt = 0;
  }

  private pushPotPopup(pot: Pot, text: string, good: boolean): void {
    const idx = this.pots.indexOf(pot);
    const p = potLayout(this.pots.length)[idx];
    if (p) this.popups.push({ x: p.x, y: p.y - 40, text, good, start: performance.now() });
  }

  // ============================================
  // 업그레이드 바
  // ============================================

  private mountUpgradeBar(): void {
    const parent = this.ctx.canvas.parentElement;
    if (!parent) return;
    const bar = document.createElement('div');
    bar.className = 'ramen-bar';
    parent.appendChild(bar);
    this.upgradeBar = bar;
    bar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.ramen-up-btn');
      if (!btn || btn.disabled) return;
      this.buyUpgrade(btn.dataset.kind as UpgradeKind);
    });
    this.buildUpgradeButtons();
  }

  private buildUpgradeButtons(): void {
    if (!this.upgradeBar) return;
    this.upgradeBar.innerHTML =
      this.upgradeBtnHTML('pots', '🍲 냄비') +
      this.upgradeBtnHTML('firepower', '🔥 화력') +
      this.upgradeBtnHTML('seats', '🪑 좌석');
    this.refreshUpgradeBar();
  }

  private upgradeBtnHTML(kind: UpgradeKind, label: string): string {
    return `<button class="ramen-up-btn" data-kind="${kind}">
      <span class="ramen-up-name">${label}</span>
      <span class="ramen-up-cost"></span>
    </button>`;
  }

  private refreshUpgradeBar(): void {
    if (!this.upgradeBar) return;
    const kinds: UpgradeKind[] = ['pots', 'firepower', 'seats'];
    for (const kind of kinds) {
      const btn = this.upgradeBar.querySelector<HTMLButtonElement>(`.ramen-up-btn[data-kind="${kind}"]`);
      if (!btn) continue;
      const cost = nextUpgradeCost(this.upgrades, kind);
      const costEl = btn.querySelector<HTMLSpanElement>('.ramen-up-cost');
      if (cost === null) {
        if (costEl) costEl.textContent = 'MAX';
        btn.disabled = true;
        btn.classList.add('maxed');
      } else {
        if (costEl) costEl.textContent = `${cost.toLocaleString()}원`;
        btn.disabled = this.earnings < cost;
        btn.classList.remove('maxed');
      }
    }
  }

  private buyUpgrade(kind: UpgradeKind): void {
    const cost = nextUpgradeCost(this.upgrades, kind);
    if (cost === null || this.earnings < cost) return;
    this.earnings -= cost;
    if (kind === 'pots') {
      this.upgrades.pots = Math.min(MAX_POTS, this.upgrades.pots + 1);
      this.pots.push({ id: this.pots.length, state: 'empty', toppings: [], cookStartGt: 0, readyGt: 0 });
    } else if (kind === 'seats') {
      this.upgrades.seats = Math.min(MAX_SEATS, this.upgrades.seats + 1);
    } else {
      this.upgrades.firepower = Math.min(FIREPOWER_MULT.length - 1, this.upgrades.firepower + 1);
    }
    sound.play('pop');
    this.refreshUpgradeBar();
  }

  // ============================================
  // 종료 랭킹 (호스트 전용)
  // ============================================

  private finishGame(): void {
    if (!this.isHost || this.destroyed) return;
    this.finishTimer = null;
    this.gameFinished = true;

    const records: PlayerRecord[] = [
      { peerId: this.myPeerId, nickname: this.myNickname, score: this.earnings },
    ];
    for (const s of this.otherScores.values()) records.push({ ...s });

    records.sort((a, b) => b.score - a.score);
    const rankings = records.map((r, idx) => ({
      peerId: r.peerId, nickname: r.nickname, rank: idx + 1, score: r.score,
    }));
    const totalPlayers = rankings.length;
    const winnerPeerId = rankings[0]?.peerId ?? null;

    const summaryFor = (peerId: string, score: number): Record<string, unknown> => ({
      gameId: 'ramen-shop',
      myPeerId: peerId,
      rank: rankings.find((r) => r.peerId === peerId)?.rank ?? totalPlayers,
      totalPlayers,
      rankings,
      myScore: score,
    });

    for (const r of records) {
      if (r.peerId === this.myPeerId) continue;
      this.ctx.sendToPeer(
        encodeEnd({
          winner: winnerPeerId === null ? null : winnerPeerId === r.peerId ? 'me' : 'opponent',
          summary: summaryFor(r.peerId, r.score),
        }),
        { target: r.peerId },
      );
    }

    this.ctx.endGame({
      winner: winnerPeerId === null ? null : winnerPeerId === this.myPeerId ? 'me' : 'opponent',
      summary: summaryFor(this.myPeerId, this.earnings),
    });
  }
}

export function createRamenShopGame(): GameModule {
  return new RamenShopGame();
}
