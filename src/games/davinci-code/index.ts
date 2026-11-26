/**
 * 다빈치 코드 — 숫자를 가리고 서로의 타일을 추리하는 게임
 *
 * 호스트 authoritative. 호스트가 덱을 섞고, 나눠주고, 맞았는지 틀렸는지를 판정한다.
 * 게스트는 "뭘 하고 싶다"만 보낸다. 게스트에겐 애초에 남의 숫자가 없어서 판정 자체가 불가능하다.
 *
 * ⚠️ 이 게임의 전부는 **남의 숫자를 모르는 것**이다.
 *    그래서 sync 를 만들 때 rules.maskFor 를 반드시 통과시킨다. 호스트 자기 화면도 예외 없이.
 *    예외를 하나라도 두면 호스트만 다 보이는 상태가 되는데, 화면만 봐선 티가 안 난다.
 */

import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import {
  JOKER, buildDeck, shuffle, startHandSize, insertIndexFor, insertAt,
  isGuessRight, hasHidden, maskFor, findWinner, nextTurnIndex, parseTurnLimit,
  type DvPlayer, type Tile,
} from './rules';
import {
  encodeHello, decodeHello, encodeDraw, decodeDraw, encodePlace, decodePlace,
  encodeGuess, decodeGuess, encodeContinue, decodeContinue, encodeReveal, decodeReveal,
  encodeSync, decodeSync, encodeEnd, decodeEnd,
  type Phase, type SyncPayload,
} from './netSync';
import { DvRenderer } from './render';
import { sound } from '../../core/sound';

/** 게스트가 hello 를 보내고 sync 가 안 오면 재시도하는 간격 */
const HELLO_RETRY_MS = 1_500;
/** 결과 화면으로 넘어가기 전에 마지막 판을 보여주는 시간 */
const END_DELAY_MS = 1_800;

