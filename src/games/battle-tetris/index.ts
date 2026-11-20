/**
 * 배틀 테트리스 GameModule — 조립 파일
 *
 * 역할:
 *   pieces + field + engine + render + netSync를 조립.
 *   키보드 입력, 루프, 네트워크 송수신, 승리 판정 담당.
 *
 * 아키텍처 (각 플레이어 로컬 시뮬레이션):
 *   각자 자기 engine으로 독립 플레이. 네트워크엔 자기 "상태 스냅샷"만 주기적 broadcast.
 *   에어하키와 달리 호스트 authoritative 아님 (테트리스는 각자 독립).
 *
 *   호스트는 "승리 판정자" 역할만: 모든 탑아웃 메시지 집계 → 마지막 생존자 판정 → bt:end broadcast.
 *
 * 메시지 흐름:
 *   - 10Hz로 내 상태 broadcast (bt:state)
 *   - 피스 고정 시 garbageSent > 0이면 랜덤 타겟에 bt:garbage 송신
 *   - 탑아웃 시 bt:topped broadcast (호스트가 랭킹 집계)
 *   - 호스트가 게임 끝 판정하면 각자에게 bt:end 전송 (시점별 시각)
 */

import type {
  GameContext,
  GameMessage,
  GameModule,
  GameResult,
  Player,
} from '../types';
import { sound } from '../../core/sound';
import { TetrisEngine, type TickEvent } from './engine';
import { TetrisRenderer, type OpponentSnapshot } from './render';
import { createEmptyField } from './field';
import {
  encodeStateSnapshot,
  decodeStateSnapshot,
  encodeGarbageAttack,
  decodeGarbageAttack,
  encodeToppedOut,
  decodeToppedOut,
  encodeEnd,
  decodeEnd,
} from './netSync';

// ============================================
// 상수
// ============================================

/** 내 상태를 이 간격으로 broadcast (ms) — 10Hz */
const STATE_BROADCAST_MS = 100;

/**
 * 키 반복 시작까지 지연 (DAS) — 60fps 기준 딱 8프레임.
 *
 * **톡 눌렀다 떼는 시간보다 길어야 한다.** 100ms 였을 땐 한 칸만 옮기려고 누른 게
 * 자주 반복으로 넘어가서 두세 칸씩 밀려버렸다 — 미끄러진다고 느낀 주범.
 * 사람이 키를 톡 누르는 시간이 보통 80~120ms 라 그 위로 올린다.
 *
 * 반대로 너무 올리면 굼뜨다. 양옆은 판을 가로지르는 일보다 **2~3칸만 옮기는 일**이
 * 훨씬 많고, 그 구간은 ARR 이 아니라 DAS 가 거의 다 먹기 때문이다.
 * 170ms 로 올렸더니 3칸 옮기는 데 270ms 가 걸려서 바로 느리다는 말이 나왔다.
 */
const DAS_DELAY_MS = 133;
/**
 * 좌우 이동 반복 간격 (ARR) — 60fps 기준 딱 2프레임, 초당 30칸.
 * 루프에서 돌리니 프레임 단위로 떨어지는 값이라야 들쭉날쭉하지 않다.
 * 45ms 는 2.7프레임이라 실제로는 3프레임(50ms)으로 반올림돼서 굼떠 보였다.
 */
const DAS_INTERVAL_MS = 33;
/** 소프트드롭(↓) 반복 간격 — 초당 120칸 */
const SOFT_DROP_INTERVAL_MS = 8;
/**
 * 소프트드롭만 한 프레임에 여러 칸 허용.
 * 아래로 쭉 내리는 게 목적이라 좌우처럼 한 칸씩 정밀할 필요가 없다.
 * 그래도 프레임이 밀렸을 때 한 번에 쏟아지지 않게 상한은 둔다.
 */
const SOFT_DROP_MAX_PER_FRAME = 2;

// ============================================
// 옵션 파싱 (방 만들기 화면에서 선택된 값)
// ============================================

