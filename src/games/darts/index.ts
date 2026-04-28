/**
 * 다트 게임 GameModule
 *
 * 조작:  과녁 아래 대기 중인 다트 클릭 → 마우스 휘둘러서 릴리스 → 플릭 속도로 투척
 *
 * 구조:
 *   - 물리 (투척 궤적): 이 파일. 릴리스 속도 + 중력으로 포물선 → 착지.
 *   - 규칙 (점수/턴/종료): rules.ts (순수 상태 머신). 착지 직후 applyDartHit 호출.
 *   - 렌더: render.ts. 매 프레임 state 스냅샷 받아 그림.
 *
 * 현재 범위:
 *   - 로컬 (혼자 플레이, 또는 같은 기기에서 턴 돌려가며) 완전 동작
 *   - 룸 옵션 mode / x01Variant 반영
 *   - 모든 모드 점수/종료 판정
 *   - 게임 종료 → overlay 노출 후 ctx.endGame
 *
 * 아직 없음:
 *   - 네트워크 동기화 (다른 기기 플레이어의 투척을 보거나 턴 넘기는 메시지) → Phase C.
 *     멀티플레이어에서도 "내 턴" 판정은 로컬 state 기반이라 기본은 동작하지만
 *     각 기기가 독립적으로 state 를 진화시키기 때문에 동기화 안 됨. 단판 로컬 테스트 전제.
 */

import type { GameContext, GameMessage, GameModule, GameResult } from '../types';
import { sound } from '../../core/sound';
import type { HitResult } from './board';
import {
  DartsRenderer,
  logicalToHit,
  BOARD_CX,
  BOARD_CY,
  type DartsMode,
  type X01Variant,
  type FlyingDart,
  type StuckDart,
} from './render';
import {
  createGameState,
  applyDartHit,
  advanceTurn,
  toPlayerDisplays,
  modeLabel,
  gameOverSubtitle,
  buildRankings,
  type DartsGame,
} from './rules';
import {
  encodeThrow,
  decodeThrow,
  encodeEnd,
  decodeEnd,
  encodeHello,
  decodeHello,
  encodeSync,
  decodeSync,
} from './netSync';

// --- 물리 상수 (논리 좌표 800×400 기준) ---

const FLIGHT_MS = 380;
const GRAVITY = 0.0022;
const SPEED_SCALE = 0.7;
const MAX_SPEED = 2.2;
const VELOCITY_WINDOW_MS = 90;
const MIN_FLICK_SPEED = 0.22;
const MIN_UPWARD_SPEED = 0.08;

// --- 타이밍 ---

/** 3다트 완료 후 다음 턴까지 대기 (꽂힌 결과 보여주기) */
const TURN_END_DELAY_MS = 1400;
/** 게임 종료 overlay 표시 시간 (ctx.endGame 으로 넘어가기 전) */
const GAME_END_DISPLAY_MS = 2400;

interface MotionSample {
  x: number;
  y: number;
  t: number;
}

interface FlightPhysics {
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  startTime: number;
}

/** 픽업 다트 중심 좌표 (render.ts drawPickupDart 와 일치 유지 필요) */
const PICKUP_X = 220;
const PICKUP_Y = 375;
/** 이 반경 안에서 mousedown 해야 투척 시작으로 인정 */
const PICKUP_HIT_RADIUS = 60;

class DartsGameModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: DartsRenderer;
  private myPeerId = '';
  private isSpectator = false;
  private isHost = false;

  // --- 규칙 엔진 (rules.ts 가 관리하는 state) ---
  private game!: DartsGame;

  // --- 물리/입력 상태 ---
  private stuckDarts: StuckDart[] = [];
  private flyingDart: FlyingDart | null = null;
  private flight: FlightPhysics | null = null;
  private heldDart: FlyingDart | null = null;
  private samples: MotionSample[] = [];
  private tracking = false;

  // --- 타이머 ---
  private turnAdvanceTimerId: number | null = null;
  private endGameTimerId: number | null = null;

  private rafId: number | null = null;
  private destroyed = false;

  /** canvas 바깥 HTML 힌트 (pickup 다트 설명). start 에서 삽입, destroy 에서 제거. */
  private hintEl: HTMLDivElement | null = null;

  /** 일시정지 — flight 진행 / 마우스 입력 / 턴 advance 모두 정지 */
  private paused = false;

  // ============================================
  // GameModule 인터페이스
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isSpectator = ctx.isSpectator === true;
    this.isHost = ctx.role === 'host';

    this.renderer = new DartsRenderer({ canvas: ctx.canvas });

    // 룸 옵션 파싱
    const mode = parseMode(ctx.roomOptions['mode']);
    const x01Variant = parseX01Variant(ctx.roomOptions['x01Variant']);

    // 플레이어 시드 — 관전자 제외, 플랫폼이 준 순서 유지
    const seeds = ctx.players
      .filter((p) => p.role === 'player')
      .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));

    this.game = createGameState(mode, x01Variant, seeds);

    ctx.canvas.style.cursor = 'crosshair';
    ctx.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);

    // pickup 설명 힌트 — canvas 바로 아래 DOM 에 삽입. 관전자는 던질 일이 없으니 안 보임.
    if (!this.isSpectator) {
      const wrap = ctx.canvas.parentElement;
      if (wrap) {
        this.hintEl = document.createElement('div');
        this.hintEl.className = 'darts-hint';
        this.hintEl.textContent = '🎯 클릭 → 아래로 당겼다가 위로 휘둘러 던지기';
        wrap.appendChild(this.hintEl);
      }
    }

    sound.startBgm('darts');

    // 게임 중 합류한 관전자/게스트라면 호스트에게 현재 state 요청.
    // 호스트는 자기 한정 — 메시지 안 보냄.
    if (!this.isHost) {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }

    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    // hello (호스트만 응답) — 합류한 피어에게 현재 state 송신
    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost) {
        this.ctx.sendToPeer(
          encodeSync({ game: this.game, stuckDarts: this.stuckDarts }),
          { target: hello.peerId },
        );
      }
      return;
    }

    // sync (게스트/관전자) — 호스트가 보낸 현재 state 로 교체
    const sync = decodeSync(msg);
    if (sync) {
      if (!this.isHost) {
        this.game = sync.game;
        this.stuckDarts = sync.stuckDarts;
      }
      return;
    }

    // 다른 플레이어의 투척 — 같은 파라미터로 로컬 flight 재생해서 state 수렴
    const t = decodeThrow(msg);
    if (t) {
      // 내 msg 가 릴레이로 돌아온 경우 드랍
      if (t.peerId === this.myPeerId) return;
      // 이미 날아가는 다트 있으면 드랍 (정상 게임 흐름에선 발생 X)
      if (this.flight || this.flyingDart) return;
      // 현재 차례 플레이어만 던질 수 있음 — 방어 체크
      const cur = this.game.players[this.game.currentIdx];
      if (!cur || cur.peerId !== t.peerId) return;
      this.startFlight(t.fromX, t.fromY, t.vx, t.vy, /* fromRemote */ true);
      return;
    }

    // 호스트가 최종 결과를 보냄 — 비호스트는 이걸 받아 결과 화면으로
    const e = decodeEnd(msg);
    if (e) {
      this.ctx.endGame(e);
      return;
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.turnAdvanceTimerId !== null) {
      window.clearTimeout(this.turnAdvanceTimerId);
      this.turnAdvanceTimerId = null;
    }
    if (this.endGameTimerId !== null) {
      window.clearTimeout(this.endGameTimerId);
      this.endGameTimerId = null;
    }
    this.ctx?.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    if (this.ctx?.canvas) this.ctx.canvas.style.cursor = '';
    this.hintEl?.remove();
    this.hintEl = null;
    this.renderer?.destroy();
    sound.stopBgm();
  }

  /** 일시정지 토글. 진행 중인 flight / windup 드래그 / 입력 모두 멈춤. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      // 진행 중인 windup 드래그 취소 (paused 풀려도 다시 시작 가능)
      this.tracking = false;
      this.heldDart = null;
      this.samples = [];
    }
  }

  // ============================================
  // 메인 루프
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;

    // 일시정지 — flight 진행 정지, 렌더만 (현재 게임 state 그대로)
    if (!this.paused) {
      this.updateFlight();
    }

    const g = this.game;
    const gameOver = g.finished
      ? {
          winnerNickname: g.players.find((p) => p.peerId === g.winnerPeerId)?.nickname ?? null,
          subtitle: gameOverSubtitle(g),
        }
      : null;

    const players = toPlayerDisplays(g);
    const amCurrent = g.players[g.currentIdx]?.peerId === this.myPeerId;
    const isMyTurn = !this.isSpectator && !g.finished && amCurrent;
    // 관전자는 myPlayerIdx = null (점수 카드는 현재 차례 플레이어 기준으로 대체 렌더됨)
    const myIdx = this.isSpectator
      ? null
      : g.players.findIndex((p) => p.peerId === this.myPeerId);

    this.renderer.render({
      mode: g.mode,
      x01Variant: g.x01Variant,
      modeLabel: modeLabel(g.mode, g.x01Variant),
      round: g.round,
      maxRounds: g.maxRounds ?? undefined,
      players,
      currentPlayerIdx: g.currentIdx,
      myPlayerIdx: myIdx !== null && myIdx >= 0 ? myIdx : null,
      stuckDarts: this.stuckDarts,
      flyingDart: this.flyingDart,
      heldDart: this.heldDart,
      isMyTurn,
      isSpectator: this.isSpectator,
      gameOver,
    });
  };

  // ============================================
  // 마우스 입력
  // ============================================

  private onMouseDown = (e: MouseEvent): void => {
    if (this.destroyed || this.isSpectator || this.game.finished || this.paused) return;
    if (this.flight || this.tracking) return;
    if (!this.isMyTurnNow()) return;
    const cur = this.game.players[this.game.currentIdx];
    if (!cur || cur.throwsThisTurn.length >= 3) return;

    const { lx, ly, nearPickup } = this.mouseToLogical(e);
    // 픽업 다트 근처에서만 집어들 수 있도록 — 과녁 위에서 무심코 눌러도 반응 X
    if (!nearPickup) return;

    e.preventDefault();
    this.tracking = true;
    this.samples = [{ x: lx, y: ly, t: performance.now() }];
    this.heldDart = { x: lx, y: ly, rotation: Math.PI };
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.tracking) return;
    const { lx, ly } = this.mouseToLogical(e);
    const now = performance.now();
    this.samples.push({ x: lx, y: ly, t: now });
    const cutoff = now - VELOCITY_WINDOW_MS * 2;
    while (this.samples.length > 2 && this.samples[0]!.t < cutoff) {
      this.samples.shift();
    }
    if (this.heldDart) {
      this.heldDart.x = lx;
      this.heldDart.y = ly;
      const v = this.computeReleaseVelocity();
      if (v && Math.hypot(v.vx, v.vy) > 0.1) {
        this.heldDart.rotation = Math.atan2(v.vy, v.vx) - Math.PI / 2;
      }
    }
  };

  private onMouseUp = (_e: MouseEvent): void => {
    if (!this.tracking) return;
    this.tracking = false;

    const release = this.computeReleaseVelocity();
    this.samples = [];
    this.heldDart = null;
    if (!release) return;

    const rawSpeed = Math.hypot(release.vx, release.vy);
    if (rawSpeed < MIN_FLICK_SPEED) return;
    if (-release.vy < MIN_UPWARD_SPEED) return;

    let vx = release.vx * SPEED_SCALE;
    let vy = release.vy * SPEED_SCALE;
    const scaledSpeed = Math.hypot(vx, vy);
    if (scaledSpeed > MAX_SPEED) {
      const k = MAX_SPEED / scaledSpeed;
      vx *= k;
      vy *= k;
    }

    this.startFlight(release.x, release.y, vx, vy);
  };

  private computeReleaseVelocity(): { x: number; y: number; vx: number; vy: number } | null {
    const n = this.samples.length;
    if (n < 2) return null;
    const latest = this.samples[n - 1]!;
    let baseIdx = 0;
    for (let i = n - 2; i >= 0; i--) {
      if (latest.t - this.samples[i]!.t <= VELOCITY_WINDOW_MS) {
        baseIdx = i;
      } else {
        break;
      }
    }
    const base = this.samples[baseIdx]!;
    const dt = latest.t - base.t;
    if (dt <= 0) return null;
    return {
      x: latest.x,
      y: latest.y,
      vx: (latest.x - base.x) / dt,
      vy: (latest.y - base.y) / dt,
    };
  }

  private mouseToLogical(e: MouseEvent): { lx: number; ly: number; nearPickup: boolean } {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const { x, y } = this.renderer.canvasToLogical(px, py);
    const dx = x - PICKUP_X;
    const dy = y - PICKUP_Y;
    const nearPickup = dx * dx + dy * dy <= PICKUP_HIT_RADIUS * PICKUP_HIT_RADIUS;
    // nearPickup 이 아니어도 mousemove 로 좌표 갱신은 필요 (PANEL_X 는 단순 참조)
    return { lx: x, ly: y, nearPickup };
  }

  private isMyTurnNow(): boolean {
    const cur = this.game.players[this.game.currentIdx];
    return !!cur && cur.peerId === this.myPeerId;
  }

  // ============================================
  // 투척 물리
  // ============================================

  private startFlight(
    x0: number, y0: number, vx: number, vy: number,
    fromRemote = false,
  ): void {
    this.flight = { x0, y0, vx, vy, startTime: performance.now() };
    this.flyingDart = {
      x: x0,
      y: y0,
      rotation: Math.atan2(vy, vx) - Math.PI / 2,
    };
    sound.play('pop');

    // 내가 실제로 던진 거면 다른 클라이언트들이 같은 flight 를 재생하도록 broadcast
    if (!fromRemote) {
      this.ctx.sendToPeer(encodeThrow({
        peerId: this.myPeerId,
        fromX: x0,
        fromY: y0,
        vx,
        vy,
      }));
    }
  }

  private updateFlight(): void {
    if (!this.flight || !this.flyingDart) return;
    const now = performance.now();
    const t = now - this.flight.startTime;

    if (t >= FLIGHT_MS) {
      this.landFlight();
      return;
    }

    const x = this.flight.x0 + this.flight.vx * t;
    const y = this.flight.y0 + this.flight.vy * t + 0.5 * GRAVITY * t * t;
    const curVy = this.flight.vy + GRAVITY * t;
    this.flyingDart.x = x;
    this.flyingDart.y = y;
    this.flyingDart.rotation = Math.atan2(curVy, this.flight.vx) - Math.PI / 2;
  }

  private landFlight(): void {
    if (!this.flight || !this.flyingDart) return;
    const t = FLIGHT_MS;
    const landX = this.flight.x0 + this.flight.vx * t;
    const landY = this.flight.y0 + this.flight.vy * t + 0.5 * GRAVITY * t * t;
    const curVy = this.flight.vy + GRAVITY * t;
    const rotation = Math.atan2(curVy, this.flight.vx) - Math.PI / 2;

    const hit = logicalToHit(landX, landY);
    const localX = landX - BOARD_CX;
    const localY = landY - BOARD_CY;

    this.stuckDarts.push({
      localX,
      localY,
      rotation,
      hit,
      freshness: 1,
    });

    this.flight = null;
    this.flyingDart = null;

    sound.play(hit.kind === 'miss' ? 'button_click' : 'tetris_clear');

    // 규칙 엔진에 히트 적용 — 점수/턴/종료 판정
    this.onDartLanded(hit);
  }

  // ============================================
  // 규칙 연계
  // ============================================

  private onDartLanded(hit: HitResult): void {
    const result = applyDartHit(this.game, hit);

    if (result.gameEnded) {
      // 승자/과녁 가득찬 상태 잠깐 보여주고 결과 화면으로
      this.scheduleEndGame();
      return;
    }

    if (result.turnEnded) {
      // 다음 턴 대기 (3다트 결과 감상) → advanceTurn
      this.turnAdvanceTimerId = window.setTimeout(() => {
        this.turnAdvanceTimerId = null;
        advanceTurn(this.game);
        // 새 턴이 돌아오면 꽂힌 다트 리셋 (각 턴마다 과녁 초기화)
        this.stuckDarts = [];
        // advanceTurn 이 maxRounds 초과 감지로 finished 세팅했을 수도 있음
        if (this.game.finished) {
          this.scheduleEndGame();
        }
      }, TURN_END_DELAY_MS);
    }
  }

  private scheduleEndGame(): void {
    if (this.endGameTimerId !== null) return; // 이미 스케줄됨
    this.endGameTimerId = window.setTimeout(() => {
      this.endGameTimerId = null;
      if (this.isHost) {
        this.hostBroadcastEnd();
      }
      // 비호스트는 호스트의 dart:end 메시지를 기다림 (onPeerMessage 에서 endGame 호출)
    }, GAME_END_DISPLAY_MS);
  }

  /**
   * 호스트만 호출 — 각 피어에게 per-peer GameResult 전송 후 자기도 ctx.endGame.
   * state 는 결정론적이라 모든 클라이언트가 동시에 scheduleEndGame 하지만,
   * ctx.endGame 호출은 호스트의 authoritative msg 로만 트리거 (플랫폼 전제 준수).
   */
  private hostBroadcastEnd(): void {
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      const result = this.buildResultFor(p.peerId);
      this.ctx.sendToPeer(encodeEnd(result), { target: p.peerId });
    }
    this.ctx.endGame(this.buildResultFor(this.myPeerId));
  }

  /** 특정 peer 의 시점으로 GameResult 생성 */
  private buildResultFor(peerId: string): GameResult {
    const g = this.game;
    const player = this.ctx.players.find((p) => p.peerId === peerId);
    const isSpec = player?.role === 'spectator';
    const winner: GameResult['winner'] = isSpec
      ? 'opponent'
      : g.winnerPeerId === null
        ? null
        : g.winnerPeerId === peerId
          ? 'me'
          : 'opponent';

    const rankings = buildRankings(g);
    const myRank = rankings.find((r) => r.peerId === peerId)?.rank ?? rankings.length;
    const winnerNickname =
      g.winnerPeerId !== null
        ? g.players.find((p) => p.peerId === g.winnerPeerId)?.nickname ?? null
        : null;

    return {
      winner,
      summary: {
        gameId: 'darts',
        mode: g.mode,
        x01Variant: g.x01Variant,
        modeLabel: modeLabel(g.mode, g.x01Variant),
        myPeerId: peerId,
        rank: myRank,
        totalPlayers: rankings.length,
        winnerNickname,
        rankings,
        rounds: g.round,
      },
    };
  }
}

// ============================================
// 룸 옵션 파싱
// ============================================

function parseMode(raw: string | undefined): DartsMode {
  switch (raw) {
    case '101':
    case '201':
    case '301':
    case 'countup':
    case 'low-countup':
    case 'cricket':
      return raw;
    default:
      return '301';
  }
}

function parseX01Variant(raw: string | undefined): X01Variant {
  return raw === 'hard' ? 'hard' : 'normal';
}

// ============================================
// 팩토리
// ============================================

export function createDartsGame(): GameModule {
  return new DartsGameModule();
}
