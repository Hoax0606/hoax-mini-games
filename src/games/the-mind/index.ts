/**
 * 더 마인드 — 말 없이 작은 숫자부터 순서대로 내기 (협동)
 *
 * 호스트 authoritative. 호스트가 카드를 나눠주고 실수와 레벨 클리어를 판정한다.
 *
 * 이 게임은 **모두가 이기거나 모두가 진다**. 승패를 가르지 않으니
 * 결과도 전원 같은 걸 보낸다 (도달 레벨 / 남은 생명).
 *
 * 자기 카드만 보는 게 게임의 전부라서 sync 는 사람마다 다르게 보낸다.
 * 자세한 건 netSync 주석 참고.
 */

import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import {
  MAX_LIVES, MAX_STARS, parseGoal, startLives, bonusFor, dealCards,
  lowerCardsThan, isLevelClear, allWantStar, allReady, type MindPlayer,
} from './rules';
import { TheMindRenderer } from './render';
import {
  encodeHello, decodeHello, encodeSync, decodeSync,
  encodeReady, decodeReady, encodePlay, decodePlay, encodeStar, decodeStar,
  encodeEnd, decodeEnd, type Phase,
} from './netSync';
import { sound } from '../../core/sound';

/** 게스트가 hello 를 보내고 sync 가 안 오면 재시도하는 간격 */
const HELLO_RETRY_MS = 1_500;
const END_DELAY_MS = 1_800;
/** 레벨을 깼을 때 축하 표시를 띄워두는 시간 */
const LEVEL_CLEAR_MS = 1_600;
const LOG_KEEP = 5;
/** 화면에 보여줄 만큼만 들고 다닌다 */
const PILE_KEEP = 8;
const BURNED_KEEP = 10;

class TheMindModule implements GameModule {
  private ctx!: GameContext;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private destroyed = false;

  private renderer: TheMindRenderer | null = null;
  private rafId: number | null = null;

  // --- 공개 상태 (게스트는 sync 로 통째 교체) ---
  private phase: Phase = 'ready';
  private level = 1;
  private goal = 8;
  private lives = 2;
  private stars = 1;
  private players: MindPlayer[] = [];
  private pile: number[] = [];
  private burned: number[] = [];
  private log: string[] = [];

  private notice = '';
  private noticeUntil = 0;
  private lastHelloAt = 0;
  private syncedOnce = false;

  // --- 호스트 전용 ---
  private leftPeers = new Set<string>();
  private ended = false;
  /** 레벨 클리어 연출 중이면 입력을 받지 않는다 */
  private levelBreakUntil = 0;

  // ============================================
  // 수명주기
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.goal = parseGoal(ctx.roomOptions['goal']);

    this.renderer = new TheMindRenderer(ctx.canvas, {
      onReady: () => this.submitReady(),
      onPlay: (card) => this.submitPlay(card),
      onStar: (on) => this.submitStar(on),
    });
    sound.startBgm('apple-game');

    if (this.isHost) {
      const seats = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'));
      this.players = seats.map((p) => ({
        peerId: p.peerId, nickname: p.nickname,
        cards: [], left: 0, played: 0, wantsStar: false, ready: false,
      }));
      this.lives = startLives(this.players.length);
      this.stars = 1;
      this.startLevel(1);
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

    const me = this.players.find((p) => p.peerId === this.myPeerId) ?? null;
    this.renderer?.render({
      phase: this.phase,
      level: this.level, goal: this.goal, lives: this.lives, stars: this.stars,
      players: this.players,
      myCards: me?.cards ?? [],
      pile: this.pile, burned: this.burned, log: this.log,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      notice: this.notice,
    });
    this.rafId = requestAnimationFrame(this.loop);
  };

  // ============================================
  // 입력 (게스트는 호스트로 던지고, 호스트는 바로 처리)
  // ============================================

  private submitReady(): void {
    if (this.isSpectator || this.phase !== 'ready') return;
    if (this.isHost) this.handleReady(this.myPeerId);
    else this.ctx.sendToPeer(encodeReady(this.myPeerId));
  }

  private submitPlay(card: number): void {
    if (this.isSpectator || this.phase !== 'play') return;
    if (this.isHost) this.handlePlay(this.myPeerId, card);
    else this.ctx.sendToPeer(encodePlay(this.myPeerId, card));
  }

  private submitStar(on: boolean): void {
    if (this.isSpectator || this.phase !== 'play') return;
    if (this.isHost) this.handleStar(this.myPeerId, on);
    else this.ctx.sendToPeer(encodeStar(this.myPeerId, on));
  }

  private showNotice(text: string): void {
    this.notice = text;
    this.noticeUntil = performance.now() + 2_600;
  }

  // ============================================
  // 호스트 — 판정
  // ============================================

  private pushLog(line: string): void {
    this.log = [...this.log, line].slice(-LOG_KEEP);
  }