export function createDavinciCode(): GameModule {
  let ctx: GameContext | null = null;
  let renderer: DvRenderer | null = null;
  let destroyed = false;
  let paused = false;

  // ---- 호스트 전용 상태 ----
  let players: DvPlayer[] = [];
  let pool: Tile[] = [];
  let turnIndex = 0;
  let phase: Phase = 'draw';
  /** 이번 턴에 뽑아서 아직 손에 든 타일. 턴이 끝날 때 열에 들어간다 */
  let drawn: Tile | null = null;
  /**
   * 타일을 열에 넣는 걸 기다리는 순번. 시작 때 여러 명일 수 있어서 큐로 둔다.
   * forcedIndex: 숫자 타일은 규칙으로 자리가 정해져 있고(주인은 확인만), 조커는 null(주인이 고름).
   */
  let placeQueue: { peerId: string; tile: Tile; forcedIndex: number | null }[] = [];
  let news = '';
  let turnLimit = 0;
  let turnStartedAt = 0;
  let turnTimer: number | undefined;
  /** 탈락한 순서(먼저 탈락 = 앞). 결과 순위는 이걸 뒤집어서 만든다 */
  const bustOrder: { peerId: string; nickname: string }[] = [];

  // ---- 게스트 전용 상태 ----
  let helloTimer: number | undefined;
  let lastSync: SyncPayload | null = null;

  const me = (): string => ctx!.myPlayerId;

  // ============================================
  // 호스트 — 판 진행
  // ============================================

  /** 관전자를 뺀 실제 플레이어만 턴 순서에 넣는다 */
  function seatPlayers(all: Player[]): DvPlayer[] {
    return all
      .filter((p) => p.role !== 'spectator')
      .map((p) => ({ peerId: p.peerId, nickname: p.nickname, tiles: [], out: false }));
  }

  function hostStart(): void {
    players = seatPlayers(ctx!.players);
    const deck = shuffle(buildDeck());
    const hand = startHandSize(players.length);

    // 나눠주기 — 숫자 타일은 자리가 정해져 있으니 바로 정렬해서 꽂고,
    // 조커는 주인이 직접 골라야 하니 큐에 쌓아 'place' 단계로 보낸다.
    for (const p of players) {
      for (let i = 0; i < hand; i++) {
        const t = deck.pop();
        if (!t) break;
        if (t.num === JOKER) placeQueue.push({ peerId: p.peerId, tile: t, forcedIndex: null });
        else p.tiles = insertAt(p.tiles, t, insertIndexFor(p.tiles, t));
      }
    }
    pool = deck;
    turnLimit = parseTurnLimit(ctx!.roomOptions['turnLimit']);
    turnIndex = 0;

    if (placeQueue.length > 0) {
      phase = 'place';
      // 시작 때만은 이름을 안 부른다 — 이때 place 는 조커 임자에게만 생기니까
      // "〇〇 님이 놓는 중" 이라고 하면 누가 조커를 받았는지 알려주는 꼴이 된다.
      news = '타일을 정리하는 중이에요';
    } else {
      beginTurn();
    }
    broadcast();
  }

  function placerName(): string {
    const id = placeQueue[0]?.peerId;
    return players.find((p) => p.peerId === id)?.nickname ?? '';
  }

  /** 지금 차례인 사람 */
  function current(): DvPlayer | null {
    return players[turnIndex] ?? null;
  }

  /** 턴 시작 — 풀이 비었으면 뽑기를 건너뛰고 바로 지목 단계로 */
  function beginTurn(): void {
    drawn = null;
    phase = pool.length > 0 ? 'draw' : 'guess';
    turnStartedAt = Date.now();
    armTimer();
  }

  function armTimer(): void {
    clearTimer();
    if (turnLimit <= 0) return;
    turnTimer = window.setTimeout(onTimeout, turnLimit * 1000);
  }
  function clearTimer(): void {
    if (turnTimer !== undefined) window.clearTimeout(turnTimer);
    turnTimer = undefined;
  }

  /** 시간 초과 — 뽑은 게 있으면 공개하고 턴을 넘긴다 */
  function onTimeout(): void {
    if (destroyed || phase === 'done') return;
    const cur = current();
    news = `${cur?.nickname ?? ''} 님의 시간이 다 됐어요`;
    endTurn(true);
  }

  /**
   * 턴 종료. 뽑은 타일을 내 열에 넣는다.
   * @param reveal 틀렸거나 시간 초과면 앞면으로(모두에게 보이게), 멈춘 거면 뒷면으로.
   */
  function endTurn(reveal: boolean): void {
    clearTimer();
    const cur = current();
    if (cur && drawn) {
      const tile: Tile = { ...drawn, revealed: reveal };
      // 조커든 숫자든 똑같이 'place' 를 거친다. 조커만 멈추면 바깥에서
      // "지금 멈췄으니 조커네" 가 들통난다. 숫자 타일은 자리를 미리 정해두고 확인만 받는다.
      placeQueue.push({
        peerId: cur.peerId,
        tile,
        forcedIndex: tile.num === JOKER ? null : insertIndexFor(cur.tiles, tile),
      });
      drawn = null;
      phase = 'place';
      // news 는 건들지 않는다 — "〇〇 님이 틀렸어요" 같은 방금 결과가 살아 있어야 한다.
      // "놓는 중" 은 화면 아래 상태줄이 따로 보여준다.
      broadcast();
      return;
    }
    drawn = null;
    settleBustAndAdvance();
  }

  /** 탈락 판정 → 승자 판정 → 다음 턴 */
  function settleBustAndAdvance(): void {
    for (const p of players) {
      if (!p.out && !hasHidden(p)) {
        p.out = true;
        bustOrder.push({ peerId: p.peerId, nickname: p.nickname });
        news = `${p.nickname} 님 탈락!`;
      }
    }

    const winner = findWinner(players);
    if (winner) { finish(winner); return; }
    if (players.filter((p) => !p.out).length === 0) { finish(null); return; }

    const next = nextTurnIndex(players, turnIndex);
    if (next < 0) { finish(null); return; }
    turnIndex = next;
    beginTurn();
    broadcast();
  }

  function finish(winner: DvPlayer | null): void {
    clearTimer();
    phase = 'done';
    news = winner ? `${winner.nickname} 님이 이겼어요!` : '게임이 끝났어요';
    broadcast();

    // 늦게 탈락할수록 상위. 승자가 1등.
    const ordered = [
      ...(winner ? [{ peerId: winner.peerId, nickname: winner.nickname }] : []),
      ...bustOrder.slice().reverse(),
    ];
    const rankings = ordered.map((r, i) => ({ peerId: r.peerId, nickname: r.nickname, rank: i + 1 }));
    const total = rankings.length;

    // GameResult 는 "내 시점"이라 사람마다 따로 만들어 보낸다 (더 마인드/원카드와 같은 방식)
    const resultFor = (peerId: string): GameResult => ({
      winner: rankings.find((r) => r.peerId === peerId)?.rank === 1 ? 'me' : 'opponent',
      summary: {
        gameId: 'davinci-code',
        myPeerId: peerId,
        rank: rankings.find((r) => r.peerId === peerId)?.rank ?? total,
        totalPlayers: total,
        rankings,
      },
    });

    for (const p of ctx!.players) {
      if (p.peerId === me()) continue;
      ctx!.sendToPeer(encodeEnd(resultFor(p.peerId)), { target: p.peerId });
    }

    window.setTimeout(() => {
      if (destroyed) return;
      ctx!.endGame(resultFor(me()));
    }, END_DELAY_MS);
  }

  // ---- 호스트: 게스트 의도 처리 ----

  function onPlace(fromPeerId: string, index: number): void {
    const pending = placeQueue[0];
    if (!pending || pending.peerId !== fromPeerId) return; // 자기 차례 아님 — 무시
    const p = players.find((x) => x.peerId === fromPeerId);
    if (!p) return;
    // 숫자 타일은 자리가 규칙으로 정해져 있다 — 게스트가 보낸 index 는 무시한다(변조 방지)
    const at = pending.forcedIndex ?? index;
    if (at < 0 || at > p.tiles.length) return;
    p.tiles = insertAt(p.tiles, pending.tile, at);
    placeQueue.shift();

    if (placeQueue.length > 0) {
      news = turnStartedAt === 0
        ? '타일을 정리하는 중이에요'
        : `${placerName()} 님이 타일을 놓는 중이에요`;
      broadcast();
      return;
    }
    // 시작 단계의 조커 배치가 끝났으면 첫 턴을 연다.
    // 턴 중에 뽑은 조커였으면 그 턴은 이미 끝난 것이라 다음 사람으로 넘긴다.
    if (turnStartedAt === 0) { beginTurn(); broadcast(); return; }
    settleBustAndAdvance();
  }

  function onDraw(fromPeerId: string): void {
    const cur = current();
    if (!cur || cur.peerId !== fromPeerId || phase !== 'draw') return;
    drawn = pool.pop() ?? null;
    phase = 'guess';
    broadcast();
  }

  function onGuess(fromPeerId: string, targetPeerId: string, tileIndex: number, num: number): void {
    const cur = current();
    if (!cur || cur.peerId !== fromPeerId) return;
    if (phase !== 'guess') return;
    if (targetPeerId === fromPeerId) return; // 자기 타일은 못 지목

    const target = players.find((p) => p.peerId === targetPeerId);
    const tile = target?.tiles[tileIndex];
    if (!target || target.out || !tile || tile.revealed) return;

    if (isGuessRight(tile, num)) {
      tile.revealed = true;
      news = `${cur.nickname} 님이 ${target.nickname} 님의 타일을 맞혔어요`;
      sound.play('button_click');
      // 맞혀서 상대가 탈락했어도 턴은 계속 쥔다(원작). 다만 승자가 갈렸으면 바로 끝.
      for (const p of players) {
        if (!p.out && !hasHidden(p)) {
          p.out = true;
          bustOrder.push({ peerId: p.peerId, nickname: p.nickname });
        }
      }
      const winner = findWinner(players);
      if (winner) { finish(winner); return; }
      phase = 'continue';
    } else {
      news = `${cur.nickname} 님이 틀렸어요`;
      // 뽑은 게 있으면 그걸 공개, 풀이 비어 못 뽑았으면 내 타일 중 하나를 고르게 한다
      if (drawn) { endTurn(true); return; }
      phase = 'reveal';
    }
    broadcast();
  }

  function onContinue(fromPeerId: string, go: boolean): void {
    const cur = current();
    if (!cur || cur.peerId !== fromPeerId || phase !== 'continue') return;
    if (go) { phase = 'guess'; broadcast(); return; }
    endTurn(false); // 멈춤 — 뽑은 타일은 닫힌 채로
  }

  function onReveal(fromPeerId: string, index: number): void {
    const cur = current();
    if (!cur || cur.peerId !== fromPeerId || phase !== 'reveal') return;
    const tile = cur.tiles[index];
    if (!tile || tile.revealed) return;
    tile.revealed = true;
    settleBustAndAdvance();
  }

  // ---- 호스트: 송신 ----

  /** 한 사람 몫 sync. 반드시 maskFor 를 통과한다 */
  function syncFor(viewerId: string): SyncPayload {
    const cur = current();
    const iAmCurrent = cur?.peerId === viewerId;
    return {
      phase,
      turnPeerId: phase === 'place' ? (placeQueue[0]?.peerId ?? '') : (cur?.peerId ?? ''),
      players: maskFor(players, viewerId),
      poolLeft: pool.length,
      // 뽑은 타일은 뽑은 사람만 본다. 남이 보면 그 턴이 통째로 무의미해진다.
      myDrawn: iAmCurrent && drawn ? { num: drawn.num, color: drawn.color } : null,
      // 놓는 사람 본인에게만. 남이 보면 조커인지 아닌지가 그대로 드러난다.
      myPlacing: placeQueue[0] && placeQueue[0].peerId === viewerId
        ? {
            num: placeQueue[0].tile.num,
            color: placeQueue[0].tile.color,
            forcedIndex: placeQueue[0].forcedIndex,
          }
        : null,
      news,
      turnLimit,
      turnStartedAt,
    };
  }

  function broadcast(): void {
    if (destroyed || !ctx) return;
    for (const p of ctx.players) {
      const payload = syncFor(p.peerId);
      if (p.peerId === me()) applySync(payload);           // 호스트 자기 화면도 같은 경로
      else ctx.sendToPeer(encodeSync(payload), { target: p.peerId });
    }
  }

  // ============================================
  // 공통 — 화면 반영
  // ============================================

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

      renderer = new DvRenderer(c.canvas, {
        onDraw: () => {
          if (ctx!.role === 'host') onDraw(me());
          else ctx!.sendToPeer(encodeDraw(me()));
        },
        onPlace: (index) => {
          if (ctx!.role === 'host') onPlace(me(), index);
          else ctx!.sendToPeer(encodePlace(me(), index));
        },
        onGuess: (targetPeerId, tileIndex, num) => {
          if (ctx!.role === 'host') onGuess(me(), targetPeerId, tileIndex, num);
          else ctx!.sendToPeer(encodeGuess(me(), targetPeerId, tileIndex, num));
        },
        onContinue: (go) => {
          if (ctx!.role === 'host') onContinue(me(), go);
          else ctx!.sendToPeer(encodeContinue(me(), go));
        },
        onReveal: (index) => {
          if (ctx!.role === 'host') onReveal(me(), index);
          else ctx!.sendToPeer(encodeReveal(me(), index));
        },
      });

      if (c.role === 'host') {
        hostStart();
      } else {
        // sync 가 올 때까지 hello 를 재시도한다. 재연결했을 때도 같은 길로 복구된다.
        ctx.sendToPeer(encodeHello(me()));
        helloTimer = window.setInterval(() => {
          if (destroyed || lastSync) return;
          ctx!.sendToPeer(encodeHello(me()));
        }, HELLO_RETRY_MS);
      }
    },

    onPeerMessage(msg: GameMessage) {
      if (destroyed || !ctx) return;

      if (ctx.role === 'host') {
        // 발신자는 payload 안의 from 으로 온다 (GameMessage 에 보낸 사람 필드가 없다)
        const hello = decodeHello(msg);
        if (hello) {
          ctx.sendToPeer(encodeSync(syncFor(hello.peerId)), { target: hello.peerId });
          return;
        }
        const draw = decodeDraw(msg);
        if (draw) { onDraw(draw.from); return; }
        const place = decodePlace(msg);
        if (place) { onPlace(place.from, place.index); return; }
        const guess = decodeGuess(msg);
        if (guess) { onGuess(guess.from, guess.targetPeerId, guess.tileIndex, guess.num); return; }
        const cont = decodeContinue(msg);
        if (cont) { onContinue(cont.from, cont.go); return; }
        const rev = decodeReveal(msg);
        if (rev) { onReveal(rev.from, rev.index); return; }
        return;
      }

      const s = decodeSync(msg);
      if (s) { applySync(s); return; }
      const end = decodeEnd(msg);
      if (end) { ctx.endGame(end); return; }
    },

    /** 나간 사람은 턴 순서에서 빼고, 그 사람 차례였으면 다음으로 넘긴다 */
    onPeerLeft(peerId: string) {
      if (ctx?.role !== 'host' || phase === 'done') return;
      const i = players.findIndex((p) => p.peerId === peerId);
      if (i < 0) return;
      const left = players[i]!;
      news = `${left.nickname} 님이 나갔어요`;
      players.splice(i, 1);
      placeQueue = placeQueue.filter((q) => q.peerId !== peerId);

      if (players.length <= 1) { finish(players[0] ?? null); return; }
      if (i < turnIndex) turnIndex -= 1;
      else if (i === turnIndex) {
        // 나간 사람 차례였다 — 그 턴은 없던 일로 하고 다음 사람에게
        drawn = null;
        turnIndex = turnIndex % players.length;
        const next = nextTurnIndex(players, turnIndex - 1 < 0 ? players.length - 1 : turnIndex - 1);
        if (next < 0) { finish(null); return; }
        turnIndex = next;
        beginTurn();
      }
      broadcast();
    },

    setPaused(p: boolean) {
      paused = p;
      // 일시정지 동안 턴 타이머가 흐르면 억울하게 턴을 뺏긴다
      if (ctx?.role !== 'host') return;
      if (paused) clearTimer();
      else if (phase !== 'done' && turnLimit > 0) armTimer();
    },

    destroy() {
      destroyed = true;
      clearTimer();
      if (helloTimer !== undefined) window.clearInterval(helloTimer);
      helloTimer = undefined;
      renderer?.destroy();
      renderer = null;
      ctx = null;
    },
  };
}
