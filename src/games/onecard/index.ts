/**
 * 원카드 GameModule — 호스트 authoritative.
 *
 * 호스트가 덱(뽑을더미)·버린더미·전원 손패를 단독 보관하고, 낼 카드 유효성·특수효과·턴을 처리한다.
 * 게스트는 공개 상태(oc:sync)와 자기 손패(oc:hand)만 받아 렌더하고, 낼카드/뽑기/패스 의사만 보낸다.
 * 호스트 본인의 플레이 입력은 네트워크를 거치지 않고 핸들러를 직접 호출한다.
 */

import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  buildDeck, shuffle, canPlay, isWild, isPlainNumber, advanceTurn,
  type Card, type Color, type CardKind,
} from './rules';
import {
  encodeHello, decodeHello, encodeSync, decodeSync, encodeHand, decodeHand,
  encodePlay, decodePlay, encodeDraw, decodeDraw, encodePass, decodePass,
  encodeEnd, decodeEnd, type OneCardPublic,
} from './netSync';
import { OneCardRenderer, type RenderState } from './render';

const HAND_START = 7;
const END_DELAY_MS = 1600;
const TURN_TIME_MS = 20_000; // 턴 제한시간 — 초과 시 자동 뽑고 넘김

class OneCardGame implements GameModule {
  private ctx!: GameContext;
  private renderer!: OneCardRenderer;

  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;

  // 게스트/공용 뷰
  private pub: OneCardPublic | null = null;
  private myHand: Card[] = [];
  private wildPickIndex = -1;
  private lastHelloAt = 0;

  // 호스트 비공개 상태
  private order: string[] = [];
  private playersMeta: Array<{ peerId: string; nickname: string }> = [];
  private deck: Card[] = [];
  private discard: Card[] = [];
  private hands = new Map<string, Card[]>();
  private activeColor: Color = 'r';
  private currentTurn = 0;
  private direction: 1 | -1 = 1;
  private finished: string[] = [];
  private phase: 'playing' | 'ended' = 'playing';
  private awaitingPostDraw = false;
  private lastAction = '';
  /** 누적 공격카드 벌칙(중첩) */
  private pendingDraw = 0;
  private pendingKind: 'draw2' | 'wild4' | null = null;
  /** 호스트: 현재 턴 시작 시각(제한시간 판정) */
  private turnStartedAt = 0;
  /** 표시용: 마지막으로 본 currentTurn + 그 로컬 시작 시각(각 클라 카운트다운) */
  private dispTurn = -1;
  private dispTurnStart = 0;

  private rafId: number | null = null;
  private destroyed = false;
  private endScheduled = false;
  private paused = false;

  // ============================================
  // GameModule
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    this.renderer = new OneCardRenderer(ctx.canvas);
    ctx.canvas.style.cursor = 'pointer';
    if (!this.isSpectator) ctx.canvas.addEventListener('mousedown', this.onDown);
    sound.startBgm('apple-game');

    if (this.isHost) {
      this.initHostGame();
      this.broadcastAll();
    } else {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
      this.lastHelloAt = performance.now();
    }
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    if (this.isHost) {
      const hello = decodeHello(msg);
      if (hello) {
        this.ctx.sendToPeer(encodeSync(this.buildPublic()), { target: hello.peerId });
        const hand = this.hands.get(hello.peerId);
        if (hand) this.ctx.sendToPeer(encodeHand(hand), { target: hello.peerId });
        return;
      }
      const play = decodePlay(msg);
      if (play) { this.handlePlay(play.from, play.card, play.chosenColor); return; }
      const draw = decodeDraw(msg);
      if (draw) { this.handleDraw(draw.from); return; }
      const pass = decodePass(msg);
      if (pass) { this.handlePass(pass.from); return; }
      return;
    }

