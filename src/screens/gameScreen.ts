import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import type { HostSession, GuestSession } from '../core/peer';
import { getGameById } from '../games/registry';
import type { GameContext, GameModule, RoomState } from '../games/types';
import { createMenuScreen } from './menu';
import { createResultScreenAsHostScreen, createResultScreenAsGuestScreen } from './resultScreen';

/**
 * 게임 실행 화면 (호스트용 / 게스트용 factory 2종)
 *
 * 역할:
 *   1. canvas 마운트 + 헤더 DOM (점수/닉네임/옵션 요약)
 *   2. 레지스트리에서 GameModule lazy 로드 후 start(ctx) 호출
 *   3. Peer 세션 메시지를 'game_msg' 필터링해서 GameModule.onPeerMessage로 전달
 *   4. GameContext.onStatusUpdate → 헤더 점수 DOM 반영
 *   5. ctx.endGame(result) → (3단계 임시) alert 후 메뉴 복귀. resultScreen은 다음 파일에서.
 *   6. 나가기 / 상대 이탈 시 방 정리
 *
 * 소유권:
 *   host/guest 세션은 대기실에서 이 화면으로 "인계"받음 (대기실은 closeOnDispose=false).
 *   이 화면이 dispose될 때 무조건 close한다.
 */

// ============================================
// 공통 유틸
// ============================================

function buildOptionSummary(gameId: string, roomOptions: Record<string, string>): string {
  const game = getGameById(gameId);
  if (!game) return '';
  return game.meta.roomOptions
    .map((opt) => {
      const val = roomOptions[opt.key] ?? opt.defaultValue;
      const choice = opt.choices.find((c) => c.value === val);
      return `${opt.label}: ${choice?.label ?? val}`;
    })
    .join(' · ');
}

function buildHeaderHTML(args: {
  hostNickname: string;
  guestNickname: string;
  optionSummary: string;
}): string {
  return `
    <div class="game-header">
      <button class="back-btn-inline" id="leave-btn" title="나가기">×</button>

      <div class="game-header-player game-header-player-host">
        <span class="participant-badge">🐱 방장</span>
        <span class="game-player-name">${escapeHtml(args.hostNickname)}</span>
      </div>

      <div class="game-score">
        <span class="game-score-home" id="score-home">0</span>
        <span class="game-score-sep">:</span>
        <span class="game-score-away" id="score-away">0</span>
      </div>

      <div class="game-header-player game-header-player-guest">
        <span class="game-player-name">${escapeHtml(args.guestNickname)}</span>
        <span class="participant-badge participant-badge-lavender">🐻 손님</span>
      </div>

      <div class="game-room-info">${escapeHtml(args.optionSummary)}</div>
    </div>

    <div class="game-canvas-wrap">
      <canvas id="game-canvas" class="game-canvas"></canvas>
    </div>
  `;
}

/** 점수 DOM에 번쩍임 애니메이션 재시작 */
function flashScore(el: HTMLElement): void {
  el.classList.remove('score-flash');
  // 강제 reflow — 동일 클래스 다시 추가해도 애니메이션이 새로 시작되도록
  void el.offsetWidth;
  el.classList.add('score-flash');
}

// ============================================
// 호스트 게임 화면
// ============================================

export interface GameScreenAsHostArgs {
  host: HostSession;
  roomState: RoomState;
}

