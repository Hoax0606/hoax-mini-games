/**
 * 블루마블 GameModule — 조립 + P2P(호스트 authoritative).
 *
 *   - 호스트가 유일한 진실(state). 주사위·황금열쇠 랜덤을 호스트만 굴리고 bm:sync 로 전파.
 *   - 현재 차례 플레이어(호스트/게스트)는 bm:act 로 행동을 호스트에 보냄. 호스트가 검증·적용 후 sync.
 *   - 렌더는 HTML DOM(캔버스 위에 오버레이). 결정은 state.pending + 내 차례 여부로 모달 표시.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  BOARD, CARDS, BUILD_TYPES, SALARY, DESERT_TURNS, buildCostOf, canBuild, acquireCost,
  tollFor, alivePeers, nextTurnIdx, createInitialState,
  type BMState, type BuildKind,
} from './rules';

/** 솔로(AlphaTest) 프리뷰용 더미 상대 peerId */
const DUMMY = '__preview_dummy__';
import {
  encodeHello, decodeHello, encodeSync, decodeSync,
  encodeAct, decodeAct, encodeEnd, decodeEnd, type BMAction,
} from './netSync';
import { BlueMarbleRenderer } from './render';

const END_DELAY_MS = 2600;

class BlueMarbleModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: BlueMarbleRenderer;
  private state!: BMState;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private destroyed = false;
  private ended = false;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    // 캔버스 숨기고 그 부모에 DOM 보드 마운트
    ctx.canvas.style.display = 'none';
    const parent = ctx.canvas.parentElement!;
    this.renderer = new BlueMarbleRenderer(parent, {
      onRoll: () => this.act({ kind: 'roll' }),
      onDecision: (accept) => this.act({ kind: 'decision', accept }),
      onBuild: (build) => this.act({ kind: 'build', build }),
      onBuildDone: () => this.act({ kind: 'endTurn' }),
      onCard: (keep) => this.act({ kind: 'card', keep }),
      onUseHeld: (cardId) => this.act({ kind: 'useHeld', cardId }),
    });
    sound.startBgm('apple-game');

    if (this.isHost) {
      const players = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'))
        .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));
      // 솔로(AlphaTest) 프리뷰 — 더미 상대 1명 추가(자동 진행)
      if (players.length === 1) players.push({ peerId: DUMMY, nickname: '연습 상대' });
      this.state = createInitialState(players);
      this.state.log = `${this.state.players[this.state.order[0]!]!.nickname}님부터 시작!`;
      this.afterChange();
    } else {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;
    const hello = decodeHello(msg);
    if (hello) { if (this.isHost) this.ctx.sendToPeer(encodeSync(this.state), { target: hello.peerId }); return; }

    const sync = decodeSync(msg);
    if (sync) { if (!this.isHost) { this.state = sync; this.render(); } return; }

    const act = decodeAct(msg);
    if (act) { if (this.isHost) this.hostHandle(act, act.by); return; }

    const end = decodeEnd(msg);
    if (end) { if (!this.isHost) this.scheduleEnd(end); return; }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.dummyTimer !== null) { window.clearTimeout(this.dummyTimer); this.dummyTimer = null; }
    this.renderer?.destroy();
    sound.stopBgm();
  }

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.destroyed || this.ended) return;
    const p = this.state.players[peerId];
    if (!p || p.bankrupt) return;
    // 이탈 = 파산 처리(턴에서 빠짐)
    const wasTheirTurn = this.state.order[this.state.turnIdx] === peerId;
    this.bankrupt(peerId);
    if (!this.ended && wasTheirTurn) { this.state.pending = null; this.advanceTurn(); }
    this.afterChange();
  }

  // ── 상태 변경 후: 동기화 + 렌더 + 더미 자동 진행 ──
  private afterChange(): void {
    this.sync();
    this.render();
    this.maybeAutoPlay();
  }

  private dummyTimer: number | null = null;
  /** 현재 차례가 더미면 잠시 후 자동 행동 예약 */
  private maybeAutoPlay(): void {
    if (!this.isHost || this.ended || this.dummyTimer !== null) return;
    if (this.state.order[this.state.turnIdx] !== DUMMY) return;
    this.dummyTimer = window.setTimeout(() => {
      this.dummyTimer = null;
      if (this.destroyed || this.ended) return;
      this.dummyAct();
    }, 950);
  }
  /** 더미의 한 스텝 (주사위/결정) — hostHandle 로 처리 */
  private dummyAct(): void {
    const s = this.state;
    if (s.order[s.turnIdx] !== DUMMY) return;
    const pend = s.pending;
    if (!pend) { this.hostHandle({ kind: 'roll', by: DUMMY }, DUMMY); return; }
    if (pend.kind === 'buy') this.hostHandle({ kind: 'decision', accept: Math.random() < 0.75, by: DUMMY }, DUMMY);
    else if (pend.kind === 'acquire') this.hostHandle({ kind: 'decision', accept: Math.random() < 0.35, by: DUMMY }, DUMMY);
    else if (pend.kind === 'card') this.hostHandle({ kind: 'card', keep: !!CARDS[pend.card]!.keep && Math.random() < 0.5, by: DUMMY }, DUMMY);
    else if (pend.kind === 'build') {
      const opt = BUILD_TYPES.find((bt) => canBuild(s, pend.tile, DUMMY, bt.kind));
      if (opt && Math.random() < 0.6) this.hostHandle({ kind: 'build', build: opt.kind, by: DUMMY }, DUMMY);
      else this.hostHandle({ kind: 'endTurn', by: DUMMY }, DUMMY);
    }
  }

  // ============================================
  // 행동 → 호스트로 (또는 호스트면 직접 처리)
  // ============================================
  private act(action: BMAction): void {
    if (this.isHost) this.hostHandle({ ...action, by: this.myPeerId }, this.myPeerId);
    else this.ctx.sendToPeer(encodeAct(action, this.myPeerId));
  }

  // ============================================
  // 호스트 처리
  // ============================================
  private hostHandle(action: BMAction & { by: string }, by: string): void {
    if (this.ended) return;
    const s = this.state;
    const cur = s.order[s.turnIdx];
    if (by !== cur || s.players[by]?.bankrupt) return; // 내 차례 아닌 사람 무시

    if (action.kind === 'useHeld') { this.useHeld(by, action.cardId); this.afterChange(); return; }

    if (action.kind === 'roll') {
      if (s.pending) return;
      this.rollAndMove(by);
    } else if (action.kind === 'decision') {
      if (s.pending?.kind === 'buy') { if (action.accept) this.doBuy(by, s.pending.tile); s.pending = null; this.endStep(by); }
      else if (s.pending?.kind === 'acquire') { if (action.accept) this.doAcquire(by, s.pending.tile); s.pending = null; this.endStep(by); }
    } else if (action.kind === 'build') {
      if (s.pending?.kind === 'build') this.doBuild(by, s.pending.tile, action.build); // 계속 pending
    } else if (action.kind === 'endTurn') {
      if (s.pending?.kind === 'build') { s.pending = null; this.endStep(by); }
    } else if (action.kind === 'card') {
      if (s.pending?.kind === 'card') { this.resolveCard(by, s.pending.card, action.keep); s.pending = null; this.endStep(by); }
    }
    this.afterChange();
  }

  private rollAndMove(peer: string): void {
    const s = this.state;
    const a = 1 + Math.floor(Math.random() * 6), b = 1 + Math.floor(Math.random() * 6);
    s.dice = [a, b];
    const p = s.players[peer]!;

    if (p.desertLeft > 0) {
      if (a === b) { p.desertLeft = 0; s.log = `${p.nickname} 무인도 탈출!`; this.move(peer, a + b); this.resolveLanding(peer); }
      else { p.desertLeft -= 1; s.doubles = 0; s.log = `${p.nickname} 무인도… (${p.desertLeft}턴 남음)`; this.advanceTurn(); }
      return;
    }
    if (a === b) s.doubles += 1; else s.doubles = 0;
    if (s.doubles >= 3) { s.doubles = 0; this.toDesert(peer); s.log = `${p.nickname} 더블 3연속 → 무인도!`; this.advanceTurn(); return; }
    s.log = `${p.nickname} · ${a}+${b}=${a + b}`;
    this.move(peer, a + b);
    this.resolveLanding(peer);
  }

  /** 칸 이동 + 출발 통과 시 월급·바퀴 */
  private move(peer: string, steps: number): void {
    const s = this.state;
    for (let k = 0; k < steps; k++) {
      s.pos[peer] = (s.pos[peer]! + 1) % BOARD.length;
      if (s.pos[peer] === 0) { s.players[peer]!.money += SALARY; s.players[peer]!.laps += 1; }
    }
  }

  /** 착지 처리 → 결정이 필요하면 pending 설정, 아니면 즉시 처리 후 턴 마무리 */
  private resolveLanding(peer: string): void {
    const s = this.state;
    const i = s.pos[peer]!;
    const t = BOARD[i];
    const p = s.players[peer]!;

    if (t.type === 'city' || t.type === 'island') {
      const o = s.owner[i];
      if (o === undefined) {
        if (p.money >= t.price) { s.pending = { kind: 'buy', tile: i }; this.render(); return; }
        s.log = `${t.name} — 살 돈이 부족해요`;
      } else if (o === peer) {
        if (t.type === 'city' && (['villa', 'house2', 'apt', 'landmark'] as BuildKind[]).some((k) => canBuild(s, i, peer, k))) {
          s.pending = { kind: 'build', tile: i }; this.render(); return;
        }
      } else {
        const toll = tollFor(s, i, peer);
        this.pay(peer, o, toll);
        s.log = `${t.name} 통행료 ${toll.toLocaleString()} → ${s.players[o]!.nickname}`;
        // 도시면 인수 기회(랜드마크·섬 제외)
        if (!p.bankrupt && t.type === 'city') {
          const cost = acquireCost(s, i);
          if (cost > 0 && p.money >= cost) { s.pending = { kind: 'acquire', tile: i, cost }; this.render(); return; }
        }
      }
    } else if (t.type === 'special') {
      if (t.kind === 'goldkey') {
        const card = Math.floor(Math.random() * CARDS.length);
        s.pending = { kind: 'card', card }; this.render(); return;
      } else if (t.kind === 'tax') { const amt = t.taxAmount ?? 100; this.pay(peer, null, amt); s.log = `${t.name} ${amt.toLocaleString()} 납부`; }
      else if (t.kind === 'concert') { this.pay(peer, null, 50); s.log = '콘서트 관람 ₩50'; }
    } else if (t.type === 'corner') {
      if (t.kind === 'start') { p.money += SALARY; s.log = '출발 도착! 월급'; }
      else if (t.kind === 'welfare') { p.money += s.fund; s.log = `사회복지기금 ${s.fund.toLocaleString()} 수령`; s.fund = 0; }
      else if (t.kind === 'desert') { this.toDesert(peer); s.log = `${p.nickname} 무인도에 갇힘`; }
      // space(우주여행): 기본판에선 이벤트 없음
    }
    this.endStep(peer);
  }

  /** 결정/착지 처리 끝 → 더블이면 재굴림(턴 유지), 아니면 다음 턴 */
  private endStep(peer: string): void {
    const s = this.state;
    if (this.ended) return;
    const dbl = s.dice && s.dice[0] === s.dice[1];
    if (dbl && !s.players[peer]!.bankrupt && s.players[peer]!.desertLeft === 0) { s.dice = null; s.log += ' · 더블! 한 번 더'; }
    else this.advanceTurn();
  }

  private advanceTurn(): void {
    const s = this.state;
    s.doubles = 0; s.pending = null; s.dice = null;
    s.turnIdx = nextTurnIdx(s);
  }

  // ── 개별 처리 ──
  private doBuy(peer: string, tile: number): void {
    const s = this.state; const t = BOARD[tile] as { price: number };
    s.players[peer]!.money -= t.price; s.owner[tile] = peer;
    if (BOARD[tile].type === 'city') s.builds[tile] = [];
    sound.play('pop');
  }
  private doBuild(peer: string, tile: number, kind: BuildKind): void {
    const s = this.state;
    if (!canBuild(s, tile, peer, kind)) return;
    s.players[peer]!.money -= buildCostOf(tile, kind);
    (s.builds[tile] ??= []).push(kind);
    sound.play('pop');
  }
  private doAcquire(peer: string, tile: number): void {
    const s = this.state; const cost = acquireCost(s, tile); if (cost < 0) return;
    const from = s.owner[tile]!;
    this.pay(peer, from, cost);
    s.owner[tile] = peer;
    sound.play('pop');
  }
  private resolveCard(peer: string, cardId: number, keep: boolean): void {
    const s = this.state; const c = CARDS[cardId]!;
    if (c.keep && keep) { (s.held[peer] ??= []).push(cardId); s.log = `황금열쇠 보관 · ${c.title}`; return; }
    this.applyCard(peer, cardId);
  }
  private useHeld(peer: string, cardId: number): void {
    const s = this.state; const arr = s.held[peer]; if (!arr) return;
    const idx = arr.indexOf(cardId); if (idx < 0) return;
    arr.splice(idx, 1);
    this.applyCard(peer, cardId);
    s.log = `보관 카드 사용 · ${CARDS[cardId]!.title}`;
  }
  private applyCard(peer: string, cardId: number): void {
    const s = this.state; const c = CARDS[cardId]!; const p = s.players[peer]!;
    if (c.money) { if (c.money < 0) this.pay(peer, null, -c.money); else p.money += c.money; }
    if (c.moveTo !== undefined) { if (c.pass && c.moveTo <= s.pos[peer]!) { p.money += SALARY; p.laps += 1; } s.pos[peer] = c.moveTo; }
    if (cardId === 7) p.desertLeft = 0; // 무인도 탈출권
    if (!c.money && !c.moveTo && cardId !== 7) s.log = `${c.title}`;
  }

  private toDesert(peer: string): void { this.state.players[peer]!.desertLeft = DESERT_TURNS; }

  /** from 이 amount 를 to(또는 기금)에게 지불. 부족하면 가진 만큼 내고 파산. */
  private pay(from: string, to: string | null, amount: number): void {
    const s = this.state; const p = s.players[from]!;
    const paid = Math.min(p.money, amount);
    p.money -= paid;
    if (to) s.players[to]!.money += paid; else s.fund += paid;
    if (amount > paid) this.bankrupt(from);
  }

  private bankrupt(peer: string): void {
    const s = this.state; const p = s.players[peer]; if (!p || p.bankrupt) return;
    p.bankrupt = true; p.money = 0;
    // 소유 부동산 반환(무주공산)
    for (const k of Object.keys(s.owner)) { if (s.owner[+k] === peer) { delete s.owner[+k]; delete s.builds[+k]; } }
    s.log = `${p.nickname} 파산!`;
    const alive = alivePeers(s);
    if (alive.length <= 1) {
      s.phase = 'ended';
      s.winnerPeerId = alive[0] ?? null;
      this.finishGame();
    }
  }

  private finishGame(): void {
    if (this.ended) return; this.ended = true;
    const s = this.state;
    const base: Record<string, unknown> = {
      gameId: 'blue-marble',
      winnerPeerId: s.winnerPeerId,
      players: s.order.map((pid) => ({ peerId: pid, nickname: s.players[pid]!.nickname, money: s.players[pid]!.money, bankrupt: s.players[pid]!.bankrupt })),
    };
    for (const pl of this.ctx.players) {
      const winner: GameResult['winner'] = pl.role === 'spectator' ? 'opponent' : (pl.peerId === s.winnerPeerId ? 'me' : 'opponent');
      const result: GameResult = { winner, summary: { ...base, myPeerId: pl.peerId } };
      if (pl.peerId === this.myPeerId) this.scheduleEnd(result);
      else this.ctx.sendToPeer(encodeEnd(result), { target: pl.peerId });
    }
  }

  private scheduleEnd(result: GameResult): void {
    this.ended = true;
    this.render();
    window.setTimeout(() => { if (!this.destroyed) this.ctx.endGame(result); }, END_DELAY_MS);
  }

  private sync(): void { if (this.isHost) this.ctx.sendToPeer(encodeSync(this.state)); }
  private render(): void {
    if (this.destroyed || !this.state) return;
    this.renderer.setLastState(this.state);
    this.renderer.render(this.state, this.myPeerId, this.isSpectator);
  }
}

function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

export function createBlueMarbleGame(): GameModule {
  return new BlueMarbleModule();
}
