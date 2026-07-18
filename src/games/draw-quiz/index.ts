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
 * 그리기 도구 UI (canvas 외부 HTML, 출제자에게만 표시):
 *   도구(라디오): 펜 / 형광펜 / 지우개 / 채우기 / 스포이드
 *   도형: 자유선 / 직선 / 사각형 / 원 (펜·형광펜만)
 *   색: 팔레트 스와치 + 컬러 피커(그라데이션 선택)
 *   굵기 5단, 실행취소(마지막 획), 전체지우기.
 *   채우기·지우개·투명 처리는 offscreen 누적 레이어에서 (render.ts 참고).
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
  DrawQuizRenderer, isInDrawArea,
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
  encodeUndo, isUndo,
  encodeClear, isClear,
  encodeGuess, decodeGuess,
  encodeCorrect, decodeCorrect,
  encodeRoundEnd, decodeRoundEnd,
  encodeEnd, decodeEnd,
  type StrokeData,
  type DrawTool,
  type ShapeKind,
} from './netSync';
import { icon } from '../../ui/icons';

/** 라운드 결과 표시 시간 (ms) */
const ROUND_RESULT_MS = 3500;
/** 지우개 전용 굵기 (펜보다 크게) */
const ERASE_WIDTH = 26;
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
  // 도구는 라디오 방식 — 하나만 활성. 'eyedropper' 는 stroke 를 만들지 않는 UI 전용 모드.
  private tool: DrawTool | 'eyedropper' = 'pen';
  private toolShape: ShapeKind = 'free';

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

    const playerList = ctx.players.filter((p) => p.role === 'player');
    const ordered = orderPlayersHostFirst(playerList);

    // 전체 라운드 = 1인당 그리는 횟수 × 인원. 1인당 횟수는 인원 반비례(적으면 많이).
    //   pickNextDrawer 가 한 바퀴 다 돌면 hasDrawn 리셋해 다음 바퀴로 넘어가므로,
    //   totalRounds 만 늘리면 전원이 여러 번 돌아가며 출제하게 된다.
    //   단 총 15라운드 상한 — 다인원(예: 10인)에서 30라운드(~40분) 되던 것 방지.
    const rounds = Math.min(15, roundsPerPlayer(ordered.length) * ordered.length);
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

    if (isUndo(msg)) {
      // 출제자가 마지막 획 되돌림 — 비출제자도 동일하게 pop.
      //   배열 참조는 유지하고 pop 만 하면 렌더러가 committedCount 축소를 감지해 레이어 재구성.
      if (this.game.drawerPeerId !== this.myPeerId) this.strokes.pop();
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
      } else if (this.game.phase === 'choosing') {
        // 출제자가 단어를 안 정하고 오래 끌면 후보 하나로 자동 시작 (무한 대기 방지)
        if (now - this.game.turnStartedAt > CHOOSE_TIMEOUT_MS) {
          const fallback = this.candidates[0];
          if (fallback) this.beginDrawingAsHost(fallback.word);
        }
      }
    }

    // 정지 중엔 render 시각을 pauseStart 로 얼려 타이머 표시가 안 흐르게(모달 뒤 타이머 진행 방지)
    const renderNow = this.paused && this.pauseStart > 0 ? this.pauseStart : now;
    this.renderer.render(this.buildRenderState(renderNow));
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

    // round_start broadcast — 출제자에게만 후보 3개 전송(매 턴 후보 택1 또는 직접입력 선택)
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
    // choosing 단계 유지 — 출제자가 후보 택1 또는 직접입력 중 고를 때까지 대기 (타임아웃 폴백은 loop)
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

  /** 출제자가 주어진 후보(index) 선택 */
  private chooseGivenWord(index: number): void {
    if (this.game.phase !== 'choosing') return;
    if (this.isHost) {
      this.handleOwnWordChoice(index);
    } else {
      const c = this.candidates[index];
      if (c) this.game.currentWord = c.word; // 출제자 로컬 즉시 표시
      this.ctx.sendToPeer(encodeWordChosen(index));
    }
  }

  /** 출제자가 단어 직접 입력 제출 */
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

  private applyRoundBegin(wordLength: number, _turnStartedAt: number, word?: string): void {
    this.game.phase = 'drawing';
    // 타이머는 각 클라 자기 시계 기준으로 — 호스트 performance.now() 값을 그대로 쓰면
    //   시계 원점이 달라 시간이 어긋나(안 보이거나 멈춤). roundBegin 수신 시각을 시작으로.
    this.game.turnStartedAt = performance.now();
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
    window.addEventListener('keydown', this.onKeyDown);
  }
  private detachDrawInput(): void {
    if (this.ctx?.canvas) this.ctx.canvas.removeEventListener('mousedown', this.onDrawDown);
    window.removeEventListener('mousemove', this.onDrawMove);
    window.removeEventListener('mouseup', this.onDrawUp);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  /** Ctrl/⌘+Z → 실행 취소. 텍스트 입력 중이면 무시(그 자체 편집이 우선). */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!(e.key === 'z' || e.key === 'Z') || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (!this.amDrawer()) return;
    e.preventDefault();
    this.undoLastStroke();
  };

  /** 마지막 획 되돌리기 — 로컬 pop + 전원 broadcast (출제자만). */
  private undoLastStroke(): void {
    if (!this.amDrawer()) return;
    if (this.strokes.length === 0) return;
    this.strokes.pop();
    this.ctx.sendToPeer(encodeUndo());
  }

  private amDrawer(): boolean {
    return !this.isSpectator && this.game.drawerPeerId === this.myPeerId && this.game.phase === 'drawing';
  }

  private onDrawDown = (e: MouseEvent): void => {
    if (this.paused || !this.amDrawer()) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
    if (!isInDrawArea(x, y)) return;

    // 스포이드 — 그 지점 색을 뽑아 펜 색으로 잡고 자동으로 펜으로 복귀 (한 번 쓰고 원위치)
    if (this.tool === 'eyedropper') {
      const picked = this.renderer.getPixelColor(x, y);
      this.toolColor = picked;
      this.selectTool('pen');
      this.syncColorUI();
      return;
    }

    // 채우기 — 드래그 없이 클릭 한 번으로 즉시 확정 + broadcast
    if (this.tool === 'fill') {
      const stroke: StrokeData = {
        points: [clampToDraw(x, y)],
        color: this.toolColor,
        width: this.toolWidth,
        tool: 'fill',
        shape: 'free',
      };
      this.strokes.push(stroke);
      this.ctx.sendToPeer(encodeStroke(stroke));
      return;
    }

    // 펜/마커/지우개 — 드래그 스트로크 시작
    this.isDrawingStroke = true;
    this.liveStroke = {
      points: [clampToDraw(x, y)],
      color: this.toolColor,
      width: this.tool === 'eraser' ? ERASE_WIDTH : this.toolWidth,
      tool: this.tool,
      // 도형은 펜/마커에서만 의미. 지우개는 항상 자유선.
      shape: this.tool === 'eraser' ? 'free' : this.toolShape,
    };
  };

  private onDrawMove = (e: MouseEvent): void => {
    if (!this.isDrawingStroke || !this.liveStroke) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
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
        <div class="dq-tool-group" id="dq-tools"></div>
        <div class="dq-tool-group" id="dq-shapes"></div>
        <div class="dq-tool-group" id="dq-widths"></div>
        <div class="dq-tool-group dq-color-group">
          <input type="color" id="dq-color-picker" class="dq-color-picker" title="색 선택" />
          <div class="dq-swatches" id="dq-colors"></div>
        </div>
        <button class="dq-tool-btn" id="dq-undo" type="button" title="실행 취소 (Ctrl+Z)">${icon('undo', { size: 19, hue: '#8b93a7' })}</button>
        <button class="dq-tool-btn" id="dq-clear" type="button" title="전체 지우기">${icon('trash', { size: 19, hue: '#ff6b6b' })}</button>
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

    this.buildToolButtons(container);
    this.buildShapeButtons(container);
    this.buildWidthButtons(container);
    this.buildColorButtons(container);

    // 컬러 피커(그라데이션 선택기) — 팔레트에 없는 임의 색
    const picker = container.querySelector<HTMLInputElement>('#dq-color-picker');
    if (picker) {
      picker.value = this.toolColor;
      picker.addEventListener('input', () => {
        this.toolColor = picker.value;
        // 임의 색을 골랐으니 팔레트 스와치 활성 표시는 해제, 도구는 펜 계열로.
        this.uiRoot?.querySelectorAll('.dq-color-btn').forEach((el) => el.classList.remove('is-active'));
        if (this.tool === 'eraser' || this.tool === 'fill' || this.tool === 'eyedropper') this.selectTool('pen');
      });
    }

    // 실행 취소 — 마지막 획 하나 되돌리기 (출제자만). Ctrl+Z 도 동일 동작.
    container.querySelector('#dq-undo')?.addEventListener('click', () => this.undoLastStroke());

    container.querySelector('#dq-clear')?.addEventListener('click', () => {
      if (!this.amDrawer()) return;
      this.strokes = [];
      this.liveStroke = null;
      this.ctx.sendToPeer(encodeClear());
    });

    const guessForm = container.querySelector<HTMLFormElement>('#dq-guess-form');
    guessForm?.addEventListener('submit', this.onGuessSubmit);

    this.uiRoot = container;
    this.setCanvasCursor(); // 동그라미 커서 초기화
    this.refreshUI();
  }
  private uiRoot: HTMLDivElement | null = null;

  /**
   * 도구 선택 (라디오) — pen/marker/eraser/fill/eyedropper 중 하나만 활성.
   * 이전 도구는 자동 해제되므로 "지우개 골랐다 펜 다시 고르면 지우개 해제" 문제 해결.
   * 도형(shape)은 pen/marker 에서만 의미 → 그 외 도구면 도형 버튼 비활성 표시.
   */
  private selectTool(t: DrawTool | 'eyedropper'): void {
    this.tool = t;
    this.uiRoot?.querySelectorAll('#dq-tools .dq-tool-btn').forEach((el) => {
      el.classList.toggle('is-active', (el as HTMLElement).dataset.tool === t);
    });
    // 도형은 펜/마커만 — 나머지 도구일 땐 흐리게
    const shapesUsable = t === 'pen' || t === 'marker';
    this.uiRoot?.querySelector('#dq-shapes')?.classList.toggle('is-disabled', !shapesUsable);
    this.setCanvasCursor();
  }

  /** 팔레트 스와치 활성 표시 + 컬러 피커 값을 현재 toolColor 로 동기화 (스포이드/스와치 선택 후) */
  private syncColorUI(): void {
    const picker = this.uiRoot?.querySelector<HTMLInputElement>('#dq-color-picker');
    if (picker) picker.value = this.toolColor;
    this.uiRoot?.querySelectorAll('.dq-color-btn').forEach((el) => {
      el.classList.toggle('is-active', (el as HTMLElement).dataset.color === this.toolColor);
    });
  }

  /** 캔버스 커서 — 펜/마커/지우개는 브러시 크기 동그라미, 채우기/스포이드는 십자. */
  private setCanvasCursor(): void {
    if (!this.ctx?.canvas) return;
    if (this.tool === 'fill' || this.tool === 'eyedropper') {
      this.ctx.canvas.style.cursor = 'crosshair';
      return;
    }
    const erasing = this.tool === 'eraser';
    const d = erasing ? ERASE_WIDTH : Math.max(8, this.toolWidth);
    const size = Math.min(60, d + 6);
    const c = size / 2;
    const r = Math.max(2, d / 2);
    const stroke = erasing ? '#999' : '#333';
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='${stroke}' stroke-width='2'/></svg>`;
    const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    this.ctx.canvas.style.cursor = `url("${uri}") ${c} ${c}, crosshair`;
  }

  private buildToolButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#dq-tools');
    if (!wrap) return;
    const tools: Array<{ id: DrawTool | 'eyedropper'; icon: string; title: string }> = [
      { id: 'pen', icon: icon('pen', { size: 19, hue: '#ff5a92' }), title: '펜' },
      { id: 'marker', icon: icon('marker', { size: 19, hue: '#ffb020' }), title: '형광펜' },
      { id: 'eraser', icon: icon('eraser', { size: 19, hue: '#8b93a7' }), title: '지우개' },
      { id: 'fill', icon: icon('fill', { size: 19, hue: '#3fb98f' }), title: '채우기' },
      { id: 'eyedropper', icon: icon('dropper', { size: 19, hue: '#9c7aeb' }), title: '스포이드 (색 추출)' },
    ];
    tools.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dq-tool-btn' + (t.id === this.tool ? ' is-active' : '');
      b.dataset.tool = t.id;
      b.innerHTML = t.icon;
      b.title = t.title;
      b.addEventListener('click', () => this.selectTool(t.id));
      wrap.appendChild(b);
    });
  }

  private buildColorButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#dq-colors');
    if (!wrap) return;
    PALETTE.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dq-color-btn' + (i === 0 ? ' is-active' : '');
      b.dataset.color = c;
      b.style.background = c;
      b.addEventListener('click', () => {
        this.toolColor = c;
        this.syncColorUI();
        // 색 선택 = 그리기 의도 → 지우개/채우기/스포이드였으면 펜으로 복귀
        if (this.tool === 'eraser' || this.tool === 'eyedropper') this.selectTool('pen');
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
        this.setCanvasCursor(); // 커서 크기 갱신
      });
      wrap.appendChild(b);
    });
  }

  private buildShapeButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#dq-shapes');
    if (!wrap) return;
    const shapes: Array<{ id: ShapeKind; icon: string; title: string }> = [
      { id: 'free', icon: icon('shape-free', { size: 19, hue: '#5aa8ff' }), title: '자유선' },
      { id: 'line', icon: icon('shape-line', { size: 19, hue: '#5aa8ff' }), title: '직선' },
      { id: 'rect', icon: icon('shape-rect', { size: 19, hue: '#5aa8ff' }), title: '사각형' },
      { id: 'ellipse', icon: icon('shape-circle', { size: 19, hue: '#5aa8ff' }), title: '원' },
    ];
    shapes.forEach((sh, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dq-tool-btn' + (i === 0 ? ' is-active' : '');
      b.innerHTML = sh.icon;
      b.title = sh.title;
      b.addEventListener('click', () => {
        this.toolShape = sh.id;
        wrap.querySelectorAll('.dq-tool-btn').forEach((el) => el.classList.remove('is-active'));
        b.classList.add('is-active');
        // 도형 선택은 펜/마커에서만 의미 — 지우개/채우기/스포이드였으면 펜으로.
        if (this.tool !== 'pen' && this.tool !== 'marker') this.selectTool('pen');
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

    // 출제자 단어 결정 UI (choosing + 출제자) — 매 턴 후보 3개 택1 또는 직접입력
    if (this.candidatesEl) {
      const choosing = this.game.phase === 'choosing' && amDrawer;
      if (choosing) {
        this.candidatesEl.style.display = 'flex';
        // 이미 떠 있으면 재생성 안 함 (직접입력 타이핑 중 값 유지)
        if (!this.candidatesEl.querySelector('.dq-choose-wrap')) {
          // 중앙 카드: 제목 + 주어진 단어 1개(크게) + '또는' + 직접입력 + 자동시작 안내
          const wrap = document.createElement('div');
          wrap.className = 'dq-choose-wrap';

          const title = document.createElement('div');
          title.className = 'dq-choose-title';
          title.innerHTML = `${icon('pen', { size: 20, hue: '#9c7aeb' })}<span>그릴 단어</span>`;
          wrap.appendChild(title);

          const sub = document.createElement('div');
          sub.className = 'dq-choose-sub';
          sub.textContent = '이 단어로 그리거나, 직접 정해도 돼요';
          wrap.appendChild(sub);

          // 주어진 단어 1개 (택1) — 크게
          const given = this.candidates[0];
          if (given) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'dq-candidate-btn dq-choose-word';
            b.innerHTML = `${icon('dice', { size: 22, hue: '#9c7aeb' })}<span>${given.word}</span>`;
            b.title = '주어진 단어로 그리기';
            b.addEventListener('click', () => this.chooseGivenWord(0));
            wrap.appendChild(b);
          }

          const divider = document.createElement('div');
          divider.className = 'dq-choose-divider';
          divider.textContent = '또는';
          wrap.appendChild(divider);

          // 직접 입력
          const form = document.createElement('form');
          form.className = 'dq-customword-form';
          form.autocomplete = 'off';
          form.innerHTML = `
            <input type="text" class="dq-customword-input" maxlength="12" placeholder="직접 입력" />
            <button type="submit" class="dq-candidate-btn dq-choose-custom">직접 출제</button>`;
          form.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = form.querySelector<HTMLInputElement>('.dq-customword-input');
            const word = input?.value.trim();
            if (word) this.submitCustomWord(word);
          });
          wrap.appendChild(form);

          this.candidatesEl.innerHTML = '';
          this.candidatesEl.appendChild(wrap);
        }
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
