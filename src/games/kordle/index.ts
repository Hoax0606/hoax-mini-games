/**
 * 꼬들 — 한국어 워들 (1인 연습 + N인 출제 대결)
 *
 * 호스트 authoritative. 정답은 호스트만 알고, 채점(Mark 배열)만 내려보낸다.
 *
 * 라운드 흐름
 *   1인(플레이어 1명): 호스트가 단어장에서 랜덤 정답 → 바로 'guess'
 *   N인: 출제자가 좌석 순으로 한 명씩 돌아가며 'setword' → 단어 제출 → 'guess'
 *        출제자는 그 라운드를 쉰다(점수 0). 전원 한 번씩 출제하면 공평해진다.
 *   전원이 맞히거나 6번 다 쓰면 'reveal'(정답 공개 + 점수 정산) → 다음 라운드
 *
 * 점수 = 100 − 시도×10 − 경과10초당 1 (rules.roundScore)
 * 라운드 수는 방 옵션. 0 이면 무제한이고, 방장이 '게임 끝내기' 를 눌러야 끝난다.
 */

import { randomStartIndex } from '../_shared/turnOrder';
import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import {
  MAX_TRIES, decompose, findComposition, judgeGuess, roundScore, emptyPlayerRound,
  parseJamoLen, parseRounds, isDone,
  type JamoLen, type PlayerRound,
} from './rules';
import { answerPool } from './words';
// 끝말잇기 사전(표준국어대사전 명사 19만) 재사용 — vite 가 공용 청크로 분리해준다
import { isInDictionary } from '../word-chain/dictionary';

/**
 * 사전 표제어 뒤에 혼자 붙는 1글자 — 홍길동전·분리수거함 처럼 표제어가 아닌 말을 받아주려고.
 * 느슨하게 받는 쪽을 택했다. 아는 단어를 쳤는데 거절당하는 게 훨씬 답답하기 때문.
 */
const TAIL_1 = new Set('전기법론학과실장원관점소물인용부비료증체식회율권형군가계성적화자집값병통');

/**
 * 쓸 수 있는 단어인가.
 *
 * 표준국어대사전은 복합어를 표제어로 안 싣는다. 그래서 사전만 보면
 * 항문외과·천연온천 같이 누구나 아는 말이 거절당한다.
 * 그래서 **사전 단어들로 쪼개지면** 인정한다.
 *   항문외과 = 항문 + 외과,  천연온천 = 천연 + 온천,  홍길동전 = 홍길동 + 전
 */
function isUsableWord(w: string): boolean {
  if (isInDictionary(w)) return true;
  for (let i = 2; i <= w.length - 2; i++) {
    if (isInDictionary(w.slice(0, i)) && isInDictionary(w.slice(i))) return true;
  }
  const last = w[w.length - 1];
  if (w.length >= 3 && last && TAIL_1.has(last) && isInDictionary(w.slice(0, -1))) return true;
  return false;
}
import { KordleRenderer } from './render';
import {
  encodeHello, decodeHello, encodeSetWord, decodeSetWord, encodeGuess, decodeGuess,
  encodeSync, decodeSync, encodeMine, decodeMine, encodeRejected, decodeRejected,
  encodeEnd, decodeEnd, type KdPublic, type PublicPlayer,
} from './netSync';
import { sound } from '../../core/sound';

/** 정답 공개를 보여주는 시간 */
const REVEAL_MS = 3_200;
/** 출제자가 창을 닫아둬서 방이 멈추는 걸 막는 백스톱 — 넘으면 호스트가 랜덤 출제 */
const SETWORD_TIMEOUT_MS = 60_000;
/** 게스트가 hello 를 보내고 sync 가 안 오면 재시도하는 간격 */
const HELLO_RETRY_MS = 1_500;
const END_DELAY_MS = 1_200;
/** 안내 문구 자동 사라짐 */
const NOTICE_MS = 2_600;

interface Seat {
  peerId: string;
  nickname: string;
}

class KordleModule implements GameModule {
  private ctx!: GameContext;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private destroyed = false;
  private paused = false;

  private jamoLen: JamoLen = 6;
  private totalRounds = 0;

