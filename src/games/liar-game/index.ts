/**
 * 라이어 게임 GameModule — 조립.
 *
 * 호스트 authoritative:
 *   호스트가 라운드 진행(역할배정/힌트순서/투표집계/판정/점수) 단독 관리.
 *   비밀(역할/제시어/진짜 라이어/개별 투표)은 호스트만 보관, 공개 상태만 lg:sync broadcast.
 *
 * 흐름: 역할배정 → 힌트 2바퀴(타이핑) → 비밀투표 → (지목=라이어면)추측 → 결과 → 다음 라운드.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  createInitialGame, resetForRound, currentHinter, advanceHinter,
  validateHint, tallyVotes, scoreRound, finalRanking,
  HINT_MAXLEN,
  type LiarGame,
} from './rules';
import { pickRound } from './words';
import {
  encodeHello, decodeHello,
  encodeSync, decodeSync,
  encodeRole, decodeRole,
  encodeHint, decodeHint,
  encodeVote, decodeVote,
  encodeGuess, decodeGuess,
  encodeReveal, decodeReveal,
  encodeRejected, decodeRejected,
  encodeEnd, decodeEnd,
  type RolePayload,
} from './netSync';
import { LiarRenderer, type RenderState } from './render';

const HINT_TIMEOUT_MS = 45_000;
const VOTE_TIMEOUT_MS = 30_000;
const GUESS_TIMEOUT_MS = 30_000;
const RESULT_DELAY_MS = 5_000;
const END_DELAY_MS = 1_500;

class LiarGameModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: LiarRenderer;
  private game!: LiarGame;

  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private mode: 'normal' | 'fool' = 'normal';

  private myRole: RolePayload | null = null;
  private revealVotes: Record<string, string> | null = null;
  /** 게스트: 마지막 hello 전송 시각. role/sync 받을 때까지 주기적 재전송 */
  private lastHelloAt = 0;
  /** 게스트: 현재 myRole 이 발급된 라운드. sync 라운드와 어긋나면 stale */
  private myRoleRound = -1;

  // 호스트 전용 비밀 상태
  private realKeyword = '';
  private fakeKeyword = '';
  private liarPeerId = '';
  private hostVotes: Record<string, string> = {};
  /** 호스트: 이번 게임에서 이미 쓴 제시어 (반복 방지) */
  private usedKeywords = new Set<string>();
  private resolved = false; // 이번 라운드 판정 완료 여부
  /** 이번 라운드 내 투표 완료 여부 (게스트/호스트 공통 — 버튼 재활성 방지) */
  private votedThisRound = false;

  // 페이즈 타임아웃 (호스트) — 이 시각 지나면 자동 진행
  private phaseDeadline = 0;
  private roundAdvanceScheduled = false;

  /**
   * 라이어 공정 배분용 "가방". 셔플된 플레이어 순열을 담아 라운드마다 하나씩 소진,
   * 비면 다시 셔플해 채운다. → n라운드 안에서 각자 정확히 한 번씩 라이어가 되어
   * 독립 난수(방장 편중 체감)보다 훨씬 공평. (호스트만 사용)
   */
  private liarBag: string[] = [];

  /** 표시용 남은시간 데드라인 (로컬 시계). 호스트=phaseDeadline, 게스트=페이즈 변화 시 로컬 기준 재설정 */
  private displayDeadline = 0;
  /** 표시 타이머 리셋 감지 키 (round:phase:hintIndex 바뀌면 카운트다운 재시작) */
  private lastPhaseKey = '';

  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;
  private endGameScheduled = false;
  private paused = false;
  private pauseStart = 0;

  // HTML
  private panel: HTMLDivElement | null = null;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.mode = ctx.roomOptions['mode'] === 'fool' ? 'fool' : 'normal';

    const players = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'));
    this.game = createInitialGame(players.map((p) => ({ peerId: p.peerId, nickname: p.nickname })));

    this.renderer = new LiarRenderer({ canvas: ctx.canvas });
    ctx.canvas.style.cursor = 'default';
    this.mountPanel();
    sound.startBgm('apple-game'); // 밝은 BGM 재활용

    if (this.isHost) {
      this.startRoundAsHost();
    } else {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
      this.lastHelloAt = performance.now();
    }

    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost) {
        // 합류자에게 현재 공개 상태 전송. 역할/제시어는 "플레이어"에게만
        // (관전자에게 보내면 제시어가 새므로 금지).
        this.ctx.sendToPeer(encodeSync(this.game), { target: hello.peerId });
        if (this.game.players.some((p) => p.peerId === hello.peerId)) {
          this.sendRoleTo(hello.peerId);
        }
      }
      return;
    }

    const sync = decodeSync(msg);
    if (sync) {
      if (!this.isHost) {
        this.game = sync;
        // 라운드가 바뀌었는데 그 라운드 역할을 아직 못 받았으면 stale → null 로 비워
        // hello 재전송이 다시 role 을 받아오게 (targeted role 유실 복구).
        if (!this.isSpectator && this.myRoleRound !== this.game.round) {
          this.myRole = null;
        }
        this.refreshUI();
      }
      return;
    }

    const role = decodeRole(msg);
    if (role) {
      if (!this.isHost) {
        this.myRole = role;
        this.myRoleRound = role.round;
        this.refreshUI();
      }
      return;
    }

    const reveal = decodeReveal(msg);
    if (reveal) {
      if (!this.isHost) {
        this.revealVotes = reveal.votes;
      }
      return;
    }

    const rejected = decodeRejected(msg);
    if (rejected) {
      this.showMessage(`❌ ${rejected.message}`);
      this.setHintEnabled(true); // 다시 입력 허용
      return;
    }

    const end = decodeEnd(msg);
    if (end) {
      this.scheduleEndGame(end);
      return;
    }

    // 호스트만 처리하는 클라 요청 (송신자 peerId 는 payload.from)
    if (this.isHost) {
      const hint = decodeHint(msg);
      if (hint) { this.handleHint(hint.from, hint.text); return; }
      const vote = decodeVote(msg);
      if (vote) { this.handleVote(vote.from, vote.target); return; }
      const guess = decodeGuess(msg);
      if (guess) { this.handleGuess(guess.from, guess.word); return; }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.gameFinished = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.panel?.remove();
    this.panel = null;
    this.renderer?.destroy();
    sound.stopBgm();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.pauseStart = performance.now();
    else if (this.pauseStart > 0) {
      // 정지 동안 흐른 시간만큼 데드라인 미룸 (호스트 판정용 + 게스트 표시용 둘 다)
      const delta = performance.now() - this.pauseStart;
      this.phaseDeadline += delta;
      if (this.displayDeadline > 0) this.displayDeadline += delta;
      this.pauseStart = 0;
    }
  }

  // ============================================
  // 루프 (렌더 + 호스트 타임아웃)
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;
    const now = performance.now();

    if (this.isHost && !this.paused && !this.gameFinished && this.phaseDeadline > 0 && now > this.phaseDeadline) {
      this.phaseDeadline = 0;
      this.onPhaseTimeout();
    }

    // 게스트: 역할(제시어)을 아직 못 받았으면 hello 재전송 —
    //   게임 전환/합류 시 hello 유실로 role·sync 를 영영 못 받아 "제시어 없음 + 남 차례"로
    //   굳던 문제 방지. 관전자는 역할이 없으니 제외.
    if (!this.isHost && !this.isSpectator && this.myRole === null && now - this.lastHelloAt > 2000) {
      this.lastHelloAt = now;
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }

    // 표시용 타이머 — 페이즈/차례가 바뀌면 로컬 데드라인 재시작.
    //   호스트는 authoritative phaseDeadline 을, 게스트는 페이즈 변화를 감지해 로컬 시계 기준
    //   카운트다운(cross-clock 문제 회피 — draw-quiz 와 동일 전략).
    const phaseKey = `${this.game.round}:${this.game.phase}:${this.game.hintIndex}`;
    if (phaseKey !== this.lastPhaseKey) {
      this.lastPhaseKey = phaseKey;
      const dur = this.phaseDurationMs(this.game.phase);
      this.displayDeadline = dur > 0 ? now + dur : 0;
    }
    // 정지 중엔 표시 시각을 pauseStart 로 얼려 타이머 표시가 안 흐르게(모달 뒤 타이머 진행 방지)
    const renderNow = this.paused && this.pauseStart > 0 ? this.pauseStart : now;
    const activeDeadline = this.isHost ? this.phaseDeadline : this.displayDeadline;
    const remainMs = activeDeadline > 0 ? Math.max(0, activeDeadline - renderNow) : 0;

    const rs: RenderState = {
      game: this.game,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      myRole: this.myRole,
      revealVotes: this.revealVotes,
      remainMs,
      now: renderNow,
    };
    try {
      this.renderer.render(rs);
    } catch (err) {
      console.error('[liar-game] render 실패', err);
    }
  };

  private onPhaseTimeout(): void {
    switch (this.game.phase) {
      case 'hint': {
        // 현재 차례가 시간 초과 → 빈 힌트로 넘김
        const cur = currentHinter(this.game);
        if (cur) this.acceptHint(cur, '(시간 초과)');
        break;
      }
      case 'vote':
        this.tallyAndJudge(); // 모인 표로만 집계
        break;
      case 'guess':
        this.resolveRound(false, null); // 추측 시간 초과 = 오답
        break;
    }
  }

  // ============================================
  // 호스트: 라운드 진행
  // ============================================

  /** 가방에서 이번 라운드 라이어 하나 뽑기 (비면 셔플해 재충전 — 공평 보장) */
  private nextLiar(): string {
    if (this.liarBag.length === 0) {
      const ids = this.game.players.map((p) => p.peerId);
      // Fisher-Yates 셔플
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      }
      this.liarBag = ids;
    }
    return this.liarBag.shift()!;
  }

  /** 페이즈별 제한시간(ms) — 타이머 표시/게스트 로컬 카운트다운에 사용 */
  private phaseDurationMs(phase: LiarGame['phase']): number {
    if (phase === 'hint') return HINT_TIMEOUT_MS;
    if (phase === 'vote') return VOTE_TIMEOUT_MS;
    if (phase === 'guess') return GUESS_TIMEOUT_MS;
    return 0; // result/ended 등은 타이머 없음
  }

  private startRoundAsHost(): void {
    const players = this.game.players;
    this.liarPeerId = this.nextLiar();
    const picked = pickRound(this.usedKeywords);
    this.usedKeywords.add(picked.keyword);
    this.realKeyword = picked.keyword;
    this.fakeKeyword = picked.fakeKeyword;
    this.hostVotes = {};
    this.resolved = false;
    this.revealVotes = null;

    // 시작 순서 로테이션 — 라운드마다 시작 플레이어를 한 칸씩 밀어 시계방향으로 돌게.
    const base = players.map((p) => p.peerId);
    const startIdx = (this.game.round - 1) % base.length;
    const order = [...base.slice(startIdx), ...base.slice(0, startIdx)];
    resetForRound(this.game, picked.category, order);

    // 역할/제시어 개별 전송 (호스트 자신 포함)
    for (const p of players) {
      if (p.peerId === this.myPeerId) {
        this.myRole = this.roleFor(p.peerId);
      } else {
        this.sendRoleTo(p.peerId);
      }
    }
    this.ctx.sendToPeer(encodeSync(this.game));
    this.startPhaseTimer(HINT_TIMEOUT_MS);
    this.refreshUI();
    sound.play('pop');
  }

  /** 특정 peer 의 이번 라운드 역할 payload */
  private roleFor(peerId: string): RolePayload {
    const round = this.game.round;
    const isLiar = peerId === this.liarPeerId;
    if (!isLiar) return { role: 'citizen', word: this.realKeyword, category: this.game.category, round };
    // 라이어
    if (this.mode === 'fool') {
      // 바보 모드 — 자기가 시민인 줄 알게 가짜 제시어 전달
      return { role: 'citizen', word: this.fakeKeyword, category: this.game.category, round };
    }
    return { role: 'liar', word: '', category: this.game.category, round };
  }

  private sendRoleTo(peerId: string): void {
    this.ctx.sendToPeer(encodeRole(this.roleFor(peerId)), { target: peerId });
  }

  /** 호스트: 힌트 수신 (게스트 or 자기) */
  private handleHint(fromPeerId: string, text: string): void {
    if (this.game.phase !== 'hint') return;
    if (fromPeerId !== currentHinter(this.game)) return; // 차례 아님
    const check = validateHint(text, this.realKeyword);
    if (!check.ok) {
      if (fromPeerId === this.myPeerId) { this.showMessage(`❌ ${check.message}`); this.setHintEnabled(true); }
      else this.ctx.sendToPeer(encodeRejected(check.message), { target: fromPeerId });
      return;
    }
    this.acceptHint(fromPeerId, text.trim());
  }

  private acceptHint(peerId: string, text: string): void {
    const nickname = this.game.players.find((p) => p.peerId === peerId)?.nickname ?? '?';
    this.game.hints.push({ peerId, nickname, text });
    const { done } = advanceHinter(this.game);
    if (done) {
      this.game.phase = 'vote';
      this.startPhaseTimer(VOTE_TIMEOUT_MS);
    } else {
      this.startPhaseTimer(HINT_TIMEOUT_MS);
    }
    this.ctx.sendToPeer(encodeSync(this.game));
    this.refreshUI();
    sound.play('button_click');
  }

  private handleVote(fromPeerId: string, target: string): void {
    if (this.game.phase !== 'vote') return;
    if (fromPeerId === target) return; // 자기 자신 투표 금지
    if (!this.game.players.some((p) => p.peerId === fromPeerId)) return; // 플레이어만
    this.hostVotes[fromPeerId] = target;
    // 전원 투표 완료 시 즉시 집계. (부분 투표 중엔 공개상태 변화 없어 broadcast 안 함)
    if (Object.keys(this.hostVotes).length >= this.game.players.length) {
      this.tallyAndJudge();
    }
  }

  private tallyAndJudge(): void {
    if (this.game.phase !== 'vote') return;
    const accused = tallyVotes(this.hostVotes);
    this.game.accusedPeerId = accused;
    if (accused && accused === this.liarPeerId) {
      // 라이어 지목 성공 → 라이어에게 추측 기회
      this.game.phase = 'guess';
      this.startPhaseTimer(GUESS_TIMEOUT_MS);
      this.ctx.sendToPeer(encodeSync(this.game));
      this.refreshUI();
    } else {
      // 오인 or 동점 → 라이어 승
      this.resolveRound(true, null);
    }
  }

  private handleGuess(fromPeerId: string, word: string): void {
    if (this.game.phase !== 'guess') return;
    if (fromPeerId !== this.liarPeerId) return; // 라이어만 추측
    const correct = word.trim().replace(/\s/g, '') === this.realKeyword.replace(/\s/g, '');
    this.resolveRound(correct, word.trim());
  }

  /** 라운드 판정 확정 + 점수 + 결과 broadcast */
  private resolveRound(liarWon: boolean, guess: string | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.phaseDeadline = 0;
    this.game.revealedLiarPeerId = this.liarPeerId;
    this.game.liarWon = liarWon;
    this.game.liarGuess = guess;
    this.game.revealedWord = this.realKeyword; // 정답 공개 (라이어 승패 무관)
    this.game.phase = 'result';
    scoreRound(this.game, this.liarPeerId, this.hostVotes, liarWon);
    this.revealVotes = { ...this.hostVotes };
    this.ctx.sendToPeer(encodeSync(this.game));
    this.ctx.sendToPeer(encodeReveal(this.hostVotes));
    this.refreshUI();
    sound.play(liarWon ? 'button_click' : 'pop');

    if (this.roundAdvanceScheduled) return;
    this.roundAdvanceScheduled = true;
    window.setTimeout(() => {
      this.roundAdvanceScheduled = false;
      if (this.destroyed) return;
      if (this.game.round >= this.game.totalRounds) this.finishAsHost();
      else { this.game.round += 1; this.startRoundAsHost(); }
    }, RESULT_DELAY_MS);
  }

  private startPhaseTimer(ms: number): void {
    this.phaseDeadline = performance.now() + ms;
  }

  // ============================================
  // 종료
  // ============================================

  private finishAsHost(): void {
    if (this.gameFinished) return;
    this.gameFinished = true;
    this.game.phase = 'ended';
    const ranking = finalRanking(this.game);
    const totalPlayers = this.game.players.length;
    const rankings = ranking.map((r) => ({ peerId: r.peerId, nickname: r.nickname, score: r.score, rank: r.rank }));
    const summaryFor = (peerId: string): Record<string, unknown> => ({
      gameId: 'liar-game',
      myPeerId: peerId,
      rank: ranking.find((r) => r.peerId === peerId)?.rank ?? totalPlayers,
      totalPlayers,
      rankings,
    });
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      this.ctx.sendToPeer(
        encodeEnd({ winner: this.winnerFor(ranking, p.peerId, p.role === 'spectator'), summary: summaryFor(p.peerId) }),
        { target: p.peerId },
      );
    }
    this.scheduleEndGame({
      winner: this.winnerFor(ranking, this.myPeerId, false),
      summary: summaryFor(this.myPeerId),
    });
  }

  private winnerFor(
    ranking: ReturnType<typeof finalRanking>,
    peerId: string,
    isSpectator: boolean,
  ): GameResult['winner'] {
    if (isSpectator) return 'opponent';
    const me = ranking.find((r) => r.peerId === peerId);
    return me && me.rank === 1 ? 'me' : 'opponent';
  }

  private scheduleEndGame(result: GameResult): void {
    if (this.endGameScheduled) return;
    this.endGameScheduled = true;
    window.setTimeout(() => {
      if (this.destroyed) return;
      this.ctx.endGame(result);
    }, END_DELAY_MS);
  }

  // ============================================
  // HTML 입력 UI
  // ============================================

  private mountPanel(): void {
    const parent = this.ctx.canvas.parentElement;
    if (!parent) return;
    const el = document.createElement('div');
    el.className = 'lg-panel';
    el.innerHTML = `
      <div class="lg-msg" id="lg-msg"></div>
      <form class="lg-input-form" id="lg-hint-form" autocomplete="off" style="display:none">
        <input type="text" class="lg-input" id="lg-hint-input" maxlength="${HINT_MAXLEN}" placeholder="제시어를 설명하세요 (직접 언급 금지)" />
        <button type="submit" class="lg-submit">설명</button>
      </form>
      <div class="lg-vote" id="lg-vote" style="display:none"></div>
      <form class="lg-input-form" id="lg-guess-form" autocomplete="off" style="display:none">
        <input type="text" class="lg-input" id="lg-guess-input" maxlength="12" placeholder="제시어가 뭐였을까요? 추측!" />
        <button type="submit" class="lg-submit">추측</button>
      </form>
    `;
    parent.appendChild(el);
    this.panel = el;

    el.querySelector<HTMLFormElement>('#lg-hint-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = el.querySelector<HTMLInputElement>('#lg-hint-input')!;
      const text = input.value.trim();
      if (!text || this.paused) return;
      this.setHintEnabled(false);
      input.value = '';
      this.submitHint(text);
    });
    el.querySelector<HTMLFormElement>('#lg-guess-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = el.querySelector<HTMLInputElement>('#lg-guess-input')!;
      const word = input.value.trim();
      if (!word || this.paused) return;
      input.value = '';
      this.submitGuess(word);
    });

    this.refreshUI();
  }

  private submitHint(text: string): void {
    if (this.isHost) this.handleHint(this.myPeerId, text);
    else this.ctx.sendToPeer(encodeHint(this.myPeerId, text));
  }
  private submitVote(target: string): void {
    this.votedThisRound = true;
    if (this.isHost) this.handleVote(this.myPeerId, target);
    else this.ctx.sendToPeer(encodeVote(this.myPeerId, target));
  }
  private submitGuess(word: string): void {
    if (this.isHost) this.handleGuess(this.myPeerId, word);
    else this.ctx.sendToPeer(encodeGuess(this.myPeerId, word));
  }

  private showMessage(text: string): void {
    const m = this.panel?.querySelector<HTMLDivElement>('#lg-msg');
    if (m) m.textContent = text;
  }
  private setHintEnabled(on: boolean): void {
    const input = this.panel?.querySelector<HTMLInputElement>('#lg-hint-input');
    const btn = this.panel?.querySelector<HTMLButtonElement>('#lg-hint-form .lg-submit');
    if (input) input.disabled = !on;
    if (btn) btn.disabled = !on;
  }

  /** 페이즈/역할에 맞춰 어떤 입력 UI 를 보일지 갱신 */
  private refreshUI(): void {
    if (!this.panel) return;
    const g = this.game;
    const hintForm = this.panel.querySelector<HTMLFormElement>('#lg-hint-form')!;
    const voteBox = this.panel.querySelector<HTMLDivElement>('#lg-vote')!;
    const guessForm = this.panel.querySelector<HTMLFormElement>('#lg-guess-form')!;
    hintForm.style.display = 'none';
    voteBox.style.display = 'none';
    guessForm.style.display = 'none';
    this.showMessage('');

    if (this.isSpectator) { this.showMessage('👀 관전 중'); return; }

    if (g.phase === 'hint') this.votedThisRound = false; // 새 라운드 힌트 단계 = 투표 초기화

    if (g.phase === 'hint') {
      if (currentHinter(g) === this.myPeerId) {
        hintForm.style.display = '';
        this.setHintEnabled(true);
        window.setTimeout(() => this.panel?.querySelector<HTMLInputElement>('#lg-hint-input')?.focus(), 10);
      } else {
        this.showMessage('다른 사람이 설명 중이에요');
      }
    } else if (g.phase === 'vote') {
      voteBox.style.display = '';
      this.buildVoteButtons(voteBox, this.votedThisRound);
    } else if (g.phase === 'guess') {
      if (g.accusedPeerId === this.myPeerId) {
        // 내가 지목당한 라이어 — 추측 입력
        guessForm.style.display = '';
        window.setTimeout(() => this.panel?.querySelector<HTMLInputElement>('#lg-guess-input')?.focus(), 10);
      } else {
        this.showMessage('라이어가 제시어를 추측하는 중');
      }
    }
  }

  private buildVoteButtons(box: HTMLDivElement, disabled: boolean): void {
    const g = this.game;
    box.innerHTML = `<div class="lg-vote-title">🗳️ 라이어는 누구?</div>`;
    const row = document.createElement('div');
    row.className = 'lg-vote-row';
    for (const p of g.players) {
      if (p.peerId === this.myPeerId) continue; // 자기 자신 제외
      const b = document.createElement('button');
      b.className = 'lg-vote-btn';
      b.textContent = p.nickname;
      b.disabled = disabled;
      b.addEventListener('click', () => {
        // 한 번 누르면 전체 비활성 (변경 불가 — 단순화)
        box.querySelectorAll<HTMLButtonElement>('.lg-vote-btn').forEach((x) => { x.disabled = true; });
        b.classList.add('voted');
        this.submitVote(p.peerId);
        this.showMessage('투표 완료! 결과를 기다려요');
      });
      row.appendChild(b);
    }
    box.appendChild(row);
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

export function createLiarGame(): GameModule {
  return new LiarGameModule();
}
