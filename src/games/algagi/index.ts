/**
 * 알까기 GameModule — 조립
 *
 * 아키텍처 (호스트 authoritative):
 *   호스트가 단독 물리 시뮬, ~10Hz 로 state broadcast.
 *   게스트는 받은 state 로 렌더만. 자기 차례에 ag:flick 송신.
 *
 * 입력:
 *   자기 차례 + phase==='aiming' 일 때만 자기 알에 마우스 드래그 → 발사.
 *   호스트는 로컬에서 즉시 applyFlick + 'resolving' 전환.
 *   게스트는 ag:flick 송신 → 호스트가 적용 후 state 로 모두에게 반영.
 *
 * 시뮬레이션 루프 (호스트만):
 *   매 프레임 RAF — phase 가 'resolving' 일 때만 stepPhysics dt 고정 60Hz 로 적분.
 *   큰 dt 들어와도 sub-step 으로 안정. 10Hz 간격으로 ag:state broadcast.
 *   allAtRest → resolveTurnEnd → (게임 끝났으면) ag:end per-peer 송신.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  type AlgagiGame,
  type PlayerIndex,
  STONE_RADIUS,
  createInitialGame,
  resolveTurnEnd,
  getNextTurn,
} from './rules';
import {
  stepPhysics,
  allAtRest,
  applyFlick,
  dragToVelocity,
} from './physics';
import {
  AlgagiRenderer,
  canvasToBoard,
  isInsideBoard,
  pickStoneAt,
  type RenderState,
} from './render';
import {
  encodeHello, decodeHello,
  encodeSync, decodeSync,
  encodeFlick, decodeFlick,
  encodeState, decodeState,
  encodeEnd, decodeEnd,
} from './netSync';

// ============================================
// 상수
// ============================================

/** 시뮬레이션 sub-step (고정 dt) — 결정론적 적분 안정성 위해. */
const SIM_DT = 1 / 60;
/** state broadcast 간격 (ms). 10Hz */
const STATE_BROADCAST_INTERVAL_MS = 100;
/** 게임 종료 후 결과 화면 이동까지 여운 (ms) */
const END_GAME_DELAY_MS = 1500;

// ============================================
// GameModule
// ============================================

class AlgagiGameModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: AlgagiRenderer;
  private game!: AlgagiGame;

  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  /** 내 PlayerIndex (관전자면 -1) */
  private myIndex: PlayerIndex | -1 = -1;

  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;
  private endGameScheduled = false;

  /** 마지막 stepPhysics 호출 시각 (호스트 전용) */
  private lastFrameTime = 0;
  /** 마지막 ag:state broadcast 시각 (호스트 전용) */
  private lastBroadcastAt = 0;
  /** broadcast 간격 동안 누적된 최대 충돌 impulse — 게스트 SFX 동기화용. broadcast 후 0 으로 리셋. */
  private accumImpulse = 0;

  // 입력 상태
  private dragStoneId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private mouseBoardX: number | null = null;
  private mouseBoardY: number | null = null;

  // 일시정지
  private paused = false;
  private pauseStart = 0;

  // ============================================
  // GameModule interface
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    // 플레이어 목록 (role==='player' 만) — index 순서대로
    const playerList = ctx.players.filter((p) => p.role === 'player');
    if (this.isHost) {
      // 호스트가 게임 초기 상태 생성. players 목록은 [호스트, 게스트1, 게스트2, ...] 순.
      const ordered = orderPlayersHostFirst(playerList, this.myPeerId);
      this.game = createInitialGame(
        ordered.map((p) => ({ peerId: p.peerId, nickname: p.nickname })),
      );
    } else {
      // 게스트/관전자는 호스트가 ag:sync 보낼 때까지 placeholder. 호스트가 보내면 game 갱신.
      const ordered = orderPlayersHostFirst(playerList, '');
      this.game = createInitialGame(
        ordered.map((p) => ({ peerId: p.peerId, nickname: p.nickname })),
      );
    }

    // 내 인덱스 (관전자 아니면)
    if (!this.isSpectator) {
      const me = this.game.players.find((p) => p.peerId === this.myPeerId);
      this.myIndex = me?.index ?? -1;
    }

    this.renderer = new AlgagiRenderer({ canvas: ctx.canvas });

    // 마우스 커서 — 알 조준 위해 crosshair
    ctx.canvas.style.cursor = 'crosshair';

    if (!this.isSpectator) {
      this.attachInput();
    }

    sound.startBgm('algagi');

    // 게스트/관전자는 호스트에게 hello → 초기 상태 sync 요청
    if (!this.isHost) {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }

    this.lastFrameTime = performance.now();
    this.lastBroadcastAt = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    // hello → 호스트가 sync 응답
    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost) {
        this.ctx.sendToPeer(encodeSync(this.game), { target: hello.peerId });
      }
      return;
    }

    // sync → 게스트/관전자가 game 상태 교체
    const sync = decodeSync(msg);
    if (sync) {
      if (!this.isHost) {
        this.game = sync;
        if (!this.isSpectator) {
          const me = this.game.players.find((p) => p.peerId === this.myPeerId);
          this.myIndex = me?.index ?? -1;
        }
      }
      return;
    }

    // flick → 호스트가 검증 후 적용 + phase 전환
    const flick = decodeFlick(msg);
    if (flick) {
      if (this.isHost) this.handleFlickRequest(flick.stoneId, flick.vx, flick.vy);
      return;
    }

    // state → 게스트/관전자가 game 상태 교체 (10Hz 스냅샷)
    // payload.impulse 가 임계 이상이면 호스트와 같은 충돌 SFX 재생 (네트워크 지연 만큼만 어긋남).
    const state = decodeState(msg);
    if (state) {
      if (!this.isHost) {
        this.game = state.game;
        if (state.impulse > 50) {
          const intensity = Math.min(1, state.impulse / 500);
          sound.play('mallet_hit', { intensity });
        }
      }
      return;
    }

    // end → 게스트/관전자가 결과 화면으로
    const end = decodeEnd(msg);
    if (end) {
      this.scheduleEndGame(end);
      return;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.gameFinished = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.detachInput();
    if (this.ctx?.canvas) this.ctx.canvas.style.cursor = '';
    this.renderer?.destroy();
    sound.stopBgm();
  }

  /** 일시정지 — paused 동안 lastFrameTime 보정해서 dt 점프 방지. 드래그 중단. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.pauseStart = performance.now();
      this.dragStoneId = null;
      this.mouseBoardX = null;
      this.mouseBoardY = null;
    } else if (this.pauseStart > 0) {
      const pausedFor = performance.now() - this.pauseStart;
      this.lastFrameTime += pausedFor;
      this.lastBroadcastAt += pausedFor;
      this.pauseStart = 0;
    }
  }

  // ============================================
  // 루프 (호스트 = 시뮬레이션, 게스트 = 렌더만)
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;

    const now = performance.now();

    if (!this.paused && this.isHost && this.game.phase === 'resolving') {
      // 시뮬레이션 진행 — fixed sub-step 으로 적분
      const elapsedSec = (now - this.lastFrameTime) / 1000;
      // 큰 lag 시 한 프레임에 너무 많은 sub-step 도는 거 방지 (최대 0.1s 분량)
      const cappedSec = Math.min(elapsedSec, 0.1);
      let remaining = cappedSec;
      // 한 프레임 내 여러 충돌이 동시에 일어나면 시끄러우니 최대 강도만 모아 한 번 재생.
      let frameMaxImpulse = 0;
      let turnEnded = false; // 이번 프레임에 턴이 종료됐는지 — 종료 시 즉시 broadcast 필요
      while (remaining > 0 && this.game.phase === 'resolving') {
        const dt = Math.min(SIM_DT, remaining);
        stepPhysics(this.game.stones, dt, (impulse) => {
          if (impulse > frameMaxImpulse) frameMaxImpulse = impulse;
        });
        remaining -= dt;

        if (allAtRest(this.game.stones)) {
          // turn 종료 — 알 제거 + 다음 턴 / 종료 판정
          const ended = resolveTurnEnd(this.game);
          turnEnded = true;
          if (ended) {
            this.finishAsHost();
          }
          break;
        }
      }
      // 충돌 SFX — 강도(0~500+) 를 mallet_hit intensity(0~1) 로 매핑.
      // 임계 50 미만은 너무 약한 스침이라 skip (조용 유지).
      // 호스트는 매 프레임 즉시 재생, 게스트는 broadcast 시점에 accumImpulse 로 동기화.
      if (frameMaxImpulse > 50) {
        const intensity = Math.min(1, frameMaxImpulse / 500);
        sound.play('mallet_hit', { intensity });
      }
      if (frameMaxImpulse > this.accumImpulse) this.accumImpulse = frameMaxImpulse;

      // 턴 종료 시: 100ms 가드 무시하고 즉시 broadcast.
      //   (이게 없으면 turn 종료 직후 aiming + 새 currentTurn 이 게스트에 안 가서
      //    게스트가 resolving 상태에 멈춰 다음 턴 입력 불가 — 둘째 턴부터 먹통 버그)
      // 게임이 끝난 경우는 finishAsHost 가 per-peer end 를 이미 보냈으니 state 는 생략.
      if (turnEnded) {
        if (this.game.phase === 'aiming') {
          this.ctx.sendToPeer(encodeState(this.game, this.accumImpulse));
          this.lastBroadcastAt = now;
          this.accumImpulse = 0;
        }
      } else if (now - this.lastBroadcastAt >= STATE_BROADCAST_INTERVAL_MS) {
        // 진행 중 10Hz broadcast
        this.ctx.sendToPeer(encodeState(this.game, this.accumImpulse));
        this.lastBroadcastAt = now;
        this.accumImpulse = 0;
      }
    }
    this.lastFrameTime = now;

    // 렌더
    const renderState: RenderState = {
      game: this.game,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      dragStoneId: this.dragStoneId,
      dragStartX: this.dragStartX,
      dragStartY: this.dragStartY,
      mouseBoardX: this.mouseBoardX,
      mouseBoardY: this.mouseBoardY,
    };
    // render 중 예외가 나도 루프가 죽지 않게 방어.
    //   (렌더는 흰 배경을 먼저 칠하고 나머지를 그린다 — 중간에 throw 하면 흰 배경만 남아
    //    매 프레임 흰 화면이 반복되던 문제. 여기서 잡아 콘솔에만 남기고 다음 프레임 진행.)
    try {
      this.renderer.render(renderState);
    } catch (err) {
      console.error('[algagi] render 실패 (프레임 건너뜀)', err);
    }
  };

  // ============================================
  // flick 처리 — 호스트만
  // ============================================

  private handleFlickRequest(stoneId: number, vx: number, vy: number): void {
    if (this.game.phase !== 'aiming') return; // 이미 시뮬 중이면 무시
    const stone = this.game.stones[stoneId];
    if (!stone || !stone.alive) return;
    // 요청자가 현재 차례의 알이어야 함
    if (stone.owner !== this.game.currentTurn) return;

    applyFlick(stone, vx, vy);
    this.game.phase = 'resolving';
    this.lastFrameTime = performance.now();
    sound.play('pop');
    // 즉시 한 번 broadcast — 게스트가 바로 시뮬 진행을 보게
    this.ctx.sendToPeer(encodeState(this.game));
    this.lastBroadcastAt = performance.now();
  }

  // ============================================
  // 게임 종료 — 호스트가 per-peer 결과 송신
  // ============================================

  /** 플레이어 이탈 — 호스트 처리 (알까기는 2~4인).
   *  나간 사람 알을 모두 제거 → liveCount 재계산 → 생존자 1명 이하면 그 사람 승으로 종료.
   *  아니면(3~4인) 나간 사람이 현재 턴이었을 때 다음으로 넘기고 상태 sync. 관전자 이탈은 무시. */
  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.gameFinished) return;
    const victim = this.game.players.find((p) => p.peerId === peerId);
    if (!victim) return;
    for (const s of this.game.stones) {
      if (s.owner === victim.index) s.alive = false;
    }
    for (const p of this.game.players) {
      p.liveCount = this.game.stones.filter((s) => s.alive && s.owner === p.index).length;
    }
    const survivors = this.game.players.filter((p) => p.liveCount > 0);
    if (survivors.length <= 1) {
      this.game.winnerPeerId = survivors[0]?.peerId ?? null;
      this.finishAsHost();
      return;
    }
    if (this.game.phase === 'aiming' && this.game.currentTurn === victim.index) {
      this.game.currentTurn = getNextTurn(this.game);
    }
    this.ctx.sendToPeer(encodeSync(this.game));
  }

  private finishAsHost(): void {
    if (this.gameFinished) return;
    this.gameFinished = true;

    const baseSummary: Record<string, unknown> = {
      gameId: 'algagi',
      turnCount: this.game.turnCount,
      winnerNickname:
        this.game.players.find((p) => p.peerId === this.game.winnerPeerId)?.nickname ?? null,
      players: this.game.players.map((p) => ({
        peerId: p.peerId,
        nickname: p.nickname,
        liveCount: p.liveCount,
      })),
    };

    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      const myWinner: GameResult['winner'] = this.computeWinnerForPeer(p);
      const result: GameResult = { winner: myWinner, summary: { ...baseSummary, myPeerId: p.peerId } };
      this.ctx.sendToPeer(encodeEnd(result), { target: p.peerId });
    }

    const myResult: GameResult = {
      winner: this.computeWinnerForPeer({ peerId: this.myPeerId, nickname: '', isHost: true, role: 'player' }),
      summary: { ...baseSummary, myPeerId: this.myPeerId },
    };
    this.scheduleEndGame(myResult);
  }

  private computeWinnerForPeer(p: Player): GameResult['winner'] {
    if (this.game.winnerPeerId === null) return null; // 무승부
    if (p.role === 'spectator') return 'opponent'; // 관전자는 자기가 이긴 게 아님
    return this.game.winnerPeerId === p.peerId ? 'me' : 'opponent';
  }

  private scheduleEndGame(result: GameResult): void {
    if (this.endGameScheduled) return;
    this.endGameScheduled = true;
    window.setTimeout(() => {
      if (this.destroyed) return;
      this.ctx.endGame(result);
    }, END_GAME_DELAY_MS);
  }

  // ============================================
  // 마우스 입력
  // ============================================

  private attachInput(): void {
    this.ctx.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  private detachInput(): void {
    if (this.ctx?.canvas) {
      this.ctx.canvas.removeEventListener('mousedown', this.onMouseDown);
    }
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (this.paused || this.gameFinished) return;
    if (this.game.phase !== 'aiming') return;

    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x: boardX, y: boardY } = canvasToBoard(
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect,
    );
    if (!isInsideBoard(boardX, boardY)) return;

    const stone = pickStoneAt(this.game.stones, boardX, boardY);
    if (!stone) return;
    // 내 알 아닐 때 — 무반응
    if (stone.owner !== this.myIndex) return;
    // 내 알이지만 내 차례 아닐 때 — 거절음 + 시각 피드백 (커서가 이미 not-allowed 인 상태)
    if (this.myIndex !== this.game.currentTurn) {
      sound.play('button_click');
      return;
    }

    this.dragStoneId = stone.id;
    this.dragStartX = stone.x;
    this.dragStartY = stone.y;
    this.mouseBoardX = boardX;
    this.mouseBoardY = boardY;
  };

  private onMouseMove = (e: MouseEvent): void => {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x: boardX, y: boardY } = canvasToBoard(
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect,
    );

    // 드래그 중이면 위치 업데이트
    if (this.dragStoneId !== null) {
      this.mouseBoardX = boardX;
      this.mouseBoardY = boardY;
      return;
    }

    // hover cursor — 내 알 위면 차례 여부에 따라 grab / not-allowed
    if (this.paused || this.gameFinished || this.game.phase !== 'aiming' || this.isSpectator) {
      this.ctx.canvas.style.cursor = 'crosshair';
      return;
    }
    if (!isInsideBoard(boardX, boardY)) {
      this.ctx.canvas.style.cursor = 'crosshair';
      return;
    }
    const hovered = pickStoneAt(this.game.stones, boardX, boardY);
    if (hovered && hovered.owner === this.myIndex) {
      this.ctx.canvas.style.cursor =
        this.myIndex === this.game.currentTurn ? 'grab' : 'not-allowed';
    } else {
      this.ctx.canvas.style.cursor = 'crosshair';
    }
  };

  private onMouseUp = (): void => {
    if (this.dragStoneId === null) return;
    const stoneId = this.dragStoneId;
    const sx = this.dragStartX;
    const sy = this.dragStartY;
    const mx = this.mouseBoardX ?? sx;
    const my = this.mouseBoardY ?? sy;

    // 드래그 변위 (마우스 - 알 위치)
    const dragDx = mx - sx;
    const dragDy = my - sy;

    // 너무 짧은 드래그는 cancel (의도치 않은 클릭 방지)
    if (Math.hypot(dragDx, dragDy) < STONE_RADIUS * 0.6) {
      this.dragStoneId = null;
      this.mouseBoardX = null;
      this.mouseBoardY = null;
      return;
    }

    const { vx, vy } = dragToVelocity(dragDx, dragDy);

    if (this.isHost) {
      // 호스트는 즉시 적용 + 시뮬 시작
      this.handleFlickRequest(stoneId, vx, vy);
    } else {
      // 게스트는 호스트에 요청 송신
      this.ctx.sendToPeer(encodeFlick({ stoneId, vx, vy }));
    }

    this.dragStoneId = null;
    this.mouseBoardX = null;
    this.mouseBoardY = null;
  };
}

// ============================================
// 헬퍼: players 배열을 [호스트, 게스트1, 게스트2, ...] 순으로 정렬
// ============================================

function orderPlayersHostFirst(players: Player[], hostPeerIdHint: string): Player[] {
  // 1) isHost 가 명시된 사람 먼저
  // 2) 그 외 nickname 또는 peerId 순서 (안정성 위해 peerId 사전순)
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  if (host) return [host, ...guests];
  // host 정보 없을 때 (게스트 측에서 hostPeerIdHint 만 알 때) — 그 peerId 를 첫번째로
  if (hostPeerIdHint) {
    const explicit = players.find((p) => p.peerId === hostPeerIdHint);
    if (explicit) {
      const rest = players.filter((p) => p.peerId !== hostPeerIdHint)
        .sort((a, b) => a.peerId.localeCompare(b.peerId));
      return [explicit, ...rest];
    }
  }
  // fallback — 그냥 들어온 순서
  return players.slice();
}

// ============================================
// Factory
// ============================================

export function createAlgagiGame(): GameModule {
  return new AlgagiGameModule();
}