  /** 카드를 새로 나눠주고 준비 단계로. 레벨 시작은 전원이 준비를 눌러야 한다 */
  private startLevel(level: number): void {
    this.level = level;
    this.phase = 'ready';
    this.pile = [];
    this.burned = [];
    const hands = dealCards(this.players.length, level);
    this.players.forEach((p, i) => {
      p.cards = hands[i] ?? [];
      p.left = p.cards.length;
      p.wantsStar = false;
      // 이미 나간 사람까지 기다리면 레벨이 영영 안 시작된다
      p.ready = this.leftPeers.has(p.peerId);
    });
    this.pushLog(`레벨 ${level} — 한 사람당 ${level}장`);
    this.broadcastSync();
  }

  private handleReady(from: string): void {
    if (this.ended || this.phase !== 'ready') return;
    const p = this.players.find((x) => x.peerId === from);
    if (!p || p.ready) return;
    p.ready = true;
    if (allReady(this.players)) {
      this.phase = 'play';
      this.pushLog('시작! 작은 숫자부터, 말은 금지');
      sound.play('tetris_harddrop');
    }
    this.broadcastSync();
  }

  private handlePlay(from: string, card: number): void {
    if (this.ended || this.phase !== 'play') return;
    if (performance.now() < this.levelBreakUntil) return;
    const me = this.players.find((x) => x.peerId === from);
    if (!me || !me.cards.includes(card)) return;

    me.cards = me.cards.filter((c) => c !== card);
    me.left = me.cards.length;
    me.played++;

    // 이 카드보다 작은 걸 들고 있던 사람들 — 전부 날아간다
    const victims = lowerCardsThan(this.players, card);
    if (victims.length > 0) {
      const lost: number[] = [];
      for (const v of victims) {
        const p = this.players.find((x) => x.peerId === v.peerId)!;
        p.cards = p.cards.filter((c) => c >= card);
        p.left = p.cards.length;
        lost.push(...v.cards);
      }
      lost.sort((a, b) => a - b);
      this.lives--;
      this.burned = [...this.burned, ...lost].slice(-BURNED_KEEP);
      this.pushLog(`${me.nickname} 님이 ${card} — 더 작은 ${lost.join(', ')} 가 날아갔어요`);
      sound.play('tetris_topout');
      this.clearStarFlags();
    } else {
      this.pushLog(`${me.nickname} 님이 ${card}`);
      sound.play('tetris_lock');
    }

    this.pile = [...this.pile, card].slice(-PILE_KEEP);

    if (this.lives <= 0) { this.finishAsHost(false); return; }
    if (isLevelClear(this.players)) { this.clearLevel(); return; }
    this.broadcastSync();
  }

  /** 수리검 — 전원이 손들면 각자 최소 카드 한 장씩 공개하고 버린다 */
  private handleStar(from: string, on: boolean): void {
    if (this.ended || this.phase !== 'play') return;
    if (performance.now() < this.levelBreakUntil) return;
    if (this.stars <= 0) return;
    const me = this.players.find((x) => x.peerId === from);
    if (!me || me.left === 0) return;
    me.wantsStar = on;

    if (!allWantStar(this.players)) { this.broadcastSync(); return; }

    this.stars--;
    const thrown: number[] = [];
    for (const p of this.players) {
      const lowest = p.cards[0];
      if (lowest === undefined) continue;
      p.cards = p.cards.slice(1);
      p.left = p.cards.length;
      thrown.push(lowest);
    }
    thrown.sort((a, b) => a - b);
    this.burned = [...this.burned, ...thrown].slice(-BURNED_KEEP);
    this.clearStarFlags();
    this.pushLog(`수리검! ${thrown.join(', ')} 를 버렸어요`);
    sound.play('tetris_clear');

    if (isLevelClear(this.players)) { this.clearLevel(); return; }
    this.broadcastSync();
  }

  private clearStarFlags(): void {
    for (const p of this.players) p.wantsStar = false;
  }

  /** 레벨 클리어 — 보너스를 주고 잠깐 쉬었다가 다음 레벨 */
  private clearLevel(): void {
    const bonus = bonusFor(this.level);
    if (bonus.lives > 0) this.lives = Math.min(MAX_LIVES, this.lives + bonus.lives);
    if (bonus.stars > 0) this.stars = Math.min(MAX_STARS, this.stars + bonus.stars);
    const extra = [
      bonus.lives > 0 ? '생명 +1' : '',
      bonus.stars > 0 ? '수리검 +1' : '',
    ].filter(Boolean).join(' · ');
    this.pushLog(`레벨 ${this.level} 클리어!${extra ? ` (${extra})` : ''}`);
    sound.play('tetris_tetris');

    if (this.level >= this.goal) { this.finishAsHost(true); return; }

    this.levelBreakUntil = performance.now() + LEVEL_CLEAR_MS;
    this.broadcastSync();
    const next = this.level + 1;
    window.setTimeout(() => {
      if (this.destroyed || this.ended) return;
      this.startLevel(next);
    }, LEVEL_CLEAR_MS);
  }

