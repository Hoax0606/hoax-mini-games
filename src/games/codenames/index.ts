/**
 * 코드네임 — 호스트 authoritative
 *
 * 호스트가 판을 깔고 팀을 나누고 모든 판정을 한다.
 * 팀 나누기는 **시작할 때 무작위**다. 대기실에 팀 고르기 UI를 넣으면 플랫폼을 손대야 해서,
 * 여기서 섞는 쪽을 골랐다. 스파이마스터는 팀 안에서 판마다 돌아가며 맡는다.
 *
 * ⚠️ 색 배치는 스파이마스터와 관전자에게만 간다 (netSync 주석 참고).
 */

import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import {
  buildBoard, remaining, validateHint, guessResult, otherTeam, TEAM_LABEL,
  type Card, type Team,
} from './rules';
import { CodenamesRenderer } from './render';
import {
  encodeHello, decodeHello, encodeSync, decodeSync,
  encodeHint, decodeHint, encodeGuess, decodeGuess, encodePass, decodePass,
  encodeReject, decodeReject, encodeEnd, decodeEnd,
  type SyncPayload, type SyncPlayer, type MaskedCard, type CdPhase,
} from './netSync';
import { sound } from '../../core/sound';

const HELLO_RETRY_MS = 1_500;
const END_DELAY_MS = 2_200;

interface Seat {
  peerId: string;
  nickname: string;
  team: Team;
  spymaster: boolean;
}

class CodenamesModule implements GameModule {
  private ctx!: GameContext;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private destroyed = false;

  private renderer: CodenamesRenderer | null = null;
  private rafId: number | null = null;
  /** 턴 제한 시간(초). 0 이면 무제한 */
  private turnLimitSec = 90;

  // --- 공개 상태 (게스트는 sync 로 통째 교체) ---
  private players: SyncPlayer[] = [];
  private cards: MaskedCard[] = [];
  private turnTeam: Team = 'red';
  private phase: CdPhase = 'hint';
  private hint: { word: string; count: number } | null = null;
  private guessesLeft = 0;
  private left = { red: 0, blue: 0 };
  private deadline = 0;
  private news = '';
  private winner: Team | null = null;

  private lastHelloAt = 0;
  private syncedOnce = false;

  // --- 호스트 전용 ---
  private seats: Seat[] = [];
  private board: Card[] = [];
  private gone = new Set<string>();
  private ended = false;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.turnLimitSec = parseTurnLimit(ctx.roomOptions['turnLimit']);

    this.renderer = new CodenamesRenderer(ctx.canvas, {
      onHint: (w, n) => this.submitHint(w, n),
      onGuess: (i) => this.submitGuess(i),
      onPass: () => this.submitPass(),
    });
    sound.startBgm('menu');

    if (this.isHost) {
      this.setupAsHost(ctx.players.filter((p) => p.role === 'player'));
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
    // 시간이 다 되면 그 턴은 그냥 넘긴다 (한 사람이 고민하다 판이 멈추지 않게)
    if (this.isHost && !this.ended && this.deadline > 0 && Date.now() >= this.deadline) {
      this.news = `${TEAM_LABEL[this.turnTeam]} 팀 시간이 다 됐어요`;
      this.endTurn();
    }

    this.renderer?.render({
      players: this.players, cards: this.cards, turnTeam: this.turnTeam, phase: this.phase,
      hint: this.hint, guessesLeft: this.guessesLeft, left: this.left,
      deadline: this.deadline, news: this.news, winner: this.winner,
      myPeerId: this.myPeerId, isSpectator: this.isSpectator,
    });
    this.rafId = requestAnimationFrame(this.loop);
  };

  // ============================================
  // 호스트 — 준비
  // ============================================

  /**
   * 팀 나누기 + 스파이마스터 뽑기.
   * 좌석을 섞어 번갈아 빨강/파랑에 넣는다. 각 팀의 첫 사람이 스파이마스터.
   * "판마다 돌아가며" 는 매 게임 새로 섞이니 자연히 바뀐다.
   */
  private setupAsHost(all: Player[]): void {
    const shuffled = all.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    this.seats = shuffled.map((p, i) => ({
      peerId: p.peerId,
      nickname: p.nickname,
      team: i % 2 === 0 ? 'red' : 'blue',
      spymaster: false,
    }));
    for (const team of ['red', 'blue'] as Team[]) {
      const first = this.seats.find((s) => s.team === team);
      if (first) first.spymaster = true;
    }

    const { cards, first } = buildBoard();
    this.board = cards;
    this.turnTeam = first;
    this.phase = 'hint';
    this.hint = null;
    this.guessesLeft = 0;
    this.news = `${TEAM_LABEL[first]} 팀 먼저 — 스파이마스터가 힌트를 생각하는 중`;
    this.armTurn();
    this.broadcast();
  }

