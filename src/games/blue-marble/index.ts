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
  BOARD, CARDS, SALARY, DESERT_TURNS, DESERT_ESCAPE, TRAVEL_COST, BONUS_STAKE, buildCostOf, canBuild, acquireCost,
  tollBreakdown, alivePeers, nextTurnIdx, createInitialState, monopolyWin, drawCardId, TOP_CITY_TILE, DESERT_TILE, SPACE_TILE,
  type BMState, type BuildKind,
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

  // ── 상태 변경 후: 동기화 + 렌더 + 더미 자동 진행 ──
  private afterChange(): void {
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
        // 선택한 건물들을 별장→2층집→아파트→랜드마크 순으로 건설(의존성·자금 검증이 순서대로 맞아야 함)
        for (const k of ['villa', 'house2', 'apt', 'landmark'] as BuildKind[]) {
          if (action.builds.includes(k) && canBuild(s, tile, by, k)) this.doBuild(by, tile, k);
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
        s.pending = null; s.pos[by] = action.tile;   // 세계여행: 출발 통과 월급 없음(도착 월급은 resolveLanding)
        s.travelFx = { seq: (s.travelFx?.seq ?? 0) + 1, by, from, to: action.tile };
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
        this.pay(by, null, ev.amount);   // 세금 납부(파산 가능)
        s.log = `${BOARD[ev.tile].name} · ₩${ev.amount.toLocaleString()} 납부`;
        this.endStep(by);
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
    // 같은 도시를 다시 고르면 배수 누적(첫 개최 ×2 … 최대 ×5).
    const next = Math.min(5, (s.olympic[tile] ?? 1) + 1);
    s.olympic = { [tile]: next };
    s.log = `${BOARD[tile].name} 올림픽 개최 ×${next}! (이전 개최지는 해제)`;
    sound.play('pop');
  }
  private doBonusPick(peer: string, choice: number): void {
    const s = this.state; const pend = s.pending; if (pend?.kind !== 'bonus') return;
    const win = Math.floor(Math.random() * 2) === (choice & 1);
    if (!win) { s.log = `보너스 실패… 판돈 ₩${pend.stake.toLocaleString()} 소멸`; s.pending = null; this.endStep(peer); return; }
    const pot = pend.pot * 2; const round = pend.round + 1;
    if (round >= 3) {   // 8배 달성 → 자동 지급
      s.players[peer]!.money += pot; s.log = `보너스 게임 8배! ₩${pot.toLocaleString()} 획득`;
      s.pending = null; this.endStep(peer); return;
    }
    s.pending = { kind: 'bonus', stake: pend.stake, round, pot };
    s.log = `보너스 성공! 누적 ₩${pot.toLocaleString()}`;
    sound.play('pop');
  }
  private doBonusStop(peer: string): void {
    const s = this.state; const pend = s.pending; if (pend?.kind !== 'bonus') return;
    s.players[peer]!.money += pend.pot; s.log = `보너스 게임 ₩${pend.pot.toLocaleString()} 획득`;
    s.pending = null; this.endStep(peer);
  }

  private rollAndMove(peer: string): void {
    const s = this.state;
    const a = 1 + Math.floor(Math.random() * 6), b = 1 + Math.floor(Math.random() * 6);
    s.dice = [a, b];
    const p = s.players[peer]!;

    if (p.desertLeft > 0) {
      if (a === b) {
        p.desertLeft = 0; s.log = `${p.nickname} · ${a}+${b} 더블! 무인도 탈출!`;
        this.move(peer, a + b); this.sync(); this.render(); this.resolveLanding(peer);
      } else {
        p.desertLeft -= 1; s.doubles = 0; s.log = `${p.nickname} · ${a}+${b} — 탈출 실패 (${p.desertLeft}턴 남음)`;
        this.sync(); this.render();   // 주사위 스핀/결과를 먼저 보여준 뒤 턴 넘김
        this.advanceTurn();
      }
      return;
    }
    if (a === b) s.doubles += 1; else s.doubles = 0;
    if (s.doubles >= 3) { s.doubles = 0; this.toDesert(peer); s.log = `${p.nickname} 더블 3연속 → 무인도!`; this.advanceTurn(); return; }
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
      } else if (p.tollExempt) {
        // 통행료 면제권 사용 중 → 이번 통행료 면제
        p.tollExempt = false;
        s.log = `${t.name} — 통행료 면제권 사용!`;
      } else {
        const info = tollBreakdown(s, i, peer);
        const toll = info.total;
        this.pay(peer, o, toll);
        s.log = `${t.name} 통행료 ${toll.toLocaleString()} → ${s.players[o]!.nickname}`;
        // 타격감 연출용 (배수 클수록 강하게)
        if (toll > 0) s.fx = { seq: (s.fx?.seq ?? 0) + 1, amount: toll, mul: info.base > 0 ? Math.round(info.total / info.base) : 1, kind: 'toll', from: peer, to: o };
        // 도시면 인수 기회(랜드마크·섬 제외)
        if (!p.bankrupt && t.type === 'city') {
          const cost = acquireCost(s, i);
          if (cost > 0 && p.money >= cost) { s.pending = { kind: 'acquire', tile: i, cost }; this.render(); return; }
        }
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
      else if (t.kind === 'concert') { this.pay(peer, null, 50); s.log = '콘서트 관람 ₩50'; }
      else if (t.kind === 'bonus') {
        // 오락실: 할지/판돈 선택 (최소 판돈 있으면)
        if (p.money >= BONUS_STAKE) { s.pending = { kind: 'bonusOffer' }; this.render(); return; }
        s.log = '보너스 게임 — 판돈이 부족해요';
      }
    } else if (t.type === 'corner') {
      if (t.kind === 'start') {
        // 출발에 "도착"(딱 멈춤/세계여행) → 월급 + 추가 건설 기회
        p.money += SALARY; s.log = '출발 도착! 월급';
        s.fx = { seq: (s.fx?.seq ?? 0) + 1, amount: SALARY, mul: 1, kind: 'gain' };
        if (this.hasBuildableCity(peer)) { s.pending = { kind: 'startBuild' }; this.render(); return; }
      }
      else if (t.kind === 'welfare') {
        // 올림픽 개최 — 내 도시 하나에 개최(통행료 배수 누적). 도시 없으면 스킵
        if (this.ownedCities(peer).length) { s.pending = { kind: 'olympic' }; this.render(); return; }
        s.log = '올림픽 — 개최할 내 도시가 없어요';
      }
      else if (t.kind === 'desert') { this.toDesert(peer); s.log = `${p.nickname} 무인도에 갇힘`; }
      else if (t.kind === 'space') {
        // 세계여행 — 비용 내면 다음 턴에 원하는 칸으로 이동
        if (p.money >= TRAVEL_COST) { this.pay(peer, null, TRAVEL_COST); p.travelReady = true; s.log = `세계여행 준비! 다음 턴에 원하는 칸으로`; }
        else s.log = '세계여행 — 비용이 부족해요';
      }
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
    // 정전 디버프 카운트다운
    for (const k of Object.keys(s.blackout)) { const n = (s.blackout[+k] ?? 0) - 1; if (n > 0) s.blackout[+k] = n; else delete s.blackout[+k]; }
    s.doubles = 0; s.pending = null; s.dice = null;
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
    switch (c.effect) {
      case 'money':
        if ((c.money ?? 0) < 0) { this.pay(peer, null, -c.money!); loss(-c.money!); } else { p.money += c.money!; gain(c.money!); }
        s.log = `${c.title}`; this.endStep(peer); return;
      case 'birthday': {
        let got = 0;
        for (const o of alivePeers(s)) if (o !== peer) { const amt = Math.min(s.players[o]!.money, c.money!); s.players[o]!.money -= amt; got += amt; }
        p.money += got; gain(got); s.log = `생일 축하 · ₩${got.toLocaleString()} 받음`; this.endStep(peer); return;
      }
      case 'proptax': {
        const tax = Math.floor(p.money * 0.1); this.pay(peer, null, tax); loss(tax);
        s.log = `재산세 ₩${tax.toLocaleString()} 납부`; this.endStep(peer); return;
      }
      case 'go': this.cardMove(peer, 0); this.resolveLanding(peer); return;        // 출발 corner에서 월급 지급
      case 'jail': { const from = s.pos[peer]!; this.toDesert(peer); s.pos[peer] = DESERT_TILE; this.setCardFly(peer, from, DESERT_TILE); s.log = '무인도 유배!'; this.endStep(peer); return; }
      case 'back3': this.cardMove(peer, ((s.pos[peer]! - 3) % BOARD.length + BOARD.length) % BOARD.length); this.resolveLanding(peer); return;
      case 'topcity': this.cardMove(peer, TOP_CITY_TILE); this.resolveLanding(peer); return;
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
  /** 카드 연출 신호 */
  private setCardFly(peer: string, from: number, to: number): void {
    const s = this.state; s.cardFx = { seq: (s.cardFx?.seq ?? 0) + 1, kind: 'fly', by: peer, from, to };
  }
  private cardFxEvt(kind: 'quake' | 'swap' | 'toast', extra: { tile?: number; tile2?: number; text?: string }): void {
    const s = this.state; s.cardFx = { seq: (s.cardFx?.seq ?? 0) + 1, kind, ...extra };
  }
  /** 카드로 순간이동 — 말 날아가는 연출 트리거 후 착지는 호출부에서 resolveLanding */
  private cardMove(peer: string, dest: number): void {
    const s = this.state; const from = s.pos[peer]!;
    s.pos[peer] = dest;
    this.setCardFly(peer, from, dest);
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
