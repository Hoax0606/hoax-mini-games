/**
 * 사과 게임 GameModule — 조립 파일
 *
 * 역할:
 *   board + rng + render + netSync 를 조립.
 *   마우스 입력, 타이머, 네트워크 송수신, 승리 판정 담당.
 *
 * 아키텍처 (로컬 시뮬레이션):
 *   각자 자기 보드로 독립 플레이. 네트워크로는 seed(초기 보드 공유) + 실시간 점수만 주고받는다.
 *   배틀 테트리스와 유사: 호스트는 최종 랭킹 판정만 한다.
 *
 * 메시지 흐름:
 *   - 호스트: 게임 시작 직후 ag:seed broadcast. 이후 5초마다 재송신(늦게 들어온 관전자용).
 *   - 전원: 2Hz 로 ag:score broadcast (관전자 제외).
 *   - 2분 타이머 종료 시점에 호스트가 자기 + 수신한 게스트 점수로 rankings 계산 → 각자에게 ag:end.
 *   - 관전자는 ag:seed 없이도 랭킹 패널은 정상 표시됨 (점수만 받으면 됨).
 */

import type {
  GameContext,
  GameMessage,
  GameModule,
  GameResult,
  Player,
} from '../types';
import { sound } from '../../core/sound';
import {
  BOARD_COLS,
  BOARD_ROWS,
  createBoard,
  normalizeRect,
  tryClear,
  type Board,
  type Rect,
} from './board';
import { createRandomSeed } from './rng';
import { AppleRenderer } from './render';
import {
  decodeEnd,
  decodeHello,
  decodeScore,
  decodeSeed,
  encodeEnd,
  encodeHello,
  encodeScore,
  encodeSeed,
} from './netSync';

// ============================================
// 상수
// ============================================

/** 게임 전체 길이 (ms) — 기본 2분 */
const GAME_DURATION_MS = 120_000;

/** 호스트가 seed 를 재송신하는 주기 (ms) — 늦게 들어온 관전자가 보드를 볼 수 있도록 */
const SEED_REBROADCAST_MS = 5_000;

/** 타이머 만료 후 호스트가 게스트들 최종 점수 받기까지 기다리는 grace period (ms) */
const FINISH_GRACE_MS = 1_000;

// ============================================
// 빈 보드 (관전자 & seed 대기 중 placeholder)
// ============================================

function emptyBoard(): Board {
  const b: Board = [];
  for (let r = 0; r < BOARD_ROWS; r++) {
    const row = new Array<number | null>(BOARD_COLS).fill(null);
    b.push(row);
  }
  return b;
}

// ============================================
// 호스트 전용: 플레이어 최종 점수 레코드
// ============================================

interface PlayerRecord {
  peerId: string;
  nickname: string;
  score: number;
}

// ============================================
// AppleGame
// ============================================

class AppleGame implements GameModule {
  private ctx!: GameContext;
  private renderer!: AppleRenderer;

  /** 아직 seed 안 받은 상태면 emptyBoard. seed 받거나 호스트면 실제 보드. */
  private board: Board = emptyBoard();
  private boardReady = false;

  private myPeerId = '';
  private myNickname = '';
  private isHost = false;
  private isSpectator = false;

  private myScore = 0;

  /** 나 제외한 플레이어들의 최신 점수 — 랭킹 패널 & 호스트 finishGame 용 */
  private otherScores = new Map<string, { peerId: string; nickname: string; score: number }>();

  // 드래그 상태
  private isDragging = false;
  private dragStart: { row: number; col: number } | null = null;
  private dragCurrent: { row: number; col: number } | null = null;

  // 루프 제어
  private rafId: number | null = null;
  private destroyed = false;
  private gameFinished = false;

  private startedAt = 0;
  private lastSeedBroadcast = 0;

  /** 일시정지 — paused 동안 startedAt 을 흘러간 만큼 더해서 타이머/시간 보정 */
  private paused = false;
  private pauseStart = 0;

