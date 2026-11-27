/**
 * 루미큐브 — 호스트 authoritative
 *
 * 호스트가 덱을 섞어 나눠주고, 턴 순서와 커밋 판정을 전부 맡는다.
 * 게스트는 턴 중에 자기 화면에서 마음대로 타일을 옮기다가, 끝낼 때 **테이블 전체**를
 * 호스트에게 보낸다. 호스트가 규칙에 맞는지 보고 통과면 확정, 아니면 사유만 돌려준다
 * (화면은 게스트가 알아서 되돌린다).
 *
 * 턴 제한 시간이 지나면 호스트가 그 사람 턴을 "한 장 가져가기" 로 자동 종료한다.
 * 조작하던 건 커밋을 안 했으니 애초에 테이블에 반영된 적이 없다.
 */

import { randomStartIndex } from '../_shared/turnOrder';
import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import {
  buildDeck, shuffle, validateCommit, normalizeSet, handPenalty, START_HAND,
  type Tile, type TileSet,
} from './rules';
import { RummikubRenderer } from './render';
import {
  encodeHello, decodeHello, encodeSync, decodeSync,
  encodeCommit, decodeCommit, encodeDraw, decodeDraw,
  encodeReject, decodeReject, encodeEnd, decodeEnd,
  type SyncPayload, type SyncPlayer,
} from './netSync';
import { sound } from '../../core/sound';

const HELLO_RETRY_MS = 1_500;
const END_DELAY_MS = 1_600;

interface Seat {
  peerId: string;
  nickname: string;
  hand: Tile[];
  melded: boolean;
}

class RummikubModule implements GameModule {
  private ctx!: GameContext;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private destroyed = false;

  private renderer: RummikubRenderer | null = null;
  private rafId: number | null = null;

  /** 턴 제한 시간(초). 0 이면 무제한 */
  private turnLimitSec = 60;

  // --- 공개 상태 (게스트는 sync 로 통째 교체) ---
  private players: SyncPlayer[] = [];
  private turnPeerId: string | null = null;
  private table: TileSet[] = [];
  private myHand: Tile[] = [];
  private poolLeft = 0;
  private turnDeadline = 0;
  private news = '';

  private lastHelloAt = 0;
  private syncedOnce = false;

  // --- 호스트 전용 ---
  private seats: Seat[] = [];
  private pool: Tile[] = [];
  private turnIdx = 0;
  private gone = new Set<string>();
  /** 더미가 비었을 때 연속으로 넘긴 사람 수 — 전원이 넘기면 게임이 끝난다 */
  private passStreak = 0;
  private ended = false;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.turnLimitSec = parseTurnLimit(ctx.roomOptions['turnLimit']);

    this.renderer = new RummikubRenderer(ctx.canvas, {
      onCommit: (table) => this.submitCommit(table),
      onDraw: () => this.submitDraw(),
    });
    sound.startBgm('menu');

    if (this.isHost) {
      const order = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'));
      const deck = shuffle(buildDeck());
      this.seats = order.map((p) => ({
        peerId: p.peerId,
        nickname: p.nickname,
        hand: deck.splice(0, START_HAND),
        melded: false,
      }));
      this.pool = deck;
      // 선은 매판 무작위. 자리 순서는 그대로라 도는 방향은 같다
      this.turnIdx = randomStartIndex(this.seats.length);
      this.turnPeerId = this.seats[this.turnIdx]?.peerId ?? null;
      this.news = '첫 등록은 30점 이상이어야 해요';
      this.armTurn();
      this.broadcast();
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

    // 제한 시간이 끝나면 그 턴은 '한 장 가져가기' 로 닫는다 (고민하다 판이 멈추지 않게)
    if (this.isHost && !this.ended && this.turnDeadline > 0 && Date.now() >= this.turnDeadline) {
      const who = this.turnPeerId;
      if (who) { this.news = `${this.nameOf(who)} 님 시간이 다 됐어요`; this.handleDraw(who); }
    }

    this.renderer?.render({
      players: this.players,
      turnPeerId: this.turnPeerId,
      table: this.table,
      myHand: this.myHand,
      poolLeft: this.poolLeft,
      turnDeadline: this.turnDeadline,
      news: this.news,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
    });
    this.rafId = requestAnimationFrame(this.loop);
  };

  // ============================================
  // 입력
  // ============================================

  private isMyTurn(): boolean {
    return !this.isSpectator && this.turnPeerId === this.myPeerId;
  }

  private submitCommit(table: TileSet[]): void {
    if (!this.isMyTurn()) return;
    if (this.isHost) this.handleCommit(this.myPeerId, table);
    else this.ctx.sendToPeer(encodeCommit(this.myPeerId, table));
  }

  private submitDraw(): void {
    if (!this.isMyTurn()) return;
    if (this.isHost) this.handleDraw(this.myPeerId);
    else this.ctx.sendToPeer(encodeDraw(this.myPeerId));
  }

  // ============================================
  // 호스트 — 판정
  // ============================================

  private nameOf(peerId: string): string {
    return this.seats.find((s) => s.peerId === peerId)?.nickname ?? '';
  }

  private armTurn(): void {
    this.turnDeadline = this.turnLimitSec > 0 ? Date.now() + this.turnLimitSec * 1000 : 0;
  }

