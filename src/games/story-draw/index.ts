/**
 * 스토리텔링(이어그리기) GameModule — 갈틱폰 방식.
 *
 * 흐름 (호스트 authoritative):
 *   drawing(턴 0..N-1) → 매 턴 전원이 동시에 그림, 시간 끝나면 책이 옆으로 회전 →
 *   totalTurns 후 reveal(슬라이드쇼로 책별 감상) → end(승패 없음).
 *
 * 그림은 실시간 공유하지 않음(반전 재미). 그리는 사람만 자기 컷을 로컬로 그리고,
 * 진행/제출을 호스트에게만 보낸다. 호스트가 컷을 모아 다음 턴의 "직전 컷 유령"으로 넘김.
 *
 * 타이머: 각 클라가 sd:turn 수신 시각 기준으로 로컬 카운트다운(cross-clock 오차 방지).
 *   호스트는 자기 시계로 durationMs+grace 지나면 강제 마감(제출 유실/이탈 대비).
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  createInitialGame, decideTotalTurns, assignmentFor, bookForSeat,
  type StoryDrawGame, type StoryBook, type StrokeData, type StrokePoint,
  type DrawTool, type ShapeKind,
} from './rules';
import {
  StoryDrawRenderer, isCanvasReady,
  PALETTE, WIDTHS, ERASE_WIDTH,
  type RenderState,
} from './render';
import {
  encodeHello, decodeHello,
  encodeSync, decodeSync,
  encodeTick, decodeTick,
  encodeTurn, decodeTurn,
  encodeProgress, decodeProgress,
  encodeDone, decodeDone,
  encodeReveal, decodeReveal,
  encodeEnd, decodeEnd,
} from './netSync';

/** 호스트: 컷당 시간 + 이 유예 지나면 강제 마감 */
const FINALIZE_GRACE_MS = 1500;
/** 슬라이드쇼 한 컷 노출 시간 (다인원이면 슬라이드가 많아 살짝 빠르게) */
const SLIDE_COVER_MS = 1500;
const SLIDE_CUT_MS = 1900;
/** 게스트: 미초기화/대기 상태로 이만큼 지나면 재동기 요청 */
const RESYNC_MS = 2500;
/** 호스트: 주기적 상태 재broadcast 간격 (드롭 복구) */
const SYNC_INTERVAL_MS = 2500;

interface Slide {
  type: 'cover' | 'cut';
  bookIndex: number;
  cutIndex: number;
}

class StoryDrawGameModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: StoryDrawRenderer;
  private game: StoryDrawGame | null = null;

  private myPeerId = '';
  private hostPeerId = '';
  private isHost = false;
  private isSpectator = false;
  /** 진행(progress) 전송 throttle — 마지막 전송 시각 */
  private lastProgressAt = 0;

  private rafId: number | null = null;
  private destroyed = false;
  private endScheduled = false;

  /** 내 좌석 번호 (관전자면 -1) */
  private mySeat = -1;
  /** 내가 이번 턴에 그리는 책 인덱스 */
  private myBookIndex = -1;
  /** 로컬로 셋업 완료한 턴 (중복 셋업/스트로크 유실 방지) */
  private localTurn = -1;
  private inited = false;

  /** 내 현재 컷 stroke */
  private strokes: StrokeData[] = [];
  private liveStroke: StrokeData | null = null;
  private isDrawingStroke = false;
  /** 직전 컷 유령 / 턴0 제시어 */
  private ghost: StrokeData[] | null = null;
  private promptText: string | null = null;
  /** 이번 턴 이미 제출했는지 */
  private submitted = false;
  /** 각 클라 로컬 턴 시작 시각 (카운트다운 기준) */
  private turnLocalStart = 0;

  // 호스트 전용 턴 집계
  private turnStartedAtHost = 0;
  private hostSubmitted = new Set<number>();
  private hostPending = new Map<number, { drawerPeerId: string; drawerNickname: string; strokes: StrokeData[] }>();
  private lastSyncAt = 0;

  // 게스트 재동기
  private lastHelloAt = 0;
  private waitingSince = 0;

  // 슬라이드쇼
  private revealBooks: StoryBook[] = [];
  private slides: Slide[] = [];
  private slideIdx = 0;
  private slideStart = 0;

  // 그리기 도구
  private toolColor: string = PALETTE[0];
  private toolWidth: number = WIDTHS[1];
  private tool: DrawTool | 'eyedropper' = 'pen';
  private toolShape: ShapeKind = 'free';

  private uiRoot: HTMLDivElement | null = null;
  private toolbarEl: HTMLDivElement | null = null;

  private paused = false;
  private pauseStart = 0;

  // ============================================
  // GameModule
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.hostPeerId = ctx.players.find((p) => p.isHost)?.peerId ?? '';
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    this.renderer = new StoryDrawRenderer({ canvas: ctx.canvas });
    ctx.canvas.style.cursor = 'crosshair';
    this.mountUI();
    sound.startBgm('apple-game');

    if (this.isHost) {
      const players = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'))
        .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));
      const mode = ctx.roomOptions['storyLength'] === 'long' ? 'long' : 'short';
      const durationMs = (Number(ctx.roomOptions['drawSeconds']) || 60) * 1000;
      const totalTurns = decideTotalTurns(players.length, mode);
      this.game = createInitialGame(players, totalTurns, durationMs);
      this.mySeat = this.game.seats.findIndex((s) => s.peerId === this.myPeerId);
      this.inited = true;
      this.startTurnAsHost(0);
    } else {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
      this.lastHelloAt = performance.now();
    }

    this.attachInput();
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost && this.game) {
        this.ctx.sendToPeer(encodeSync(this.game), { target: hello.peerId });
        // reveal 중 합류자에겐 슬라이드쇼 데이터도
        if (this.game.phase === 'reveal') {
          this.ctx.sendToPeer(encodeReveal(this.game.books), { target: hello.peerId });
        }
      }
      return;
    }

    const sync = decodeSync(msg);
    if (sync) {
      if (!this.isHost) this.applySync(sync.game);
      return;
    }

    // 경량 tick — 상태를 직접 적용하지 않고, 내가 뒤처졌으면 hello 로 전체 sync 를 요청만.
    const tick = decodeTick(msg);
    if (tick) {
      if (!this.isHost) {
        const now = performance.now();
        const behind = !this.inited
          || tick.phase !== this.game?.phase
          || (tick.phase === 'drawing' && tick.turn > this.localTurn);
        if (behind && now - this.lastHelloAt > 700) {
          this.lastHelloAt = now;
          this.ctx.sendToPeer(encodeHello(this.myPeerId));
        }
      }
      return;
    }

    const turn = decodeTurn(msg);
    if (turn) {
      // 재정렬/중복으로 도착한 낡은(이미 지난) 턴은 무시 — 되감기 시 stroke 유실/빈 컷 방지.
      if (!this.isHost && !(this.inited && this.game?.phase === 'drawing' && turn.turn <= this.localTurn)) {
        this.applyTurnPayload(turn.turn, turn.durationMs, turn.turnStartedAt, turn.assignments);
      }
      return;
    }

    const prog = decodeProgress(msg);
    if (prog) {
      if (this.isHost) this.hostRecord(prog.peerId, prog.turn, prog.strokes, false);
      return;
    }

    const done = decodeDone(msg);
    if (done) {
      if (this.isHost) this.hostRecord(done.peerId, done.turn, done.strokes, true);
      return;
    }

    const reveal = decodeReveal(msg);
    if (reveal) {
      if (!this.isHost) this.startSlideshow(reveal.books);
      return;
    }

    const end = decodeEnd(msg);
    if (end) {
      this.scheduleEnd(end);
      return;
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    this.detachInput();
    this.unmountUI();
    if (this.ctx?.canvas) this.ctx.canvas.style.cursor = '';
    this.renderer?.destroy();
    sound.stopBgm();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.pauseStart = performance.now();
    } else if (this.pauseStart > 0) {
      const delta = performance.now() - this.pauseStart;
      // 로컬/호스트 타이머 기준시각을 밀어 정지 시간만큼 보정
      this.turnLocalStart += delta;
      this.turnStartedAtHost += delta;
      this.slideStart += delta;
      this.pauseStart = 0;
    }
  }

  // ============================================
  // 루프
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;
    const now = performance.now();

    if (!this.paused && this.game) {
      if (this.game.phase === 'drawing') {
        // 로컬 카운트다운 만료 → 자동 제출.
        //   turnLocalStart>0 가드 — 아직 이번 턴 셋업(applyTurnPayload/applySync)이 안 됐으면
        //   기본값 0 으로 left 가 음수가 되어 "받자마자 즉시 제출"되던 문제 방지.
        if (this.amDrawer() && this.turnLocalStart > 0) {
          const left = this.game.durationMs - (now - this.turnLocalStart);
          if (left <= 0) this.submitLocalCut();
        }
        // 호스트: 전원 제출 or 시간+유예 초과 시 마감
        if (this.isHost && now - this.turnStartedAtHost > this.game.durationMs + FINALIZE_GRACE_MS) {
          this.finalizeTurnAsHost();
        }
        // 호스트: 주기 broadcast 는 경량 tick 만 (turn/phase). 무거운 전체 sync 는 hello 응답으로만
        //   target 전송 → 호스트 업링크 폭주(핑 급상승) 방지.
        if (this.isHost && now - this.lastSyncAt > SYNC_INTERVAL_MS) {
          this.lastSyncAt = now;
          this.ctx.sendToPeer(encodeTick(this.game.turn, this.game.phase));
        }
        // 게스트: 미초기화/대기 지속 시 재동기 요청
        if (!this.isHost && this.needsResync(now)) {
          this.lastHelloAt = now;
          this.ctx.sendToPeer(encodeHello(this.myPeerId));
        }
      } else if (this.game.phase === 'reveal') {
        this.advanceSlideshow(now);
        // reveal 전환을 놓친 게스트가 감지하도록 경량 tick 유지
        if (this.isHost && now - this.lastSyncAt > SYNC_INTERVAL_MS) {
          this.lastSyncAt = now;
          this.ctx.sendToPeer(encodeTick(this.game.turn, this.game.phase));
        }
      }
    }

    try {
      this.renderer.render(this.buildRenderState(now));
    } catch (err) {
      console.error('[story-draw] render 오류', err);
    }
  };

  private needsResync(now: number): boolean {
    if (this.inited && this.game && this.game.phase === 'drawing' && !this.submitted) return false;
    const anchor = this.inited ? Math.max(this.waitingSince, this.lastHelloAt) : this.lastHelloAt;
    return now - anchor > RESYNC_MS;
  }

  private buildRenderState(now: number): RenderState {
    if (!this.game) {
      return { mode: 'draw', strokes: [], connecting: true } as RenderState;
    }
    if (this.game.phase === 'reveal') return this.buildRevealState();

    // 일시정지 중엔 정지 시점 기준으로 표시(카운트다운 시각 드리프트 방지). 언포즈 시 turnLocalStart 보정됨.
    const clock = this.paused && this.pauseStart > 0 ? this.pauseStart : now;
    const left = Math.max(0, this.game.durationMs - (clock - this.turnLocalStart));
    return {
      mode: 'draw',
      strokes: this.strokes,
      liveStroke: this.liveStroke,
      ghost: this.ghost,
      promptText: this.promptText,
      turn: this.game.turn,
      totalTurns: this.game.totalTurns,
      timeLeftMs: left,
      durationMs: this.game.durationMs,
      submitted: this.submitted || this.isSpectator,
      // 호스트만 정확한 제출 수 표시 (게스트는 숫자 없이 안내만)
      submittedCount: this.isHost ? this.hostSubmitted.size : undefined,
      totalPlayers: this.isHost ? this.game.seats.length : undefined,
      spectator: this.isSpectator,
    } as RenderState;
  }

  private buildRevealState(): RenderState {
    const slide = this.slides[this.slideIdx];
    if (!slide) return { mode: 'reveal', strokes: [], isCoverSlide: true, title: '', ownerNickname: '' };
    const book = this.revealBooks[slide.bookIndex];
    if (!book) return { mode: 'reveal', strokes: [], isCoverSlide: true, title: '', ownerNickname: '' };
    if (slide.type === 'cover') {
      return { mode: 'reveal', strokes: [], isCoverSlide: true, title: book.prompt, ownerNickname: book.ownerNickname };
    }
    const cut = book.cuts[slide.cutIndex];
    return {
      mode: 'reveal',
      strokes: cut ? cut.strokes : [],
      title: book.prompt,
      drawerNickname: cut ? cut.drawerNickname : '',
      cutIndex: slide.cutIndex + 1,
      cutTotal: book.cuts.length,
    };
  }

  // ============================================
  // 호스트: 턴 진행
  // ============================================

  private startTurnAsHost(turn: number): void {
    if (!this.game) return;
    const now = performance.now();
    this.game.turn = turn;
    this.game.phase = 'drawing';
    this.game.turnStartedAt = now;
    this.turnStartedAtHost = now;
    this.hostSubmitted.clear();
    this.hostPending.clear();

    const n = this.game.seats.length;
    const assignments = this.game.seats.map((_s, seat) => {
      const a = assignmentFor(this.game!, seat);
      return { seat, bookIndex: a.bookIndex, prompt: a.prompt, ghost: a.ghost };
    });
    this.ctx.sendToPeer(encodeTurn({ turn, durationMs: this.game.durationMs, turnStartedAt: now, assignments }));
    void n;
    // 호스트 본인 셋업
    this.applyTurnPayload(turn, this.game.durationMs, now, assignments);
  }

  /** 그리는 사람(진행/제출) 수신 — 호스트 집계. 뒤처진(다른 턴) 기록은 무시. */
  private hostRecord(fromPeerId: string, turn: number, strokes: StrokeData[], final: boolean): void {
    if (!this.game || this.game.phase !== 'drawing' || turn !== this.game.turn) return;
    const seat = this.game.seats.findIndex((s) => s.peerId === fromPeerId);
    if (seat < 0) return;
    const n = this.game.seats.length;
    const book = bookForSeat(seat, this.game.turn, n);
    const drawer = this.game.seats[seat]!;
    this.hostPending.set(book, { drawerPeerId: drawer.peerId, drawerNickname: drawer.nickname, strokes: strokes.slice() });
    if (final && !this.hostSubmitted.has(seat)) {
      this.hostSubmitted.add(seat);
      if (this.hostSubmitted.size >= n) this.finalizeTurnAsHost();
    }
  }

  private finalizeTurnAsHost(): void {
    if (!this.game || this.game.phase !== 'drawing') return;
    const n = this.game.seats.length;
    const turn = this.game.turn;
    for (let b = 0; b < n; b++) {
      const seat = (b + turn) % n; // 이 턴에 책 b 를 그린 좌석
      const drawer = this.game.seats[seat]!;
      const pend = this.hostPending.get(b);
      this.game.books[b]!.cuts[turn] = {
        drawerPeerId: drawer.peerId,
        drawerNickname: drawer.nickname,
        strokes: pend ? pend.strokes : [],
      };
    }
    this.hostSubmitted.clear();
    this.hostPending.clear();

    if (turn + 1 < this.game.totalTurns) {
      this.startTurnAsHost(turn + 1);
    } else {
      this.revealAsHost();
    }
  }

  private revealAsHost(): void {
    if (!this.game) return;
    this.game.phase = 'reveal';
    this.ctx.sendToPeer(encodeReveal(this.game.books));
    this.startSlideshow(this.game.books);
  }

  // ============================================
  // 공통: 상태 적용
  // ============================================

  private applyTurnPayload(
    turn: number,
    durationMs: number,
    _turnStartedAt: number,
    assignments: { seat: number; bookIndex: number; prompt?: string; ghost?: StrokeData[] }[],
  ): void {
    if (!this.game) return;
    this.game.turn = turn;
    this.game.phase = 'drawing';
    this.game.durationMs = durationMs;
    this.localTurn = turn;
    this.inited = true;

    const a = assignments.find((x) => x.seat === this.mySeat);
    if (a && this.mySeat >= 0) {
      this.myBookIndex = a.bookIndex;
      this.ghost = a.ghost && a.ghost.length > 0 ? a.ghost : null;
      this.promptText = a.prompt ?? null;
    } else {
      // 관전자 등 — 그릴 것 없음
      this.myBookIndex = -1;
      this.ghost = null;
      this.promptText = null;
    }
    this.strokes = [];
    this.liveStroke = null;
    this.isDrawingStroke = false;
    this.submitted = false;
    this.turnLocalStart = performance.now();
    this.refreshToolbar();
  }

  private applySync(game: StoryDrawGame): void {
    const prevPhase = this.game?.phase;
    // 되감기 방지 — 재정렬로 도착한 낡은 전체 sync(이미 지난 턴)는 무시. 현재 그림/타이머 유지.
    if (this.inited && game.phase === 'drawing' && this.game && game.turn < this.localTurn) return;
    // 구조 채택
    this.game = game;
    if (this.mySeat < 0 || !this.inited) {
      this.mySeat = game.seats.findIndex((s) => s.peerId === this.myPeerId);
    }
    this.inited = true;

    if (game.phase === 'reveal') {
      if (prevPhase !== 'reveal') this.startSlideshow(game.books);
      return;
    }
    // drawing — 내 로컬 턴과 다르면(뒤처짐/합류) 이번 턴을 셋업. 같으면 내 진행 유지.
    if (this.localTurn !== game.turn || prevPhase !== 'drawing') {
      this.localTurn = game.turn;
      if (this.mySeat >= 0) {
        const asg = assignmentFor(game, this.mySeat);
        this.myBookIndex = asg.bookIndex;
        this.ghost = asg.ghost && asg.ghost.length > 0 ? asg.ghost : null;
        this.promptText = asg.prompt ?? null;
      } else {
        this.myBookIndex = -1; this.ghost = null; this.promptText = null;
      }
      this.strokes = [];
      this.liveStroke = null;
      this.submitted = false;
      this.turnLocalStart = performance.now();
      this.refreshToolbar();
    } else {
      // 같은 턴 — 유령/제시어만 최신화(내 stroke 는 보존)
      if (this.mySeat >= 0) {
        const asg = assignmentFor(game, this.mySeat);
        this.ghost = asg.ghost && asg.ghost.length > 0 ? asg.ghost : this.ghost;
        this.promptText = asg.prompt ?? this.promptText;
      }
    }
  }

  // ============================================
  // 슬라이드쇼
  // ============================================

  private startSlideshow(books: StoryBook[]): void {
    if (this.game) this.game.phase = 'reveal';
    this.revealBooks = books;
    this.slides = [];
    books.forEach((book, b) => {
      this.slides.push({ type: 'cover', bookIndex: b, cutIndex: -1 });
      book.cuts.forEach((_c, ci) => this.slides.push({ type: 'cut', bookIndex: b, cutIndex: ci }));
    });
    this.slideIdx = 0;
    this.slideStart = performance.now();
    this.refreshToolbar();
  }

  private advanceSlideshow(now: number): void {
    const slide = this.slides[this.slideIdx];
    if (!slide) return;
    const dur = slide.type === 'cover' ? SLIDE_COVER_MS : SLIDE_CUT_MS;
    if (now - this.slideStart < dur) return;
    if (this.slideIdx < this.slides.length - 1) {
      this.slideIdx++;
      this.slideStart = now;
    } else if (this.isHost && !this.endScheduled) {
      // 마지막 슬라이드까지 다 보여줌 → 종료 (호스트가 트리거)
      this.endAsHost();
    }
  }

  private endAsHost(): void {
    const result: GameResult = { winner: null, summary: { gameId: 'story-draw' } };
    this.ctx.sendToPeer(encodeEnd(result));
    this.scheduleEnd(result);
  }

  private scheduleEnd(result: GameResult): void {
    if (this.endScheduled) return;
    this.endScheduled = true;
    window.setTimeout(() => {
      if (this.destroyed) return;
      this.ctx.endGame(result);
    }, 400);
  }

  // ============================================
  // 그리기 입력
  // ============================================

  private amDrawer(): boolean {
    return !this.isSpectator && !!this.game && this.game.phase === 'drawing'
      && this.mySeat >= 0 && !this.submitted;
  }

  private attachInput(): void {
    this.ctx.canvas.addEventListener('mousedown', this.onDown);
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('keydown', this.onKeyDown);
  }
  private detachInput(): void {
    if (this.ctx?.canvas) this.ctx.canvas.removeEventListener('mousedown', this.onDown);
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!(e.key === 'z' || e.key === 'Z') || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (!this.amDrawer() || this.strokes.length === 0) return;
    e.preventDefault();
    this.strokes.pop();
  };

  private onDown = (e: MouseEvent): void => {
    if (this.paused || !this.amDrawer()) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
    if (!isCanvasReady(x, y)) return;

    if (this.tool === 'eyedropper') {
      this.toolColor = this.renderer.getPixelColor(x, y);
      this.selectTool('pen');
      this.syncColorUI();
      return;
    }
    if (this.tool === 'fill') {
      const stroke: StrokeData = { points: [clampToCanvas(x, y)], color: this.toolColor, width: this.toolWidth, tool: 'fill', shape: 'free' };
      this.strokes.push(stroke);
      this.sendProgress();
      return;
    }
    this.isDrawingStroke = true;
    this.liveStroke = {
      points: [clampToCanvas(x, y)],
      color: this.toolColor,
      width: this.tool === 'eraser' ? ERASE_WIDTH : this.toolWidth,
      tool: this.tool,
      shape: this.tool === 'eraser' ? 'free' : this.toolShape,
    };
  };

  private onMove = (e: MouseEvent): void => {
    if (!this.isDrawingStroke || !this.liveStroke) return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
    const clamped = clampToCanvas(x, y);
    if (this.liveStroke.shape && this.liveStroke.shape !== 'free') {
      this.liveStroke.points = [this.liveStroke.points[0]!, clamped];
    } else {
      this.liveStroke.points.push(clamped);
    }
  };

  private onUp = (): void => {
    if (!this.isDrawingStroke || !this.liveStroke) return;
    this.isDrawingStroke = false;
    const stroke = this.liveStroke;
    this.liveStroke = null;
    if (stroke.points.length > 0) {
      this.strokes.push(stroke);
      this.sendProgress();
    }
  };

  /**
   * 진행 중 stroke 를 호스트에 보관 (타임아웃 마감 시에도 컷 보존).
   * 호스트에게만 target 전송 → 다른 게스트로 relay 안 됨(그림 실시간 노출 방지 + 트래픽↓).
   * 게스트는 throttle 로 과도한 전송 억제(최종 제출은 submitLocalCut 이 전량 보냄).
   */
  private sendProgress(): void {
    if (!this.amDrawer()) return;
    if (this.isHost) {
      this.hostRecord(this.myPeerId, this.game!.turn, this.strokes, false);
      return;
    }
    const now = performance.now();
    if (now - this.lastProgressAt < 1200) return;
    this.lastProgressAt = now;
    this.ctx.sendToPeer(encodeProgress({
      peerId: this.myPeerId, nickname: this.myNickname(),
      bookIndex: this.myBookIndex, turn: this.game!.turn, strokes: this.strokes,
    }), { target: this.hostPeerId });
  }

  private submitLocalCut(): void {
    if (this.submitted || !this.game || this.mySeat < 0) return;
    this.submitted = true;
    this.isDrawingStroke = false;
    this.liveStroke = null;
    this.waitingSince = performance.now();
    if (this.isHost) {
      this.hostRecord(this.myPeerId, this.game.turn, this.strokes, true);
    } else {
      this.ctx.sendToPeer(encodeDone({
        peerId: this.myPeerId, nickname: this.myNickname(),
        bookIndex: this.myBookIndex, turn: this.game.turn, strokes: this.strokes,
      }), { target: this.hostPeerId });
    }
    sound.play('tetris_clear');
    this.refreshToolbar();
  }

  private myNickname(): string {
    return this.game?.seats.find((s) => s.peerId === this.myPeerId)?.nickname
      ?? this.ctx.myNickname ?? '나';
  }

  // ============================================
  // 도구 UI (draw-quiz 개선판과 동일 구성 + 완성 버튼)
  // ============================================

  private mountUI(): void {
    const parent = this.ctx.canvas.parentElement;
    if (!parent) return;
    const container = document.createElement('div');
    container.className = 'dq-ui';
    container.innerHTML = `
      <div class="dq-toolbar" id="sd-toolbar" style="display:none">
        <div class="dq-tool-group" id="sd-tools"></div>
        <div class="dq-tool-group" id="sd-shapes"></div>
        <div class="dq-tool-group" id="sd-widths"></div>
        <div class="dq-tool-group dq-color-group">
          <input type="color" id="sd-color-picker" class="dq-color-picker" title="색 선택" />
          <div class="dq-swatches" id="sd-colors"></div>
        </div>
        <button class="dq-tool-btn" id="sd-undo" type="button" title="실행 취소 (Ctrl+Z)">↶</button>
        <button class="dq-tool-btn" id="sd-clear" type="button" title="전체 지우기">🗑️</button>
        <button class="dq-submit-btn" id="sd-submit" type="button">완성 ✓</button>
      </div>
    `;
    parent.appendChild(container);
    this.uiRoot = container;
    this.toolbarEl = container.querySelector('#sd-toolbar');

    this.buildToolButtons(container);
    this.buildShapeButtons(container);
    this.buildWidthButtons(container);
    this.buildColorButtons(container);

    const picker = container.querySelector<HTMLInputElement>('#sd-color-picker');
    if (picker) {
      picker.value = this.toolColor;
      picker.addEventListener('input', () => {
        this.toolColor = picker.value;
        this.uiRoot?.querySelectorAll('.dq-color-btn').forEach((el) => el.classList.remove('is-active'));
        if (this.tool === 'eraser' || this.tool === 'fill' || this.tool === 'eyedropper') this.selectTool('pen');
      });
    }
    container.querySelector('#sd-undo')?.addEventListener('click', () => {
      if (!this.amDrawer() || this.strokes.length === 0) return;
      this.strokes.pop();
    });
    container.querySelector('#sd-clear')?.addEventListener('click', () => {
      if (!this.amDrawer()) return;
      this.strokes = [];
      this.liveStroke = null;
    });
    container.querySelector('#sd-submit')?.addEventListener('click', () => this.submitLocalCut());

    this.setCanvasCursor();
    this.refreshToolbar();
  }

  private refreshToolbar(): void {
    if (this.toolbarEl) this.toolbarEl.style.display = this.amDrawer() ? 'flex' : 'none';
  }

  private selectTool(t: DrawTool | 'eyedropper'): void {
    this.tool = t;
    this.uiRoot?.querySelectorAll('#sd-tools .dq-tool-btn').forEach((el) => {
      el.classList.toggle('is-active', (el as HTMLElement).dataset.tool === t);
    });
    const shapesUsable = t === 'pen' || t === 'marker';
    this.uiRoot?.querySelector('#sd-shapes')?.classList.toggle('is-disabled', !shapesUsable);
    this.setCanvasCursor();
  }

  private syncColorUI(): void {
    const picker = this.uiRoot?.querySelector<HTMLInputElement>('#sd-color-picker');
    if (picker) picker.value = this.toolColor;
    this.uiRoot?.querySelectorAll('.dq-color-btn').forEach((el) => {
      el.classList.toggle('is-active', (el as HTMLElement).dataset.color === this.toolColor);
    });
  }

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
    this.ctx.canvas.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`;
  }

  private buildToolButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#sd-tools');
    if (!wrap) return;
    const tools: Array<{ id: DrawTool | 'eyedropper'; icon: string; title: string }> = [
      { id: 'pen', icon: '✏️', title: '펜' },
      { id: 'marker', icon: '🖍️', title: '형광펜' },
      { id: 'eraser', icon: '🧽', title: '지우개' },
      { id: 'fill', icon: '🪣', title: '채우기' },
      { id: 'eyedropper', icon: '💧', title: '스포이드' },
    ];
    tools.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dq-tool-btn' + (t.id === this.tool ? ' is-active' : '');
      b.dataset.tool = t.id;
      b.textContent = t.icon;
      b.title = t.title;
      b.addEventListener('click', () => this.selectTool(t.id));
      wrap.appendChild(b);
    });
  }

  private buildColorButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#sd-colors');
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
        if (this.tool === 'eraser' || this.tool === 'eyedropper') this.selectTool('pen');
      });
      wrap.appendChild(b);
    });
  }

  private buildWidthButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#sd-widths');
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
        this.setCanvasCursor();
      });
      wrap.appendChild(b);
    });
  }

  private buildShapeButtons(root: HTMLElement): void {
    const wrap = root.querySelector('#sd-shapes');
    if (!wrap) return;
    const shapes: Array<{ id: ShapeKind; icon: string; title: string }> = [
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
        if (this.tool !== 'pen' && this.tool !== 'marker') this.selectTool('pen');
      });
      wrap.appendChild(b);
    });
  }

  private unmountUI(): void {
    this.uiRoot?.remove();
    this.uiRoot = null;
    this.toolbarEl = null;
  }
}

// ============================================
// 헬퍼
// ============================================

function clampToCanvas(x: number, y: number): StrokePoint {
  return { x: Math.max(0, Math.min(760, x)), y: Math.max(0, Math.min(480, y)) };
}

function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

export function createStoryDrawGame(): GameModule {
  return new StoryDrawGameModule();
}
