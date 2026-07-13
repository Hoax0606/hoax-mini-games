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
  encodeMove, decodeMove,
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
/** 분열탄 파편 각 벌림(라디안) */
const SPLIT_SPREAD = 0.30;
/** 수류탄 지형 반사 감쇠 계수 */
const BOUNCE_DAMP = 0.55;
/** 턴당 이동 연료(=이동 가능 px). 턴마다 재충전 */
const FUEL_PER_TURN = 100;
/** 이동 속도 (px/s) */
const MOVE_SPEED = 60;
/** 이동 위치 broadcast 간격(ms) */
const MOVE_BROADCAST_MS = 100;

/** 날아가는 포탄 하나. bounces/fuseLeft 는 수류탄, landed 는 착지 여부 */
interface Shell extends Projectile {
  bounces: number;
  /** 남은 퓨즈(ms). 수류탄만 유의미, 나머지는 Infinity */
  fuseLeft: number;
  landed: boolean;
}

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

  // 궤적 — 여러 포탄(분열탄은 3개 동시)
  private shells: Shell[] = [];
  private fireWind = 0;
  /** 지금 날아가는 포탄의 무기 (착탄 폭발 파라미터 결정) */
  private flyingWeapon: WeaponId = 'normal';
  /** 분열탄이 이번 발사에서 이미 분열했는지 */
  private splitDone = false;
  /** 호스트: 이번 발사에서 누적된 폭발(분열탄 여러 개) */
  private pendingBlasts: Crater[] = [];
  /** 호스트: 이번 발사로 게임이 끝났는지 */
  private pendingEnded = false;
  /** 내가 선택한 무기 (무기 바) */
  private selectedWeapon: WeaponId = 'normal';
  /** 무기 바 DOM */
  private weaponBar: HTMLDivElement | null = null;
  /** 이동 바 DOM */
  private moveBar: HTMLDivElement | null = null;
  /** 남은 이동 연료(px). 턴마다 FUEL_PER_TURN 으로 재충전 */
  private fuelLeft = FUEL_PER_TURN;
  /** 이동 방향: -1 왼쪽 / 0 정지 / 1 오른쪽 (버튼 홀드) */
  private moveDir: -1 | 0 | 1 = 0;
  /** 마지막 이동 위치 broadcast 시각 */
  private moveBroadcastAt = 0;
  /** window mouseup 이동정지 핸들러 (cleanup 용) */
  private moveReleaseHandler: (() => void) | null = null;

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
    this.fuelLeft = FUEL_PER_TURN;
    if (!this.isSpectator) {
      this.mountMoveBar();
      this.mountWeaponBar();
    }
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
        this.shells = [];
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

    const mv = decodeMove(msg);
    if (mv) {
      // 현재 턴 포대의 이동만 반영 (다른 포대 이동은 무시)
      if (mv.fromFortId === this.game.currentTurn) {
        const f = this.game.forts.find((ff) => ff.id === mv.fromFortId);
        if (f) f.x = mv.x;
      }
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
    this.moveBar?.remove();
    this.moveBar = null;
    if (this.moveReleaseHandler) {
      window.removeEventListener('mouseup', this.moveReleaseHandler);
      this.moveReleaseHandler = null;
    }
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
      // 정지 동안 흐른 시간을 각 기준 시각에 더해 보정 —
      //   안 그러면 턴 타이머/워치독이 정지 시간까지 세서 재개 즉시 턴 스킵됨.
      const delta = performance.now() - this.pauseStart;
      this.lastFrameTime += delta;
      this.turnStartedAt += delta;
      if (this.firingStartedAt > 0) this.firingStartedAt += delta;
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

    if (!this.paused && this.shells.length && this.game.phase === 'firing') {
      const elapsed = Math.min(0.1, (now - this.lastFrameTime) / 1000);
      let remaining = elapsed;
      while (remaining > 0 && this.shells.length && this.game.phase === 'firing') {
        const dt = Math.min(SIM_DT, remaining);
        this.stepShells(dt);
        remaining -= dt;
      }
    }

    // 포대 이동 (◀▶ 홀드 중 + 내 차례 + 연료 남음)
    if (!this.paused && this.moveDir !== 0 && this.canMove()) {
      const cf = this.currentFort();
      if (cf) {
        const frameDt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
        let dx = this.moveDir * MOVE_SPEED * frameDt;
        if (Math.abs(dx) > this.fuelLeft) dx = this.moveDir * this.fuelLeft; // 연료 한도
        this.fuelLeft = Math.max(0, this.fuelLeft - Math.abs(dx));
        const margin = 30;
        cf.x = Math.max(margin, Math.min(this.game.terrainWidth - margin, cf.x + dx));
        if (now - this.moveBroadcastAt > MOVE_BROADCAST_MS) {
          this.ctx.sendToPeer(encodeMove({ fromFortId: cf.id, x: cf.x }));
          this.moveBroadcastAt = now;
        }
        this.refreshMoveBar();
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
    this.fuelLeft = FUEL_PER_TURN; // 새 턴 이동 연료 재충전
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
      shells: this.shells.map((s) => ({ x: s.x, y: s.y, fuseLeft: s.fuseLeft })),
      flyingWeapon: this.flyingWeapon,
      aim,
      now,
      // 턴 타이머 표시용 — 각 클라 로컬 시각(자기 시계 기준). 호스트가 실제 타임아웃 판정.
      turnStartedAt: this.turnStartedAt,
      turnTimeMs: TURN_TIME_MS,
    };
  }

  /**
   * 모든 shell 한 스텝 진행 + 무기별 처리(분열/튕김/퓨즈/착탄).
   * 결정론적: 모든 클라가 같은 파라미터로 같은 궤적/분열/튕김을 재생.
   * 착탄 폭발 확정은 호스트만 (landShell 에서 누적) → 전부 착지 시 finalizeImpactAsHost.
   */
  private stepShells(dt: number): void {
    const spec = WEAPONS[this.flyingWeapon];

    // 분열탄: 정점(올라가다 vy≥0 로 전환) 도달 시 1개 → 3개
    if (spec.split && !this.splitDone && this.shells.length === 1 && (this.shells[0]!.landed === false) && this.shells[0]!.vy >= 0) {
      this.splitFragments(this.shells[0]!);
      this.splitDone = true;
    }

    for (const s of this.shells) {
      if (s.landed) continue;
      if (spec.fuseMs) s.fuseLeft -= dt * 1000;
      stepProjectile(s, this.fireWind, dt);

      const off = s.x < -60 || s.x > this.game.terrainWidth + 60 || s.y > 440;
      const groundY = terrainTopAt(this.hm, s.x);
      const hitGround = s.y >= groundY;

      if (spec.fuseMs) {
        // 수류탄: 퓨즈 끝나면 폭발, 아니면 지형에 튕기며 굴러감
        if (off) this.landShell(s, true);
        else if (s.fuseLeft <= 0) this.landShell(s, false);
        else if (hitGround) {
          s.y = groundY - 1;
          s.vy = -Math.abs(s.vy) * BOUNCE_DAMP;
          s.vx *= BOUNCE_DAMP;
          s.bounces++;
        }
      } else {
        let hitFort = false;
        for (const f of this.game.forts) {
          if (!f.alive) continue;
          if (Math.hypot(f.x - s.x, fortCenterY(this.hm, f) - s.y) < 12) { hitFort = true; break; }
        }
        if (off && !hitGround && !hitFort) this.landShell(s, true);
        else if (hitGround || hitFort) this.landShell(s, false);
      }
    }

    // 호스트: 모든 포탄 착지 OR 게임 종료(분열 파편 하나가 마지막 적 처치) 시 확정.
    //   phase==='ended' 조건이 없으면, 파편 A 가 게임을 끝냈는데 파편 B 가 아직
    //   공중이라 every(landed)=false → finalize 안 불려 fr:end 를 못 보내고 전원 멈춤.
    if (this.isHost && this.shells.length > 0
      && (this.game.phase === 'ended' || this.shells.every((s) => s.landed))) {
      this.finalizeImpactAsHost();
    }
    // 게스트는 landed 상태로 두고 호스트 impact 를 기다림 (applyImpactLocal 에서 정리)
  }

  /** 분열탄 파편 3개 생성 (현재 속도 기준 ±SPLIT_SPREAD). */
  private splitFragments(s: Shell): void {
    const speed = Math.hypot(s.vx, s.vy);
    const base = Math.atan2(s.vy, s.vx);
    this.shells = [-SPLIT_SPREAD, 0, SPLIT_SPREAD].map((d) => ({
      x: s.x, y: s.y,
      vx: Math.cos(base + d) * speed,
      vy: Math.sin(base + d) * speed,
      bounces: 0, fuseLeft: Infinity, landed: false,
    }));
  }

  /** 포탄 착지 표시. 호스트는 즉시 폭발 적용 + 크레이터 누적 (miss 면 폭발 없음). */
  private landShell(s: Shell, isMiss: boolean): void {
    s.landed = true;
    if (!this.isHost || isMiss) return;
    const spec = WEAPONS[this.flyingWeapon];
    const cx = s.x;
    const cy = Math.min(s.y, terrainTopAt(this.hm, s.x));
    carveCrater(this.hm, cx, cy, spec.craterRadius);
    this.craters.push({ cx, cy, r: spec.craterRadius });
    this.pendingBlasts.push({ cx, cy, r: spec.craterRadius });
    const res = applyBlast(this.game, this.hm, cx, cy, spec.blastRadius, spec.maxDamage);
    if (res.ended) this.pendingEnded = true;
  }

  /** 호스트: 이번 발사의 모든 폭발을 한 번에 확정 broadcast + 턴 진행/종료. */
  private finalizeImpactAsHost(): void {
    const nextWind = this.randomWind();
    const ended = this.pendingEnded || this.game.phase === 'ended';
    if (ended) {
      this.game.phase = 'ended';
      this.ctx.sendToPeer(encodeImpact({
        blasts: this.pendingBlasts, hp: this.hpMap(), ended: true,
        nextTurn: -1, nextWind, winnerPeerIds: this.game.winnerPeerIds,
      }));
      this.finishAsHost();
    } else {
      advanceTurn(this.game, nextWind, performance.now());
      this.turnStartedAt = performance.now();
      this.fuelLeft = FUEL_PER_TURN; // 새 턴 이동 연료 재충전
      this.ctx.sendToPeer(encodeImpact({
        blasts: this.pendingBlasts, hp: this.hpMap(), ended: false,
        nextTurn: this.game.currentTurn, nextWind, winnerPeerIds: [],
      }));
      this.refreshWeaponBar();
    }
    this.shells = [];
    this.pendingBlasts = [];
    this.pendingEnded = false;
    sound.play('tetris_garbage');
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
    if (!this.ready || this.isSpectator || this.paused || this.game.phase !== 'aiming' || this.shells.length > 0) return false;
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
    this.refreshMoveBar();
  }

  // ============================================
  // 이동 바 UI (◀ ▶ 홀드)
  // ============================================

  private canMove(): boolean {
    if (!this.ready || this.isSpectator || this.paused || this.game.phase !== 'aiming' || this.shells.length > 0) return false;
    if (this.fuelLeft <= 0) return false;
    const cf = this.currentFort();
    return !!cf && cf.ownerPeerId === this.myPeerId;
  }

  private mountMoveBar(): void {
    const parent = this.ctx.canvas.parentElement;
    if (!parent) return;
    const bar = document.createElement('div');
    bar.className = 'fortress-move-bar';
    bar.innerHTML = `
      <button class="fm-btn" data-dir="-1" title="왼쪽 이동">◀</button>
      <div class="fm-fuel"><div class="fm-fuel-fill"></div></div>
      <button class="fm-btn" data-dir="1" title="오른쪽 이동">▶</button>
    `;
    parent.appendChild(bar);
    this.moveBar = bar;

    // 버튼 누르는 동안 이동, 떼면 정지 + 최종 위치 확정 broadcast
    bar.querySelectorAll<HTMLButtonElement>('.fm-btn').forEach((b) => {
      const dir = Number(b.dataset.dir) as -1 | 1;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (this.canMove()) this.moveDir = dir;
      });
    });
    const release = (): void => {
      if (this.moveDir === 0) return;
      this.moveDir = 0;
      const cf = this.currentFort();
      if (cf && cf.ownerPeerId === this.myPeerId) {
        this.ctx.sendToPeer(encodeMove({ fromFortId: cf.id, x: cf.x })); // 최종 위치 수렴
      }
      this.refreshMoveBar();
    };
    window.addEventListener('mouseup', release);
    this.moveReleaseHandler = release;

    this.refreshMoveBar();
  }

  /** 이동 버튼 활성/연료바 갱신 */
  private refreshMoveBar(): void {
    if (!this.moveBar) return;
    const cf = this.currentFort();
    const myTurn = this.game.phase === 'aiming' && !this.isSpectator
      && this.shells.length === 0 && !!cf && cf.ownerPeerId === this.myPeerId;
    this.moveBar.querySelectorAll<HTMLButtonElement>('.fm-btn').forEach((b) => {
      b.disabled = !myTurn || this.fuelLeft <= 0;
    });
    const fill = this.moveBar.querySelector<HTMLElement>('.fm-fuel-fill');
    if (fill) fill.style.width = `${Math.round((this.fuelLeft / FUEL_PER_TURN) * 100)}%`;
    this.moveBar.classList.toggle('inactive', !myTurn);
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

    // 발사 직전 턴 재확인 — 드래그 도중 타임아웃 스킵 등으로 내 차례가 끝났으면 발사 취소.
    //   (없으면 이미 넘어간 남의 차례 포대 id 로 발사가 나가 오동기화)
    const me = this.currentFort();
    if (!me || me.ownerPeerId !== this.myPeerId || this.game.phase !== 'aiming' || this.shells.length > 0) return;

    const dx = this.mouseX - this.aimFromX;
    const dy = this.mouseY - this.aimFromY;
    const dragLen = Math.hypot(dx, dy);
    if (dragLen < 8) return; // 너무 짧음 — 발사 취소

    // 발사 무기 결정 — 잔탄 없으면 일반탄으로 폴백 (UI 가 막지만 방어적)
    const ownerPeerId = me.ownerPeerId;
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
    const spec = WEAPONS[weapon];
    this.shells = [{ x: sx, y: sy, vx, vy, bounces: 0, fuseLeft: spec.fuseMs ?? Infinity, landed: false }];
    this.splitDone = false;
    this.pendingBlasts = [];
    this.pendingEnded = false;
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
    this.shells = [];
    if (p.ended) {
      this.game.phase = 'ended';
      this.game.winnerPeerIds = p.winnerPeerIds;
    } else if (p.nextTurn !== -1) {
      this.game.currentTurn = p.nextTurn;
      this.game.wind = p.nextWind;
      this.game.phase = 'aiming';
      this.turnStartedAt = performance.now(); // 새 턴 타이머 표시 리셋
      this.fuelLeft = FUEL_PER_TURN; // 새 턴 이동 연료 재충전
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
