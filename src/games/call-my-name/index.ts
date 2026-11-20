/**
 * 양세찬 게임 (콜 마이 네임) — 이마에 붙은 내 단어 맞히기
 *
 * 호스트 authoritative. 호스트가 단어를 나눠주고 차례와 정답을 판정한다.
 *
 * 질문과 대답은 **채팅으로** 한다 (라이어 게임과 같은 방식).
 * 원래 말로 하는 게임이라 질문을 양식에 가두면 재미가 죽는다.
 * 그래서 게임 모듈은 누가 뭘 달고 있는지, 누구 차례인지, 정답인지만 관리한다.
 *
 * 자기 단어를 모르는 게 게임의 전부라서, sync 는 사람마다 다르게 보낸다
 * (받는 사람 자기 단어만 지워서). 자세한 건 netSync 주석 참고.
 */

import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import {
  THEMES, parseTheme, pickWords, isCorrect, nextTurn, isOver, rankSort,
  type PlayerState,
} from './rules';
import { CallMyNameRenderer } from './render';
import {
  encodeHello, decodeHello, encodeSync, decodeSync,
  encodeGuess, decodeGuess, encodePass, decodePass,
  encodeEnd, decodeEnd,
} from './netSync';
import { sound } from '../../core/sound';

/** 게스트가 hello 를 보내고 sync 가 안 오면 재시도하는 간격 */
const HELLO_RETRY_MS = 1_500;
const END_DELAY_MS = 1_400;
/** 화면 아래 기록은 이만큼만 남긴다 */
const LOG_KEEP = 6;

class CallMyNameModule implements GameModule {
  private ctx!: GameContext;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private destroyed = false;

  private renderer: CallMyNameRenderer | null = null;
  private rafId: number | null = null;

  private themeKey = 'all';
  private themeLabel = '전체';

  // --- 공개 상태 (게스트는 sync 로 받아서 통째 교체) ---
  private players: PlayerState[] = [];
  private turnPeerId: string | null = null;
  private log: string[] = [];

  private notice = '';
  private noticeUntil = 0;
  private lastHelloAt = 0;
  private syncedOnce = false;

  // --- 호스트 전용 ---
  private turnIdx = 0;
  private nextRank = 1;
  private leftPeers = new Set<string>();
  private ended = false;

  // ============================================
  // 수명주기
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.themeKey = parseTheme(ctx.roomOptions['theme']);
    this.themeLabel = THEMES.find((t) => t.key === this.themeKey)?.label ?? '전체';

    this.renderer = new CallMyNameRenderer(ctx.canvas, {
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
      this.pushLog(`주제는 ${this.themeLabel}. 채팅으로 물어보세요`);
      this.broadcastSync();
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

    this.renderer?.render({
      players: this.players,
      turnPeerId: this.turnPeerId,
      theme: this.themeLabel,
      log: this.log,
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

  private pushLog(line: string): void {
    this.log = [...this.log, line].slice(-LOG_KEEP);
  }

  private handleGuess(from: string, word: string): void {
    if (this.ended || this.turnPeerId !== from) return;
    const me = this.players.find((p) => p.peerId === from);
    if (!me || me.solved) return;

    me.tries++;
    if (isCorrect(word, me.word)) {
      me.solved = true;
      me.rank = this.nextRank++;
      this.pushLog(`${me.nickname} 님 정답! (${me.word}) ${me.rank}등`);
      sound.play('tetris_tetris');
      if (isOver(this.players) || this.activeCount() === 0) { this.finishAsHost(); return; }
    } else {
      this.pushLog(`${me.nickname} 님이 ${word} 라고 했지만 아니에요`);
      sound.play('tetris_lock');
    }
    this.advanceTurn();
  }

  private handlePass(from: string): void {
    if (this.ended || this.turnPeerId !== from) return;
    const me = this.players.find((p) => p.peerId === from);
    if (me) this.pushLog(`${me.nickname} 님이 차례를 넘겼어요`);
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
        this.broadcastSync();
        return;
      }
    }
    this.finishAsHost();
  }

  private broadcastSync(): void {
    // 사람마다 자기 단어만 지워서 보낸다 (전체 broadcast 하면 자기 걸 볼 수 있다).
    // 호스트 자신에겐 안 보낸다 — 원본을 들고 있고, 자기 단어는 렌더가 가린다.
    for (const target of this.players) {
      if (target.peerId === this.myPeerId) continue;
      const view = this.players.map((p) => (
        p.peerId === target.peerId ? { ...p, word: '' } : p
      ));
      this.ctx.sendToPeer(encodeSync({
        players: view, turnPeerId: this.turnPeerId, theme: this.themeLabel, log: this.log,
      }), { target: target.peerId });
    }
    // 관전자에게는 전부 보여준다 (맞힐 사람이 아니라 구경꾼이다)
    for (const p of this.ctx.players) {
      if (p.role !== 'spectator') continue;
      this.ctx.sendToPeer(encodeSync({
        players: this.players, turnPeerId: this.turnPeerId, theme: this.themeLabel, log: this.log,
      }), { target: p.peerId });
    }
  }

  private finishAsHost(): void {
    if (this.ended) return;
    this.ended = true;
    this.turnPeerId = null;
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
      this.log = sync.log;
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
    if (p) this.pushLog(`${p.nickname} 님이 나갔어요`);
    if (this.activeCount() === 0) { this.finishAsHost(); return; }
    // 나간 사람 차례였으면 다음으로 넘긴다
    if (this.turnPeerId === peerId) this.advanceTurn();
    else this.broadcastSync();
  }
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
