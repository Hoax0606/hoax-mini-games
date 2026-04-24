import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import type { HostSession, GuestSession, JoinRequest, JoinDecision } from '../core/peer';
import { getGameById } from '../games/registry';
import type { GameContext, GameModule, Player, RoomState } from '../games/types';
import { createMenuScreen } from './menu';
import { createResultScreenAsHostScreen, createResultScreenAsGuestScreen } from './resultScreen';
import { buildReactionBarHTML, wireReactionBar, showReactionBubble } from '../ui/reactions';
import { storage } from '../core/storage';

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
  /** 관전자 뷰면 점수판 대신 "관전 중" 배지 표시 */
  spectator?: boolean;
}): string {
  const centerHTML = args.spectator
    ? `<div class="game-score game-score-spectator">👀 관전 중</div>`
    : `
      <div class="game-score">
        <span class="game-score-home" id="score-home">0</span>
        <span class="game-score-sep">:</span>
        <span class="game-score-away" id="score-away">0</span>
      </div>
    `;

  return `
    <div class="game-header">
      <button class="back-btn-inline" id="leave-btn" title="나가기">×</button>

      <div class="game-header-player game-header-player-host">
        <span class="participant-badge">🐱 방장</span>
        <span class="game-player-name">${escapeHtml(args.hostNickname)}</span>
      </div>

      ${centerHTML}

      <div class="game-header-player game-header-player-guest">
        <span class="game-player-name">${escapeHtml(args.guestNickname)}</span>
        <span class="participant-badge participant-badge-lavender">🐻 손님</span>
      </div>

      <div class="game-room-info">
        <span class="game-room-info-text">${escapeHtml(args.optionSummary)}</span>
        <span class="ping-badge ping-pending" id="ping-badge">⏳ 측정 중</span>
      </div>
    </div>

    <div class="game-canvas-wrap">
      <canvas id="game-canvas" class="game-canvas"></canvas>
    </div>

    <div class="reaction-bar-floating">${buildReactionBarHTML()}</div>
  `;
}

/** 점수 DOM에 번쩍임 애니메이션 재시작 */
function flashScore(el: HTMLElement): void {
  el.classList.remove('score-flash');
  // 강제 reflow — 동일 클래스 다시 추가해도 애니메이션이 새로 시작되도록
  void el.offsetWidth;
  el.classList.add('score-flash');
}

/** ping(ms)를 배지 엘리먼트에 반영. null = 끊김/측정불가 */
function updatePingBadge(el: HTMLElement, ms: number | null): void {
  if (ms === null) {
    el.textContent = '⚠️ 끊김';
    el.className = 'ping-badge ping-dead';
    return;
  }
  let cls: string;
  let icon: string;
  if (ms < 60)       { cls = 'ping-good'; icon = '🟢'; }
  else if (ms < 150) { cls = 'ping-ok';   icon = '🟡'; }
  else               { cls = 'ping-slow'; icon = '🔴'; }
  el.textContent = `${icon} ${ms}ms`;
  el.className = `ping-badge ${cls}`;
}

// ============================================
// 호스트 게임 화면
// ============================================

export interface GameScreenAsHostArgs {
  host: HostSession;
  roomState: RoomState;
  /** 비공개방 여부 — 게임 중 관전자 입장 요청 시 비번 검증에 사용 */
  isPrivate: boolean;
  /** 방장이 방 만들 때 지정한 비번 (공개방이면 빈 문자열) — 관전자 입장 비번 검증용 */
  password: string;
}

