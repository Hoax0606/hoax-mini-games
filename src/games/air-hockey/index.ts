/**
 * 에어하키 게임 모듈 (GameModule 구현)
 *
 * 이 파일은 physics + render + netSync 를 "조립"하고,
 * 다음 책임들을 담당:
 *   - 입력 수집 (마우스 + 키보드)
 *   - 매 프레임 루프
 *   - 호스트 / 게스트 역할 분기
 *   - 승리 판정 및 결과 화면으로의 종료
 *
 * 역할 분리:
 *   [호스트]  로컬 입력 + 수신한 게스트 입력 → stepPhysics → state 브로드캐스트 → 승리 체크
 *   [게스트]  로컬 입력 → 호스트로 전송, 받은 state를 그대로 렌더 (자기 말렛만 로컬 예측)
 *
 * 게스트 로컬 예측:
 *   네트워크 왕복 지연(보통 50~100ms) 때문에 게스트가 마우스를 움직여도 호스트 응답이 올 때까지
 *   자기 말렛이 안 움직이면 UX가 최악. 해결: 게스트는 렌더할 때 자기 말렛 x/y만
 *   로컬 myTarget으로 "덮어써서" 즉시 반응하도록. 퍽 충돌 판정은 여전히 호스트 기준이라
 *   아주 짧은 순간 말렛 위치가 어긋날 수 있지만 대부분 눈에 안 띄는 수준.
 */

import type { GameModule, GameContext, GameMessage, GameResult } from '../types';
import {
  FIELD,
  CENTER_X,
  PHYSICS,
  createInitialState,
  stepPhysics,
  type GameState,
  type PhysicsEvent,
  type Vec2,
} from './physics';
import { Renderer } from './render';
import {
  encodeState,
  encodeInput,
  encodeEndForOpponent,
  decodeState,
  decodeInput,
  decodeEnd,
} from './netSync';
import { sound } from '../../core/sound';

const KEYBOARD_SPEED = 9; // 키보드 조작 시 프레임당 이동 픽셀 (논리 좌표)

class AirHockeyGame implements GameModule {
  private ctx!: GameContext;
  private canvas!: HTMLCanvasElement;
  private renderer!: Renderer;
  private state: GameState = createInitialState();
  private winScore = 7;

  private myTarget: Vec2 = { x: 0, y: 0 };
  private opponentTarget: Vec2 = { x: 0, y: 0 };

  // 키보드 조작용 누적 위치 (마우스는 즉시 위치, 키보드는 누적)
  private keyboardTarget: Vec2 = { x: 0, y: 0 };
  private keys = { up: false, down: false, left: false, right: false };
  /** 가장 최근에 쓴 입력 장치 — 마우스 쓰면 keyboard 값 무시, 키보드 쓰면 마우스 값 무시 */
  private lastInput: 'mouse' | 'keyboard' = 'mouse';

  private rafId: number | null = null;
  /** 게스트: 마지막 host state 수신 시각 — 스냅샷 사이 퍽/말렛 외삽(부드럽게)용 */
  private lastStateAt = 0;
  /** 고정 스텝 물리 누적기 — 프레임레이트와 무관하게 60Hz 시뮬 유지 */
  private physAccum = 0;
  private lastPhysTime = 0;
  private pendingEvents: PhysicsEvent[] = [];
  private gameEnded = false;
  /** 일시정지 — gameScreen 의 setPaused 호출로 토글. true 면 물리/입력 송신 스킵, 렌더만 */
  private paused = false;
  /** 스코어보드 DOM (하키 테이블과 메뉴바 사이 = 캔버스 위) + 마지막 표시 점수 */
  private scoreEl: HTMLDivElement | null = null;
  private shownScore = '';

  // ============================================
  // GameModule interface
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.canvas = ctx.canvas;
    this.winScore = parseInt(ctx.roomOptions.winScore ?? '7', 10) || 7;

    // 역할별 초기 말렛 위치 (내 말렛 = 내 진영)
    const myInitial = ctx.role === 'host'
      ? { x: FIELD.WIDTH * 0.20, y: FIELD.HEIGHT / 2 }
      : { x: FIELD.WIDTH * 0.80, y: FIELD.HEIGHT / 2 };
    const oppInitial = ctx.role === 'host'
      ? { x: FIELD.WIDTH * 0.80, y: FIELD.HEIGHT / 2 }
      : { x: FIELD.WIDTH * 0.20, y: FIELD.HEIGHT / 2 };

