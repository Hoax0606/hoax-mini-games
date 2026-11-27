/**
 * 양세찬 게임 (콜 마이 네임) — 이마에 붙은 내 단어 맞히기
 *
 * 호스트 authoritative. 호스트가 단어를 나눠주고 차례와 정답을 판정한다.
 *
 * 한 차례는 세 단계다.
 *   1) ask     차례인 사람이 질문 하나를 쓴다
 *   2) answer  나머지가 **각자 한 번씩** 대답한다 (전원 끝나거나 제한 시간이 지나면 다음)
 *   3) decide  질문자가 정답을 말하거나 차례를 넘긴다
 *
 * 예전엔 대답이 자유였고 질문·대답·알림이 한 피드에 시간순으로 섞여 쌓였는데,
 * "지금 누가 뭐라고 했더라" 를 눈으로 좇아야 해서 판이 안 읽혔다.
 * 이제 바퀴(Round)로 묶어서 사람별 카드에 쌓는다.
 *
 * 대답은 자유 입력이다 — 예/아니오로 가두면 "글쎄…" 가 사라져서 재미가 죽는다.
 *
 * 자기 단어를 모르는 게 게임의 전부라서, sync 는 사람마다 다르게 보낸다
 * (받는 사람 자기 단어만 지워서). 자세한 건 netSync 주석 참고.
 */

import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import {
  THEMES, parseTheme, resolveTheme, pickWords, isCorrect, nextTurn, isOver, rankSort,
  clipFeedText, NO_ANSWER, ROUND_KEEP, type Round, type PlayerState,
} from './rules';
import { CallMyNameRenderer } from './render';
import {
  encodeHello, decodeHello, encodeSync, decodeSync,
  encodeAsk, decodeAsk, encodeAnswer, decodeAnswer,
  encodeGuess, decodeGuess, encodePass, decodePass,
  encodeEnd, decodeEnd, type CnPhase,
} from './netSync';
import { sound } from '../../core/sound';

/** 게스트가 hello 를 보내고 sync 가 안 오면 재시도하는 간격 */
const HELLO_RETRY_MS = 1_500;
const END_DELAY_MS = 1_400;
/** 도배 방지 — 한 사람이 이 간격 안에 두 번 말할 수 없다 */
const SAY_COOLDOWN_MS = 400;

class CallMyNameModule implements GameModule {
  private ctx!: GameContext;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private destroyed = false;

  private renderer: CallMyNameRenderer | null = null;
  private rafId: number | null = null;

  private themeKey = 'food';
  private themeLabel = '…';
  /** 대답 제한 시간(초). 0 이면 무제한 — 그땐 질문자가 직접 넘겨야 한다 */
  private answerLimitSec = 30;

  // --- 공개 상태 (게스트는 sync 로 받아서 통째 교체) ---
  private players: PlayerState[] = [];
  private turnPeerId: string | null = null;
  private phase: CnPhase = 'ask';
  private rounds: Round[] = [];
  private answerDeadline = 0;
  private news = '';

  private notice = '';
  private noticeUntil = 0;
  private lastHelloAt = 0;
  private syncedOnce = false;

  // --- 호스트 전용 ---
  private turnIdx = 0;
  private nextRank = 1;
  private leftPeers = new Set<string>();
  private lastSayAt = new Map<string, number>();
  private ended = false;

  // ============================================
  // 수명주기
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    const picked = parseTheme(ctx.roomOptions['theme']);
    this.answerLimitSec = parseAnswerLimit(ctx.roomOptions['answerLimit']);
    if (this.isHost) {
      // 랜덤이면 여기서 주제가 확정된다. 게스트에겐 sync 로 라벨만 내려간다
      const t = resolveTheme(picked);
      this.themeKey = t.key;
      this.themeLabel = t.label;
    } else {
      this.themeKey = picked;
      this.themeLabel = THEMES.find((t) => t.key === picked)?.label ?? '…';
    }

    this.renderer = new CallMyNameRenderer(ctx.canvas, {
      onAsk: (t) => this.submitAsk(t),
      onAnswer: (t) => this.submitAnswer(t),
      onGuess: (w) => this.submitGuess(w),
      onPass: () => this.submitPass(),
    });
    sound.startBgm('apple-game');

    if (this.isHost) {
      const seats = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'));
      const words = pickWords(this.themeKey, seats.length);
      this.players = seats.map((p, i) => ({
        peerId: p.peerId,
        nickname: p.nickname,
        word: words[i] ?? '',
        solved: false,
        rank: 0,
        tries: 0,
      }));
      this.turnIdx = 0;
      this.turnPeerId = this.players[0]?.peerId ?? null;
      this.news = `주제는 ${this.themeLabel}`;
      this.openRound();
    } else {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
      this.lastHelloAt = performance.now();
    }

