/**
 * 배틀 테트리스 게임 엔진 — 피스 상태 머신
 *
 * 역할:
 *   pieces(모양/킥) + field(충돌/라인클리어) 위에 게임 진행 로직 조립.
 *   - 현재 피스 / 홀드 / 넥스트 관리
 *   - 이동 / SRS 회전 / 소프트드롭 / 하드드롭
 *   - 중력 + 락 딜레이
 *   - 라인 클리어 → 가비지 공격 산출
 *   - 받은 가비지 주입
 *   - 탑아웃 감지
 *
 * 의도적 제외:
 *   DOM/Canvas 접근, 네트워크 송수신, 입력 이벤트 리스닝.
 *   render.ts / netSync.ts / index.ts 가 각각 담당.
 */

import {
  PieceBag,
  spawnPosition,
  getKicks,
  type PieceId,
  type PieceState,
  type Rotation,
} from './pieces';
import {
  createEmptyField,
  collides,
  placePiece,
  clearFullLines,
  injectGarbage,
  dropDistance,
  type Field,
} from './field';

// ============================================
// 공개 상태 & 이벤트
// ============================================

export interface EngineState {
  field: Field;
  currentPiece: PieceState | null;
  /** 홀드된 피스 (없으면 null). 피스당 1회만 hold 가능 */
  holdPiece: PieceId | null;
  /** 현재 피스에 대해 이미 hold를 한 번 썼는지 */
  holdUsed: boolean;
  /** 다음에 나올 피스들 (미리보기 2개) */
  nextPieces: PieceId[];
  /** 상대가 보낸 가비지가 쌓이는 큐 — 내 피스 고정 시 주입됨 */
  pendingGarbage: number;
  toppedOut: boolean;
  /** 누적 라인 클리어 수 (통계용) */
  totalLinesCleared: number;
}

export type TickEvent =
  /** 피스 하나가 필드에 고정됨. linesCleared=이번에 지운 줄 수, garbageSent=상대에게 보낼 공격 수 */
  | { kind: 'piece_locked'; linesCleared: number; garbageSent: number }
  /** 받은 가비지 주입 완료 */
  | { kind: 'garbage_injected'; count: number }
  /** 탑아웃 = 게임오버 */
  | { kind: 'topped_out' };

// ============================================
// 공격 계산
// ============================================

/**
 * 클리어한 라인 수 → 상대에게 보낼 기본 가비지 수.
 * 싱글 0 / 더블 1 / 트리플 2 / 테트리스 4 (테트리스 스탠다드)
 */
function linesToGarbage(cleared: number): number {
  switch (cleared) {
    case 2: return 1;
    case 3: return 2;
    case 4: return 4;
    default: return 0;
  }
}

// ============================================
// TetrisEngine
// ============================================

export interface TetrisEngineOpts {
  /** 한 칸 낙하에 걸리는 ms. 기본 800 (=보통) */
  gravityMs?: number;
  /** 공격 가비지 배수. 0.5=약 / 1.0=중 / 1.5=강 */
  attackMultiplier?: number;
  /** 바닥 닿은 후 고정까지 여유 ms */
  lockDelayMs?: number;
}

export class TetrisEngine {
  private bag: PieceBag;
  private readonly gravityMs: number;
  private readonly attackMultiplier: number;
  private readonly lockDelayMs: number;

  state: EngineState;

  /** 중력/락 타이머 (ms 누적) */
  private gravityAcc = 0;
  private lockTimer = 0;

  /** 이번 update 중 쌓인 이벤트 — update()가 반환하면서 비움 */
  private pending: TickEvent[] = [];

  constructor(opts: TetrisEngineOpts = {}) {
    this.gravityMs = opts.gravityMs ?? 800;
    this.attackMultiplier = opts.attackMultiplier ?? 1;
    this.lockDelayMs = opts.lockDelayMs ?? 500;
    this.bag = new PieceBag();
    this.state = this.createInitialState();
  }

