/**
 * 노 터치 크라켄 — 호스트 authoritative
 *
 * 호스트가 역할을 나누고, 카드를 돌리고, 뒤집힌 결과를 판정한다.
 * 게스트는 "저 사람의 n번째 카드를 뒤집겠다" 만 보내고 나머지는 전부 sync 로 받는다.
 *
 * 선언("나 보물 2장 있어")은 채팅으로 한다 — 별도 UI를 두지 않았다.
 * 거짓말과 추궁이 이 게임의 전부라, 버튼으로 정형화하면 오히려 재미가 줄어든다.
 */

import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import {
  buildDeck, dealRoles, handSizeForRound, shuffle, setupFor,
  ROUNDS, ROLE_LABEL, KIND_LABEL, type CardKind, type Role,
} from './rules';
import { KrakenRenderer } from './render';
import {
  encodeHello, decodeHello, encodeSync, decodeSync,
  encodeFlip, decodeFlip, encodeEnd, decodeEnd,
  type SyncPayload, type SyncSeat, type KrPhase,
} from './netSync';
import { randomStartIndex } from '../_shared/turnOrder';
import { sound } from '../../core/sound';

const HELLO_RETRY_MS = 1_500;
const END_DELAY_MS = 2_600;

interface Seat {
  peerId: string;
  nickname: string;
  role: Role;
  /** 아직 안 뒤집힌 카드. 섞인 순서라 본인도 어느 게 뭔지 모른다 */
  hand: CardKind[];
  /** 이번 라운드에 이 사람 앞에서 공개된 카드 */
  opened: CardKind[];
  gone: boolean;
}

class KrakenModule implements GameModule {
  private ctx!: GameContext;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private destroyed = false;

  private renderer: KrakenRenderer | null = null;
  private rafId: number | null = null;
  /** 턴 제한 시간(초). 0 이면 무제한 */
  private turnLimitSec = 60;

  // --- 공개 상태 (게스트는 sync 로 통째 교체) ---
  private seatsView: SyncSeat[] = [];
  private round = 1;
  private actionsLeft = 0;
  private turn = '';
  private phase: KrPhase = 'play';
  private found = { treasure: 0, futile: 0, kraken: 0 };
  private totalTreasure = 0;
  private deadline = 0;
  private news = '';
  private winner: Role | null = null;

  private lastHelloAt = 0;
  private syncedOnce = false;

  // --- 호스트 전용 ---
  private seats: Seat[] = [];
  private ended = false;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.turnLimitSec = parseTurnLimit(ctx.roomOptions['turnLimit']);

