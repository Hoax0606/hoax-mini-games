/**
 * 폭탄 돌리기 끝말잇기 GameModule — 조립.
 *
 * 아키텍처(호스트 authoritative, word-chain 기반):
 *   - 단어 검증/두음/사전/시작단어는 word-chain 순수 함수 재사용.
 *   - 턴당 타이머 없음. 대신 호스트만 아는 **숨겨진 폭탄 타이머**(30초~3분 랜덤).
 *     폭탄이 터지는 순간 currentTurn(=폭탄 든 사람)이 패배 → bw:end.
 *   - 시작 플레이어는 peer 시드로 랜덤(전원 동일 계산, sync 불필요).
 *   - 틀린 단어는 거절만(탈락 없음, 재입력). 압박은 오직 폭탄.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  createInitialGame, validateSubmission, applySubmission, seedFromPeers,
  type WordChainGame, type PlayerIndex,
} from '../word-chain/rules';
import { randomBombMs, startTurnFromPeers } from './rules';
import {
  encodeHello, decodeHello,
  encodeSync, decodeSync,
  encodeSubmit, decodeSubmit,
  encodeAccepted, decodeAccepted,
  encodeRejected, decodeRejected,
  encodeEnd, decodeEnd,
} from './netSync';
import { BombRenderer, type RenderState } from './render';

const END_GAME_DELAY_MS = 2200; // 폭발 여운 살짝 더 길게

class BombWordChainModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: BombRenderer;
  private game!: WordChainGame;

  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private myIndex: PlayerIndex | -1 = -1;

  /** 폭발로 패배한 사람 (렌더 오버레이용) */
  private loserPeerId: string | null = null;

  // 호스트 전용 숨겨진 폭탄 타이머
  private bombStartedAt = 0;
  private bombDurationMs = 0;

  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;
  private endGameScheduled = false;

  // 입력 UI (word-chain 클래스 재사용)
  private inputEl: HTMLInputElement | null = null;
  private inputContainer: HTMLDivElement | null = null;
  private rejectMessageEl: HTMLDivElement | null = null;
  private rejectMessageTimer: number | null = null;

  private paused = false;
  private pauseStart = 0;

  // ============================================
  // GameModule
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    const ordered = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'));
    const peerIds = ordered.map((p) => p.peerId);
    const sharedSeed = seedFromPeers(peerIds); // 시작단어 시드 (전원 동일)
    this.game = createInitialGame(
      ordered.map((p) => ({ peerId: p.peerId, nickname: p.nickname })),
      sharedSeed,
    );
    // 랜덤 시작 플레이어 — 전원 동일 계산(공개돼도 무방)
    this.game.currentTurn = startTurnFromPeers(peerIds, ordered.length) as PlayerIndex;

    if (!this.isSpectator) {
      this.myIndex = this.game.players.find((p) => p.peerId === this.myPeerId)?.index ?? -1;
    }

    // 호스트만 폭탄 타이머 세팅 (숨김)
    if (this.isHost) {
      this.bombDurationMs = randomBombMs();
      this.bombStartedAt = performance.now();
    }

    this.renderer = new BombRenderer({ canvas: ctx.canvas });
    ctx.canvas.style.cursor = 'default';
    this.mountInputUI();
    sound.startBgm('word-chain');

    if (!this.isHost) {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }
    this.refreshInputEnabled();
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost) this.ctx.sendToPeer(encodeSync(this.game), { target: hello.peerId });
      return;
    }

    const sync = decodeSync(msg);
    if (sync) {
      if (!this.isHost) {
        this.game = sync;
        if (!this.isSpectator) {
          this.myIndex = this.game.players.find((p) => p.peerId === this.myPeerId)?.index ?? -1;
        }
        this.refreshInputEnabled();
      }
      return;
    }

    const submit = decodeSubmit(msg);
    if (submit) {
      if (this.isHost) this.handleSubmitFromGuest(submit.word);
      return;
    }

    const accepted = decodeAccepted(msg);
    if (accepted) {
      if (!this.isHost) {
        this.game.history.push({ word: accepted.word, byPeerId: accepted.byPeerId, byNickname: accepted.byNickname });
        this.game.usedWords.add(accepted.word);
        this.game.currentTurn = accepted.nextTurn;
        this.refreshInputEnabled();
      }
      sound.play('pop');
      return;
    }

    const rejected = decodeRejected(msg);
    if (rejected) {
      this.showRejectMessage(rejected.message);
      sound.play('button_click');
      return;
    }

    const end = decodeEnd(msg);
    if (end) {
      // 게스트: 폭발 오버레이 먼저 반영 후 결과 화면 예약
      const loser = end.summary['loserPeerId'];
      if (typeof loser === 'string') this.loserPeerId = loser;
      this.game.phase = 'ended';
      this.refreshInputEnabled();
      sound.play('goal'); // 폭발음 대용
      this.scheduleEndGame(end);
      return;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.gameFinished = true;
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
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
      // 정지 동안 폭탄 타이머도 멈춘 것처럼 (호스트만 의미 있음)
      this.bombStartedAt += performance.now() - this.pauseStart;
      this.pauseStart = 0;
    }
    this.refreshInputEnabled();
  }

  // ============================================
  // 루프 — 호스트만 폭탄 감시
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;
    const now = performance.now();

    if (this.isHost && !this.paused && this.game.phase === 'aiming'
      && now - this.bombStartedAt >= this.bombDurationMs) {
      this.explodeAsHost();
    }

    this.renderer.render({
      game: this.game,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      loserPeerId: this.loserPeerId,
      now,
    } satisfies RenderState);
  };

  // ============================================
  // 호스트 처리
  // ============================================

  private handleSubmitFromGuest(word: string): void {
    if (this.game.phase !== 'aiming') return;
    const cur = this.game.players.find((p) => p.index === this.game.currentTurn);
    if (!cur) return;
    const result = validateSubmission(this.game, word.trim());
    if (!result.ok) {
      this.ctx.sendToPeer(encodeRejected({ reason: result.reason, message: result.message }), { target: cur.peerId });
      return;
    }
    this.acceptWord(word.trim(), cur.peerId, cur.nickname);
  }

  private handleOwnSubmit(word: string): void {
    if (this.game.phase !== 'aiming' || this.myIndex !== this.game.currentTurn) return;
    const result = validateSubmission(this.game, word.trim());
    if (!result.ok) {
      this.showRejectMessage(result.message);
      sound.play('button_click');
      return;
    }
    const me = this.game.players.find((p) => p.index === this.myIndex);
    if (!me) return;
    this.acceptWord(word.trim(), me.peerId, me.nickname);
    if (this.inputEl) this.inputEl.value = '';
  }

  /** 호스트: 단어 채택 → 로컬 적용 + broadcast (턴 넘김 = 폭탄 전달) */
  private acceptWord(word: string, byPeerId: string, byNickname: string): void {
    applySubmission(this.game, word, byPeerId, byNickname, performance.now());
    this.ctx.sendToPeer(encodeAccepted({
      word, byPeerId, byNickname, nextTurn: this.game.currentTurn,
    }));
    sound.play('pop');
    this.refreshInputEnabled();
  }

  private explodeAsHost(): void {
    if (this.gameFinished) return;
    const holder = this.game.players.find((p) => p.index === this.game.currentTurn);
    this.loserPeerId = holder?.peerId ?? null;
    this.game.phase = 'ended';
    this.gameFinished = true;
    sound.play('goal');
    this.refreshInputEnabled();

    const baseSummary: Record<string, unknown> = {
      gameId: 'bomb-wordchain',
      loserPeerId: this.loserPeerId,
      loserNickname: holder?.nickname ?? '?',
      wordCount: this.game.history.length - 1, // 시드 단어 제외
      players: this.game.players.map((p) => ({
        peerId: p.peerId,
        nickname: p.nickname,
        survived: p.peerId !== this.loserPeerId,
      })),
    };

    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      this.ctx.sendToPeer(
        encodeEnd({ winner: this.winnerForPeer(p.peerId, p.role === 'spectator'), summary: { ...baseSummary, myPeerId: p.peerId } }),
        { target: p.peerId },
      );
    }
    this.scheduleEndGame({
      winner: this.winnerForPeer(this.myPeerId, false),
      summary: { ...baseSummary, myPeerId: this.myPeerId },
    });
  }

  /** 폭탄 든 사람만 패배. 나머지(관전자 포함)는 생존. */
  private winnerForPeer(peerId: string, isSpectator: boolean): GameResult['winner'] {
    if (isSpectator) return 'opponent';
    return peerId === this.loserPeerId ? 'opponent' : 'me';
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
  // 입력 UI (word-chain .wc-input-* 재사용)
  // ============================================

  private mountInputUI(): void {
    const parent = this.ctx.canvas.parentElement;
    if (!parent) return;
    const container = document.createElement('div');
    container.className = 'wc-input-container';
    container.innerHTML = `
      <div class="wc-input-hint" id="bw-input-hint">잠시만요</div>
      <form class="wc-input-form" id="bw-input-form" autocomplete="off">
        <input type="text" class="wc-input" id="bw-input" maxlength="10" placeholder="단어 입력 후 Enter" />
        <button type="submit" class="wc-input-submit">제출</button>
      </form>
      <div class="wc-reject-message" id="bw-reject-message"></div>
    `;
    parent.appendChild(container);
    this.inputContainer = container;
    this.inputEl = container.querySelector<HTMLInputElement>('#bw-input');
    this.rejectMessageEl = container.querySelector<HTMLDivElement>('#bw-reject-message');
    container.querySelector<HTMLFormElement>('#bw-input-form')?.addEventListener('submit', this.onSubmitForm);
    this.refreshInputEnabled();
  }

  private unmountInputUI(): void {
    if (this.rejectMessageTimer !== null) { window.clearTimeout(this.rejectMessageTimer); this.rejectMessageTimer = null; }
    this.inputContainer?.remove();
    this.inputContainer = null;
    this.inputEl = null;
    this.rejectMessageEl = null;
  }

  private onSubmitForm = (e: Event): void => {
    e.preventDefault();
    if (!this.inputEl) return;
    const word = this.inputEl.value.trim();
    if (!word || this.paused || this.gameFinished || this.isSpectator) return;
    if (this.myIndex !== this.game.currentTurn || this.game.phase !== 'aiming') return;
    if (this.isHost) {
      this.handleOwnSubmit(word);
    } else {
      this.ctx.sendToPeer(encodeSubmit(word));
      this.inputEl.value = '';
    }
  };

  private refreshInputEnabled(): void {
    if (!this.inputEl || !this.inputContainer) return;
    const hint = this.inputContainer.querySelector<HTMLDivElement>('#bw-input-hint');
    const myTurn = !this.isSpectator && this.myIndex === this.game.currentTurn;
    const isAiming = this.game.phase === 'aiming';
    const enabled = myTurn && isAiming && !this.paused && !this.gameFinished;
    this.inputEl.disabled = !enabled;

    if (hint) {
      if (this.isSpectator) {
        hint.textContent = '관전 중';
      } else if (this.game.phase === 'ended') {
        hint.textContent = '게임 끝';
      } else if (!myTurn) {
        const cur = this.game.players.find((p) => p.index === this.game.currentTurn);
        hint.textContent = `${cur?.nickname ?? '?'} 님이 폭탄을 들고 있어요`;
      } else {
        // 요구 글자는 캔버스 히어로에 크게 나오므로 여기선 긴장감만
        hint.textContent = '서둘러요! 폭탄이 터지기 전에';
      }
    }
    if (enabled) window.setTimeout(() => this.inputEl?.focus(), 10);
  }

  private showRejectMessage(message: string): void {
    if (!this.rejectMessageEl) return;
    this.rejectMessageEl.textContent = `❌ ${message}`;
    this.rejectMessageEl.classList.add('is-visible');
    if (this.rejectMessageTimer !== null) window.clearTimeout(this.rejectMessageTimer);
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

export function createBombWordChainGame(): GameModule {
  return new BombWordChainModule();
}