  /** 호스트 seed (게스트는 수신한 값 저장 — 재진입 시 재사용 고려하진 않음) */
  private seed = 0;

  // ============================================
  // GameModule
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.myNickname = ctx.myNickname;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator;

    this.renderer = new AppleRenderer({ canvas: ctx.canvas });

    // "나 제외한 플레이어" 초기화 — role='player' 만. (관전자는 랭킹 대상 X)
    for (const p of ctx.players) {
      if (p.peerId === this.myPeerId) continue;
      if (p.role !== 'player') continue;
      this.otherScores.set(p.peerId, {
        peerId: p.peerId,
        nickname: p.nickname,
        score: 0,
      });
    }

    // 호스트: seed 생성 + 자기 보드 준비 + broadcast
    if (this.isHost) {
      this.seed = createRandomSeed();
      this.board = createBoard(this.seed);
      this.boardReady = true;
      // 첫 broadcast 는 루프 첫 틱에서 바로 — lastSeedBroadcast 가 0 이라 즉시 조건 만족
    }

    // 기본 CSS(.game-canvas)가 에어하키를 위해 cursor:none 으로 숨겨져 있어서
    // 여기선 inline style 로 덮어쓴다. 드래그 UX 에 어울리는 crosshair.
    // 관전자도 커서는 보여주는 게 자연스러움(마우스로 랭킹 영역 가리킬 수 있음).
    ctx.canvas.style.cursor = 'crosshair';

    // 마우스 입력 — 관전자는 등록 X
    if (!this.isSpectator) {
      this.attachInput();
    }

    // 게임 BGM 시작 (관전자도 함께)
    sound.startBgm('apple-game');

    // 호스트가 아니면(=게스트/관전자) "나 들어왔어 seed 줘" 를 즉시 호스트에 요청.
    // 호스트의 자동 재전송(5초 주기)에 의존하면 첫 5초간 빈 보드가 되므로 핸드셰이크로 빠르게.
    if (!this.isHost) {
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }

    this.startedAt = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    // 0) hello (호스트만 처리) — 요청한 peer 에게만 seed 를 target 으로 즉시 송신
    const hello = decodeHello(msg);
    if (hello) {
      if (this.isHost && this.boardReady) {
        this.ctx.sendToPeer(encodeSeed(this.seed), { target: hello.peerId });
      }
      return;
    }

    // 1) 시드 수신 (게스트/관전자)
    const seed = decodeSeed(msg);
    if (seed) {
      if (!this.boardReady) {
        this.seed = seed.seed;
        // 관전자도 seed 받지만 보드 건드리지 않음 — render 는 isSpectator 로 오버레이 처리
        if (!this.isSpectator) {
          this.board = createBoard(seed.seed);
        }
        this.boardReady = true;
      }
      return;
    }

    // 2) 점수 스냅샷 (나 아닌 모든 peer)
    const scoreMsg = decodeScore(msg);
    if (scoreMsg) {
      if (scoreMsg.peerId === this.myPeerId) return;
      const existing = this.otherScores.get(scoreMsg.peerId);
      if (existing) {
        existing.score = scoreMsg.score;
      }
      // otherScores 에 없는 peerId (=관전자 peerId) 는 무시. 플레이어만 랭킹에 포함.
      return;
    }

    // 3) 종료 판정 (호스트가 각자에게 시점별로 보낸 결과)
    //    관전자는 플랫폼 game_end broadcast 경로로 이동하므로 이 메시지 무시.
    const end = decodeEnd(msg);
    if (end) {
      if (this.isSpectator) return;
      this.gameFinished = true;
      this.ctx.endGame(end);
      return;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.gameFinished = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.detachInput();
    this.renderer?.destroy();
    sound.stopBgm();
    // 커서 inline 스타일 원복 (다시하기/다른 게임 진입 시 영향 없게)
    if (this.ctx?.canvas) {
      this.ctx.canvas.style.cursor = '';
    }
  }

