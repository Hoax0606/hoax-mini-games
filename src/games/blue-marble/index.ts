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
    if (this.infoTimer !== null) { window.clearTimeout(this.infoTimer); this.infoTimer = null; }
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
      }, 1000);
      return;
    }
    if (this.dummyTimer !== null) return;
    if (s.order[s.turnIdx] !== DUMMY) return;
    this.dummyTimer = window.setTimeout(() => {
      this.dummyTimer = null;
      if (this.destroyed || this.ended) return;
      this.dummyAct();
    }, 600);
  }
  /** 더미의 한 스텝 (주사위/결정) — hostHandle 로 처리 */
  private dummyAct(): void {
    const s = this.state;
    if (s.order[s.turnIdx] !== DUMMY) return;
    const pend = s.pending;
    if (!pend) { this.hostHandle({ kind: 'roll', by: DUMMY }, DUMMY); return; }
    if (pend.kind === 'buy') this.hostHandle({ kind: 'decision', accept: Math.random() < 0.75, by: DUMMY }, DUMMY);
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
    const cur = s.order[s.turnIdx];
    if (by !== cur || s.players[by]?.bankrupt) return; // 내 차례 아닌 사람 무시

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
        if (to <= from) {
          s.players[by]!.laps += 1;
          if (to !== 0) {
            s.players[by]!.money += SALARY;
            s.fx = { seq: (s.fx?.seq ?? 0) + 1, amount: SALARY, mul: 1, kind: 'gain', to: by };
          }
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
          s.pending = { kind: 'raiseFunds', to: null, amount: ev.amount };
          s.log = `세금 ₩${ev.amount.toLocaleString()} — 낼 돈이 부족해요. 땅을 파세요`;
        } else {
          this.pay(by, null, ev.amount, true);   // 세금 → 사회복지기금 적립
          s.log = `${BOARD[ev.tile].name} · ₩${ev.amount.toLocaleString()} 납부`;
          this.endStep(by);
        }
      }
    } else if (action.kind === 'sell') {
      // 내 땅 판매 — 내 소유이고, 자유(대기 없음) 또는 자금 마련 중일 때
      if (s.owner[action.tile] === by && (s.pending === null || s.pending.kind === 'raiseFunds')) {
        this.doSell(by, action.tile);
      }
    } else if (action.kind === 'payDebt') {
      if (s.pending?.kind === 'raiseFunds' && s.players[by]!.money >= s.pending.amount) {
        const { to, amount } = s.pending;
        s.pending = null;
        this.pay(by, to, amount, to === null);   // to=null 인 채무는 세금뿐 → 기금 적립
        this.endStep(by);
      }
    } else if (action.kind === 'giveUp') {
      if (s.pending?.kind === 'raiseFunds') {
        const { to, amount } = s.pending;
        s.pending = null;
        // 파산해도 가진 돈은 전부 받을 사람(to=null 인 세금이면 기금)에게 넘어간다.
        // 예전엔 bankrupt() 를 바로 불러서 p.money=0 으로 지워버려 남은 현금이 소멸했음.
        // pay() 가 min(보유, 청구)만큼 넘기고 그래도 부족하면 파산 처리까지 해준다.
        this.pay(by, to, amount, to === null);
        if (!this.ended) this.endStep(by);
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
        // 살 돈이 없으면 잠깐 안내 후 자동으로 턴 넘김 (info pending)
        s.log = `${t.name} — 살 돈이 부족해요`;
        s.pending = { kind: 'info', tile: i, text: '살 돈이 부족해요' }; this.render(); return;
      } else if (o === peer) {
        if (t.type === 'city' && (['villa', 'house2', 'apt', 'landmark'] as BuildKind[]).some((k) => canBuild(s, i, peer, k))) {
          s.pending = { kind: 'build', tile: i }; this.render(); return;
        }
      } else {
        const info = tollBreakdown(s, i, peer);
        let exempt = false;
        if (info.total > 0) {
          if (p.tollExempt) {
            p.tollExempt = false; exempt = true;   // 보관함에서 미리 쓴 것 — 이미 결정했으니 안 물음
          } else {
            // 보관 중인 면제권이 있으면 쓸지 물어본다. 통행료는 밟는 즉시 정산돼서
            // 플레이어가 끼어들 틈이 없으니, 이 순간에 물어보는 게 유일한 선택 지점.
            const card = this.heldTollExemptId(peer);
            if (card !== null) {
              s.pending = { kind: 'tollAsk', tile: i, toll: info.total, to: o, card };
              s.log = `${t.name} 통행료 ₩${info.total.toLocaleString()} — 면제권을 쓸까요?`;
              this.render(); return;
            }
          }
        }
        if (this.settleToll(peer, i, o, info, exempt)) return;   // 자금마련/인수 대기 걸림
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
        // 세계여행 — 비용(TRAVEL_COST) 내면 다음 턴에 원하는 칸으로 이동.
        // 성공/실패 둘 다 info 로 띄운다: 예전엔 s.log 만 넣었는데 log 는 화면에 안 그려져서
        // 돈이 부족하면 아무 안내 없이 턴이 넘어가 "목적지가 안 골라진다"로 보였음.
        if (p.money >= TRAVEL_COST) {
          // 세계여행권을 받았으면 더블이어도 한 번 더는 없음 — 추가 굴림 대신 다음 턴 순간이동을 받는 것.
          // (예전엔 더블로 한 번 더 굴려서 딴 데 간 뒤에도 세계여행이 살아있어 이중 이득이었다)
          // 돈이 부족해 못 갔을 때는 받은 게 없으니 더블을 그대로 살려둔다.
          s.noExtraRoll = true;
          this.pay(peer, null, TRAVEL_COST); p.travelReady = true;
          s.log = '세계여행 준비! 다음 턴에 원하는 칸으로';
          s.pending = { kind: 'info', tile: i, text: `₩${TRAVEL_COST.toLocaleString()} 지불 — 다음 턴에 원하는 칸으로!` };
        } else {
          s.log = '세계여행 — 비용이 부족해요';
          s.pending = { kind: 'info', tile: i, text: `₩${TRAVEL_COST.toLocaleString()} 필요 — 돈이 부족해서 못 가요` };
        }
        this.render(); return;
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
    // 세계여행 대기자의 턴이면 → 원하는 칸 선택(travel)으로 시작
    const cur = s.order[s.turnIdx]!;
    if (s.players[cur]!.travelReady && !s.players[cur]!.bankrupt) {
      s.players[cur]!.travelReady = false;
      s.pending = { kind: 'travel' };
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
        // 금액이 음수인 money 카드 = 병원비·속도위반 벌금 → 기금 적립
        if ((c.money ?? 0) < 0) { this.pay(peer, null, -c.money!, true); loss(-c.money!); } else { p.money += c.money!; gain(c.money!); }
        s.log = `${c.title}`; this.endStep(peer); return;
      case 'birthday': {
        let got = 0;
        for (const o of alivePeers(s)) if (o !== peer) { const amt = Math.min(s.players[o]!.money, c.money!); s.players[o]!.money -= amt; got += amt; }
        p.money += got; gain(got); s.log = `생일 축하 · ₩${got.toLocaleString()} 받음`; this.endStep(peer); return;
      }
      case 'proptax': {
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
      case 'tollExempt': p.tollExempt = true; s.log = '통행료 면제권 사용 — 다음 통행료 면제'; this.cardFxEvt('toast', { text: '통행료 면제권 사용!' }); break;
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
        s.pending = { kind: 'raiseFunds', to: owner, amount: toll };
        s.log = `${t.name} 통행료 ₩${toll.toLocaleString()} — 낼 돈이 부족해요. 땅을 파세요`;
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