  private armTurn(): void {
    this.deadline = this.turnLimitSec > 0 ? Date.now() + this.turnLimitSec * 1000 : 0;
  }

  // ============================================
  // 입력
  // ============================================

  private mySeat(): SyncPlayer | undefined {
    return this.players.find((p) => p.peerId === this.myPeerId);
  }

  private submitHint(word: string, count: number): void {
    const me = this.mySeat();
    if (!me || !me.spymaster || me.team !== this.turnTeam || this.phase !== 'hint') return;
    if (this.isHost) this.handleHint(this.myPeerId, word, count);
    else this.ctx.sendToPeer(encodeHint(this.myPeerId, word, count));
  }

  private submitGuess(index: number): void {
    const me = this.mySeat();
    if (!me || me.spymaster || me.team !== this.turnTeam || this.phase !== 'guess') return;
    if (this.isHost) this.handleGuess(this.myPeerId, index);
    else this.ctx.sendToPeer(encodeGuess(this.myPeerId, index));
  }

  private submitPass(): void {
    const me = this.mySeat();
    if (!me || me.spymaster || me.team !== this.turnTeam || this.phase !== 'guess') return;
    if (this.isHost) this.handlePass(this.myPeerId);
    else this.ctx.sendToPeer(encodePass(this.myPeerId));
  }

  // ============================================
  // 호스트 — 판정
  // ============================================

  private seatOf(peerId: string): Seat | undefined {
    return this.seats.find((s) => s.peerId === peerId);
  }

  private handleHint(from: string, raw: string, count: number): void {
    if (this.ended || this.phase !== 'hint') return;
    const seat = this.seatOf(from);
    if (!seat || !seat.spymaster || seat.team !== this.turnTeam) return;

    const err = validateHint(raw, this.board);
    if (err) {
      if (from === this.myPeerId) this.renderer?.showReject(err);
      else this.ctx.sendToPeer(encodeReject(err), { target: from });
      return;
    }
    const n = Math.max(1, Math.min(9, Math.floor(count)));
    this.hint = { word: raw.trim(), count: n };
    // 숫자+1 까지 찍을 수 있다 (원작 규칙 — 지난 턴에 못 찾은 걸 주우라고 준 여유)
    this.guessesLeft = n + 1;
    this.phase = 'guess';
    this.news = `${TEAM_LABEL[seat.team]} 팀 힌트: ${this.hint.word} ${n}`;
    this.armTurn();
    sound.play('pop');
    this.broadcast();
  }

  private handleGuess(from: string, index: number): void {
    if (this.ended || this.phase !== 'guess') return;
    const seat = this.seatOf(from);
    if (!seat || seat.spymaster || seat.team !== this.turnTeam) return;
    const card = this.board[index];
    if (!card || card.revealed) return;

    card.revealed = true;
    const res = guessResult(card.color, seat.team);

    if (res === 'assassin') {
      this.news = `${card.word} 은(는) 암살자! ${TEAM_LABEL[seat.team]} 팀 패배`;
      sound.play('tetris_topout');
      this.finish(otherTeam(seat.team));
      return;
    }

    if (res === 'hit') {
      this.news = `${card.word} 적중!`;
      sound.play('tetris_tetris');
      this.guessesLeft -= 1;
      if (remaining(this.board, seat.team) === 0) { this.finish(seat.team); return; }
      if (this.guessesLeft <= 0) { this.news = `${card.word} 적중 — 기회를 다 썼어요`; this.endTurn(); return; }
      this.broadcast();
      return;
    }

    if (res === 'opponent') {
      this.news = `${card.word} 은(는) ${TEAM_LABEL[otherTeam(seat.team)]} 팀 카드였어요`;
      sound.play('tetris_lock');
      if (remaining(this.board, otherTeam(seat.team)) === 0) { this.finish(otherTeam(seat.team)); return; }
    } else {
      this.news = `${card.word} 은(는) 행인이었어요`;
      sound.play('tetris_lock');
    }
    this.endTurn();
  }

  private handlePass(from: string): void {
    if (this.ended || this.phase !== 'guess') return;
    const seat = this.seatOf(from);
    if (!seat || seat.spymaster || seat.team !== this.turnTeam) return;
    this.news = `${TEAM_LABEL[seat.team]} 팀이 넘겼어요`;
    this.endTurn();
  }

  private endTurn(): void {
    this.turnTeam = otherTeam(this.turnTeam);
    this.phase = 'hint';
    this.hint = null;
    this.guessesLeft = 0;
    this.armTurn();
    this.broadcast();
  }

  /** 받는 사람 기준으로 색을 가린다. 스파이마스터와 관전자만 다 본다 */
  private maskFor(peerId: string): MaskedCard[] {
    const seat = this.seatOf(peerId);
    const seeAll = this.ended || !seat || seat.spymaster; // 좌석이 없다 = 관전자
    return this.board.map((c) => ({
      word: c.word,
      revealed: c.revealed,
      color: c.revealed || seeAll ? c.color : null,
    }));
  }