  private renderer: KordleRenderer | null = null;
  private rafId: number | null = null;

  // --- 공개 상태 (게스트는 sync 로 받아서 통째 교체) ---
  private pub: KdPublic = {
    phase: 'setword', round: 0, totalRounds: 0, jamoLen: 6,
    setterPeerId: null, players: [], answer: null,
  };

  // --- 로컬 ---
  private myGuesses: string[] = [];
  /**
   * 입력 버퍼 — 기본 자모만 쌓인다.
   * 출제(setword)와 추측(guess)이 **같은 버퍼·같은 키보드**를 쓴다.
   * 출제만 따로 텍스트 입력창을 두면 한쪽은 IME, 한쪽은 풀어쓰기라 손이 헷갈린다.
   */
  private jamo: string[] = [];
  private myWord: string | null = null;
  private notice = '';
  private noticeUntil = 0;
  private localRoundStart = 0;
  private lastHelloAt = 0;
  private syncedOnce = false;

  // --- 호스트 전용 ---
  private seats: Seat[] = [];
  /** 첫 출제자 출발점 (게임당 한 번 무작위). -1 = 아직 안 정함 */
  private setterBase = -1;
  private leftPeers = new Set<string>();
  private answer = '';
  private rounds = new Map<string, PlayerRound>();
  private roundStartAt = 0;
  private setwordDeadline = 0;
  private revealUntil = 0;
  private usedAnswers = new Set<string>();

  // ============================================
  // 수명주기
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.jamoLen = parseJamoLen(ctx.roomOptions['len']);
    this.totalRounds = parseRounds(ctx.roomOptions['rounds']);

    this.renderer = new KordleRenderer(ctx.canvas, {
      onJamo: (j) => {
        if (this.jamo.length < this.jamoLen) this.jamo.push(j);
      },
      onBackspace: () => { this.jamo.pop(); },
      onSubmit: () => {
        if (this.amSetting()) this.submitWord();
        else this.submitGuess();
      },
      onFinish: () => this.requestFinish(),
      onPickRandom: () => {
        // 출제가 막힐 때 단어장에서 하나. 60초 백스톱에 걸려 방이 멈추는 것보다 낫다
        const pool = answerPool(this.jamoLen);
        const w = pool[Math.floor(Math.random() * pool.length)] ?? '';
        this.jamo = decompose(w) ?? [];
      },
    });
    sound.startBgm('apple-game'); // 가벼운 퍼즐용 BGM 재사용

