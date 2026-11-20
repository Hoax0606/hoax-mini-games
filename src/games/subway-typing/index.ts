/**
 * 지하철 타자 — 노선 하나를 골라 역 이름을 순서대로 치는 레이스
 *
 * 타이핑 자체는 각자 로컬에서 굴린다. 키 입력을 호스트로 넘기면 지연 때문에 손맛이 죽는다.
 * 호스트는 진행 보고(sb:progress/done)를 모아 순위만 판정한다.
 *
 * 역 통과 판정은 **입력값이 역 이름과 정확히 같아지는 순간** 자동으로 넘어간다.
 * 엔터를 안 치게 한 건 실제 타자 게임들이 그렇고, 한 글자라도 덜 누르는 게 빠르기 때문.
 */

import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import {
  buildCourse, parseRoute, destLabel,
  isOnTrack, isComplete, emptyRecord, kpm, rankSort,
  type Direction, type Record as SbRecord,
} from './rules';
import { SubwayRenderer } from './render';
import {
  encodeHello, decodeHello, encodeStart, decodeStart,
  encodeProgress, decodeProgress, encodeDone, decodeDone,
  encodeStandings, decodeStandings, encodeEnd, decodeEnd,
  type Standing,
} from './netSync';
import { sound } from '../../core/sound';

const COUNTDOWN_MS = 3_000;
/** 1등이 들어온 뒤 남은 사람을 기다려주는 시간 */
const GRACE_MS = 25_000;
const HELLO_RETRY_MS = 1_500;
const END_DELAY_MS = 1_200;

interface Seat {
  peerId: string;
  nickname: string;
}

class SubwayTypingModule implements GameModule {
  private ctx!: GameContext;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  private destroyed = false;
  private paused = false;
  private pauseAt = 0;

  private renderer: SubwayRenderer | null = null;
  private rafId: number | null = null;

  private lineName = '2호선';
  private dir: Direction = 'down';
  private course: string[] = [];

  /** 출발 시각 (performance.now 기준). 카운트다운이 끝나는 순간 */
  private startAt = 0;
  private typed = '';
  private me: SbRecord = emptyRecord();
  private finished = false;

  private standings: Standing[] = [];
  private lastHelloAt = 0;
  private syncedOnce = false;

  // --- 호스트 전용 ---
  private seats: Seat[] = [];
  private leftPeers = new Set<string>();
  private records = new Map<string, SbRecord>();
  private firstDoneAt = 0;
  private ended = false;

  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    const route = parseRoute(ctx.roomOptions['route']);
    this.lineName = route.lineName;
    this.dir = route.dir;

    this.renderer = new SubwayRenderer(ctx.canvas, {
      onType: (v) => this.onType(v),
    });
    sound.startBgm('apple-game');

