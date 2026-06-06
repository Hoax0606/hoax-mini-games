/**
 * 끝말잇기 GameModule — 조립
 *
 * 아키텍처 (호스트 authoritative 턴제):
 *   호스트가 game state 단독 보관 + 검증 + 타임아웃 판정.
 *   게스트는 자기 차례에 wc:submit 송신, 호스트로부터 accepted/rejected 받음.
 *   호스트가 wc:accepted broadcast 또는 wc:timeout broadcast 로 모두에게 알림.
 *
 * 게스트 합류:
 *   wc:hello → 호스트 wc:sync (전체 state)
 *
 * UI 흐름:
 *   - Canvas 에 큰 마지막 단어 + 다음 시작 글자 + 타이머
 *   - HTML input (자기 차례에만 활성) 으로 단어 입력
 *   - 우측 패널: 단어 히스토리 + 각 플레이어 상태
 *
 * 일시정지:
 *   turnStartedAt 보정 + 입력창 disable.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  createInitialGame,
  validateSubmission,
  applySubmission,
  eliminatePlayer,
  allowedStartLetters,
  TURN_TIME_MS,
  TIMEOUT_GRACE_MS,
  type WordChainGame,
  type PlayerIndex,
} from './rules';
import {
  encodeHello, decodeHello,
  encodeSync, decodeSync,
  encodeSubmit, decodeSubmit,
  encodeAccepted, decodeAccepted,
  encodeRejected, decodeRejected,
  encodeTimeout, decodeTimeout,
  encodeEnd, decodeEnd,
} from './netSync';
import { WordChainRenderer, type RenderState } from './render';

/** 결과 화면 이동 전 결과 오버레이 여운 (ms) */
const END_GAME_DELAY_MS = 1800;

class WordChainGameModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: WordChainRenderer;
  private game!: WordChainGame;

  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private myIndex: PlayerIndex | -1 = -1;

  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;
  private endGameScheduled = false;

  // 입력
  private inputEl: HTMLInputElement | null = null;
  private inputContainer: HTMLDivElement | null = null;
  private rejectMessageEl: HTMLDivElement | null = null;
  /** 거절 메시지 자동 사라짐 타이머 */
  private rejectMessageTimer: number | null = null;

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

    const playerList = ctx.players.filter((p) => p.role === 'player');
    const ordered = orderPlayersHostFirst(playerList);

    if (this.isHost) {
      this.game = createInitialGame(
        ordered.map((p) => ({ peerId: p.peerId, nickname: p.nickname })),
      );
      this.game.turnStartedAt = performance.now();
    } else {
      // 게스트는 호스트가 sync 보내기 전 placeholder
      this.game = createInitialGame(
        ordered.map((p) => ({ peerId: p.peerId, nickname: p.nickname })),
      );
    }

    if (!this.isSpectator) {
      const me = this.game.players.find((p) => p.peerId === this.myPeerId);
      this.myIndex = me?.index ?? -1;
    }

    this.renderer = new WordChainRenderer({ canvas: ctx.canvas });
    ctx.canvas.style.cursor = 'default';

    // HTML 입력창 마운트 (canvas 부모 끝에)
    this.mountInputUI();

    sound.startBgm('word-chain');

    // 게스트/관전자는 호스트에게 초기 동기화 요청
    if (!this.isHost) {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    } else {
      // 호스트는 자기 차례면 즉시 입력 활성
      this.refreshInputEnabled();
    }

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
        this.refreshInputEnabled();
      }
      return;
    }

    // submit → 호스트가 검증 후 broadcast or reject
    const submit = decodeSubmit(msg);
    if (submit) {
      if (this.isHost) this.handleSubmitFromGuest(submit.word, msg);
      return;
    }

    // accepted → 모두가 history 갱신 + 턴 진행
    const accepted = decodeAccepted(msg);
    if (accepted) {
      // 호스트는 이미 적용했으니 자기 호출 무시 (echo 가능성)
      if (!this.isHost) {
        this.game.history.push({
          word: accepted.word,
          byPeerId: accepted.byPeerId,
          byNickname: accepted.byNickname,
        });
        this.game.usedWords.add(accepted.word);
        this.game.currentTurn = accepted.nextTurn;
        this.game.turnStartedAt = performance.now(); // 자기 시계 기준으로 재시작
        this.refreshInputEnabled();
      }
      sound.play('pop');
      return;
    }

    // rejected → 송신자에게만 옴. 거절 메시지 표시.
    const rejected = decodeRejected(msg);
    if (rejected) {
      this.showRejectMessage(rejected.message);
      sound.play('button_click');
      return;
    }

    // timeout → 모두가 victim 탈락 처리
    const tm = decodeTimeout(msg);
    if (tm) {
      if (!this.isHost) {
        const victim = this.game.players.find((p) => p.index === tm.victimIndex);
        if (victim) {
          victim.alive = false;
          victim.outReason = 'timeout';
        }
        if (tm.nextTurn === -1) {
          // 게임 종료 — winnerPeerId 는 wc:end 에서 받음
          this.game.phase = 'ended';
        } else {
          this.game.currentTurn = tm.nextTurn as PlayerIndex;
          this.game.turnStartedAt = performance.now();
        }
        this.refreshInputEnabled();
      }
      sound.play('button_click');
      return;
    }

    // end → 결과 화면 이동
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
    this.unmountInputUI();
    this.renderer?.destroy();
    sound.stopBgm();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.pauseStart = performance.now();
    } else if (this.pauseStart > 0) {
      const pausedFor = performance.now() - this.pauseStart;
      this.game.turnStartedAt += pausedFor;
      this.pauseStart = 0;
    }
    this.refreshInputEnabled();
  }

  // ============================================
  // 루프 — 호스트만 타임아웃 감시
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;

    const now = performance.now();

    if (this.isHost && !this.paused && this.game.phase === 'aiming') {
      const elapsed = now - this.game.turnStartedAt;
      if (elapsed > TURN_TIME_MS + TIMEOUT_GRACE_MS) {
        this.handleTimeoutAsHost(now);
      }
    }

    // 렌더
    const renderState: RenderState = {
      game: this.game,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      now,
    };
    this.renderer.render(renderState);
  };

  // ============================================
  // 호스트 처리
  // ============================================

  private handleSubmitFromGuest(word: string, msg: GameMessage): void {
    if (this.game.phase !== 'aiming') return;
    // 송신자 확인 — game_msg 의 from 필드. 다만 GameContext 에서 노출 안 됨 → 게임 로직 단순 처리.
    // currentTurn 인 사람만 제출 가능하다는 가정.
    void msg;

    const currentPlayer = this.game.players.find((p) => p.index === this.game.currentTurn);
    if (!currentPlayer) return;

    const result = validateSubmission(this.game, word.trim());
    if (!result.ok) {
      // 거절 — 송신자에게만 (target 지정). 송신자는 currentPlayer.
      this.ctx.sendToPeer(
        encodeRejected({ reason: result.reason, message: result.message }),
        { target: currentPlayer.peerId },
      );
      return;
    }

    // 통과 — 호스트 로컬에 적용 + broadcast
    const trimmed = word.trim();
    const now = performance.now();
    applySubmission(this.game, trimmed, currentPlayer.peerId, currentPlayer.nickname, now);
    this.ctx.sendToPeer(encodeAccepted({
      word: trimmed,
      byPeerId: currentPlayer.peerId,
      byNickname: currentPlayer.nickname,
      nextTurn: this.game.currentTurn,
      turnStartedAt: now,
    }));
    sound.play('pop');
    this.refreshInputEnabled();
  }

  /** 호스트 본인이 input 제출했을 때 — 같은 검증 흐름. */
  private handleOwnSubmit(word: string): void {
    if (this.game.phase !== 'aiming') return;
    if (this.myIndex !== this.game.currentTurn) return;

    const result = validateSubmission(this.game, word.trim());
    if (!result.ok) {
      this.showRejectMessage(result.message);
      sound.play('button_click');
      return;
    }

    const trimmed = word.trim();
    const me = this.game.players.find((p) => p.index === this.myIndex);
    if (!me) return;
    const now = performance.now();
    applySubmission(this.game, trimmed, me.peerId, me.nickname, now);
    this.ctx.sendToPeer(encodeAccepted({
      word: trimmed,
      byPeerId: me.peerId,
      byNickname: me.nickname,
      nextTurn: this.game.currentTurn,
      turnStartedAt: now,
    }));
    sound.play('pop');
    if (this.inputEl) this.inputEl.value = '';
    this.refreshInputEnabled();
  }

  private handleTimeoutAsHost(now: number): void {
    const victim = this.game.currentTurn;
    const { ended } = eliminatePlayer(this.game, victim, 'timeout', now);
    this.ctx.sendToPeer(encodeTimeout({
      victimIndex: victim,
      nextTurn: ended ? -1 : this.game.currentTurn,
      turnStartedAt: now,
    }));
    sound.play('button_click');
    if (ended) {
      this.finishAsHost();
    }
    this.refreshInputEnabled();
  }

  private finishAsHost(): void {
    if (this.gameFinished) return;
    this.gameFinished = true;

    const baseSummary: Record<string, unknown> = {
      gameId: 'word-chain',
      totalRounds: this.game.history.length - 1, // 시드 단어 제외
      winnerNickname:
        this.game.players.find((p) => p.peerId === this.game.winnerPeerId)?.nickname ?? null,
      players: this.game.players.map((p) => ({
        peerId: p.peerId,
        nickname: p.nickname,
        alive: p.alive,
        outReason: p.outReason ?? null,
      })),
    };

    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      const myWinner: GameResult['winner'] = this.computeWinnerForPeer(p);
      const result: GameResult = { winner: myWinner, summary: { ...baseSummary, myPeerId: p.peerId } };
      this.ctx.sendToPeer(encodeEnd(result), { target: p.peerId });
    }

    const myResult: GameResult = {
      winner: this.computeWinnerForPeer({
        peerId: this.myPeerId, nickname: '', isHost: true, role: 'player',
      }),
      summary: { ...baseSummary, myPeerId: this.myPeerId },
    };
    this.scheduleEndGame(myResult);
  }

  private computeWinnerForPeer(p: Player): GameResult['winner'] {
    if (this.game.winnerPeerId === null) return null;
    if (p.role === 'spectator') return 'opponent';
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
  // 입력 UI — HTML input 으로
  // ============================================

  private mountInputUI(): void {
    const parent = this.ctx.canvas.parentElement;
    if (!parent) return;

    const container = document.createElement('div');
    container.className = 'wc-input-container';
    container.innerHTML = `
      <div class="wc-input-hint" id="wc-input-hint">잠시만요…</div>
      <form class="wc-input-form" id="wc-input-form" autocomplete="off">
        <input type="text" class="wc-input" id="wc-input" maxlength="10"
               placeholder="단어 입력 후 Enter" />
        <button type="submit" class="wc-input-submit">제출</button>
      </form>
      <div class="wc-reject-message" id="wc-reject-message"></div>
    `;
    parent.appendChild(container);

    this.inputContainer = container;
    this.inputEl = container.querySelector<HTMLInputElement>('#wc-input');
    this.rejectMessageEl = container.querySelector<HTMLDivElement>('#wc-reject-message');

    const form = container.querySelector<HTMLFormElement>('#wc-input-form');
    form?.addEventListener('submit', this.onSubmitForm);

    this.refreshInputEnabled();
  }

  private unmountInputUI(): void {
    if (this.rejectMessageTimer !== null) {
      window.clearTimeout(this.rejectMessageTimer);
      this.rejectMessageTimer = null;
    }
    this.inputContainer?.remove();
    this.inputContainer = null;
    this.inputEl = null;
    this.rejectMessageEl = null;
  }

  private onSubmitForm = (e: Event): void => {
    e.preventDefault();
    if (!this.inputEl) return;
    const word = this.inputEl.value.trim();
    if (!word) return;
    if (this.paused || this.gameFinished) return;
    if (this.isSpectator) return;
    if (this.myIndex !== this.game.currentTurn) return;
    if (this.game.phase !== 'aiming') return;

    if (this.isHost) {
      this.handleOwnSubmit(word);
    } else {
      this.ctx.sendToPeer(encodeSubmit(word));
      this.inputEl.value = '';
      // 거절 가능성 있어 자체 비활성은 안 함 — accepted/rejected 오면 그때 처리
    }
  };

  /** 입력창 활성/비활성 + hint 텍스트 갱신 */
  private refreshInputEnabled(): void {
    if (!this.inputEl || !this.inputContainer) return;
    const hint = this.inputContainer.querySelector<HTMLDivElement>('#wc-input-hint');

    const myTurn = !this.isSpectator && this.myIndex === this.game.currentTurn;
    const isAiming = this.game.phase === 'aiming';
    const myAlive = !this.isSpectator
      ? this.game.players.find((p) => p.peerId === this.myPeerId)?.alive
      : false;

    const enabled = myTurn && isAiming && !!myAlive && !this.paused && !this.gameFinished;
    this.inputEl.disabled = !enabled;

    if (hint) {
      if (this.isSpectator) {
        hint.textContent = '👀 관전 중';
      } else if (this.game.phase === 'ended') {
        hint.textContent = '게임 끝';
      } else if (!myAlive) {
        hint.textContent = '😭 탈락했어요';
      } else if (!myTurn) {
        const cur = this.game.players.find((p) => p.index === this.game.currentTurn);
        hint.textContent = `⏳ ${cur?.nickname ?? '?'} 차례`;
      } else {
        const lastWord = this.game.history[this.game.history.length - 1]!.word;
        const lastChar = lastWord[lastWord.length - 1]!;
        const allowed = allowedStartLetters(lastChar);
        hint.textContent = `🎯 "${[...allowed].join(' / ')}" 로 시작하는 단어`;
      }
    }

    if (enabled) {
      // 차례 들어오면 포커스 — UX 향상
      window.setTimeout(() => this.inputEl?.focus(), 10);
    }
  }

  private showRejectMessage(message: string): void {
    if (!this.rejectMessageEl) return;
    this.rejectMessageEl.textContent = `❌ ${message}`;
    this.rejectMessageEl.classList.add('is-visible');
    if (this.rejectMessageTimer !== null) {
      window.clearTimeout(this.rejectMessageTimer);
    }
    this.rejectMessageTimer = window.setTimeout(() => {
      this.rejectMessageEl?.classList.remove('is-visible');
      this.rejectMessageTimer = null;
    }, 2400);
  }
}

// ============================================
// 헬퍼
// ============================================

function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

// ============================================
// Factory
// ============================================

export function createWordChainGame(): GameModule {
  return new WordChainGameModule();
}
