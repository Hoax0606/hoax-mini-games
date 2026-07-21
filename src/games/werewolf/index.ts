/**
 * 한밤의 늑대인간 GameModule — 조립 (호스트 authoritative).
 *
 * 호스트가 카드 배분 / 밤 순서 진행 / 카드 교환 / 투표 집계 / 승패 판정을 단독 관리.
 * 비밀(내 역할·밤에 본 것)은 sync 에 안 담고 각 peer 에게만 targeted 로 전송.
 *
 * 흐름: 역할배정(deal) → 밤(night, 역할 순서대로) → 낮 토론(day) → 투표(vote) → 결과(result).
 *
 * 밤 행동 규칙:
 *  - 밤 행동은 "처음 받은 역할(origRole)" 기준. 카드가 바뀌어도 원래 역할대로 행동.
 *  - 정보를 받는 역할(늑대/예언자/강도/불면증)은 결과를 보고 "확인" 해야 다음으로 진행.
 *  - 눈 감고 하는 역할(말썽쟁이/주정뱅이)은 선택 즉시 진행.
 *  - 세팅에 있는 밤-행동 역할은 카드가 가운데에만 있어도 스텝을 진행(잠깐 대기) — 정보 은폐.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  dealCards, setupFor, nightStepsForSetup, tallyVotes, resolveHunterDeaths, computeWin, teamOf,
  validateFreeSetup, ROLE_META, MIN_PLAYERS, CENTER_COUNT,
  type Role, type SecretDeal, type PublicState, type ChatLine, type RevealData,
} from './rules';
import {
  encodeHello, decodeHello,
  encodeSync, decodeSync,
  encodeRole, decodeRole,
  encodeReady, decodeReady,
  encodeAct, decodeAct,
  encodeNightInfo, decodeNightInfo,
  encodeChat, decodeChat,
  encodeVote, decodeVote,
  encodeEnd, decodeEnd,
  type NightAction, type NightInfo,
} from './netSync';
import { WerewolfRenderer, type WwRenderState } from './render';

const DUMMY_PREFIX = '__ww_dummy_';
const DEAL_TIMEOUT_MS = 40_000;
const NIGHT_STEP_MS = 30_000;
const VOTE_MS = 40_000;
const RESULT_SHOW_MS = 9_000;
const END_DELAY_MS = 1_500;
const DUMMY_DELAY_MS = 900;
/** 카드가 가운데에만 있는 밤 스텝의 대기 시간(정보 은폐용, 랜덤) */
const MASK_MIN_MS = 2_500;
const MASK_MAX_MS = 4_500;

const DUMMY_CHATS = ['난 마을사람이야 ㅋㅋ', '음… 누가 수상한데', '난 아님 진짜로', '예언자 나와봐'];

class WerewolfModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: WerewolfRenderer;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;

  // 공개 상태 (전원 공유)
  private state!: PublicState;

  // 내 로컬 상태 (모든 클라)
  private myOrigRole: Role | null = null;
  private memos: NightInfo[] = [];
  private confirmedDeal = false;
  private actedNight = false;
  private voted = false;
  private lastHelloAt = 0;

  // ── 호스트 전용 비밀 상태 ──
  private deal!: SecretDeal;
  private hostMemos: Record<string, NightInfo[]> = {}; // peer 별 밤 정보 (유실 재전송용)
  private nightSteps: Role[] = [];
  private stepIdx = 0;
  private readySet = new Set<string>();
  // 랜덤(자유) 모드: 호스트가 setup 페이즈에서 고르는 카드 구성
  private freeMode = false;
  private setupDeck: Role[] = [];
  private pendingPlayers: { peerId: string; nickname: string }[] = [];
  private stepChosen = new Set<string>(); // 이번 스텝에서 정보 선택을 이미 한 actor
  private stepDone = new Set<string>();    // 이번 스텝에서 완료한 actor
  private dgCopy: Record<string, Role> = {}; // 도플갱어 peerId → 복사한 직업
  private hostVotes: Record<string, string> = {};
  private phaseDeadline = 0;
  private stepAdvancing = false;
  /** 결과 공개용 밤 행동/교환 로그 (호스트가 밤 동안 기록) */
  private hostNightLog: string[] = [];
  private hostSwapLog: string[] = [];

  // 타이머
  private dayMs = 180_000;
  private displayDeadline = 0;
  private lastPhaseKey = '';
  private rafId: number | null = null;
  private dummyTimer: number | null = null;
  private destroyed = false;
  private ended = false;
  private endScheduled = false;
  private paused = false;
  private pauseStart = 0;

  // ============================================
  // 시작
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.dayMs = Math.max(30, Number(ctx.roomOptions['discuss'] ?? '180')) * 1000;

    this.freeMode = ctx.roomOptions['mode'] === 'free';
    this.renderer = new WerewolfRenderer(ctx.canvas, {
      onReady: () => this.doReady(),
      onNightAct: (a) => this.doNightAct(a),
      onChat: (t) => this.doChat(t),
      onVote: (t) => this.doVote(t),
      onSetupAdd: (r) => this.setupAdd(r),
      onSetupRemove: (r) => this.setupRemove(r),
      onSetupStart: () => this.setupStart(),
    });
    sound.startBgm('apple-game');

    if (this.isHost) {
      const realPlayers = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'))
        .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));
      const players = [...realPlayers];
      // 솔로(AlphaTest) 프리뷰 — 최소 인원까지 더미로 채움 (자동 진행)
      let d = 1;
      while (players.length < MIN_PLAYERS) {
        players.push({ peerId: `${DUMMY_PREFIX}${d}__`, nickname: `봇 ${String.fromCharCode(64 + d)}` });
        d += 1;
      }
      this.pendingPlayers = players;
      if (this.freeMode) this.startSetupAsHost(players);
      else this.startDealAsHost(players);
    } else {
      this.state = emptyState();
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
      this.lastHelloAt = performance.now();
    }

    this.rafId = requestAnimationFrame(this.loop);
  }

  // ============================================
  // 메시지 수신
  // ============================================

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost) this.sendStateTo(hello.peerId);
      return;
    }

    const sync = decodeSync(msg);
    if (sync) {
      if (!this.isHost) { this.state = sync; this.render(); }
      return;
    }

    const role = decodeRole(msg);
    if (role) {
      if (!this.isHost) { this.myOrigRole = role.role; this.render(); }
      return;
    }

    const info = decodeNightInfo(msg);
    if (info) {
      if (!this.isHost) { this.memos.push(info.info); this.render(); }
      return;
    }

    const end = decodeEnd(msg);
    if (end) { if (!this.isHost) this.scheduleEnd(end); return; }

    // 호스트만 처리하는 클라 요청
    if (this.isHost) {
      const ready = decodeReady(msg);
      if (ready) { this.handleReady(ready.from); return; }
      const act = decodeAct(msg);
      if (act) { this.handleAct(act.from, act.action); return; }
      const chat = decodeChat(msg);
      if (chat) { this.relayChat(chat.from, chat.nickname, chat.text); return; }
      const vote = decodeVote(msg);
      if (vote) { this.handleVote(vote.from, vote.target); return; }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.ended = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.dummyTimer !== null) window.clearTimeout(this.dummyTimer);
    this.renderer?.destroy();
    sound.stopBgm();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.pauseStart = performance.now();
    else if (this.pauseStart > 0) {
      const delta = performance.now() - this.pauseStart;
      this.phaseDeadline += delta;
      if (this.displayDeadline > 0) this.displayDeadline += delta;
      this.pauseStart = 0;
    }
  }

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.destroyed || this.ended) return;
    // 이탈자는 그냥 남겨둠(카드는 그대로). 단, 진행이 그 사람 행동을 기다리고 있으면 스킵.
    if (this.state.phase === 'night') { this.stepDone.add(peerId); this.maybeAdvanceStep(); }
    else if (this.state.phase === 'vote') { this.maybeResolveVote(); }
    else if (this.state.phase === 'deal') { this.readySet.add(peerId); this.maybeStartNight(); }
  }

  // ============================================
  // 루프 (타이머 표시 + 호스트 데드라인)
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;
    const now = performance.now();

    if (this.isHost && !this.paused && !this.ended && this.phaseDeadline > 0 && now > this.phaseDeadline) {
      this.phaseDeadline = 0;
      this.onPhaseTimeout();
    }

    // 게스트: 역할 못 받았으면 hello 재전송 (합류/전환 시 유실 복구)
    if (!this.isHost && !this.isSpectator && this.myOrigRole === null && now - this.lastHelloAt > 2000) {
      this.lastHelloAt = now;
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }

    // 표시 타이머 — 낮/투표만 카운트다운 (밤은 숨김: 스텝 길이로 정보 새는 것 방지)
    const phaseKey = `${this.state?.phase}:${this.state?.nightStep}`;
    if (phaseKey !== this.lastPhaseKey) {
      this.lastPhaseKey = phaseKey;
      const dur = this.state?.phase === 'day' ? this.dayMs : this.state?.phase === 'vote' ? VOTE_MS : 0;
      this.displayDeadline = dur > 0 ? now + dur : 0;
    }
    const renderNow = this.paused && this.pauseStart > 0 ? this.pauseStart : now;
    const remainMs = this.displayDeadline > 0 ? Math.max(0, this.displayDeadline - renderNow) : 0;

    if (this.state) this.render(remainMs);
  };

  private onPhaseTimeout(): void {
    switch (this.state.phase) {
      case 'deal': this.startNight(); break;
      case 'night': this.forceCompleteStep(); break;
      case 'day': this.startVote(); break;
      case 'vote': this.resolveVote(); break;
    }
  }

  // ============================================
  // 렌더
  // ============================================

  private render(remainMs = 0): void {
    if (!this.state) return;
    const rs: WwRenderState = {
      state: this.state,
      myPeerId: this.myPeerId,
      isHost: this.isHost,
      isSpectator: this.isSpectator,
      myOrigRole: this.myOrigRole,
      memos: this.memos,
      remainMs,
      confirmedDeal: this.confirmedDeal,
      actedNight: this.actedNight,
      voted: this.voted,
    };
    try { this.renderer.render(rs); } catch (err) { console.error('[werewolf] render 실패', err); }
  }

  private sync(): void {
    if (this.isHost) this.ctx.sendToPeer(encodeSync(this.state));
  }

  // ============================================
  // 클라 → (호스트) 입력
  // ============================================

  private doReady(): void {
    if (this.confirmedDeal) return;
    this.confirmedDeal = true;
    if (this.isHost) this.handleReady(this.myPeerId);
    else this.ctx.sendToPeer(encodeReady(this.myPeerId));
    this.render();
  }

  private doNightAct(a: NightAction): void {
    if (isTerminalAction(a)) this.actedNight = true;
    if (this.isHost) this.handleAct(this.myPeerId, a);
    else this.ctx.sendToPeer(encodeAct(this.myPeerId, a));
    this.render();
  }

  private doChat(text: string): void {
    const nick = this.myNick();
    if (this.isHost) this.relayChat(this.myPeerId, nick, text);
    else this.ctx.sendToPeer(encodeChat(this.myPeerId, nick, text));
  }

  private doVote(target: string): void {
    if (this.voted) return;
    this.voted = true;
    if (this.isHost) this.handleVote(this.myPeerId, target);
    else this.ctx.sendToPeer(encodeVote(this.myPeerId, target));
    this.render();
  }

  // ============================================
  // 호스트: deal 페이즈
  // ============================================

  /** 랜덤 모드: 호스트가 카드 구성을 고르는 setup 페이즈. 기본값 = 공식 조합. */
  private startSetupAsHost(players: { peerId: string; nickname: string }[]): void {
    this.setupDeck = [...setupFor(players.length)];
    this.state = {
      phase: 'setup', players, setup: [...this.setupDeck], readyCount: 0,
      nightRole: null, nightStep: 0, nightTotal: 0, chatLog: [], reveal: null,
    };
    this.sync();
    this.render();
  }

  private setupAdd(role: Role): void {
    if (!this.isHost || this.state.phase !== 'setup') return;
    // 늑대만 다중 허용. 나머지는 최대 1장. 카드 수는 인원+3 초과 못 함.
    if (role !== 'wolf' && this.setupDeck.filter((r) => r === role).length >= 1) return;
    if (this.setupDeck.length >= this.pendingPlayers.length + CENTER_COUNT) return;
    this.setupDeck.push(role);
    this.state.setup = [...this.setupDeck];
    this.render();
  }

  private setupRemove(role: Role): void {
    if (!this.isHost || this.state.phase !== 'setup') return;
    const i = this.setupDeck.lastIndexOf(role);
    if (i >= 0) this.setupDeck.splice(i, 1);
    this.state.setup = [...this.setupDeck];
    this.render();
  }

  private setupStart(): void {
    if (!this.isHost || this.state.phase !== 'setup') return;
    const check = validateFreeSetup(this.setupDeck, this.pendingPlayers.length);
    if (!check.ok) { this.render(); return; } // 카드 수/중복 위반 시 시작 불가 (경고는 무시 가능)
    this.startDealAsHost(this.pendingPlayers, [...this.setupDeck]);
  }

  private startDealAsHost(players: { peerId: string; nickname: string }[], deck: Role[] = setupFor(players.length)): void {
    this.deal = dealCards(players.map((p) => p.peerId), deck, () => Math.random());
    this.nightSteps = nightStepsForSetup(deck);
    this.state = {
      phase: 'deal',
      players,
      setup: deck,
      readyCount: 0,
      nightRole: null,
      nightStep: 0,
      nightTotal: this.nightSteps.length,
      chatLog: [],
      reveal: null,
    };
    // 각자에게 처음 역할 전송 (호스트 자신 포함)
    for (const p of players) {
      if (p.peerId === this.myPeerId) this.myOrigRole = this.deal.origRole[p.peerId]!;
      else if (!isDummy(p.peerId)) this.ctx.sendToPeer(encodeRole(this.deal.origRole[p.peerId]!), { target: p.peerId });
      // 더미는 즉시 준비 완료 처리
      if (isDummy(p.peerId)) this.readySet.add(p.peerId);
    }
    this.state.readyCount = this.readySet.size;
    this.phaseDeadline = performance.now() + DEAL_TIMEOUT_MS;
    this.sync();
    this.render();
    sound.play('pop');
    // 각자 자기 역할 카드를 확인하고 "확인했어요" 버튼을 눌러야 밤으로 진행.
    // 솔로 프리뷰도 봇 2명은 자동 ready(위 readySet)라 사람이 버튼만 누르면 바로 넘어간다.
    this.maybeStartNight();
  }

  private handleReady(from: string): void {
    if (this.state.phase !== 'deal') return;
    this.readySet.add(from);
    this.state.readyCount = this.readySet.size;
    this.sync();
    this.maybeStartNight();
  }

  private maybeStartNight(): void {
    if (this.state.phase !== 'deal') return;
    const allReady = this.state.players.every((p) => this.readySet.has(p.peerId));
    if (allReady) this.startNight();
  }

  // ============================================
  // 호스트: 밤 엔진
  // ============================================

  private startNight(): void {
    if (this.state.phase !== 'deal') return;
    this.state.phase = 'night';
    this.stepIdx = 0;
    this.hostNightLog = [];
    this.hostSwapLog = [];
    this.dgCopy = {};
    this.sync();
    this.beginStep();
  }

  private beginStep(): void {
    if (this.state.phase !== 'night') return;
    if (this.stepIdx >= this.nightSteps.length) { this.startDay(); return; }
    this.stepAdvancing = false;
    this.stepChosen.clear();
    this.stepDone.clear();
    const role = this.nightSteps[this.stepIdx]!;
    this.state.nightRole = role;
    this.state.nightStep = this.stepIdx + 1;

    const actors = this.actorsOf(role);
    if (actors.length === 0) {
      // 카드가 가운데에만 있음 — 잠깐 대기 후 다음 (정보 은폐)
      this.sync();
      this.render();
      const mask = MASK_MIN_MS + Math.random() * (MASK_MAX_MS - MASK_MIN_MS);
      this.phaseDeadline = performance.now() + mask;
      return;
    }

    // 늑대: 시작하자마자 동료 정보 배포
    if (role === 'wolf') {
      const wolfIds = actors;
      const solo = wolfIds.length === 1;
      for (const w of wolfIds) {
        const others = wolfIds.filter((x) => x !== w);
        this.sendMemo(w, { kind: 'wolves', peerIds: others, solo });
      }
    }
    // 불면증: 시작하자마자 최종 카드 알려줌 (마지막 스텝이라 교환 모두 반영됨)
    if (role === 'insomniac') {
      for (const a of actors) this.sendMemo(a, { kind: 'insomniac', role: this.deal.curCard[a]! });
    }
    // 하수인: 늑대(처음 늑대였던 사람들) 목록 확인. 늑대는 하수인을 모름(단방향).
    if (role === 'minion') {
      const wolves = this.actorsOf('wolf');
      for (const a of actors) this.sendMemo(a, { kind: 'minionWolves', peerIds: wolves });
    }
    // 메이슨: 서로 확인 (혼자면 아무도 안 보임)
    if (role === 'mason') {
      const solo = actors.length === 1;
      for (const m of actors) this.sendMemo(m, { kind: 'masons', peerIds: actors.filter((x) => x !== m), solo });
    }

    this.phaseDeadline = performance.now() + NIGHT_STEP_MS;
    this.sync();
    this.render();
    this.scheduleDummies();
  }

  /** 이번 스텝에서 실제로 행동해야 하는 플레이어(= 이 역할을 처음 받은 사람들) */
  private actorsOf(role: Role): string[] {
    return this.state.players.map((p) => p.peerId).filter((pid) => this.deal.origRole[pid] === role);
  }

  private handleAct(from: string, action: NightAction): void {
    if (this.state.phase !== 'night' || this.ended) return;
    const role = this.state.nightRole;
    if (!role) return;
    if (this.deal.origRole[from] !== role) return; // 이 스텝 담당 아님
    if (this.stepDone.has(from)) return;

    switch (action.kind) {
      case 'doppelCopy': {
        if (this.stepChosen.has(from)) return; // 이미 복사함
        const target = action.target;
        if (target === from || !this.deal.origRole[target]) return;
        const copied = this.deal.origRole[target]!; // 도플갱어가 맨 처음이라 target 의 최초 역할 = 현재 역할
        this.dgCopy[from] = copied;
        this.deal.curCard[from] = copied; // 복사 즉시 그 직업이 됨 (승패도 이 카드 기준)
        this.hostSwapLog.push(`도플갱어가 ${this.nickOf(target)}의 직업(${ROLE_META[copied].name})을 복사했어요.`);
        this.sendMemo(from, { kind: 'doppelCopied', target, role: copied });
        // 복사한 직업의 밤 행동을 "즉시" 수행. 정보/무행동 역할은 여기서 처리하고 확인 대기,
        // 행동 역할(예언자/강도/말썽쟁이/주정뱅이)은 후속 액션을 기다린다(stepChosen 안 잠금).
        if (copied === 'wolf' || copied === 'minion') {
          this.sendMemo(from, { kind: 'minionWolves', peerIds: this.actorsOf('wolf') });
          this.stepChosen.add(from);
        } else if (copied === 'mason') {
          const masons = this.actorsOf('mason').filter((x) => x !== from);
          this.sendMemo(from, { kind: 'masons', peerIds: masons, solo: masons.length === 0 });
          this.stepChosen.add(from);
        } else if (copied === 'insomniac') {
          this.sendMemo(from, { kind: 'insomniac', role: this.deal.curCard[from]! });
          this.stepChosen.add(from);
        } else if (copied !== 'seer' && copied !== 'robber' && copied !== 'troublemaker' && copied !== 'drunk') {
          // 마을주민/사냥꾼/탄넬러/도플갱어(중첩 방지) — 행동 없음, 확인만
          this.stepChosen.add(from);
        }
        // 행동 역할이면 stepChosen 을 잠그지 않아 아래 seer/robber/... 액션을 이어서 받는다.
        return;
      }
      case 'wolfPeek': {
        // 혼자 늑대만 유효 — 가운데 1장 엿보기 (완료 아님, 확인 대기)
        if (this.actorsOf('wolf').length !== 1) return;
        const c = clampCenter(action.center);
        this.sendMemo(from, { kind: 'peeked', center: c, role: this.deal.center[c]! });
        this.hostNightLog.push(`혼자인 늑대가 가운데 카드를 확인했어요.`);
        return;
      }
      case 'wolfConfirm':
      case 'insomniacConfirm':
      case 'skip':
        this.markDone(from);
        return;
      case 'seerPlayer': {
        if (this.stepChosen.has(from)) return;
        this.stepChosen.add(from);
        const t = action.target;
        if (this.deal.curCard[t]) this.sendMemo(from, { kind: 'seerPlayer', target: t, role: this.deal.curCard[t]! });
        this.hostNightLog.push(`${this.nickOf(from)}(예언자)가 ${this.nickOf(t)}의 카드를 확인했어요.`);
        return; // 확인(skip) 기다림
      }
      case 'seerCenter': {
        if (this.stepChosen.has(from)) return;
        this.stepChosen.add(from);
        const cs = action.centers.slice(0, 2).map(clampCenter);
        this.sendMemo(from, { kind: 'seerCenter', cards: cs.map((c) => ({ center: c, role: this.deal.center[c]! })) });
        this.hostNightLog.push(`${this.nickOf(from)}(예언자)가 가운데 카드 2장을 확인했어요.`);
        return;
      }
      case 'robber': {
        if (this.stepChosen.has(from)) return;
        this.stepChosen.add(from);
        const t = action.target;
        // 강도: 대상 카드와 내 카드를 맞바꾸고, 바뀐 내 카드 확인
        const mine = this.deal.curCard[from]!;
        this.deal.curCard[from] = this.deal.curCard[t]!;
        this.deal.curCard[t] = mine;
        this.sendMemo(from, { kind: 'robbed', target: t, newRole: this.deal.curCard[from]! });
        this.hostSwapLog.push(`${this.nickOf(from)}(강도)가 ${this.nickOf(t)}의 카드를 가져왔어요.`);
        return; // 확인 기다림
      }
      case 'troublemaker': {
        if (this.stepChosen.has(from)) { this.markDone(from); return; }
        this.stepChosen.add(from);
        const { a, b } = action;
        if (a !== b && this.deal.curCard[a] && this.deal.curCard[b]) {
          const tmp = this.deal.curCard[a]!;
          this.deal.curCard[a] = this.deal.curCard[b]!;
          this.deal.curCard[b] = tmp;
          this.hostSwapLog.push(`말썽쟁이가 ${this.nickOf(a)} ↔ ${this.nickOf(b)}의 카드를 맞바꿨어요.`);
        }
        this.markDone(from); // 눈 감고 하는 행동 — 즉시 완료
        return;
      }
      case 'drunk': {
        if (this.stepChosen.has(from)) { this.markDone(from); return; }
        this.stepChosen.add(from);
        const c = clampCenter(action.center);
        const mine = this.deal.curCard[from]!;
        this.deal.curCard[from] = this.deal.center[c]!;
        this.deal.center[c] = mine;
        this.hostSwapLog.push(`${this.nickOf(from)}(주정뱅이)가 가운데 카드와 자기 카드를 바꿨어요.`);
        this.markDone(from);
        return;
      }
    }
  }

  private markDone(from: string): void {
    this.stepDone.add(from);
    this.maybeAdvanceStep();
  }

  private maybeAdvanceStep(): void {
    if (this.state.phase !== 'night' || this.stepAdvancing) return;
    const actors = this.actorsOf(this.state.nightRole!);
    if (actors.every((a) => this.stepDone.has(a))) this.advanceStep();
  }

  /** 시간초과 — 미완료 actor 를 강제 완료하고 진행 */
  private forceCompleteStep(): void {
    if (this.state.phase !== 'night') return;
    for (const a of this.actorsOf(this.state.nightRole!)) this.stepDone.add(a);
    this.advanceStep();
  }

  private advanceStep(): void {
    if (this.stepAdvancing) return;
    this.stepAdvancing = true;
    this.stepIdx += 1;
    sound.play('button_click');
    this.beginStep();
  }

  // ============================================
  // 호스트: 낮 → 투표 → 결과
  // ============================================

  private startDay(): void {
    this.state.phase = 'day';
    this.state.nightRole = null;
    this.phaseDeadline = performance.now() + this.dayMs;
    this.sync();
    this.render();
    sound.play('pop');
    this.scheduleDummies();
  }

  private relayChat(from: string, nickname: string, text: string): void {
    const clean = text.trim().slice(0, 200);
    if (!clean) return;
    const line: ChatLine = { peerId: from, nickname, text: clean };
    this.state.chatLog.push(line);
    if (this.state.chatLog.length > 60) this.state.chatLog.shift();
    this.sync();
    this.render();
  }

  private startVote(): void {
    this.state.phase = 'vote';
    this.hostVotes = {};
    this.phaseDeadline = performance.now() + VOTE_MS;
    this.sync();
    this.render();
    this.scheduleDummies();
  }

  private handleVote(from: string, target: string): void {
    if (this.state.phase !== 'vote') return;
    if (!this.state.players.some((p) => p.peerId === from)) return;
    if (!this.state.players.some((p) => p.peerId === target)) return;
    this.hostVotes[from] = target;
    this.maybeResolveVote();
  }

  private maybeResolveVote(): void {
    if (this.state.phase !== 'vote') return;
    const allVoted = this.state.players.every((p) => p.peerId in this.hostVotes);
    if (allVoted) this.resolveVote();
  }

  private resolveVote(): void {
    if (this.state.phase !== 'vote' || this.ended) return;
    const seats = this.state.players.map((p) => p.peerId);
    const finalRoles: Record<string, Role> = {};
    for (const s of seats) finalRoles[s] = this.deal.curCard[s]!;
    // 최다 득표 처형 → 사냥꾼 연쇄 처형 → 승패 판정 (최종 카드 기준)
    const base = tallyVotes(this.hostVotes, seats).executed;
    const executed = resolveHunterDeaths(base, this.hostVotes, finalRoles);
    const { winningTeam, winners } = computeWin(finalRoles, executed);
    // 사냥꾼 연쇄로 추가 처형이 있었으면 로그에 표시
    const extra = executed.filter((p) => !base.includes(p));
    const hunterLog = extra.map((p) => `사냥꾼이 지목했던 ${this.nickOf(p)}도 함께 처형됐어요.`);

    const reveal: RevealData = {
      finalRoles,
      origRoles: { ...this.deal.origRole },
      center: [...this.deal.center],
      votes: { ...this.hostVotes },
      executed,
      winningTeam,
      winners,
      nightLog: [...this.hostNightLog, ...hunterLog],
      swapLog: [...this.hostSwapLog],
    };
    this.state.phase = 'result';
    this.state.reveal = reveal;
    this.phaseDeadline = 0;
    this.sync();
    this.render();
    sound.play(winningTeam === 'village' ? 'pop' : 'button_click');
    this.finishAsHost(reveal);
  }

  // ============================================
  // 종료
  // ============================================

  private finishAsHost(reveal: RevealData): void {
    if (this.ended) return;
    this.ended = true;
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId || isDummy(p.peerId)) continue;
      this.ctx.sendToPeer(
        encodeEnd(this.resultFor(reveal, p.peerId, p.role === 'spectator')),
        { target: p.peerId },
      );
    }
    this.scheduleEnd(this.resultFor(reveal, this.myPeerId, this.isSpectator), RESULT_SHOW_MS);
  }

  private resultFor(reveal: RevealData, peerId: string, spectator: boolean): GameResult {
    const myFinal = reveal.finalRoles[peerId];
    const myTeam = myFinal ? teamOf(myFinal) : null;
    // winners 목록이 최종 권위 (탄넬러 단독승/하수인 포함/무승부 등 팀 비교로 안 잡히는 경우 커버)
    const iWon = !spectator && reveal.winners.includes(peerId);
    return {
      winner: spectator ? null : (iWon ? 'me' : 'opponent'),
      summary: {
        gameId: 'werewolf',
        winningTeam: reveal.winningTeam,
        myTeam,
        myFinalRole: myFinal ?? null,
        myFinalRoleName: myFinal ? ROLE_META[myFinal].name : null,
      },
    };
  }

  private scheduleEnd(result: GameResult, delay = RESULT_SHOW_MS): void {
    if (this.endScheduled) return;
    this.endScheduled = true;
    window.setTimeout(() => {
      if (this.destroyed) return;
      this.ctx.endGame(result);
    }, this.isHost ? delay : END_DELAY_MS);
  }

  // ============================================
  // 더미 AI (솔로 프리뷰)
  // ============================================

  private scheduleDummies(): void {
    if (!this.isHost || this.ended) return;
    if (!this.state.players.some((p) => isDummy(p.peerId))) return;
    if (this.dummyTimer !== null) return;
    this.dummyTimer = window.setTimeout(() => {
      this.dummyTimer = null;
      if (this.destroyed || this.ended) return;
      this.driveDummies();
    }, DUMMY_DELAY_MS);
  }

  private driveDummies(): void {
    const dummies = this.state.players.filter((p) => isDummy(p.peerId)).map((p) => p.peerId);
    if (this.state.phase === 'night') {
      const role = this.state.nightRole!;
      for (const d of dummies) {
        if (this.deal.origRole[d] !== role || this.stepDone.has(d)) continue;
        this.dummyNightAct(d, role);
      }
    } else if (this.state.phase === 'vote') {
      for (const d of dummies) {
        if (d in this.hostVotes) continue;
        const others = this.state.players.map((p) => p.peerId).filter((x) => x !== d);
        this.handleVote(d, pick(others));
      }
    } else if (this.state.phase === 'day') {
      // 낮엔 가끔 한 마디 (분위기용) — 한 번만
      const d = dummies[0];
      if (d && this.state.chatLog.length < 2) {
        const nm = this.state.players.find((p) => p.peerId === d)!.nickname;
        this.relayChat(d, nm, pick(DUMMY_CHATS));
      }
    }
  }

  private dummyNightAct(d: string, role: Role): void {
    const others = this.state.players.map((p) => p.peerId).filter((x) => x !== d);
    switch (role) {
      case 'doppelganger':
        this.handleAct(d, { kind: 'doppelCopy', target: pick(others) });
        this.markDone(d); break; // 복사만 하고 후속 행동은 생략(봇)
      case 'wolf':
        this.markDone(d); break; // 동료 확인/혼자면 엿보기 생략하고 확인
      case 'seer':
        this.handleAct(d, { kind: 'seerPlayer', target: pick(others) });
        this.markDone(d); break;
      case 'robber':
        this.handleAct(d, { kind: 'robber', target: pick(others) });
        this.markDone(d); break;
      case 'troublemaker': {
        const two = shufflePick(others, 2);
        if (two.length === 2) this.handleAct(d, { kind: 'troublemaker', a: two[0]!, b: two[1]! });
        else this.markDone(d);
        break;
      }
      case 'drunk':
        this.handleAct(d, { kind: 'drunk', center: Math.floor(Math.random() * CENTER_COUNT) });
        break;
      case 'insomniac':
      default:
        this.markDone(d); break;
    }
  }

  // ============================================
  // 호스트 헬퍼
  // ============================================

  /** 밤 정보 전달 (호스트 보관 + 대상에게). 대상이 호스트 자신이면 로컬 memos 에 push */
  private sendMemo(peerId: string, info: NightInfo): void {
    (this.hostMemos[peerId] ??= []).push(info);
    if (peerId === this.myPeerId) { this.memos.push(info); this.render(); }
    else if (!isDummy(peerId)) this.ctx.sendToPeer(encodeNightInfo(info), { target: peerId });
  }

  /** 합류/재요청한 peer 에게 현재 상태 + 역할 + 밤 메모 재전송 */
  private sendStateTo(peerId: string): void {
    this.ctx.sendToPeer(encodeSync(this.state), { target: peerId });
    if (this.deal && this.deal.origRole[peerId]) {
      this.ctx.sendToPeer(encodeRole(this.deal.origRole[peerId]!), { target: peerId });
    }
    for (const m of this.hostMemos[peerId] ?? []) {
      this.ctx.sendToPeer(encodeNightInfo(m), { target: peerId });
    }
  }

  private myNick(): string {
    return this.ctx.players.find((p) => p.peerId === this.myPeerId)?.nickname ?? this.ctx.myNickname ?? '나';
  }

  /** peerId → 닉네임 (결과 로그용). */
  private nickOf(peerId: string): string {
    return this.state.players.find((p) => p.peerId === peerId)?.nickname ?? '?';
  }
}

// ============================================
// 모듈 밖 헬퍼
// ============================================

function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

function emptyState(): PublicState {
  return { phase: 'deal', players: [], setup: [], readyCount: 0, nightRole: null, nightStep: 0, nightTotal: 0, chatLog: [], reveal: null };
}

function isDummy(peerId: string): boolean {
  return peerId.startsWith(DUMMY_PREFIX);
}

function isTerminalAction(a: NightAction): boolean {
  return a.kind === 'wolfConfirm' || a.kind === 'insomniacConfirm' || a.kind === 'skip'
    || a.kind === 'troublemaker' || a.kind === 'drunk';
}

function clampCenter(c: number): number {
  return Math.max(0, Math.min(CENTER_COUNT - 1, Math.floor(c)));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function shufflePick<T>(arr: T[], n: number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

export function createWerewolfGame(): GameModule {
  return new WerewolfModule();
}