function parseGravityMs(speed?: string): number {
  switch (speed) {
    case 'slow': return 1200;
    case 'fast': return 450;
    default: return 800; // normal
  }
}

function parseAttackMultiplier(strength?: string): number {
  switch (strength) {
    case 'weak': return 0.5;
    case 'strong': return 1.5;
    default: return 1; // normal
  }
}

// ============================================
// 승리 판정용 (호스트 전용)
// ============================================

interface PlayerRankState {
  alive: boolean;
  rank: number | null;
  nickname: string;
}

// ============================================
// BattleTetrisGame
// ============================================

class BattleTetrisGame implements GameModule {
  private ctx!: GameContext;
  private engine!: TetrisEngine;
  private renderer!: TetrisRenderer;
  private myPeerId = '';
  private isHost = false;

  /** 상대들의 최신 상태 (필드 + 탑아웃 + 라인수) */
  private opponents = new Map<string, OpponentSnapshot>();

  /** 호스트 전용: 승리 판정 상태 */
  private playerRanks: Map<string, PlayerRankState> | null = null;
  private nextRankToAssign = 0;

  /** 루프 제어 */
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private lastStateBroadcast = 0;
  /** state broadcast 주기(ms). 다인원이면 호스트 relay 폭주를 막으려 느슨하게 */
  private broadcastMs = STATE_BROADCAST_MS;
  private gameFinished = false;
  private destroyed = false;

  /** 통계: 게임 시작 시각 (performance.now 기준), 보낸/받은 가비지 누적.
   *  각자 로컬에서만 추적 — 결과 화면은 "내 기준" stats만 보여준다 (타인 stats는 수집 X). */
  private startedAt = 0;
  private garbageSentTotal = 0;
  private garbageReceivedTotal = 0;

  /** 일시정지 — true 면 engine.update / broadcast / 키 입력 모두 스킵 */
  private paused = false;

  // 입력 상태
  private pressedKeys = new Set<string>();
  /** 반복 키의 다음 실행 예정 시각 (performance.now 기준). 타이머 대신 게임 루프가 돌린다 */
  private repeatAt = new Map<string, number>();
  /** 좌우를 동시에 누르고 있을 때 이기는 쪽. 둘 다 돌리면 제자리에서 덜덜 떤다 */
  private lastDir: string | null = null;

  // ============================================
  // GameModule
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';

    // 엔진은 관전자에게도 생성은 해둠(타입/렌더 공용 편의상), 다만 관전자는 update/input/broadcast 를
    // 전부 호출하지 않으므로 상태가 초기값에서 움직이지 않는다. 렌더러는 isSpectator 를 보고 메인 필드를
    // 숨기고 "관전 중" 오버레이로 덮는다.
    const gravityMs = parseGravityMs(ctx.roomOptions['speed']);
    const attackMultiplier = parseAttackMultiplier(ctx.roomOptions['garbageStrength']);
    this.engine = new TetrisEngine({ gravityMs, attackMultiplier });

    // 다인원이면 state broadcast 주기를 느슨하게 — 호스트가 각 스냅샷을 N-1명에게 relay 하므로
    //   인원² 로 늘어나는 트래픽 완화 (7인 이상 180ms≈5.5Hz, 그 이하 100ms=10Hz).
    const playerCount = ctx.players.filter((p) => p.role === 'player').length;
    this.broadcastMs = playerCount > 6 ? 180 : STATE_BROADCAST_MS;

    // 렌더러
    this.renderer = new TetrisRenderer({ canvas: ctx.canvas });

    // 상대 초기화 — 관전자 기준으로는 "모든 role==='player'" 가 상대. 본인/다른 관전자 제외.
    for (const p of ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      if (p.role !== 'player') continue;
      this.opponents.set(p.peerId, {
        peerId: p.peerId,
        nickname: p.nickname,
        field: createEmptyField(),
        toppedOut: false,
        linesCleared: 0,
      });
    }