  /** 일시정지 토글. paused 동안 흐른 만큼 startedAt 을 더해 타이머가 멈춘 것처럼. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.pauseStart = performance.now();
      // 드래그 중이었으면 취소
      this.isDragging = false;
      this.dragStart = null;
      this.dragCurrent = null;
    } else if (this.pauseStart > 0) {
      this.startedAt += performance.now() - this.pauseStart;
      this.pauseStart = 0;
    }
  }

  // ============================================
  // 메인 루프
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;

    const now = performance.now();
    const elapsed = now - this.startedAt;
    const remainingMs = Math.max(0, GAME_DURATION_MS - elapsed);

    if (!this.gameFinished) {
      // 호스트: seed 주기적 재송신 (늦게 들어온 관전자용)
      if (this.isHost && now - this.lastSeedBroadcast >= SEED_REBROADCAST_MS) {
        this.ctx.sendToPeer(encodeSeed(this.seed));
        this.lastSeedBroadcast = now;
      }

      // 타이머 만료 — 게임 중엔 점수 공유 X. 만료 시점에만 "최종 점수" 를 한 번 송신.
      if (remainingMs <= 0) {
        sound.play('tetris_topout'); // 종료 알림 사운드 재활용
        this.gameFinished = true;
        this.isDragging = false;
        this.dragStart = null;
        this.dragCurrent = null;

        // 관전자 제외, 자기 최종 점수 한 번 broadcast
        if (!this.isSpectator) {
          this.ctx.sendToPeer(encodeScore(this.myPeerId, this.myScore));
        }

        if (this.isHost) {
          // 네트워크 지연으로 게스트 점수가 도착할 시간(grace) 준 뒤 랭킹 집계.
          // 1초면 LAN/WAN 양쪽 다 여유 있음.
          window.setTimeout(() => this.finishGame(), FINISH_GRACE_MS);
        }
        // 게스트는 호스트의 ag:end 수신까지 대기 (렌더만 계속).
      }
    }

    // 렌더
    this.renderer.render({
      board: this.board,
      dragRect: this.currentDragRect(),
      remainingMs,
      myScore: this.myScore,
      myNickname: this.myNickname,
      otherPlayers: [...this.otherScores.values()],
      isSpectator: this.isSpectator,
      gameEnded: this.gameFinished,
    });
  };

  /** 현재 드래그 중이면 정규화된 rect, 아니면 null */
  private currentDragRect(): Rect | null {
    if (!this.isDragging || !this.dragStart || !this.dragCurrent) return null;
    return normalizeRect(
      this.dragStart.row,
      this.dragStart.col,
      this.dragCurrent.row,
      this.dragCurrent.col,
    );
  }

  // ============================================
  // 호스트 전용 — 최종 랭킹 판정
  // ============================================

  private finishGame(): void {
    if (!this.isHost) return;
    this.gameFinished = true;

    // 모든 플레이어 레코드 수집 (나 + otherScores).
    // otherScores 는 ctx.players 기반 role='player' 만 넣어놨으니 관전자는 자동 제외.
    const records: PlayerRecord[] = [
      { peerId: this.myPeerId, nickname: this.myNickname, score: this.myScore },
    ];
    for (const s of this.otherScores.values()) {
      records.push({ peerId: s.peerId, nickname: s.nickname, score: s.score });
    }

    // 점수 내림차순 → rank 부여 (동점은 배열 순서대로 다른 rank — MVP 허용)
    records.sort((a, b) => b.score - a.score);
    const rankings = records.map((r, idx) => ({
      peerId: r.peerId,
      nickname: r.nickname,
      rank: idx + 1,
      score: r.score,
    }));
    const totalPlayers = rankings.length;
    const winnerPeerId = rankings[0]?.peerId ?? null;

    // 각 게스트에게 시점별 ag:end 전송
    for (const r of records) {
      if (r.peerId === this.myPeerId) continue;
      const peerResult: GameResult = {
        winner:
          winnerPeerId === null ? null :
          winnerPeerId === r.peerId ? 'me' : 'opponent',
        summary: {
          gameId: 'apple-game',
          myPeerId: r.peerId,
          rank: rankings.find((rank) => rank.peerId === r.peerId)?.rank ?? totalPlayers,
          totalPlayers,
          rankings,
          myScore: r.score,
        },
      };
      this.ctx.sendToPeer(encodeEnd(peerResult), { target: r.peerId });
    }

    // 내 결과
    const myRank = rankings.find((r) => r.peerId === this.myPeerId)?.rank ?? totalPlayers;
    const myResult: GameResult = {
      winner:
        winnerPeerId === null ? null :
        winnerPeerId === this.myPeerId ? 'me' : 'opponent',
      summary: {
        gameId: 'apple-game',
        myPeerId: this.myPeerId,
        rank: myRank,
        totalPlayers,
        rankings,
        myScore: this.myScore,
      },
    };
    this.ctx.endGame(myResult);
  }

