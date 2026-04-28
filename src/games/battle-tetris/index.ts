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

/** 키 반복 시작까지 지연 (DAS) — 좌우/아래 이동만 반복 */
const DAS_DELAY_MS = 160;
/** 좌우 이동 반복 간격 (ARR) */
const DAS_INTERVAL_MS = 45;
/** 소프트드롭(↓) 반복 간격 — 좌우보다 빠르게. 대략 40칸/초 */
const SOFT_DROP_INTERVAL_MS = 25;

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
  private repeatTimers = new Map<string, { timeout?: number; interval?: number }>();

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
      const events = this.engine.update(dt);
      if (events.length > 0) this.handleEngineEvents(events);

      // 10Hz state broadcast (탑아웃 후에도 한 번은 더 보냄 → 상대 미니뷰 갱신)
      if (now - this.lastStateBroadcast >= STATE_BROADCAST_MS) {
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
    // 반복 타이머 정리
    for (const t of this.repeatTimers.values()) {
      if (t.timeout !== undefined) window.clearTimeout(t.timeout);
      if (t.interval !== undefined) window.clearInterval(t.interval);
    }
    this.repeatTimers.clear();
    this.pressedKeys.clear();
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

    // 즉시 한 번 실행
    this.performKey(e.code);

    // 반복 키면 DAS 세팅
    if (this.isRepeatKey(e.code)) {
      const to = window.setTimeout(() => this.startRepeating(e.code), DAS_DELAY_MS);
      this.repeatTimers.set(e.code, { timeout: to });
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.pressedKeys.delete(e.code);
    const t = this.repeatTimers.get(e.code);
    if (t) {
      if (t.timeout !== undefined) window.clearTimeout(t.timeout);
      if (t.interval !== undefined) window.clearInterval(t.interval);
      this.repeatTimers.delete(e.code);
    }
  };

  private onBlur = (): void => {
    // 포커스 잃으면 모든 키 해제 (유령키 방지)
    this.pressedKeys.clear();
    for (const t of this.repeatTimers.values()) {
      if (t.timeout !== undefined) window.clearTimeout(t.timeout);
      if (t.interval !== undefined) window.clearInterval(t.interval);
    }
    this.repeatTimers.clear();
  };

  private startRepeating(code: string): void {
    if (!this.pressedKeys.has(code)) return;
    // 아래키(소프트드롭)는 좌우 이동보다 빠른 간격으로 반복
    const intervalMs = code === 'ArrowDown' ? SOFT_DROP_INTERVAL_MS : DAS_INTERVAL_MS;
    const interval = window.setInterval(() => {
      if (!this.pressedKeys.has(code)) {
        window.clearInterval(interval);
        return;
      }
      this.performKey(code);
    }, intervalMs);
    const existing = this.repeatTimers.get(code) ?? {};
    this.repeatTimers.set(code, { ...existing, interval });
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
