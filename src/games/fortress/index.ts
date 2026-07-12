/**
 * 포트리스 GameModule — 조립
 *
 * 아키텍처 (호스트 authoritative + 결정론적 궤적 재생):
 *   - 지형: seed 로 각 클라가 동일 생성(generateTerrain) + 크레이터 순차 적용.
 *   - 발사: 발사자가 fr:fire(각도/파워/시작좌표/바람) broadcast → 모든 클라가
 *           같은 파라미터로 포탄 궤적 애니 재생.
 *   - 착탄: 호스트가 궤적 시뮬로 착탄점 확정 → fr:impact(크레이터+HP+다음턴/바람)
 *           broadcast → 지형/HP 동기화. (부동소수 오차와 무관하게 확정값 일치)
 *
 * 입력: 자기 차례에 드래그(반대 방향 발사) — 알까기/다트와 동일 규약.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  createInitialGame, applyBlast, advanceTurn, fortCenterY,
  CRATER_RADIUS,
  type FortressGame, type Fort,
} from './rules';
import {
  generateTerrain, carveCrater, terrainTopAt,
} from './terrain';
import {
  launchVelocity, stepProjectile, MAX_WIND, type Projectile,
} from './physics';
import {
  FortressRenderer, type RenderState,
} from './render';
import {
  encodeHello, decodeHello,
  encodeSync, decodeSync,
  encodeFire, decodeFire,
  encodeImpact, decodeImpact,
  encodeEnd, decodeEnd,
  type Crater,
} from './netSync';

const SIM_DT = 1 / 120;          // 궤적 sub-step (정확한 착탄)
const END_GAME_DELAY_MS = 1800;
const MAX_DRAG_PX = 200;         // 이 이상 당기면 파워 100%
/** 포신 발사 시작점 — 포대 중심에서 위로 */
const MUZZLE_RISE = 13;

class FortressGameModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: FortressRenderer;
  private game!: FortressGame;
  private hm: number[] = [];
  private craters: Crater[] = [];

  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  /** 게스트가 호스트 지형/상태 sync 를 받았는지 — 받기 전엔 조준·발사 금지(지형 불일치 방지) */
  private ready = false;

  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;
  private endGameScheduled = false;
  private lastFrameTime = 0;

  // 궤적
  private projectile: Projectile | null = null;
  private fireWind = 0;

  // 드래그 조준
  private aiming = false;
  private aimFromX = 0;
  private aimFromY = 0;
  private mouseX: number | null = null;
  private mouseY: number | null = null;

  private paused = false;
  private pauseStart = 0;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    const playerList = ctx.players.filter((p) => p.role === 'player');
    const ordered = orderPlayersHostFirst(playerList);

    // 호스트가 seed/바람 결정 (게스트는 sync 로 덮어씀)
    const seed = this.isHost ? (Math.floor(Math.random() * 2 ** 31) || 1) : 1;
    const wind0 = this.isHost ? this.randomWind() : 0;
    const fortsPerPlayer = Math.max(1, Math.min(3, Number(ctx.roomOptions['fortsPerPlayer']) || 1));
    this.game = createInitialGame(
      ordered.map((p) => ({ peerId: p.peerId, nickname: p.nickname })),
      seed, wind0, fortsPerPlayer,
    );
    this.hm = generateTerrain(this.game.seed, this.game.terrainWidth);
    this.ready = this.isHost; // 호스트는 자기 생성이라 즉시 준비. 게스트는 sync 후.

    this.renderer = new FortressRenderer({ canvas: ctx.canvas });
    ctx.canvas.style.cursor = 'crosshair';
    this.attachInput();
    sound.startBgm('battle-tetris'); // 긴장감 BGM 재활용

    if (!this.isHost) this.ctx.sendToPeer(encodeHello(this.myPeerId));

    this.lastFrameTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost) {
        this.ctx.sendToPeer(encodeSync({ game: this.game, craters: this.craters }), { target: hello.peerId });
      }
      return;
    }

    const sync = decodeSync(msg);
    if (sync) {
      if (!this.isHost) {
        this.game = sync.game;
        this.craters = sync.craters;
        this.hm = generateTerrain(this.game.seed, this.game.terrainWidth);
        for (const c of this.craters) carveCrater(this.hm, c.cx, c.cy, c.r);
        this.ready = true; // 호스트 지형/상태 동기화 완료 — 이제 조준 허용
      }
      return;
    }

    const fire = decodeFire(msg);
    if (fire) {
      // 모든 클라 궤적 재생 (발사자 자신은 로컬에서 이미 시작했으면 중복 방지)
      if (this.game.phase !== 'firing') {
        this.beginProjectile(fire.startX, fire.startY, fire.angleRad, fire.power01, fire.wind);
      }
      return;
    }

    const impact = decodeImpact(msg);
    if (impact) {
      if (!this.isHost) this.applyImpactLocal(impact);
      return;
    }

    const end = decodeEnd(msg);
    if (end) {
      this.scheduleEndGame(end);
      return;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.gameFinished = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.detachInput();
    if (this.ctx?.canvas) this.ctx.canvas.style.cursor = '';
    this.renderer?.destroy();
    sound.stopBgm();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.pauseStart = performance.now();
      this.aiming = false;
    } else if (this.pauseStart > 0) {
      this.lastFrameTime += performance.now() - this.pauseStart;
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

    if (!this.paused && this.projectile && this.game.phase === 'firing') {
      const elapsed = Math.min(0.1, (now - this.lastFrameTime) / 1000);
      let remaining = elapsed;
      while (remaining > 0 && this.projectile) {
        const dt = Math.min(SIM_DT, remaining);
        stepProjectile(this.projectile, this.fireWind, dt);
        remaining -= dt;
        if (this.checkImpact()) break; // 착탄 시 처리 후 종료
      }
    }
    this.lastFrameTime = now;

    this.renderer.render(this.buildRenderState(now));
  };

  private buildRenderState(now: number): RenderState {
    const aim = (this.aiming && this.mouseX !== null && this.mouseY !== null)
      ? { fromX: this.aimFromX, fromY: this.aimFromY, mx: this.mouseX, my: this.mouseY }
      : null;
    return {
      game: this.game,
      hm: this.hm,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      projectile: this.projectile ? { x: this.projectile.x, y: this.projectile.y } : null,
      aim,
      now,
    };
  }

  /** 착탄 판정 (호스트만 확정). 착탄했으면 true. */
  private checkImpact(): boolean {
    const p = this.projectile;
    if (!p) return false;

    // 화면 밖으로 크게 이탈 → 빗나감 (호스트만 처리, 게스트는 impact 대기)
    const off = p.x < -60 || p.x > this.game.terrainWidth + 60 || p.y > 440;
    const hitGround = p.y >= terrainTopAt(this.hm, p.x);
    let hitFort = false;
    for (const f of this.game.forts) {
      if (!f.alive) continue;
      if (Math.hypot(f.x - p.x, fortCenterY(this.hm, f) - p.y) < 12) { hitFort = true; break; }
    }

    if (!off && !hitGround && !hitFort) return false;

    // 착탄 — 호스트만 확정 broadcast. 게스트는 궤적만 멈춤.
    if (this.isHost) {
      this.handleImpactAsHost(p.x, Math.min(p.y, terrainTopAt(this.hm, p.x)), off && !hitGround && !hitFort);
    } else {
      this.projectile = null; // 게스트: 궤적 정지, impact 대기
    }
    return true;
  }

  // ============================================
  // 발사 (입력)
  // ============================================

  private attachInput(): void {
    this.ctx.canvas.addEventListener('mousedown', this.onDown);
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
  }
  private detachInput(): void {
    if (this.ctx?.canvas) this.ctx.canvas.removeEventListener('mousedown', this.onDown);
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
  }

  /** 현재 차례 포대 (내 소유일 때만 조준 가능) */
  private currentFort(): Fort | undefined {
    return this.game.forts.find((f) => f.id === this.game.currentTurn);
  }

  private canAim(): boolean {
    if (!this.ready || this.isSpectator || this.paused || this.game.phase !== 'aiming' || this.projectile) return false;
    const cf = this.currentFort();
    return !!cf && cf.ownerPeerId === this.myPeerId;
  }

  private onDown = (e: MouseEvent): void => {
    if (!this.canAim()) return;
    const me = this.currentFort();
    if (!me) return;
    this.aiming = true;
    this.aimFromX = me.x;
    this.aimFromY = fortCenterY(this.hm, me) - MUZZLE_RISE;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
    this.mouseX = x; this.mouseY = y;
  };

  private onMove = (e: MouseEvent): void => {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
    this.mouseX = x; this.mouseY = y;
  };

  private onUp = (): void => {
    if (!this.aiming) return;
    this.aiming = false;
    if (this.mouseX === null || this.mouseY === null) return;
    const dx = this.mouseX - this.aimFromX;
    const dy = this.mouseY - this.aimFromY;
    const dragLen = Math.hypot(dx, dy);
    if (dragLen < 8) return; // 너무 짧음 — 발사 취소

    // 발사 방향 = 당긴 반대. 각도(위가 +) = atan2(dy, -dx)
    const angleRad = Math.atan2(dy, -dx);
    const power01 = Math.min(1, dragLen / MAX_DRAG_PX);
    const wind = this.game.wind;

    // 로컬 즉시 시작 + broadcast (게스트/호스트 공통)
    this.beginProjectile(this.aimFromX, this.aimFromY, angleRad, power01, wind);
    this.ctx.sendToPeer(encodeFire({
      fromFortId: this.game.currentTurn,
      startX: this.aimFromX, startY: this.aimFromY,
      angleRad, power01, wind,
    }));
  };

  private beginProjectile(sx: number, sy: number, angleRad: number, power01: number, wind: number): void {
    const { vx, vy } = launchVelocity(angleRad, power01);
    this.projectile = { x: sx, y: sy, vx, vy };
    this.fireWind = wind;
    this.game.phase = 'firing';
    this.lastFrameTime = performance.now();
    sound.play('mallet_hit', { intensity: 0.5 });
  }

  // ============================================
  // 착탄 처리
  // ============================================

  private handleImpactAsHost(cx: number, cy: number, isMiss: boolean): void {
    let craterR = 0;
    if (!isMiss) {
      craterR = CRATER_RADIUS;
      carveCrater(this.hm, cx, cy, craterR);
      this.craters.push({ cx, cy, r: craterR });
    }
    const blast = isMiss ? { hp: this.hpMap(), ended: false } : applyBlast(this.game, this.hm, cx, cy);
    this.projectile = null;

    const nextWind = this.randomWind();
    if (blast.ended) {
      this.ctx.sendToPeer(encodeImpact({
        cx, cy, craterR, hp: blast.hp, ended: true,
        nextTurn: -1, nextWind, winnerPeerIds: this.game.winnerPeerIds,
      }));
      this.finishAsHost();
    } else {
      advanceTurn(this.game, nextWind, performance.now());
      this.ctx.sendToPeer(encodeImpact({
        cx, cy, craterR, hp: blast.hp, ended: false,
        nextTurn: this.game.currentTurn, nextWind, winnerPeerIds: [],
      }));
    }
    sound.play('tetris_garbage');
  }

  /** 게스트: 확정 impact 반영 */
  private applyImpactLocal(p: ReturnType<typeof decodeImpact>): void {
    if (!p) return;
    if (p.craterR > 0) {
      carveCrater(this.hm, p.cx, p.cy, p.craterR);
      this.craters.push({ cx: p.cx, cy: p.cy, r: p.craterR });
    }
    for (const f of this.game.forts) {
      const hp = p.hp[f.id];
      if (hp !== undefined) { f.hp = hp; f.alive = hp > 0; }
    }
    this.projectile = null;
    if (p.ended) {
      this.game.phase = 'ended';
      this.game.winnerPeerIds = p.winnerPeerIds;
    } else if (p.nextTurn !== -1) {
      this.game.currentTurn = p.nextTurn;
      this.game.wind = p.nextWind;
      this.game.phase = 'aiming';
    }
    sound.play('tetris_garbage');
  }

  private hpMap(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const f of this.game.forts) out[f.id] = f.hp;
    return out;
  }

  private randomWind(): number {
    return Math.round((Math.random() * 2 - 1) * MAX_WIND);
  }

  // ============================================
  // 종료
  // ============================================

  private finishAsHost(): void {
    if (this.gameFinished) return;
    this.gameFinished = true;
    const winners = this.game.winnerPeerIds;
    // 플레이어(소유자) 단위 집계 — 남은 포대 총 HP 합으로 순위. (포대 여러 개 대응)
    const byOwner = new Map<string, { nickname: string; hp: number; alive: boolean }>();
    for (const f of this.game.forts) {
      const e = byOwner.get(f.ownerPeerId) ?? { nickname: f.ownerNickname, hp: 0, alive: false };
      e.hp += f.hp;
      if (f.alive) e.alive = true;
      byOwner.set(f.ownerPeerId, e);
    }
    const coWinnerNicknames = [...new Set(this.game.forts
      .filter((f) => winners.includes(f.ownerPeerId)).map((f) => f.ownerNickname))];
    const rankings = [...byOwner.entries()]
      .sort((a, b) => (b[1].alive ? 1 : 0) - (a[1].alive ? 1 : 0) || b[1].hp - a[1].hp)
      .map(([peerId, e], i) => ({ peerId, nickname: e.nickname, hp: e.hp, rank: i + 1 }));
    const baseSummary: Record<string, unknown> = {
      gameId: 'fortress',
      isCoWin: winners.length >= 2,
      coWinnerNicknames,
      rankings,
    };
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      this.ctx.sendToPeer(
        encodeEnd({ winner: this.winnerFor(p), summary: { ...baseSummary, myPeerId: p.peerId } }),
        { target: p.peerId },
      );
    }
    this.scheduleEndGame({
      winner: this.winnerFor({ peerId: this.myPeerId, nickname: '', isHost: true, role: 'player' }),
      summary: { ...baseSummary, myPeerId: this.myPeerId },
    });
  }

  private winnerFor(p: Player): GameResult['winner'] {
    if (this.game.winnerPeerIds.length === 0) return null; // 무승부
    if (p.role === 'spectator') return 'opponent';
    return this.game.winnerPeerIds.includes(p.peerId) ? 'me' : 'opponent';
  }

  private scheduleEndGame(result: GameResult): void {
    if (this.endGameScheduled) return;
    this.endGameScheduled = true;
    window.setTimeout(() => {
      if (this.destroyed) return;
      this.ctx.endGame(result);
    }, END_GAME_DELAY_MS);
  }
}

function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

export function createFortressGame(): GameModule {
  return new FortressGameModule();
}
