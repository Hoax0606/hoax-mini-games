/**
 * 가짜 화가 GameModule — 조립 (호스트 authoritative).
 *
 * 라이어 게임 엔진 이식(역할 비밀배분/투표/추측/점수/봇/이탈) + draw-quiz 입력·공유캔버스.
 * 흐름: 역할배분 → draw(턴제 한 획씩, laps 바퀴) → vote(마피아 지목) → (지목=마피아면)guess → result → 다음 라운드.
 *
 * 비밀(역할/제시어/마피아/투표)은 sync 에 안 담고 fa:role 로 각 peer 에게만.
 * 그림은 공유 — 호스트가 authoritative 로 strokes 에 쌓고 fa:sync 로 전파(턴제라 스트로크당 sync 로 충분).
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import { pickRound } from '../liar-game/words';
import {
  createInitialGame, resetForRound, currentDrawer, advanceDraw,
  tallyVotes, scoreRound, finalRanking, colorFor, isDummy,
  DRAW_LAPS_DEFAULT,
  type FakeArtistGame, type StrokeData, type Role,
} from './rules';
import {
  encodeHello, decodeHello, encodeSync, decodeSync,
  encodeRole, decodeRole, encodeStroke, decodeStroke,
  encodeVote, decodeVote, encodeGuess, decodeGuess,
  encodeReveal, encodeEnd, decodeEnd,
  type RolePayload,
} from './netSync';
import { FakeArtistRenderer, PEN_WIDTH, type FaRenderState } from './render';

const DRAW_TURN_MS = 30_000;
const VOTE_TIMEOUT_MS = 30_000;
const GUESS_TIMEOUT_MS = 30_000;
const RESULT_DELAY_MS = 6_000;
const END_DELAY_MS = 1_500;
const DUMMY_DELAY_MS = 1_100;
const ACTION_RESEND_MS = 2_500;

class FakeArtistModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: FakeArtistRenderer;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private laps = DRAW_LAPS_DEFAULT;

  // 공개 상태
  private game!: FakeArtistGame;

  // 로컬 상태 (모든 클라)
  private myRole: RolePayload | null = null;
  private myRoleRound = -1;
  private liveStroke: StrokeData | null = null;
  private isDrawingStroke = false;
  /** 이번 drawIndex 에 내가 이미 획을 냈으면 잠금 */
  private mySentDrawIndex = -1;
  private mySentStroke: StrokeData | null = null;
  private iVoted = false;
  private myVoteRound = -1;
  private myVoteTarget: string | null = null;
  private iGuessed = false;
  private lastHelloAt = 0;
  private lastActionResendAt = 0;

  // 호스트 전용 비밀
  private realWord = '';
  private fakePeerId = '';
  private hostVotes: Record<string, string> = {};
  private usedWords = new Set<string>();
  private fakeBag: string[] = [];
  private resolved = false;
  private revealVotes: Record<string, string> | null = null;
  private phaseDeadline = 0;
  private roundAdvanceScheduled = false;
  private endScheduled = false;

  // 표시 타이머 (로컬)
  private displayDeadline = 0;
  private lastPhaseKey = '';
  private rafId: number | null = null;
  private dummyTimer: number | null = null;
  private destroyed = false;
  private ended = false;
  private paused = false;
  private pauseStart = 0;

  // ============================================
  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.laps = Math.max(1, Math.min(3, Number(ctx.roomOptions['laps'] ?? DRAW_LAPS_DEFAULT)));

    this.renderer = new FakeArtistRenderer(ctx.canvas, {
      onVote: (t) => this.doVote(t),
      onGuess: (w) => this.doGuess(w),
    });
    this.attachDrawInput();
    sound.startBgm('apple-game');

    const players = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'))
      .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));
    this.game = createInitialGame(players.length ? players : [{ peerId: this.myPeerId, nickname: ctx.myNickname ?? '나' }], this.laps);

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
      if (this.isHost) { this.sendStateTo(hello.peerId); }
      return;
    }
    const sync = decodeSync(msg);
    if (sync) {
      if (!this.isHost) {
        this.game = sync;
        if (this.myRoleRound !== sync.round) this.myRole = null; // stale → 재요청
        this.render();
      }
      return;
    }
    const role = decodeRole(msg);
    if (role) {
      if (!this.isHost) { this.myRole = role; this.myRoleRound = role.round; this.render(); }
      return;
    }
    const end = decodeEnd(msg);
    if (end) { if (!this.isHost) this.scheduleEndLocal(end); return; }

    if (this.isHost) {
      const stroke = decodeStroke(msg);
      if (stroke) { this.handleStroke(stroke.from, stroke.stroke); return; }
      const vote = decodeVote(msg);
      if (vote) { this.handleVote(vote.from, vote.target); return; }
      const guess = decodeGuess(msg);
      if (guess) { this.handleGuess(guess.from, guess.word); return; }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.ended = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.dummyTimer !== null) window.clearTimeout(this.dummyTimer);
    this.detachDrawInput();
    this.renderer?.destroy();
    sound.stopBgm();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.pauseStart = performance.now();
    else if (this.pauseStart > 0) {
      const delta = performance.now() - this.pauseStart;
      this.phaseDeadline += delta;
      if (this.displayDeadline > 0) this.displayDeadline += delta;
      this.pauseStart = 0;
    }
  }

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.destroyed || this.ended) return;
    // 이탈자는 남겨두되, 진행이 그를 기다리면 타임아웃이 스킵. 활성 1명 이하면 종료.
    const active = this.game.players.filter((p) => !isDummy(p.peerId) && p.peerId !== peerId);
    if (active.length <= 1) { this.finishAsHost(); return; }
    // 현재 그릴 차례/투표를 기다리는 중이면 즉시 정리
    if (this.game.phase === 'draw' && currentDrawer(this.game) === peerId) this.skipDrawTurn();
    else if (this.game.phase === 'vote') this.maybeTallyVotes();
  }

  // ============================================
  // 루프
  // ============================================
  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;
    const now = performance.now();

    if (this.isHost && !this.paused && !this.ended && this.phaseDeadline > 0 && now > this.phaseDeadline) {
      this.phaseDeadline = 0;
      this.onPhaseTimeout();
    }

    // 게스트: 역할 못 받았으면 hello 재전송
    if (!this.isHost && !this.isSpectator && this.myRole === null && now - this.lastHelloAt > 2000) {
      this.lastHelloAt = now;
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }

    // 게스트: 내 입력(획/투표/추측) 유실 대비 재전송 (같은 상황 유지 중이면, 멱등)
    if (!this.isHost && !this.isSpectator && this.game && now - this.lastActionResendAt > ACTION_RESEND_MS) {
      const g = this.game;
      let resent = true;
      if (g.phase === 'draw' && currentDrawer(g) === this.myPeerId
          && this.mySentDrawIndex === g.drawIndex && this.mySentStroke) {
        this.ctx.sendToPeer(encodeStroke(this.myPeerId, this.mySentStroke));
      } else if (g.phase === 'vote' && this.iVoted && this.myVoteRound === g.round && this.myVoteTarget) {
        this.ctx.sendToPeer(encodeVote(this.myPeerId, this.myVoteTarget));
      } else {
        resent = false;
      }
      if (resent) this.lastActionResendAt = now;
    }

    // 표시 타이머
    if (this.game) {
      const g = this.game;
      const phaseKey = `${g.phase}:${g.round}:${g.drawIndex}`;
      if (phaseKey !== this.lastPhaseKey) {
        this.lastPhaseKey = phaseKey;
        const dur = g.phase === 'draw' ? DRAW_TURN_MS : g.phase === 'vote' ? VOTE_TIMEOUT_MS
          : g.phase === 'guess' ? GUESS_TIMEOUT_MS : 0;
        this.displayDeadline = dur > 0 ? now + dur : 0;
      }
      const renderNow = this.paused && this.pauseStart > 0 ? this.pauseStart : now;
      const remainMs = this.displayDeadline > 0 ? Math.max(0, this.displayDeadline - renderNow) : 0;
      this.render(remainMs);
    }
  };

  private onPhaseTimeout(): void {
    switch (this.game.phase) {
      case 'draw': this.skipDrawTurn(); break;
      case 'vote': this.maybeTallyVotes(true); break;
      case 'guess': this.resolveRound(false, null); break;
    }
  }

  // ============================================
  // 렌더
  // ============================================
  private render(remainMs = 0): void {
    if (!this.game) return;
    const rs: FaRenderState = {
      game: this.game,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      myRole: this.myRole,
      liveStroke: this.liveStroke,
      remainMs,
      iVoted: this.iVoted && this.myVoteRound === this.game.round,
      iGuessed: this.iGuessed,
      revealVotes: this.revealVotes,
    };
    try { this.renderer.render(rs); } catch (err) { console.error('[fake-artist] render 실패', err); }
  }

  private sync(): void {
    if (this.isHost) this.ctx.sendToPeer(encodeSync(this.game));
  }

  // ============================================
  // 그리기 입력 (draw-quiz 패턴)
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
    return !this.isSpectator && this.game.phase === 'draw'
      && currentDrawer(this.game) === this.myPeerId
      && this.mySentDrawIndex !== this.game.drawIndex; // 이번 획 아직 안 냄
  }

  private myColor(): string {
    return this.myRole?.color ?? this.game.colors[this.myPeerId] ?? colorFor(0);
  }

  private onDrawDown = (e: MouseEvent): void => {
    if (this.paused || !this.amDrawer()) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
    if (!this.renderer.isInPaper(x, y)) return;
    this.isDrawingStroke = true;
    this.liveStroke = { points: [{ x, y }], color: this.myColor(), width: PEN_WIDTH, tool: 'pen', shape: 'free' };
  };
  private onDrawMove = (e: MouseEvent): void => {
    if (!this.isDrawingStroke || !this.liveStroke) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
    this.liveStroke.points.push({ x, y });
  };
  private onDrawUp = (): void => {
    if (!this.isDrawingStroke || !this.liveStroke) return;
    this.isDrawingStroke = false;
    const stroke = this.liveStroke;
    this.liveStroke = null;
    if (stroke.points.length === 0) return;
    this.submitStroke(stroke);
  };

  private submitStroke(stroke: StrokeData): void {
    // 이번 턴 잠금
    this.mySentDrawIndex = this.game.drawIndex;
    this.mySentStroke = stroke;
    if (this.isHost) {
      this.handleStroke(this.myPeerId, stroke); // 호스트 authoritative (push+advance+sync)
    } else {
      this.game.strokes.push(stroke);            // 낙관적 표시 (곧 sync 로 확정)
      this.ctx.sendToPeer(encodeStroke(this.myPeerId, stroke));
      this.render();
    }
  }

  // ============================================
  // 호스트: 라운드/드로우
  // ============================================
  private startRoundAsHost(): void {
    this.fakePeerId = this.nextFake();
    const { category, keyword } = pickRound(this.usedWords);
    this.usedWords.add(keyword);
    this.realWord = keyword;

    const n = this.game.players.length;
    const startIdx = (this.game.round - 1) % n;
    const ids = this.game.players.map((p) => p.peerId);
    const order = [...ids.slice(startIdx), ...ids.slice(0, startIdx)];
    resetForRound(this.game, category, order);

    this.hostVotes = {};
    this.resolved = false;
    this.revealVotes = null;
    this.roundAdvanceScheduled = false;
    this.resetLocalRoundFlags();

    for (const p of this.game.players) {
      if (p.peerId === this.myPeerId) { this.myRole = this.roleFor(p.peerId); this.myRoleRound = this.game.round; }
      else if (!isDummy(p.peerId)) this.ctx.sendToPeer(encodeRole(this.roleFor(p.peerId)), { target: p.peerId });
    }
    this.phaseDeadline = performance.now() + DRAW_TURN_MS;
    this.sync();
    this.render();
    sound.play('pop');
    this.scheduleDummies();
  }

  private resetLocalRoundFlags(): void {
    this.mySentDrawIndex = -1;
    this.mySentStroke = null;
    this.iVoted = false;
    this.myVoteTarget = null;
    this.iGuessed = false;
  }

  private roleFor(peerId: string): RolePayload {
    const role: Role = peerId === this.fakePeerId ? 'fake' : 'citizen';
    return {
      role,
      word: role === 'fake' ? '' : this.realWord,
      category: this.game.category,
      color: this.game.colors[peerId] ?? colorFor(0),
      round: this.game.round,
    };
  }

  /** 공정 마피아 로테이션 봉투 — 비면 전원 셔플로 재충전. 5라운드 동안 모두 한 번씩. */
  private nextFake(): string {
    if (this.fakeBag.length === 0) {
      this.fakeBag = this.game.players.map((p) => p.peerId);
      for (let i = this.fakeBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.fakeBag[i], this.fakeBag[j]] = [this.fakeBag[j]!, this.fakeBag[i]!];
      }
    }
    return this.fakeBag.shift()!;
  }

  private handleStroke(from: string, stroke: StrokeData): void {
    if (this.game.phase !== 'draw' || this.ended) return;
    if (from !== currentDrawer(this.game)) return;
    // 색 강제(치팅 방지) + 펜/free 고정 + 점 개수 방어
    const safe: StrokeData = {
      points: stroke.points.slice(0, 4000),
      color: this.game.colors[from] ?? colorFor(0),
      width: PEN_WIDTH, tool: 'pen', shape: 'free',
    };
    this.game.strokes.push(safe);
    this.afterDrawTurn();
  }

  /** 시간 초과/이탈 — 이번 드로어 스킵(획 없이 진행) */
  private skipDrawTurn(): void {
    if (this.game.phase !== 'draw') return;
    this.afterDrawTurn();
  }

  private afterDrawTurn(): void {
    const { done } = advanceDraw(this.game);
    if (done) {
      this.game.phase = 'vote';
      this.hostVotes = {};
      this.phaseDeadline = performance.now() + VOTE_TIMEOUT_MS;
    } else {
      this.phaseDeadline = performance.now() + DRAW_TURN_MS;
    }
    this.sync();
    this.render();
    this.scheduleDummies();
  }

  // ============================================
  // 투표 / 추측 / 결과
  // ============================================
  private handleVote(from: string, target: string): void {
    if (this.game.phase !== 'vote') return;
    if (from === target) return;
    if (!this.game.players.some((p) => p.peerId === from)) return;
    this.hostVotes[from] = target;
    this.maybeTallyVotes();
  }

  private maybeTallyVotes(force = false): void {
    if (this.game.phase !== 'vote') return;
    const allVoted = this.game.players.every((p) => p.peerId in this.hostVotes || isDummy(p.peerId));
    if (!force && !allVoted) return;
    // 더미 미투표분 랜덤 채움
    for (const p of this.game.players) {
      if (isDummy(p.peerId) && !(p.peerId in this.hostVotes)) {
        const others = this.game.players.map((x) => x.peerId).filter((x) => x !== p.peerId);
        this.hostVotes[p.peerId] = pick(others);
      }
    }
    const accused = tallyVotes(this.hostVotes);
    this.game.accusedPeerId = accused;
    if (accused === this.fakePeerId) {
      // 마피아 잡힘 → 제시어 맞히기 기회
      this.game.phase = 'guess';
      this.phaseDeadline = performance.now() + GUESS_TIMEOUT_MS;
      this.sync();
      this.render();
      this.scheduleDummies();
    } else {
      this.resolveRound(true, null); // 못 잡음 → 마피아 승
    }
  }

  private handleGuess(from: string, word: string): void {
    if (this.game.phase !== 'guess' || from !== this.fakePeerId) return;
    const correct = norm(word) === norm(this.realWord);
    this.resolveRound(correct, word);
  }

  private resolveRound(fakeWon: boolean, guess: string | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.game.phase = 'result';
    this.game.revealedFakePeerId = this.fakePeerId;
    this.game.fakeWon = fakeWon;
    this.game.fakeGuess = guess;
    this.game.revealedWord = this.realWord;
    scoreRound(this.game, this.fakePeerId, this.hostVotes, fakeWon);
    this.revealVotes = { ...this.hostVotes };
    this.phaseDeadline = 0;
    this.sync();
    this.ctx.sendToPeer(encodeReveal(this.revealVotes));
    this.render();
    sound.play(fakeWon ? 'button_click' : 'goal');

    if (this.roundAdvanceScheduled) return;
    this.roundAdvanceScheduled = true;
    window.setTimeout(() => {
      if (this.destroyed || this.ended) return;
      if (this.game.round >= this.game.totalRounds) this.finishAsHost();
      else { this.game.round += 1; this.startRoundAsHost(); }
    }, RESULT_DELAY_MS);
  }

  private finishAsHost(): void {
    if (this.ended) return;
    this.ended = true;
    this.game.phase = 'ended';
    const ranking = finalRanking(this.game);
    this.sync();
    this.render();
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId || isDummy(p.peerId)) continue;
      const spec = p.role === 'spectator';
      this.ctx.sendToPeer(encodeEnd(this.resultFor(ranking, p.peerId, spec)), { target: p.peerId });
    }
    this.scheduleEndLocal(this.resultFor(ranking, this.myPeerId, this.isSpectator));
  }

  private resultFor(
    ranking: Array<{ peerId: string; nickname: string; score: number; rank: number }>,
    peerId: string, spectator: boolean,
  ): GameResult {
    const rank = ranking.find((r) => r.peerId === peerId)?.rank ?? ranking.length;
    return {
      winner: spectator ? null : (rank === 1 ? 'me' : 'opponent'),
      summary: {
        gameId: 'fake-artist',
        myPeerId: peerId,
        rank,
        totalPlayers: ranking.length,
        rankings: ranking.map((r) => ({ peerId: r.peerId, nickname: r.nickname, score: r.score, rank: r.rank })),
      },
    };
  }

  private scheduleEndLocal(result: GameResult): void {
    if (this.endScheduled) return;
    this.endScheduled = true;
    window.setTimeout(() => { if (!this.destroyed) this.ctx.endGame(result); }, END_DELAY_MS);
  }

  // ============================================
  // 클라 입력 (투표/추측)
  // ============================================
  private doVote(target: string): void {
    if (this.iVoted && this.myVoteRound === this.game.round) return;
    this.iVoted = true;
    this.myVoteRound = this.game.round;
    this.myVoteTarget = target;
    if (this.isHost) this.handleVote(this.myPeerId, target);
    else this.ctx.sendToPeer(encodeVote(this.myPeerId, target));
    this.render();
  }

  private doGuess(word: string): void {
    if (this.iGuessed) return;
    this.iGuessed = true;
    if (this.isHost) this.handleGuess(this.myPeerId, word);
    else this.ctx.sendToPeer(encodeGuess(this.myPeerId, word));
    this.render();
  }

  // ============================================
  // 더미봇 (솔로 프리뷰)
  // ============================================
  private scheduleDummies(): void {
    if (!this.isHost || this.ended) return;
    if (!this.game.players.some((p) => isDummy(p.peerId))) return;
    if (this.dummyTimer !== null) return;
    this.dummyTimer = window.setTimeout(() => {
      this.dummyTimer = null;
      if (this.destroyed || this.ended) return;
      this.driveDummies();
    }, DUMMY_DELAY_MS);
  }

  private driveDummies(): void {
    const g = this.game;
    if (g.phase === 'draw') {
      const d = currentDrawer(g);
      if (d && isDummy(d)) this.handleStroke(d, this.randomScribble(g.colors[d] ?? colorFor(0)));
    } else if (g.phase === 'vote') {
      for (const p of g.players) {
        if (!isDummy(p.peerId) || p.peerId in this.hostVotes) continue;
        const others = g.players.map((x) => x.peerId).filter((x) => x !== p.peerId);
        this.handleVote(p.peerId, pick(others));
      }
    } else if (g.phase === 'guess') {
      if (isDummy(this.fakePeerId)) this.handleGuess(this.fakePeerId, '???'); // 봇 마피아는 오답
    }
  }

  /** 봇이 캔버스에 긋는 작은 랜덤 획 */
  private randomScribble(color: string): StrokeData {
    const cx = 120 + Math.random() * 520;
    const cy = 100 + Math.random() * 280;
    const pts = [{ x: cx, y: cy }];
    const steps = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < steps; i++) {
      pts.push({ x: cx + (Math.random() - 0.5) * 90, y: cy + (Math.random() - 0.5) * 90 });
    }
    return { points: pts, color, width: PEN_WIDTH, tool: 'pen', shape: 'free' };
  }

  // ============================================
  // 헬퍼
  // ============================================
  private sendStateTo(peerId: string): void {
    this.ctx.sendToPeer(encodeSync(this.game), { target: peerId });
    if (this.game.players.some((p) => p.peerId === peerId) && this.realWord) {
      this.ctx.sendToPeer(encodeRole(this.roleFor(peerId)), { target: peerId });
    }
    if (this.revealVotes) this.ctx.sendToPeer(encodeReveal(this.revealVotes), { target: peerId });
  }
}

// ============================================
// 모듈 밖 헬퍼
// ============================================
function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** 공백 제거 + 소문자화 (추측 비교용) */
function norm(s: string): string {
  return s.replace(/\s/g, '').toLowerCase();
}

export function createFakeArtistGame(): GameModule {
  return new FakeArtistModule();
}
