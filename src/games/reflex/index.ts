/**
 * 반응속도 게임 GameModule
 *
 * 규칙:
 *   - 각 플레이어가 5라운드 독립 실행
 *   - 라운드: 클릭 → 빨강 1.5~5초 대기 → 초록 → 클릭 시점(ms) 기록
 *   - 빨강 상태에서 클릭 시 실격(foul) → 다음 라운드
 *   - 평균 반응속도(ms) 낮은 순 → 승자
 *
 * 네트워크:
 *   - 라운드 끝날 때마다 rx:round_done broadcast (상대 미니뷰 갱신용)
 *   - 5라운드 모두 끝나면 rx:player_done broadcast
 *   - 호스트가 전원 완료 감지 → rx:end per-peer broadcast → ctx.endGame
 *
 * 관전자:
 *   입력/자기 라운드 X. 상대 진행만 render. rx:end 받으면 결과 화면.
 */

import type { GameContext, GameMessage, GameModule, GameResult } from '../types';
import { sound } from '../../core/sound';
import {
  ReflexRenderer,
  type OpponentState,
  type ReflexPhase,
} from './render';
import {
  encodeRoundDone, decodeRoundDone,
  encodePlayerDone, decodePlayerDone,
  encodeEnd, decodeEnd,
} from './netSync';

const TOTAL_ROUNDS = 5;
/** 빨강 대기 시간 범위 (ms) */
const WAIT_MIN_MS = 1500;
const WAIT_MAX_MS = 5000;
/** 초록 후 자동 다음 라운드까지 결과 표시 시간 */
const RESULT_DISPLAY_MS = 1400;
/** 실격 후 다음 라운드 시작까지 대기 */
const FOUL_DISPLAY_MS = 1600;

interface PlayerFinal {
  peerId: string;
  nickname: string;
  finalAvgMs: number;   // -1 = 전부 실격
  foulCount: number;
}

class ReflexGame implements GameModule {
  private ctx!: GameContext;
  private renderer!: ReflexRenderer;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;

  private opponents = new Map<string, OpponentState>();

  // 내 상태
  private phase: ReflexPhase = { kind: 'idle' };
  private currentRound = 1;
  private roundResults: number[] = []; // 성공 라운드 ms들
  private foulCount = 0;
  private waitStartedAt = 0;   // GO 상태 된 시각 (반응시간 기준점)
  private waitTimerId: number | null = null;

  // 호스트 전용: 전원의 최종 점수 집계
  private finals: Map<string, PlayerFinal> | null = null;
  private expectedPlayerCount = 0;

  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    // 상대(나 제외 플레이어) 초기화. 관전자는 모든 플레이어가 상대
    for (const p of ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      if (p.role !== 'player') continue;
      this.opponents.set(p.peerId, {
        peerId: p.peerId,
        nickname: p.nickname,
        roundsDone: 0,
        avgMs: 0,
        foulCount: 0,
        finished: false,
      });
    }

    // 호스트는 전체 플레이어 수 tracking (자기 제외 + 관전자 제외)
    if (this.isHost) {
      this.finals = new Map();
      this.expectedPlayerCount = ctx.players.filter(p => p.role === 'player').length;
    }

    this.renderer = new ReflexRenderer({ canvas: ctx.canvas });
    ctx.canvas.style.cursor = 'pointer';

    if (!this.isSpectator) {
      ctx.canvas.addEventListener('click', this.onCanvasClick);
    }

    sound.startBgm('apple-game'); // TODO: 전용 BGM은 나중에. 밝은 분위기 재사용

    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const rd = decodeRoundDone(msg);
    if (rd) {
      const opp = this.opponents.get(rd.peerId);
      if (opp) {
        opp.roundsDone = rd.roundsDone;
        opp.avgMs = rd.avgMs;
        opp.foulCount = rd.foulCount;
      }
      return;
    }

