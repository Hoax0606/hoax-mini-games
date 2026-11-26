/**
 * 스페이스 크루 — 협동 트릭테이킹
 *
 * 호스트 authoritative. 호스트가 섞고, 나눠주고, 트릭 승자와 임무 완료/실패를 판정한다.
 * 게스트는 "이 카드를 내겠다" 같은 의도만 보낸다.
 *
 * ⚠️ 이 게임의 전부는 **남의 손패를 모르는 것**이다.
 *    sync 를 만들 때 받는 사람 손패만 숫자로 담고 나머지는 장수만 보낸다.
 *    호스트 자기 화면도 같은 함수를 통과시킨다 — 예외를 두면 호스트만 다 보이는
 *    상태가 되는데, 화면만 봐선 티가 안 난다.
 *
 * 캠페인은 한 방에서 연속으로 돈다. 미션을 깨면 결과 화면으로 나가지 않고
 * 게임 안에서 다음 미션으로 넘어간다. 진행도는 호스트 브라우저에 저장한다.
 */

import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import {
  buildDeck, shuffle, dealCounts, trickCount, sortHand, commanderOf,
  canPlay, trickWinnerIndex, commSlotsFor, judgeTrick, sameCard, COLOR_SUITS, COLOR_MAX,
  type Card, type CommSlot, type Suit, type Task,
} from './rules';
import { missionFor, type MissionSpec } from './missions';
import {
  encodeHello, decodeHello, encodePickTask, decodePickTask, encodePlay, decodePlay,
  encodeComm, decodeComm, encodeNext, decodeNext, encodeSync, decodeSync, encodeEnd, decodeEnd,
  type Phase, type SyncPayload, type CommView,
} from './netSync';
import { ScRenderer } from './render';
import { storage } from '../../core/storage';
import { sound } from '../../core/sound';

const HELLO_RETRY_MS = 1_500;
/** 트릭이 끝나고 카드를 걷기 전에 보여주는 시간 */
const TRICK_HOLD_MS = 1_400;
const END_DELAY_MS = 1_600;
/** 캠페인 진행도 저장 키 */
const PROGRESS_KEY = 'hoax:spacecrew:mission';

/** 호스트 브라우저에 저장된 "다음에 할 미션" */
function savedMission(): number {
  const raw = Number(localStorage.getItem(PROGRESS_KEY));
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}
function saveMission(n: number): void {
  try { localStorage.setItem(PROGRESS_KEY, String(n)); } catch { /* 사생활 모드 등 — 무시 */ }
}

