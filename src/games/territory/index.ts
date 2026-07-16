/**
 * 땅따먹기 GameModule — 호스트 authoritative 실시간 sim.
 *
 * 호스트가 격자(영토/꼬리)·머리·생존을 단독 시뮬(고정 스텝 8Hz)하고 매 틱 스냅샷 broadcast.
 * 게스트는 스냅샷만 렌더하고 방향키 입력(ds:dir)만 보낸다. 죽으면 잠시 후 3×3 리스폰.
 * 시간 종료 시 영토 넓은 순 승.
 */

import type { GameContext, GameMessage, GameModule, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  GW, GH, DIRS, opposite, idx, inBounds,
  newTerritory, claimBlock, clearOwner, countTerritory, floodCapture, findRespawn,
} from './rules';
import {
  encodeHello, decodeHello, encodeSync, decodeSync, gridToStr,
  encodeDir, decodeDir, encodeEnd, decodeEnd,
  type TerritorySnap,
} from './netSync';
import { TerritoryRenderer, type RenderState } from './render';

const TICK_MS = 120;         // 8.3Hz 고정 스텝
const RESPAWN_MS = 2000;
const END_DELAY_MS = 1600;

interface P {
  peerId: string;
  nick: string;
  x: number;
  y: number;
  dir: number;
  pendingDir: number;
  alive: boolean;
  deadUntilGt: number;
  trail: number[];
}

class TerritoryGame implements GameModule {
  private ctx!: GameContext;
  private renderer!: TerritoryRenderer;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;

  // 게스트 뷰
  private snap: TerritorySnap | null = null;
  private lastHelloAt = 0;

  // 호스트 상태
  private terr: number[] = [];
  private trailGrid: number[] = [];
  private ps: P[] = [];
  private startedAt = 0;
  private durationMs = 180_000;
  private phase: 'playing' | 'ended' = 'playing';
  private accum = 0;
  private lastFrame = 0;

  private rafId: number | null = null;
  private destroyed = false;
  private endScheduled = false;
  private paused = false;
  private pauseStart = 0;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    this.renderer = new TerritoryRenderer(ctx.canvas);
    const dur = Number(ctx.roomOptions['duration']);
    this.durationMs = (Number.isFinite(dur) && dur > 0 ? dur : 180) * 1000;

    if (!this.isSpectator) window.addEventListener('keydown', this.onKey);
    sound.startBgm('battle-tetris'); // 긴장감 BGM 재활용