    if (this.isHost) {
      this.seats = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'))
        .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));
      this.records = new Map(this.seats.map((s) => [s.peerId, emptyRecord()]));
      this.course = buildCourse(this.lineName, this.dir);
      this.startAt = performance.now() + COUNTDOWN_MS;
      this.ctx.sendToPeer(encodeStart({
        lineName: this.lineName,
        dir: this.dir,
        countdownMs: COUNTDOWN_MS,
      }));
      this.pushStandings();
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

  setPaused(paused: boolean): void {
    // 멈춘 동안은 출발 시각을 밀어서 기록이 손해 안 나게 한다
    if (paused && !this.paused) this.pauseAt = performance.now();
    if (!paused && this.paused) this.startAt += performance.now() - this.pauseAt;
    this.paused = paused;
  }

  // ============================================

  private loop = (): void => {
    if (this.destroyed) return;
    const now = performance.now();

    if (!this.isHost && !this.syncedOnce && now - this.lastHelloAt > HELLO_RETRY_MS) {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
      this.lastHelloAt = now;
    }
    if (this.isHost && !this.paused) this.tickHost(now);

    const countdown = Math.max(0, this.startAt - now);
    if (this.renderer) {
      this.renderer.render({
        lineName: this.lineName,
        dest: destLabel(this.lineName, this.dir),
        course: this.course,
        index: this.me.index,
        typed: this.typed,
        mistakes: this.me.mistakes,
        chars: this.me.chars,
        countdownMs: countdown,
        elapsedMs: this.elapsed(now),
        standings: this.standings,
        myPeerId: this.myPeerId,
        isSpectator: this.isSpectator,
        finished: this.finished,
      });
      if (countdown <= 0 && !this.finished && !this.isSpectator) this.renderer.focus();
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private elapsed(now: number): number {
    if (this.me.timeMs !== null) return this.me.timeMs;
    return Math.max(0, now - this.startAt);
  }

  private tickHost(now: number): void {
    if (this.ended) return;
    const active = this.seats.filter((s) => !this.leftPeers.has(s.peerId));
    if (active.length === 0) return;
    const allDone = active.every((s) => (this.records.get(s.peerId)?.timeMs ?? null) !== null);
    // 전원 완주했거나, 1등 나온 뒤 유예 시간이 지나면 끝
    if (allDone || (this.firstDoneAt > 0 && now - this.firstDoneAt > GRACE_MS)) {
      this.finishAsHost();
    }
  }

  // ============================================
  // 입력
  // ============================================

  private onType(value: string): void {
    if (this.finished || this.isSpectator) return;
    if (performance.now() < this.startAt) return; // 카운트다운 중엔 안 받는다

    const target = this.course[this.me.index] ?? '';
    // 글자가 늘어난 만큼만 타수로 센다 (지우고 다시 치는 건 안 쳐준다)
    if (value.length > this.typed.length) this.me.chars += value.length - this.typed.length;

    const wasOk = isOnTrack(this.typed, target);
    const nowOk = isOnTrack(value, target);
    // 멀쩡하다가 길을 벗어난 순간에만 오타 1회 (틀린 채로 계속 치는 건 추가로 안 센다)
    if (wasOk && !nowOk) this.me.mistakes++;
    this.typed = value;

    if (isComplete(value, target)) {
      this.me.index++;
      this.typed = '';
      this.renderer?.clearInput();
      sound.play('tetris_lock');
      if (this.me.index >= this.course.length) this.completeRace();
      else this.report();
    }
  }

  private completeRace(): void {
    this.finished = true;
    this.me.timeMs = Math.max(0, performance.now() - this.startAt);
    sound.play('tetris_tetris');
    if (this.isHost) this.hostDone(this.myPeerId, this.me.timeMs, this.me.chars, this.me.mistakes);
    else this.ctx.sendToPeer(encodeDone(this.myPeerId, this.me.timeMs, this.me.chars, this.me.mistakes));
  }

  private report(): void {
    if (this.isHost) this.hostProgress(this.myPeerId, this.me.index, this.me.chars, this.me.mistakes);
    else this.ctx.sendToPeer(encodeProgress(this.myPeerId, this.me.index, this.me.chars, this.me.mistakes));
  }

  // ============================================
  // 호스트 집계
  // ============================================

  private hostProgress(from: string, index: number, chars: number, mistakes: number): void {
    const r = this.records.get(from);
    if (!r || r.timeMs !== null) return;
    r.index = index; r.chars = chars; r.mistakes = mistakes;
    this.pushStandings();
  }

  private hostDone(from: string, timeMs: number, chars: number, mistakes: number): void {
    const r = this.records.get(from);
    if (!r || r.timeMs !== null) return;
    r.index = this.course.length; r.chars = chars; r.mistakes = mistakes; r.timeMs = timeMs;
    if (this.firstDoneAt === 0) this.firstDoneAt = performance.now();
    this.pushStandings();
  }

  private pushStandings(): void {
    this.standings = this.seats
      .filter((s) => !this.leftPeers.has(s.peerId))
      .map((s) => {
        const r = this.records.get(s.peerId) ?? emptyRecord();
        return {
          peerId: s.peerId, nickname: s.nickname,
          index: r.index, chars: r.chars, mistakes: r.mistakes, timeMs: r.timeMs,
        };
      });
    this.ctx.sendToPeer(encodeStandings(this.standings));
  }

  private finishAsHost(): void {
    if (this.ended) return;
    this.ended = true;

    const rows = this.seats
      .filter((s) => !this.leftPeers.has(s.peerId))
      .map((s) => {
        const r = this.records.get(s.peerId) ?? emptyRecord();
        return {
          peerId: s.peerId, nickname: s.nickname,
          timeMs: r.timeMs, index: r.index, chars: r.chars, mistakes: r.mistakes,
          kpm: kpm(r.chars, r.timeMs ?? Math.max(1, performance.now() - this.startAt)),
        };
      })
      .sort(rankSort);
    const rankings = rows.map((r, i) => ({ ...r, rank: i + 1, score: r.timeMs ?? 0 }));

    window.setTimeout(() => {
      if (this.destroyed) return;
      for (const s of this.seats) {
        const mine = rankings.find((r) => r.peerId === s.peerId);
        const result: GameResult = {
          winner: rankings.length < 2 ? null : mine && mine.rank === 1 ? 'me' : 'opponent',
          summary: {
            gameId: 'subway-typing',
            myPeerId: s.peerId,
            rank: mine?.rank ?? rankings.length,
            totalPlayers: rankings.length,
            lineName: `${this.lineName} ${destLabel(this.lineName, this.dir)}`,
            stationCount: this.course.length,
            myTimeMs: mine?.timeMs ?? null,
            myKpm: mine?.kpm ?? 0,
            myMistakes: mine?.mistakes ?? 0,
            rankings,
          },
        };
        if (s.peerId === this.myPeerId) this.ctx.endGame(result);
        else this.ctx.sendToPeer(encodeEnd(result), { target: s.peerId });
      }
    }, END_DELAY_MS);
  }

  // ============================================
  // 수신
  // ============================================

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    if (this.isHost) {
      const hello = decodeHello(msg);
      if (hello) {
        // 늦게 합류한 사람에게도 같은 코스를 내려보낸다
        this.ctx.sendToPeer(encodeStart({
          lineName: this.lineName,
          dir: this.dir,
          countdownMs: Math.max(0, this.startAt - performance.now()),
        }), { target: hello.peerId });
        this.pushStandings();
        return;
      }
      const pg = decodeProgress(msg);
      if (pg) { this.hostProgress(pg.from, pg.index, pg.chars, pg.mistakes); return; }
      const dn = decodeDone(msg);
      if (dn) { this.hostDone(dn.from, dn.timeMs, dn.chars, dn.mistakes); return; }
      return;
    }

    const st = decodeStart(msg);
    if (st) {
      this.syncedOnce = true;
      this.lineName = st.lineName;
      this.dir = st.dir;
      this.course = buildCourse(st.lineName, st.dir);
      this.startAt = performance.now() + st.countdownMs;
      return;
    }
    const sd = decodeStandings(msg);
    if (sd) { this.standings = sd; return; }
    const end = decodeEnd(msg);
    if (end) { this.ctx.endGame(end); return; }
  }

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.destroyed) return;
    this.leftPeers.add(peerId);
    this.records.delete(peerId);
    this.pushStandings();
  }
}

/** 좌석 순서 = 방장 먼저, 나머지는 peerId 사전순 */
function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

export function createSubwayTyping(): GameModule {
  return new SubwayTypingModule();
}
