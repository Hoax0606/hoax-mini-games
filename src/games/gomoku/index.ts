/**
 * 오목 GameModule — 조립
 *
 * 아키텍처:
 *   호스트 authoritative. 수 놓기/타이머 판정 모두 호스트가 결정.
 *   게스트는 `go:request_move` 로 의사 전달 → 호스트 검증 후 `go:move` broadcast.
 *
 * 관전자:
 *   render 에 `myRole: 'spectator'` 반영하고 입력 비활성. 입장 시 `go:hello` 보내 현재 상태 sync 받음.
 *
 * 주요 상태:
 *   board, currentTurn, moveNumber, turnStartedAt(performance.now), lastMove, gameOver.
 *   둘 다 로컬 진행이지만 호스트만 권위적으로 판정.
 *
 * 타이머:
 *   각 턴 시작 시 `turnStartedAt = performance.now()`. 렌더는 경과 ms 로 남은 초 표시.
 *   호스트 loop 에서 `> 30초` 감지 시 즉시 `go:end(reason='timeout')` broadcast + endGame.
 */

import type { GameContext, GameMessage, GameModule, GameResult } from '../types';
import { sound } from '../../core/sound';
import {
  createEmptyBoard,
  isLegal,
  checkWin,
  isBoardFull,
  type Board,
  type BoardSize,
  type WinInfo,
} from './board';
import { GomokuRenderer, type RenderState } from './render';
import {
  encodeRequestMove, decodeRequestMove,
  encodeMove, decodeMove,
  encodeSync, decodeSync,
  encodeHello, isHello,
  encodeEnd, decodeEnd,
} from './netSync';

// ============================================
// 상수
// ============================================

const TURN_TIME_MS = 30_000;
/** 호스트가 타이머 체크할 때 여유 ms (네트워크 지연 보정) */
const TIMEOUT_GRACE_MS = 500;

// ============================================
// 옵션 파싱
// ============================================

function parseBoardSize(opt?: string): BoardSize {
  return opt === '19' ? 19 : 15;
}

// ============================================
// GomokuGame
// ============================================

class GomokuGame implements GameModule {
  private ctx!: GameContext;
  private renderer!: GomokuRenderer;

  private boardSize: BoardSize = 15;
  private board: Board = [];
  /** 'B' = 호스트(선공), 'W' = 게스트(후공) */
  private currentTurn: 'B' | 'W' = 'B';
  private moveNumber = 0;
  /** 현재 턴이 시작된 시각 (performance.now) */
  private turnStartedAt = 0;
  private lastMove: { x: number; y: number } | null = null;
  private winInfo: WinInfo | null = null;

  /** 게임 종료 상태 (로컬 표시용 + 중복 처리 방어) */
  private gameOver: RenderState['gameOver'] = null;
  private gameFinished = false;
  /** endGame은 3초 뒤 호출 (결과 오버레이 여운) */
  private endGameScheduled = false;

  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;
  /** 내가 두는 색 (관전자면 null) */
  private mySide: 'B' | 'W' | null = null;

  private hostNickname = '';
  private guestNickname = '';

  /** 마우스 hover 상태 (내 차례일 때만 의미 있음) */
  private hoverCell: { x: number; y: number; legal: boolean } | null = null;

  private rafId: number | null = null;
  private destroyed = false;

  /** 게임 시작 시각 (performance.now). 결과 화면 소요시간 표시용 */
  private startedAt = 0;

  // ============================================
  // GameModule interface
  // ============================================

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;

    this.boardSize = parseBoardSize(ctx.roomOptions['boardSize']);
    this.board = createEmptyBoard(this.boardSize);
    this.currentTurn = 'B';
    this.moveNumber = 0;
    this.turnStartedAt = performance.now();

    // 호스트 닉네임/게스트 닉네임 추출 (플레이어 역할만)
    const playerList = ctx.players.filter((p) => p.role === 'player');
    const hostPlayer = playerList.find((p) => p.isHost);
    const guestPlayer = playerList.find((p) => !p.isHost);
    this.hostNickname = hostPlayer?.nickname ?? ctx.myNickname;
    this.guestNickname = guestPlayer?.nickname ?? ctx.opponentNickname;

