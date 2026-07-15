/**
 * 라면가게 GameModule — 조립 파일.
 *
 * 아키텍처(사과게임 미러링, 단 seed 없음):
 *   손님·주문·랜덤이 없어 모두 동일한 빈 가게에서 시작 → 초기 동기화 불필요.
 *   각자 로컬에서 냄비를 돌려 라면을 만들어 팔고(매출 로컬 권위), 영업 종료 시점에만
 *   자기 최종 매출을 1회 broadcast → 호스트가 랭킹 집계(rs:end).
 *
 * 시간 기준: gameTime = now - startedAt(단일 기준). 냄비 끓기/불음 판정 모두 gameTime 상대값이라
 *   일시정지는 startedAt 한 곳만 보정하면 된다.
 *
 * 조리 루프(클릭): 빈 냄비→물→면(끓기 시작)→ready→클릭 판매. ready 방치 시 불음→클릭 폐기.
 *   토핑: 하단 타일 클릭해 "장전" → 다음 ready 냄비 클릭 시 토핑 추가(매출↑).
 */

import type { GameContext, GameMessage, GameModule, GameResult } from '../types';
import { sound } from '../../core/sound';
import { TOPPING_BY_ID, type ToppingId } from './defs';
import {
  boilTimeMs, bowlPrice, initialPots, initialUpgrades, nextUpgradeCost,
  MAX_POTS, OVERCOOK_MS, FIREPOWER_MULT,
  type Pot, type Upgrades, type UpgradeKind,
} from './rules';
import { RamenRenderer, potLayout, type MoneyPopup } from './render';
import { decodeEnd, decodeScore, decodeClock, encodeEnd, encodeScore, encodeClock } from './netSync';

/** 타이머 만료 후 호스트가 게스트 최종 매출 받기까지 기다리는 grace(ms) */
const FINISH_GRACE_MS = 1000;
/** 호스트 시계 broadcast 간격(ms) */
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

  /** 나 제외 플레이어 최종 매출 (호스트 집계용) */
  private otherScores = new Map<string, PlayerRecord>();

  private durationMs = 180_000;
  private startedAt = 0;
  /** 호스트: 마지막 시계 broadcast 시각 */
  private lastClockAt = 0;

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

    // 영업시간 옵션 (초 단위 문자열). 기본 3분.
    const dur = Number(ctx.roomOptions['duration']);
    this.durationMs = (Number.isFinite(dur) && dur > 0 ? dur : 180) * 1000;

    this.upgrades = initialUpgrades();
    this.pots = initialPots(this.upgrades.pots);

    // 나 제외 플레이어(role='player')만 랭킹 대상으로 초기화. 관전자 제외.
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

    sound.startBgm('apple-game'); // 밝고 느긋한 BGM 재활용

    this.startedAt = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const clk = decodeClock(msg);
    if (clk) {
      // 게스트: 자기 startedAt 을 호스트 남은시간에 맞춤 → 로드/카운트다운 편차 보정(공정).
      if (!this.isHost && !this.paused && !this.gameFinished) {
        const newStart = performance.now() - (this.durationMs - clk.remainMs);
        // 냄비 타이머는 gameTime(=now-startedAt) 기준이라 startedAt 이 바뀌면 같이 밀어줘야
        //   진행 중 냄비가 튀지 않는다. (보통 첫 정렬은 냄비 비었을 때라 영향 미미, 방어적 보정)
        const d = this.startedAt - newStart;
        if (d !== 0) {
          for (const pot of this.pots) {
            if (pot.cookStartGt > 0) pot.cookStartGt += d;
            if (pot.readyGt > 0) pot.readyGt += d;
          }
        }
        this.startedAt = newStart;
      }
      return;
    }

    const scoreMsg = decodeScore(msg);
    if (scoreMsg) {
      if (scoreMsg.peerId === this.myPeerId) return;
      const rec = this.otherScores.get(scoreMsg.peerId);
      if (rec) rec.score = scoreMsg.score; // 관전자 peerId 는 map 에 없어 자동 무시
      return;
    }

    const end = decodeEnd(msg);
    if (end) {
      if (this.isSpectator) return; // 관전자는 플랫폼 game_end 경로로 이동
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
      // 정지 동안 흐른 만큼 startedAt 을 밀어 gameTime(냄비 타이머 포함)을 멈춘 것처럼.
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
    const remainingMs = Math.max(0, this.durationMs - gameTime);

    if (!this.gameFinished && !this.paused && !this.isSpectator) {
      // 냄비 진행 — cooking→ready, ready 방치→overcooked
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

    // 호스트: authoritative 남은시간 주기 broadcast (게스트 시계 정렬 — 시작/종료 공정)
    if (this.isHost && !this.paused && !this.gameFinished && now - this.lastClockAt > CLOCK_INTERVAL_MS) {
      this.lastClockAt = now;
      this.ctx.sendToPeer(encodeClock(remainingMs));
    }

    if (!this.gameFinished && remainingMs <= 0) {
      this.gameFinished = true;
      sound.play('tetris_topout');
      if (!this.isSpectator) this.ctx.sendToPeer(encodeScore(this.myPeerId, this.earnings));
      if (this.isHost) this.finishTimer = window.setTimeout(() => this.finishGame(), FINISH_GRACE_MS);
    }

    // 팝업 만료 정리
    if (this.popups.length) this.popups = this.popups.filter((p) => now - p.start < 900);

    this.renderer.render({
      pots: this.pots,
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
      // 토글: 같은 토핑 다시 누르면 장전 해제
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
        break; // 끓는 중 — 무시
      case 'ready':
        if (this.armedTopping) {
          // 토핑 추가 (중복 방지). 장전은 1회용.
          if (!pot.toppings.includes(this.armedTopping)) pot.toppings.push(this.armedTopping);
          this.armedTopping = null;
          sound.play('pop');
        } else {
          this.serve(pot);
        }
        break;
      case 'overcooked':
        // 폐기 (매출 0)
        this.pushPopup(pot, '불음!', false);
        this.missedCount++;
        this.resetPot(pot);
        sound.play('button_click');
        break;
    }
  }

  private serve(pot: Pot): void {
    const price = bowlPrice(pot);
    this.earnings += price;
    this.servedCount++;
    this.pushPopup(pot, `+${price.toLocaleString()}`, true);
    this.resetPot(pot);
    sound.play('goal');
    this.refreshUpgradeBar(); // 매출 변동 → 구매 가능 여부 갱신
  }

  private resetPot(pot: Pot): void {
    pot.state = 'empty';
    pot.toppings = [];
    pot.cookStartGt = 0;
    pot.readyGt = 0;
  }

  private pushPopup(pot: Pot, text: string, good: boolean): void {
    // 냄비 논리 위치에 팝업 (render 의 potLayout 과 동일 좌표계)
    const idx = this.pots.indexOf(pot);
    const p = potLayout(this.pots.length)[idx];
    if (p) this.popups.push({ x: p.x, y: p.y - 40, text, good, start: performance.now() });
  }

  // ============================================
  // 업그레이드 바 (HTML 오버레이)
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
      this.upgradeBtnHTML('pots', '🍲 냄비 추가') +
      this.upgradeBtnHTML('firepower', '🔥 화력 강화');
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
    const kinds: UpgradeKind[] = ['pots', 'firepower'];
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
