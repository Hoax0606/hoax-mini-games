/**
 * 포트리스 GameModule — 조립
 *
 * 아키텍처 (호스트 authoritative + 결정론적 궤적 재생):
 *   - 지형: seed 로 각 클라가 동일 생성(generateTerrain) + 크레이터 순차 적용.
 *   - 발사: 발사자가 fr:fire(각도/파워/시작좌표/바람) broadcast → 모든 클라가
 *           같은 파라미터로 포탄 궤적 애니 재생.
 *   - 착탄: 호스트가 궤적 시뮬로 착탄점 확정 → fr:impact(크레이터+HP+다음턴/바람)
 *           broadcast → 지형/HP 동기화. (부동소수 오차와 무관하게 확정값 일치)
 *
 * 입력: 자기 차례에 드래그(반대 방향 발사) — 알까기/다트와 동일 규약.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  createInitialGame, applyBlast, advanceTurn, fortCenterY,
  WEAPONS, hasAmmo, spendAmmo,
  type FortressGame, type Fort, type WeaponId,
} from './rules';
import {
  generateTerrain, carveCrater, terrainTopAt,
} from './terrain';
import {
  launchVelocity, stepProjectile, MAX_WIND, type Projectile,
} from './physics';
import {
  FortressRenderer, type RenderState,
} from './render';
import {
  encodeHello, decodeHello,
  encodeSync, decodeSync,
  encodeFire, decodeFire,
  encodeImpact, decodeImpact,
  encodeEnd, decodeEnd,
  type Crater,
} from './netSync';

const SIM_DT = 1 / 120;          // 궤적 sub-step (정확한 착탄)
const END_GAME_DELAY_MS = 1800;
const MAX_DRAG_PX = 200;         // 이 이상 당기면 파워 100%
/** 포신 발사 시작점 — 포대 중심에서 위로 */
const MUZZLE_RISE = 13;
/** 한 턴 제한 시간(ms). 안 쏘면 호스트가 턴을 넘겨 무한 정지 방지 */
const TURN_TIME_MS = 30_000;
/** 게스트가 'firing' 상태로 이 시간 넘게 갇히면 재동기화 요청 (착탄 메시지 유실/중간합류 복구) */
const FIRING_WATCHDOG_MS = 8_000;

class FortressGameModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: FortressRenderer;
  private game!: FortressGame;
  private hm: number[] = [];
  private craters: Crater[] = [];

  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  /** 게스트가 호스트 지형/상태 sync 를 받았는지 — 받기 전엔 조준·발사 금지(지형 불일치 방지) */
  private ready = false;

  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;
  private endGameScheduled = false;
  private lastFrameTime = 0;

  // 궤적
  private projectile: Projectile | null = null;
  private fireWind = 0;
  /** 지금 날아가는 포탄의 무기 (착탄 폭발 파라미터 결정) */
  private flyingWeapon: WeaponId = 'normal';
  /** 내가 선택한 무기 (무기 바) */
  private selectedWeapon: WeaponId = 'normal';
  /** 무기 바 DOM */
  private weaponBar: HTMLDivElement | null = null;

  /** 현재 aiming 턴 시작 시각 (호스트만 사용 — 타임아웃 스킵 판정) */
  private turnStartedAt = 0;
  /** firing 진입 시각 (게스트 워치독용) */
  private firingStartedAt = 0;

  // 드래그 조준
  private aiming = false;
  private aimFromX = 0;
  private aimFromY = 0;
  private mouseX: number | null = null;
  private mouseY: number | null = null;

  private paused = false;
  private pauseStart = 0;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    const playerList = ctx.players.filter((p) => p.role === 'player');
    const ordered = orderPlayersHostFirst(playerList);

    // 호스트가 seed/바람 결정 (게스트는 sync 로 덮어씀)
    const seed = this.isHost ? (Math.floor(Math.random() * 2 ** 31) || 1) : 1;
    const wind0 = this.isHost ? this.randomWind() : 0;
    const fortsPerPlayer = Math.max(1, Math.min(3, Number(ctx.roomOptions['fortsPerPlayer']) || 1));
    this.game = createInitialGame(
      ordered.map((p) => ({ peerId: p.peerId, nickname: p.nickname })),
      seed, wind0, fortsPerPlayer,
    );
    this.hm = generateTerrain(this.game.seed, this.game.terrainWidth);
    this.ready = this.isHost; // 호스트는 자기 생성이라 즉시 준비. 게스트는 sync 후.

    this.renderer = new FortressRenderer({ canvas: ctx.canvas });
    ctx.canvas.style.cursor = 'crosshair';
    this.attachInput();
    if (!this.isSpectator) this.mountWeaponBar();
    sound.startBgm('battle-tetris'); // 긴장감 BGM 재활용

    if (!this.isHost) this.ctx.sendToPeer(encodeHello(this.myPeerId));

    this.lastFrameTime = performance.now();
    this.turnStartedAt = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost) {
        this.ctx.sendToPeer(encodeSync({ game: this.game, craters: this.craters }), { target: hello.peerId });
      }
      return;
    }

    const sync = decodeSync(msg);
    if (sync) {
      if (!this.isHost) {
        this.game = sync.game;
        this.craters = sync.craters;
        this.hm = generateTerrain(this.game.seed, this.game.terrainWidth);
        for (const c of this.craters) carveCrater(this.hm, c.cx, c.cy, c.r);
        this.projectile = null;
        this.ready = true; // 호스트 지형/상태 동기화 완료 — 이제 조준 허용
        this.turnStartedAt = performance.now(); // 타이머 표시 기준 리셋
        // 합류 시점에 호스트가 발사 중이면 포탄을 못 받으니 워치독으로 재동기화되게 시각 기록
        this.firingStartedAt = this.game.phase === 'firing' ? performance.now() : 0;
        if (this.weaponBar) this.buildWeaponButtons(); // 동기화된 실제 로드아웃으로 갱신
      }
      return;
    }

    const fire = decodeFire(msg);
    if (fire) {
      // 차례 검증 — 현재 턴 포대가 aiming 상태에서 보낸 발사만 재생한다.
      //   (차례 아닌 발사를 받아들이면 호스트가 엉뚱한 포대 기준으로 턴을 넘겨 꼬임)
      //   발사자 자신은 로컬에서 이미 firing 이라 여기 안 걸림(중복 방지).
      if (this.game.phase === 'aiming' && fire.fromFortId === this.game.currentTurn) {
        // 발사자 탄약 차감 (모든 클라 동일하게 — 결정론적)
        const shooter = this.game.forts.find((f) => f.id === fire.fromFortId);
        if (shooter) spendAmmo(this.game, shooter.ownerPeerId, fire.weapon);
        this.beginProjectile(fire.startX, fire.startY, fire.angleRad, fire.power01, fire.wind, fire.weapon);
      }
      return;
    }

    const impact = decodeImpact(msg);
    if (impact) {
      if (!this.isHost) this.applyImpactLocal(impact);
      return;
    }

    const end = decodeEnd(msg);
    if (end) {
      this.scheduleEndGame(end);
      return;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.gameFinished = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.detachInput();
    this.weaponBar?.remove();
    this.weaponBar = null;
    if (this.ctx?.canvas) this.ctx.canvas.style.cursor = '';
    this.renderer?.destroy();
    sound.stopBgm();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.pauseStart = performance.now();
      this.aiming = false;
    } else if (this.pauseStart > 0) {
      this.lastFrameTime += performance.now() - this.pauseStart;
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

    if (!this.paused && this.projectile && this.game.phase === 'firing') {
      const elapsed = Math.min(0.1, (now - this.lastFrameTime) / 1000);
      let remaining = elapsed;
      while (remaining > 0 && this.projectile) {
        const dt = Math.min(SIM_DT, remaining);
        stepProjectile(this.projectile, this.fireWind, dt);
        remaining -= dt;
        if (this.checkImpact()) break; // 착탄 시 처리 후 종료
      }
    }

    if (!this.paused && !this.gameFinished) {
      // 호스트: 현재 플레이어가 제한 시간 내 안 쏘면 턴 스킵 (무한 정지 방지)
      if (this.isHost && this.game.phase === 'aiming' && now - this.turnStartedAt > TURN_TIME_MS) {
        this.skipTurnAsHost();
      }
      // 게스트: firing 상태로 너무 오래 갇히면 (착탄 유실/중간합류) 재동기화 요청
      if (!this.isHost && this.ready && this.game.phase === 'firing'
        && this.firingStartedAt > 0 && now - this.firingStartedAt > FIRING_WATCHDOG_MS) {
        this.firingStartedAt = now; // 재요청 간격 확보
        this.ctx.sendToPeer(encodeHello(this.myPeerId));
      }
    }

    this.lastFrameTime = now;

    this.renderer.render(this.buildRenderState(now));
  };

  /** 호스트: 시간 초과한 현재 턴을 발사 없이 넘긴다. 착탄 없는 impact(변화 0)로 전원 동기화. */
  private skipTurnAsHost(): void {
    const nextWind = this.randomWind();
    advanceTurn(this.game, nextWind, performance.now());
    this.turnStartedAt = performance.now();
    this.ctx.sendToPeer(encodeImpact({
      blasts: [], hp: this.hpMap(), ended: false,
      nextTurn: this.game.currentTurn, nextWind, winnerPeerIds: [],
    }));
    this.refreshWeaponBar();
    sound.play('button_click');
  }

  private buildRenderState(now: number): RenderState {
    let aim: RenderState['aim'] = null;
    if (this.aiming && this.mouseX !== null && this.mouseY !== null) {
      // 드래그 길이 → 파워(0~1). 조준 원뿔 길이/색에 사용. onUp 발사 공식과 동일.
      const dx = this.mouseX - this.aimFromX;
      const dy = this.mouseY - this.aimFromY;
      const power01 = Math.min(1, Math.hypot(dx, dy) / MAX_DRAG_PX);
      aim = { fromX: this.aimFromX, fromY: this.aimFromY, mx: this.mouseX, my: this.mouseY, power01 };
    }
    return {
      game: this.game,
      hm: this.hm,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      projectile: this.projectile ? { x: this.projectile.x, y: this.projectile.y } : null,
      aim,
      now,
      // 턴 타이머 표시용 — 각 클라 로컬 시각(자기 시계 기준). 호스트가 실제 타임아웃 판정.
      turnStartedAt: this.turnStartedAt,
      turnTimeMs: TURN_TIME_MS,
    };
  }

  /** 착탄 판정 (호스트만 확정). 착탄했으면 true. */
  private checkImpact(): boolean {
    const p = this.projectile;
    if (!p) return false;

    // 화면 밖으로 크게 이탈 → 빗나감 (호스트만 처리, 게스트는 impact 대기)
    const off = p.x < -60 || p.x > this.game.terrainWidth + 60 || p.y > 440;
    const hitGround = p.y >= terrainTopAt(this.hm, p.x);
    let hitFort = false;
    for (const f of this.game.forts) {
      if (!f.alive) continue;
      if (Math.hypot(f.x - p.x, fortCenterY(this.hm, f) - p.y) < 12) { hitFort = true; break; }
    }

    if (!off && !hitGround && !hitFort) return false;

    // 착탄 — 호스트만 확정 broadcast. 게스트는 궤적만 멈춤.
    if (this.isHost) {
      this.handleImpactAsHost(p.x, Math.min(p.y, terrainTopAt(this.hm, p.x)), off && !hitGround && !hitFort);
    } else {
      this.projectile = null; // 게스트: 궤적 정지, impact 대기
    }
    return true;
  }

  // ============================================
  // 발사 (입력)
  // ============================================

  private attachInput(): void {
    this.ctx.canvas.addEventListener('mousedown', this.onDown);
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
  }
  private detachInput(): void {
    if (this.ctx?.canvas) this.ctx.canvas.removeEventListener('mousedown', this.onDown);
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
  }

  /** 현재 차례 포대 (내 소유일 때만 조준 가능) */
  private currentFort(): Fort | undefined {
    return this.game.forts.find((f) => f.id === this.game.currentTurn);
  }

  private canAim(): boolean {
    if (!this.ready || this.isSpectator || this.paused || this.game.phase !== 'aiming' || this.projectile) return false;
    const cf = this.currentFort();
    return !!cf && cf.ownerPeerId === this.myPeerId;
  }

  // ============================================
  // 무기 바 UI (canvas 아래 HTML)
  // ============================================

  private mountWeaponBar(): void {
    const parent = this.ctx.canvas.parentElement;
    if (!parent) return;
    const bar = document.createElement('div');
    bar.className = 'fortress-weapon-bar';
    parent.appendChild(bar);
    this.weaponBar = bar;
    // 이벤트 위임 — 버튼 클릭 시 무기 선택
    bar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.fw-btn');
      if (!btn || btn.disabled) return;
      const w = btn.dataset.weapon as WeaponId;
      if (!hasAmmo(this.game, this.myPeerId, w)) return;
      this.selectedWeapon = w;
      this.refreshWeaponBar();
      sound.play('button_click');
    });
    this.buildWeaponButtons();
  }

  /** 내 로드아웃(일반탄 + 특수 2종)으로 버튼 재생성. sync 로 로드아웃 바뀌면 다시 호출. */
  private buildWeaponButtons(): void {
    if (!this.weaponBar) return;
    const specials = Object.keys(this.game.ammo[this.myPeerId] ?? {}) as WeaponId[];
    const list: WeaponId[] = ['normal', ...specials];
    this.weaponBar.innerHTML = list
      .map((w) => {
        const s = WEAPONS[w];
        return `<button class="fw-btn" data-weapon="${w}">
          <span class="fw-icon">${s.icon}</span>
          <span class="fw-name">${s.name}</span>
          <span class="fw-ammo"></span>
        </button>`;
      })
      .join('');
    if (!list.includes(this.selectedWeapon)) this.selectedWeapon = 'normal';
    this.refreshWeaponBar();
  }

  /** 잔탄/선택/활성 상태 갱신 (내 차례 아니면 전체 비활성) */
  private refreshWeaponBar(): void {
    if (!this.weaponBar) return;
    const cf = this.currentFort();
    const isMyTurn = this.game.phase === 'aiming' && !this.isSpectator
      && !!cf && cf.ownerPeerId === this.myPeerId;
    const btns = this.weaponBar.querySelectorAll<HTMLButtonElement>('.fw-btn');
    btns.forEach((btn) => {
      const w = btn.dataset.weapon as WeaponId;
      const left = w === 'normal' ? Infinity : (this.game.ammo[this.myPeerId]?.[w] ?? 0);
      const ammoEl = btn.querySelector('.fw-ammo');
      if (ammoEl) ammoEl.textContent = w === 'normal' ? '∞' : `×${left}`;
      const empty = left <= 0;
      const disabled = !isMyTurn || empty;
      btn.disabled = disabled;
      btn.classList.toggle('disabled', disabled);
      btn.classList.toggle('selected', w === this.selectedWeapon && !empty);
    });
  }

  private onDown = (e: MouseEvent): void => {
    if (!this.canAim()) return;
    const me = this.currentFort();
    if (!me) return;
    this.aiming = true;
    this.aimFromX = me.x;
    this.aimFromY = fortCenterY(this.hm, me) - MUZZLE_RISE;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
    this.mouseX = x; this.mouseY = y;
  };

  private onMove = (e: MouseEvent): void => {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);
    this.mouseX = x; this.mouseY = y;
  };

  private onUp = (): void => {
    if (!this.aiming) return;
    this.aiming = false;
    if (this.mouseX === null || this.mouseY === null) return;
    const dx = this.mouseX - this.aimFromX;
    const dy = this.mouseY - this.aimFromY;
    const dragLen = Math.hypot(dx, dy);
    if (dragLen < 8) return; // 너무 짧음 — 발사 취소

    // 발사 무기 결정 — 잔탄 없으면 일반탄으로 폴백 (UI 가 막지만 방어적)
    const me = this.currentFort();
    const ownerPeerId = me?.ownerPeerId ?? this.myPeerId;
    let weapon = this.selectedWeapon;
    if (!hasAmmo(this.game, ownerPeerId, weapon)) weapon = 'normal';
    const spec = WEAPONS[weapon];
    // 유도탄은 바람 무시 — 발사 wind 를 0 으로 보내 모든 클라가 동일 궤적 재생
    const effWind = spec.ignoreWind ? 0 : this.game.wind;

    // 발사 방향 = 당긴 반대. 각도(위가 +) = atan2(dy, -dx)
    const angleRad = Math.atan2(dy, -dx);
    const power01 = Math.min(1, dragLen / MAX_DRAG_PX);

    // 로컬 즉시 시작 + broadcast (게스트/호스트 공통)
    this.beginProjectile(this.aimFromX, this.aimFromY, angleRad, power01, effWind, weapon);
    spendAmmo(this.game, ownerPeerId, weapon);
    if (!hasAmmo(this.game, ownerPeerId, weapon)) this.selectedWeapon = 'normal'; // 소진 시 기본 복귀
    this.ctx.sendToPeer(encodeFire({
      fromFortId: this.game.currentTurn,
      startX: this.aimFromX, startY: this.aimFromY,
      angleRad, power01, wind: effWind, weapon,
    }));
    this.refreshWeaponBar();
  };

  private beginProjectile(sx: number, sy: number, angleRad: number, power01: number, wind: number, weapon: WeaponId): void {
    const { vx, vy } = launchVelocity(angleRad, power01);
    this.projectile = { x: sx, y: sy, vx, vy };
    this.fireWind = wind;
    this.flyingWeapon = weapon;
    this.game.phase = 'firing';
    this.lastFrameTime = performance.now();
    this.firingStartedAt = performance.now();
    sound.play('mallet_hit', { intensity: 0.5 });
  }

  // ============================================
  // 착탄 처리
  // ============================================

  private handleImpactAsHost(cx: number, cy: number, isMiss: boolean): void {
    const spec = WEAPONS[this.flyingWeapon];
    const blasts: Crater[] = [];
    let blast: { hp: Record<number, number>; ended: boolean };
    if (isMiss) {
      blast = { hp: this.hpMap(), ended: false };
    } else {
      const craterR = spec.craterRadius;
      carveCrater(this.hm, cx, cy, craterR);
      this.craters.push({ cx, cy, r: craterR });
      blasts.push({ cx, cy, r: craterR });
      blast = applyBlast(this.game, this.hm, cx, cy, spec.blastRadius, spec.maxDamage);
    }
    this.projectile = null;

    const nextWind = this.randomWind();
    if (blast.ended) {
      this.ctx.sendToPeer(encodeImpact({
        blasts, hp: blast.hp, ended: true,
        nextTurn: -1, nextWind, winnerPeerIds: this.game.winnerPeerIds,
      }));
      this.finishAsHost();
    } else {
      advanceTurn(this.game, nextWind, performance.now());
      this.turnStartedAt = performance.now(); // 다음 턴 타임아웃 카운트 리셋
      this.ctx.sendToPeer(encodeImpact({
        blasts, hp: blast.hp, ended: false,
        nextTurn: this.game.currentTurn, nextWind, winnerPeerIds: [],
      }));
      this.refreshWeaponBar();
    }
    sound.play('tetris_garbage');
  }

  /** 게스트: 확정 impact 반영 */
  private applyImpactLocal(p: ReturnType<typeof decodeImpact>): void {
    if (!p) return;
    for (const b of p.blasts) {
      carveCrater(this.hm, b.cx, b.cy, b.r);
      this.craters.push({ cx: b.cx, cy: b.cy, r: b.r });
    }
    for (const f of this.game.forts) {
      const hp = p.hp[f.id];
      if (hp !== undefined) { f.hp = hp; f.alive = hp > 0; }
    }
    this.projectile = null;
    if (p.ended) {
      this.game.phase = 'ended';
      this.game.winnerPeerIds = p.winnerPeerIds;
    } else if (p.nextTurn !== -1) {
      this.game.currentTurn = p.nextTurn;
      this.game.wind = p.nextWind;
      this.game.phase = 'aiming';
      this.turnStartedAt = performance.now(); // 새 턴 타이머 표시 리셋
      this.refreshWeaponBar();
    }
    sound.play('tetris_garbage');
  }

  private hpMap(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const f of this.game.forts) out[f.id] = f.hp;
    return out;
  }

  private randomWind(): number {
    return Math.round((Math.random() * 2 - 1) * MAX_WIND);
  }

  // ============================================
  // 종료
  // ============================================

  private finishAsHost(): void {
    if (this.gameFinished) return;
    this.gameFinished = true;
    const winners = this.game.winnerPeerIds;
    // 플레이어(소유자) 단위 집계 — 남은 포대 총 HP 합으로 순위. (포대 여러 개 대응)
    const byOwner = new Map<string, { nickname: string; hp: number; alive: boolean }>();
    for (const f of this.game.forts) {
      const e = byOwner.get(f.ownerPeerId) ?? { nickname: f.ownerNickname, hp: 0, alive: false };
      e.hp += f.hp;
      if (f.alive) e.alive = true;
      byOwner.set(f.ownerPeerId, e);
    }
    const coWinnerNicknames = [...new Set(this.game.forts
      .filter((f) => winners.includes(f.ownerPeerId)).map((f) => f.ownerNickname))];
    const rankings = [...byOwner.entries()]
      .sort((a, b) => (b[1].alive ? 1 : 0) - (a[1].alive ? 1 : 0) || b[1].hp - a[1].hp)
      .map(([peerId, e], i) => ({ peerId, nickname: e.nickname, hp: e.hp, rank: i + 1 }));
    const baseSummary: Record<string, unknown> = {
      gameId: 'fortress',
      isCoWin: winners.length >= 2,
      coWinnerNicknames,
      rankings,
    };
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      this.ctx.sendToPeer(
        encodeEnd({ winner: this.winnerFor(p), summary: { ...baseSummary, myPeerId: p.peerId } }),
        { target: p.peerId },
      );
    }
    this.scheduleEndGame({
      winner: this.winnerFor({ peerId: this.myPeerId, nickname: '', isHost: true, role: 'player' }),
      summary: { ...baseSummary, myPeerId: this.myPeerId },
    });
  }

  private winnerFor(p: Player): GameResult['winner'] {
    if (this.game.winnerPeerIds.length === 0) return null; // 무승부
    if (p.role === 'spectator') return 'opponent';
    return this.game.winnerPeerIds.includes(p.peerId) ? 'me' : 'opponent';
  }

  private scheduleEndGame(result: GameResult): void {
    if (this.endGameScheduled) return;
    this.endGameScheduled = true;
    window.setTimeout(() => {
      if (this.destroyed) return;
      this.ctx.endGame(result);
    }, END_GAME_DELAY_MS);
  }
}

function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

export function createFortressGame(): GameModule {
  return new FortressGameModule();
}