  private syncFor(peerId: string): SyncPayload {
    return {
      players: this.seats.map((s) => ({
        peerId: s.peerId, nickname: s.nickname, team: s.team,
        spymaster: s.spymaster, gone: this.gone.has(s.peerId),
      })),
      cards: this.maskFor(peerId),
      turnTeam: this.turnTeam,
      phase: this.phase,
      hint: this.hint,
      guessesLeft: this.guessesLeft,
      left: { red: remaining(this.board, 'red'), blue: remaining(this.board, 'blue') },
      deadline: this.deadline,
      news: this.news,
      winner: this.winner,
    };
  }

  private broadcast(): void {
    if (this.destroyed || !this.ctx) return;
    for (const p of this.ctx.players) {
      const payload = this.syncFor(p.peerId);
      if (p.peerId === this.myPeerId) this.applySync(payload);
      else this.ctx.sendToPeer(encodeSync(payload), { target: p.peerId });
    }
  }

  private finish(winner: Team): void {
    if (this.ended) return;
    this.ended = true;
    this.winner = winner;
    this.phase = 'over';
    this.deadline = 0;
    this.broadcast(); // 끝났으니 색이 전부 공개된다 (maskFor 가 ended 를 본다)

    const resultFor = (peerId: string): GameResult => {
      const seat = this.seatOf(peerId);
      return {
        winner: seat ? (seat.team === winner ? 'me' : 'opponent') : null,
        summary: {
          gameId: 'codenames',
          myPeerId: peerId,
          winnerTeam: winner,
          myTeam: seat?.team ?? null,
          mySpymaster: seat?.spymaster ?? false,
          players: this.seats.map((s) => ({
            peerId: s.peerId, nickname: s.nickname, team: s.team, spymaster: s.spymaster,
          })),
          left: { red: remaining(this.board, 'red'), blue: remaining(this.board, 'blue') },
        },
      };
    };

    window.setTimeout(() => {
      if (this.destroyed) return;
      for (const p of this.ctx.players) {
        if (p.peerId === this.myPeerId) continue;
        this.ctx.sendToPeer(encodeEnd(resultFor(p.peerId)), { target: p.peerId });
      }
      this.ctx.endGame(resultFor(this.myPeerId));
    }, END_DELAY_MS);
  }

  // ============================================
  // 수신
  // ============================================

  private applySync(s: SyncPayload): void {
    this.players = s.players;
    this.cards = s.cards;
    this.turnTeam = s.turnTeam;
    this.phase = s.phase;
    this.hint = s.hint;
    this.guessesLeft = s.guessesLeft;
    this.left = s.left;
    this.deadline = s.deadline;
    this.news = s.news;
    this.winner = s.winner;
    this.syncedOnce = true;
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    if (this.isHost) {
      const hello = decodeHello(msg);
      if (hello) { this.broadcast(); return; }
      const h = decodeHint(msg);
      if (h) { this.handleHint(h.from, h.word, h.count); return; }
      const g = decodeGuess(msg);
      if (g) { this.handleGuess(g.from, g.index); return; }
      const p = decodePass(msg);
      if (p) { this.handlePass(p.from); return; }
      return;
    }

    const sync = decodeSync(msg);
    if (sync) { this.applySync(sync); return; }
    const reject = decodeReject(msg);
    if (reject) { this.renderer?.showReject(reject); return; }
    const end = decodeEnd(msg);
    if (end) { this.ctx.endGame(end); return; }
  }

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.ended) return;
    this.gone.add(peerId);
    const seat = this.seatOf(peerId);
    if (!seat) { this.broadcast(); return; }
    this.news = `${seat.nickname} 님이 나갔어요`;

    // 스파이마스터가 나가면 같은 팀의 남은 사람에게 넘긴다 — 아니면 그 팀은 힌트를 못 준다
    if (seat.spymaster) {
      seat.spymaster = false;
      const heir = this.seats.find((s) => s.team === seat.team && !this.gone.has(s.peerId));
      if (heir) {
        heir.spymaster = true;
        this.news = `${seat.nickname} 님이 나가서 ${heir.nickname} 님이 스파이마스터를 맡아요`;
      }
    }
    // 한 팀이 통째로 비면 더 진행할 수 없다 — 남은 팀 승리
    for (const team of ['red', 'blue'] as Team[]) {
      const alive = this.seats.filter((s) => s.team === team && !this.gone.has(s.peerId));
      if (alive.length === 0) { this.finish(otherTeam(team)); return; }
    }
    this.broadcast();
  }
}

/** 방 옵션의 턴 제한 시간(초). '0' = 무제한 */
function parseTurnLimit(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 90;
}

export function createCodenames(): GameModule {
  return new CodenamesModule();
}
