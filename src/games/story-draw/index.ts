/**
 * 스토리텔링(이어그리기) GameModule — 갈틱폰 방식.
 *
 * 흐름 (호스트 authoritative):
 *   drawing(턴 0..N-1) → 매 턴 전원이 동시에 그림, 시간 끝나면 책이 옆으로 회전 →
 *   totalTurns 후 reveal(각자 로컬로 갤러리 감상) → end(승패 없음).
 *
 * 그림은 실시간 공유하지 않음(반전 재미). 그리는 사람만 자기 컷을 로컬로 그리고,
 * 진행/제출을 호스트에게만 보낸다. 호스트가 컷을 모아 다음 턴의 "직전 컷 유령"으로 넘김.
 *
 * 타이머: 각 클라가 sd:turn 수신 시각 기준으로 로컬 카운트다운(cross-clock 오차 방지).
 *   호스트는 자기 시계로 durationMs+grace 지나면 강제 마감(제출 유실/이탈 대비).
 *
 * 감상(reveal): 호스트가 sd:reveal 로 모든 책을 뿌리면, 각 클라가 "각자 자기 페이스로"
 *   HTML 갤러리에서 원하는 책을 골라 컷을 넘겨본다(갈틱폰 방식). 예전엔 호스트가 슬라이드를
 *   자동으로 넘기며 전원 동기화했는데, 감상 리듬이 강제돼 답답했다 → 완전 로컬 상호작용으로 교체.
 *   진행/그리기 HUD 도 캔버스가 아니라 HTML(상단 바)로 옮겨 그림을 가리지 않게 했다.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import { icon } from '../../ui/icons';
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
/** 게스트: 미초기화/대기 상태로 이만큼 지나면 재동기 요청 */
const RESYNC_MS = 2500;
/** 호스트: 주기적 상태 재broadcast 간격 (드롭 복구) */
const SYNC_INTERVAL_MS = 2500;
/** 타이머 경고(핑크) 임계 */
const TIMER_WARN_MS = 10000;

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

  // 감상(reveal) — 로컬 인터랙티브 갤러리
  private revealBooks: StoryBook[] = [];
  private revealEntered = false;
  /** 내가 이미 열어본 책 인덱스 ("✓ 봤어요" 표시) */
  private seenBooks = new Set<number>();
  /**
   * 컷 썸네일 dataURL 캐시. key = `${bookIndex}:${cutIndex}`.
   * 갤러리/뷰어가 매번 re-render 되므로 stroke→이미지 변환을 매번 하면 무거움 → 한 번만 렌더 후 재사용.
   */
  private thumbCache = new Map<string, string>();
  /** "전체 이야기" 자동 재생 몽타주 타이머 (rAF 루프와 별개). 슬라이드 이탈/닫기/파괴 시 반드시 해제. */
  private montageTimer: number | null = null;

  // 그리기 도구
  private toolColor: string = PALETTE[0];
  private toolWidth: number = WIDTHS[1];
  private tool: DrawTool | 'eyedropper' = 'pen';
  private toolShape: ShapeKind = 'free';

  private uiRoot: HTMLDivElement | null = null;
  private toolbarEl: HTMLDivElement | null = null;
  /** 그리기 상단 바 (진행/타이머/제시어) — 캔버스 위에 삽입 */
  private topbarEl: HTMLDivElement | null = null;
  /** 감상 갤러리 컨테이너 (uiRoot 안, reveal 때만 표시) */
  private galleryEl: HTMLDivElement | null = null;
  /** 열린 책 뷰어 오버레이 (body 에 append) */
  private viewerEl: HTMLDivElement | null = null;
  /** 상단 바 하위 참조 (매 프레임 갱신용) */
  private tbCut: HTMLElement | null = null;
  private tbFill: HTMLElement | null = null;
  private tbSec: HTMLElement | null = null;
  private tbSecNum: HTMLElement | null = null;
  private tbRight: HTMLElement | null = null;
  /** 상단 바 오른쪽(제시어/이어그리기)을 매 프레임 새로 안 그리게 마지막 상태 캐시 */
  private lastTopRight = '';

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
      if (!this.isHost) this.enterReveal(reveal.books);
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
      // 로컬/호스트 타이머 기준시각을 밀어 정지 시간만큼 보정 (감상 단계는 타이머 없음)
      this.turnLocalStart += delta;
      this.turnStartedAtHost += delta;
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
        // 감상은 순수 로컬 HTML 갤러리 — 슬라이드 자동진행/동기화 없음.
        // reveal 전환을 놓친 게스트가 감지하도록 경량 tick 만 유지.
        if (this.isHost && now - this.lastSyncAt > SYNC_INTERVAL_MS) {
          this.lastSyncAt = now;
          this.ctx.sendToPeer(encodeTick(this.game.turn, this.game.phase));
        }
      }
    }

    // 상단 바 갱신(그리기 단계). 감상 단계는 캔버스를 숨기므로 렌더 생략.
    if (this.game && this.game.phase === 'drawing') this.syncTopbar(now);
    if (!this.game || this.game.phase !== 'reveal') {
      try {
        this.renderer.render(this.buildRenderState());
      } catch (err) {
        console.error('[story-draw] render 오류', err);
      }
    }
  };

  private needsResync(now: number): boolean {
    if (this.inited && this.game && this.game.phase === 'drawing' && !this.submitted) return false;
    const anchor = this.inited ? Math.max(this.waitingSince, this.lastHelloAt) : this.lastHelloAt;
    return now - anchor > RESYNC_MS;
  }

  private buildRenderState(): RenderState {
    if (!this.game) return { strokes: [], connecting: true };
    return {
      strokes: this.strokes,
      liveStroke: this.liveStroke,
      ghost: this.ghost,
      submitted: this.submitted || this.isSpectator,
      // 호스트만 정확한 제출 수 표시 (게스트는 숫자 없이 안내만)
      submittedCount: this.isHost ? this.hostSubmitted.size : undefined,
      totalPlayers: this.isHost ? this.game.seats.length : undefined,
      spectator: this.isSpectator,
    };
  }

  /** 그리기 상단 바(HTML) 갱신 — 진행/타이머/제시어. 일시정지 중엔 정지 시점 기준으로 표시. */
  private syncTopbar(now: number): void {
    if (!this.topbarEl || !this.game) return;
    if (this.topbarEl.hidden) this.topbarEl.hidden = false;

    // 일시정지 중엔 정지 시점 기준(카운트다운 시각 드리프트 방지). 언포즈 시 turnLocalStart 보정됨.
    const clock = this.paused && this.pauseStart > 0 ? this.pauseStart : now;
    const dur = this.game.durationMs;
    const left = Math.max(0, dur - (clock - this.turnLocalStart));
    const frac = dur > 0 ? Math.max(0, Math.min(1, left / dur)) : 0;
    const warn = left <= TIMER_WARN_MS;

    if (this.tbCut) this.tbCut.textContent = `${this.game.turn + 1} / ${this.game.totalTurns} 컷`;
    if (this.tbFill) {
      this.tbFill.style.width = `${(frac * 100).toFixed(1)}%`;
      this.tbFill.classList.toggle('warn', warn);
    }
    if (this.tbSecNum) this.tbSecNum.textContent = `${Math.ceil(left / 1000)}초`;
    if (this.tbSec) this.tbSec.classList.toggle('warn', warn);

    // 오른쪽: 턴0=제시어 칩 / 그 외=이어그리기. 값이 바뀔 때만 innerHTML 갱신.
    const right = this.promptText
      ? `<span class="sd-prompt">제시어 · ${escapeHtml(this.promptText)}</span>`
      : `<span class="sd-cont">${icon('pen', { size: 13 })} 이어 그리기</span>`;
    if (this.tbRight && right !== this.lastTopRight) {
      this.tbRight.innerHTML = right;
      this.lastTopRight = right;
    }
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

  /** 나간 플레이어 추적 (활성 인원 계산용) */
  private leftPeers = new Set<string>();

  /** 플레이어 이탈 — 호스트 처리.
   *  나간 좌석은 "제출됨"으로 간주해 그 사람 그림을 기다리지 않는다(최대 durationMs 대기 방지).
   *  활성 1명 이하면 즉시 감상(reveal)으로. 나간 좌석 제외 전원 제출됐으면 이번 턴 즉시 마감. */
  onPeerLeft(peerId: string): void {
    if (!this.isHost || !this.game || this.game.phase !== 'drawing') return;
    this.leftPeers.add(peerId);
    const seat = this.game.seats.findIndex((s) => s.peerId === peerId);
    if (seat >= 0) this.hostSubmitted.add(seat);
    const active = this.game.seats.filter((s) => !this.leftPeers.has(s.peerId)).length;
    if (active <= 1) { this.revealAsHost(); return; }
    if (this.hostSubmitted.size >= this.game.seats.length) this.finalizeTurnAsHost();
  }

  private revealAsHost(): void {
    if (!this.game) return;
    this.game.phase = 'reveal';
    this.ctx.sendToPeer(encodeReveal(this.game.books));
    this.enterReveal(this.game.books);
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
      if (prevPhase !== 'reveal') this.enterReveal(game.books);
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
  // 감상(reveal) — 로컬 인터랙티브 갤러리
  // ============================================

  /** 감상 진입 — 캔버스/도구바 숨기고 HTML 갤러리 표시. 중복 진입 방지. */
  private enterReveal(books: StoryBook[]): void {
    if (this.game) this.game.phase = 'reveal';
    this.revealBooks = books;
    if (this.revealEntered) { this.buildGallery(); return; }
    this.revealEntered = true;

    // 감상은 순수 HTML — 그리기 캔버스/도구바/상단 바 숨김
    this.ctx.canvas.style.display = 'none';
    if (this.topbarEl) this.topbarEl.hidden = true;
    if (this.toolbarEl) this.toolbarEl.style.display = 'none';
    sound.play('tetris_clear');
    this.buildGallery();
  }

  /** 컷 썸네일 dataURL (캐시). cutIndex 0 = 표지에도 쓰는 첫 컷. */
  private cutThumb(bookIdx: number, cutIdx: number): string {
    const key = `${bookIdx}:${cutIdx}`;
    let url = this.thumbCache.get(key);
    if (url === undefined) {
      const cut = this.revealBooks[bookIdx]?.cuts[cutIdx];
      url = this.renderer.renderThumbnail(cut ? cut.strokes : []);
      this.thumbCache.set(key, url);
    }
    return url;
  }

  /** 책 갤러리 그리기 (열어본 책엔 ✓ 표시). */
  private buildGallery(): void {
    if (!this.galleryEl) return;
    this.galleryEl.hidden = false;
    const cards = this.revealBooks.map((b, i) => {
      const cover = b.cuts.length > 0
        ? `<img class="sd-cover-img" src="${this.cutThumb(i, 0)}" alt="">`
        : icon('pen', { size: 28, hue: '#b89aff' });
      const seen = this.seenBooks.has(i) ? '<span class="sd-seen">봤어요</span>' : '';
      return `<button class="sd-book" type="button" data-i="${i}">
        <span class="sd-cover">${cover}</span>
        <span class="sd-meta">
          <span class="sd-who">${escapeHtml(b.ownerNickname)} 님의 이야기</span>
          <span class="sd-ttl">제시어 · ${escapeHtml(b.prompt)}</span>
          ${seen}
        </span>
      </button>`;
    }).join('');
    // 호스트만: 모두 감상했다 싶으면 게임을 끝낸다(감상 리듬은 자유라 자동 종료가 없음).
    const endBtn = this.isHost
      ? `<button class="sd-end-btn" type="button" id="sd-end">감상 끝 · 로비로</button>`
      : `<div class="sd-gwait">호스트가 마무리하면 로비로 돌아가요</div>`;
    this.galleryEl.innerHTML = `
      <div class="sd-gtitle">완성! 이야기 감상</div>
      <div class="sd-gsub">책을 골라보세요</div>
      <div class="sd-gbooks">${cards}</div>
      ${endBtn}`;
    this.galleryEl.querySelectorAll<HTMLElement>('.sd-book').forEach((el) => {
      el.addEventListener('click', () => this.openViewer(Number(el.dataset.i)));
    });
    this.galleryEl.querySelector('#sd-end')?.addEventListener('click', () => this.endAsHost());
  }

  /** 책 뷰어 오버레이 — 표지 → 컷 1..n → 전체 이야기. 로컬 상호작용(이전/다음/닫기). */
  private openViewer(bookIdx: number): void {
    const book = this.revealBooks[bookIdx];
    if (!book) return;
    let slide = 0;                    // 0=표지, 1..total=컷, last=전체 이야기
    const total = book.cuts.length;
    const last = total + 1;

    const ov = document.createElement('div');
    ov.className = 'sd-viewer';
    document.body.appendChild(ov);
    this.viewerEl = ov;

    // "전체 이야기" 자동 재생: 현재 재생 중인 컷 인덱스(0-base)
    let montageCut = 0;

    const close = (): void => {
      this.clearMontage();
      this.seenBooks.add(bookIdx);
      ov.remove();
      if (this.viewerEl === ov) this.viewerEl = null;
      this.buildGallery();
    };

    /** 컷 하나를 큰 화면으로 그림(수동 컷 뷰/몽타주 공용). cutIdx 는 0-base. */
    const bigCut = (cutIdx: number): string => {
      const cut = book.cuts[cutIdx];
      return `<div class="sd-cut-top">제시어 · "${escapeHtml(book.prompt)}"</div>
        <img class="sd-cut-img" src="${this.cutThumb(bookIdx, cutIdx)}" alt="">
        <div class="sd-cut-badge">${icon('pen', { size: 14 })} ${escapeHtml(cut?.drawerNickname ?? '')} · ${cutIdx + 1}/${total}컷</div>`;
    };

    /** 몽타주 스테이지/진행 표시만 갱신(카드 전체 재생성 X → 핸들러 유지). */
    const paintMontage = (): void => {
      const stage = ov.querySelector('#sd-montage');
      if (stage) stage.innerHTML = bigCut(montageCut);
      const dots = ov.querySelectorAll('#sd-montage-dots i');
      dots.forEach((d, k) => d.classList.toggle('on', k === montageCut));
    };

    const draw = (): void => {
      // 슬라이드가 바뀔 때마다 몽타주 타이머부터 정리(중복 인터벌 방지).
      this.clearMontage();

      // 전체 이야기 = 컷을 자동으로 넘겨 보여주는 몽타주(무한 반복). 컷 수 상관없이 동작.
      if (slide === last) {
        const mdots = Array.from({ length: total }, (_v, k) => `<i class="${k === 0 ? 'on' : ''}"></i>`).join('');
        ov.innerHTML = `<div class="sd-vcard">
          <div class="sd-vtop"><span class="sd-vt">전체 이야기</span><button class="sd-vx" type="button" aria-label="닫기">${icon('xmark', { size: 18 })}</button></div>
          <div class="sd-vstage cut" id="sd-montage"></div>
          <div class="sd-vnav">
            <button class="sd-vbtn ghost" type="button" data-act="prev">이전</button>
            <span class="sd-montage-info"><span class="sd-montage-label">자동 재생</span><span class="sd-dots" id="sd-montage-dots">${mdots}</span></span>
            <button class="sd-vbtn" type="button" data-act="close">갤러리로</button>
          </div>
        </div>`;
        ov.querySelector('.sd-vx')?.addEventListener('click', close);
        // 이전 = 마지막 컷으로 복귀(정상 흐름). draw() 안에서 clearMontage 됨.
        ov.querySelector('[data-act="prev"]')?.addEventListener('click', () => { slide = total; draw(); });
        ov.querySelector('[data-act="close"]')?.addEventListener('click', close);
        montageCut = 0;
        paintMontage();
        // ~1.8초마다 다음 컷 → 끝에서 다시 처음으로 순환
        this.montageTimer = window.setInterval(() => {
          montageCut = total > 0 ? (montageCut + 1) % total : 0;
          paintMontage();
        }, 1800);
        return;
      }

      let body: string;
      if (slide === 0) {
        body = `<div class="sd-vstage">
          <div class="sd-cover-box">
            <div class="sd-cover-who">${escapeHtml(book.ownerNickname)} 님의 이야기</div>
            <div class="sd-cover-ttl">"${escapeHtml(book.prompt)}"</div>
          </div>
        </div>`;
      } else {
        body = `<div class="sd-vstage cut">${bigCut(slide - 1)}</div>`;
      }
      const dots = Array.from({ length: last + 1 }, (_v, k) => `<i class="${k === slide ? 'on' : ''}"></i>`).join('');
      const label = slide === 0 ? '표지' : `${slide}번째 컷`;
      ov.innerHTML = `<div class="sd-vcard">
        <div class="sd-vtop"><span class="sd-vt">${label}</span><button class="sd-vx" type="button" aria-label="닫기">${icon('xmark', { size: 18 })}</button></div>
        ${body}
        <div class="sd-vnav">
          <button class="sd-vbtn ghost" type="button" data-act="prev" ${slide === 0 ? 'disabled' : ''}>이전</button>
          <span class="sd-dots">${dots}</span>
          <button class="sd-vbtn" type="button" data-act="next">다음</button>
        </div>
      </div>`;
      ov.querySelector('.sd-vx')?.addEventListener('click', close);
      ov.querySelector('[data-act="prev"]')?.addEventListener('click', () => { if (slide > 0) { slide--; draw(); } });
      ov.querySelector('[data-act="next"]')?.addEventListener('click', () => { if (slide < last) { slide++; draw(); } });
    };

    // 배경(오버레이 여백) 클릭 시 닫기 — 카드 내부 클릭은 유지
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    draw();
  }

  /** 몽타주 인터벌 해제 — 누수 방지(슬라이드 이탈/닫기/파괴 시). */
  private clearMontage(): void {
    if (this.montageTimer !== null) {
      clearInterval(this.montageTimer);
      this.montageTimer = null;
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

    // 그리기 상단 바 — 캔버스 위에 삽입(HUD 를 종이 밖으로). 진행/타이머/제시어.
    const topbar = document.createElement('div');
    topbar.className = 'sd-topbar';
    topbar.hidden = true;
    topbar.innerHTML = `
      <span class="sd-cut" id="sd-cut">1 / 1 컷</span>
      <span class="sd-mid">
        <span class="sd-tbar"><i id="sd-tbar-fill"></i></span>
        <span class="sd-tsec" id="sd-tsec">${icon('clock', { size: 14 })}<span id="sd-tsec-num">60초</span></span>
      </span>
      <span class="sd-right" id="sd-right"></span>
    `;
    parent.insertBefore(topbar, this.ctx.canvas);
    this.topbarEl = topbar;
    this.tbCut = topbar.querySelector('#sd-cut');
    this.tbFill = topbar.querySelector('#sd-tbar-fill');
    this.tbSec = topbar.querySelector('#sd-tsec');
    this.tbSecNum = topbar.querySelector('#sd-tsec-num');
    this.tbRight = topbar.querySelector('#sd-right');

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
        <button class="dq-tool-btn" id="sd-undo" type="button" title="실행 취소 (Ctrl+Z)">${icon('undo', { size: 19, hue: '#8b93a7' })}</button>
        <button class="dq-tool-btn" id="sd-clear" type="button" title="전체 지우기">${icon('trash', { size: 19, hue: '#ff6b6b' })}</button>
        <button class="dq-submit-btn" id="sd-submit" type="button">완성</button>
      </div>
      <div class="sd-gallery" id="sd-gallery" hidden></div>
    `;
    parent.appendChild(container);
    this.uiRoot = container;
    this.toolbarEl = container.querySelector('#sd-toolbar');
    this.galleryEl = container.querySelector('#sd-gallery');

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
      { id: 'pen', icon: icon('pen', { size: 19, hue: '#ff5a92' }), title: '펜' },
      { id: 'marker', icon: icon('marker', { size: 19, hue: '#ffb020' }), title: '형광펜' },
      { id: 'eraser', icon: icon('eraser', { size: 19, hue: '#8b93a7' }), title: '지우개' },
      { id: 'fill', icon: icon('fill', { size: 19, hue: '#3fb98f' }), title: '채우기' },
      { id: 'eyedropper', icon: icon('dropper', { size: 19, hue: '#9c7aeb' }), title: '스포이드' },
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
        if (this.tool !== 'pen' && this.tool !== 'marker') this.selectTool('pen');
      });
      wrap.appendChild(b);
    });
  }

  private unmountUI(): void {
    this.clearMontage();
    this.viewerEl?.remove();
    this.viewerEl = null;
    this.topbarEl?.remove();
    this.topbarEl = null;
    this.uiRoot?.remove();
    this.uiRoot = null;
    this.toolbarEl = null;
    this.galleryEl = null;
    // 캔버스 표시 상태 원복(감상 중 숨겼을 수 있음)
    if (this.ctx?.canvas) this.ctx.canvas.style.display = '';
  }
}

// ============================================
// 헬퍼
// ============================================

function clampToCanvas(x: number, y: number): StrokePoint {
  return { x: Math.max(0, Math.min(760, x)), y: Math.max(0, Math.min(480, y)) };
}

/** 닉네임/제시어는 외부 입력 → 갤러리/뷰어에 innerHTML 로 넣기 전 이스케이프 (XSS·깨짐 방지). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

export function createStoryDrawGame(): GameModule {
  return new StoryDrawGameModule();
}