export function createGameScreenAsHostScreen(args: GameScreenAsHostArgs): Screen {
  const { host, roomState, isPrivate, password } = args;
  let gameModule: GameModule | null = null;
  let disposed = false;
  // 결과 화면으로 이동할 땐 세션 소유권 넘기므로 close 하지 않음
  let closeOnDispose = true;

  // 게임 시작 시점에 들어와 있던 플레이어들 (관전자와 구분).
  // 게임 도중에 들어오는 사람은 전부 spectators 로. role='spectator' 마킹.
  const activePlayers: Player[] = [...roomState.players];
  const spectators: Player[] = [];

  /** 현재 방 상태 스냅샷 — 관전자에게 join_accepted 보낼 때 + player_joined broadcast 시 사용 */
  const snapshotRoomState = (): RoomState => ({
    ...roomState,
    players: [...activePlayers, ...spectators],
    status: 'playing',
  });

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
          // 플랫폼 레벨 game_end broadcast — 관전자도 받아서 결과 화면으로 이동.
          // 기존 플레이어들은 각 게임의 내부 메시지(bt:end / ah:end)로 이미 이동 경로가 있으므로
          // game_end 를 추가로 받아도 게스트 쪽에서 isSpectator 체크 후 무시한다.
          host.send({ type: 'game_end', result });

          // GOAL! 이펙트를 잠깐 여운으로 보여준 뒤 결과 화면 전환
          // (loop는 계속 돌고 파티클이 자연스럽게 fade-out 하므로 정지 느낌 없음)
          window.setTimeout(() => {
            if (disposed) return;
            closeOnDispose = false; // host 소유권을 결과 화면에 넘김
            router.replace(() =>
              createResultScreenAsHostScreen({ host, roomState, result, isPrivate, password })
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
        // 이모지 반응: 내 화면에 표시 + 다른 게스트들에게 forward
        if (msg.type === 'reaction') {
          showReactionBubble(msg.emoji, msg.nickname);
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) host.sendTo(pid, msg);
          }
          return;
        }
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

      // 이모지 반응 버튼 (게임 중에도 사용 가능)
      wireReactionBar(el, (emoji) => {
        const myNick = storage.getNickname();
        showReactionBubble(emoji, myNick);
        host.send({ type: 'reaction', emoji, nickname: myNick });
      });

      // 게임 중에 새로 들어오는 연결 = 관전자 후보.
      // 비공개방이면 비번 검증. 통과하면 spectator로 수락, RoomState(status='playing') 반환.
      host.onJoinRequest = (req: JoinRequest, fromPeerId: string): JoinDecision => {
        if (isPrivate && req.password !== password) {
          return { accept: false, reason: 'wrong_password' };
        }
        const newSpec: Player = {
          peerId: fromPeerId,
          nickname: req.nickname,
          isHost: false,
          role: 'spectator',
        };
        // preview: spectators 배열에 선반영해서 돌려준다 (아직 실제 add는 onGuestConnected 에서)
        const preview: RoomState = {
          ...snapshotRoomState(),
          players: [...activePlayers, ...spectators, newSpec],
        };
        return { accept: true, roomState: preview, asSpectator: true };
      };

      // 관전자 수락 완료 → spectators 배열에 확정 추가 + 기존 연결 전원에게 알림
      host.onGuestConnected = (nickname, peerId) => {
        const newSpec: Player = {
          peerId,
          nickname,
          isHost: false,
          role: 'spectator',
        };
        spectators.push(newSpec);
        // 기존 피어들(플레이어+기존 관전자)에게 새 관전자 알림. 게스트 gameScreen에서 이 메시지는
        // 로그/토스트 용도. ctx.players 자동 업데이트는 하지 않는다(MVP 범위 밖).
        host.send({ type: 'player_joined', player: newSpec });
      };

      // 연결 끊김: 플레이어 이탈이면 게임 즉시 종료, 관전자 이탈이면 조용히 제거만.
      host.onGuestDisconnected = (peerId) => {
        const specIdx = spectators.findIndex((s) => s.peerId === peerId);
        if (specIdx >= 0) {
          const [removed] = spectators.splice(specIdx, 1);
          if (removed) {
            host.send({ type: 'player_left', peerId, nickname: removed.nickname });
          }
          return;
        }
        alert('상대가 게임을 나갔어요');
        router.reset(() => createMenuScreen());
      };

      // 나가기
      leaveBtn.addEventListener('click', () => {
        if (window.confirm('게임을 나가시겠어요? 상대와의 연결이 끊어져요.')) {
          router.reset(() => createMenuScreen());
        }
      });

      // Ping 배지: 여러 게스트 중 "가장 느린" 쪽을 대표로 표시 (호스트 시점 가장 나쁜 연결)
      const pingBadgeEl = el.querySelector<HTMLSpanElement>('#ping-badge')!;
      host.onPingChanged = (pings) => {
        if (pings.size === 0) {
          updatePingBadge(pingBadgeEl, null);
          return;
        }
        const worstPing = Math.max(...pings.values());
        updatePingBadge(pingBadgeEl, worstPing);
      };

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
      host.onPingChanged = null;
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

  // "나"의 role 판정 — roomState.players 에서 내 peerId 찾아 role='spectator' 면 관전 모드.
  // (게임 중 입장한 관전자는 roomState가 호스트에서 build 된 시점에 이미 role='spectator' 마킹되어 있음)
  const myPlayerId = guest.myPeerId;
  const mySelf = roomState.players.find((p) => p.peerId === myPlayerId);
  const isSpectator = mySelf?.role === 'spectator';

  return {
    render() {
      const game = getGameById(roomState.gameId);
      if (!game) {
        queueMicrotask(() => router.reset(() => createMenuScreen()));
        return document.createElement('div');
      }

      const hostNickname = roomState.hostNickname;
      const guestNickname = roomState.guestNickname ?? (isSpectator ? '관전자' : '나');
      const optionSummary = buildOptionSummary(roomState.gameId, roomState.roomOptions);

      const el = document.createElement('div');
      el.className = 'game-screen';
      el.innerHTML = buildHeaderHTML({ hostNickname, guestNickname, optionSummary, spectator: isSpectator });

      const canvas = el.querySelector<HTMLCanvasElement>('#game-canvas')!;
      // 관전자 뷰는 점수판 대신 "관전 중" 배지라 score-home/away 엘리먼트가 없다.
      const scoreHome = el.querySelector<HTMLSpanElement>('#score-home');
      const scoreAway = el.querySelector<HTMLSpanElement>('#score-away');
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;

      let lastHostScore = 0;
      let lastGuestScore = 0;

      const players = roomState.players;

      // GameContext — 게스트(또는 관전자) 시점
      const ctx: GameContext = {
        canvas,
        role: 'guest',
        myPlayerId,
        isSpectator,
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
          // 관전자 뷰는 점수판 DOM이 없으므로 업데이트 스킵
          if (!scoreHome || !scoreAway) return;
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
        // 이모지 반응 — 호스트가 broadcast/relay 한 것
        if (msg.type === 'reaction') {
          showReactionBubble(msg.emoji, msg.nickname);
          return;
        }
        // 관전자 전용 종료 경로 — 플레이어들은 각 게임의 내부 메시지(bt:end / ah:end) 로
        // ctx.endGame 을 통해 이미 이동하므로 game_end 는 무시해도 된다.
        if (msg.type === 'game_end') {
          if (isSpectator && !disposed) {
            closeOnDispose = false;
            router.replace(() =>
              createResultScreenAsGuestScreen({ guest, roomState, result: msg.result })
            );
          }
          return;
        }
        if (msg.type !== 'game_msg') return;
        // target이 나를 향하지 않으면 무시 (호스트가 relay 단계에서 거름)
        if (msg.target && msg.target !== myPlayerId) return;
        gameModule?.onPeerMessage(msg.payload);
      };

      // 이모지 반응 버튼 (게임 중) — 게스트는 호스트에게만 송신
      wireReactionBar(el, (emoji) => {
        const myNick = storage.getNickname();
        showReactionBubble(emoji, myNick);
        guest.send({ type: 'reaction', emoji, nickname: myNick });
      });

      guest.onDisconnect = () => {
        alert(isSpectator ? '방이 닫혔어요' : '방장이 게임을 나갔어요');
        router.reset(() => createMenuScreen());
      };

      leaveBtn.addEventListener('click', () => {
        if (window.confirm('게임을 나가면 방도 같이 나가요. 나가시겠어요?')) {
          router.reset(() => createMenuScreen());
        }
      });

      // Ping 배지 — 호스트가 보고해주는 내 편도 지연 표시
      const pingBadgeEl = el.querySelector<HTMLSpanElement>('#ping-badge')!;
      guest.onPingChanged = (ms) => updatePingBadge(pingBadgeEl, ms);

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
      guest.onPingChanged = null;
      if (closeOnDispose) guest.close();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