    if (this.isHost) {
      this.seats = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'))
        .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));
      this.pub.totalRounds = this.totalRounds;
      this.pub.jamoLen = this.jamoLen;
      this.startRoundAsHost();
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

  setPaused(paused: boolean): void {
    // 타이머가 점수에 들어가므로, 멈춘 동안은 라운드 시작 시각을 밀어서 손해 안 보게 한다
    if (paused && !this.paused) this.pauseAt = performance.now();
    if (!paused && this.paused) {
      const delta = performance.now() - this.pauseAt;
      this.roundStartAt += delta;
      this.localRoundStart += delta;
    }
    this.paused = paused;
  }
  private pauseAt = 0;

  // ============================================
  // 루프
  // ============================================

  private loop = (): void => {
    if (this.destroyed) return;
    const now = performance.now();

    if (!this.isHost && !this.syncedOnce && now - this.lastHelloAt > HELLO_RETRY_MS) {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
      this.lastHelloAt = now;
    }
    if (this.isHost && !this.paused) this.tickHost(now);
    if (this.notice && now > this.noticeUntil) this.notice = '';

    this.renderer?.render({
      pub: this.pub,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      myGuesses: this.myGuesses,
      jamo: this.jamo,
      myWord: this.myWord,
      wordCheck: this.amSetting() ? this.checkJamo(this.jamo) : null,
      elapsedMs: this.pub.phase === 'guess' ? Math.max(0, now - this.localRoundStart) : 0,
      isHost: this.isHost,
      notice: this.notice,
    });
    this.rafId = requestAnimationFrame(this.loop);
  };

  private tickHost(now: number): void {
    if (this.pub.phase === 'setword' && this.setwordDeadline > 0 && now > this.setwordDeadline) {
      // 출제자가 응답이 없다 → 호스트가 대신 랜덤 출제 (방이 멈추지 않게)
      this.acceptAnswer(this.pickRandomAnswer(), true);
    } else if (this.pub.phase === 'reveal' && now > this.revealUntil) {
      this.startRoundAsHost();
    }
  }

  // ============================================
  // 호스트 — 라운드 진행
  // ============================================

  private activeSeats(): Seat[] {
    return this.seats.filter((s) => !this.leftPeers.has(s.peerId));
  }

  /**
   * 지금 라운드를 무르고 혼자 모드(랜덤 출제)로 다시 연다.
   * 같이 하던 사람이 다 나가 혼자 남았을 때 푸른다.
   */
  private restartRoundSolo(): void {
    this.pub.round -= 1; // startRound 가 다시 1 올린다
    this.startRoundAsHost();
  }

  private startRoundAsHost(): void {
    const seats = this.activeSeats();
    if (seats.length === 0) return;

    const next = this.pub.round + 1;
    if (this.totalRounds > 0 && next > this.totalRounds) {
      this.finishAsHost();
      return;
    }

    // 출제자 로테이션. 혼자면 출제자 없이 랜덤 정답
    const solo = seats.length < 2;
    // 첫 출제자도 무작위 — 안 그러면 항상 방장이 먼저 낸다
    if (this.setterBase < 0) this.setterBase = randomStartIndex(seats.length);
    const setter = solo ? null : seats[(this.setterBase + next - 1) % seats.length]!;

    this.pub.round = next;
    this.pub.setterPeerId = setter?.peerId ?? null;
    this.pub.answer = null;
    this.rounds = new Map(seats.map((s) => [s.peerId, emptyPlayerRound()]));
    this.myGuesses = [];
    this.jamo = [];
    this.myWord = null;

    if (solo) {
      this.acceptAnswer(this.pickRandomAnswer(), false);
    } else {
      this.answer = '';
      this.pub.phase = 'setword';
      this.setwordDeadline = performance.now() + SETWORD_TIMEOUT_MS;
      this.broadcastSync();
    }
  }

  private pickRandomAnswer(): string {
    const pool = answerPool(this.jamoLen);
    // 한 게임 안에서 같은 단어가 또 나오지 않게. 다 쓰면 리셋
    if (this.usedAnswers.size >= pool.length) this.usedAnswers.clear();
    for (let i = 0; i < 60; i++) {
      const w = pool[Math.floor(Math.random() * pool.length)]!;
      if (!this.usedAnswers.has(w)) return w;
    }
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  private acceptAnswer(word: string, auto: boolean): void {
    this.answer = word;
    // 관전자는 정답을 알고 본다 — 남이 얼마나 가까워졌는지가 보여야 구경이 된다
    this.ctx.publishSpectatorInfo([{ label: '정답', value: word, hot: true }]);
    this.usedAnswers.add(word);
    this.pub.phase = 'guess';
    this.setwordDeadline = 0;
    this.roundStartAt = performance.now();
    this.localRoundStart = this.roundStartAt;
    if (auto) this.pub.setterPeerId = null; // 자동 출제면 출제자 없음 → 전원 참가
    if (this.pub.setterPeerId === this.myPeerId) this.myWord = word;

    // 맞힐 사람이 한 명도 없으면(단어 고르는 사이 다 나갔다) 라운드가 영영 안 끝난다.
    // 출제자만 남아 키보드만 보고 있는 상황 — 혼자 모드로 다시 열어준다.
    if (this.pub.setterPeerId !== null && this.guessers().length === 0) {
      this.restartRoundSolo();
      return;
    }
    this.broadcastSync();
  }

  private handleSetWord(from: string, word: string): void {
    if (this.pub.phase !== 'setword' || from !== this.pub.setterPeerId) return;
    const err = this.validateWord(word);
    if (err) {
      if (from === this.myPeerId) this.showNotice(err);
      else this.sendTo(from, encodeRejected(err));
      return;
    }
    this.acceptAnswer(word.trim(), false);
  }

  private handleGuess(from: string, word: string): void {
    // 거절은 반드시 보낸 쪽에 알린다. 조용히 버리면 그쪽 myGuesses 에
    // 색 없는 고아 항목이 남아 글자와 채점 결과가 어긋난다.
    const reject = (msg: string): void => {
      if (from === this.myPeerId) {
        const back = this.myGuesses.pop();
        if (back) this.jamo = decompose(back) ?? [];  // 되돌려서 고칠 수 있게
        this.showNotice(msg);
      } else {
        this.sendTo(from, encodeRejected(msg));
      }
    };
    if (this.pub.phase !== 'guess') return reject('지금은 추측할 수 없어요.');
    if (from === this.pub.setterPeerId) return reject('출제자는 맞힐 수 없어요.');
    const r = this.rounds.get(from);
    if (!r) return reject('참가자 목록에 없어요.');
    if (isDone(r)) return reject('이번 라운드는 이미 끝났어요.');

    const err = this.validateWord(word);
    if (err) return reject(err);
    const guess = word.trim();
    const gj = decompose(guess)!;
    const aj = decompose(this.answer)!;
    const marks = judgeGuess(gj, aj);

    r.guesses.push(guess);
    r.marks.push(marks);
    if (gj.join('') === aj.join('')) {
      r.solved = true;
      r.elapsedMs = performance.now() - this.roundStartAt;
    } else if (r.marks.length >= MAX_TRIES) {
      r.failed = true;
      r.elapsedMs = performance.now() - this.roundStartAt;
    }
    this.broadcastSync();

    // 출제자/이탈자를 뺀 '맞히는 사람' 전원이 끝났으면 라운드 종료
    if (this.guessers().every((p) => isDone(this.rounds.get(p)!))) this.revealAsHost();
  }

  private guessers(): string[] {
    return this.activeSeats()
      .map((s) => s.peerId)
      .filter((id) => id !== this.pub.setterPeerId && this.rounds.has(id));
  }

  /**
   * 자모 길이 + 사전 등재 여부를 본다.
   * 추측을 사전으로 막으면서 출제만 자유롭게 두면 **아무도 못 맞히는 라운드**가 생기므로
   * 출제·추측 모두 같은 기준을 쓴다.
   */
  private validateWord(raw: string): string | null {
    const w = raw.trim();
    if (!w) return '단어를 입력해주세요.';
    const j = decompose(w);
    // decompose 는 완성형 음절만 받는다 → 조합 중인 글자(ㄷ, 도ㅈ …)가 남아 있으면 여기서 걸린다
    if (!j) return '글자를 완성해주세요.';
    if (j.length !== this.jamoLen) return `자모 ${this.jamoLen}칸이어야 해요 (지금 ${j.length}칸).`;
    if (!isUsableWord(w)) return `'${w}' 는 쓸 수 없는 단어예요.`;
    return null;
  }

  private revealAsHost(): void {
    for (const id of this.guessers()) {
      const r = this.rounds.get(id)!;
      r.score = roundScore(r.solved, r.marks.length, r.elapsedMs ?? 0);
    }
    this.pub.phase = 'reveal';
    this.pub.answer = this.answer;
    this.revealUntil = performance.now() + REVEAL_MS;
    // 누적 총점은 publicPlayers() 가 rounds + totals 로 만든다
    for (const [id, r] of this.rounds) this.totals.set(id, (this.totals.get(id) ?? 0) + r.score);
    this.broadcastSync();
  }
  private totals = new Map<string, number>();

  private requestFinish(): void {
    if (this.isHost) this.finishAsHost();
  }

  private finishAsHost(): void {
    if (this.pub.phase === 'ended') return;
    this.pub.phase = 'ended';
    this.pub.answer = this.answer || null;
    this.broadcastSync();

    // 동점은 같은 등수. resultScreen 이 기대하는 스키마에 맞춘다
    // (gameId / myPeerId / rank / totalPlayers / rankings[{peerId,nickname,rank,score}])
    const sorted = this.activeSeats()
      .map((s) => ({ peerId: s.peerId, nickname: s.nickname, score: this.totals.get(s.peerId) ?? 0 }))
      .sort((a, b) => b.score - a.score);
    const rankings = sorted.map((e, i) => ({
      ...e,
      rank: i > 0 && sorted[i - 1]!.score === e.score ? -1 : i + 1,
    }));
    for (let i = 1; i < rankings.length; i++) {
      if (rankings[i]!.rank === -1) rankings[i]!.rank = rankings[i - 1]!.rank;
    }
    const top = sorted[0]?.score ?? 0;

    window.setTimeout(() => {
      if (this.destroyed) return;
      for (const s of this.seats) {
        const mine = this.totals.get(s.peerId) ?? 0;
        const result: GameResult = {
          winner: rankings.length < 2 ? null : mine === top ? 'me' : 'opponent',
          summary: {
            gameId: 'kordle',
            myPeerId: s.peerId,
            rank: rankings.find((r) => r.peerId === s.peerId)?.rank ?? rankings.length,
            totalPlayers: rankings.length,
            myScore: mine,
            jamoLen: this.jamoLen,
            rounds: this.pub.round,
            rankings,
          },
        };
        if (s.peerId === this.myPeerId) this.ctx.endGame(result);
        else this.sendTo(s.peerId, encodeEnd(result));
      }
    }, END_DELAY_MS);
  }

  // ============================================
  // 동기화
  // ============================================

  private publicPlayers(): PublicPlayer[] {
    return this.activeSeats().map((s) => {
      const r = this.rounds.get(s.peerId) ?? emptyPlayerRound();
      return {
        peerId: s.peerId,
        nickname: s.nickname,
        marks: r.marks,
        solved: r.solved,
        failed: r.failed,
        elapsedMs: r.elapsedMs,
        roundScore: r.score,
        total: this.totals.get(s.peerId) ?? 0,
      };
    });
  }

  private broadcastSync(): void {
    this.pub.players = this.publicPlayers();
    this.pub.jamoLen = this.jamoLen;
    this.pub.totalRounds = this.totalRounds;
    this.ctx.sendToPeer(encodeSync(this.pub));
  }

  private sendTo(peerId: string, msg: GameMessage): void {
    this.ctx.sendToPeer(msg, { target: peerId });
  }

  // ============================================
  // 입력
  // ============================================

  /** 지금 내가 출제할 차례인가 (= 입력 버퍼가 '추측' 이 아니라 '출제' 용인가) */
  private amSetting(): boolean {
    return this.pub.phase === 'setword' && this.pub.setterPeerId === this.myPeerId;
  }

  private submitWord(): void {
    const c = this.checkJamo(this.jamo);
    if (!c.ok || !c.word) {
      this.showNotice(c.message || `자모 ${this.jamoLen}칸을 채워주세요.`);
      return;
    }
    const word = c.word;
    this.jamo = [];
    this.myWord = word;
    if (this.isHost) this.handleSetWord(this.myPeerId, word);
    else this.ctx.sendToPeer(encodeSetWord(this.myPeerId, word));
  }

  private submitGuess(): void {
    if (this.jamo.length !== this.jamoLen) {
      this.showNotice(`자모 ${this.jamoLen}칸을 채워주세요 (지금 ${this.jamo.length}칸).`);
      return;
    }
    // 자모만으로는 원래 글자를 하나로 못 정한다(각가이 ↔ 가까이).
    // 그래서 "조합 가능한 것 중 사전에 있는 단어" 를 찾아 그걸 제출한다.
    const w = findComposition(this.jamo, isUsableWord);
    if (!w) {
      this.showNotice('사전에 없는 단어예요.');
      return;
    }
    this.jamo = [];
    this.myGuesses.push(w); // 내 글자는 로컬 보관 — sync 에는 색만 온다
    if (this.isHost) this.handleGuess(this.myPeerId, w);
    else this.ctx.sendToPeer(encodeGuess(this.myPeerId, w));
  }

  /**
   * 출제 입력 실시간 검증. 제출해봐야 거절당하는 걸 막으려고 치는 동안 계속 돌린다.
   *
   * 자모만으로는 글자를 하나로 못 정한다(ㄱㅏㄱㄱㅏㅇㅣ = 각가이 ↔ 가까이).
   * 그래서 추측 제출과 **똑같이** 조합 가능한 것 중 사전에 있는 단어를 찾아
   * 그걸 출제어로 쓴다. 찾은 단어를 안내 문구에 그대로 보여줘서
   * 내가 생각한 말과 다르면 지우고 다시 칠 수 있게 한다.
   */
  private checkJamo(j: readonly string[]): { ok: boolean; word: string | null; message: string } {
    if (j.length === 0) return { ok: false, word: null, message: '' };
    if (j.length < this.jamoLen) {
      return { ok: false, word: null, message: `자모 ${j.length}칸 — ${this.jamoLen - j.length}칸 더 필요해요` };
    }
    const w = findComposition(j, isUsableWord);
    if (!w) return { ok: false, word: null, message: '쓸 수 있는 단어가 아니에요' };
    return { ok: true, word: w, message: `'${w}' — 출제할 수 있어요` };
  }

  private showNotice(text: string): void {
    this.notice = text;
    this.noticeUntil = performance.now() + NOTICE_MS;
  }

  // ============================================
  // 수신
  // ============================================

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    if (this.isHost) {
      const hello = decodeHello(msg);
      if (hello) {
        this.broadcastSync();
        const r = this.rounds.get(hello.peerId);
        if (r && r.guesses.length > 0) this.sendTo(hello.peerId, encodeMine(this.pub.round, r.guesses));
        return;
      }
      const sw = decodeSetWord(msg);
      if (sw) { this.handleSetWord(sw.from, sw.word); return; }
      const g = decodeGuess(msg);
      if (g) { this.handleGuess(g.from, g.word); return; }
      return;
    }

    const sync = decodeSync(msg);
    if (sync) {
      const newRound = sync.round !== this.pub.round;
      const toGuess = sync.phase === 'guess' && this.pub.phase !== 'guess';
      this.pub = sync;
      this.jamoLen = sync.jamoLen;
      this.totalRounds = sync.totalRounds;
      this.syncedOnce = true;
      if (newRound) {
        this.myGuesses = [];
        this.jamo = [];
        this.myWord = null;
      }
      if (toGuess || newRound) this.localRoundStart = performance.now();
      return;
    }
    const mine = decodeMine(msg);
    if (mine) {
      if (mine.round === this.pub.round) this.myGuesses = mine.guesses;
      return;
    }
    const rej = decodeRejected(msg);
    if (rej) {
      // 거절당한 추측은 로컬 기록에서 되돌린다 (호스트는 안 받아들였으므로)
      if (this.myGuesses.length > (this.pub.players.find((p) => p.peerId === this.myPeerId)?.marks.length ?? 0)) {
        this.myGuesses.pop();
      }
      this.showNotice(rej.message);
      return;
    }
    const end = decodeEnd(msg);
    if (end) { this.ctx.endGame(end); return; }
  }

  // ============================================
  // 이탈
  // ============================================

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.destroyed) return;
    this.leftPeers.add(peerId);
    this.rounds.delete(peerId);

    const seats = this.activeSeats();
    if (seats.length === 0) return;

    // 혼자 남았는데 출제자가 정해져 있으면 눈앉 할 사람이 없거나 맞힐 사람이 없다.
    // 그 라운드를 혼자 모드로 다시 열어 혐태에 멈추지 않게 한다.
    if (seats.length < 2 && this.pub.setterPeerId !== null
        && (this.pub.phase === 'setword' || this.pub.phase === 'guess')) {
      this.restartRoundSolo();
      return;
    }

    if (this.pub.phase === 'setword' && peerId === this.pub.setterPeerId) {
      // 출제자가 나갔다 → 호스트가 대신 랜덤 출제하고 전원 참가로 돌린다
      this.acceptAnswer(this.pickRandomAnswer(), true);
      return;
    }
    if (this.pub.phase === 'guess') {
      const left = this.guessers();
      if (left.length > 0 && left.every((p) => isDone(this.rounds.get(p)!))) {
        this.revealAsHost();
        return;
      }
      if (left.length === 0) { this.revealAsHost(); return; }
    }
    this.broadcastSync();
  }
}

/** 좌석 순서 = 방장 먼저, 나머지는 peerId 사전순. 전 클라이언트가 같은 순서를 본다 */
function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

export function createKordle(): GameModule {
  return new KordleModule();
}