  // ============================================
  // 마우스 입력
  // ============================================

  private attachInput(): void {
    const canvas = this.ctx.canvas;
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('mousemove', this.onMouseMove);
    // mouseup 은 window 에 달아서 캔버스 밖에서 뗐을 때도 드래그 종료
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('blur', this.onBlur);
  }

  private detachInput(): void {
    const canvas = this.ctx.canvas;
    canvas.removeEventListener('mousedown', this.onMouseDown);
    canvas.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (this.gameFinished || this.paused) return;
    const cell = this.pickCellFromEvent(e);
    if (!cell) return;
    this.isDragging = true;
    this.dragStart = cell;
    this.dragCurrent = cell;
    e.preventDefault();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isDragging || this.paused) return;
    const cell = this.pickCellFromEvent(e, { clampToBoard: true });
    if (cell) {
      this.dragCurrent = cell;
    }
  };

  private onMouseUp = (): void => {
    if (!this.isDragging || this.paused) return;
    const rect = this.currentDragRect();
    this.isDragging = false;
    this.dragStart = null;
    this.dragCurrent = null;
    if (!rect || this.gameFinished) return;

    const cleared = tryClear(this.board, rect);
    if (cleared > 0) {
      this.myScore += cleared;
      sound.play('tetris_clear'); // 성공 사운드 — 기존 경쾌한 아르페지오 재활용
      // 게임 중엔 상대에게 점수 broadcast 하지 않음 (Henry 요청 — 실시간 점수 비노출).
      // 최종 점수는 타이머 만료 시점에만 한 번 송신.
    }
    // 실패 시 무음 — 자주 시도할수록 시끄러움 방지
  };

  private onBlur = (): void => {
    // 포커스 잃으면 드래그 중단 (유령 드래그 방지)
    this.isDragging = false;
    this.dragStart = null;
    this.dragCurrent = null;
  };

  /**
   * MouseEvent → 격자 좌표.
   * @param opts.clampToBoard true 면 보드 밖 좌표도 경계 셀로 스냅 (드래그 중에 사용)
   */
  private pickCellFromEvent(
    e: MouseEvent,
    opts: { clampToBoard?: boolean } = {},
  ): { row: number; col: number } | null {
    const canvas = this.ctx.canvas;
    const rect = canvas.getBoundingClientRect();
    const logical = this.renderer.canvasToLogical(
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    if (opts.clampToBoard) {
      // 드래그 중 — 보드 밖도 경계 셀로 스냅
      return this.renderer.logicalToCellClamp(logical.x, logical.y);
    }
    const cell = this.renderer.logicalToCell(logical.x, logical.y);
    return cell ? { row: cell.row, col: cell.col } : null;
  }
}

// ============================================
// Factory (registry 에서 사용)
// ============================================

export function createAppleGame(): GameModule {
  return new AppleGame();
}

// 타입 re-export (type-only import 방지용)
export type { Player };