    // 내 색 결정 (관전자는 null)
    if (this.isSpectator) {
      this.mySide = null;
    } else if (this.isHost) {
      this.mySide = 'B';
    } else {
      this.mySide = 'W';
    }

    this.renderer = new GomokuRenderer({ canvas: ctx.canvas });
    this.startedAt = performance.now();

    // 캔버스 커서를 crosshair 로 오버라이드 (기본 none 에서 복귀)
    ctx.canvas.style.cursor = 'crosshair';

    this.attachInput();
    sound.startBgm('gomoku');

    // 게스트/관전자는 호스트에게 초기 동기화 요청
    if (!this.isHost) {
      this.ctx.sendToPeer(encodeHello());
    }

    this.rafId = requestAnimationFrame(this.loop);
  }

  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    // 1) hello (호스트만 응답)
    if (isHello(msg)) {
      if (this.isHost) this.handleHello();
      return;
    }

    // 2) 게스트의 수 요청 (호스트만 처리)
    const req = decodeRequestMove(msg);
    if (req) {
      if (this.isHost) this.handleRequestMove(req.x, req.y, 'W');
      return;
    }

    // 3) 호스트가 broadcast 한 확정된 수
    const mv = decodeMove(msg);
    if (mv) {
      this.applyMove(mv.x, mv.y, mv.stone, mv.moveNumber);
      return;
    }

    // 4) 초기 sync (게스트/관전자가 받음)
    const sync = decodeSync(msg);
    if (sync) {
      this.board = sync.board;
      this.currentTurn = sync.currentTurn;
      this.moveNumber = sync.moveNumber;
      this.lastMove = sync.lastMove;
      this.turnStartedAt = performance.now() - sync.turnElapsedMs;
      return;
    }

    // 5) 게임 종료 (게스트/관전자가 받음)
    const end = decodeEnd(msg);
    if (end) {
      this.handleRemoteEnd(end);
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
    // 커서 복귀 (gameScreen 공통 CSS 기본값 cursor:none 으로 돌아가지만, 명시적으로)
    if (this.ctx?.canvas) this.ctx.canvas.style.cursor = '';
    this.renderer?.destroy();
    sound.stopBgm();
  }

  // ============================================
  // 루프
  // ============================================

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;

    const now = performance.now();

    // 호스트: 타이머 초과 체크
    if (this.isHost && !this.gameFinished) {
      const elapsed = now - this.turnStartedAt;
      if (elapsed > TURN_TIME_MS + TIMEOUT_GRACE_MS) {
        // 현재 턴 쪽이 시간초과 → 상대 승
        const loser = this.currentTurn;
        const winner: 'B' | 'W' = loser === 'B' ? 'W' : 'B';
        this.finishAsHost(winner, 'timeout');
      }
    }

    this.renderer.render(this.buildRenderState(now));
  };

  private buildRenderState(now: number): RenderState {
    const elapsed = now - this.turnStartedAt;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    const timerRatio = remaining / TURN_TIME_MS;
    const timerSeconds = remaining / 1000;

    const myRole: RenderState['myRole'] =
      this.isSpectator ? 'spectator' : (this.isHost ? 'host' : 'guest');

    return {
      board: this.board,
      boardSize: this.boardSize,
      currentTurn: this.currentTurn,
      mySide: this.mySide,
      lastMove: this.lastMove,
      winInfo: this.winInfo,
      hoverCell: this.hoverCell,
      timerSeconds,
      timerRatio,
      hostNickname: this.hostNickname,
      guestNickname: this.guestNickname,
      myRole,
      gameOver: this.gameOver,
    };
  }

  // ============================================
  // 호스트: 요청 처리 & 수 확정
  // ============================================

  private handleHello(): void {
    // 처음 입장한 피어에게 현재 상태 sync 전송
    // target 없이 broadcast 해도 무해하지만 대역폭 절약을 위해 hello 보낸 피어에게만 보내는 게 이상적.
    // 현재 GameContext 에선 onPeerMessage 에 from 이 노출 안 되므로 broadcast 로 fallback.
    // 이미 받은 사람은 같은 moveNumber 라 재적용 하진 않음.
    const now = performance.now();
    const turnElapsedMs = Math.min(now - this.turnStartedAt, TURN_TIME_MS);
    this.ctx.sendToPeer(
      encodeSync({
        board: this.board,
        currentTurn: this.currentTurn,
        moveNumber: this.moveNumber,
        turnElapsedMs,
        lastMove: this.lastMove,
      }),
    );
  }

  /** 호스트가 '수 요청'을 받았을 때 (게스트 또는 자기 로컬 콜). stone 은 요청자의 색 */
  private handleRequestMove(x: number, y: number, stone: 'B' | 'W'): void {
    if (this.gameFinished) return;
    if (stone !== this.currentTurn) return; // 순서 위반
    if (!isLegal(this.board, x, y, stone)) return; // 금수/범위/점유

    // 확정
    this.board[y]![x] = stone;
    this.moveNumber++;
    this.lastMove = { x, y };

    // 전체 broadcast (호스트 본인 로컬은 applyMove가 게스트/호스트 공통 경로라
    //  아래에서 같은 moveNumber 로 또 적용되지 않게 이미 board 는 써둠)
    this.ctx.sendToPeer(encodeMove(x, y, stone, this.moveNumber));

    // 로컬 사운드/이펙트
    sound.play('pop');

    // 승리 / 무승부 판정
    const win = checkWin(this.board, x, y, stone);
    if (win) {
      this.winInfo = win;
      this.finishAsHost(stone, 'five');
      return;
    }
    if (isBoardFull(this.board)) {
      this.finishAsHost(null, 'draw');
      return;
    }

    // 턴 넘김
    this.currentTurn = stone === 'B' ? 'W' : 'B';
    this.turnStartedAt = performance.now();
  }

  private finishAsHost(winner: 'B' | 'W' | null, reason: 'five' | 'timeout' | 'draw'): void {
    if (this.gameFinished) return;
    this.gameFinished = true;
    this.gameOver = { winner, reason };

    const durationMs = Math.max(0, performance.now() - this.startedAt);
    // 공통 summary — 결과 화면이 쓸 수 있는 정보. peerId 는 각 수신자별로 끼워넣음.
    const baseSummary: Record<string, unknown> = {
      gameId: 'gomoku',
      reason,
      moveCount: this.moveNumber,
      durationMs,
      hostNickname: this.hostNickname,
      guestNickname: this.guestNickname,
      winnerNickname:
        winner === 'B' ? this.hostNickname :
        winner === 'W' ? this.guestNickname :
        null,
      winnerSide: winner, // 'B' | 'W' | null — 관전자 UI 에서 돌 아이콘 강조용
    };

    // 각 참가자 시점별 GameResult 생성해 peer 별로 전송
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId) continue;

      let myWinner: GameResult['winner'];
      if (winner === null) {
        myWinner = null;
      } else if (p.role === 'spectator') {
        // 관전자는 항상 opponent 관점 (자기가 이긴 게 아니니)
        myWinner = 'opponent';
      } else {
        // 플레이어: 그 피어의 색이 winner와 일치하는지
        const peerStone: 'B' | 'W' = p.isHost ? 'B' : 'W';
        myWinner = peerStone === winner ? 'me' : 'opponent';
      }
      const peerResult: GameResult = {
        winner: myWinner,
        summary: { ...baseSummary, myPeerId: p.peerId },
      };
      this.ctx.sendToPeer(encodeEnd(peerResult), { target: p.peerId });
    }

    // 호스트 본인 endGame
    const myResult: GameResult = {
      winner: winner === null ? null : (winner === 'B' ? 'me' : 'opponent'),
      summary: { ...baseSummary, myPeerId: this.myPeerId },
    };
    this.scheduleEndGame(myResult);
  }

  // ============================================
  // 공통: 확정된 수 적용 (호스트·게스트 모두)
  // ============================================

  private applyMove(x: number, y: number, stone: 'B' | 'W', moveNumber: number): void {
    if (this.gameFinished) return;
    // 중복 방어: 이미 이 번호의 수가 적용됐으면 skip
    if (moveNumber <= this.moveNumber) return;

    this.board[y]![x] = stone;
    this.moveNumber = moveNumber;
    this.lastMove = { x, y };
    this.currentTurn = stone === 'B' ? 'W' : 'B';
    this.turnStartedAt = performance.now();

    // 로컬 승리 판정은 참고만 (winInfo 표시용). 실제 게임 종료는 호스트의 go:end 를 기다림.
    const win = checkWin(this.board, x, y, stone);
    if (win) this.winInfo = win;

    sound.play('pop');
  }

  // ============================================
  // 원격 end 처리 (게스트/관전자)
  // ============================================

  private handleRemoteEnd(result: GameResult): void {
    if (this.gameFinished) return;
    this.gameFinished = true;

    const summary = result.summary ?? {};
    const reason = (summary['reason'] as RenderState['gameOver'] extends infer G
      ? G extends { reason: infer R } ? R : never : never) ?? 'five';
    // winner 추론: my winner 'me' 면 내 돌, 'opponent' 면 상대 돌
    let winner: 'B' | 'W' | null = null;
    if (result.winner === 'me') {
      winner = this.mySide;
    } else if (result.winner === 'opponent') {
      // 상대 = 내 색의 반대
      winner = this.mySide === 'B' ? 'W' : this.mySide === 'W' ? 'B' : null;
    }
    this.gameOver = { winner, reason: reason as 'five' | 'timeout' | 'draw' };

    this.scheduleEndGame(result);
  }

  /** 게임 종료 시 결과 화면으로 이동 (승리 하이라이트 여운 최소) */
  private scheduleEndGame(result: GameResult): void {
    if (this.endGameScheduled) return;
    this.endGameScheduled = true;
    window.setTimeout(() => {
      if (this.destroyed) return;
      this.ctx.endGame(result);
    }, 1000);
  }

  // ============================================
  // 입력 (마우스)
  // ============================================

  private attachInput(): void {
    if (this.isSpectator) return; // 관전자는 입력 없음
    this.ctx.canvas.addEventListener('mousemove', this.onMouseMove);
    this.ctx.canvas.addEventListener('mouseleave', this.onMouseLeave);
    this.ctx.canvas.addEventListener('click', this.onClick);
  }

  private detachInput(): void {
    if (!this.ctx?.canvas) return;
    this.ctx.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.ctx.canvas.removeEventListener('mouseleave', this.onMouseLeave);
    this.ctx.canvas.removeEventListener('click', this.onClick);
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (this.gameFinished) { this.hoverCell = null; return; }
    if (this.currentTurn !== this.mySide) { this.hoverCell = null; return; }

    const rect = this.ctx.canvas.getBoundingClientRect();
    const cell = this.renderer.canvasToCell(
      e.clientX - rect.left,
      e.clientY - rect.top,
      this.boardSize,
    );
    if (!cell) { this.hoverCell = null; return; }
    if (this.board[cell.y]?.[cell.x] !== null) { this.hoverCell = null; return; }

    const legal = isLegal(this.board, cell.x, cell.y, this.mySide!);
    this.hoverCell = { x: cell.x, y: cell.y, legal };
  };

  private onMouseLeave = (): void => {
    this.hoverCell = null;
  };

  private onClick = (e: MouseEvent): void => {
    if (this.gameFinished) return;
    if (this.currentTurn !== this.mySide) return;

    const rect = this.ctx.canvas.getBoundingClientRect();
    const cell = this.renderer.canvasToCell(
      e.clientX - rect.left,
      e.clientY - rect.top,
      this.boardSize,
    );
    if (!cell) return;
    if (!isLegal(this.board, cell.x, cell.y, this.mySide!)) {
      // 금수 → 가벼운 피드백
      sound.play('button_click');
      return;
    }

    // 호스트는 자기 수 즉시 로컬 처리 (broadcast 포함)
    // 게스트는 요청만 보냄 (호스트가 검증 후 broadcast 하면 그 때 로컬에도 적용됨)
    if (this.isHost) {
      this.handleRequestMove(cell.x, cell.y, 'B');
    } else {
      this.ctx.sendToPeer(encodeRequestMove(cell.x, cell.y));
    }
  };
}

// ============================================
// Factory
// ============================================

export function createGomokuGame(): GameModule {
  return new GomokuGame();
}
