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
/** 키 반복 간격 (ARR) */
const DAS_INTERVAL_MS = 45;

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

    // 엔진 생성 (방 옵션 반영)
    const gravityMs = parseGravityMs(ctx.roomOptions['speed']);
    const attackMultiplier = parseAttackMultiplier(ctx.roomOptions['garbageStrength']);
    this.engine = new TetrisEngine({ gravityMs, attackMultiplier });

    // 렌더러
    this.renderer = new TetrisRenderer({ canvas: ctx.canvas });

    // 상대 초기화
    for (const p of ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      this.opponents.set(p.peerId, {
        peerId: p.peerId,
        nickname: p.nickname,
        field: createEmptyField(),
        toppedOut: false,
        linesCleared: 0,
      });
    }

    // 호스트면 랭킹 집계용 state 생성
    if (this.isHost) {
      this.playerRanks = new Map();
      for (const p of ctx.players) {
        this.playerRanks.set(p.peerId, {
          alive: true,
          rank: null,
          nickname: p.nickname,
        });
      }
      this.nextRankToAssign = ctx.players.length;
    }

    // 입력 등록 + 루프 시작
    this.attachInput();
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

    // 2) 가비지 공격 (내 수신 큐에 쌓음)
    const garbage = decodeGarbageAttack(msg);
    if (garbage) {
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

    // 4) 게임 종료 (게스트 전용 — 호스트는 자기 finishGame에서 처리)
    const end = decodeEnd(msg);
    if (end) {
      this.gameFinished = true;
      this.ctx.endGame(end);
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
    this.renderer?.destroy();
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

    // 게임 진행 (탑아웃 후엔 engine.update가 no-op이지만 호출은 유지)
    if (!this.gameFinished) {
      const events = this.engine.update(dt);
      if (events.length > 0) this.handleEngineEvents(events);

      // 10Hz state broadcast (탑아웃 후에도 한 번은 더 보냄 → 상대 미니뷰 갱신)
      if (now - this.lastStateBroadcast >= STATE_BROADCAST_MS) {
        this.broadcastState();
        this.lastStateBroadcast = now;
      }
    }

    // 렌더는 매 프레임 (탑아웃 오버레이 + 상대 미니뷰 최신 반영)
    this.renderer.render(this.engine.state, [...this.opponents.values()]);
  };

  private handleEngineEvents(events: readonly TickEvent[]): void {
    for (const ev of events) {
      switch (ev.kind) {
        case 'piece_locked':
          if (ev.garbageSent > 0) {
            this.sendGarbageToRandomAlive(ev.garbageSent);
          }
          break;

        case 'topped_out':
          // 내 탑아웃: broadcast + (호스트면) 자기 집계
          this.ctx.sendToPeer(encodeToppedOut(this.myPeerId));
          // 상대들의 UI에도 즉시 반영되도록 내 snapshot 한 번 더
          this.broadcastState();
          if (this.isHost) this.markPlayerOut(this.myPeerId);
          break;

        case 'garbage_injected':
          // 이펙트 훅 자리 (파티클 등) — 지금은 무처리
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

    // 내 결과로 endGame
    const myState = this.playerRanks.get(this.myPeerId);
    const myResult: GameResult = {
      winner:
        winnerPeerId === null ? null :
        winnerPeerId === this.myPeerId ? 'me' : 'opponent',
      summary: {
        rank: myState?.rank ?? totalPlayers,
        totalPlayers,
        rankings,
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
    const interval = window.setInterval(() => {
      if (!this.pressedKeys.has(code)) {
        window.clearInterval(interval);
        return;
      }
      this.performKey(code);
    }, DAS_INTERVAL_MS);
    const existing = this.repeatTimers.get(code) ?? {};
    this.repeatTimers.set(code, { ...existing, interval });
  }

  private performKey(code: string): void {
    if (this.gameFinished || this.engine.state.toppedOut) return;

    switch (code) {
      case 'ArrowLeft':  this.engine.moveLeft(); break;
      case 'ArrowRight': this.engine.moveRight(); break;
      case 'ArrowDown':  this.engine.softDrop(); break;
      case 'ArrowUp':
      case 'KeyX':       this.engine.rotateCW(); break;
      case 'KeyZ':       this.engine.rotateCCW(); break;
      case 'Space':      this.engine.hardDrop(); break;
      case 'ShiftLeft':
      case 'ShiftRight':
      case 'KeyC':       this.engine.hold(); break;
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