  private handleCommit(from: string, proposed: TileSet[]): void {
    if (this.ended || this.turnPeerId !== from) return;
    const seat = this.seats.find((s) => s.peerId === from);
    if (!seat) return;

    const verdict = validateCommit(this.table, proposed, seat.hand, !seat.melded);
    if (!verdict.ok) {
      if (from === this.myPeerId) this.renderer?.showReject(verdict.reason);
      else this.ctx.sendToPeer(encodeReject(verdict.reason), { target: from });
      return;
    }

    // 통과 — 손패에서 빼고 테이블을 보기 좋게 정리해서 확정
    const used = new Set(verdict.usedTileIds);
    seat.hand = seat.hand.filter((t) => !used.has(t.id));
    seat.melded = true;
    this.table = proposed.map((s) => normalizeSet(s));
    this.passStreak = 0;
    sound.play('pop');

    if (seat.hand.length === 0) { this.finish(seat.peerId); return; }
    this.news = `${seat.nickname} 님이 ${used.size}장 냈어요`;
    this.nextTurn();
  }

  private handleDraw(from: string): void {
    if (this.ended || this.turnPeerId !== from) return;
    const seat = this.seats.find((s) => s.peerId === from);
    if (!seat) return;

    const drawn = this.pool.pop();
    if (drawn) {
      seat.hand.push(drawn);
      this.news = `${seat.nickname} 님이 한 장 가져갔어요`;
      this.passStreak = 0;
    } else {
      // 더미가 비었으면 그냥 넘긴다. 전원이 연달아 넘기면 더 진행할 수 없다
      this.news = `${seat.nickname} 님이 넘겼어요 (더미 없음)`;
      this.passStreak += 1;
      if (this.passStreak >= this.activeSeats().length) { this.finish(null); return; }
    }
    this.nextTurn();
  }

  private activeSeats(): Seat[] {
    return this.seats.filter((s) => !this.gone.has(s.peerId));
  }

  private nextTurn(): void {
    const alive = this.activeSeats();
    if (alive.length === 0) { this.finish(null); return; }
    for (let step = 1; step <= this.seats.length; step++) {
      const i = (this.turnIdx + step) % this.seats.length;
      const s = this.seats[i]!;
      if (this.gone.has(s.peerId)) continue;
      this.turnIdx = i;
      this.turnPeerId = s.peerId;
      this.armTurn();
      this.broadcast();
      return;
    }
    this.finish(null);
  }

  /**
   * 사람마다 다른 sync. 손패는 받는 사람 것만 실물로 넣는다.
   * 관전자는 신 시점이라 전원 손패를 볼 수 있어야 하지만, 여기선 테이블만 보여준다
   * (손패까지 실시간으로 다 보내면 남의 턴 내내 큰 payload 가 오간다).
   */
  private syncFor(peerId: string): SyncPayload {
    const seat = this.seats.find((s) => s.peerId === peerId);
    return {
      players: this.seats.map((s) => ({
        peerId: s.peerId,
        nickname: s.nickname,
        handCount: s.hand.length,
        melded: s.melded,
        gone: this.gone.has(s.peerId),
      })),
      turnPeerId: this.turnPeerId,
      table: this.table,
      myHand: seat?.hand ?? [],
      poolLeft: this.pool.length,
      turnDeadline: this.turnDeadline,
      news: this.news,
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

  private finish(winnerId: string | null): void {
    if (this.ended) return;
    this.ended = true;
    this.turnPeerId = null;
    this.turnDeadline = 0;
    this.news = winnerId ? `${this.nameOf(winnerId)} 님이 손패를 다 냈어요!` : '더 낼 수 있는 사람이 없어요';
    this.broadcast();

    // 순위 — 남은 타일 벌점이 적은 순. 다 낸 사람은 0점이라 자동으로 1등
    const ranked = [...this.seats]
      .map((s) => ({ seat: s, penalty: handPenalty(s.hand) }))
      .sort((a, b) => a.penalty - b.penalty);
    const rankings = ranked.map((r, i) => ({
      peerId: r.seat.peerId,
      nickname: r.seat.nickname,
      rank: i + 1,
      left: r.seat.hand.length,
      penalty: r.penalty,
    }));

    const resultFor = (peerId: string): GameResult => {
      const mine = rankings.find((r) => r.peerId === peerId);
      return {
        winner: mine ? (mine.rank === 1 ? 'me' : 'opponent') : null,
        summary: {
          gameId: 'rummikub',
          myPeerId: peerId,
          rank: mine?.rank ?? 0,
          totalPlayers: rankings.length,
          myLeft: mine?.left ?? 0,
          myPenalty: mine?.penalty ?? 0,
          rankings,
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
    this.turnPeerId = s.turnPeerId;
    this.table = s.table;
    this.myHand = s.myHand;
    this.poolLeft = s.poolLeft;
    this.turnDeadline = s.turnDeadline;
    this.news = s.news;
    this.syncedOnce = true;
    this.renderer?.onNewState(s.turnPeerId === this.myPeerId);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    if (this.isHost) {
      const hello = decodeHello(msg);
      if (hello) { this.broadcast(); return; }
      const c = decodeCommit(msg);
      if (c) { this.handleCommit(c.from, c.table); return; }
      const d = decodeDraw(msg);
      if (d) { this.handleDraw(d.from); return; }
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
    const seat = this.seats.find((s) => s.peerId === peerId);
    if (seat) {
      // 나간 사람 손패는 더미로 돌려보낸다 — 안 그러면 그 타일들이 영영 사라진다
      this.pool.push(...seat.hand);
      this.pool = shuffle(this.pool);
      seat.hand = [];
      this.news = `${seat.nickname} 님이 나갔어요`;
    }
    if (this.activeSeats().length === 0) { this.finish(null); return; }
    if (this.turnPeerId === peerId) this.nextTurn();
    else this.broadcast();
  }
}

/** 방 옵션의 턴 제한 시간(초). '0' = 무제한 */
function parseTurnLimit(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

/** 좌석 순서 = 호스트 먼저, 나머지는 들어온 순서 */
function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.filter((p) => p.isHost);
  const rest = players.filter((p) => !p.isHost);
  return [...host, ...rest];
}

export function createRummikub(): GameModule {
  return new RummikubModule();
}