export function createGameScreenAsHostScreen(args: GameScreenAsHostArgs): Screen {
  const { host, roomState } = args;
  let gameModule: GameModule | null = null;
  let disposed = false;
  // 결과 화면으로 이동할 땐 세션 소유권 넘기므로 close 하지 않음
  let closeOnDispose = true;

  return {
    render() {
      const game = getGameById(roomState.gameId);
      if (!game) {
        queueMicrotask(() => router.reset(() => createMenuScreen()));
        return document.createElement('div');
      }

      const hostNickname = roomState.hostNickname;
      const guestNickname = roomState.guestNickname ?? '상대';
      const optionSummary = buildOptionSummary(roomState.gameId, roomState.roomOptions);

      const el = document.createElement('div');
      el.className = 'game-screen';
      el.innerHTML = buildHeaderHTML({ hostNickname, guestNickname, optionSummary });

      const canvas = el.querySelector<HTMLCanvasElement>('#game-canvas')!;
      const scoreHome = el.querySelector<HTMLSpanElement>('#score-home')!;
      const scoreAway = el.querySelector<HTMLSpanElement>('#score-away')!;
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;

      // 점수 변화 감지용 이전 값 (호스트 시점 로컬 state)
      let lastHostScore = 0;
      let lastGuestScore = 0;

      const myPlayerId = host.myPeerId;
      const players = roomState.players;

      // GameContext — 호스트 시점
      const ctx: GameContext = {
        canvas,
        role: 'host',
        myPlayerId,
        isSpectator: false,
        players,
        myNickname: hostNickname,
        opponentNickname: guestNickname,
        roomOptions: roomState.roomOptions,
        sendToPeer: (msg, options) => {
          // target 있으면 특정 게스트에게만, 없으면 모든 게스트에게 broadcast
          if (options?.target) {
            if (options.target !== myPlayerId) {
              host.sendTo(options.target, {
                type: 'game_msg',
                payload: msg,
                target: options.target,
                from: myPlayerId,
              });
            }
          } else {
            host.send({ type: 'game_msg', payload: msg, from: myPlayerId });
          }
        },
        endGame: (result) => {
          // GOAL! 이펙트를 잠깐 여운으로 보여준 뒤 결과 화면 전환
          // (loop는 계속 돌고 파티클이 자연스럽게 fade-out 하므로 정지 느낌 없음)
          window.setTimeout(() => {
            if (disposed) return;
            closeOnDispose = false; // host 소유권을 결과 화면에 넘김
            router.replace(() =>
              createResultScreenAsHostScreen({ host, roomState, result })
            );
          }, 900);
        },
        onStatusUpdate: (status) => {
          const h = Number(status['hostScore']) || 0;
          const g = Number(status['guestScore']) || 0;
          if (scoreHome.textContent !== String(h)) {
            scoreHome.textContent = String(h);
            if (h > lastHostScore) flashScore(scoreHome);
          }
          if (scoreAway.textContent !== String(g)) {
            scoreAway.textContent = String(g);
            if (g > lastGuestScore) flashScore(scoreAway);
          }
          lastHostScore = h;
          lastGuestScore = g;
        },
      };

      // HostSession 메시지 라우팅 — game_msg를 (필요시 다른 게스트에) relay + 호스트 로컬 소비
      host.onMessage = (msg, fromPeerId) => {
        if (msg.type !== 'game_msg') return;
        // target이 다른 게스트를 향하면 그 쪽으로만 forward
        if (msg.target && msg.target !== myPlayerId) {
          host.sendTo(msg.target, { ...msg, from: fromPeerId });
          return;
        }
        // target이 없거나 나(호스트)를 향한 경우 → 로컬 소비
        gameModule?.onPeerMessage(msg.payload);
        // target 없으면 다른 게스트들에게도 broadcast (송신자 제외)
        if (!msg.target) {
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) {
              host.sendTo(pid, { ...msg, from: fromPeerId });
            }
          }
        }
      };

      // 게스트가 연결 끊김 → 게임 즉시 종료
      host.onGuestDisconnected = () => {
        alert('상대가 게임을 나갔어요');
        router.reset(() => createMenuScreen());
      };

      // 나가기
      leaveBtn.addEventListener('click', () => {
        if (window.confirm('게임을 나가시겠어요? 상대와의 연결이 끊어져요.')) {
          router.reset(() => createMenuScreen());
        }
      });

      // 게임 모듈 lazy 로드 + 시작
      (async () => {
        try {
          const loaded = await game.load();
          if (disposed) {
            loaded.destroy();
            return;
          }
          gameModule = loaded;
          await gameModule.start(ctx);
        } catch (err) {
          console.error('[gameScreen/host] failed to start game', err);
          alert('게임을 시작할 수 없어요');
          router.reset(() => createMenuScreen());
        }
      })();

      return el;
    },

    dispose() {
      disposed = true;
      gameModule?.destroy();
      gameModule = null;
      host.onMessage = null;
      host.onGuestDisconnected = null;
      host.onJoinRequest = null;
      host.onGuestConnected = null;
      if (closeOnDispose) host.close();
    },
  };
}