    // 호스트면 랭킹 집계용 state 생성 (관전자는 호스트가 아니므로 영향 없음)
    if (this.isHost) {
      this.playerRanks = new Map();
      for (const p of ctx.players) {
        // 관전자는 승패 판정 대상이 아님 — 호스트가 게임 시작 시점 플레이어만 관리.
        // (게임 중 합류한 관전자는 애초에 playerRanks 에 들어올 기회가 없음)
        if (p.role !== 'player') continue;
        this.playerRanks.set(p.peerId, {
          alive: true,
          rank: null,
          nickname: p.nickname,
        });
      }
      this.nextRankToAssign = this.playerRanks.size;
    }

    // 통계 시작 시각 기록 (관전자는 사실상 안 씀)
    this.startedAt = performance.now();

    // 관전자는 입력/루프 broadcast 전부 없음. 렌더 루프만 돌린다.
    if (!ctx.isSpectator) {
      this.attachInput();
    }

    // 게임 BGM 시작 (관전자도 함께)
    sound.startBgm('battle-tetris');

    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    // 1) 상태 스냅샷 (상대 미니뷰 갱신)
    const snap = decodeStateSnapshot(msg);
    if (snap) {
      const opp = this.opponents.get(snap.peerId);
      if (opp) {
        opp.field = snap.field;
        opp.toppedOut = snap.toppedOut;
        opp.linesCleared = snap.linesCleared;
      }
      return;
    }

    // 2) 가비지 공격 (내 수신 큐에 쌓음) — 관전자한테는 오지 않아야 하지만 방어적으로 무시
    const garbage = decodeGarbageAttack(msg);
    if (garbage) {
      if (this.ctx.isSpectator) return;
      if (!this.engine.state.toppedOut && !this.gameFinished) {
        this.engine.queueGarbage(garbage.count);
      }
      return;
    }

    // 3) 탑아웃 알림 (UI 갱신 + 호스트면 집계)
    const topped = decodeToppedOut(msg);
    if (topped) {
      const opp = this.opponents.get(topped.peerId);
      if (opp) opp.toppedOut = true;
      if (this.isHost) this.markPlayerOut(topped.peerId);
      return;
    }