    this.myTarget = { ...myInitial };
    this.keyboardTarget = { ...myInitial };
    this.opponentTarget = { ...oppInitial };

    this.renderer = new Renderer({ canvas: this.canvas });

    // 스코어보드 — 하키 테이블(캔버스)과 상단 메뉴바 사이에 삽입 (경기장 밖, 프로스티드 알약).
    this.scoreEl = document.createElement('div');
    this.scoreEl.className = 'ah-scoreboard';
    this.scoreEl.innerHTML =
      `<span class="ah-dot ah-dot-host"></span>` +
      `<span class="ah-num ah-num-host">0</span>` +
      `<span class="ah-sep">:</span>` +
      `<span class="ah-num ah-num-guest">0</span>` +
      `<span class="ah-dot ah-dot-guest"></span>`;
    const wrap = this.canvas.parentElement;
    if (wrap) wrap.insertBefore(this.scoreEl, this.canvas);
    this.updateScoreboard();

    // 관전자는 입력 송신이 필요 없음 — 마우스/키보드 리스너 자체를 붙이지 않는다.
    // 호스트의 ah:state broadcast 만 받아서 renderer 로 그대로 표시.
    if (!ctx.isSpectator) {
      this.attachInput();
    }

    // 게임 BGM 시작 (관전자도 같이 들음)
    sound.startBgm('air-hockey');