  private createInitialState(): EngineState {
    const firstId = this.bag.next();
    return {
      field: createEmptyField(),
      currentPiece: spawnPosition(firstId),
      holdPiece: null,
      holdUsed: false,
      nextPieces: this.bag.peek(2),
      pendingGarbage: 0,
      toppedOut: false,
      totalLinesCleared: 0,
    };
  }

  // ============================================
  // 메인 루프
  // ============================================

  /**
   * 매 프레임 호출. dt = 직전 호출 이후 경과 ms.
   * 이번 프레임에 발생한 이벤트들을 반환.
   */
  update(dt: number): TickEvent[] {
    if (this.state.toppedOut || !this.state.currentPiece) {
      return this.drain();
    }

    // 바닥 닿았는지 (한 칸 아래로 이동이 안 되면 grounded)
    const grounded = collides(this.state.field, {
      ...this.state.currentPiece,
      y: this.state.currentPiece.y + 1,
    });

    if (grounded) {
      // 락 타이머 진행
      this.lockTimer += dt;
      if (this.lockTimer >= this.lockDelayMs) {
        this.lockAndAdvance();
      }
    } else {
      this.lockTimer = 0;
      // 중력: gravityMs마다 한 칸씩 떨어뜨림. 큰 dt에선 여러 칸 떨어질 수 있음
      this.gravityAcc += dt;
      while (this.gravityAcc >= this.gravityMs) {
        this.gravityAcc -= this.gravityMs;
        if (!this.stepDown()) break; // 떨어지다 바닥 닿으면 중단
      }
    }

    return this.drain();
  }

  private drain(): TickEvent[] {
    if (this.pending.length === 0) return [];
    const out = this.pending;
    this.pending = [];
    return out;
  }

  // ============================================
  // 입력 핸들러
  // ============================================

  moveLeft(): boolean {
    return this.tryMove(-1, 0);
  }

  moveRight(): boolean {
    return this.tryMove(+1, 0);
  }

  /** 소프트 드롭: 한 칸 내림. 중력 타이머도 리셋 (연타 가속 효과) */
  softDrop(): boolean {
    if (this.stepDown()) {
      this.gravityAcc = 0;
      return true;
    }
    return false;
  }

  /**
   * 하드 드롭: 바닥까지 즉시 이동 후 즉시 고정.
   * 반환값: 떨어진 칸 수 (점수/이펙트용)
   */
  hardDrop(): number {
    if (!this.state.currentPiece || this.state.toppedOut) return 0;
    const dist = dropDistance(this.state.field, this.state.currentPiece);
    this.state.currentPiece = { ...this.state.currentPiece, y: this.state.currentPiece.y + dist };
    this.lockAndAdvance();
    return dist;
  }

  rotateCW(): boolean {
    if (!this.state.currentPiece) return false;
    const from = this.state.currentPiece.rotation;
    const to = ((from + 1) % 4) as Rotation;
    return this.tryRotate(from, to);
  }

  rotateCCW(): boolean {
    if (!this.state.currentPiece) return false;
    const from = this.state.currentPiece.rotation;
    const to = ((from + 3) % 4) as Rotation;
    return this.tryRotate(from, to);
  }

  /**
   * 홀드: 현재 피스를 보관, 이전에 보관된 피스(있으면)와 교체.
   * 현재 피스에 대해 이미 사용했으면 무시.
   */
  hold(): boolean {
    if (this.state.holdUsed || !this.state.currentPiece || this.state.toppedOut) {
      return false;
    }
    const currentId = this.state.currentPiece.id;
    if (this.state.holdPiece === null) {
      // 홀드가 비어있으면 현재 피스 저장 + 다음 피스 spawn
      this.state.holdPiece = currentId;
      this.spawnNextPiece();
    } else {
      // 홀드와 스왑
      const swappedId = this.state.holdPiece;
      this.state.holdPiece = currentId;
      const newPiece = spawnPosition(swappedId);
      if (collides(this.state.field, newPiece)) {
        this.state.currentPiece = null;
        this.state.toppedOut = true;
        this.pending.push({ kind: 'topped_out' });
        return false;
      }
      this.state.currentPiece = newPiece;
    }
    this.state.holdUsed = true;
    this.gravityAcc = 0;
    this.lockTimer = 0;
    return true;
  }

