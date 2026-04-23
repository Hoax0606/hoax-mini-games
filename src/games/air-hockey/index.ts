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
  private pendingEvents: PhysicsEvent[] = [];
  private gameEnded = false;

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

    this.attachInput();

    // 루프 시작
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.ctx.role === 'host') {
      // 호스트는 게스트 input만 기대
      const t = decodeInput(msg);
      if (t) this.opponentTarget = t;
      return;
    }

    // 게스트: state 또는 end
    const snap = decodeState(msg);
    if (snap) {
      this.state = snap.state;
      if (snap.events.length > 0) {
        this.pendingEvents.push(...snap.events);
      }
      return;
    }
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
    this.renderer?.destroy();
  }

  // ============================================
  // 프레임 루프
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.gameEnded) return;

    // 입력 확정 (키보드는 매 프레임 누적 이동 반영)
    this.applyKeyboardInput();

    if (this.ctx.role === 'host') {
      this.hostTick();
    } else {
      this.guestTick();
    }
  };

  private hostTick(): void {
    // 1) 물리 한 프레임
    const events = stepPhysics(this.state, {
      hostTarget: this.myTarget,
      guestTarget: this.opponentTarget,
    });

    // 2) 상태 + 이벤트를 게스트에 송신
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
    this.ctx.onStatusUpdate?.({
      hostScore: this.state.score.host,
      guestScore: this.state.score.guest,
      phase: this.state.phase,
    });
  }

  private guestTick(): void {
    // 1) 자기 입력을 호스트에 송신
    this.ctx.sendToPeer(encodeInput(this.myTarget));

    // 2) 로컬 예측: 받은 state를 그대로 렌더하되 자기 말렛만 로컬 target으로 덮어씀
    // (렌더 전용 사본을 만들어 원본 state는 건드리지 않음 — 다음 메시지 도착 시 일관성 유지)
    const renderState: GameState = {
      ...this.state,
      mallets: {
        ...this.state.mallets,
        guest: {
          ...this.state.mallets.guest,
          x: this.myTarget.x,
          y: this.myTarget.y,
        },
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
        case 'stuck_reset':
          sound.play('pop');
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