  private broadcastSync(): void {
    // 받는 사람 카드만 채우고 나머지는 지운다 (전체 broadcast 하면 남의 숫자가 보인다)
    for (const target of this.players) {
      if (target.peerId === this.myPeerId) continue;
      const view = this.players.map((p) => (
        p.peerId === target.peerId ? p : { ...p, cards: [] }
      ));
      this.ctx.sendToPeer(encodeSync(this.snapshot(view)), { target: target.peerId });
    }
    // 관전자에게는 아무 카드도 안 보여준다 — 다 보이면 훈수가 된다
    const blind = this.players.map((p) => ({ ...p, cards: [] }));
    for (const p of this.ctx.players) {
      if (p.role !== 'spectator') continue;
      this.ctx.sendToPeer(encodeSync(this.snapshot(blind)), { target: p.peerId });
    }
  }

  private snapshot(players: MindPlayer[]): Parameters<typeof encodeSync>[0] {
    return {
      phase: this.phase, level: this.level, goal: this.goal,
      lives: this.lives, stars: this.stars,
      players, pile: this.pile, burned: this.burned, log: this.log,
    };
  }

  private finishAsHost(won: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.phase = 'done';
    this.pushLog(won ? `레벨 ${this.goal} 까지 전부 클리어!` : '생명을 다 썼어요…');
    this.broadcastSync();

    const rankings = [...this.players]
      .sort((a, b) => b.played - a.played)
      .map((p, i) => ({
        peerId: p.peerId, nickname: p.nickname, rank: i + 1, played: p.played,
      }));
    const result: GameResult = {
      // 협동이라 승패가 갈리지 않는다 — 다 같이 이기거나 다 같이 못 깬다
      winner: won ? 'me' : null,
      summary: {
        gameId: 'the-mind',
        won,
        level: won ? this.goal : this.level,
        goal: this.goal,
        lives: Math.max(0, this.lives),
        stars: this.stars,
        totalPlayers: rankings.length,
        rankings,
      },
    };

    window.setTimeout(() => {
      if (this.destroyed) return;
      for (const p of this.ctx.players) {
        if (p.peerId === this.myPeerId) continue;
        this.ctx.sendToPeer(encodeEnd({ ...result, summary: { ...result.summary, myPeerId: p.peerId } }),
          { target: p.peerId });
      }
      this.ctx.endGame({ ...result, summary: { ...result.summary, myPeerId: this.myPeerId } });
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
      const r = decodeReady(msg);
      if (r) { this.handleReady(r.from); return; }
      const p = decodePlay(msg);
      if (p) { this.handlePlay(p.from, p.card); return; }
      const s = decodeStar(msg);
      if (s) { this.handleStar(s.from, s.on); return; }
      return;
    }

    const sync = decodeSync(msg);
    if (sync) {
      const wasLives = this.lives;
      this.phase = sync.phase;
      this.level = sync.level;
      this.goal = sync.goal;
      this.lives = sync.lives;
      this.stars = sync.stars;
      this.players = sync.players;
      this.pile = sync.pile;
      this.burned = sync.burned;
      this.log = sync.log;
      this.syncedOnce = true;
      // 소리는 호스트가 안 보내준다 — 생명이 줄어든 걸 보고 각자 낸다
      if (this.lives < wasLives) sound.play('tetris_topout');
      return;
    }
    const end = decodeEnd(msg);
    if (end) { this.ctx.endGame(end); return; }
  }

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.ended) return;
    this.leftPeers.add(peerId);
    const idx = this.players.findIndex((x) => x.peerId === peerId);
    if (idx < 0) return;
    const gone = this.players[idx]!;
    // 나간 사람 카드는 테이블에서 치운다 — 영영 안 나올 카드를 기다릴 순 없다
    this.burned = [...this.burned, ...gone.cards].slice(-BURNED_KEEP);
    this.players.splice(idx, 1);
    this.pushLog(`${gone.nickname} 님이 나갔어요`);

    if (this.players.length === 0) { this.finishAsHost(false); return; }
    if (this.phase === 'ready' && allReady(this.players)) {
      this.phase = 'play';
      this.pushLog('시작! 작은 숫자부터, 말은 금지');
    }
    if (this.phase === 'play' && isLevelClear(this.players)) { this.clearLevel(); return; }
    this.broadcastSync();
  }
}

/** 호스트를 맨 앞에 두고 나머지는 들어온 순서 — 좌석 순서의 단일 출처 */
function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.filter((p) => p.isHost);
  const rest = players.filter((p) => !p.isHost);
  return [...host, ...rest];
}

export function createTheMind(): GameModule {
  return new TheMindModule();
}
