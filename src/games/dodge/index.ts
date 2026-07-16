/**
 * 똥 피하기 GameModule.
 *
 * 아키텍처 (사과게임/반응속도 계열 — 독립 시뮬 + 결정론적 낙하물):
 *   - 호스트가 모드(동일/랜덤) + 시드를 broadcast. 동일 모드면 전원 같은 시드 → 같은 낙하 패턴.
 *   - 각 클라는 로컬에서 캐릭터를 조작(← → 이동, Space 대시)하며 낙하물을 피한다.
 *   - 낙하물 위치는 (시드 + 경과시간 t)의 순수 함수라 프레임레이트 무관, 클라별 시계 무관.
 *   - 죽으면(닿으면) 생존시간 확정. 호스트가 생존현황 집계 → 마지막 생존자 승, 순위=생존시간.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  createSpawner, isHit, FIELD_W, PLAYER_W, MOVE_SPEED,
  DASH_SPEED, DASH_DUR_MS, DASH_CD_MS, MAX_GAME_MS,
  type DodgeMode, type Faller,
} from './rules';
import { DodgeRenderer, type RenderState } from './render';
import {
  encodeHello, decodeHello,
  encodeStart, decodeStart,
  encodeHeartbeat, decodeHeartbeat,
  encodeStandings, decodeStandings,
  encodeEnd, decodeEnd,
  type StandingEntry,
} from './netSync';

const HB_INTERVAL_MS = 400;      // 게스트 → 호스트 하트비트 주기
const STANDINGS_INTERVAL_MS = 600; // 호스트 → 전체 순위표 주기
const END_DELAY_MS = 300;        // 플랫폼 endGame 도 딜레이가 있어 짧게 (더블 딜레이 방지)

class DodgeGameModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: DodgeRenderer;
  private myPeerId = '';
  private hostPeerId = '';
  private isHost = false;
  private isSpectator = false;

  private rafId: number | null = null;
  private destroyed = false;
  private paused = false;
  private pauseStart = 0;

  // 진행 상태
  private started = false;
  private gameEnded = false;
  private endScheduled = false;
  private mode: DodgeMode = 'same';
  /** 시뮬 경과시간(초). capped dt 누적 → 렉 때도 낙하물·캐릭터가 같은 시계로 움직임(터널링·정지중낙하 방지) */
  private simT = 0;
  private spawner: { fallers: Faller[]; ensure(t: number): void } | null = null;

  // 내 캐릭터
  private playerX = (FIELD_W - PLAYER_W) / 2;
  private facing: -1 | 1 = 1;
  private leftHeld = false;
  private rightHeld = false;
  private dashDir: -1 | 1 = 1;
  private dashUntil = 0;
  private dashCdUntil = 0;
  private dead = false;
  private myAliveMs = 0;
  private lastFrame = 0;
  private lastHbAt = 0;

  // 호스트 집계
  private standings = new Map<string, StandingEntry>();
  private lastStandingsAt = 0;
  private gameStartWall = 0; // 호스트 워치독 기준

  // 게스트 재동기
  private lastHelloAt = 0;

  // ============================================
  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.hostPeerId = ctx.players.find((p) => p.isHost)?.peerId ?? '';
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    this.renderer = new DodgeRenderer(ctx.canvas);
    ctx.canvas.style.cursor = 'default';
    sound.startBgm('reflex'); // 긴장감 BGM 재활용

    if (this.isHost) {
      const mode: DodgeMode = ctx.roomOptions['pattern'] === 'random' ? 'random' : 'same';
      const seed = (Math.floor(Math.random() * 2 ** 31) || 1) >>> 0;
      // 호스트 자신 시작 + 전원에게 알림
      this.beginLocal(mode, seed, 0);
      this.ctx.sendToPeer(encodeStart({ mode, seed, t: 0 }));
      // 순위표 초기화 (role==='player' 전원)
      for (const p of ctx.players) {
        if (p.role !== 'player') continue;
        this.standings.set(p.peerId, { peerId: p.peerId, nickname: p.nickname, aliveMs: 0, dead: false });
      }
      this.gameStartWall = performance.now();
    } else {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
      this.lastHelloAt = performance.now();
    }

    this.attachInput();
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  /** 모드/시드 확정 후 로컬 게임 시작 (호스트/게스트 공통).
   *  @param t0 호스트 현재 게임시각(초) — 늦게 시작해도 같은 패턴 위치에서 시작(쉬운 초반 재획득 방지) */
  private beginLocal(mode: DodgeMode, seed: number, t0 = 0): void {
    if (this.started) return;
    this.started = true;
    this.mode = mode;
    this.sharedSeed = seed; // 재동기(hello) 시 동일 모드 시드 재전송용
    // 동일 모드면 공유 시드, 랜덤 모드면 각자 자기 시드
    const useSeed = mode === 'same' ? seed : ((Math.floor(Math.random() * 2 ** 31) || 1) >>> 0);
    this.spawner = createSpawner(useSeed);
    // 카운트다운은 플랫폼(gameScreen)이 시작 전에 이미 3초 보여줌 → 여기선 바로 플레이.
    // simT 를 호스트 시각으로 맞춤: 정상 시작이면 ~0, 늦게 합류/재동기면 그만큼 진행된 지점에서 시작.
    this.simT = Math.max(0, t0);
    this.playerX = (FIELD_W - PLAYER_W) / 2;
    this.dead = false;
    this.myAliveMs = this.simT * 1000;
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost && this.started) {
        // 합류/재동기 — 현재 모드+시드 + 순위표 전달
        this.ctx.sendToPeer(
          encodeStart({ mode: this.mode, seed: this.currentSeedForShare(), t: this.simT }),
          { target: hello.peerId },
        );
        this.ctx.sendToPeer(encodeStandings([...this.standings.values()]), { target: hello.peerId });
      }
      return;
    }

    const start = decodeStart(msg);
    if (start) {
      if (!this.isHost) this.beginLocal(start.mode, start.seed, start.t);
      return;
    }

    const hb = decodeHeartbeat(msg);
    if (hb) {
      if (this.isHost) this.hostApplyHb(hb.peerId, hb.aliveMs, hb.dead);
      return;
    }

    const st = decodeStandings(msg);
    if (st) {
      if (!this.isHost) this.standings = new Map(st.map((e) => [e.peerId, e]));
      return;
    }

    const end = decodeEnd(msg);
    if (end) {
      this.scheduleEnd(end);
      return;
    }
  }

  /** 동일 모드면 공유 시드 필요 — spawner 생성에 쓴 시드를 저장해두면 좋지만,
   *  동일 모드에서만 의미 있고 호스트는 원 seed 를 안다. 재동기용으로 호스트가 보관한 값 사용. */
  private sharedSeed = 1;
  private currentSeedForShare(): number {
    return this.sharedSeed;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
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
    } else if (this.pauseStart > 0) {
      const d = performance.now() - this.pauseStart;
      // simT 는 정지 중 누적을 안 하므로 보정 불필요. wall-clock 기준(대시/워치독)만 보정.
      this.dashUntil += d;
      this.dashCdUntil += d;
      this.gameStartWall += d;
      this.lastFrame = performance.now();
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
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (!this.paused && this.started && !this.gameEnded && this.spawner) {
      this.simT += dt; // capped dt 누적 — 낙하물·캐릭터·생존시간 모두 이 시계로 (터널링/정지중낙하 방지)
      const t = this.simT;
      this.spawner.ensure(t);

      if (!this.isSpectator && !this.dead) {
        this.movePlayer(now, dt);
        this.myAliveMs = t * 1000;
        if (isHit(this.playerX, t, this.spawner.fallers)) {
          this.dead = true;
          sound.play('tetris_topout');
          this.sendHeartbeat(now, true); // 사망 즉시 통보
        }
      }
      // 하트비트 (게스트 플레이어만; 호스트는 자기 순위 직접 갱신)
      if (!this.isSpectator && !this.isHost && now - this.lastHbAt > HB_INTERVAL_MS) {
        this.sendHeartbeat(now, this.dead);
      }

      // 호스트: 자기 순위 갱신 + 순위표 broadcast + 종료 판정
      if (this.isHost) {
        this.hostApplyHb(this.myPeerId, this.myAliveMs, this.dead);
        if (now - this.lastStandingsAt > STANDINGS_INTERVAL_MS) {
          this.lastStandingsAt = now;
          this.ctx.sendToPeer(encodeStandings([...this.standings.values()]));
        }
        this.checkEndAsHost(now);
      }
    }

    // 게스트: 아직 start 못 받았으면 주기적으로 hello 재요청 (start broadcast 유실 복구).
    //   started 가드 밖에 둬야 함 — 안 그러면 영영 "연결 중" 고착.
    if (!this.paused && !this.isHost && !this.started && now - this.lastHelloAt > 1500) {
      this.lastHelloAt = now;
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }

    try {
      this.renderer.render(this.buildState(now));
    } catch (err) {
      console.error('[dodge] render 오류', err);
    }
  };

  private movePlayer(now: number, dt: number): void {
    const dashing = now < this.dashUntil;
    const heldDir = (this.rightHeld ? 1 : 0) - (this.leftHeld ? 1 : 0); // -1 / 0 / 1
    if (heldDir !== 0) this.facing = heldDir > 0 ? 1 : -1;
    const dir = dashing ? this.dashDir : heldDir;
    const speed = dashing ? DASH_SPEED : MOVE_SPEED;
    this.playerX += dir * speed * dt;
    if (this.playerX < 0) this.playerX = 0;
    const maxX = FIELD_W - PLAYER_W;
    if (this.playerX > maxX) this.playerX = maxX;
  }

  private tryDash(now: number): void {
    if (this.dead || this.paused || now < this.dashCdUntil) return;
    const heldDir = (this.rightHeld ? 1 : 0) - (this.leftHeld ? 1 : 0);
    this.dashDir = heldDir !== 0 ? (heldDir > 0 ? 1 : -1) : this.facing;
    this.dashUntil = now + DASH_DUR_MS;
    this.dashCdUntil = now + DASH_CD_MS;
    sound.play('mallet_hit', { intensity: 0.4 });
  }

  private sendHeartbeat(now: number, dead: boolean): void {
    this.lastHbAt = now;
    this.ctx.sendToPeer(
      encodeHeartbeat({ peerId: this.myPeerId, aliveMs: this.myAliveMs, dead }),
      { target: this.hostPeerId },
    );
  }

  private hostApplyHb(peerId: string, aliveMs: number, dead: boolean): void {
    const e = this.standings.get(peerId);
    if (!e) return;
    // 생존시간은 단조 증가만 (뒤늦은 하트비트가 값 되돌리지 않게)
    if (aliveMs > e.aliveMs) e.aliveMs = aliveMs;
    if (dead) e.dead = true;
  }

  private checkEndAsHost(now: number): void {
    if (this.gameEnded) return;
    const players = [...this.standings.values()];
    const aliveCount = players.filter((e) => !e.dead).length;
    // 전원 죽어야 종료 — 마지막 생존자도 자기가 죽을 때까지 계속 피함(순위=생존시간).
    // (예전엔 마지막 1명 남으면 바로 끝났는데, 끝까지 플레이하도록 변경)
    const watchdog = now - this.gameStartWall > MAX_GAME_MS;
    if (aliveCount <= 0 || watchdog) this.finalizeAsHost();
  }

  private finalizeAsHost(): void {
    if (this.gameEnded) return;
    this.gameEnded = true;
    const entries = [...this.standings.values()].sort((a, b) => {
      if (a.dead !== b.dead) return a.dead ? 1 : -1;
      return b.aliveMs - a.aliveMs;
    });
    const rankings = entries.map((e, i) => ({
      peerId: e.peerId, nickname: e.nickname, rank: i + 1, survivalMs: Math.round(e.aliveMs),
    }));
    const winnerPeerId = rankings[0]?.peerId ?? null;
    const baseSummary: Record<string, unknown> = {
      gameId: 'dodge',
      totalPlayers: rankings.length,
      rankings,
    };
    const winnerFor = (p: Player): GameResult['winner'] => {
      if (p.role === 'spectator') return 'opponent';
      return p.peerId === winnerPeerId ? 'me' : 'opponent';
    };
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      this.ctx.sendToPeer(
        encodeEnd({ winner: winnerFor(p), summary: { ...baseSummary, myPeerId: p.peerId } }),
        { target: p.peerId },
      );
    }
    this.scheduleEnd({
      winner: this.myPeerId === winnerPeerId ? 'me' : 'opponent',
      summary: { ...baseSummary, myPeerId: this.myPeerId },
    });
  }

  private scheduleEnd(result: GameResult): void {
    if (this.endScheduled) return;
    this.endScheduled = true;
    this.gameEnded = true;
    window.setTimeout(() => {
      if (!this.destroyed) this.ctx.endGame(result);
    }, END_DELAY_MS);
  }

  private buildState(now: number): RenderState {
    if (!this.started || !this.spawner) {
      return {
        phase: 'playing', t: 0, fallers: [], playerX: this.playerX,
        facing: this.facing, dashing: false, dashReady01: 1, myAliveMs: 0,
        standings: [...this.standings.values()], myPeerId: this.myPeerId,
        isSpectator: this.isSpectator, connecting: !this.isHost,
      };
    }
    const dashReady01 = now >= this.dashCdUntil ? 1
      : Math.max(0, 1 - (this.dashCdUntil - now) / DASH_CD_MS);
    return {
      phase: this.dead ? 'dead' : 'playing',
      t: this.simT,
      fallers: this.spawner.fallers,
      playerX: this.playerX,
      facing: this.facing,
      dashing: now < this.dashUntil,
      dashReady01,
      myAliveMs: this.myAliveMs,
      standings: [...this.standings.values()],
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
    };
  }

  // ============================================
  // 입력
  // ============================================
  private attachInput(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }
  private detachInput(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isSpectator) return;
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') { this.leftHeld = true; e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { this.rightHeld = true; e.preventDefault(); }
    else if (k === ' ' || k === 'Spacebar') { this.tryDash(performance.now()); e.preventDefault(); }
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') this.leftHeld = false;
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') this.rightHeld = false;
  };
}

export function createDodgeGame(): GameModule {
  return new DodgeGameModule();
}
