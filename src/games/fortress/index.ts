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
  type FortressGame, type Fort, type WeaponId, type WeaponSpec,
} from './rules';
import {
  generateTerrain, carveCrater, terrainTopAt,
} from './terrain';
import {
  launchVelocity, segPos, segVel, MAX_WIND,
  type Projectile, type FlightSeg,
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

const SIM_DT = 1 / 120;          // 궤적 고정 스텝(초) — 모든 클라 동일 스텝수로 결정론적 궤적
const END_GAME_DELAY_MS = 1800;
const MAX_DRAG_PX = 200;         // 이 이상 당기면 파워 100%
/** 포신 발사 시작점 — 포대 중심에서 위로 */
const MUZZLE_RISE = 13;
/** 한 턴 제한 시간(ms). 안 쏘면 호스트가 턴을 넘겨 무한 정지 방지 */
const TURN_TIME_MS = 30_000;
/** 게스트가 'firing' 상태로 이 시간 넘게 갇히면 재동기화 요청 (착탄 메시지 유실/중간합류 복구) */
const FIRING_WATCHDOG_MS = 8_000;
/** 호스트: 포탄이 이 시간 넘게 착탄 안 되면 강제 턴 종료 (게임 정지 방지 안전장치) */
const FIRING_MAX_MS = 6_000;
/** 발사 직후 이 시간 동안은 "호스트가 아직 내 발사를 반영 못한 오래된 aiming sync" 를 무시.
 *  RTT 지연으로 날아가던 포탄이 사라지는 것 방지. 이후엔 받아들여 fr:fire 유실도 복구. */
const RESYNC_STALE_AIMING_MS = 1_500;
/** 분열탄 파편 각 벌림(라디안) */
const SPLIT_SPREAD = 0.30;
/** 유도탄 등속(px/s) — 중력/바람 무시, 타겟까지 일정 속도 */
const GUIDED_SPEED = 340;
/** 유도탄 최대 선회 각속도(rad/s) — 클수록 급하게 타겟으로 꺾음 */
const GUIDED_TURN_RATE = 3.4;
/** 수류탄 지형 반사 감쇠 계수 */
const BOUNCE_DAMP = 0.55;
/** 발사 직후 이 거리(px)까진 지형/포대 충돌 무시 — 총구 앞 오조준 착탄 방지 */
const LAUNCH_CLEARANCE = 20;
/** 폭발 이펙트 시각 반경 = 크레이터반경 × 이 배율. 호스트·게스트가 같은 값(크레이터반경)으로
 *  계산하도록 통일 — 예전엔 호스트 blastRadius / 게스트 크레이터×1.7 로 폭발 크기가 달라 보였음 */
const EXPLOSION_VIS_SCALE = 2.3;
/** 포대 피격 판정 반경 (탱크 몸통). 차체 반폭(~14)보다 커야 "맞은 것 같은데 통과"가 안 남 */
const FORT_HIT_RADIUS = 16;
/** 포대 몸통 중심 y = 지형top - 이 값 (탱크 차체 높이) */
const FORT_HIT_RISE = 11;
/** 턴당 이동 연료(=이동 가능 px). 턴마다 재충전 */
const FUEL_PER_TURN = 100;
/** 이동 속도 (px/s) */
const MOVE_SPEED = 60;
/** 이동 위치 broadcast 간격(ms) */
const MOVE_BROADCAST_MS = 100;
/** 이동 시 한 스텝 넘을 수 있는 최대 지형 높이차(px). 이보다 가파르면(크레이터 벽) 정지 — 순간이동 방지 */
const MAX_CLIMB_PER_STEP = 3;

/** 날아가는 포탄 하나. bounces/fuseLeft 는 수류탄, landed 는 착지 여부 */
interface Shell extends Projectile {
  bounces: number;
  /** 남은 퓨즈(ms). 수류탄만 유의미, 나머지는 Infinity */
  fuseLeft: number;
  landed: boolean;
  /** 발사(생성) 지점 — 총구 클리어런스 계산용 */
  spawnX: number;
  spawnY: number;
  /** 현재 비행 구간(해석식 원점). 분열/튕김 때 새로 시작 */
  seg: FlightSeg;
  /** 현재 구간에서 경과한 시간(초). 위치 = segPos(seg, st) */
  st: number;
  /** 발사한 포대 id — 이 포대는 자탄이 벗어나기 전엔 충돌 무시(자기 포대 자폭 방지) */
  originFortId: number;
  /** 자기 포대 히트박스를 한 번 벗어났는지. false 동안은 originFortId 충돌 무시(아래로 쏠 때 자폭 방지) */
  armed: boolean;
  /** 유도탄 여부 — true 면 탄도 발사 후 정점을 지나면 타겟으로 호밍 */
  guided?: boolean;
  /** 유도탄: 정점(하강 시작)을 지나 호밍 단계에 들어갔는지 */
  homing?: boolean;
  /** 유도탄 목표 좌표(발사 시 고정) */
  tx?: number;
  ty?: number;
}

/** 포탄의 현재 (x,y,vx,vy) 를 원점으로 새 비행 구간 시작 (발사·분열·튕김 공통) */
function startSeg(s: Shell, wind: number): void {
  s.seg = { x0: s.x, y0: s.y, vx0: s.vx, vy0: s.vy, wind };
  s.st = 0;
}

/**
 * 점(px,py) 과 선분(a→b) 의 최근접점 + 거리.
 * 고속 포탄의 스침/통과(터널링) 판정 + 직격 시 폭발 중심을 탱크에 가장 가까운
 * 지점으로 스냅하는 데 쓴다(스텝 끝점이 탱크를 지나쳐 데미지가 줄던 문제 방지).
 */
function segClosest(ax: number, ay: number, bx: number, by: number, px: number, py: number): { x: number; y: number; d: number } {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t, cy = ay + dy * t;
  return { x: cx, y: cy, d: Math.hypot(px - cx, py - cy) };
}

/** 무기 바 아이콘 — 이모지 대신 인라인 SVG (프로젝트 방침: UI는 아이콘/도형). viewBox 24, .fw-icon svg 가 크기 지정 */
const WEAPON_ICONS: Record<WeaponId, string> = {
  normal: '<svg viewBox="0 0 24 24"><circle cx="11" cy="15" r="7" fill="#3a3242"/><circle cx="11" cy="15" r="7" fill="none" stroke="#241f2b" stroke-width="1"/><circle cx="8.4" cy="12.4" r="2.2" fill="#655d6b"/><path d="M15.5 8.6 q2.2-1.8 1.3-4.4" stroke="#c99a5a" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="17" cy="4" r="2" fill="#ffb845"/><circle cx="16.5" cy="3.6" r="0.8" fill="#fff3d0"/></svg>',
  big: '<svg viewBox="0 0 24 24"><path d="M12 12 L14 2 L16 11 L23 8 L17 13 L22 19 L15 15 L14 23 L11 15 L4 19 L9 12 L2 9 Z" fill="#ffb845" opacity="0.9"/><circle cx="12" cy="13" r="6.2" fill="#ff5a5a"/><circle cx="12" cy="13" r="6.2" fill="none" stroke="#d63a3a" stroke-width="1"/><circle cx="9.8" cy="10.8" r="1.9" fill="#ff8f8f"/></svg>',
  split: '<svg viewBox="0 0 24 24"><g stroke="#9a7fe0" stroke-width="1.5" stroke-linecap="round"><path d="M12 8 L6.5 15M12 8 L12 16M12 8 L17.5 15" fill="none"/></g><circle cx="12" cy="6" r="3.4" fill="#b89aff" stroke="#7a5fc7" stroke-width="1"/><circle cx="6" cy="17" r="2.7" fill="#b89aff" stroke="#7a5fc7" stroke-width="1"/><circle cx="12" cy="18" r="2.7" fill="#b89aff" stroke="#7a5fc7" stroke-width="1"/><circle cx="18" cy="17" r="2.7" fill="#b89aff" stroke="#7a5fc7" stroke-width="1"/></svg>',
  grenade: '<svg viewBox="0 0 24 24"><rect x="7.5" y="8.5" width="9" height="11.5" rx="4.2" fill="#5a7a3a"/><rect x="7.5" y="8.5" width="9" height="11.5" rx="4.2" fill="none" stroke="#3f5a26" stroke-width="1"/><g stroke="#3f5a26" stroke-width="0.9" opacity="0.7"><path d="M10 11 h4M10 14 h4M10 17 h4M12 9.5 v10"/></g><rect x="9.5" y="6" width="5" height="3" rx="1" fill="#8a8a8a"/><path d="M14 7 h4" stroke="#8a8a8a" stroke-width="1.6" stroke-linecap="round"/><circle cx="19.5" cy="7" r="2.2" fill="none" stroke="#c99a5a" stroke-width="1.6"/></svg>',
  guided: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="#5b9cff" stroke-width="1.5" stroke-dasharray="3 3"/><g transform="rotate(-45 12 12)"><rect x="10.4" y="6" width="3.2" height="9" rx="1.6" fill="#5b9cff"/><path d="M12 4 l1.8 3 h-3.6 Z" fill="#3f78c9"/><path d="M10.4 13 l-2 2.5 h2 Z M13.6 13 l2 2.5 h-2 Z" fill="#3f78c9"/></g><circle cx="12" cy="12" r="1.6" fill="#3f78c9"/></svg>',
  bombard: '<svg viewBox="0 0 24 24"><g stroke-linecap="round"><path d="M4 20 L11 13" stroke="#ff8a3b" stroke-width="3"/><path d="M3 15 L8.5 11" stroke="#ffb845" stroke-width="2.4"/><path d="M8 21 L13 15" stroke="#ffd454" stroke-width="2.2"/></g><circle cx="15.5" cy="9" r="6" fill="#7a5a3a"/><circle cx="15.5" cy="9" r="6" fill="none" stroke="#5a4028" stroke-width="1"/><circle cx="13.4" cy="7.2" r="1.7" fill="#9a7a58"/><circle cx="17.5" cy="10.5" r="1.1" fill="#5a4028"/></svg>',
};

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
  /** 게스트: 현재 hm 이 만들어진 seed (같으면 지형 재생성 스킵) */
  private terrainSeed = -1;
  /** 호스트: 마지막 주기 sync 브로드캐스트 시각 */
  private lastSyncAt = 0;

  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;
  private endGameScheduled = false;
  private lastFrameTime = 0;

  // 궤적 — 여러 포탄(분열탄은 3개 동시)
  private shells: Shell[] = [];
  private fireWind = 0;
  /** 고정 스텝 시뮬 누적기(초). 매 프레임 실경과를 더해 SIM_DT 단위로만 소비 → 결정론적 */
  private simAccum = 0;
  /** 지금 날아가는 포탄의 무기 (착탄 폭발 파라미터 결정) */
  private flyingWeapon: WeaponId = 'normal';
  /** 분열탄이 이번 발사에서 이미 분열했는지 */
  private splitDone = false;
  /** 호스트: 이번 발사에서 누적된 폭발(분열탄 여러 개) */
  private pendingBlasts: Crater[] = [];
  /** 호스트: 이번 발사로 게임이 끝났는지 */
  private pendingEnded = false;
  /** 폭발 이펙트 (클라 로컬 시각화, 확장 후 페이드) */
  private explosions: { x: number; y: number; r: number; start: number }[] = [];
  /** 데미지 숫자 팝업 (피격 위치에서 위로 뜨며 사라짐) */
  private damagePops: { x: number; y: number; dmg: number; start: number }[] = [];
  /** 포대별 마지막 피격 시각 (탱크 플래시용) */
  private fortHitAt: Record<number, number> = {};
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
  /** 게스트: 마지막 hello 전송 시각. ready 될 때까지 주기적으로 재전송 */
  private lastHelloAt = 0;

  // 드래그 조준
  private aiming = false;
  private aimFromX = 0;
  private aimFromY = 0;
  private mouseX: number | null = null;
  private mouseY: number | null = null;

  /** 유도탄 타겟으로 고른 적 포대 id (null=미지정). 같은 타겟 재클릭 시 발사 */
  private guidedTarget: number | null = null;

  // 카메라 수동 스크롤 — 휠/좌우 화살표로 맵을 둘러봄. null 이면 자동 따라가기.
  private camUserX: number | null = null;
  /** 자동 카메라가 마지막으로 중심 잡은 턴 — 턴 바뀌면 수동 스크롤 해제하고 재중심 */
  private lastFocusTurn = -1;

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
    const weaponMode = ctx.roomOptions['weaponMode'] === 'all' ? 'all' : 'random';
    this.game = createInitialGame(
      ordered.map((p) => ({ peerId: p.peerId, nickname: p.nickname })),
      seed, wind0, fortsPerPlayer, weaponMode,
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
    this.lastHelloAt = performance.now();
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
        // 내가 방금 쏴서 로컬은 firing 인데, 호스트가 아직 내 fr:fire 를 못 받아 보낸
        //   오래된 aiming 스냅샷이면 무시 — 안 그러면 아래 this.game 덮어쓰기 + shells=[] 로
        //   날아가던 포탄이 사라지고 재발사 창이 열린다. 착탄은 fr:impact 로 확정되니 안전.
        //   grace 이후엔 받아들여 fr:fire 진짜 유실 시 복구.
        if (this.game?.phase === 'firing' && sync.game.phase === 'aiming'
          && this.shells.length > 0
          && performance.now() - this.firingStartedAt < RESYNC_STALE_AIMING_MS) {
          return;
        }
        const wasReady = this.ready;
        const prevPhase = this.game?.phase;
        // 내가 지금 ◀▶ 로 움직이는 내 포대의 x 는 로컬이 최신(100ms 마다 호스트로 broadcast) —
        //   주기 sync 가 RTT 만큼 옛 x 로 덮으면 1.5초마다 되튀는 러버밴딩. 내 포대 x 만 보존.
        let holdX: { id: number; x: number } | null = null;
        if (this.game?.phase === 'aiming') {
          const cur = this.game.forts.find((f) => f.id === this.game.currentTurn);
          if (cur && cur.ownerPeerId === this.myPeerId) holdX = { id: cur.id, x: cur.x };
        }
        this.game = sync.game; // wind/currentTurn/phase/점수 등 최신 반영
        // 지형은 seed 또는 크레이터 수가 바뀌었을 때만 재생성 (주기 sync 마다 재생성 방지)
        if (this.terrainSeed !== sync.game.seed || this.craters.length !== sync.craters.length) {
          this.terrainSeed = sync.game.seed;
          this.craters = sync.craters;
          this.hm = generateTerrain(sync.game.seed, sync.game.terrainWidth);
          for (const c of this.craters) carveCrater(this.hm, c.cx, c.cy, c.r);
        }
        // 내가 조종 중이던 포대가 여전히 내 차례(aiming)면 로컬 x 유지 (러버밴딩 방지).
        //   턴이 넘어갔거나 다른 포대면 호스트 값 그대로 수용.
        if (holdX && this.game.phase === 'aiming' && this.game.currentTurn === holdX.id) {
          const f = this.game.forts.find((ff) => ff.id === holdX!.id);
          if (f && f.ownerPeerId === this.myPeerId) f.x = holdX.x;
        }
        // 발사 중이 아니면 잔여 shell 정리(착탄 유실 복구). 발사 중이면 진행 애니 유지.
        if (this.game.phase !== 'firing') this.shells = [];
        this.ready = true;
        if (!wasReady || prevPhase !== this.game.phase) this.turnStartedAt = performance.now();
        this.firingStartedAt = this.game.phase === 'firing' ? performance.now() : 0;
        if (this.weaponBar) this.buildWeaponButtons();
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
        const guidedTarget = (fire.weapon === 'guided' && typeof fire.targetX === 'number' && typeof fire.targetY === 'number')
          ? { tx: fire.targetX, ty: fire.targetY } : undefined;
        this.beginProjectile(fire.startX, fire.startY, fire.angleRad, fire.power01, fire.wind, fire.weapon, fire.fromFortId, guidedTarget);
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
      // 현재 턴 포대의 이동만, 그리고 조준(aiming) 단계에서만 반영.
      //   (발사 후 뒤늦게 도착한 이동 패킷이 포대 위치를 바꿔 착탄 판정에 영향 주는 것 방지)
      if (mv.fromFortId === this.game.currentTurn && this.game.phase === 'aiming') {
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
      // 정지 동안 흐른 시간을 각 "절대 기준시각"에 더해 보정 —
      //   안 그러면 턴 타이머/워치독이 정지 시간까지 세서 재개 즉시 턴 스킵됨.
      //   ※ lastFrameTime 은 보정하지 않는다: 루프가 정지 중에도 매 프레임 now 로
      //     갱신하므로(아래 loop 끝) 이미 최신이다. 여기서 delta 를 더하면 미래값이 되어
      //     재개 직후 simAccum 이 음수가 되고 포탄이 정지시간만큼 얼어붙는다.
      const delta = performance.now() - this.pauseStart;
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
      // 고정 스텝 누적기 — 실경과를 더해 SIM_DT 단위로만 소비.
      //   항상 정확히 SIM_DT 씩 밟으므로 프레임레이트·렉과 무관하게 모든 클라가 동일 궤적.
      this.simAccum += (now - this.lastFrameTime) / 1000;
      // 렉 스파이크로 스텝이 폭주하지 않게 상한(0.25초치). 넘친 시간은 버림.
      if (this.simAccum > 0.25) this.simAccum = 0.25;
      // 음수 방지 — 시계 되감김/보정 오류로 delta 가 음수여도 포탄이 멈추지 않게.
      if (this.simAccum < 0) this.simAccum = 0;
      try {
        while (this.simAccum >= SIM_DT && this.shells.length && this.game.phase === 'firing') {
          this.stepShells(SIM_DT);
          this.simAccum -= SIM_DT;
        }
      } catch (err) {
        // 시뮬 중 예외 — 포탄을 정리하고 호스트가 턴을 확정해 게임이 얼지 않게.
        console.error('[fortress] 포탄 시뮬 오류 — 강제 착탄 처리', err);
        this.shells = [];
        if (this.isHost) this.finalizeImpactAsHost();
      }
    }

    // 안전장치: 어떤 이유로든 포탄이 오래 착탄 안 되면 호스트가 강제로 턴 종료 (게임 정지 방지)
    if (this.isHost && !this.paused && this.game.phase === 'firing'
      && this.firingStartedAt > 0 && now - this.firingStartedAt > FIRING_MAX_MS) {
      console.warn('[fortress] firing 안전 타임아웃 — 강제 종료');
      this.shells = [];
      this.finalizeImpactAsHost();
    }

    // 포대 이동 (◀▶ 홀드 중 + 내 차례 + 연료 남음)
    if (!this.paused && this.moveDir !== 0 && this.canMove()) {
      const cf = this.currentFort();
      if (cf) {
        const frameDt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
        let dx = this.moveDir * MOVE_SPEED * frameDt;
        if (Math.abs(dx) > this.fuelLeft) dx = this.moveDir * this.fuelLeft; // 연료 한도
        const margin = 30;
        const nextX = Math.max(margin, Math.min(this.game.terrainWidth - margin, cf.x + dx));
        // 올라가는(더 높은 땅) 것만 막고, 내려가는(파인 땅/크레이터 안쪽) 건 허용.
        //   hm 값 클수록 낮은 땅 → climb>0 이면 목적지가 더 높음(올라감). 예전엔 abs 라 내려가기도
        //   막혀서 "깎인 땅으로 못 감" 버그. 이제 낙차(내려감)는 자유, 오르막만 MAX_CLIMB 로 제한.
        const climb = terrainTopAt(this.hm, cf.x) - terrainTopAt(this.hm, nextX);
        if (climb <= MAX_CLIMB_PER_STEP) {
          this.fuelLeft = Math.max(0, this.fuelLeft - Math.abs(nextX - cf.x));
          cf.x = nextX;
          if (now - this.moveBroadcastAt > MOVE_BROADCAST_MS) {
            this.ctx.sendToPeer(encodeMove({ fromFortId: cf.id, x: cf.x }));
            this.moveBroadcastAt = now;
          }
          this.refreshMoveBar();
        } else {
          this.moveDir = 0; // 벽에 막힘 — 이동 중단
          this.refreshMoveBar();
        }
      }
    }

    if (!this.paused && !this.gameFinished) {
      // 호스트: 현재 플레이어가 제한 시간 내 안 쏘면 턴 스킵 (무한 정지 방지)
      if (this.isHost && this.game.phase === 'aiming' && now - this.turnStartedAt > TURN_TIME_MS) {
        this.skipTurnAsHost();
      }
      // 호스트: 주기적으로 전체 상태 재broadcast — 게스트 wind/턴/지형/ready 를 항상 최신으로
      //   (초기 sync 유실/전환/합류 시에도 자동 복구. 지형은 게스트가 변화 있을 때만 재생성)
      if (this.isHost && now - this.lastSyncAt > 1500) {
        this.lastSyncAt = now;
        this.ctx.sendToPeer(encodeSync({ game: this.game, craters: this.craters }));
      }
      // 게스트: 아직 sync(ready) 못 받았으면 hello 를 주기적으로 재전송 —
      //   초기/재대결 시 hello 유실로 영영 ready 안 돼 조준·이동 전부 막히던 문제 방지.
      if (!this.isHost && !this.ready && now - this.lastHelloAt > 2000) {
        this.lastHelloAt = now;
        this.ctx.sendToPeer(encodeHello(this.myPeerId));
      }
      // 게스트: firing 상태로 너무 오래 갇히면 (착탄 유실/중간합류) 재동기화 요청
      if (!this.isHost && this.ready && this.game.phase === 'firing'
        && this.firingStartedAt > 0 && now - this.firingStartedAt > FIRING_WATCHDOG_MS) {
        this.firingStartedAt = now; // 재요청 간격 확보
        this.ctx.sendToPeer(encodeHello(this.myPeerId));
      }
    }

    this.lastFrameTime = now;

    // 이펙트 만료 정리
    if (this.explosions.length) this.explosions = this.explosions.filter((e) => now - e.start < 480);
    if (this.damagePops.length) this.damagePops = this.damagePops.filter((d) => now - d.start < 900);

    // 정지 중엔 render 시각을 pauseStart 로 얼려 턴 타이머 표시가 안 흐르게(모달 뒤 타이머 진행 방지)
    const renderNow = this.paused && this.pauseStart > 0 ? this.pauseStart : now;
    try {
      this.renderer.render(this.buildRenderState(renderNow));
    } catch (err) {
      console.error('[fortress] render 오류 (프레임 건너뜀)', err);
    }
  };

  /** 호스트: 시간 초과한 현재 턴을 발사 없이 넘긴다. 착탄 없는 impact(변화 0)로 전원 동기화. */
  /** 플레이어 이탈 — 호스트 처리.
   *  나간 사람 소유 포대를 전부 파괴하고, 생존 소유자가 1(팀) 이하면 종료(applyBlast 종료 로직 재현).
   *  아니면 그 사람이 현재 턴이었을 때만 턴을 넘기고, 갱신된 상태를 sync 한다. */
  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.game.phase === 'ended') return;
    const hadAliveFort = this.game.forts.some((f) => f.ownerPeerId === peerId && f.alive);
    if (!hadAliveFort) return; // 관전자이거나 이미 전멸
    for (const f of this.game.forts) {
      if (f.ownerPeerId === peerId) { f.alive = false; f.hp = 0; }
    }
    const survivorOwners = [...new Set(this.game.forts.filter((f) => f.alive).map((f) => f.ownerPeerId))];
    if (survivorOwners.length <= 1) {
      // 남은 사람 승 (0명이면 무승부 빈 배열) — applyBlast 종료와 동일
      this.game.phase = 'ended';
      this.game.winnerPeerIds = survivorOwners;
      this.ctx.sendToPeer(encodeImpact({
        blasts: [], hp: this.hpMap(), ended: true,
        nextTurn: -1, nextWind: this.randomWind(), winnerPeerIds: survivorOwners,
      }));
      this.finishAsHost();
      return;
    }
    // 계속 — 나간 사람이 현재 턴(포대)이었으면 다음 생존 포대로 넘김
    const curFort = this.game.forts.find((f) => f.id === this.game.currentTurn);
    if (this.game.phase === 'aiming' && (!curFort || !curFort.alive)) {
      const nextWind = this.randomWind();
      advanceTurn(this.game, nextWind, performance.now());
      this.turnStartedAt = performance.now();
      this.fuelLeft = FUEL_PER_TURN;
      this.ctx.sendToPeer(encodeImpact({
        blasts: [], hp: this.hpMap(), ended: false,
        nextTurn: this.game.currentTurn, nextWind, winnerPeerIds: [],
      }));
      this.refreshWeaponBar();
    } else {
      // 포탄 비행 중이거나 현재 턴 유지 — 갱신된 hp/alive 전체 sync (착탄 시 getNextTurn 이 죽은 포대 스킵)
      this.ctx.sendToPeer(encodeSync({ game: this.game, craters: this.craters }));
    }
  }

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
    // 턴이 바뀌면 수동 스크롤 해제하고 현재 포대로 재중심 + 유도탄 타겟 초기화
    if (this.game.currentTurn !== this.lastFocusTurn) {
      this.lastFocusTurn = this.game.currentTurn;
      this.camUserX = null;
      this.guidedTarget = null;
    }
    // 유도탄 타겟 레티클 (내가 유도탄 조준 중이고 타겟이 살아있을 때)
    let guidedTarget: RenderState['guidedTarget'] = null;
    if (this.guidedTarget !== null && this.shells.length === 0) {
      const t = this.game.forts.find((f) => f.id === this.guidedTarget && f.alive);
      if (t) guidedTarget = { x: t.x, y: fortCenterY(this.hm, t) }; // 실제 호밍 목표점과 동일
      else this.guidedTarget = null;
    }
    // 카메라 포커스: 포탄이 날면 포탄을 따라가고(수동 해제), 아니면 수동 스크롤 위치 > 현재 포대.
    let focusX: number | undefined;
    if (this.shells.length > 0) {
      focusX = this.shells[0]!.x;
      this.camUserX = null;
    } else if (this.camUserX !== null) {
      focusX = this.camUserX;
    } else {
      focusX = this.game.forts.find((f) => f.id === this.game.currentTurn && f.alive)?.x;
    }
    return {
      game: this.game,
      hm: this.hm,
      myPeerId: this.myPeerId,
      isSpectator: this.isSpectator,
      shells: this.shells.map((s) => ({ x: s.x, y: s.y, vx: s.vx, vy: s.vy, fuseLeft: s.fuseLeft })),
      flyingWeapon: this.flyingWeapon,
      explosions: this.explosions,
      damagePops: this.damagePops,
      fortHitAt: this.fortHitAt,
      aim,
      now,
      // 턴 타이머 표시용 — 각 클라 로컬 시각(자기 시계 기준). 호스트가 실제 타임아웃 판정.
      turnStartedAt: this.turnStartedAt,
      turnTimeMs: TURN_TIME_MS,
      focusX,
      guidedTarget,
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

      // 한 스텝 전진 — 이전 위치는 스침(터널링) 판정에 사용
      const prevX = s.x, prevY = s.y;
      if (s.guided && !s.homing) {
        // 유도탄 1단계 — 탄도(포물선). 정점(vy>=0=하강) + 최소 비행 후 호밍 단계로.
        s.st += dt;
        const p = segPos(s.seg, s.st); s.x = p.x; s.y = p.y;
        const v = segVel(s.seg, s.st); s.vx = v.vx; s.vy = v.vy;
        if (s.vy >= 0 && s.st >= 0.3) s.homing = true;
      } else if (s.guided) {
        // 유도탄 2단계 — 호밍: 타겟 방향으로 제한 각속도만큼 선회, 등속 유지. 고정스텝이라 결정론적.
        const desired = Math.atan2((s.ty ?? s.y) - s.y, (s.tx ?? s.x) - s.x);
        let cur = Math.atan2(s.vy, s.vx);
        let diff = desired - cur;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const maxTurn = GUIDED_TURN_RATE * dt;
        diff = Math.max(-maxTurn, Math.min(maxTurn, diff));
        cur += diff;
        s.vx = Math.cos(cur) * GUIDED_SPEED;
        s.vy = Math.sin(cur) * GUIDED_SPEED;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
      } else {
        // 해석식(포물선) — 구간 시작 후 경과시간 t 의 닫힌 수식
        s.st += dt;
        const p = segPos(s.seg, s.st); s.x = p.x; s.y = p.y;
        const v = segVel(s.seg, s.st); s.vx = v.vx; s.vy = v.vy;
      }

      // 유도탄은 호밍으로 타겟에 되돌아오므로 좌우·상단으로 잠깐 벗어나도 컬링하지 않는다
      //   (강하게 쏘면 1단계 탄도가 화면 밖으로 나갔다가 호밍으로 복귀 → 예전엔 여기서 사라졌음).
      //   화면 한참 아래로 떨어질 때만 미스 처리.
      const off = s.guided === true
        ? s.y > 700
        : (s.x < -60 || s.x > this.game.terrainWidth + 60 || s.y > 440);
      // 총구 클리어런스 — 발사 직후 일정 거리 전엔 지형/포대 충돌 무시(오조준 착탄 방지)
      const cleared = Math.hypot(s.x - s.spawnX, s.y - s.spawnY) > LAUNCH_CLEARANCE;
      const groundY = terrainTopAt(this.hm, s.x);
      const hitGround = cleared && s.y >= groundY;

      if (spec.fuseMs) {
        // 수류탄: 퓨즈 끝나면 폭발, 아니면 지형에 튕기며 굴러감
        if (off) this.landShell(s, true);
        else if (s.fuseLeft <= 0) this.landShell(s, false);
        else if (hitGround) {
          // 지형에 닿으면 낮게 튀며 경사 방향으로 굴러감 (경사 클수록 빨리 downhill)
          s.y = groundY - 1;
          // 기울기: 오른쪽 지면이 더 낮으면(값 큼) 오른쪽으로 굴러야 → slope>0 → vx 증가
          const slope = terrainTopAt(this.hm, s.x + 6) - terrainTopAt(this.hm, s.x - 6);
          s.vx = s.vx * 0.6 + slope * 4; // 마찰 + 경사 가속
          s.vy = -Math.abs(s.vy) * 0.3;  // 거의 안 튀고 구르는 느낌
          s.bounces++;
          startSeg(s, this.fireWind); // 반사 후 새 속도로 새 구간 시작
        }
      } else {
        // 자탄이 발사 포대 히트박스를 한 번 벗어나면 armed — 이후엔 자기 포대에도 맞을 수 있음(되돌아오는 경우).
        //   아래로 쏠 때 클리어런스(20px)만으론 자기 포대(반경16) 안이라 자폭하던 문제 방지.
        if (!s.armed) {
          const origin = this.game.forts.find((f) => f.id === s.originFortId);
          if (origin) {
            const oy = terrainTopAt(this.hm, origin.x) - FORT_HIT_RISE;
            if (Math.hypot(s.x - origin.x, s.y - oy) > FORT_HIT_RADIUS + 6) s.armed = true;
          } else {
            s.armed = true;
          }
        }
        let hitFort = false;
        if (cleared) {
          for (const f of this.game.forts) {
            if (!f.alive) continue;
            if (f.id === s.originFortId && !s.armed) continue; // 발사 포대는 벗어나기 전엔 무시
            // 탱크 몸통 중심 기준 원형 히트박스. 스텝 이동선분(prev→cur)과의 최근접거리로
            //   판정해 고속 포탄이 탱크를 한 프레임에 통과(터널링)해도 잡는다.
            const fy = terrainTopAt(this.hm, f.x) - FORT_HIT_RISE;
            const c = segClosest(prevX, prevY, s.x, s.y, f.x, fy);
            if (c.d < FORT_HIT_RADIUS) {
              // 폭발 중심을 최근접점으로 스냅 → 정타는 풀 데미지
              s.x = c.x; s.y = c.y;
              hitFort = true;
              break;
            }
          }
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
    this.shells = [-SPLIT_SPREAD, 0, SPLIT_SPREAD].map((d) => {
      const vx = Math.cos(base + d) * speed;
      const vy = Math.sin(base + d) * speed;
      return {
        x: s.x, y: s.y, vx, vy,
        bounces: 0, fuseLeft: Infinity, landed: false,
        spawnX: s.x, spawnY: s.y,
        seg: { x0: s.x, y0: s.y, vx0: vx, vy0: vy, wind: this.fireWind },
        st: 0,
        // 파편은 공중에서 생겨 이미 자기 포대 밖 → 바로 armed
        originFortId: s.originFortId, armed: true,
      };
    });
  }

  /** 포탄 착지 표시. 호스트는 즉시 폭발 적용 (miss 면 폭발 없음). */
  private landShell(s: Shell, isMiss: boolean): void {
    s.landed = true;
    if (!this.isHost || isMiss) return;
    const spec = WEAPONS[this.flyingWeapon];
    if (this.flyingWeapon === 'bombard') {
      // 에어스트라이크 — 착탄점을 중앙으로 5발이 균등 간격 좌우 대칭.
      //   중앙(offset 0) 1발은 정확히 지정 착탄점에 명중. 랜덤 없음 → 모든 클라 동일.
      const N = 5, spacing = 30;
      for (let i = 0; i < N; i++) {
        const off = (i - (N - 1) / 2) * spacing; // -60,-30,0,+30,+60
        const bx = Math.max(0, Math.min(this.game.terrainWidth, s.x + off));
        this.blastAt(bx, terrainTopAt(this.hm, bx), spec, i * 70); // 좌→우 시차 폭발
      }
    } else {
      // 폭발 중심 = 포탄 실제 착탄 좌표. 땅속으로 파고들었으면 지표면으로 스냅.
      //   (직격이면 s.y=탱크 높이 유지, 땅 착탄이면 지표면) → 판정 기준 일관.
      const iy = Math.min(s.y, terrainTopAt(this.hm, s.x));
      this.blastAt(s.x, iy, spec, 0);
    }
  }

  /** 한 지점 폭발 — 크레이터 + 데미지 + 이펙트. expDelay 로 폭발 연출 시차(에어스트라이크용). */
  private blastAt(cx: number, cy: number, spec: WeaponSpec, expDelay: number): void {
    carveCrater(this.hm, cx, cy, spec.craterRadius);
    this.craters.push({ cx, cy, r: spec.craterRadius });
    this.pendingBlasts.push({ cx, cy, r: spec.craterRadius });
    this.addExplosion(cx, cy, spec.craterRadius * EXPLOSION_VIS_SCALE, expDelay);
    const before = new Map(this.game.forts.map((f) => [f.id, f.hp]));
    const res = applyBlast(this.game, this.hm, cx, cy, spec.blastRadius, spec.maxDamage);
    this.registerDamagePops(before);
    if (res.ended) this.pendingEnded = true;
  }

  /** 폭발 이펙트 등록 (호스트/게스트 공통). delay 로 연출 시차(에어스트라이크). */
  private addExplosion(x: number, y: number, r: number, delay = 0): void {
    this.explosions.push({ x, y, r, start: performance.now() + delay });
  }

  /** hp 변화(피격) 감지 → 데미지 숫자 팝업 + 탱크 플래시 등록. before = 적용 전 hp 스냅샷 */
  private registerDamagePops(before: Map<number, number>): void {
    const now = performance.now();
    for (const f of this.game.forts) {
      const prev = before.get(f.id);
      if (prev === undefined) continue;
      const dmg = prev - f.hp;
      if (dmg > 0) {
        this.fortHitAt[f.id] = now;
        this.damagePops.push({ x: f.x, y: terrainTopAt(this.hm, f.x) - 34, dmg, start: now });
      }
    }
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
    this.ctx.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('keydown', this.onKeyPan);
  }
  private detachInput(): void {
    if (this.ctx?.canvas) {
      this.ctx.canvas.removeEventListener('mousedown', this.onDown);
      this.ctx.canvas.removeEventListener('wheel', this.onWheel);
    }
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('keydown', this.onKeyPan);
  }

  /** 카메라가 자동으로 따라갈 월드 x (날아가는 포탄 > 현재 포대) */
  private autoFocusX(): number | undefined {
    if (this.shells.length > 0) return this.shells[0]!.x;
    return this.game.forts.find((f) => f.id === this.game.currentTurn && f.alive)?.x;
  }

  /** 마우스 휠 → 카메라 가로 스크롤 (수동). 발사되면 자동으로 포탄 따라감. */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const w = this.game.terrainWidth;
    const base = this.camUserX ?? this.autoFocusX() ?? w / 2;
    const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
    this.camUserX = Math.max(0, Math.min(w, base + delta * 1.2));
  };

  /** ← / → 화살표로도 카메라 스크롤 */
  private onKeyPan = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const w = this.game.terrainWidth;
    const base = this.camUserX ?? this.autoFocusX() ?? w / 2;
    this.camUserX = Math.max(0, Math.min(w, base + (e.key === 'ArrowLeft' ? -80 : 80)));
  };

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
      if (w !== 'guided') this.guidedTarget = null; // 유도탄 아니면 타겟 해제
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
          <span class="fw-icon">${WEAPON_ICONS[w] ?? ''}</span>
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
      if (ammoEl) {
        ammoEl.textContent = w === 'normal' ? '∞' : `×${left}`;
        ammoEl.classList.toggle('inf', w === 'normal');
      }
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
    const rect = this.ctx.canvas.getBoundingClientRect();
    const { x, y } = this.renderer.screenToLogical(e.clientX - rect.left, e.clientY - rect.top);

    // 유도탄: 적 포대 클릭 → 타겟 락. 타겟이 잡혀 있으면(빈 곳 클릭) 아래 드래그 조준으로 발사.
    //   발사 후 정점을 지나면 락된 타겟으로 유도된다(중간부터 호밍).
    if (this.selectedWeapon === 'guided' && hasAmmo(this.game, me.ownerPeerId, 'guided')) {
      const target = this.fortNear(x, y, me.ownerPeerId);
      if (target) { this.guidedTarget = target.id; return; } // 적 클릭 = 타겟 지정(발사 안 함)
      if (this.guidedTarget === null) return;                // 타겟 먼저 골라야 조준 가능
      // 타겟 있음 → 일반탄처럼 드래그 조준 진행
    }

    this.aiming = true;
    this.aimFromX = me.x;
    this.aimFromY = fortCenterY(this.hm, me) - MUZZLE_RISE;
    this.mouseX = x; this.mouseY = y;
  };

  /** 클릭 지점 근처의 살아있는 '남의' 포대 (유도탄 타겟용). 없으면 undefined */
  private fortNear(x: number, y: number, myPeerId: string): Fort | undefined {
    let best: Fort | undefined;
    let bestD = 44; // 타겟 인식 반경(논리 px)
    for (const f of this.game.forts) {
      if (!f.alive || f.ownerPeerId === myPeerId) continue;
      const fy = terrainTopAt(this.hm, f.x) - FORT_HIT_RISE;
      const d = Math.hypot(x - f.x, y - fy);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

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

    // 유도탄이면 락된 타겟 해석 (없으면 발사 취소)
    let guidedTgt: { tx: number; ty: number } | undefined;
    if (weapon === 'guided') {
      const t = this.game.forts.find((f) => f.id === this.guidedTarget && f.alive);
      if (!t) return;
      guidedTgt = { tx: t.x, ty: fortCenterY(this.hm, t) };
    }

    // 로컬 즉시 시작 + broadcast (게스트/호스트 공통)
    this.beginProjectile(this.aimFromX, this.aimFromY, angleRad, power01, effWind, weapon, this.game.currentTurn, guidedTgt);
    spendAmmo(this.game, ownerPeerId, weapon);
    if (!hasAmmo(this.game, ownerPeerId, weapon)) this.selectedWeapon = 'normal'; // 소진 시 기본 복귀
    this.ctx.sendToPeer(encodeFire({
      fromFortId: this.game.currentTurn,
      startX: this.aimFromX, startY: this.aimFromY,
      angleRad, power01, wind: effWind, weapon,
      ...(guidedTgt ? { targetX: guidedTgt.tx, targetY: guidedTgt.ty } : {}),
    }));
    this.guidedTarget = null;
    this.refreshWeaponBar();
  };

  private beginProjectile(sx: number, sy: number, angleRad: number, power01: number, wind: number, weapon: WeaponId, originFortId: number, guidedTarget?: { tx: number; ty: number }): void {
    const spec = WEAPONS[weapon];
    let vx: number, vy: number;
    let guided = false, tx: number | undefined, ty: number | undefined;
    if (weapon === 'guided' && guidedTarget) {
      // 유도탄: 각도/파워로 '탄도 발사'(바람 무시) → 정점(하강 시작) 지나면 타겟으로 호밍.
      //   angle/power/target 모두 결정론 파라미터라 전 클라 동일 궤적.
      guided = true; tx = guidedTarget.tx; ty = guidedTarget.ty;
      const lv = launchVelocity(angleRad, power01);
      vx = lv.vx; vy = lv.vy;
    } else {
      const lv = launchVelocity(angleRad, power01);
      vx = lv.vx; vy = lv.vy;
    }
    this.shells = [{
      x: sx, y: sy, vx, vy,
      bounces: 0, fuseLeft: spec.fuseMs ?? Infinity, landed: false,
      spawnX: sx, spawnY: sy,
      seg: { x0: sx, y0: sy, vx0: vx, vy0: vy, wind },
      st: 0,
      originFortId, armed: false,
      guided, homing: false, tx, ty,
    }];
    this.simAccum = 0;
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
    p.blasts.forEach((b, i) => {
      carveCrater(this.hm, b.cx, b.cy, b.r);
      this.craters.push({ cx: b.cx, cy: b.cy, r: b.r });
      // 여러 발이면(에어스트라이크) 시차를 줘 "비" 처럼 순차 폭발.
      //   반경은 호스트와 동일한 공식(크레이터반경 × 배율)으로 → 폭발 크기 일치.
      this.addExplosion(b.cx, b.cy, b.r * EXPLOSION_VIS_SCALE, p.blasts.length > 1 ? i * 70 : 0);
    });
    const before = new Map(this.game.forts.map((f) => [f.id, f.hp]));
    for (const f of this.game.forts) {
      const hp = p.hp[f.id];
      if (hp !== undefined) { f.hp = hp; f.alive = hp > 0; }
    }
    this.registerDamagePops(before);
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