    this.renderer = new KrakenRenderer(ctx.canvas, {
      onFlip: (target, index) => this.submitFlip(target, index),
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
    // 시간이 다 되면 호스트가 대신 아무 카드나 뒤집는다.
    // 한 명이 고민하다 판이 영영 멈추는 것보다는 낫다 (넘기기가 없는 게임이라 건너뛸 수가 없다).
    if (this.isHost && !this.ended && this.deadline > 0 && Date.now() >= this.deadline) {
      this.flipRandom();
    }

    this.renderer?.render({
      seats: this.seatsView, round: this.round, actionsLeft: this.actionsLeft,
      turn: this.turn, phase: this.phase, found: this.found,
      totalTreasure: this.totalTreasure, deadline: this.deadline,
      news: this.news, winner: this.winner,
      myPeerId: this.myPeerId, isSpectator: this.isSpectator,
    });
    this.rafId = requestAnimationFrame(this.loop);
  };

  // ============================================
  // 호스트 — 준비
  // ============================================

  private setupAsHost(all: Player[]): void {
    const n = all.length;
    const roles = dealRoles(n);
    const deck = buildDeck(n);
    const hand = handSizeForRound(1);

    this.seats = all.map((p, i) => ({
      peerId: p.peerId,
      nickname: p.nickname,
      role: roles[i] ?? 'crew',
      hand: deck.slice(i * hand, i * hand + hand),
      opened: [],
      gone: false,
    }));

    this.totalTreasure = setupFor(n).treasure;
    this.round = 1;
    this.actionsLeft = n;
    this.phase = 'play';
    this.found = { treasure: 0, futile: 0, kraken: 0 };
    this.turn = this.seats[randomStartIndex(n)]!.peerId;
    this.news = '1라운드 — 각자 채팅으로 내 패 구성을 말해요 (거짓말해도 됩니다)';

    // 역할은 화면에 안 그려지니 관전자용 통로로 따로 넘긴다. 손패 구성은 sync 로 전부 간다.
    this.ctx.publishSpectatorInfo(
      this.seats.map((s) => ({
        label: s.nickname,
        value: ROLE_LABEL[s.role],
        hot: s.role === 'pirate',
      })),
    );

    this.armTurn();
    this.broadcast();
  }

  private armTurn(): void {
    this.deadline = this.turnLimitSec > 0 ? Date.now() + this.turnLimitSec * 1000 : 0;
  }

  // ============================================
  // 입력
  // ============================================

  private submitFlip(target: string, index: number): void {
    if (this.phase !== 'play' || this.isSpectator) return;
    if (this.turn !== this.myPeerId || target === this.myPeerId) return;
    if (this.isHost) this.handleFlip(this.myPeerId, target, index);
    else this.ctx.sendToPeer(encodeFlip(this.myPeerId, target, index));
  }

  // ============================================
  // 호스트 — 판정
  // ============================================

  private seatOf(peerId: string): Seat | undefined {
    return this.seats.find((s) => s.peerId === peerId);
  }

  private active(): Seat[] {
    return this.seats.filter((s) => !s.gone);
  }

  private handleFlip(from: string, target: string, index: number, auto = false): void {
    if (this.ended || this.phase !== 'play') return;
    if (from !== this.turn || from === target) return;
    const actor = this.seatOf(from);
    const owner = this.seatOf(target);
    if (!actor || actor.gone || !owner || owner.gone) return;
    if (index < 0 || index >= owner.hand.length) return;

    const card = owner.hand.splice(index, 1)[0]!;
    owner.opened.push(card);
    this.found[card] += 1;
    const who = auto ? `시간 초과로 ${actor.nickname} 님 대신` : `${actor.nickname} 님이`;
    this.news = `${who} ${owner.nickname} 님의 카드를 뒤집었어요 — ${KIND_LABEL[card]}`;

    if (card === 'kraken') {
      this.news = `크라켄이 깨어났어요! ${owner.nickname} 님의 카드였습니다`;
      sound.play('tetris_topout');
      this.finish('pirate');
      return;
    }
    if (card === 'treasure') sound.play('tetris_tetris');
    else sound.play('tetris_lock');

    if (this.found.treasure >= this.totalTreasure) {
      this.news = '보물을 전부 찾았어요! 탐험대 승리';
      this.finish('crew');
      return;
    }

    // 뒤집힌 카드의 주인이 다음 차례가 된다 (원작 규칙)
    this.turn = target;
    this.actionsLeft -= 1;
    // 라운드의 마지막 한 장이면 라운드 안내가 소식을 덮어쓴다 — 뭐가 나왔는지는 같이 남긴다
    if (this.actionsLeft <= 0) { this.nextRound(this.news); return; }

    this.armTurn();
    this.broadcast();
  }

  /** 시간 초과 — 뒤집을 수 있는 카드 중 하나를 무작위로 */
  private flipRandom(): void {
    if (!this.seatOf(this.turn)) { this.deadline = 0; return; }
    const targets = this.active().filter((s) => s.peerId !== this.turn && s.hand.length > 0);
    if (targets.length === 0) { this.nextRound(); return; }
    const t = targets[Math.floor(Math.random() * targets.length)]!;
    const i = Math.floor(Math.random() * t.hand.length);
    this.handleFlip(this.turn, t.peerId, i, true);
  }

  private nextRound(lead = ''): void {
    if (this.ended) return;
    // 마지막 라운드까지 버텼으면 여기서 끝. round 를 올려버리면 화면에 "5/4 라운드" 가 뜬다
    if (this.round >= ROUNDS) {
      this.news = `${lead ? lead + '  ·  ' : ''}${ROUNDS}라운드가 다 지났어요 — 보물을 못 찾았으니 해적 승리`;
      this.finish('pirate');
      return;
    }
    this.round += 1;

    // 남은 카드를 전부 모아 다시 섞어 나눈다. 라운드마다 한 장씩 줄어든다.
    const alive = this.active();
    const pool = shuffle(alive.flatMap((s) => s.hand));
    for (const s of this.seats) { s.hand = []; s.opened = []; }

    // 보통은 pool.length === alive.length * handSizeForRound(round) 로 딱 떨어진다.
    // 중간에 누가 나가서 카드가 빠졌을 때만 어긋나는데, 그럴 땐 앞에서부터 한 장씩 더 준다.
    const base = Math.floor(pool.length / Math.max(1, alive.length));
    let extra = pool.length - base * alive.length;
    let at = 0;
    for (const s of alive) {
      const take = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      s.hand = pool.slice(at, at + take);
      at += take;
    }

    this.actionsLeft = alive.length;
    if (!this.seatOf(this.turn) || this.seatOf(this.turn)!.gone) {
      this.turn = alive[0]?.peerId ?? this.turn;
    }
    this.news = `${lead ? lead + '  ·  ' : ''}${this.round}라운드 — 카드를 다시 섞어 ${handSizeForRound(this.round)}장씩 나눴어요`;
    sound.play('pop');
    this.armTurn();
    this.broadcast();
  }

  /** 받는 사람 기준으로 가린다. 관전자와 게임 종료 후에는 전부 열린다 */
  private maskFor(peerId: string): SyncSeat[] {
    const seeAll = this.ended || !this.seatOf(peerId); // 좌석이 없다 = 관전자
    return this.seats.map((s) => {
      const mine = seeAll || s.peerId === peerId;
      return {
        peerId: s.peerId,
        nickname: s.nickname,
        hidden: s.hand.length,
        opened: s.opened.slice(),
        gone: s.gone,
        role: mine ? s.role : null,
        counts: mine
          ? {
              treasure: s.hand.filter((c) => c === 'treasure').length,
              kraken: s.hand.filter((c) => c === 'kraken').length,
            }
          : null,
      };
    });
  }

  private syncFor(peerId: string): SyncPayload {
    return {
      seats: this.maskFor(peerId),
      round: this.round,
      actionsLeft: this.actionsLeft,
      turn: this.turn,
      phase: this.phase,
      found: { ...this.found },
      totalTreasure: this.totalTreasure,
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

  private finish(winner: Role | null): void {
    if (this.ended) return;
    this.ended = true;
    this.winner = winner;
    this.phase = 'over';
    this.deadline = 0;
    this.broadcast(); // 끝났으니 역할과 손패가 전부 열린다 (maskFor 가 ended 를 본다)

    const resultFor = (peerId: string): GameResult => {
      const seat = this.seatOf(peerId);
      return {
        winner: seat && winner ? (seat.role === winner ? 'me' : 'opponent') : null,
        summary: {
          gameId: 'kraken',
          myPeerId: peerId,
          winnerRole: winner,
          myRole: seat?.role ?? null,
          round: this.round,
          found: { ...this.found },
          totalTreasure: this.totalTreasure,
          players: this.seats.map((s) => ({
            peerId: s.peerId, nickname: s.nickname, role: s.role,
          })),
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
    this.seatsView = s.seats;
    this.round = s.round;
    this.actionsLeft = s.actionsLeft;
    this.turn = s.turn;
    this.phase = s.phase;
    this.found = s.found;
    this.totalTreasure = s.totalTreasure;
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
      const f = decodeFlip(msg);
      if (f) { this.handleFlip(f.from, f.target, f.index); return; }
      return;
    }

    const sync = decodeSync(msg);
    if (sync) { this.applySync(sync); return; }
    const end = decodeEnd(msg);
    if (end) { this.ctx.endGame(end); return; }
  }

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.ended) return;
    const seat = this.seatOf(peerId);
    if (!seat || seat.gone) { this.broadcast(); return; }
    seat.gone = true;

    // 들고 있던 카드는 그 자리에서 공개한다.
    // 그냥 빼버리면 그 안에 있던 보물을 영영 못 찾아서 탐험대가 이길 방법이 사라진다.
    const left = seat.hand.splice(0, seat.hand.length);
    for (const c of left) { seat.opened.push(c); this.found[c] += 1; }
    this.news = `${seat.nickname} 님이 나갔어요 — 들고 있던 카드 ${left.length}장이 공개됩니다`;

    if (left.includes('kraken')) {
      this.news = `${seat.nickname} 님이 크라켄을 들고 나갔어요 — 해적 승리`;
      this.finish('pirate');
      return;
    }
    if (this.found.treasure >= this.totalTreasure) {
      this.news = '보물을 전부 찾았어요! 탐험대 승리';
      this.finish('crew');
      return;
    }

    const alive = this.active();
    if (alive.length < 2) { this.news = '사람이 너무 많이 나갔어요'; this.finish(null); return; }

    if (this.turn === peerId) this.turn = alive[0]!.peerId;
    // 뒤집을 카드가 한 장도 안 남았으면 라운드를 앞당겨 끝낸다
    if (alive.every((s) => s.hand.length === 0)) { this.nextRound(); return; }

    this.armTurn();
    this.broadcast();
  }
}

/** 방 옵션의 턴 제한 시간(초). '0' = 무제한 */
function parseTurnLimit(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

export function createKraken(): GameModule {
  return new KrakenModule();
}