// ============================================
// 게스트 게임 화면
// ============================================

export interface GameScreenAsGuestArgs {
  guest: GuestSession;
  roomState: RoomState;
}

export function createGameScreenAsGuestScreen(args: GameScreenAsGuestArgs): Screen {
  const { guest, roomState } = args;
  let gameModule: GameModule | null = null;
  let disposed = false;
  let closeOnDispose = true;

  return {
    render() {
      const game = getGameById(roomState.gameId);
      if (!game) {
        queueMicrotask(() => router.reset(() => createMenuScreen()));
        return document.createElement('div');
      }

      const hostNickname = roomState.hostNickname;
      const guestNickname = roomState.guestNickname ?? '나';
      const optionSummary = buildOptionSummary(roomState.gameId, roomState.roomOptions);

      const el = document.createElement('div');
      el.className = 'game-screen';
      el.innerHTML = buildHeaderHTML({ hostNickname, guestNickname, optionSummary });

      const canvas = el.querySelector<HTMLCanvasElement>('#game-canvas')!;
      const scoreHome = el.querySelector<HTMLSpanElement>('#score-home')!;
      const scoreAway = el.querySelector<HTMLSpanElement>('#score-away')!;
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;

      let lastHostScore = 0;
      let lastGuestScore = 0;

      const myPlayerId = guest.myPeerId;
      const players = roomState.players;

      // GameContext — 게스트 시점
      const ctx: GameContext = {
        canvas,
        role: 'guest',
        myPlayerId,
        isSpectator: false,
        players,
        myNickname: guestNickname,
        opponentNickname: hostNickname,
        roomOptions: roomState.roomOptions,
        sendToPeer: (msg, options) => {
          // 게스트는 호스트에게만 직접 전송. target 있으면 호스트가 relay
          const netMsg: { type: 'game_msg'; payload: typeof msg; from: string; target?: string } = {
            type: 'game_msg',
            payload: msg,
            from: myPlayerId,
          };
          if (options?.target) netMsg.target = options.target;
          guest.send(netMsg);
        },
        endGame: (result) => {
          window.setTimeout(() => {
            if (disposed) return;
            closeOnDispose = false;
            router.replace(() =>
              createResultScreenAsGuestScreen({ guest, roomState, result })
            );
          }, 900);
        },
        onStatusUpdate: (status) => {
          const h = Number(status['hostScore']) || 0;
          const g = Number(status['guestScore']) || 0;
          if (scoreHome.textContent !== String(h)) {
            scoreHome.textContent = String(h);
            if (h > lastHostScore) flashScore(scoreHome);
          }
          if (scoreAway.textContent !== String(g)) {
            scoreAway.textContent = String(g);
            if (g > lastGuestScore) flashScore(scoreAway);
          }
          lastHostScore = h;
          lastGuestScore = g;
        },
      };

      guest.onMessage = (msg) => {
        if (msg.type !== 'game_msg') return;
        // target이 나를 향하지 않으면 무시 (호스트가 relay 단계에서 거름)
        if (msg.target && msg.target !== myPlayerId) return;
        gameModule?.onPeerMessage(msg.payload);
      };

      guest.onDisconnect = () => {
        alert('방장이 게임을 나갔어요');
        router.reset(() => createMenuScreen());
      };

      leaveBtn.addEventListener('click', () => {
        if (window.confirm('게임을 나가시겠어요? 방에서 완전히 나가요.')) {
          router.reset(() => createMenuScreen());
        }
      });

      (async () => {
        try {
          const loaded = await game.load();
          if (disposed) {
            loaded.destroy();
            return;
          }
          gameModule = loaded;
          await gameModule.start(ctx);
        } catch (err) {
          console.error('[gameScreen/guest] failed to start game', err);
          alert('게임을 시작할 수 없어요');
          router.reset(() => createMenuScreen());
        }
      })();

      return el;
    },

    dispose() {
      disposed = true;
      gameModule?.destroy();
      gameModule = null;
      guest.onMessage = null;
      guest.onDisconnect = null;
      if (closeOnDispose) guest.close();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
