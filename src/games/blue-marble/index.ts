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
  BOARD, CARDS, SALARY, DESERT_TURNS, DESERT_ESCAPE, TRAVEL_COST, BONUS_STAKE, OLYMPIC_MAX_MUL, buildCostOf, canBuild, hasAllHouses, acquireCost, sellRefund,
  tollBreakdown, alivePeers, nextTurnIdx, createInitialState, monopolyWin, drawCardId, topTollTile, SEOUL_TILE, DESERT_TILE, SPACE_TILE,
  resolveOrderRound, ORDER_MAX_ROUNDS, estateValue, totalAssets,
  type BMState, type BuildKind, type TollInfo,
} from './rules';

/** 솔로(AlphaTest) 프리뷰용 더미 상대 peerId */
const DUMMY = '__preview_dummy__';
import {
  encodeHello, decodeHello, encodeSync, decodeSync,
  encodeAct, decodeAct, encodeEnd, decodeEnd, type BMAction,
} from './netSync';
import { BlueMarbleRenderer } from './render';

const END_DELAY_MS = 3200;
/** 순서 확정 후 결과를 보여주는 시간 */
const ORDER_REVEAL_MS = 2600;
/** 이 시간 안 굴리면 호스트가 대신 굴려준다(한 명 때문에 방이 멈추지 않게) */
const ORDER_AUTOROLL_MS = 15000;
/** 채팅 치트 `/showmethemoney` 로 받는 금액 */
const CHEAT_MONEY = 200000;
/** 안내(info) 창이 떠 있는 시간 — 다른 사람도 "누가 왜 못 샀는지" 읽을 수 있어야 해서 넉넉히 */
const INFO_MS = 1900;

class BlueMarbleModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: BlueMarbleRenderer;
  private state!: BMState;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private destroyed = false;
  private ended = false;
  /** 원래 좌석 순서. s.order 는 순서 정하기 결과로 재정렬되므로 tiebreak 기준을 따로 들고 있는다 */
  private seatOrder: string[] = [];
  private orderTimer: number | null = null;
  private orderStartTimer: number | null = null;
  private orderRoundStartedAt = 0;
  private orderPendingKey = '';

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
      onOrderRoll: () => this.act({ kind: 'orderRoll' }),
      onDesertPay: () => this.act({ kind: 'desertPay' }),
      onDecision: (accept) => this.act({ kind: 'decision', accept }),
      onBuildConfirm: (builds) => this.act({ kind: 'build', builds }),
      onCard: (keep) => this.act({ kind: 'card', keep }),
      onUseHeld: (cardId) => this.act({ kind: 'useHeld', cardId }),
      onPickCity: (tile) => this.act({ kind: 'pickCity', tile }),
      onTravelTo: (tile) => this.act({ kind: 'travelTo', tile }),
      onEventOk: () => this.act({ kind: 'eventOk' }),
      onBonusStart: (stake) => this.act({ kind: 'bonusStart', stake }),
      onBonusPick: (choice) => this.act({ kind: 'bonusPick', choice }),
      onBonusStop: () => this.act({ kind: 'bonusStop' }),
      onSell: (tile) => this.act({ kind: 'sell', tile }),
      onPayDebt: () => this.act({ kind: 'payDebt' }),
      onGiveUp: () => this.act({ kind: 'giveUp' }),
      onSettled: () => this.maybeAutoPlay(),  // 애니 끝난 뒤 더미 진행
    });
    sound.startBgm('apple-game');

    if (this.isHost) {
      const players = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'))
        .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));
      // 솔로(AlphaTest) 프리뷰 — 더미 상대 1명 추가(자동 진행)
      if (players.length === 1) players.push({ peerId: DUMMY, nickname: '연습 상대' });
      this.state = createInitialState(players);
      this.seatOrder = this.state.order.slice();
      this.state.log = '주사위를 굴려 순서를 정해요';
      // 순서 정하기 진행 감시(안 굴리는 사람 대신 굴리기 + 더미 자동)
      this.orderTimer = window.setInterval(() => this.tickOrderPhase(), 500);
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
    if (this.infoTimer !== null) { window.clearTimeout(this.infoTimer); this.infoTimer = null; }
    if (this.orderTimer !== null) { window.clearInterval(this.orderTimer); this.orderTimer = null; }
    if (this.orderStartTimer !== null) { window.clearTimeout(this.orderStartTimer); this.orderStartTimer = null; }
    this.renderer?.destroy();
    sound.stopBgm();
  }

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.destroyed || this.ended) return;
    const s = this.state;
    const p = s.players[peerId];
    if (!p || p.bankrupt) return;

    // 순서 정하기 중이면 굴림 대기에서 빼고 계속 (안 그러면 안 오는 사람을 계속 기다림)
    if (s.phase === 'order') {
      const i = s.orderPending.indexOf(peerId);
      if (i >= 0) s.orderPending.splice(i, 1);
      this.bankrupt(peerId);
      if (!this.ended && s.orderPending.length === 0 && s.phase === 'order') this.finishOrderRound();
      this.afterChange();
      return;
    }

    // 이탈 = 파산 처리(턴에서 빠짐)
    const wasTheirTurn = s.order[s.turnIdx] === peerId;
    // 나간 사람이 빚 갚는 중이었으면 그 대기를 풀고 큐를 이어간다 (안 그러면 아무도 못 누르고 멈춤)
    const wasDebtor = s.pending?.kind === 'raiseFunds' && s.pending.debtor === peerId;
    this.bankrupt(peerId);
    if (this.ended) { this.afterChange(); return; }
    if (wasDebtor) s.pending = null;
    if (wasTheirTurn) {
      // 나간 사람이 차례 주인 → 그 턴에 딸린 빚(생일 축하 등)은 받을 사람이 없으니 통째로 버린다
      s.pending = null; s.debtQueue = [];
      this.advanceTurn();
    } else {
      s.debtQueue = s.debtQueue.filter((d) => d.from !== peerId);
      if (wasDebtor && this.processDebts() && !this.ended) this.endStep(s.order[s.turnIdx]!);
    }
    this.afterChange();
  }

  /** 직전 afterChange 시점의 플레이어별 현금 (증감 뱃지 diff용) */
  private moneySnap: Record<string, number> = {};

  /**
   * 직전 스냅샷 대비 현금 증감을 모아 moneyFx 로 실어보낸다.
   * 통행료·카드·세금·월급·구매·건설·판매까지 경로를 안 가리고 전부 잡히므로,
   * 돈이 움직이는 곳마다 연출 코드를 심을 필요가 없다.
   */
  private diffMoney(): void {
    const s = this.state;
    const deltas: Record<string, number> = {};
    let any = false;
    for (const pid of s.order) {
      const now = s.players[pid]?.money ?? 0;
      const before = this.moneySnap[pid];
      if (before !== undefined && now !== before) { deltas[pid] = now - before; any = true; }
      this.moneySnap[pid] = now;
    }
    if (any) s.moneyFx = { seq: (s.moneyFx?.seq ?? 0) + 1, deltas };
  }

  // ── 상태 변경 후: 동기화 + 렌더 + 더미 자동 진행 ──
  private afterChange(): void {
    this.diffMoney();
    this.sync();
    this.render();
    // 더미 자동진행은 render()의 onSettled(애니 완료 후)에서만 트리거 — 여기서 직접 호출 X
  }

  private dummyTimer: number | null = null;
  /** 안내(info) 자동 넘김 타이머 */
  private infoTimer: number | null = null;
  /** 현재 차례가 더미면 잠시 후 자동 행동 예약 + 안내(info) pending 자동 넘김 */
  private maybeAutoPlay(): void {
    if (!this.isHost || this.ended) return;
    const s = this.state;
    // 안내(돈 부족 등) → 잠깐 보여준 뒤 자동으로 턴 마무리
    if (s.pending?.kind === 'info') {
      if (this.infoTimer === null) this.infoTimer = window.setTimeout(() => {
        this.infoTimer = null;
        if (this.destroyed || this.ended) return;
        const peer = this.state.order[this.state.turnIdx]!;
        this.state.pending = null;
        this.endStep(peer);      // 더블이면 재굴림, 아니면 다음 턴
        this.afterChange();
      }, INFO_MS);
      return;
    }
    if (this.dummyTimer !== null) return;
    if (!this.dummyActs()) return;
    this.dummyTimer = window.setTimeout(() => {
      this.dummyTimer = null;
      if (this.destroyed || this.ended) return;
      this.dummyAct();
    }, 600);
  }
  /** 지금 더미가 움직여야 하나? 자기 차례이거나, 남의 턴이어도 자기가 빚을 갚아야 할 때 */
  private dummyActs(): boolean {
    const s = this.state;
    if (s.phase !== 'playing') return false;
    if (s.pending?.kind === 'raiseFunds') return s.pending.debtor === DUMMY;
    return s.order[s.turnIdx] === DUMMY;
  }
  /** 더미의 한 스텝 (주사위/결정) — hostHandle 로 처리 */
  private dummyAct(): void {
    const s = this.state;
    if (!this.dummyActs()) return;
    const pend = s.pending;
    if (!pend) { this.hostHandle({ kind: 'roll', by: DUMMY }, DUMMY); return; }
    if (pend.kind === 'travelOffer') this.hostHandle({ kind: 'decision', accept: s.players[DUMMY]!.money >= pend.cost * 10, by: DUMMY }, DUMMY);
    else if (pend.kind === 'buy') this.hostHandle({ kind: 'decision', accept: Math.random() < 0.75, by: DUMMY }, DUMMY);
    else if (pend.kind === 'acquire') this.hostHandle({ kind: 'decision', accept: Math.random() < 0.35, by: DUMMY }, DUMMY);
    else if (pend.kind === 'tollAsk') this.hostHandle({ kind: 'decision', accept: true, by: DUMMY }, DUMMY);
    else if (pend.kind === 'card') this.hostHandle({ kind: 'card', keep: false, by: DUMMY }, DUMMY);
    else if (pend.kind === 'build') {
      const picks = (['villa', 'house2', 'apt'] as BuildKind[]).filter((k) => canBuild(s, pend.tile, DUMMY, k));
      this.hostHandle({ kind: 'build', builds: picks.length ? [picks[0]!] : [], by: DUMMY }, DUMMY);
    }
    else if (pend.kind === 'olympic' || pend.kind === 'startBuild') {
      const cities = pend.kind === 'olympic' ? this.ownedCities(DUMMY) : this.ownedCities(DUMMY).filter((i) => this.cityBuildable(DUMMY, i));
      if (cities.length) this.hostHandle({ kind: 'pickCity', tile: cities[0]!, by: DUMMY }, DUMMY);
      else { s.pending = null; this.endStep(DUMMY); this.afterChange(); }   // 개최/건설할 도시 없음
    }
    else if (pend.kind === 'travel') {
      // 아무 빈 도시(없으면 아무 칸)로 이동
      const empty = BOARD.map((t, i) => (t.type === 'city' && s.owner[i] === undefined ? i : -1)).filter((i) => i >= 0);
      const dest = empty.length ? empty[Math.floor(Math.random() * empty.length)]! : Math.floor(Math.random() * BOARD.length);
      this.hostHandle({ kind: 'travelTo', tile: dest, by: DUMMY }, DUMMY);
    }
    else if (pend.kind === 'event') { this.hostHandle({ kind: 'eventOk', by: DUMMY }, DUMMY); }
    else if (pend.kind === 'raiseFunds') {
      if (s.players[DUMMY]!.money >= pend.amount) this.hostHandle({ kind: 'payDebt', by: DUMMY }, DUMMY);
      else {
        const mine = Object.keys(s.owner).map(Number).filter((i) => s.owner[i] === DUMMY);
        if (mine.length) this.hostHandle({ kind: 'sell', tile: mine[0]!, by: DUMMY }, DUMMY);
        else this.hostHandle({ kind: 'giveUp', by: DUMMY }, DUMMY);
      }
    }
    else if (pend.kind === 'cardSwapMine') { const c = this.ownedCities(DUMMY); this.hostHandle({ kind: 'pickCity', tile: c[0] ?? -1, by: DUMMY }, DUMMY); }
    else if (pend.kind === 'cardSwapTheirs' || pend.kind === 'cardBlackout') { const t = this.opponentCities(DUMMY); this.hostHandle({ kind: 'pickCity', tile: t[0] ?? -1, by: DUMMY }, DUMMY); }
    else if (pend.kind === 'cardQuake') { const t = this.opponentCities(DUMMY).filter((i) => (this.state.builds[i]?.length ?? 0) > 0); this.hostHandle({ kind: 'pickCity', tile: t[0] ?? -1, by: DUMMY }, DUMMY); }
    else if (pend.kind === 'bonusOffer') {
      const opts = [0, 100000, 200000, 300000].filter((v) => v === 0 || s.players[DUMMY]!.money >= v);
      this.hostHandle({ kind: 'bonusStart', stake: opts[Math.floor(Math.random() * opts.length)]!, by: DUMMY }, DUMMY);
    }
    else if (pend.kind === 'bonus') {
      if (pend.round >= 1 && Math.random() < 0.5) this.hostHandle({ kind: 'bonusStop', by: DUMMY }, DUMMY);
      else this.hostHandle({ kind: 'bonusPick', choice: Math.floor(Math.random() * 2), by: DUMMY }, DUMMY);
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
    if (s.players[by]?.bankrupt) return;

    // 치트 — 차례/페이즈 상관없이 바로 적용. 로그도 뱃지도 없이 조용히 올린다.
    // diffMoney 가 스냅샷 대비 증감으로 뱃지를 띄우므로, 스냅샷도 같이 올려서
    // 이번 변화를 "이미 반영된 것"으로 만들어 +₩ 뱃지가 안 뜨게 한다.
    if (action.kind === 'cheatMoney') {
      const p = s.players[by];
      if (p) {
        p.money += CHEAT_MONEY;
        this.moneySnap[by] = p.money;
        this.afterChange();
      }
      return;
    }

    // 순서 정하기 단계에선 굴림만 받는다
    if (s.phase === 'order') {
      if (action.kind === 'orderRoll') this.doOrderRoll(by);
      return;
    }
    if (action.kind === 'orderRoll') return;

    const cur = s.order[s.turnIdx];
    // 자금 마련 중인 채무자는 차례가 아니어도 땅 팔기/지불/파산만은 할 수 있다(생일 축하 등)
    const rf = s.pending?.kind === 'raiseFunds' ? s.pending : null;
    const asDebtor = rf !== null && by === rf.debtor
      && (action.kind === 'sell' || action.kind === 'payDebt' || action.kind === 'giveUp');
    if (!asDebtor && by !== cur) return;   // 내 차례 아닌 사람 무시
    // 차례인 사람이라도 남이 빚 갚는 중이면 끼어들 수 없다
    if (rf !== null && rf.debtor !== by) return;

    if (action.kind === 'useHeld') { if (!s.pending) { this.useHeld(by, action.cardId); this.afterChange(); } return; }

    if (action.kind === 'desertPay') {
      // 무인도: 돈 내고 즉시 탈출 (턴 유지 → 이어서 주사위 굴림)
      const p = s.players[by]!;
      if (!s.pending && p.desertLeft > 0 && p.money >= DESERT_ESCAPE) {
        p.money -= DESERT_ESCAPE; p.desertLeft = 0;
        s.log = `${p.nickname} ₩${DESERT_ESCAPE.toLocaleString()} 내고 무인도 탈출!`;
      }
      this.afterChange(); return;
    }

    if (action.kind === 'roll') {
      if (s.pending) return;
      this.rollAndMove(by);
    } else if (action.kind === 'decision') {
      if (s.pending?.kind === 'buy') {
        if (action.accept) {
          const tile = s.pending.tile;
          this.doBuy(by, tile);
          if (this.ended) { this.afterChange(); return; }   // 구매로 독점 즉시승 달성
          // 부루마블처럼 구매 직후 바로 건물 짓기 — 지을 수 있는 게 있으면 build 창으로 이어감
          const buildable = (['villa', 'house2', 'apt', 'landmark'] as BuildKind[]).some((k) => canBuild(s, tile, by, k));
          if (BOARD[tile].type === 'city' && buildable) { s.pending = { kind: 'build', tile }; this.afterChange(); return; }
        }
        s.pending = null; this.endStep(by);
      }
      else if (s.pending?.kind === 'travelOffer') {
        // 세계여행 갈지 말지 — 가면 비용 내고 목적지 선택(그게 이번 턴의 이동),
        // 안 가면 그냥 평범하게 주사위를 굴린다.
        const cost = s.pending.cost;
        s.pending = null;
        if (action.accept && s.players[by]!.money >= cost) {
          this.pay(by, null, cost);
          s.pending = { kind: 'travel' };
          s.log = `세계여행 ₩${cost.toLocaleString()} 지불 — 원하는 칸을 고르세요`;
        } else {
          s.log = '세계여행 안 가기 — 주사위를 굴리세요';
        }
      }
      else if (s.pending?.kind === 'tollAsk') {
        // 통행료 면제권 쓸지 답변 — 쓰면 카드 소모 후 통행료 0, 안 쓰면 그대로 정산
        const { tile, to, card } = s.pending;
        s.pending = null;
        const held = s.held[by];
        const idx = held ? held.indexOf(card) : -1;
        const exempt = action.accept && held !== undefined && idx >= 0;
        if (exempt) held!.splice(idx, 1);
        if (!this.settleToll(by, tile, to, tollBreakdown(s, tile, by), exempt)) this.endStep(by);
      }
      else if (s.pending?.kind === 'acquire') {
        if (action.accept) {
          const tile = s.pending.tile;
          this.doAcquire(by, tile);
          if (this.ended) { this.afterChange(); return; }   // 인수로 독점 즉시승
          // 인수 직후에도 지을 수 있으면 건설창으로 이어감 (구매와 동일)
          const buildable = (['villa', 'house2', 'apt', 'landmark'] as BuildKind[]).some((k) => canBuild(s, tile, by, k));
          if (BOARD[tile].type === 'city' && buildable) { s.pending = { kind: 'build', tile }; this.afterChange(); return; }
        }
        s.pending = null; this.endStep(by);
      }
    } else if (action.kind === 'build') {
      if (s.pending?.kind === 'build') {
        const tile = s.pending.tile;
        // 랜드마크는 별장·빌딩·호텔이 "이 창에 오기 전부터" 지어져 있어야 한다.
        // canBuild 는 현재 s.builds 만 보므로, 한 루프로 돌리면 방금 지은 3건물이 선행조건을 채워
        // 땅 구매~랜드마크가 한 턴에 끝나버린다 → 시작 시점 상태(before)로 따로 검사.
        const before = [...(s.builds[tile] ?? [])];
        for (const k of ['villa', 'house2', 'apt'] as BuildKind[]) {
          if (action.builds.includes(k) && canBuild(s, tile, by, k)) this.doBuild(by, tile, k);
        }
        if (action.builds.includes('landmark') && hasAllHouses(before) && canBuild(s, tile, by, 'landmark')) {
          this.doBuild(by, tile, 'landmark');
        }
        s.pending = null; this.endStep(by);   // 완료 → 턴 마무리
      }
    } else if (action.kind === 'card') {
      if (s.pending?.kind === 'card') { const card = s.pending.card; s.pending = null; this.applyCard(by, card); }
    } else if (action.kind === 'pickCity') {
      if (s.pending?.kind === 'olympic') {
        const free = s.pending.free; this.doOlympic(by, action.tile); s.pending = null;
        if (!free) this.endStep(by);   // 카드로 개최한 free는 턴 안 넘김
      } else if (s.pending?.kind === 'startBuild') {
        if (s.owner[action.tile] === by && BOARD[action.tile].type === 'city' && this.cityBuildable(by, action.tile)) {
          s.pending = { kind: 'build', tile: action.tile };   // 추가 건설 → 건설 메뉴
        } else { s.pending = null; this.endStep(by); }
      } else if (s.pending?.kind === 'cardSwapMine') {
        if (s.owner[action.tile] === by && BOARD[action.tile].type === 'city') s.pending = { kind: 'cardSwapTheirs', mine: action.tile };
        else { s.pending = null; this.endStep(by); }
      } else if (s.pending?.kind === 'cardSwapTheirs') {
        const mine = s.pending.mine, their = action.tile, from = s.owner[their];
        if (from !== undefined && from !== by && BOARD[their].type === 'city') {
          s.owner[mine] = from; s.owner[their] = by;
          s.log = `${BOARD[mine].name} ↔ ${BOARD[their].name} 교환!`; sound.play('pop');
          this.cardFxEvt('swap', { tile: mine, tile2: their });
        }
        s.pending = null; this.checkMonopolyWin(by); if (!this.ended) this.endStep(by);
      } else if (s.pending?.kind === 'cardQuake') {
        const tile = action.tile, arr = s.builds[tile];
        if (s.owner[tile] !== undefined && s.owner[tile] !== by && arr && arr.length) {
          const top = (['landmark', 'apt', 'house2', 'villa'] as BuildKind[]).find((k) => arr.includes(k));
          if (top) { arr.splice(arr.indexOf(top), 1); s.log = `${BOARD[tile].name} 건물 1단계 파괴!`; sound.play('pop'); this.cardFxEvt('quake', { tile }); }
        }
        s.pending = null; this.endStep(by);
      } else if (s.pending?.kind === 'cardBlackout') {
        const tile = action.tile;
        if (s.owner[tile] !== undefined && s.owner[tile] !== by && BOARD[tile].type === 'city') { s.blackout[tile] = 3; s.log = `${BOARD[tile].name} 정전! 3턴 통행료 0`; sound.play('pop'); }
        s.pending = null; this.endStep(by);
      }
    } else if (action.kind === 'travelTo') {
      if (s.pending?.kind === 'travel') {
        const from = s.pos[by]!;
        const to = action.tile;
        s.pending = null; s.pos[by] = to;
        // 세계여행도 "앞으로 날아가는" 것으로 취급 → 출발선을 넘으면 걸어간 것과 똑같이 월급·바퀴 인정.
        // to <= from 이면 31번 칸을 지나 0번(출발)을 넘어간 것. to===0 은 출발에 "도착"이라
        // 월급을 resolveLanding 이 주므로 여기선 바퀴만 올린다.
        // 월급 팝업은 여기서 s.fx 로 띄우지 않는다 — 곧바로 부르는 resolveLanding 이
        // 통행료 fx 로 덮어쓰는데, 그 동안 렌더러는 비행 애니로 busy 라 월급 fx 를 소비하지 못하고
        // 그냥 사라졌다. 주사위 이동과 마찬가지로 **말이 출발 칸을 지나는 순간 렌더러가** 띄운다.
        if (to <= from) {
          s.players[by]!.laps += 1;
          if (to !== 0) s.players[by]!.money += SALARY;
        }
        s.travelFx = { seq: (s.travelFx?.seq ?? 0) + 1, by, from, to };
        this.sync(); this.render();   // 비행기 애니 트리거
        this.resolveLanding(by);
      }
    } else if (action.kind === 'bonusStart') {
      if (s.pending?.kind === 'bonusOffer') {
        const stake = action.stake;
        if (stake > 0 && s.players[by]!.money >= stake) {
          s.players[by]!.money -= stake;
          s.pending = { kind: 'bonus', stake, round: 0, pot: stake };
          s.log = `보너스 게임 시작! 판돈 ₩${stake.toLocaleString()}`;
        } else { s.pending = null; this.endStep(by); }   // 안 함
      }
    } else if (action.kind === 'bonusPick') {
      if (s.pending?.kind === 'bonus') this.doBonusPick(by, action.choice);
    } else if (action.kind === 'bonusStop') {
      if (s.pending?.kind === 'bonus') this.doBonusStop(by);
    } else if (action.kind === 'eventOk') {
      if (s.pending?.kind === 'event') {
        const ev = s.pending; s.pending = null;
        // 세금 낼 돈 부족 + 팔 땅 있으면 → 마련 페이즈, 아니면 납부(파산 가능)
        if (s.players[by]!.money < ev.amount && this.hasSellable(by)) {
          s.pending = { kind: 'raiseFunds', debtor: by, to: null, amount: ev.amount, toFund: true };
          s.log = `세금 ₩${ev.amount.toLocaleString()} — 낼 현금이 부족해요. 땅을 파세요`;
        } else {
          this.pay(by, null, ev.amount, true);   // 세금 → 사회복지기금 적립
          s.log = `${BOARD[ev.tile].name} · ₩${ev.amount.toLocaleString()} 납부`;
          this.endStep(by);
        }
      }
    } else if (action.kind === 'sell') {
      // 내 땅 판매 — 내 소유이고, 자유(대기 없음) 또는 내가 갚아야 하는 자금 마련 중일 때
      const rf = s.pending;
      if (s.owner[action.tile] === by && (rf === null || (rf.kind === 'raiseFunds' && rf.debtor === by))) {
        this.doSell(by, action.tile);
      }
    } else if (action.kind === 'payDebt') {
      if (s.pending?.kind === 'raiseFunds' && s.pending.debtor === by && s.players[by]!.money >= s.pending.amount) {
        const { to, amount, toFund } = s.pending;
        s.pending = null;
        this.pay(by, to, amount, toFund);
        this.settleDebtStep();
      }
    } else if (action.kind === 'giveUp') {
      if (s.pending?.kind === 'raiseFunds' && s.pending.debtor === by) {
        const { to, amount, toFund } = s.pending;
        s.pending = null;
        // 파산해도 가진 돈은 전부 받을 사람(to=null 인 세금이면 기금)에게 넘어간다.
        // 예전엔 bankrupt() 를 바로 불러서 p.money=0 으로 지워버려 남은 현금이 소멸했음.
        // pay() 가 min(보유, 청구)만큼 넘기고 그래도 부족하면 파산 처리까지 해준다.
        this.pay(by, to, amount, toFund);
        this.settleDebtStep();
      }
    }
    this.afterChange();
  }

  private ownedCities(peer: string): number[] {
    const s = this.state;
    return Object.keys(s.owner).map(Number).filter((i) => s.owner[i] === peer && BOARD[i].type === 'city');
  }
  private opponentCities(peer: string): number[] {
    const s = this.state;
    return Object.keys(s.owner).map(Number).filter((i) => s.owner[i] !== undefined && s.owner[i] !== peer && BOARD[i].type === 'city');
  }
  /** 이 플레이어가 팔 수 있는 땅(도시/섬)을 하나라도 가졌는지 */
  private hasSellable(peer: string): boolean {
    return Object.keys(this.state.owner).some((k) => this.state.owner[+k] === peer);
  }

  /** 채팅창 치트 코드 (채팅 로그엔 안 남는다 — gameScreen 이 걸러서 여기로만 보냄) */
  onCheatCode(code: string): void {
    if (this.destroyed || this.ended || code !== 'showmethemoney') return;
    this.act({ kind: 'cheatMoney' });
  }

  // ============================================
  // 순서 정하기 (게임 시작 전 전원 주사위)
  // ============================================

  /** 한 사람 굴림. 전원 다 굴리면 라운드 정산 */
  private doOrderRoll(peer: string): void {
    const s = this.state;
    const i = s.orderPending.indexOf(peer);
    if (i < 0) return;                       // 이미 굴렸음 (재전송 멱등)
    s.orderPending.splice(i, 1);
    const dice: [number, number] = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
    (s.orderRolls[peer] ??= []).push(dice[0] + dice[1]);
    (s.orderDice[peer] ??= []).push(dice);
    s.orderLast = { seq: (s.orderLast?.seq ?? 0) + 1, peer, dice };
    s.log = `${s.players[peer]!.nickname} · ${dice[0]}+${dice[1]} = ${dice[0] + dice[1]}`;
    sound.play('pop');
    if (s.orderPending.length === 0) this.finishOrderRound();
    this.afterChange();
  }

  /** 라운드 정산 — 동점자가 있으면 그 사람들만 재굴림, 없으면 순서 확정 후 게임 시작 */
  private finishOrderRound(): void {
    const s = this.state;
    const { sorted, tied } = resolveOrderRound(s.orderRolls, this.seatOrder);
    const round = Math.max(...Object.values(s.orderRolls).map((a) => a.length), 1);
    if (tied.length > 0 && round < ORDER_MAX_ROUNDS) {
      s.orderPending = this.seatOrder.filter((p) => tied.includes(p));   // 좌석 순으로 재굴림
      s.log = `동점! ${tied.map((p) => s.players[p]!.nickname).join(' · ')} 다시 굴리기`;
      return;
    }
    s.order = sorted;
    s.turnIdx = 0;
    s.log = `${s.players[sorted[0]!]!.nickname}님 먼저!`;
    // 결과를 잠깐 보여준 뒤 시작 (바로 넘기면 누가 몇 나왔는지 못 봄)
    this.orderStartTimer = window.setTimeout(() => {
      this.orderStartTimer = null;
      if (this.destroyed || this.ended) return;
      this.state.phase = 'playing';
      this.afterChange();
    }, ORDER_REVEAL_MS);
  }

  /**
   * 순서 정하기 백스톱 — 안 굴리고 버티는 사람이 있으면 호스트가 대신 굴려 진행을 막지 않는다.
   * (창을 닫아둔 사람 하나 때문에 방 전체가 멈추는 걸 방지)
   */
  private tickOrderPhase(): void {
    if (!this.isHost || this.destroyed || this.ended) return;
    const s = this.state;
    if (s.phase !== 'order') {
      if (this.orderTimer !== null) { window.clearInterval(this.orderTimer); this.orderTimer = null; }
      return;
    }
    // 더미(솔로 연습 상대)는 기다릴 것 없이 바로
    if (s.orderPending.includes(DUMMY)) { this.doOrderRoll(DUMMY); return; }
    const now = performance.now();
    if (this.orderRoundStartedAt === 0 || this.orderPendingKey !== s.orderPending.join(',')) {
      this.orderPendingKey = s.orderPending.join(',');
      this.orderRoundStartedAt = now;
      return;
    }
    if (now - this.orderRoundStartedAt < ORDER_AUTOROLL_MS) return;
    const who = s.orderPending[0];
    if (who !== undefined) this.doOrderRoll(who);
  }

  /**
   * 자금 마련 창에서 지불/파산이 끝난 뒤 — 대기열에 남은 빚이 있으면 이어서, 없으면 턴 마무리.
   * (대기열이 처음부터 비어 있던 통행료·세금은 그냥 턴 마무리로 떨어진다)
   */
  private settleDebtStep(): void {
    if (this.ended) return;
    const s = this.state;
    if (s.debtQueue.length) s.debtQueue.shift();   // 방금 갚은 건 큐에서 제거
    if (this.processDebts() && !this.ended) this.endStep(s.order[s.turnIdx]!);
  }

  /**
   * 빚 대기열을 앞에서부터 처리한다.
   *   현금 충분 → 바로 지불하고 다음
   *   부족한데 팔 땅 있음 → 그 사람에게 자금 마련 창을 띄우고 **멈춤**(false 반환)
   *   부족하고 팔 땅도 없음 → 가진 만큼 내고 파산, 다음으로
   * 큐를 다 비우면 true — 호출부가 endStep 하면 된다.
   */
  private processDebts(): boolean {
    const s = this.state;
    while (s.debtQueue.length) {
      const d = s.debtQueue[0]!;
      const p = s.players[d.from];
      if (!p || p.bankrupt || d.amount <= 0) { s.debtQueue.shift(); continue; }
      if (p.money < d.amount && this.hasSellable(d.from)) {
        s.pending = { kind: 'raiseFunds', debtor: d.from, to: d.to, amount: d.amount, toFund: d.toFund };
        s.log = `${p.nickname} · ₩${d.amount.toLocaleString()} 낼 현금이 부족해요. 땅을 파세요`;
        this.render();
        return false;
      }
      this.pay(d.from, d.to, d.amount, d.toFund);
      s.debtQueue.shift();
      if (this.ended) return false;   // 파산으로 게임이 끝났으면 더 진행 안 함
    }
    return true;
  }
  /** 내 땅 판매 → 땅값+건물비 전액 회수, 소유/건물/올림픽 해제 */
  private doSell(peer: string, tile: number): void {
    const s = this.state;
    if (s.owner[tile] !== peer) return;
    const refund = sellRefund(s, tile);
    s.players[peer]!.money += refund;
    delete s.owner[tile];
    delete s.builds[tile];
    delete s.olympic[tile];
    s.log = `${BOARD[tile].name} 판매 → ₩${refund.toLocaleString()} 회수`;
    sound.play('pop');
  }
  private cityBuildable(peer: string, tile: number): boolean {
    return (['villa', 'house2', 'apt', 'landmark'] as BuildKind[]).some((k) => canBuild(this.state, tile, peer, k));
  }
  private hasBuildableCity(peer: string): boolean {
    return this.ownedCities(peer).some((i) => this.cityBuildable(peer, i));
  }
  private doOlympic(peer: string, tile: number): void {
    const s = this.state;
    if (s.owner[tile] !== peer || BOARD[tile].type !== 'city') return;
    // 올림픽은 항상 "한 곳"만 개최 — 새 도시를 고르면 기존 개최지는 사라진다.
    // 같은 도시를 다시 고르면 배수가 2배씩 뛴다(×2→×4→×8→×16→×32 상한).
    const next = Math.min(OLYMPIC_MAX_MUL, (s.olympic[tile] ?? 1) * 2);
    s.olympic = { [tile]: next };
    s.log = `${BOARD[tile].name} 올림픽 개최 ×${next}! (이전 개최지는 해제)`;
    sound.play('pop');
  }
  private doBonusPick(peer: string, choice: number): void {
    const s = this.state; const pend = s.pending; if (pend?.kind !== 'bonus') return;
    const win = Math.floor(Math.random() * 2) === (choice & 1);
    if (!win) {
      s.log = `보너스 실패… 판돈 ₩${pend.stake.toLocaleString()} 소멸`;
      this.bonusResult(peer, `실패… 판돈 ₩${pend.stake.toLocaleString()} 날림`);
      return;
    }
    const pot = pend.pot * 2; const round = pend.round + 1;
    if (round >= 3) {   // 8배 달성 → 자동 지급
      s.players[peer]!.money += pot; s.log = `보너스 게임 8배! ₩${pot.toLocaleString()} 획득`;
      s.fx = { seq: (s.fx?.seq ?? 0) + 1, amount: pot, mul: 1, kind: 'gain', to: peer };
      this.bonusResult(peer, `8배 성공!! ₩${pot.toLocaleString()} 획득`);
      return;
    }
    s.pending = { kind: 'bonus', stake: pend.stake, round, pot };
    s.log = `보너스 성공! 누적 ₩${pot.toLocaleString()}`;
    sound.play('pop');
  }
  private doBonusStop(peer: string): void {
    const s = this.state; const pend = s.pending; if (pend?.kind !== 'bonus') return;
    s.players[peer]!.money += pend.pot; s.log = `보너스 게임 ₩${pend.pot.toLocaleString()} 획득`;
    s.fx = { seq: (s.fx?.seq ?? 0) + 1, amount: pend.pot, mul: 1, kind: 'gain', to: peer };
    this.bonusResult(peer, `₩${pend.pot.toLocaleString()} 받고 종료`);
  }
  /**
   * 보너스 게임 결과를 info 로 한 번 띄운 뒤 턴 마무리.
   * 그냥 endStep 하면 모달이 즉시 닫혀서 구경하던 사람들은 결과를 못 본다.
   * info 는 renderPending 이 차례와 무관하게 모두에게 보여주고, 호스트가 1초 뒤 자동으로 턴을 넘긴다.
   */
  private bonusResult(peer: string, text: string): void {
    this.state.pending = { kind: 'info', tile: this.state.pos[peer]!, text };
  }

  private rollAndMove(peer: string): void {
    const s = this.state;
    const a = 1 + Math.floor(Math.random() * 6), b = 1 + Math.floor(Math.random() * 6);
    s.dice = [a, b];
    const p = s.players[peer]!;

    if (p.desertLeft > 0) {
      if (a === b) {
        p.desertLeft = 0; s.log = `${p.nickname} · ${a}+${b} 더블! 무인도 탈출!`;
        s.noExtraRoll = true;   // 탈출용 더블 → 한 번 더는 없음
        this.move(peer, a + b); this.sync(); this.render(); this.resolveLanding(peer);
      } else {
        p.desertLeft -= 1; s.doubles = 0; s.log = `${p.nickname} · ${a}+${b} — 탈출 실패 (${p.desertLeft}턴 남음)`;
        this.sync(); this.render();   // 주사위 스핀/결과를 먼저 보여준 뒤 턴 넘김
        this.advanceTurn();
      }
      return;
    }
    if (a === b) s.doubles += 1; else s.doubles = 0;
    if (s.doubles >= 3) {
      s.doubles = 0;
      this.toDesert(peer);
      // 예전엔 desertLeft 만 세워서 말이 원래 칸(예: 방콕)에 남고 상태만 무인도가 됐다.
      // 무인도 유배 카드처럼 실제로 무인도 칸까지 옮겨야 "왜 여기서 무인도?"가 안 생긴다.
      s.pos[peer] = DESERT_TILE;
      s.log = `${p.nickname} 더블 3연속 → 무인도!`;
      // advanceTurn 이 dice 를 지워버리므로, 3번째 더블 주사위와 끌려가는 이동을 먼저 보여준다
      this.sync(); this.render();
      this.advanceTurn();
      return;
    }
    s.log = `${p.nickname} · ${a}+${b}=${a + b}`;
    this.move(peer, a + b);
    this.sync(); this.render();  // 이동 애니 트리거(dice 살아있을 때) — 통행료/세금 등 결정 없는 착지도 말이 움직이게
    this.resolveLanding(peer);
  }

  /** 칸 이동 + 출발 통과 시 월급·바퀴 */
  private move(peer: string, steps: number): void {
    const s = this.state;
    for (let k = 0; k < steps; k++) {
      s.pos[peer] = (s.pos[peer]! + 1) % BOARD.length;
      if (s.pos[peer] === 0) {
        s.players[peer]!.laps += 1;
        // 출발 "통과" 월급 (팝업은 렌더러가 통과하는 순간 표시 — 도착 땅에서 뜨지 않게). 도착 월급은 resolveLanding start.
        if (k < steps - 1) s.players[peer]!.money += SALARY;
      }
    }
  }

  /** 착지 처리 → 결정이 필요하면 pending 설정, 아니면 즉시 처리 후 턴 마무리 */
  private resolveLanding(peer: string): void {
    const s = this.state;
    const i = s.pos[peer]!;
    const t = BOARD[i];
    const p = s.players[peer]!;

    // 해변 관광지 — 누가 밟든 방문 횟수 +1 (최대 3, 통행료 배수)
    if (t.type === 'island' && t.spot === 'beach') s.beachVisits[i] = Math.min(3, (s.beachVisits[i] ?? 0) + 1);

    if (t.type === 'city' || t.type === 'island') {
      const o = s.owner[i];
      if (o === undefined) {
        if (p.money >= t.price) { s.pending = { kind: 'buy', tile: i }; this.render(); return; }
        // 살 돈이 없으면 잠깐 안내 후 자동으로 턴 넘김 (info pending — 전원에게 보임).
        // 누가 못 샀는지 알 수 있게 닉네임과 금액을 같이 넣는다.
        s.log = `${p.nickname} · ${t.name} 살 현금이 부족해요`;
        s.pending = { kind: 'info', tile: i,
          text: `${p.nickname}님 현금 부족 — ₩${t.price.toLocaleString()} 필요 (현재 ₩${p.money.toLocaleString()})` };
        this.render(); return;
      } else if (o === peer) {
        if (t.type === 'city' && (['villa', 'house2', 'apt', 'landmark'] as BuildKind[]).some((k) => canBuild(s, i, peer, k))) {
          s.pending = { kind: 'build', tile: i }; this.render(); return;
        }
      } else {
        const info = tollBreakdown(s, i, peer);
        // 보관 중인 면제권이 있으면 쓸지 물어본다. 통행료는 밟는 즉시 정산돼서
        // 플레이어가 끼어들 틈이 없으니, 이 순간이 유일한 선택 지점.
        if (info.total > 0) {
          const card = this.heldTollExemptId(peer);
          if (card !== null) {
            s.pending = { kind: 'tollAsk', tile: i, toll: info.total, to: o, card };
            s.log = `${t.name} 통행료 ₩${info.total.toLocaleString()} — 면제권을 쓸까요?`;
            this.render(); return;
          }
        }
        if (this.settleToll(peer, i, o, info, false)) return;   // 자금마련/인수 대기 걸림
      }
    } else if (t.type === 'special') {
      if (t.kind === 'goldkey') {
        const card = drawCardId(Math.random());
        // 보관형 카드(무인도 탈출권 등)는 즉시 쓸 수 없으니 자동으로 보관함에 저장
        if (CARDS[card]!.keep) {
          (s.held[peer] ??= []).push(card);
          s.log = `황금열쇠 · ${CARDS[card]!.title} — 보관함에 저장`;
          s.pending = { kind: 'info', tile: i, text: `${CARDS[card]!.title} 보관!` };
          this.render(); return;
        }
        s.pending = { kind: 'card', card }; this.render(); return;
      } else if (t.kind === 'tax') {
        // 세금 — 모두에게 창 표시, 밟은 사람이 확인하면 납부 후 진행
        const amt = t.taxAmount ?? 100;
        s.pending = { kind: 'event', tile: i, text: `세금 ₩${amt.toLocaleString()} 납부`, amount: amt };
        this.render(); return;
      }
      else if (t.kind === 'bonus') {
        // 오락실: 할지/판돈 선택 (최소 판돈 있으면)
        if (p.money >= BONUS_STAKE) { s.pending = { kind: 'bonusOffer' }; this.render(); return; }
        s.log = '보너스 게임 — 판돈이 부족해요';
        s.pending = { kind: 'info', tile: i, text: `최소 판돈 ₩${BONUS_STAKE.toLocaleString()} 부족 — 못 해요` };
        this.render(); return;
      }
    } else if (t.type === 'corner') {
      if (t.kind === 'start') {
        // 출발에 "도착"(딱 멈춤/세계여행) → 월급 + 추가 건설 기회
        p.money += SALARY; s.log = '출발 도착! 월급';
        s.fx = { seq: (s.fx?.seq ?? 0) + 1, amount: SALARY, mul: 1, kind: 'gain' };
        if (this.hasBuildableCity(peer)) { s.pending = { kind: 'startBuild' }; this.render(); return; }
      }
      else if (t.kind === 'olympic') {
        // 올림픽 개최 — 내 도시 하나에 개최(통행료 배수 누적). 도시 없으면 스킵
        if (this.ownedCities(peer).length) { s.pending = { kind: 'olympic' }; this.render(); return; }
        s.log = '올림픽 — 개최할 내 도시가 없어요';
      }
      else if (t.kind === 'desert') { this.toDesert(peer); s.log = `${p.nickname} 무인도에 갇힘`; }
      else if (t.kind === 'space') {
        // 세계여행 — 도착만으로는 아무 일도 안 일어난다. 비용을 낼지 말지는
        // **다음 내 턴이 시작될 때** 물어본다(advanceTurn → travelOffer).
        // 밟자마자 돈이 빠져나가면 "가고 싶지도 않은데 3만원 뜯겼다"가 되므로.
        s.log = `세계여행 — 다음 내 턴에 갈지 정해요 (₩${TRAVEL_COST.toLocaleString()})`;
      }
    }
    this.endStep(peer);
  }

  /** 결정/착지 처리 끝 → 더블이면 재굴림(턴 유지), 아니면 다음 턴 */
  private endStep(peer: string): void {
    const s = this.state;
    if (this.ended) return;
    const dbl = s.dice && s.dice[0] === s.dice[1];
    if (dbl && !s.noExtraRoll && !s.players[peer]!.bankrupt && s.players[peer]!.desertLeft === 0) { s.dice = null; s.log += ' · 더블! 한 번 더'; }
    else this.advanceTurn();
  }

  private advanceTurn(): void {
    const s = this.state;
    // 정전 디버프 카운트다운
    for (const k of Object.keys(s.blackout)) { const n = (s.blackout[+k] ?? 0) - 1; if (n > 0) s.blackout[+k] = n; else delete s.blackout[+k]; }
    s.doubles = 0; s.noExtraRoll = false; s.pending = null; s.dice = null;
    s.turnIdx = nextTurnIdx(s);
    const cur = s.order[s.turnIdx]!;
    if (s.players[cur]!.bankrupt) return;
    if (s.players[cur]!.travelReady) {
      // 세계여행 카드로 받은 무료 여행권 → 비용 없이 바로 목적지 선택
      s.players[cur]!.travelReady = false;
      s.pending = { kind: 'travel' };
    } else if (s.pos[cur] === SPACE_TILE && s.players[cur]!.desertLeft === 0) {
      // 세계여행 칸에 서서 턴 시작 → 갈지 말지 물어본다(돈 없으면 렌더러가 '간다'를 잠금)
      s.pending = { kind: 'travelOffer', cost: TRAVEL_COST };
    }
  }

  // ── 개별 처리 ──
  private doBuy(peer: string, tile: number): void {
    const s = this.state; const t = BOARD[tile] as { price: number };
    s.players[peer]!.money -= t.price; s.owner[tile] = peer;
    if (BOARD[tile].type === 'city') s.builds[tile] = [];
    sound.play('pop');
    this.checkMonopolyWin(peer);
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
    this.checkMonopolyWin(peer);
  }

  /** 독점 즉시승(트리플/라인/관광지) 판정 → 달성 시 게임 종료 */
  private checkMonopolyWin(peer: string): void {
    if (this.ended) return;
    const s = this.state;
    const reason = monopolyWin(s, peer);
    if (!reason) return;
    s.phase = 'ended';
    s.winnerPeerId = peer;
    s.log = `${s.players[peer]!.nickname} · ${reason} 달성 — 승리!`;
    this.finishGame();
  }
  /** 뽑은 즉발 카드 적용 (이동 카드는 내부에서 resolveLanding, 그 외엔 endStep) */
  private applyCard(peer: string, cardId: number): void {
    const s = this.state; const c = CARDS[cardId]!; const p = s.players[peer]!;
    const gain = (amt: number): void => { s.fx = { seq: (s.fx?.seq ?? 0) + 1, amount: amt, mul: 1, kind: 'gain', to: peer }; };
    const loss = (amt: number): void => { s.fx = { seq: (s.fx?.seq ?? 0) + 1, amount: amt, mul: 1, kind: 'toll', from: peer }; };
    // 말을 옮기는 카드는 "걸어서 도착한 것"이 아니므로 더블이었어도 한 번 더 굴리지 않는다
    if (c.effect === 'go' || c.effect === 'jail' || c.effect === 'back3' || c.effect === 'topcity'
        || c.effect === 'seoul' || c.effect === 'travel') {
      s.noExtraRoll = true;
    }
    switch (c.effect) {
      case 'money':
        // 금액이 음수인 money 카드 = 병원비·속도위반 벌금 → 기금 적립 + 현금 부족하면 땅 팔 기회
        if ((c.money ?? 0) < 0) {
          const owe = -c.money!;
          s.log = c.title; loss(owe);
          s.debtQueue = [{ from: peer, to: null, amount: owe, toFund: true }];
          if (this.processDebts()) this.endStep(peer);
          return;
        }
        p.money += c.money!; gain(c.money!);
        s.log = `${c.title}`; this.endStep(peer); return;
      case 'birthday': {
        // 나 빼고 전원이 각 c.money 씩 낸다. 현금이 모자란 사람은 한 명씩 땅 팔기 창을 거친다.
        s.log = `생일 축하 · 모두에게 ₩${c.money!.toLocaleString()}씩`;
        s.debtQueue = alivePeers(s).filter((o) => o !== peer)
          .map((o) => ({ from: o, to: peer, amount: c.money!, toFund: false }));
        if (this.processDebts()) this.endStep(peer);
        return;
      }
      case 'proptax': {
        // 현금의 10% 라 정의상 항상 낼 수 있음 — 땅 팔 일 없음
        const tax = Math.floor(p.money * 0.1); this.pay(peer, null, tax, true); loss(tax);
        s.log = `재산세 ₩${tax.toLocaleString()} 납부`; this.endStep(peer); return;
      }
      case 'go': this.cardMove(peer, 0); this.resolveLanding(peer); return;        // 출발 corner에서 월급 지급
      case 'jail': { const from = s.pos[peer]!; this.toDesert(peer); s.pos[peer] = DESERT_TILE; this.setCardFly(peer, from, DESERT_TILE); s.log = '무인도 유배!'; this.endStep(peer); return; }
      case 'back3': this.cardMove(peer, ((s.pos[peer]! - 3) % BOARD.length + BOARD.length) % BOARD.length, true); this.resolveLanding(peer); return;
      case 'topcity': this.cardMove(peer, topTollTile(s, peer)); this.resolveLanding(peer); return;
      case 'seoul': this.cardMove(peer, SEOUL_TILE); this.resolveLanding(peer); return;
      case 'welfare': {
        const amt = s.fund;
        if (amt <= 0) {
          s.log = '사회복지기금 — 아직 모인 돈이 없어요';
          this.cardFxEvt('toast', { text: '모인 기금이 없어요' });
        } else {
          s.fund = 0; p.money += amt; gain(amt);
          s.log = `사회복지기금 ₩${amt.toLocaleString()} 전액 수령!`;
        }
        this.endStep(peer); return;
      }
      case 'swap':
        if (this.ownedCities(peer).length && this.opponentCities(peer).length) s.pending = { kind: 'cardSwapMine' };
        else { s.log = '교환할 도시가 없어요'; this.endStep(peer); }
        return;
      case 'quake':
        if (this.opponentCities(peer).some((i) => (s.builds[i]?.length ?? 0) > 0)) s.pending = { kind: 'cardQuake' };
        else { s.log = '부술 상대 건물이 없어요'; this.endStep(peer); }
        return;
      case 'blackout':
        if (this.opponentCities(peer).length) s.pending = { kind: 'cardBlackout' };
        else { s.log = '정전시킬 상대 도시가 없어요'; this.endStep(peer); }
        return;
      case 'olympicGrant':
        // 올림픽 개최 — 즉발. 내 도시 하나에 개최(통행료 배수), 없으면 스킵
        if (this.ownedCities(peer).length) s.pending = { kind: 'olympic' };
        else { s.log = '개최할 내 도시가 없어요'; this.endStep(peer); }
        return;
      case 'travel':
        // 세계여행 카드 — 즉시 세계여행 칸으로 이동, 건물 없이 턴 종료
        // (세계여행 칸에 도착했으니 다음 턴에 원하는 칸으로 이동 준비. 카드라 비용 없음)
        this.cardMove(peer, SPACE_TILE);
        p.travelReady = true;
        s.log = '세계여행권! 세계여행으로 이동 — 다음 턴 원하는 칸으로';
        this.endStep(peer);
        return;
      default: this.endStep(peer); return;   // (보관형은 이 경로로 안 옴)
    }
  }
  /** 카드 연출 신호. back=true면 역방향(뒤로 3칸)으로 걸어가는 연출 */
  private setCardFly(peer: string, from: number, to: number, back = false): void {
    const s = this.state; s.cardFx = { seq: (s.cardFx?.seq ?? 0) + 1, kind: 'fly', by: peer, from, to, back };
  }
  private cardFxEvt(kind: 'quake' | 'swap' | 'toast', extra: { tile?: number; tile2?: number; text?: string }): void {
    const s = this.state; s.cardFx = { seq: (s.cardFx?.seq ?? 0) + 1, kind, ...extra };
  }
  /** 카드로 이동 — 판을 따라 걸어가는 연출 트리거 후 착지는 호출부에서 resolveLanding */
  private cardMove(peer: string, dest: number, back = false): void {
    const s = this.state; const from = s.pos[peer]!;
    s.pos[peer] = dest;
    // 카드 이동도 판 경로를 정방향으로 "걸어가는" 것이라(166d73c) 출발선을 넘으면
    // 주사위로 걸어간 것과 똑같이 월급·바퀴를 인정해야 한다.
    //   dest < from  → 31번 칸을 지나 0번(출발)을 넘어감
    //   dest === 0   → 출발에 "도착" — 월급은 resolveLanding 이 주므로 여기선 바퀴만
    //   dest === from→ 제자리(연출도 안 움직임) → 아무것도 없음
    //   back(뒤로 3칸) → 역주행이라 월급 없음
    if (!back && dest < from) {
      s.players[peer]!.laps += 1;
      if (dest !== 0) s.players[peer]!.money += SALARY;
    }
    this.setCardFly(peer, from, dest, back);
    this.sync(); this.render();
  }

  /** 보관 카드 사용 (자유 행동 — 턴 안 넘김) */
  private useHeld(peer: string, cardId: number): void {
    const s = this.state; const arr = s.held[peer]; if (!arr) return;
    const idx = arr.indexOf(cardId); if (idx < 0) return;
    const c = CARDS[cardId]!; const p = s.players[peer]!;
    // 사용 조건 검사 (조건 안 맞으면 카드 소모 없이 안내만)
    if (c.effect === 'jailFree' && p.desertLeft === 0) { s.log = '무인도에 있을 때만 쓸 수 있어요'; return; }
    arr.splice(idx, 1);
    switch (c.effect) {
      case 'jailFree': p.desertLeft = 0; s.log = '무인도 탈출권 사용!'; this.cardFxEvt('toast', { text: '무인도 탈출!' }); break;
      default: break;
    }
  }

  /** 보관함에 있는 통행료 면제권 카드 id (없으면 null) */
  private heldTollExemptId(peer: string): number | null {
    const held = this.state.held[peer];
    return held?.find((id) => CARDS[id]?.effect === 'tollExempt') ?? null;
  }

  /**
   * 남의 땅 통행료 정산 + 인수 기회.
   * exempt=true 면 통행료 없이 면제 연출만.
   * 결정 대기(자금마련/인수)를 걸었으면 true → 호출부는 endStep 없이 바로 return.
   */
  private settleToll(peer: string, tile: number, owner: string, info: TollInfo, exempt: boolean): boolean {
    const s = this.state; const p = s.players[peer]!; const t = BOARD[tile];
    const toll = info.total;
    if (exempt) {
      s.log = `${t.name} 통행료 ₩${toll.toLocaleString()} — 면제권으로 0원!`;
      this.cardFxEvt('toast', { text: '통행료 면제권 사용! 통행료 0' });
      sound.play('pop');
    } else {
      // 낼 돈 부족 + 팔 땅 있으면 → 자금 마련 페이즈(파산 대신 땅 팔 기회)
      if (toll > 0 && p.money < toll && this.hasSellable(peer)) {
        s.pending = { kind: 'raiseFunds', debtor: peer, to: owner, amount: toll, toFund: false };
        s.log = `${t.name} 통행료 ₩${toll.toLocaleString()} — 낼 현금이 부족해요. 땅을 파세요`;
        this.render(); return true;
      }
      this.pay(peer, owner, toll);
      s.log = `${t.name} 통행료 ${toll.toLocaleString()} → ${s.players[owner]!.nickname}`;
      // 타격감 연출용 (배수 클수록 강하게)
      if (toll > 0) s.fx = { seq: (s.fx?.seq ?? 0) + 1, amount: toll, mul: info.base > 0 ? Math.round(info.total / info.base) : 1, kind: 'toll', from: peer, to: owner };
    }
    // 도시면 인수 기회(랜드마크·섬 제외)
    if (!p.bankrupt && t.type === 'city') {
      const cost = acquireCost(s, tile);
      if (cost > 0 && p.money >= cost) { s.pending = { kind: 'acquire', tile, cost }; this.render(); return true; }
    }
    return false;
  }

  private toDesert(peer: string): void { this.state.players[peer]!.desertLeft = DESERT_TURNS; }

  /**
   * from 이 amount 를 to 에게 지불. to=null 이면 은행행.
   * 부족하면 가진 만큼 내고 파산.
   *
   * toFund=true 인 은행행만 사회복지기금에 적립된다 — **벌금(병원비·속도위반)과 세금(재산세·국세청)뿐**.
   * 세계여행비·무인도 탈출비·보너스 판돈처럼 "서비스 값"으로 나가는 돈은 그냥 은행 소멸.
   */
  private pay(from: string, to: string | null, amount: number, toFund = false): void {
    const s = this.state; const p = s.players[from]!;
    const paid = Math.min(p.money, amount);
    p.money -= paid;
    if (to) s.players[to]!.money += paid;
    else if (toFund) s.fund += paid;
    if (amount > paid) this.bankrupt(from);
  }

  private bankrupt(peer: string): void {
    const s = this.state; const p = s.players[peer]; if (!p || p.bankrupt) return;
    p.bankrupt = true; p.money = 0;
    // 소유 부동산 반환(무주공산)
    for (const k of Object.keys(s.owner)) { if (s.owner[+k] === peer) { delete s.owner[+k]; delete s.builds[+k]; } }
    s.log = `${p.nickname} 파산!`;
    // 판 흔들림 + "○○ 파산!" 연출. 렌더러엔 예전부터 있었는데 세팅하는 곳이 없어 죽어 있었다.
    s.fx = { seq: (s.fx?.seq ?? 0) + 1, amount: 0, mul: 1, kind: 'bankrupt', from: peer, nick: p.nickname };
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
      // money=현금 / estate=부동산 / assets=총자산. 순위는 총자산 기준(결과 화면)
      players: s.order.map((pid) => ({
        peerId: pid, nickname: s.players[pid]!.nickname, bankrupt: s.players[pid]!.bankrupt,
        money: s.players[pid]!.money, estate: estateValue(s, pid), assets: totalAssets(s, pid),
      })),
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
    // 이동/주사위 애니가 끝난 뒤(=착지해서 어떤 땅에서 파산했는지 보인 뒤) 결과·통행료 fx 를
    // 잠깐 보여주고 나서 결과 화면으로. (애니 중이면 끝날 때까지 대기)
    const go = (): void => {
      if (this.destroyed) return;
      if (this.renderer.isBusy()) { window.setTimeout(go, 250); return; }
      window.setTimeout(() => { if (!this.destroyed) this.ctx.endGame(result); }, END_DELAY_MS);
    };
    go();
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