    const pd = decodePlayerDone(msg);
    if (pd) {
      const opp = this.opponents.get(pd.peerId);
      if (opp) {
        opp.finished = true;
        opp.roundsDone = TOTAL_ROUNDS;
        opp.avgMs = pd.finalAvgMs > 0 ? pd.finalAvgMs : 0;
        opp.foulCount = pd.foulCount;
      }
      // 호스트: 집계
      if (this.isHost && this.finals && !this.finals.has(pd.peerId)) {
        const nick = this.ctx.players.find(p => p.peerId === pd.peerId)?.nickname ?? '?';
        this.finals.set(pd.peerId, {
          peerId: pd.peerId,
          nickname: nick,
          finalAvgMs: pd.finalAvgMs,
          foulCount: pd.foulCount,
        });
        this.tryFinishIfAllDone();
      }
      return;
    }

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
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.waitTimerId !== null) { window.clearTimeout(this.waitTimerId); this.waitTimerId = null; }
    this.ctx?.canvas.removeEventListener('click', this.onCanvasClick);
    if (this.ctx?.canvas) this.ctx.canvas.style.cursor = '';
    this.renderer?.destroy();
    sound.stopBgm();
  }

  // ============================================
  // 메인 루프 (주로 render)
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;

    const myAvgMs = this.computeMyAvg();
    this.renderer.render({
      phase: this.phase,
      currentRound: Math.min(this.currentRound, TOTAL_ROUNDS),
      totalRounds: TOTAL_ROUNDS,
      myAvgMs,
      myFoulCount: this.foulCount,
      opponents: [...this.opponents.values()],
    });
  };

  private computeMyAvg(): number {
    if (this.roundResults.length === 0) return 0;
    const sum = this.roundResults.reduce((a, b) => a + b, 0);
    return sum / this.roundResults.length;
  }

  // ============================================
  // 라운드 상태 머신
  // ============================================

  private startWaiting(): void {
    // 빨간 상태로 진입 + 랜덤 시간 후 GO 전환
    this.phase = { kind: 'waiting' };
    const waitMs = WAIT_MIN_MS + Math.random() * (WAIT_MAX_MS - WAIT_MIN_MS);
    this.waitTimerId = window.setTimeout(() => {
      if (this.destroyed) return;
      this.waitTimerId = null;
      this.phase = { kind: 'go' };
      this.waitStartedAt = performance.now();
      sound.play('pop');
    }, waitMs);
  }

  private onCanvasClick = (): void => {
    if (this.gameFinished || this.isSpectator) return;

    switch (this.phase.kind) {
      case 'idle':
        this.startWaiting();
        break;
      case 'waiting': {
        // 실격
        if (this.waitTimerId !== null) {
          window.clearTimeout(this.waitTimerId);
          this.waitTimerId = null;
        }
        this.foulCount++;
        sound.play('button_click');
        this.phase = { kind: 'foul' };
        this.broadcastMyProgress();
        window.setTimeout(() => this.advanceToNextRound(), FOUL_DISPLAY_MS);
        break;
      }
      case 'go': {
        const ms = Math.max(0, Math.round(performance.now() - this.waitStartedAt));
        this.roundResults.push(ms);
        sound.play('tetris_clear');
        this.phase = { kind: 'result', ms };
        this.broadcastMyProgress();
        window.setTimeout(() => this.advanceToNextRound(), RESULT_DISPLAY_MS);
        break;
      }
      case 'result':
      case 'foul':
      case 'done':
        // 대기 중. 자동 진행.
        break;
    }
  };

  private advanceToNextRound(): void {
    if (this.destroyed) return;
    if (this.currentRound >= TOTAL_ROUNDS) {
      this.finishMyRounds();
      return;
    }
    this.currentRound++;
    this.startWaiting();
  }

  /** 현재까지 진행 상황을 상대에게 알림 (라운드 or 실격 완료 직후 호출) */
  private broadcastMyProgress(): void {
    this.ctx.sendToPeer(
      encodeRoundDone({
        peerId: this.myPeerId,
        roundsDone: this.roundResults.length + this.foulCount,
        avgMs: this.computeMyAvg(),
        foulCount: this.foulCount,
      }),
    );
  }

  /** 내 5라운드 전부 완료 처리 */
  private finishMyRounds(): void {
    const finalAvgMs = this.roundResults.length > 0 ? this.computeMyAvg() : -1;
    this.phase = {
      kind: 'done',
      finalAvgMs: finalAvgMs > 0 ? finalAvgMs : 0,
      foulCount: this.foulCount,
    };
    // 최종 진행 상황 broadcast + player_done 송신
    this.broadcastMyProgress();
    const donePayload = {
      peerId: this.myPeerId,
      finalAvgMs,
      foulCount: this.foulCount,
    };
    this.ctx.sendToPeer(encodePlayerDone(donePayload));

    // 호스트는 자기 완료도 집계 (자기한텐 메시지 안 오므로 직접 집어넣음)
    if (this.isHost && this.finals) {
      this.finals.set(this.myPeerId, {
        peerId: this.myPeerId,
        nickname: this.ctx.myNickname,
        finalAvgMs,
        foulCount: this.foulCount,
      });
      this.tryFinishIfAllDone();
    }
  }

  // ============================================
  // 호스트: 전원 완료 판정 + 결과 전송
  // ============================================

  private tryFinishIfAllDone(): void {
    if (!this.isHost || !this.finals || this.gameFinished) return;
    if (this.finals.size < this.expectedPlayerCount) return;

    this.gameFinished = true;

    // 평균 ms 오름차순 정렬 (작을수록 빠름=좋음). 전부 실격(-1)은 맨 뒤로.
    const entries = [...this.finals.values()].sort((a, b) => {
      const aBad = a.finalAvgMs <= 0;
      const bBad = b.finalAvgMs <= 0;
      if (aBad && !bBad) return 1;
      if (!aBad && bBad) return -1;
      if (aBad && bBad) return 0;
      return a.finalAvgMs - b.finalAvgMs;
    });

    const rankings = entries.map((e, i) => ({
      peerId: e.peerId,
      nickname: e.nickname,
      rank: i + 1,
      avgMs: e.finalAvgMs,
      foulCount: e.foulCount,
    }));

    const winnerPeerId = rankings[0]?.peerId ?? null;

    const baseSummary: Record<string, unknown> = {
      gameId: 'reflex',
      totalPlayers: rankings.length,
      rankings,
    };

    // 각 피어에게 시점별 GameResult 전송
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      let myWinner: GameResult['winner'];
      if (p.role === 'spectator') {
        myWinner = 'opponent';
      } else if (winnerPeerId === null) {
        myWinner = null;
      } else {
        myWinner = winnerPeerId === p.peerId ? 'me' : 'opponent';
      }
      const rank = rankings.find(r => r.peerId === p.peerId)?.rank ?? rankings.length;
      const peerResult: GameResult = {
        winner: myWinner,
        summary: { ...baseSummary, myPeerId: p.peerId, rank },
      };
      this.ctx.sendToPeer(encodeEnd(peerResult), { target: p.peerId });
    }

    // 호스트 본인
    const myRank = rankings.find(r => r.peerId === this.myPeerId)?.rank ?? rankings.length;
    const myResult: GameResult = {
      winner:
        winnerPeerId === null ? null :
        winnerPeerId === this.myPeerId ? 'me' : 'opponent',
      summary: { ...baseSummary, myPeerId: this.myPeerId, rank: myRank },
    };
    this.ctx.endGame(myResult);
  }
}

export function createReflexGame(): GameModule {
  return new ReflexGame();
}