    // 4) 게임 종료 — 플레이어(게스트)는 이 경로로 결과 화면 이동.
    //    관전자는 자기 기준 rank/rankings 가 맞지 않고 플랫폼 game_end broadcast 가 따로 오므로 무시.
    const end = decodeEnd(msg);
    if (end) {
      if (this.ctx.isSpectator) return;
      this.gameFinished = true;
      // 호스트가 보낸 rankings/rank 에 내 로컬 stats 를 합쳐서 결과 화면에 넘김
      this.ctx.endGame({
        winner: end.winner,
        summary: { ...end.summary, ...this.buildMyStatsSummary() },
      });
      return;
    }
  }

  /**
   * 결과 화면용 "내 기준" stats 묶음.
   * rank/rankings 같은 판정 정보는 호스트 쪽 finishGame이 채워 넣는다.
   * 이 함수는 "내 플레이 내용(라인/공격/수신/시간 등)" 만 책임.
   */
  private buildMyStatsSummary(): Record<string, unknown> {
    const s = this.engine.state;
    return {
      // gameId 마커 — resultScreen이 테트리스 전용 UI로 분기할 때 사용
      gameId: 'battle-tetris',
      // 결과 화면이 rankings 리스트에서 "나" 행을 강조하려고 peerId 필요
      myPeerId: this.myPeerId,
      myStats: {
        linesCleared: s.totalLinesCleared,
        garbageSent: this.garbageSentTotal,
        garbageReceived: this.garbageReceivedTotal,
        durationMs: Math.max(0, performance.now() - this.startedAt),
        piecesPlaced: s.piecesPlaced,
        tetrisCount: s.tetrisCount,
        maxCombo: s.maxCombo,
      },
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.gameFinished = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.detachInput();
    this.renderer?.destroy();
    sound.stopBgm();
  }

  /** 일시정지 토글. paused 풀릴 때 lastFrameTime 리셋해 dt 폭주 방지. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!paused) {
      this.lastFrameTime = 0;
    }
  }

  // ============================================
  // 메인 루프
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;

    const now = performance.now();
    const dt = this.lastFrameTime === 0 ? 16 : Math.min(now - this.lastFrameTime, 100);
    this.lastFrameTime = now;

    // 관전자/일시정지 시 engine.update / broadcast 스킵 — 상대 스냅샷 받은 것만 렌더
    if (!this.ctx.isSpectator && !this.gameFinished && !this.paused) {
      // 키 반복을 중력보다 먼저 — 이번 프레임에 민 칸이 이번 프레임에 그려진다
      this.tickRepeat(now);
      const events = this.engine.update(dt);
      if (events.length > 0) this.handleEngineEvents(events);

      // 10Hz state broadcast (탑아웃 후에도 한 번은 더 보냄 → 상대 미니뷰 갱신)
      if (now - this.lastStateBroadcast >= this.broadcastMs) {
        this.broadcastState();
        this.lastStateBroadcast = now;
      }
    }

    // 렌더는 매 프레임 (탑아웃 오버레이 + 상대 미니뷰 최신 반영).
    // 관전자는 spectator 옵션 켜서 메인 필드/HOLD/NEXT 대신 "관전 중" 오버레이 표시.
    this.renderer.render(
      this.engine.state,
      [...this.opponents.values()],
      { spectator: this.ctx.isSpectator },
    );
  };

  private handleEngineEvents(events: readonly TickEvent[]): void {
    for (const ev of events) {
      switch (ev.kind) {
        case 'piece_locked':
          // 사운드: 4줄 동시면 "테트리스", 1~3줄이면 "clear", 못 지웠으면 "lock"
          if (ev.linesCleared >= 4) {
            sound.play('tetris_tetris');
          } else if (ev.linesCleared > 0) {
            sound.play('tetris_clear');
          } else {
            sound.play('tetris_lock');
          }
          if (ev.garbageSent > 0) {
            this.garbageSentTotal += ev.garbageSent;
            this.sendGarbageToRandomAlive(ev.garbageSent);
          }
          break;

        case 'topped_out':
          sound.play('tetris_topout');
          // 내 탑아웃: broadcast + (호스트면) 자기 집계
          this.ctx.sendToPeer(encodeToppedOut(this.myPeerId));
          // 상대들의 UI에도 즉시 반영되도록 내 snapshot 한 번 더
          this.broadcastState();
          if (this.isHost) this.markPlayerOut(this.myPeerId);
          break;

        case 'garbage_injected':
          this.garbageReceivedTotal += ev.count;
          sound.play('tetris_garbage');
          // 방금 바닥에서 올라온 방해줄 강조 플래시
          this.renderer.flashGarbage(ev.count);
          break;

        case 'unbreakable_injected':
          // 시간 경과로 자동 푸시된 안 깨지는 줄 — 가비지와 같은 사운드 재활용
          sound.play('tetris_garbage');
          this.renderer.flashGarbage(1);
          break;
      }
    }
  }

  private broadcastState(): void {
    this.ctx.sendToPeer(
      encodeStateSnapshot(
        this.myPeerId,
        this.engine.state.field,
        this.engine.state.toppedOut,
        this.engine.state.totalLinesCleared,
      ),
    );
  }

  /** 살아있는 상대 중 랜덤 1명에게 가비지 공격 */
  private sendGarbageToRandomAlive(count: number): void {
    const targets: string[] = [];
    for (const opp of this.opponents.values()) {
      if (!opp.toppedOut) targets.push(opp.peerId);
    }
    if (targets.length === 0) return;
    const target = targets[Math.floor(Math.random() * targets.length)]!;
    this.ctx.sendToPeer(encodeGarbageAttack(count), { target });
  }

  // ============================================
  // 호스트 전용 — 승리 판정
  // ============================================

  /** 플레이어 이탈 처리.
   *  - 상대 미니뷰에서 제거(호스트·게스트 공통) — 안 하면 나간 사람 보드가 유령으로 남음.
   *  - 호스트: 승리 판정에서도 제외. 안 그러면 last-one-standing 이 나간 사람을 계속
   *    '생존'으로 세어 생존자가 1명이 돼도 게임이 영영 안 끝난다. 이탈=지금 탈락으로 처리. */
  onPeerLeft(peerId: string): void {
    this.opponents.delete(peerId);
    this.markPlayerOut(peerId); // markPlayerOut 내부에서 isHost/gameFinished/존재 가드
  }

  private markPlayerOut(peerId: string): void {
    if (!this.isHost || !this.playerRanks || this.gameFinished) return;
    const s = this.playerRanks.get(peerId);
    if (!s || !s.alive) return;

    s.alive = false;
    s.rank = this.nextRankToAssign--;

    // 생존자 1명 이하면 종료
    const aliveEntries = [...this.playerRanks.entries()].filter(([, ps]) => ps.alive);
    if (aliveEntries.length <= 1) {
      if (aliveEntries.length === 1) {
        // 마지막 생존자를 1등으로 마킹
        aliveEntries[0]![1].rank = 1;
      }
      this.finishGame();
    }
  }

  private finishGame(): void {
    if (this.gameFinished || !this.playerRanks) return;
    this.gameFinished = true;

    const totalPlayers = this.playerRanks.size;
    const rankings = [...this.playerRanks.entries()]
      .map(([peerId, s]) => ({
        peerId,
        nickname: s.nickname,
        rank: s.rank ?? totalPlayers,
      }))
      .sort((a, b) => a.rank - b.rank);

    const winnerEntry = rankings.find((r) => r.rank === 1);
    const winnerPeerId = winnerEntry?.peerId ?? null;

    // 각 게스트에게 시점별 결과 전송
    for (const [peerId, state] of this.playerRanks) {
      if (peerId === this.myPeerId) continue;
      const peerResult: GameResult = {
        winner:
          winnerPeerId === null ? null :
          winnerPeerId === peerId ? 'me' : 'opponent',
        summary: {
          rank: state.rank ?? totalPlayers,
          totalPlayers,
          rankings,
        },
      };
      this.ctx.sendToPeer(encodeEnd(peerResult), { target: peerId });
    }

    // 내 결과로 endGame (rankings + 내 로컬 stats 합성)
    const myState = this.playerRanks.get(this.myPeerId);
    const myResult: GameResult = {
      winner:
        winnerPeerId === null ? null :
        winnerPeerId === this.myPeerId ? 'me' : 'opponent',
      summary: {
        rank: myState?.rank ?? totalPlayers,
        totalPlayers,
        rankings,
        ...this.buildMyStatsSummary(),
      },
    };
    this.ctx.endGame(myResult);
  }

  // ============================================
  // 입력 (키보드 + DAS)
  // ============================================

  private attachInput(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  private detachInput(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.clearKeys();
  }

  private clearKeys(): void {
    this.pressedKeys.clear();
    this.repeatAt.clear();
    this.lastDir = null;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // 이미 눌려있으면 브라우저 자동 반복 무시 (우리가 DAS로 관리)
    if (this.pressedKeys.has(e.code)) {
      if (this.isGameKey(e.code)) e.preventDefault();
      return;
    }
    if (!this.isGameKey(e.code)) return;

    this.pressedKeys.add(e.code);
    e.preventDefault();

    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') this.lastDir = e.code;

    // 즉시 한 번 실행
    this.performKey(e.code);

    // 반복 키면 DAS 세팅
    if (this.isRepeatKey(e.code)) this.repeatAt.set(e.code, performance.now() + DAS_DELAY_MS);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.pressedKeys.delete(e.code);
    this.repeatAt.delete(e.code);
    // 이기고 있던 방향을 뗐으면 반대쪽에게 넘긴다.
    // 이때 DAS 부터 다시 — 안 그러면 손을 떼자마자 반대로 쭉 쏘아버린다.
    if (this.lastDir === e.code) {
      const other = e.code === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
      this.lastDir = this.pressedKeys.has(other) ? other : null;
      if (this.lastDir) this.repeatAt.set(this.lastDir, performance.now() + DAS_DELAY_MS);
    }
  };

  private onBlur = (): void => {
    // 포커스 잃으면 모든 키 해제 (유령키 방지)
    this.clearKeys();
  };

  /**
   * 꾹 누른 키의 반복 — setInterval 이 아니라 **게임 루프**에서 돌린다.
   *
   * 타이머로 돌리면 프레임이 한 번 밀릴 때 콜백이 그만큼 몰려서 한 프레임에
   * 서너 칸을 순간이동하듯 건너뛴다. 20ms 간격이면 60fps 한 프레임(16ms)에
   * 한 번꼴이라 조금만 버벅여도 바로 티가 났다 — 미끄러져 보이던 또 하나의 이유.
   * 루프에서 돌리면 한 프레임에 많아야 한 칸으로 묶인다.
   */
  private tickRepeat(now: number): void {
    for (const code of this.pressedKeys) {
      const due = this.repeatAt.get(code);
      if (due === undefined || now < due) continue;
      // 좌우 동시 입력은 나중에 누른 쪽만 움직인다
      if ((code === 'ArrowLeft' || code === 'ArrowRight') && this.lastDir !== code) continue;

      if (code === 'ArrowDown') {
        // 8ms 간격은 한 프레임(16ms)보다 짧다 → 밀린 만큼 상한까지 채워서 내린다
        const n = Math.min(SOFT_DROP_MAX_PER_FRAME, 1 + Math.floor((now - due) / SOFT_DROP_INTERVAL_MS));
        for (let i = 0; i < n; i++) this.performKey(code);
        this.repeatAt.set(code, now + SOFT_DROP_INTERVAL_MS);
        continue;
      }

      this.performKey(code);
      // due 에 더하지 않고 now 기준으로 다시 잡는다. 더하면 밀린 프레임만큼 몰아서 실행된다
      this.repeatAt.set(code, now + DAS_INTERVAL_MS);
    }
  }

  private performKey(code: string): void {
    if (this.gameFinished || this.engine.state.toppedOut || this.paused) return;

    switch (code) {
      case 'ArrowLeft':  this.engine.moveLeft(); break;
      case 'ArrowRight': this.engine.moveRight(); break;
      case 'ArrowDown':  this.engine.softDrop(); break;
      case 'ArrowUp':
      case 'KeyX':
        if (this.engine.rotateCW()) sound.play('tetris_rotate');
        break;
      case 'KeyZ':
        if (this.engine.rotateCCW()) sound.play('tetris_rotate');
        break;
      case 'Space':
        this.engine.hardDrop();
        sound.play('tetris_harddrop');
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
      case 'KeyC':
        if (this.engine.hold()) sound.play('tetris_hold');
        break;
    }
  }

  private isGameKey(code: string): boolean {
    return (
      code === 'ArrowLeft' || code === 'ArrowRight' ||
      code === 'ArrowDown' || code === 'ArrowUp' ||
      code === 'KeyX' || code === 'KeyZ' || code === 'KeyC' ||
      code === 'ShiftLeft' || code === 'ShiftRight' || code === 'Space'
    );
  }

  private isRepeatKey(code: string): boolean {
    return code === 'ArrowLeft' || code === 'ArrowRight' || code === 'ArrowDown';
  }
}

// ============================================
// Factory (registry에서 사용)
// ============================================

export function createBattleTetrisGame(): GameModule {
  return new BattleTetrisGame();
}

// TS unused warning 방지: Player 타입이 import 됐지만 직접 안 쓰이면 제거
// (향후 타입 확장 시 참조할 수 있게 타입-only re-export는 하지 않음)
export type { Player };