    if (this.isHost) this.initHost();
    else { this.ctx.sendToPeer(encodeHello(this.myPeerId)); this.lastHelloAt = performance.now(); }

    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;
    if (this.isHost) {
      const hello = decodeHello(msg);
      if (hello) { this.ctx.sendToPeer(encodeSync(this.buildSnap()), { target: hello.peerId }); return; }
      const dir = decodeDir(msg);
      if (dir) { this.setPending(dir.from, dir.dir); return; }
      return;
    }
    const sync = decodeSync(msg);
    if (sync) { this.snap = sync; return; }
    const end = decodeEnd(msg);
    if (end) { this.scheduleEnd(end); return; }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    window.removeEventListener('keydown', this.onKey);
    this.renderer?.destroy();
    sound.stopBgm();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.pauseStart = performance.now();
    else if (this.pauseStart > 0) { this.startedAt += performance.now() - this.pauseStart; this.pauseStart = 0; this.lastFrame = performance.now(); }
  }

  // ============================================
  // 입력
  // ============================================
  private onKey = (e: KeyboardEvent): void => {
    let dir = -1;
    switch (e.key) {
      case 'ArrowUp': case 'w': case 'W': dir = 0; break;
      case 'ArrowRight': case 'd': case 'D': dir = 1; break;
      case 'ArrowDown': case 's': case 'S': dir = 2; break;
      case 'ArrowLeft': case 'a': case 'A': dir = 3; break;
      default: return;
    }
    e.preventDefault();
    if (this.paused || this.isSpectator) return;
    if (this.isHost) this.setPending(this.myPeerId, dir);
    else this.ctx.sendToPeer(encodeDir(this.myPeerId, dir));
  };

  private setPending(peerId: string, dir: number): void {
    const p = this.ps.find((pp) => pp.peerId === peerId);
    if (p && p.alive) p.pendingDir = dir;
  }

  // ============================================
  // 루프
  // ============================================
  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;
    const now = performance.now();

    if (this.isHost && !this.paused && this.phase === 'playing') {
      this.accum += now - this.lastFrame;
      if (this.accum > 500) this.accum = 500; // 렉 상한
      while (this.accum >= TICK_MS) { this.tick(now); this.accum -= TICK_MS; }
    }
    this.lastFrame = now;

    if (!this.isHost && !this.snap && now - this.lastHelloAt > 1500) {
      this.lastHelloAt = now;
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }

    if (this.snap) {
      const rs: RenderState = { snap: this.snap, myPeerId: this.myPeerId, now };
      try { this.renderer.render(rs); } catch (err) { console.error('[territory] render', err); }
    }
  };

  // ============================================
  // 호스트 시뮬
  // ============================================
  private initHost(): void {
    const ordered = orderPlayersHostFirst(this.ctx.players.filter((p) => p.role === 'player'));
    this.terr = newTerritory();
    this.trailGrid = new Array<number>(GW * GH).fill(-1);
    this.ps = ordered.slice(0, 6).map((pl) => ({
      peerId: pl.peerId, nick: pl.nickname, x: 0, y: 0, dir: 1, pendingDir: 1,
      alive: true, deadUntilGt: 0, trail: [],
    }));
    // 초기 스폰 (겹치지 않게 findRespawn 순차)
    this.ps.forEach((p, i) => {
      const spot = findRespawn(this.terr);
      claimBlock(this.terr, i, spot.x, spot.y, 1);
      p.x = spot.x; p.y = spot.y; p.dir = Math.floor(Math.random() * 4); p.pendingDir = p.dir;
    });
    this.startedAt = performance.now();
    this.phase = 'playing';
    this.broadcast();
  }

  private tick(now: number): void {
    const gt = now - this.startedAt;
    if (gt >= this.durationMs) { this.endGameAsHost(); return; }

    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i]!;
      if (!p.alive) {
        if (gt >= p.deadUntilGt) this.respawn(i);
        continue;
      }
      this.stepPlayer(i, gt);
    }
    this.broadcast();
  }

  private stepPlayer(i: number, gt: number): void {
    const p = this.ps[i]!;
    // 방향 적용 (180도 반전 금지)
    if (p.pendingDir !== opposite(p.dir)) p.dir = p.pendingDir;
    const nx = p.x + DIRS[p.dir]![0];
    const ny = p.y + DIRS[p.dir]![1];
    if (!inBounds(nx, ny)) { this.die(i, gt); return; }
    const cell = idx(nx, ny);

    // 꼬리 충돌 — 그 꼬리 주인 사망 (자기 꼬리면 자기 사망)
    const tOwner = this.trailGrid[cell]!;
    if (tOwner >= 0) {
      this.die(tOwner, gt);
      if (tOwner === i) return; // 내가 죽음
    }

    p.x = nx; p.y = ny;
    if (this.terr[cell] === i) {
      // 내 영토 복귀 → 꼬리 있으면 캡처
      if (p.trail.length > 0) this.capture(i);
    } else {
      // 밖 → 꼬리 연장
      if (this.trailGrid[cell]! < 0) { this.trailGrid[cell] = i; p.trail.push(cell); }
    }
  }

  private capture(i: number): void {
    const p = this.ps[i]!;
    for (const c of p.trail) { this.terr[c] = i; this.trailGrid[c] = -1; }
    p.trail = [];
    floodCapture(this.terr, i);
    sound.play('pop');
  }

  private die(i: number, gt: number): void {
    const p = this.ps[i]!;
    if (!p.alive) return;
    p.alive = false;
    p.deadUntilGt = gt + RESPAWN_MS;
    for (const c of p.trail) if (this.trailGrid[c] === i) this.trailGrid[c] = -1;
    p.trail = [];
    clearOwner(this.terr, i);
    if (p.peerId === this.myPeerId) sound.play('tetris_topout');
  }

  private respawn(i: number): void {
    const p = this.ps[i]!;
    const spot = findRespawn(this.terr);
    claimBlock(this.terr, i, spot.x, spot.y, 1);
    p.x = spot.x; p.y = spot.y; p.dir = Math.floor(Math.random() * 4); p.pendingDir = p.dir;
    p.alive = true; p.trail = [];
  }

  private buildSnap(): TerritorySnap {
    const gt = this.startedAt > 0 ? performance.now() - this.startedAt : 0;
    return {
      grid: gridToStr(this.terr),
      players: this.ps.map((p, i) => ({
        peerId: p.peerId, nick: p.nick, x: p.x, y: p.y, dir: p.dir,
        alive: p.alive, score: countTerritory(this.terr, i),
      })),
      trails: this.ps.map((p) => [...p.trail]),
      phase: this.phase,
      remainMs: Math.max(0, this.durationMs - gt),
      totalMs: this.durationMs,
    };
  }

  private broadcast(): void {
    this.snap = this.buildSnap();
    this.ctx.sendToPeer(encodeSync(this.snap));
  }

  private endGameAsHost(): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.broadcast();
    const scored = this.ps.map((p, i) => ({ peerId: p.peerId, nick: p.nick, score: countTerritory(this.terr, i) }))
      .sort((a, b) => b.score - a.score);
    let rank = 0, prev = Infinity;
    const rankings = scored.map((r, i) => {
      if (r.score < prev) { rank = i + 1; prev = r.score; }
      return { peerId: r.peerId, nickname: r.nick, rank, score: r.score };
    });
    const total = rankings.length;
    const summaryFor = (peerId: string): Record<string, unknown> => ({
      gameId: 'territory',
      myPeerId: peerId,
      rank: rankings.find((r) => r.peerId === peerId)?.rank ?? total,
      totalPlayers: total,
      cells: GW * GH,
      rankings,
    });
    const winnerFor = (peerId: string): GameResult['winner'] =>
      (rankings.find((r) => r.peerId === peerId)?.rank === 1 ? 'me' : 'opponent');
    for (const pl of this.ctx.players) {
      if (pl.peerId === this.myPeerId) continue;
      this.ctx.sendToPeer(
        encodeEnd({ winner: pl.role === 'spectator' ? 'opponent' : winnerFor(pl.peerId), summary: summaryFor(pl.peerId) }),
        { target: pl.peerId },
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

export function createTerritoryGame(): GameModule {
  return new TerritoryGame();
}