    // 게스트
    const sync = decodeSync(msg);
    if (sync) { this.pub = sync; return; }
    const hand = decodeHand(msg);
    if (hand) { this.myHand = hand; return; }
    const end = decodeEnd(msg);
    if (end) { this.scheduleEnd(end); return; }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.ctx?.canvas?.removeEventListener('mousedown', this.onDown);
    this.renderer?.destroy();
    sound.stopBgm();
    if (this.ctx?.canvas) this.ctx.canvas.style.cursor = '';
  }

  private pauseStart = 0;
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.pauseStart = performance.now();
    else if (this.pauseStart > 0) {
      // 정지 동안 흐른 만큼 턴 제한시각을 밀어 재개 즉시 타임아웃 안 나게
      this.turnStartedAt += performance.now() - this.pauseStart;
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
    if (!this.isHost && !this.pub && now - this.lastHelloAt > 1500) {
      this.lastHelloAt = now;
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }
    // 호스트: 턴 제한시간 초과 감시
    if (this.isHost && this.phase === 'playing' && !this.paused
      && this.turnStartedAt > 0 && now - this.turnStartedAt > TURN_TIME_MS) {
      this.timeoutCurrent();
    }
    if (!this.pub) return; // 아직 상태 못 받음
    // 표시용 턴 카운트다운 — currentTurn 바뀌면 로컬 시계로 리셋(cross-clock 회피)
    if (this.pub.currentTurn !== this.dispTurn) { this.dispTurn = this.pub.currentTurn; this.dispTurnStart = now; }
    const turnRemainMs = this.pub.phase === 'playing' ? Math.max(0, this.pub.turnMs - (now - this.dispTurnStart)) : 0;
    const rs: RenderState = {
      pub: this.pub,
      myPeerId: this.myPeerId,
      myHand: this.myHand,
      isSpectator: this.isSpectator,
      wildPickIndex: this.wildPickIndex,
      turnRemainMs,
      now,
    };
    try { this.renderer.render(rs); } catch (err) { console.error('[onecard] render', err); }
  };

  // ============================================
  // 입력 (내 차례에만 유효)
  // ============================================

  private onDown = (e: MouseEvent): void => {
    if (this.paused || this.isSpectator || !this.pub || this.pub.phase !== 'playing') return;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const rs: RenderState = {
      pub: this.pub, myPeerId: this.myPeerId, myHand: this.myHand,
      isSpectator: false, wildPickIndex: this.wildPickIndex, turnRemainMs: 0, now: performance.now(),
    };
    const hit = this.renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top, rs);
    if (!hit) return;

    // 와일드 색 선택 중
    if (this.wildPickIndex >= 0) {
      if (hit.kind === 'color') {
        const card = this.myHand[this.wildPickIndex];
        const idx = this.wildPickIndex;
        this.wildPickIndex = -1;
        if (card) this.doPlay(card, hit.color);
        void idx;
      }
      return;
    }

    const myTurn = this.pub.order[this.pub.currentTurn] === this.myPeerId;
    if (!myTurn) return;

    const pending = this.pub.pendingDraw > 0;
    if (hit.kind === 'card') {
      const card = this.myHand[hit.index];
      if (!card) return;
      // 스택 중이면 같은 종류 공격카드로만 받아치기, 아니면 일반 유효성
      const playable = pending
        ? card.kind === this.pub.pendingKind
        : canPlay(card, this.pub.activeColor, this.pub.discardTop.kind);
      if (!playable) { sound.play('button_click'); return; }
      if (isWild(card)) { this.wildPickIndex = hit.index; return; } // 색 선택 오버레이
      this.doPlay(card);
    } else if (hit.kind === 'draw') {
      // 스택 중이면 뽑기 = 누적 벌칙 받기. 아니면 (이미 뽑았으면 패스 / 아니면 1장 뽑기)
      if (pending) this.doDraw();
      else if (this.pub.awaitingPostDraw) this.doPass();
      else this.doDraw();
    }
  };

  /** 호스트면 직접 처리, 게스트면 의사 전송 */
  private doPlay(card: Card, chosenColor?: Color): void {
    if (this.isHost) this.handlePlay(this.myPeerId, card, chosenColor);
    else this.ctx.sendToPeer(encodePlay({ from: this.myPeerId, card, chosenColor }));
  }
  private doDraw(): void {
    if (this.isHost) this.handleDraw(this.myPeerId);
    else this.ctx.sendToPeer(encodeDraw(this.myPeerId));
  }
  private doPass(): void {
    if (this.isHost) this.handlePass(this.myPeerId);
    else this.ctx.sendToPeer(encodePass(this.myPeerId));
  }

  // ============================================
  // 호스트 게임 로직
  // ============================================

  private initHostGame(): void {
    this.playersMeta = orderPlayersHostFirst(this.ctx.players.filter((p) => p.role === 'player'))
      .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));
    this.order = this.playersMeta.map((p) => p.peerId);
    this.deck = buildDeck();
    shuffle(this.deck);
    for (const pid of this.order) this.hands.set(pid, this.deck.splice(this.deck.length - HAND_START, HAND_START));
    // 첫 버린 카드 — 숫자 카드가 나올 때까지 (특수/와일드는 바닥으로)
    let first: Card | undefined;
    while (this.deck.length > 0) {
      const c = this.deck.pop()!;
      if (isPlainNumber(c)) { first = c; break; }
      this.deck.unshift(c);
    }
    this.discard = first ? [first] : [{ color: 'r', kind: '0' }];
    this.activeColor = (this.discard[0]!.color as Color);
    this.currentTurn = 0;
    this.direction = 1;
    this.finished = [];
    this.phase = 'playing';
    this.awaitingPostDraw = false;
    this.pendingDraw = 0;
    this.pendingKind = null;
    this.turnStartedAt = performance.now();
    this.lastAction = '';
  }

  /** 현재 턴 인덱스 설정 + 제한시간 리셋 */
  private setTurn(idx: number): void {
    this.currentTurn = idx;
    this.turnStartedAt = performance.now();
    this.awaitingPostDraw = false;
  }

  private curPeer(): string { return this.order[this.currentTurn]!; }
  private nick(pid: string): string { return this.playersMeta.find((p) => p.peerId === pid)?.nickname ?? '?'; }
  private topKind(): CardKind { return this.discard[this.discard.length - 1]!.kind; }
  private activeCount(): number {
    const set = new Set(this.finished);
    return this.order.filter((p) => !set.has(p)).length;
  }

  private handlePlay(from: string, card: Card, chosenColor?: Color): void {
    if (this.phase !== 'playing' || from !== this.curPeer()) return;
    const hand = this.hands.get(from);
    if (!hand) return;
    const idx = hand.findIndex((c) => c.color === card.color && c.kind === card.kind);
    if (idx < 0) return;
    const kind = card.kind;
    // 스택 진행 중이면 같은 종류 공격카드로만 받아치기 가능. 아니면 일반 유효성.
    if (this.pendingDraw > 0) {
      if (kind !== this.pendingKind) return;
    } else if (!canPlay(card, this.activeColor, this.topKind())) {
      return;
    }

    hand.splice(idx, 1);
    this.discard.push(card);
    this.activeColor = isWild(card) ? (chosenColor ?? 'r') : (card.color as Color);

    const set = new Set(this.finished);
    if (hand.length === 0 && !set.has(from)) { this.finished.push(from); set.add(from); }

    let steps = 1;
    if (kind === 'draw2' || kind === 'wild4') {
      // 스택 누적 — 즉시 뽑지 않고 다음 사람에게 넘김(받아치거나 뽑아야 함)
      this.pendingDraw += kind === 'draw2' ? 2 : 4;
      this.pendingKind = kind;
      this.lastAction = `${this.nick(from)} ${kind === 'draw2' ? '+2' : '+4'} (누적 ${this.pendingDraw}장!)`;
      steps = 1;
    } else if (kind === 'skip') {
      steps = 2; this.lastAction = `${this.nick(from)} 건너뛰기!`;
    } else if (kind === 'reverse') {
      this.direction = (this.direction * -1) as 1 | -1;
      steps = this.activeCount() <= 2 ? 2 : 1;
      this.lastAction = `${this.nick(from)} 방향 전환!`;
    } else {
      this.lastAction = `${this.nick(from)} 냄`;
    }

    this.setTurn(advanceTurn(this.order, this.currentTurn, this.direction, set, steps));
    this.checkEnd();
    this.broadcastAll();
  }

  private handleDraw(from: string): void {
    if (this.phase !== 'playing' || from !== this.curPeer()) return;
    const set = new Set(this.finished);
    // 스택 진행 중이면 = 누적 벌칙 전부 받고 턴 종료
    if (this.pendingDraw > 0) {
      this.drawCards(from, this.pendingDraw);
      this.lastAction = `${this.nick(from)} ${this.pendingDraw}장 받음!`;
      this.pendingDraw = 0;
      this.pendingKind = null;
      this.setTurn(advanceTurn(this.order, this.currentTurn, this.direction, set, 1));
      this.broadcastAll();
      return;
    }
    if (this.awaitingPostDraw) return;
    this.drawCards(from, 1);
    const hand = this.hands.get(from)!;
    const drawn = hand[hand.length - 1]!;
    if (canPlay(drawn, this.activeColor, this.topKind())) {
      this.awaitingPostDraw = true; // 턴 유지 — 낼지/패스할지
      this.lastAction = `${this.nick(from)} 카드 뽑음`;
    } else {
      this.setTurn(advanceTurn(this.order, this.currentTurn, this.direction, set, 1));
      this.lastAction = `${this.nick(from)} 뽑고 패스`;
    }
    this.broadcastAll();
  }

  private handlePass(from: string): void {
    if (this.phase !== 'playing' || from !== this.curPeer() || !this.awaitingPostDraw) return;
    const set = new Set(this.finished);
    this.setTurn(advanceTurn(this.order, this.currentTurn, this.direction, set, 1));
    this.lastAction = `${this.nick(from)} 패스`;
    this.broadcastAll();
  }

  /** 호스트: 턴 제한시간 초과 → 스택 있으면 받고, 없으면 1장 뽑고 무조건 넘김 */
  private timeoutCurrent(): void {
    const from = this.curPeer();
    const set = new Set(this.finished);
    if (this.pendingDraw > 0) {
      this.drawCards(from, this.pendingDraw);
      this.lastAction = `${this.nick(from)} 시간초과 — ${this.pendingDraw}장!`;
      this.pendingDraw = 0; this.pendingKind = null;
    } else {
      this.drawCards(from, 1);
      this.lastAction = `${this.nick(from)} 시간초과 — 1장`;
    }
    this.setTurn(advanceTurn(this.order, this.currentTurn, this.direction, set, 1));
    this.broadcastAll();
  }

  /** 뽑을더미에서 count 장 (비면 버린더미 맨위 제외하고 셔플해 보충) */
  private drawCards(peerId: string, count: number): void {
    const hand = this.hands.get(peerId);
    if (!hand) return;
    for (let i = 0; i < count; i++) {
      if (this.deck.length === 0) {
        if (this.discard.length <= 1) break; // 보충할 카드 없음
        const top = this.discard.pop()!;
        shuffle(this.discard);
        this.deck = this.discard;
        this.discard = [top];
      }
      const c = this.deck.pop();
      if (c) hand.push(c);
    }
  }

  private checkEnd(): void {
    if (this.activeCount() <= 1) {
      // 마지막 남은 1명도 finished 에 추가(꼴등) 후 종료
      const set = new Set(this.finished);
      const last = this.order.find((p) => !set.has(p));
      if (last) this.finished.push(last);
      this.phase = 'ended';
    }
  }

  private buildPublic(): OneCardPublic {
    const handCounts: Record<string, number> = {};
    for (const p of this.order) handCounts[p] = this.hands.get(p)?.length ?? 0;
    return {
      players: this.playersMeta,
      order: this.order,
      handCounts,
      discardTop: this.discard[this.discard.length - 1]!,
      activeColor: this.activeColor,
      currentTurn: this.currentTurn,
      direction: this.direction,
      drawPileCount: this.deck.length,
      finished: [...this.finished],
      phase: this.phase,
      awaitingPostDraw: this.awaitingPostDraw,
      pendingDraw: this.pendingDraw,
      pendingKind: this.pendingKind,
      turnMs: TURN_TIME_MS,
      lastAction: this.lastAction,
    };
  }

  /** 호스트: 공개상태 broadcast + 각자 손패 target 전송. 종료면 결과 처리. */
  private broadcastAll(): void {
    const pub = this.buildPublic();
    this.pub = pub;
    this.ctx.sendToPeer(encodeSync(pub));
    for (const pid of this.order) {
      const hand = this.hands.get(pid) ?? [];
      if (pid === this.myPeerId) this.myHand = hand;
      else this.ctx.sendToPeer(encodeHand(hand), { target: pid });
    }
    if (this.phase === 'playing') sound.play('pop');
    if (this.phase === 'ended') this.finishAsHost();
  }

  private finishAsHost(): void {
    if (this.endScheduled) return;
    const total = this.finished.length;
    const rankings = this.finished.map((peerId, i) => ({
      peerId, nickname: this.nick(peerId), rank: i + 1,
    }));
    const summaryFor = (peerId: string): Record<string, unknown> => ({
      gameId: 'onecard',
      myPeerId: peerId,
      rank: rankings.find((r) => r.peerId === peerId)?.rank ?? total,
      totalPlayers: total,
      rankings,
    });
    const winnerFor = (peerId: string): GameResult['winner'] =>
      (rankings.find((r) => r.peerId === peerId)?.rank === 1 ? 'me' : 'opponent');

    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      this.ctx.sendToPeer(
        encodeEnd({ winner: p.role === 'spectator' ? 'opponent' : winnerFor(p.peerId), summary: summaryFor(p.peerId) }),
        { target: p.peerId },
      );
    }
    sound.play('goal');
    this.scheduleEnd({ winner: winnerFor(this.myPeerId), summary: summaryFor(this.myPeerId) });
  }

  private scheduleEnd(result: GameResult): void {
    if (this.endScheduled) return;
    this.endScheduled = true;
    window.setTimeout(() => { if (!this.destroyed) this.ctx.endGame(result); }, END_DELAY_MS);
  }
}

function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

export function createOneCardGame(): GameModule {
  return new OneCardGame();
}