  /** 외부(네트워크)에서 받은 가비지 공격을 큐에 쌓음 */
  queueGarbage(count: number): void {
    if (count > 0) this.state.pendingGarbage += count;
  }

  // ============================================
  // 내부: 이동 / 회전 / 고정 로직
  // ============================================

  private tryMove(dx: number, dy: number): boolean {
    const piece = this.state.currentPiece;
    if (!piece || this.state.toppedOut) return false;
    const trial: PieceState = { ...piece, x: piece.x + dx, y: piece.y + dy };
    if (collides(this.state.field, trial)) return false;
    this.state.currentPiece = trial;
    // 바닥 닿은 상태에서 이동하면 락 타이머 리셋 (회전·이동으로 재위치)
    this.lockTimer = 0;
    return true;
  }

  /** 한 칸 아래로 이동. 못 내려가면 false */
  private stepDown(): boolean {
    return this.tryMove(0, 1);
  }

  private tryRotate(from: Rotation, to: Rotation): boolean {
    const piece = this.state.currentPiece;
    if (!piece || this.state.toppedOut) return false;
    const kicks = getKicks(piece.id, from, to);
    for (const [dx, dy] of kicks) {
      const trial: PieceState = {
        ...piece,
        x: piece.x + dx,
        y: piece.y - dy, // SRS convention (+y=up) → 내 좌표계 (+y=down) 변환
        rotation: to,
      };
      if (!collides(this.state.field, trial)) {
        this.state.currentPiece = trial;
        this.lockTimer = 0;
        return true;
      }
    }
    return false;
  }

  /**
   * 피스 고정 → 라인 클리어 → 공격 산출 → 받은 가비지 주입 → 다음 피스 spawn.
   * 탑아웃 시 state.toppedOut = true 로 설정하고 이벤트 push.
   */
  private lockAndAdvance(): void {
    if (!this.state.currentPiece) return;

    placePiece(this.state.field, this.state.currentPiece);

    // 라인 클리어
    const lines = clearFullLines(this.state.field);
    this.state.totalLinesCleared += lines;

    // 공격 계산 + 가비지 상쇄
    const baseAttack = linesToGarbage(lines);
    const boosted = Math.floor(baseAttack * this.attackMultiplier);
    // 테트리스 관습: 라인을 지우면 내 수신 큐를 먼저 깎고 남은 것만 상대에게 전송
    const mutualCancel = Math.min(boosted, this.state.pendingGarbage);
    this.state.pendingGarbage -= mutualCancel;
    const netSent = boosted - mutualCancel;

    this.pending.push({
      kind: 'piece_locked',
      linesCleared: lines,
      garbageSent: netSent,
    });

    // 내 수신 가비지가 여전히 남아있고 이번에 라인을 못 지웠으면 → 필드에 주입
    // (라인을 지웠다면 이미 상쇄 로직에서 부분적으로 또는 전부 해소됨)
    if (lines === 0 && this.state.pendingGarbage > 0) {
      const count = this.state.pendingGarbage;
      const toppedByGarbage = injectGarbage(this.state.field, count);
      this.state.pendingGarbage = 0;
      this.pending.push({ kind: 'garbage_injected', count });
      if (toppedByGarbage) {
        this.state.currentPiece = null;
        this.state.toppedOut = true;
        this.pending.push({ kind: 'topped_out' });
        return;
      }
    }

    // 다음 피스 spawn
    this.spawnNextPiece();
  }

  /** 새 피스를 필드에 스폰. 충돌하면 탑아웃 처리. */
  private spawnNextPiece(): void {
    const nextId = this.bag.next();
    const newPiece = spawnPosition(nextId);
    this.state.nextPieces = this.bag.peek(2);

    if (collides(this.state.field, newPiece)) {
      this.state.currentPiece = null;
      this.state.toppedOut = true;
      this.pending.push({ kind: 'topped_out' });
      return;
    }

    this.state.currentPiece = newPiece;
    this.state.holdUsed = false;
    this.gravityAcc = 0;
    this.lockTimer = 0;
  }
}