    // 루프 시작
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.ctx.role === 'host') {
      // 호스트는 게스트 input만 기대 (관전자는 input 송신 안 함)
      const t = decodeInput(msg);
      if (t) this.opponentTarget = t;
      return;
    }

    // 게스트/관전자: state 는 공통으로 받아서 렌더링
    const snap = decodeState(msg);
    if (snap) {
      this.state = snap.state;
      this.lastStateAt = performance.now(); // 외삽 기준 시각
      if (snap.events.length > 0) {
        this.pendingEvents.push(...snap.events);
      }
      return;
    }

    // ah:end 는 "게스트 시점으로 winner 뒤집힌" 결과라서 관전자가 그대로 받으면
    // 호스트 승리를 '내 패배'로 오해하게 된다. 관전자는 이 메시지를 무시하고
    // 플랫폼 game_end broadcast(호스트 원본 시점) 로만 결과 화면에 진입한다.
    if (this.ctx.isSpectator) return;

    const end = decodeEnd(msg);
    if (end) {
      this.gameEnded = true;
      this.ctx.endGame(end);
    }
  }

  destroy(): void {
    this.gameEnded = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.detachInput();
    this.scoreEl?.remove();
    this.scoreEl = null;
    this.renderer?.destroy();
    sound.stopBgm();
  }

  /** GameModule 인터페이스: 일시정지 토글. 물리/네트워크 송신 정지, 렌더는 계속. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  // ============================================
  // 프레임 루프
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);

    if (this.gameEnded) {
      // 종료 후엔 물리·입력 중단 — 다만 파티클/골 이펙트 fade-out은 자연스럽게 유지.
      // 이렇게 해야 "결과 화면 대기 중"에 화면이 얼어붙은 느낌이 안 남.
      this.renderer.render(this.state, []);
      return;
    }

    // 관전자는 호스트가 broadcast 한 state 를 그대로 렌더만. 입력/예측/송신 없음.
    if (this.ctx.isSpectator) {
      this.renderer.render(this.state, this.pendingEvents);
      this.playEventSounds(this.pendingEvents);
      this.pendingEvents.length = 0;
      this.publishStatus();
      return;
    }

    // 일시정지 — 물리/네트워크 송신 정지, 렌더만 유지(현재 state 그대로 멈춤).
    // 호스트가 stepPhysics 를 안 호출하면 puck 위치가 그대로라 게스트도 동일하게 정지된 화면.
    if (this.paused) {
      this.lastPhysTime = 0; // 재개 시 누적기 재시작 (정지 시간이 한꺼번에 밀려들지 않게)
      this.renderer.render(this.state, []);
      this.publishStatus();
      return;
    }

    // 입력 확정 (키보드는 매 프레임 누적 이동 반영)
    this.applyKeyboardInput();

    if (this.ctx.role === 'host') {
      this.hostTick();
    } else {
      this.guestTick();
    }
    this.updateScoreboard();
  };

  private hostTick(): void {
    // 1) 고정 스텝 물리 — 실제 경과시간을 FIXED_DT(1/60) 단위로만 소비.
    //    호스트 모니터 주사율(60/120/144Hz)과 무관하게 항상 초당 ~60스텝 → 퍽 속도 일정.
    //    (예전엔 RAF 프레임당 1스텝이라 고주사율 호스트에서 게임이 몇 배 빨라졌음)
    const now = performance.now();
    if (this.lastPhysTime === 0) this.lastPhysTime = now;
    this.physAccum += (now - this.lastPhysTime) / 1000;
    this.lastPhysTime = now;
    if (this.physAccum > 0.25) this.physAccum = 0.25; // 렉 스파이크 상한

    const events: PhysicsEvent[] = [];
    while (this.physAccum >= PHYSICS.FIXED_DT) {
      const e = stepPhysics(this.state, {
        hostTarget: this.myTarget,
        guestTarget: this.opponentTarget,
      });
      if (e.length) events.push(...e);
      this.physAccum -= PHYSICS.FIXED_DT;
    }

    // 2) 상태 + 이벤트를 게스트에 송신 (프레임당 1회, 서브스텝 이벤트 합쳐서)
    this.ctx.sendToPeer(encodeState(this.state, events));

    // 3) 로컬 렌더
    this.renderer.render(this.state, events);

    // 4) 이벤트 → 사운드
    this.playEventSounds(events);

    // 5) 헤더 점수 UI 업데이트
    this.publishStatus();

    // 6) 승리 판정 (골 이벤트가 있었다면 점수 이미 반영됨)
    if (events.some((e) => e.kind === 'goal')) {
      this.checkWinCondition();
    }
  }

  private publishStatus(): void {
    // 점수는 캔버스 위 자체 스코어보드가 표시 → 헤더엔 점수 안 보냄(게임명만).
    this.ctx.onStatusUpdate?.({ phase: this.state.phase });
  }

  /** 캔버스 위 스코어보드 갱신 (점수 바뀔 때만 DOM 터치) */
  private updateScoreboard(): void {
    if (!this.scoreEl) return;
    const key = `${this.state.score.host}:${this.state.score.guest}`;
    if (key === this.shownScore) return;
    this.shownScore = key;
    const h = this.scoreEl.querySelector<HTMLElement>('.ah-num-host');
    const g = this.scoreEl.querySelector<HTMLElement>('.ah-num-guest');
    if (h) h.textContent = String(this.state.score.host);
    if (g) g.textContent = String(this.state.score.guest);
  }

  private guestTick(): void {
    // 1) 자기 입력을 호스트에 송신
    this.ctx.sendToPeer(encodeInput(this.myTarget));

    // 2) 로컬 예측 + 외삽으로 부드럽게:
    //    - 내 말렛: 로컬 target 으로 즉시(1:1) 덮어씀 (입력 지연 0)
    //    - 퍽 & 상대 말렛: 마지막 스냅샷 이후 경과시간만큼 속도로 외삽(dead-reckoning)
    //      → 스냅샷이 지터로 띄엄띄엄 와도 60fps 로 매끄럽게 미끄러짐(프리즈→텔레포트 방지).
    const elapsed = Math.min(0.09, (performance.now() - this.lastStateAt) / 1000);
    const p = this.state.puck;
    const pr = FIELD.PUCK_RADIUS;
    const oppM = this.state.mallets.host;
    const renderState: GameState = {
      ...this.state,
      puck: {
        ...p,
        x: clampNum(p.x + p.vx * elapsed, pr, FIELD.WIDTH - pr),
        y: clampNum(p.y + p.vy * elapsed, pr, FIELD.HEIGHT - pr),
      },
      mallets: {
        host: { ...oppM, x: oppM.x + oppM.vx * elapsed, y: oppM.y + oppM.vy * elapsed },
        guest: { ...this.state.mallets.guest, x: this.myTarget.x, y: this.myTarget.y },
      },
    };

    this.renderer.render(renderState, this.pendingEvents);
    // 사운드는 render 후에 재생 (pendingEvents 비우기 전에 소비)
    this.playEventSounds(this.pendingEvents);
    this.pendingEvents.length = 0;

    // 게스트도 헤더 점수 UI 업데이트
    this.publishStatus();
  }

  /** PhysicsEvent 배열을 소비하며 대응 사운드 재생 */
  private playEventSounds(events: readonly PhysicsEvent[]): void {
    for (const ev of events) {
      switch (ev.kind) {
        case 'mallet_hit':
          sound.play('mallet_hit', { intensity: ev.intensity });
          break;
        case 'wall_hit':
          sound.play('wall_hit');
          break;
        case 'goal':
          sound.play('goal');
          break;
      }
    }
  }

  private checkWinCondition(): void {
    const { host, guest } = this.state.score;
    if (host < this.winScore && guest < this.winScore) return;

    const hostWon = host > guest;
    const myResult: GameResult = {
      winner: hostWon ? 'me' : 'opponent',
      summary: { hostScore: host, guestScore: guest, winScore: this.winScore },
    };

    // 게스트에게 종료 메시지 (시점 뒤집힌 버전)
    this.ctx.sendToPeer(encodeEndForOpponent(myResult));

    this.gameEnded = true;
    this.ctx.endGame(myResult);
  }

  // ============================================
  // 입력 처리
  // ============================================

  private attachInput(): void {
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // 캔버스를 벗어나도 마우스 추적이 유지되도록 (버튼 누른 상태에서 빠져나가는 케이스 대비는 아니지만
    // 마우스무브가 캔버스 밖에서도 잡히면 튀는 UX 개선)
  }

  private detachInput(): void {
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private onMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const logical = this.renderer.canvasToLogical(
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    // 자기 진영으로 clamp. physics.ts의 updateMallet도 같은 제약을 걸지만
    // 게스트의 로컬 예측(guestTick)에서도 올바르게 그려지도록 입력 단계에서 막아둠.
    const constrained = this.constrainToMyHalf(logical);
    this.myTarget = constrained;
    // 키보드 조작으로 돌아갔을 때를 위해 키보드 누적 위치도 맞춰둠
    this.keyboardTarget = { ...constrained };
    this.lastInput = 'mouse';
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowUp':    case 'w': case 'W': this.keys.up = true; break;
      case 'ArrowDown':  case 's': case 'S': this.keys.down = true; break;
      case 'ArrowLeft':  case 'a': case 'A': this.keys.left = true; break;
      case 'ArrowRight': case 'd': case 'D': this.keys.right = true; break;
      default: return;
    }
    this.lastInput = 'keyboard';
    e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowUp':    case 'w': case 'W': this.keys.up = false; break;
      case 'ArrowDown':  case 's': case 'S': this.keys.down = false; break;
      case 'ArrowLeft':  case 'a': case 'A': this.keys.left = false; break;
      case 'ArrowRight': case 'd': case 'D': this.keys.right = false; break;
    }
  };

  private applyKeyboardInput(): void {
    if (this.lastInput !== 'keyboard') return;

    if (this.keys.up)    this.keyboardTarget.y -= KEYBOARD_SPEED;
    if (this.keys.down)  this.keyboardTarget.y += KEYBOARD_SPEED;
    if (this.keys.left)  this.keyboardTarget.x -= KEYBOARD_SPEED;
    if (this.keys.right) this.keyboardTarget.x += KEYBOARD_SPEED;

    // 자기 진영 + 필드 안쪽으로 clamp (키보드 입력은 눌러둔 만큼 값이 계속 쌓이므로 필수)
    this.keyboardTarget = this.constrainToMyHalf(this.keyboardTarget);
    this.myTarget = { ...this.keyboardTarget };
  }

  /**
   * 입력 좌표를 내 진영(중앙선 안 넘기) + 필드 안쪽으로 제한.
   * physics.ts의 updateMallet도 같은 clamp를 적용하지만,
   * 게스트 로컬 예측은 물리를 거치지 않아 여기서 미리 제약해둬야 말렛이 중앙선을 넘지 않음.
   */
  private constrainToMyHalf(target: Vec2): Vec2 {
    const isHost = this.ctx.role === 'host';
    const minX = isHost ? FIELD.MALLET_RADIUS : CENTER_X + FIELD.MALLET_RADIUS;
    const maxX = isHost ? CENTER_X - FIELD.MALLET_RADIUS : FIELD.WIDTH - FIELD.MALLET_RADIUS;
    const minY = FIELD.MALLET_RADIUS;
    const maxY = FIELD.HEIGHT - FIELD.MALLET_RADIUS;
    return {
      x: clamp(target.x, minX, maxX),
      y: clamp(target.y, minY, maxY),
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 레지스트리에서 사용하는 팩토리.
 * lazy import로 들어오므로 첫 게임 시작 시점에만 로드됨.
 */
export function createAirHockeyGame(): GameModule {
  return new AirHockeyGame();
}

/** 값 범위 클램프 (게스트 퍽 외삽이 벽 밖으로 안 나가게) */
function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