export function createSpaceCrew(): GameModule {
  let ctx: GameContext | null = null;
  let renderer: ScRenderer | null = null;
  let destroyed = false;

  // ---- 호스트 전용 ----
  let seats: { peerId: string; nickname: string }[] = [];
  let hands: Record<string, Card[]> = {};
  let commanderId = '';
  let turnPeerId = '';
  let phase: Phase = 'brief';
  let mission = 1;
  let spec: MissionSpec = missionFor(1);
  let tasks: Task[] = [];
  /** 아직 아무도 안 고른 임무 (pick 단계) */
  let taskPool: Task[] = [];
  let pickCount = 0;
  let trick: { peerId: string; card: Card }[] = [];
  let led: Suit | null = null;
  let trickNo = 0;
  let trickTotal = 0;
  let comms: CommView[] = [];
  /** 아직 통신을 안 쓴 사람 */
  let commLeft = new Set<string>();
  let result: { ok: boolean; reason: string } | null = null;
  let news = '';
  /** brief/over 단계에서 "다음" 을 누른 사람들 — 전원이 눌러야 넘어간다 */
  let readySet = new Set<string>();
  let clearedCount = 0;
  let holdTimer: number | undefined;

  // ---- 게스트 전용 ----
  let helloTimer: number | undefined;
  let lastSync: SyncPayload | null = null;

  const me = (): string => ctx!.myPlayerId;
  const isHost = (): boolean => ctx?.role === 'host';
  const nickOf = (peerId: string): string =>
    seats.find((s) => s.peerId === peerId)?.nickname ?? '';

  // ============================================
  // 호스트 — 미션 준비
  // ============================================

  function seatPlayers(all: Player[]): { peerId: string; nickname: string }[] {
    return all
      .filter((p) => p.role !== 'spectator')
      .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));
  }

  /** 미션 하나를 처음부터 차린다 (재도전도 같은 길) */
  function setupMission(): void {
    spec = missionFor(mission);
    const deck = shuffle(buildDeck());
    const counts = dealCounts(seats.length);
    hands = {};
    let at = 0;
    seats.forEach((s, i) => {
      hands[s.peerId] = sortHand(deck.slice(at, at + counts[i]!));
      at += counts[i]!;
    });

    commanderId = commanderOf(hands) ?? seats[0]!.peerId;
    trickTotal = trickCount(seats.length);
    trickNo = 0;
    trick = [];
    led = null;
    comms = [];
    commLeft = new Set(seats.map((s) => s.peerId));
    result = null;
    readySet = new Set();

    // 임무 카드는 색 카드에서만 뽑는다 (로켓엔 임무가 없다)
    const colorCards: Card[] = [];
    for (const suit of COLOR_SUITS) for (let n = 1; n <= COLOR_MAX; n++) colorCards.push({ suit, num: n });
    const picked = shuffle(colorCards).slice(0, spec.taskCount);
    // 순서 토큰은 앞에서부터 spec.orderedCount 개에 붙인다
    taskPool = picked.map((card, i) => ({
      card,
      ownerId: null,
      order: i < spec.orderedCount ? i + 1 : null,
      done: false,
    }));
    tasks = taskPool.slice();
    pickCount = 0;

    phase = 'brief';
    news = `미션 ${mission}`;
    broadcast();
  }

  function beginPick(): void {
    phase = 'pick';
    pickCount = 0;
    turnPeerId = commanderId;
    news = '임무를 고르세요';
    broadcast();
  }

  /** 사령관부터 시계방향 */
  function advancePicker(): void {
    const ci = seats.findIndex((s) => s.peerId === commanderId);
    pickCount += 1;
    if (taskPool.length === 0) { beginPlay(); return; }
    turnPeerId = seats[(ci + pickCount) % seats.length]!.peerId;
    broadcast();
  }

  function beginPlay(): void {
    phase = 'play';
    trickNo = 1;
    trick = [];
    led = null;
    turnPeerId = commanderId;
    news = '';
    broadcast();
  }

  // ============================================
  // 호스트 — 게스트 의도 처리
  // ============================================

  function onPickTask(from: string, index: number): void {
    if (phase !== 'pick' || from !== turnPeerId) return;
    const t = taskPool[index];
    if (!t) return;
    t.ownerId = from;
    taskPool.splice(index, 1);
    news = `${nickOf(from)} 님이 임무를 맡았어요`;
    advancePicker();
  }

  function onPlay(from: string, card: Card): void {
    if (phase !== 'play' || from !== turnPeerId) return;
    const hand = hands[from];
    if (!hand || !canPlay(hand, led, card)) return;

    hands[from] = hand.filter((c) => !sameCard(c, card));
    trick.push({ peerId: from, card });
    if (led === null) led = card.suit;

    // 공개해둔 통신 카드를 낸 거면 토큰을 빨강으로
    const cm = comms.find((c) => c.peerId === from && sameCard(c.card, card));
    if (cm) cm.spent = true;

    if (trick.length < seats.length) {
      const i = seats.findIndex((s) => s.peerId === from);
      turnPeerId = seats[(i + 1) % seats.length]!.peerId;
      broadcast();
      return;
    }
    settleTrick();
  }

  /** 트릭이 다 찼다 — 승자를 정하고 임무를 판정한다 */
  function settleTrick(): void {
    const winnerIdx = trickWinnerIndex(trick.map((t) => t.card), led!);
    const winner = trick[winnerIdx]!.peerId;
    const outcome = judgeTrick(tasks, trick.map((t) => t.card), winner);

    if (outcome.failed) {
      for (const t of outcome.completed) t.done = true;
      news = outcome.failed === 'wrong-winner'
        ? `${nickOf(winner)} 님이 남의 임무 카드를 가져갔어요`
        : '임무 순서가 틀렸어요';
      finishMission(false, news);
      return;
    }
    for (const t of outcome.completed) t.done = true;
    if (outcome.completed.length > 0) sound.play('button_click');

    news = `${nickOf(winner)} 님이 가져갔어요`;
    broadcast();

    // 카드를 바로 걷으면 뭐가 나왔는지 볼 틈이 없다
    holdTimer = window.setTimeout(() => {
      if (destroyed) return;
      if (outcome.allDone) { finishMission(true, '임무를 모두 끝냈어요!'); return; }
      if (trickNo >= trickTotal) { finishMission(false, '트릭이 다 끝났는데 임무가 남았어요'); return; }
      trick = [];
      led = null;
      trickNo += 1;
      turnPeerId = winner; // 이긴 사람이 다음 리드
      broadcast();
    }, TRICK_HOLD_MS);
  }

  function finishMission(ok: boolean, reason: string): void {
    phase = 'over';
    result = { ok, reason };
    readySet = new Set();
    if (ok) {
      clearedCount += 1;
      mission += 1;
      saveMission(mission);
    }
    news = reason;
    broadcast();
  }

  function onComm(from: string, card: Card, slot: CommSlot): void {
    if (phase !== 'play' || spec.commBanned) return;
    if (!commLeft.has(from)) return;
    if (trick.length > 0) return;                       // 트릭 진행 중엔 불가
    if (trickNo <= spec.commBlockTricks) return;        // 앞 N트릭 차단
    const hand = hands[from];
    if (!hand) return;
    const slots = commSlotsFor(hand, card);
    if (slots.length === 0) return;                     // 최고·최저·유일 중 하나여야 한다
    if (!spec.deadZone && !slots.includes(slot)) return; // 거짓 위치는 못 쓴다

    commLeft.delete(from);
    comms.push({ peerId: from, card, slot: spec.deadZone ? null : slot, spent: false });
    news = `${nickOf(from)} 님이 통신했어요`;
    broadcast();
  }

  function onNext(from: string, go: boolean): void {
    if (phase !== 'brief' && phase !== 'over') return;
    if (!go) { endCampaign(); return; }                 // 그만하기는 누구나

    readySet.add(from);
    if (readySet.size < seats.length) { broadcast(); return; }

    if (phase === 'brief') { beginPick(); return; }
    setupMission();                                      // 성공이면 다음, 실패면 재도전
  }

  function endCampaign(): void {
    if (holdTimer !== undefined) window.clearTimeout(holdTimer);
    phase = 'over';
    broadcast();

    // 협동 게임이라 순위가 없다. 전원 같은 결과를 본다.
    const resultFor = (): GameResult => ({
      winner: clearedCount > 0 ? 'me' : null,
      summary: {
        gameId: 'space-crew',
        cleared: clearedCount,
        reached: mission,
        players: seats.length,
      },
    });
    for (const p of ctx!.players) {
      if (p.peerId === me()) continue;
      ctx!.sendToPeer(encodeEnd(resultFor()), { target: p.peerId });
    }
    window.setTimeout(() => {
      if (destroyed) return;
      ctx!.endGame(resultFor());
    }, END_DELAY_MS);
  }

  // ============================================
  // 호스트 — 송신
  // ============================================

  /** 한 사람 몫 sync. 남의 손패는 장수만 */
  function syncFor(viewerId: string): SyncPayload {
    return {
      phase,
      mission,
      taskCount: spec.taskCount,
      orderMode: spec.orderMode,
      commBlockTricks: spec.commBlockTricks,
      deadZone: spec.deadZone,
      commBanned: spec.commBanned,
      players: seats.map((s) => ({
        peerId: s.peerId,
        nickname: s.nickname,
        handCount: hands[s.peerId]?.length ?? 0,
        commLeft: commLeft.has(s.peerId),
      })),
      commanderId,
      turnPeerId,
      myHand: hands[viewerId] ?? [],
      tasks: tasks.map((t) => ({ card: t.card, ownerId: t.ownerId, order: t.order, done: t.done })),
      trick: trick.slice(),
      led,
      trickNo,
      trickTotal,
      comms: comms.slice(),
      result,
      news,
    };
  }

  function broadcast(): void {
    if (destroyed || !ctx) return;
    for (const p of ctx.players) {
      const payload = syncFor(p.peerId);
      if (p.peerId === me()) applySync(payload);   // 호스트 자기 화면도 같은 경로
      else ctx.sendToPeer(encodeSync(payload), { target: p.peerId });
    }
  }

  function applySync(s: SyncPayload): void {
    lastSync = s;
    if (helloTimer !== undefined) { window.clearInterval(helloTimer); helloTimer = undefined; }
    renderer?.render(s, me());
  }

  // ============================================
  // GameModule
  // ============================================

  return {
    start(c: GameContext) {
      ctx = c;
      destroyed = false;

      renderer = new ScRenderer(c.canvas, {
        onPickTask: (i) => isHost() ? onPickTask(me(), i) : ctx!.sendToPeer(encodePickTask(me(), i)),
        onPlay: (card) => isHost() ? onPlay(me(), card) : ctx!.sendToPeer(encodePlay(me(), card)),
        onComm: (card, slot) => isHost() ? onComm(me(), card, slot) : ctx!.sendToPeer(encodeComm(me(), card, slot)),
        onNext: (go) => isHost() ? onNext(me(), go) : ctx!.sendToPeer(encodeNext(me(), go)),
      });

      if (c.role === 'host') {
        seats = seatPlayers(c.players);
        // 방 옵션: 이어하기(기본) / 1부터 새로
        mission = c.roomOptions['start'] === 'new' ? 1 : savedMission();
        clearedCount = 0;
        setupMission();
      } else {
        ctx.sendToPeer(encodeHello(me()));
        helloTimer = window.setInterval(() => {
          if (destroyed || lastSync) return;
          ctx!.sendToPeer(encodeHello(me()));
        }, HELLO_RETRY_MS);
      }
    },

    onPeerMessage(msg: GameMessage) {
      if (destroyed || !ctx) return;

      if (isHost()) {
        const hello = decodeHello(msg);
        if (hello) { ctx.sendToPeer(encodeSync(syncFor(hello.from)), { target: hello.from }); return; }
        const pick = decodePickTask(msg);
        if (pick) { onPickTask(pick.from, pick.index); return; }
        const play = decodePlay(msg);
        if (play) { onPlay(play.from, play.card); return; }
        const comm = decodeComm(msg);
        if (comm) { onComm(comm.from, comm.card, comm.slot); return; }
        const next = decodeNext(msg);
        if (next) { onNext(next.from, next.go); return; }
        return;
      }

      const s = decodeSync(msg);
      if (s) { applySync(s); return; }
      const end = decodeEnd(msg);
      if (end) { ctx.endGame(end); return; }
    },

    /**
     * 협동 게임이라 한 명이 빠지면 그 판은 성립하지 않는다(그 사람 손패와 임무가 통째로 사라짐).
     * 남은 인원으로 같은 미션을 다시 차린다.
     */
    onPeerLeft(peerId: string) {
      if (!isHost() || destroyed) return;
      const i = seats.findIndex((s) => s.peerId === peerId);
      if (i < 0) return;
      seats.splice(i, 1);
      if (seats.length < 3) { endCampaign(); return; }
      if (holdTimer !== undefined) window.clearTimeout(holdTimer);
      news = '한 명이 나가서 미션을 다시 시작해요';
      setupMission();
    },

    destroy() {
      destroyed = true;
      if (holdTimer !== undefined) window.clearTimeout(holdTimer);
      if (helloTimer !== undefined) window.clearInterval(helloTimer);
      holdTimer = helloTimer = undefined;
      renderer?.destroy();
      renderer = null;
      ctx = null;
    },
  };
}
