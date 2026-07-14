/**
 * 그림 퀴즈 GameModule — 조립
 *
 * 아키텍처 (호스트 authoritative 라운드 진행):
 *   호스트가 라운드 상태(출제자/단어/타이머/점수) 단독 관리.
 *   출제자는 그림 stroke 를 broadcast. 추측은 dq:guess 로 호스트가 판정.
 *
 * 라운드 흐름:
 *   choosing → (출제자 단어 선택) → drawing → (정답 or 타임아웃) → round_result
 *     → 다음 라운드 choosing ... → 마지막 라운드 후 ended → dq:end
 *
 * 정답 입력:
 *   비출제자는 하단 추측 input 으로 단어 입력 → dq:guess 송신.
 *   정답이면 호스트가 dq:correct broadcast (단어 노출 X). 틀리면 무시(피드백 최소).
 *   ※ 단순화를 위해 별도 추측 input 사용 — 플랫폼 채팅과 분리.
 *
 * 그리기 도구 UI:
 *   canvas 외부 HTML — 펜/지우개/색6/굵기3/전체지우기. 출제자에게만 표시.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  createInitialGame,
  pickNextDrawer,
  isCorrectGuess,
  awardCorrect,
  roundHasCorrect,
  roundsPerPlayer,
  scoreMap,
  computeWinners,
  ROUND_DURATION_MS,
  TIMEOUT_GRACE_MS,
  type DrawQuizGame,
  type StrokePoint,
} from './rules';
import { pickCandidates, type QuizWord } from './words';
import {
  DrawQuizRenderer, canvasToDraw, isInDrawArea,
  PALETTE, WIDTHS,
  type RenderState,
} from './render';
import {
  encodeHello, decodeHello,
  encodeSync, decodeSync,
  encodeRoundStart, decodeRoundStart,
  encodeWordChosen, decodeWordChosen,
  encodeCustomWord, decodeCustomWord,
  encodeRoundBegin, decodeRoundBegin,
  encodeReveal, decodeReveal,
  encodeStroke, decodeStroke,
  encodeClear, isClear,
  encodeGuess, decodeGuess,
  encodeCorrect, decodeCorrect,
  encodeRoundEnd, decodeRoundEnd,
  encodeEnd, decodeEnd,
  type StrokeData,
} from './netSync';

/** 라운드 결과 표시 시간 (ms) */
const ROUND_RESULT_MS = 3500;
/** 라운드 종료 이만큼 남았을 때 정답 한 글자 공개 (ms) */
const REVEAL_BEFORE_MS = 20_000;
/** 직접입력 모드에서 출제자가 단어 안 정하면 이 시간 뒤 자동 시작 (ms) */
const CHOOSE_TIMEOUT_MS = 30_000;

class DrawQuizGameModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: DrawQuizRenderer;
  private game!: DrawQuizGame;

  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;

  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;
  private endGameScheduled = false;

  /** 완료된 stroke 들 (모든 클라이언트 공유) */
  private strokes: StrokeData[] = [];
  /** 출제자가 현재 그리는 중인 stroke */
  private liveStroke: StrokeData | null = null;
  private isDrawingStroke = false;

  /** 출제 방식 — auto(자동 지급) / custom(출제자 직접 입력) */
  private wordMode: 'auto' | 'custom' = 'auto';
  /** 출제자 후보 단어 (choosing 단계) */
  private candidates: QuizWord[] = [];
  /** 라운드 결과 단계 공개 단어 */
  private revealedWord: string | null = null;
  /** 호스트 전용 — 이번 라운드 실제 제시어 (표시용 currentWord 는 마스킹될 수 있음) */
  private realWord = '';
  /** 이번 라운드 글자 힌트를 이미 공개했는지 (호스트) */
  private hintRevealed = false;

  /** 현재 그리기 도구 상태 */
  private toolColor: string = PALETTE[0];
  private toolWidth: number = WIDTHS[1];
  private toolErase = false;
  private toolStyle: 'pen' | 'block' | 'marker' = 'pen';
  private toolShape: 'free' | 'rect' | 'ellipse' | 'line' = 'free';

  /** 호스트 타이머용 — round_result 끝나는 시각 */
  private resultEndsAt = 0;

  // DOM
  private toolbarEl: HTMLDivElement | null = null;
  private guessBarEl: HTMLDivElement | null = null;
  private candidatesEl: HTMLDivElement | null = null;

  // ============================================
  // GameModule
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.wordMode = ctx.roomOptions['wordMode'] === 'custom' ? 'custom' : 'auto';

    const playerList = ctx.players.filter((p) => p.role === 'player');
    const ordered = orderPlayersHostFirst(playerList);

    // 전체 라운드 = 1인당 그리는 횟수 × 인원. 1인당 횟수는 인원 반비례(적으면 많이).
    //   pickNextDrawer 가 한 바퀴 다 돌면 hasDrawn 리셋해 다음 바퀴로 넘어가므로,
    //   totalRounds 만 늘리면 전원이 여러 번 돌아가며 출제하게 된다.
    const rounds = roundsPerPlayer(ordered.length) * ordered.length;
    this.game = createInitialGame(
      ordered.map((p) => ({ peerId: p.peerId, nickname: p.nickname })),
      rounds,
    );

    this.renderer = new DrawQuizRenderer({ canvas: ctx.canvas });
    ctx.canvas.style.cursor = 'crosshair';

    this.mountUI();
    sound.startBgm('apple-game'); // 밝고 느긋한 BGM 재활용

    if (this.isHost) {
      // 호스트가 첫 라운드 시작
      this.startNextRoundAsHost();
    } else {
      // 게스트/관전자는 현재 상태 sync 요청
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }

    this.attachDrawInput();
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost) {
        this.ctx.sendToPeer(
          encodeSync({ game: this.maskedGameFor(hello.peerId), strokes: this.strokes }),
          { target: hello.peerId },
        );
      }
      return;
    }

    const sync = decodeSync(msg);
    if (sync) {
      if (!this.isHost) {
        this.game = reviveGame(sync.game);
        this.strokes = sync.strokes;
        this.refreshUI();
      }
      return;
    }

    const rs = decodeRoundStart(msg);
    if (rs) {
      if (!this.isHost) this.applyRoundStart(rs.round, rs.drawerPeerId, rs.candidates, rs.turnStartedAt);
      return;
    }

    const wc = decodeWordChosen(msg);
    if (wc) {
      if (this.isHost) this.handleWordChosen(wc.index);
      return;
    }

    const cw = decodeCustomWord(msg);
    if (cw) {
      if (this.isHost) this.handleCustomWord(cw.word);
      return;
    }

    const rb = decodeRoundBegin(msg);
    if (rb) {
      if (!this.isHost) this.applyRoundBegin(rb.wordLength, rb.turnStartedAt, rb.word);
      return;
    }

    const rev = decodeReveal(msg);
    if (rev) {
      // 글자 힌트 — 비출제자의 마스킹 단어에 글자 하나 드러냄
      if (!this.isHost && this.game.drawerPeerId !== this.myPeerId) {
        const cw = this.game.currentWord;
        if (rev.index >= 0 && rev.index < cw.length) {
          this.game.currentWord = cw.slice(0, rev.index) + rev.char + cw.slice(rev.index + 1);
        }
      }
      return;
    }

    const stroke = decodeStroke(msg);
    if (stroke) {
      // 출제자가 보낸 획 — 내가 출제자가 아니면 누적
      if (this.game.drawerPeerId !== this.myPeerId) {
        this.strokes.push(stroke);
      }
      return;
    }

    if (isClear(msg)) {
      if (this.game.drawerPeerId !== this.myPeerId) this.strokes = [];
      return;
    }

    const guess = decodeGuess(msg);
    if (guess) {
      if (this.isHost) this.tryGuessAsHost(guess.peerId, guess.nickname, guess.word);
      return;
    }

    const correct = decodeCorrect(msg);
    if (correct) {
      this.applyCorrect(correct.peerId, correct.nickname, correct.scores);
      return;
    }

    const re = decodeRoundEnd(msg);
    if (re) {
      if (!this.isHost) this.applyRoundEnd(re.word, re.scores);
      return;
    }

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
    this.detachDrawInput();
    this.unmountUI();
    if (this.ctx?.canvas) this.ctx.canvas.style.cursor = '';
    this.renderer?.destroy();
    sound.stopBgm();
  }

  setPaused(paused: boolean): void {
    // 그림 퀴즈는 일시정지 시 타이머만 보정 — 호스트 기준.
    if (paused) {
      this.pauseStart = performance.now();
    } else if (this.pauseStart > 0) {
      const d = performance.now() - this.pauseStart;
      this.game.turnStartedAt += d;
      this.resultEndsAt += d;
      this.pauseStart = 0;
    }
    this.paused = paused;
  }
  private paused = false;
  private pauseStart = 0;

  // ============================================
  // 루프 — 호스트가 타이머 진행
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;
    const now = performance.now();

    if (this.isHost && !this.paused) {
      if (this.game.phase === 'drawing') {
        const elapsed = now - this.game.turnStartedAt;
        // 시간 임박 시 정답 한 글자 공개 (호스트 전용 realWord 사용)
        if (!this.hintRevealed && this.realWord.length > 0
          && elapsed > ROUND_DURATION_MS - REVEAL_BEFORE_MS) {
          this.hintRevealed = true;
          const idx = Math.floor(Math.random() * this.realWord.length);
          const ch = this.realWord[idx]!;
          this.ctx.sendToPeer(encodeReveal(idx, ch));
          // 호스트가 추측자면 자기 마스킹 화면에도 반영
          if (this.game.drawerPeerId !== this.myPeerId) {
            const cw = this.game.currentWord;
            this.game.currentWord = cw.slice(0, idx) + ch + cw.slice(idx + 1);
          }
        }
        if (elapsed > ROUND_DURATION_MS + TIMEOUT_GRACE_MS) {
          this.endRoundAsHost();
        } else if (roundHasCorrect(this.game)) {
          // 첫 정답자 나옴 — 그 1명만 득점하고 라운드 즉시 종료
          this.endRoundAsHost();
        }
      } else if (this.game.phase === 'round_result') {
        if (now >= this.resultEndsAt) {
          this.startNextRoundAsHost();
        }
      } else if (this.game.phase === 'choosing' && this.wordMode === 'custom') {
        // 출제자가 단어를 안 정하고 오래 끌면 후보 하나로 자동 시작 (무한 대기 방지)
        if (now - this.game.turnStartedAt > CHOOSE_TIMEOUT_MS) {
          const fallback = this.candidates[0];
          if (fallback) this.beginDrawingAsHost(fallback.word);
        }
      }
    }

    this.renderer.render(this.buildRenderState(now));
  };

  private buildRenderState(now: number): RenderState {
    return {
      game: this.game,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      strokes: this.strokes,
      liveStroke: this.liveStroke,
      now,
      candidates: this.candidates.map((c) => c.word),
      revealedWord: this.revealedWord,
    };
  }

  // ============================================
  // 호스트: 라운드 진행
  // ============================================

  private startNextRoundAsHost(): void {
    // 모든 라운드 끝났으면 종료
    if (this.game.round >= this.game.totalRounds) {
      this.finishAsHost();
      return;
    }

    const drawer = pickNextDrawer(this.game);
    if (!drawer) { this.finishAsHost(); return; }
    drawer.hasDrawn = true;

    this.game.round++;
    this.game.phase = 'choosing';
    this.game.drawerPeerId = drawer.peerId;
    this.game.currentWord = '';
    this.game.correctThisRound = [];
    this.strokes = [];
    this.liveStroke = null;
    this.revealedWord = null;

    // 후보 3개 추출
    this.candidates = pickCandidates(this.game.usedWords, 3);

    const now = performance.now();
    this.game.turnStartedAt = now;

    // round_start broadcast — 출제자에게만 후보 단어 포함 (per-peer 다르게)
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      const isThisDrawer = p.peerId === drawer.peerId;
      this.ctx.sendToPeer(
        encodeRoundStart({
          round: this.game.round,
          drawerPeerId: drawer.peerId,
          drawerNickname: drawer.nickname,
          candidates: isThisDrawer ? this.candidates.map((c) => c.word) : [],
          turnStartedAt: now,
        }),
        { target: p.peerId },
      );
    }

    // 호스트 본인 처리 — 출제자가 누구든 호스트는 실제 후보를 그대로 유지해야 한다.
    //   (게스트 출제자가 word_chosen(index) 을 보내면 호스트가 this.candidates[index] 로
    //    단어를 찾아 판정하기 때문. 여기서 [] 로 덮어쓰면 그 조회가 undefined → 선택이
    //    조용히 씹혀서 "둘째 출제자부터 선택 안 됨" 버그가 났었음.)
    //   화면 노출은 refreshUI 의 amDrawer 가드로 막으므로 비출제자 화면엔 안 뜬다.
    this.applyRoundStart(this.game.round, drawer.peerId, this.candidates.map((c) => c.word), now);
    if (this.wordMode === 'auto') {
      // 자동 지급 — 선택 단계 없이 후보 중 랜덤 하나로 바로 그리기 시작
      const auto = this.candidates[Math.floor(Math.random() * this.candidates.length)] ?? this.candidates[0];
      if (auto) this.beginDrawingAsHost(auto.word);
    }
    // custom 모드는 choosing 단계 유지 — 출제자가 단어를 직접 입력할 때까지 대기
    this.refreshUI();
  }

  private handleWordChosen(index: number): void {
    if (this.game.phase !== 'choosing') return;
    const chosen = this.candidates[index];
    if (!chosen) return;
    this.beginDrawingAsHost(chosen.word);
  }

  /** 호스트 본인이 출제자일 때 단어 고름 */
  private handleOwnWordChoice(index: number): void {
    if (this.game.phase !== 'choosing') return;
    if (this.game.drawerPeerId !== this.myPeerId) return;
    const chosen = this.candidates[index];
    if (!chosen) return;
    this.beginDrawingAsHost(chosen.word);
  }

  /** 직접입력 모드: 출제자가 단어 제출 */
  private submitCustomWord(word: string): void {
    if (this.game.phase !== 'choosing') return;
    if (this.isHost) {
      this.handleCustomWord(word);
    } else {
      this.game.currentWord = word; // 출제자 로컬 즉시 표시
      this.ctx.sendToPeer(encodeCustomWord(word));
    }
  }

  /** 호스트: 직접입력 단어 수신 → 그리기 시작 */
  private handleCustomWord(word: string): void {
    if (this.game.phase !== 'choosing') return;
    const w = word.trim();
    if (!w) return;
    this.beginDrawingAsHost(w);
  }

  private beginDrawingAsHost(word: string): void {
    this.realWord = word; // 호스트 전용 실제 단어 (힌트/판정/정답공개용)
    this.game.usedWords.add(word);
    this.game.phase = 'drawing';
    this.hintRevealed = false;
    const now = performance.now();
    this.game.turnStartedAt = now;
    // 표시용 currentWord — 호스트가 출제자면 실제 단어, 추측자면 마스킹(자기 화면에 정답 안 새게)
    this.game.currentWord = this.game.drawerPeerId === this.myPeerId ? word : '*'.repeat(word.length);
    // 출제자에겐 실제 단어, 비출제자에겐 글자수만 (자동 지급이라 출제자도 단어를 받아야 함)
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      const isDrawer = p.peerId === this.game.drawerPeerId;
      this.ctx.sendToPeer(encodeRoundBegin({
        wordLength: word.length,
        durationMs: ROUND_DURATION_MS,
        turnStartedAt: now,
        word: isDrawer ? word : undefined,
      }), { target: p.peerId });
    }
    this.refreshUI();
  }

  // ============================================
  // 비호스트(또는 공통): 상태 적용
  // ============================================

  private applyRoundStart(round: number, drawerPeerId: string, candidates: string[], turnStartedAt: number): void {
    this.game.round = round;
    this.game.phase = 'choosing';
    this.game.drawerPeerId = drawerPeerId;
    this.game.currentWord = '';
    this.game.correctThisRound = [];
    this.game.turnStartedAt = turnStartedAt;
    this.strokes = [];
    this.liveStroke = null;
    this.revealedWord = null;
    // 후보는 출제자만 받음
    this.candidates = candidates.map((w) => ({ word: w, difficulty: 'normal' as const }));
    this.refreshUI();
  }

  private applyRoundBegin(wordLength: number, turnStartedAt: number, word?: string): void {
    this.game.phase = 'drawing';
    this.game.turnStartedAt = turnStartedAt;
    this.hintRevealed = false;
    if (word) {
      this.game.currentWord = word; // 출제자 — 실제 단어 수신
    } else if (this.game.drawerPeerId !== this.myPeerId) {
      // 비출제자는 글자수만 (렌더가 _ 로 그림). 글자 힌트로 일부가 채워질 수 있음
      this.game.currentWord = '*'.repeat(wordLength);
    }
    this.refreshUI();
  }

  private applyCorrect(peerId: string, _nickname: string, scores: Record<string, number>): void {
    if (!this.game.correctThisRound.includes(peerId)) {
      this.game.correctThisRound.push(peerId);
    }
    for (const p of this.game.players) {
      if (scores[p.peerId] !== undefined) p.score = scores[p.peerId]!;
    }
    sound.play('tetris_clear');
    this.refreshUI();
  }

  private applyRoundEnd(word: string, scores: Record<string, number>): void {
    this.game.phase = 'round_result';
    this.revealedWord = word;
    this.game.currentWord = word;
    for (const p of this.game.players) {
      if (scores[p.peerId] !== undefined) p.score = scores[p.peerId]!;
    }
    this.refreshUI();
  }

  private endRoundAsHost(): void {
    // 출제자는 점수 없음 (맞춘 사람만 +1). awardDrawer 제거됨.
    this.game.phase = 'round_result';
    this.revealedWord = this.realWord;      // 실제 정답 공개
    this.game.currentWord = this.realWord;  // 결과 화면용
    this.resultEndsAt = performance.now() + ROUND_RESULT_MS;
    const hasNext = this.game.round < this.game.totalRounds;
    this.ctx.sendToPeer(encodeRoundEnd({
      word: this.realWord,
      scores: scoreMap(this.game),
      hasNext,
    }));
    this.refreshUI();
  }

  private finishAsHost(): void {
    if (this.gameFinished) return;
    this.gameFinished = true;
    this.game.phase = 'ended';
    const winners = computeWinners(this.game);
    this.game.winnerPeerIds = winners.map((w) => w.peerId);

    const coWinnerNicknames = winners.map((w) => w.nickname);
    const baseSummary: Record<string, unknown> = {
      gameId: 'draw-quiz',
      // 단독 우승이면 닉 1개, 공동 우승이면 여러 개, 무승부면 빈 배열
      coWinnerNicknames,
      isCoWin: winners.length >= 2,
      rankings: [...this.game.players]
        .sort((a, b) => b.score - a.score)
        .map((p, i) => ({ peerId: p.peerId, nickname: p.nickname, score: p.score, rank: i + 1 })),
    };

    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      this.ctx.sendToPeer(
        encodeEnd({ winner: this.computeWinnerForPeer(p), summary: { ...baseSummary, myPeerId: p.peerId } }),
        { target: p.peerId },
      );
    }
    this.scheduleEndGame({
      winner: this.computeWinnerForPeer({ peerId: this.myPeerId, nickname: '', isHost: true, role: 'player' }),
      summary: { ...baseSummary, myPeerId: this.myPeerId },
    });
  }

  /** 공동 우승자 목록에 있으면 'me'(승리), 무승부(빈 목록)면 null, 그 외 'opponent'. */
  private computeWinnerForPeer(p: Player): GameResult['winner'] {
    if (this.game.winnerPeerIds.length === 0) return null; // 무승부
    if (p.role === 'spectator') return 'opponent';
    return this.game.winnerPeerIds.includes(p.peerId) ? 'me' : 'opponent';
  }

  private scheduleEndGame(result: GameResult): void {
    if (this.endGameScheduled) return;
    this.endGameScheduled = true;
    window.setTimeout(() => {
      if (this.destroyed) return;
      this.ctx.endGame(result);
    }, ROUND_RESULT_MS);
  }

  /** sync 시 비출제자에겐 currentWord 가려서 보냄 */
  private maskedGameFor(peerId: string): DrawQuizGame {
    if (peerId === this.game.drawerPeerId || this.game.phase === 'round_result' || this.game.phase === 'ended') {
      return this.game;
    }
    return { ...this.game, currentWord: '*'.repeat(this.game.currentWord.length) };
  }

  // ============================================
  // 그리기 입력 (출제자만)
  // ============================================

  private attachDrawInput(): void {
    this.ctx.canvas.addEventListener('mousedown', this.onDrawDown);
    window.addEventListener('mousemove', this.onDrawMove);
    window.addEventListener('mouseup', this.onDrawUp);
  }
  private detachDrawInput(): void {
    if (this.ctx?.canvas) this.ctx.canvas.removeEventListener('mousedown', this.onDrawDown);
    window.removeEventListener('mousemove', this.onDrawMove);
    window.removeEventListener('mouseup', this.onDrawUp);
  }

  private amDrawer(): boolean {
    return !this.isSpectator && this.game.drawerPeerId === this.myPeerId && this.game.phase === 'drawing';
  }

  private onDrawDown = (e: MouseEvent): void => {
    if (this.paused || !this.amDrawer()) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = canvasToDraw(e.clientX - rect.left, e.clientY - rect.top, rect);
    if (!isInDrawArea(x, y)) return;
    this.isDrawingStroke = true;
    this.liveStroke = {
      points: [{ x, y }],
      color: this.toolColor,
      width: this.toolWidth,
      erase: this.toolErase,
      style: this.toolStyle,
      shape: this.toolShape,
    };
  };

  private onDrawMove = (e: MouseEvent): void => {
    if (!this.isDrawingStroke || !this.liveStroke) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = canvasToDraw(e.clientX - rect.left, e.clientY - rect.top, rect);
    const clamped = clampToDraw(x, y);
    if (this.liveStroke.shape && this.liveStroke.shape !== 'free') {
      // 도형: 시작점 + 현재점 2개만 유지 (드래그 중 실시간 미리보기)
      this.liveStroke.points = [this.liveStroke.points[0]!, clamped];
    } else {
      this.liveStroke.points.push(clamped);
    }
  };

  private onDrawUp = (): void => {
    if (!this.isDrawingStroke || !this.liveStroke) return;
    this.isDrawingStroke = false;
    // 완료된 stroke 를 누적 + broadcast
    const stroke = this.liveStroke;
    this.liveStroke = null;
    if (stroke.points.length > 0) {
      this.strokes.push(stroke);
      this.ctx.sendToPeer(encodeStroke(stroke));
    }
  };

  // ============================================
  // HTML UI — 도구 / 후보 단어 / 추측 입력
  // ============================================

  private mountUI(): void {
    const parent = this.ctx.canvas.parentElement;
    if (!parent) return;
    const container = document.createElement('div');
    container.className = 'dq-ui';
    container.innerHTML = `
      <div class="dq-candidates" id="dq-candidates" style="display:none"></div>
      <div class="dq-toolbar" id="dq-toolbar" style="display:none">
        <div class="dq-tool-group" id="dq-colors"></div>
        <div class="dq-tool-group" id="dq-widths"></div>
        <div class="dq-tool-group" id="dq-styles"></div>
        <div class="dq-tool-group" id="dq-shapes"></div>
        <button class="dq-tool-btn" id="dq-erase" type="button" title="지우개">🧽</button>
        <button class="dq-tool-btn" id="dq-clear" type="button" title="전체 지우기">🗑️</button>
      </div>
      <div class="dq-guessbar" id="dq-guessbar" style="display:none">
        <form class="dq-guess-form" id="dq-guess-form" autocomplete="off">
          <input type="text" class="dq-guess-input" id="dq-guess-input" maxlength="20"
                 placeholder="정답을 입력하고 Enter" />
          <button type="submit" class="dq-guess-submit">추측</button>
        </form>
      </div>
    `;
    parent.appendChild(container);
    this.toolbarEl = container.querySelector('#dq-toolbar');
    this.guessBarEl = container.querySelector('#dq-guessbar');
    this.candidatesEl = container.querySelector('#dq-candidates');

    this.buildColorButtons(container);
    this.buildWidthButtons(container);
    this.buildStyleButtons(container);
    this.buildShapeButtons(container);
    container.querySelector('#dq-erase')?.addEventListener('click', () => {
      this.toolErase = !this.toolErase;
      (container.querySelector('#dq-erase') as HTMLElement)?.classList.toggle('is-active', this.toolErase);
    });
    container.querySelector('#dq-clear')?.addEventListener('click', () => {
      if (!this.amDrawer()) return;
      this.strokes = [];
      this.liveStroke = null;
      this.ctx.sendToPeer(encodeClear());
    });

    const guessForm = container.querySelector<HTMLFormElement>('#dq-guess-form');
    guessForm?.addEventListener('submit', this.onGuessSubmit);

    this.uiRoot = container;
    this.refreshUI();
  }
  private uiRoot: HTMLDivElement | null = null;

  private buildColorButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#dq-colors');
    if (!wrap) return;
    PALETTE.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dq-color-btn' + (i === 0 ? ' is-active' : '');
      b.style.background = c;
      b.addEventListener('click', () => {
        this.toolColor = c;
        this.toolErase = false;
        wrap.querySelectorAll('.dq-color-btn').forEach((el) => el.classList.remove('is-active'));
        b.classList.add('is-active');
        (root.querySelector('#dq-erase') as HTMLElement)?.classList.remove('is-active');
      });
      wrap.appendChild(b);
    });
  }

  private buildWidthButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#dq-widths');
    if (!wrap) return;
    WIDTHS.forEach((w, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dq-width-btn' + (i === 1 ? ' is-active' : '');
      b.innerHTML = `<span style="width:${w}px;height:${w}px"></span>`;
      b.addEventListener('click', () => {
        this.toolWidth = w;
        wrap.querySelectorAll('.dq-width-btn').forEach((el) => el.classList.remove('is-active'));
        b.classList.add('is-active');
      });
      wrap.appendChild(b);
    });
  }

  private buildStyleButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#dq-styles');
    if (!wrap) return;
    const styles: Array<{ id: 'pen' | 'block' | 'marker'; icon: string; title: string }> = [
      { id: 'pen', icon: '✏️', title: '펜' },
      { id: 'block', icon: '⬛', title: '블록(각진)' },
      { id: 'marker', icon: '🖍️', title: '형광펜' },
    ];
    styles.forEach((st, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dq-tool-btn' + (i === 0 ? ' is-active' : '');
      b.textContent = st.icon;
      b.title = st.title;
      b.addEventListener('click', () => {
        this.toolStyle = st.id;
        wrap.querySelectorAll('.dq-tool-btn').forEach((el) => el.classList.remove('is-active'));
        b.classList.add('is-active');
      });
      wrap.appendChild(b);
    });
  }

  private buildShapeButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#dq-shapes');
    if (!wrap) return;
    const shapes: Array<{ id: 'free' | 'rect' | 'ellipse' | 'line'; icon: string; title: string }> = [
      { id: 'free', icon: '〰️', title: '자유선' },
      { id: 'line', icon: '／', title: '직선' },
      { id: 'rect', icon: '▭', title: '사각형' },
      { id: 'ellipse', icon: '◯', title: '원' },
    ];
    shapes.forEach((sh, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dq-tool-btn' + (i === 0 ? ' is-active' : '');
      b.textContent = sh.icon;
      b.title = sh.title;
      b.addEventListener('click', () => {
        this.toolShape = sh.id;
        wrap.querySelectorAll('.dq-tool-btn').forEach((el) => el.classList.remove('is-active'));
        b.classList.add('is-active');
      });
      wrap.appendChild(b);
    });
  }

  private onGuessSubmit = (e: Event): void => {
    e.preventDefault();
    const input = this.uiRoot?.querySelector<HTMLInputElement>('#dq-guess-input');
    if (!input) return;
    const word = input.value.trim();
    if (!word) return;
    input.value = '';
    if (this.isSpectator) return;
    if (this.game.phase !== 'drawing') return;
    if (this.game.drawerPeerId === this.myPeerId) return; // 출제자는 추측 X
    if (this.game.correctThisRound.includes(this.myPeerId)) return; // 이미 맞힘

    if (this.isHost) {
      this.tryGuessAsHost(this.myPeerId, this.myNickname(), word);
    } else {
      this.ctx.sendToPeer(encodeGuess({ word, peerId: this.myPeerId, nickname: this.myNickname() }));
    }
  };

  /** 호스트가 추측 판정 (자기 추측 + 게스트 추측 공통) */
  private tryGuessAsHost(peerId: string, nickname: string, word: string): void {
    if (this.game.phase !== 'drawing') return;
    if (peerId === this.game.drawerPeerId) return;
    if (this.game.correctThisRound.includes(peerId)) return;
    if (!isCorrectGuess(word, this.realWord)) return; // 오답 — 무시 (호스트 실제 단어로 판정)

    const ok = awardCorrect(this.game, peerId);
    if (ok) {
      const rank = this.game.correctThisRound.indexOf(peerId) + 1;
      this.ctx.sendToPeer(encodeCorrect({
        peerId, nickname, scores: scoreMap(this.game), rank,
      }));
      // 호스트 본인 화면도 반영
      sound.play('tetris_clear');
      this.refreshUI();
      // 전원 정답이면 loop 에서 곧 endRound
    }
  }

  private myNickname(): string {
    return this.game.players.find((p) => p.peerId === this.myPeerId)?.nickname ?? '나';
  }

  private unmountUI(): void {
    this.uiRoot?.remove();
    this.uiRoot = null;
    this.toolbarEl = null;
    this.guessBarEl = null;
    this.candidatesEl = null;
  }

  /** phase / 역할에 따라 도구·후보·추측 UI 보임 전환 */
  private refreshUI(): void {
    if (!this.uiRoot) return;
    const amDrawer = !this.isSpectator && this.game.drawerPeerId === this.myPeerId;

    // 출제자 단어 결정 UI (choosing + 출제자)
    if (this.candidatesEl) {
      const choosing = this.game.phase === 'choosing' && amDrawer;
      if (choosing && this.wordMode === 'custom') {
        // 직접 입력 — 입력창(이미 떠 있으면 재생성 안 함: 타이핑 중 값 유지)
        this.candidatesEl.style.display = 'flex';
        if (!this.candidatesEl.querySelector('.dq-customword-input')) {
          this.candidatesEl.innerHTML = `
            <form class="dq-customword-form" autocomplete="off">
              <input type="text" class="dq-customword-input" maxlength="12" placeholder="출제할 단어 입력 후 Enter" />
              <button type="submit" class="dq-candidate-btn">출제</button>
            </form>`;
          const form = this.candidatesEl.querySelector<HTMLFormElement>('.dq-customword-form');
          form?.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = this.candidatesEl!.querySelector<HTMLInputElement>('.dq-customword-input');
            const word = input?.value.trim();
            if (word) this.submitCustomWord(word);
          });
          window.setTimeout(() => this.candidatesEl?.querySelector<HTMLInputElement>('.dq-customword-input')?.focus(), 10);
        }
      } else if (choosing && this.candidates.length > 0) {
        // (자동 모드는 choosing 을 건너뛰므로 보통 여기 안 옴 — 후보 버튼 폴백)
        this.candidatesEl.style.display = 'flex';
        this.candidatesEl.innerHTML = '';
        this.candidates.forEach((c, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'dq-candidate-btn';
          b.textContent = c.word;
          b.addEventListener('click', () => {
            if (this.isHost) {
              this.handleOwnWordChoice(i);
            } else {
              this.game.currentWord = this.candidates[i]!.word;
              this.ctx.sendToPeer(encodeWordChosen(i));
            }
          });
          this.candidatesEl!.appendChild(b);
        });
      } else {
        this.candidatesEl.style.display = 'none';
        this.candidatesEl.innerHTML = '';
      }
    }

    // 도구 (drawing + 출제자)
    if (this.toolbarEl) {
      this.toolbarEl.style.display = (this.game.phase === 'drawing' && amDrawer) ? 'flex' : 'none';
    }

    // 추측 입력 (drawing + 비출제자 + 비관전 + 안 맞힌 사람)
    if (this.guessBarEl) {
      const canGuess = this.game.phase === 'drawing'
        && !amDrawer && !this.isSpectator
        && !this.game.correctThisRound.includes(this.myPeerId);
      this.guessBarEl.style.display = canGuess ? 'flex' : 'none';
      if (canGuess) {
        window.setTimeout(() => {
          this.uiRoot?.querySelector<HTMLInputElement>('#dq-guess-input')?.focus();
        }, 10);
      }
    }
  }
}

// ============================================
// 헬퍼
// ============================================

function clampToDraw(x: number, y: number): StrokePoint {
  return {
    x: Math.max(0, Math.min(560, x)),
    y: Math.max(0, Math.min(400, y)),
  };
}

/** sync 로 받은 game 의 usedWords/Set 복원 (JSON 직렬화로 객체가 됨) */
function reviveGame(g: DrawQuizGame): DrawQuizGame {
  const used = g.usedWords;
  return {
    ...g,
    usedWords: used instanceof Set ? used : new Set(Array.isArray(used) ? used : []),
    correctThisRound: Array.isArray(g.correctThisRound) ? g.correctThisRound : [],
  };
}

function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

export function createDrawQuizGame(): GameModule {
  return new DrawQuizGameModule();
}