    this.rafId = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.renderer?.destroy();
    this.renderer = null;
    sound.stopBgm();
  }

  private loop = (): void => {
    if (this.destroyed) return;
    const now = performance.now();

    if (!this.isHost && !this.syncedOnce && now - this.lastHelloAt > HELLO_RETRY_MS) {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
      this.lastHelloAt = now;
    }
    if (this.notice && now > this.noticeUntil) this.notice = '';

    // 제한 시간이 끝나면 안 답한 사람은 무응답으로 두고 넘어간다.
    // 한 명이 자리를 비워 판이 멈추는 걸 막는 장치 (전원 대답이 필수라서 필요하다).
    if (this.isHost && this.phase === 'answer' && this.answerDeadline > 0
        && Date.now() >= this.answerDeadline) {
      this.closeAnswers(true);
    }

    this.renderer?.render({
      players: this.players,
      turnPeerId: this.turnPeerId,
      theme: this.themeLabel,
      phase: this.phase,
      rounds: this.rounds,
      answerDeadline: this.answerDeadline,
      news: this.news,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      notice: this.notice,
    });
    this.rafId = requestAnimationFrame(this.loop);
  };

  // ============================================
  // 입력
  // ============================================

  private isMyTurn(): boolean {
    return !this.isSpectator && this.turnPeerId === this.myPeerId;
  }

  private submitAsk(raw: string): void {
    const text = clipFeedText(raw);
    if (!text) return;
    if (!this.isMyTurn() || this.phase !== 'ask') return;
    if (this.isHost) this.handleAsk(this.myPeerId, text);
    else this.ctx.sendToPeer(encodeAsk(this.myPeerId, text));
  }

  private submitAnswer(raw: string): void {
    const text = clipFeedText(raw);
    if (!text) return;
    if (this.isSpectator || this.phase !== 'answer') return;
    if (this.isHost) this.handleAnswer(this.myPeerId, text);
    else this.ctx.sendToPeer(encodeAnswer(this.myPeerId, text));
  }

  private submitGuess(word: string): void {
    if (!this.isMyTurn()) return;
    const w = word.trim();
    if (!w) { this.showNotice('정답을 입력해주세요.'); return; }
    if (this.isHost) this.handleGuess(this.myPeerId, w);
    else this.ctx.sendToPeer(encodeGuess(this.myPeerId, w));
  }

  private submitPass(): void {
    if (!this.isMyTurn()) return;
    if (this.isHost) this.handlePass(this.myPeerId);
    else this.ctx.sendToPeer(encodePass(this.myPeerId));
  }

  private showNotice(text: string): void {
    this.notice = text;
    this.noticeUntil = performance.now() + 2_400;
  }

  // ============================================
  // 호스트 — 판정
  // ============================================

  /** 지금 바퀴 (= 마지막 바퀴). 아직 없으면 null */
  private current(): Round | null {
    return this.rounds[this.rounds.length - 1] ?? null;
  }

  /** 새 바퀴를 열고 질문을 기다린다 */
  private openRound(): void {
    const asker = this.players.find((p) => p.peerId === this.turnPeerId);
    if (!asker) { this.finishAsHost(); return; }
    this.phase = 'ask';
    this.answerDeadline = 0;
    this.rounds = [...this.rounds, {
      no: this.rounds.length + 1,
      askerPeerId: asker.peerId,
      askerName: asker.nickname,
      question: '',
      answers: [],
    }].slice(-ROUND_KEEP);
    this.broadcastSync();
  }

  /**
   * 이번 질문에 답해야 하는 사람들.
   * 기본은 "아직 못 맞혔고 안 나간, 질문자 아닌 사람" — 맞힌 사람은 빠진다.
   * 다만 그런 사람이 하나도 없으면(막판에 질문자만 남은 경우) 맞힌 사람들이 대신 답한다.
   * 안 그러면 마지막 사람은 아무 정보도 못 얻고 찍기만 해야 한다.
   */
  private answererIds(askerPeerId: string): string[] {
    const alive = this.players.filter((p) => !this.leftPeers.has(p.peerId) && p.peerId !== askerPeerId);
    const unsolved = alive.filter((p) => !p.solved);
    const pool = unsolved.length > 0 ? unsolved : alive;
    return pool.map((p) => p.peerId);
  }

  private handleAsk(from: string, raw: string): void {
    if (this.ended || this.phase !== 'ask') return;
    if (this.turnPeerId !== from) return;
    const me = this.players.find((p) => p.peerId === from);
    if (!me || this.leftPeers.has(from)) return;

    const now = performance.now();
    if (now - (this.lastSayAt.get(from) ?? 0) < SAY_COOLDOWN_MS) return;
    this.lastSayAt.set(from, now);

    const text = clipFeedText(raw);
    if (!text) return;
    const round = this.current();
    if (!round) return;

    round.question = text;
    round.answers = this.answererIds(from).map((peerId) => ({ peerId, text: '' }));
    sound.play('pop');

    if (round.answers.length === 0) {
      // 답할 사람이 아무도 없다 (혼자 남음) → 바로 정답/넘기기
      this.phase = 'decide';
      this.answerDeadline = 0;
    } else {
      this.phase = 'answer';
      this.answerDeadline = this.answerLimitSec > 0 ? Date.now() + this.answerLimitSec * 1000 : 0;
    }
    this.broadcastSync();
  }

  private handleAnswer(from: string, raw: string): void {
    if (this.ended || this.phase !== 'answer') return;
    const round = this.current();
    if (!round) return;
    const slot = round.answers.find((a) => a.peerId === from);
    if (!slot || slot.text) return; // 대답 대상이 아니거나 이미 답했다

    const now = performance.now();
    if (now - (this.lastSayAt.get(from) ?? 0) < SAY_COOLDOWN_MS) return;
    this.lastSayAt.set(from, now);

    const text = clipFeedText(raw);
    if (!text) return;
    slot.text = text;
    sound.play('pop');

    if (round.answers.every((a) => a.text)) this.closeAnswers(false);
    else this.broadcastSync();
  }

  /** 대답 단계를 닫고 질문자에게 공을 넘긴다. byTimeout 이면 빈 칸을 무응답으로 채운다 */
  private closeAnswers(byTimeout: boolean): void {
    const round = this.current();
    if (!round) return;
    if (byTimeout) {
      for (const a of round.answers) if (!a.text) a.text = NO_ANSWER;
    }
    this.phase = 'decide';
    this.answerDeadline = 0;
    this.broadcastSync();
  }

  private handleGuess(from: string, word: string): void {
    if (this.ended || this.turnPeerId !== from) return;
    // 대답을 다 듣기 전에는 못 맞힌다 — 그게 이번 규칙의 핵심이다
    if (this.phase !== 'decide') return;
    const me = this.players.find((p) => p.peerId === from);
    if (!me || me.solved) return;

    me.tries++;
    if (isCorrect(word, me.word)) {
      me.solved = true;
      me.rank = this.nextRank++;
      this.news = `${me.nickname} 님 정답! (${me.word}) ${me.rank}등`;
      sound.play('tetris_tetris');
      if (isOver(this.players) || this.activeCount() === 0) { this.finishAsHost(); return; }
    } else {
      this.news = `${me.nickname} 님이 ${word} 라고 했지만 아니에요`;
      sound.play('tetris_lock');
    }
    this.advanceTurn();
  }

  private handlePass(from: string): void {
    if (this.ended || this.turnPeerId !== from) return;
    if (this.phase !== 'decide') return;
    const me = this.players.find((p) => p.peerId === from);
    if (me) this.news = `${me.nickname} 님이 차례를 넘겼어요`;
    this.advanceTurn();
  }

  /** 아직 못 맞혔고 나가지도 않은 사람 수 */
  private activeCount(): number {
    return this.players.filter((p) => !p.solved && !this.leftPeers.has(p.peerId)).length;
  }

  private advanceTurn(): void {
    const idx = this.players.findIndex((p) => p.peerId === this.turnPeerId);
    // 이탈자는 건너뛴다 — nextTurn 은 solved 만 보므로 여기서 한 번 더 거른다
    let i = idx < 0 ? 0 : idx;
    for (let step = 0; step < this.players.length; step++) {
      const n = nextTurn(this.players, i);
      if (n === null) { this.finishAsHost(); return; }
      i = n;
      if (!this.leftPeers.has(this.players[i]!.peerId)) {
        this.turnIdx = i;
        this.turnPeerId = this.players[i]!.peerId;
        this.openRound();
        return;
      }
    }
    this.finishAsHost();
  }

  private syncFor(targetPeerId: string, hideOwnWord: boolean): GameMessage {
    const view = hideOwnWord
      // 맞힌 뒤에는 더 가릴 이유가 없다 — 계속 지우면 자기 카드가 빈 채로 남는다
      ? this.players.map((p) => (p.peerId === targetPeerId && !p.solved ? { ...p, word: '' } : p))
      : this.players;
    return encodeSync({
      players: view,
      turnPeerId: this.turnPeerId,
      theme: this.themeLabel,
      phase: this.phase,
      rounds: this.rounds,
      answerDeadline: this.answerDeadline,
      news: this.news,
    });
  }

  private broadcastSync(): void {
    // 사람마다 자기 단어만 지워서 보낸다 (전체 broadcast 하면 자기 걸 볼 수 있다).
    // 호스트 자신에겐 안 보낸다 — 원본을 들고 있고, 자기 단어는 렌더가 가린다.
    for (const target of this.players) {
      if (target.peerId === this.myPeerId) continue;
      this.ctx.sendToPeer(this.syncFor(target.peerId, true), { target: target.peerId });
    }
    // 관전자에게는 전부 보여준다 (맞힐 사람이 아니라 구경꾼이다)
    for (const p of this.ctx.players) {
      if (p.role !== 'spectator') continue;
      this.ctx.sendToPeer(this.syncFor(p.peerId, false), { target: p.peerId });
    }
  }

  private finishAsHost(): void {
    if (this.ended) return;
    this.ended = true;
    this.turnPeerId = null;
    this.phase = 'over';
    this.answerDeadline = 0;
    this.broadcastSync();

    const ranked = [...this.players].sort(rankSort);
    const rankings = ranked.map((p, i) => ({
      peerId: p.peerId, nickname: p.nickname, rank: i + 1,
      word: p.word, solved: p.solved, tries: p.tries,
    }));
    const summaryFor = (peerId: string): GameResult => {
      const mine = rankings.find((r) => r.peerId === peerId);
      return {
        winner: mine ? (mine.rank === 1 ? 'me' : 'opponent') : null,
        summary: {
          gameId: 'call-my-name',
          myPeerId: peerId,
          theme: this.themeLabel,
          rank: mine?.rank ?? 0,
          totalPlayers: rankings.length,
          myWord: mine?.word ?? '',
          mySolved: mine?.solved ?? false,
          myTries: mine?.tries ?? 0,
          rankings,
        },
      };
    };

    window.setTimeout(() => {
      if (this.destroyed) return;
      for (const p of this.ctx.players) {
        if (p.peerId === this.myPeerId) continue;
        this.ctx.sendToPeer(encodeEnd(summaryFor(p.peerId)), { target: p.peerId });
      }
      this.ctx.endGame(summaryFor(this.myPeerId));
    }, END_DELAY_MS);
  }

  // ============================================
  // 수신
  // ============================================

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    if (this.isHost) {
      const hello = decodeHello(msg);
      if (hello) { this.broadcastSync(); return; }
      const a = decodeAsk(msg);
      if (a) { this.handleAsk(a.from, a.text); return; }
      const an = decodeAnswer(msg);
      if (an) { this.handleAnswer(an.from, an.text); return; }
      const g = decodeGuess(msg);
      if (g) { this.handleGuess(g.from, g.word); return; }
      const p = decodePass(msg);
      if (p) { this.handlePass(p.from); return; }
      return;
    }

    const sync = decodeSync(msg);
    if (sync) {
      this.players = sync.players;
      this.turnPeerId = sync.turnPeerId;
      this.themeLabel = sync.theme;
      this.phase = sync.phase;
      this.rounds = sync.rounds;
      this.answerDeadline = sync.answerDeadline;
      this.news = sync.news;
      this.syncedOnce = true;
      return;
    }
    const end = decodeEnd(msg);
    if (end) { this.ctx.endGame(end); return; }
  }

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.ended) return;
    this.leftPeers.add(peerId);
    const p = this.players.find((x) => x.peerId === peerId);
    if (p) this.news = `${p.nickname} 님이 나갔어요`;
    if (this.activeCount() === 0) { this.finishAsHost(); return; }

    // 나간 사람을 기다리느라 대답 단계가 안 끝나는 일이 없게, 그 칸을 무응답으로 닫는다
    const round = this.current();
    if (this.phase === 'answer' && round) {
      const slot = round.answers.find((a) => a.peerId === peerId);
      if (slot && !slot.text) slot.text = NO_ANSWER;
      if (round.answers.every((a) => a.text)) { this.closeAnswers(false); return; }
    }

    // 나간 사람 차례였으면 다음으로 넘긴다
    if (this.turnPeerId === peerId) this.advanceTurn();
    else this.broadcastSync();
  }
}

/** 방 옵션의 대답 제한 시간(초). '0' = 무제한 */
function parseAnswerLimit(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/** 호스트를 맨 앞에 두고 나머지는 들어온 순서 — 좌석 순서의 단일 출처 */
function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.filter((p) => p.isHost);
  const rest = players.filter((p) => !p.isHost);
  return [...host, ...rest];
}

export function createCallMyName(): GameModule {
  return new CallMyNameModule();
}
