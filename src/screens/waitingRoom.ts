import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage } from '../core/storage';
import type { HostSession, GuestSession, JoinRequest, JoinDecision } from '../core/peer';
import { getGameById } from '../games/registry';
import type { Player, RoomState } from '../games/types';
import { createGameScreenAsHostScreen, createGameScreenAsGuestScreen } from './gameScreen';

/**
 * 대기실 — 호스트 측 / 게스트 측 factory 2종.
 *
 * 다인 지원 (Phase 1-B):
 *   - 방 인원은 게임마다 다름: game.meta.minPlayers ~ maxPlayers
 *   - 호스트: HostSession.maxAccepted는 createRoom에서 이미 maxPlayers-1로 세팅됨
 *   - 참가자 UI는 players 배열 기반 동적 렌더 (남는 자리는 점선 박스)
 *   - 시작 조건: 참가자 수 >= minPlayers
 *   - 게스트 입장/퇴장 시 호스트가 player_joined / player_left + room_state broadcast
 *   - 게스트 측은 room_state 수신 시 participants 섹션을 통째로 재렌더
 */

// ============================================
// 공통 헬퍼
// ============================================

/** 참가자 리스트 HTML — 방 정원만큼 슬롯 생성, 빈 슬롯은 점선 */
function renderParticipantsHTML(
  players: Player[],
  maxPlayers: number,
  myPeerId: string | null,
): string {
  const cells: string[] = [];
  for (let i = 0; i < maxPlayers; i++) {
    const p = players[i];
    if (p) {
      const badgeText = p.isHost ? '방장' : '손님';
      const badgeCls = p.isHost ? '' : 'participant-badge-lavender';
      const hostCls = p.isHost ? 'participant-host' : 'participant-guest';
      const isMe = myPeerId !== null && p.peerId === myPeerId;
      const nameHtml = isMe
        ? `${escapeHtml(p.nickname)} <span class="participant-you">(나)</span>`
        : escapeHtml(p.nickname);
      cells.push(`
        <div class="participant ${hostCls}">
          <span class="participant-badge ${badgeCls}">${badgeText}</span>
          <span class="participant-name">${nameHtml}</span>
        </div>
      `);
    } else {
      cells.push(`
        <div class="participant participant-empty">
          <span class="participant-badge">빈 자리</span>
          <span class="participant-name">친구를 기다리는 중...</span>
        </div>
      `);
    }
  }
  return cells.join('');
}

function buildOptionSummary(roomState: RoomState, gameId: string): string {
  const game = getGameById(gameId);
  if (!game) return '';
  return game.meta.roomOptions
    .map((opt) => {
      const val = roomState.roomOptions[opt.key] ?? opt.defaultValue;
      const choice = opt.choices.find((c) => c.value === val);
      return `${opt.label}: ${choice?.label ?? val}`;
    })
    .join(' · ');
}

// ============================================
// 호스트 대기실
// ============================================

export interface WaitingRoomAsHostArgs {
  host: HostSession;
  gameId: string;
  isPrivate: boolean;
  password: string;
  roomOptions: Record<string, string>;
}

export function createWaitingRoomAsHostScreen(args: WaitingRoomAsHostArgs): Screen {
  const { host, gameId, isPrivate, password, roomOptions } = args;

  let closeOnDispose = true;
  const hostNickname = storage.getNickname();

  // 방 내부 상태 — guestPlayers는 방장 제외한 참가자들
  let guestPlayers: Player[] = [];

  const game = getGameById(gameId);
  const maxPlayers = game?.meta.maxPlayers ?? 2;
  const minPlayers = game?.meta.minPlayers ?? 2;

  const hostPlayer: Player = {
    peerId: host.myPeerId,
    nickname: hostNickname,
    isHost: true,
    role: 'player',
  };

  /** 현재 방 상태 스냅샷 (broadcast/게스트에게 넘길 때 사용) */
  const snapshotRoomState = (): RoomState => {
    const players: Player[] = [hostPlayer, ...guestPlayers];
    return {
      roomId: host.roomId,
      gameId,
      players,
      hostNickname,
      // 호환용: 2인 게임에서 기존 코드가 참조할 수 있으므로 첫 게스트 닉네임만
      guestNickname: guestPlayers[0]?.nickname ?? null,
      isPrivate,
      roomOptions,
      status: 'waiting',
    };
  };

  return {
    render() {
      if (!game) {
        queueMicrotask(() => router.back());
        return document.createElement('div');
      }

      const optionSummary = buildOptionSummary(snapshotRoomState(), gameId);

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="leave-btn" title="방 나가기">×</button>

        <div class="card" style="min-width: 460px;">
          <div class="card-title">🎀 대기실</div>
          <div class="card-subtitle">${escapeHtml(game.meta.name)}</div>

          <div class="room-code-box">
            <div class="room-code-label">방 코드</div>
            <div class="room-code-row">
              <span class="room-code" id="room-code-text">${escapeHtml(host.roomId)}</span>
              <button class="btn btn-secondary btn-sm" id="copy-btn">📋 복사</button>
            </div>
            <div class="room-code-hint">이 코드를 친구에게 공유하세요</div>
          </div>

          <div class="participants" id="participants"></div>

          <div class="room-info">
            <span class="room-info-item">${escapeHtml(optionSummary)}</span>
            <span class="room-info-item">${isPrivate ? '🔒 비공개' : '🌐 공개'}</span>
            <span class="room-info-item" id="player-count">1 / ${maxPlayers}</span>
          </div>

          <button class="btn btn-primary btn-lg btn-block" id="start-btn" disabled>
            친구를 기다리는 중...
          </button>
        </div>

        <div class="toast" id="toast"></div>
      `;

      const participantsEl = el.querySelector<HTMLDivElement>('#participants')!;
      const startBtn = el.querySelector<HTMLButtonElement>('#start-btn')!;
      const copyBtn = el.querySelector<HTMLButtonElement>('#copy-btn')!;
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;
      const toastEl = el.querySelector<HTMLDivElement>('#toast')!;
      const playerCountEl = el.querySelector<HTMLSpanElement>('#player-count')!;

      /** 참가자 리스트 / 카운터 / 시작 버튼 상태 동기화 */
      const refreshUI = (): void => {
        const players = [hostPlayer, ...guestPlayers];
        participantsEl.innerHTML = renderParticipantsHTML(players, maxPlayers, hostPlayer.peerId);
        playerCountEl.textContent = `${players.length} / ${maxPlayers}`;

        if (players.length >= minPlayers) {
          startBtn.disabled = false;
          startBtn.textContent = '게임 시작';
        } else {
          startBtn.disabled = true;
          const need = minPlayers - players.length;
          startBtn.textContent = `${need}명 더 필요해요`;
        }
      };
      refreshUI();

      // ---- 방 로직 콜백 ----
      host.onJoinRequest = (req: JoinRequest, fromPeerId: string): JoinDecision => {
        if (guestPlayers.length >= maxPlayers - 1) {
          return { accept: false, reason: 'room_full' };
        }
        if (isPrivate && req.password !== password) {
          return { accept: false, reason: 'wrong_password' };
        }
        // 수락 — preview에 새 게스트 포함해서 반환 (게스트가 받자마자 본인 포함된 상태)
        const newPlayer: Player = {
          peerId: fromPeerId,
          nickname: req.nickname,
          isHost: false,
          role: 'player',
        };
        const preview: RoomState = {
          ...snapshotRoomState(),
          players: [hostPlayer, ...guestPlayers, newPlayer],
          guestNickname: guestPlayers[0]?.nickname ?? newPlayer.nickname,
        };
        return { accept: true, roomState: preview };
      };

      host.onGuestConnected = (nickname, peerId) => {
        const newPlayer: Player = { peerId, nickname, isHost: false, role: 'player' };
        guestPlayers.push(newPlayer);

        // 다른 기존 게스트들에게 새 게스트 입장 알림 (신규 게스트는 join_accepted로 이미 받음)
        host.send({ type: 'player_joined', player: newPlayer });
        // 전원에게 최신 방 상태 동기화
        host.send({ type: 'room_state', roomState: snapshotRoomState() });

        refreshUI();
        showToast(`${nickname} 님이 들어왔어요`);
      };

      host.onGuestDisconnected = (peerId) => {
        const removed = guestPlayers.find((p) => p.peerId === peerId);
        guestPlayers = guestPlayers.filter((p) => p.peerId !== peerId);
        if (removed) {
          host.send({ type: 'player_left', peerId, nickname: removed.nickname });
          host.send({ type: 'room_state', roomState: snapshotRoomState() });
        }
        refreshUI();
        showToast(`${removed?.nickname ?? '게스트'} 님이 나갔어요`);
      };

      host.onMessage = (msg) => {
        console.debug('[waitingRoom] message from guest:', msg);
      };

      // ---- 방 코드 복사 ----
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(host.roomId);
          showToast('방 코드를 복사했어요!');
        } catch {
          const ok = window.prompt('방 코드를 복사하세요:', host.roomId);
          if (ok !== null) showToast('방 코드를 확인했어요');
        }
      });

      // ---- 시작 버튼 ----
      startBtn.addEventListener('click', () => {
        const players = [hostPlayer, ...guestPlayers];
        if (players.length < minPlayers) return;

        host.send({ type: 'game_start' });

        closeOnDispose = false;
        const rs: RoomState = { ...snapshotRoomState(), status: 'playing' };
        router.replace(() => createGameScreenAsHostScreen({ host, roomState: rs }));
      });

      // ---- 방 나가기 ----
      leaveBtn.addEventListener('click', () => {
        const confirmMsg = guestPlayers.length > 0
          ? '방을 나가면 모든 참가자의 연결이 끊겨요. 나가시겠어요?'
          : '방을 나가시겠어요?';
        if (window.confirm(confirmMsg)) {
          router.back();
        }
      });

      // ---- 토스트 헬퍼 ----
      let toastTimer: number | undefined;
      function showToast(text: string): void {
        toastEl.textContent = text;
        toastEl.classList.add('show');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
          toastEl.classList.remove('show');
        }, 2200);
      }

      return el;
    },

    dispose() {
      if (closeOnDispose) {
        host.close();
      }
      host.onJoinRequest = null;
      host.onGuestConnected = null;
      host.onGuestDisconnected = null;
      host.onMessage = null;
    },
  };
}

// ============================================
// 게스트 대기실
// ============================================

export interface WaitingRoomAsGuestArgs {
  guest: GuestSession;
  /** join_accepted로 받은 초기 방 상태 (본인 포함) */
  initialRoomState: RoomState;
}

export function createWaitingRoomAsGuestScreen(args: WaitingRoomAsGuestArgs): Screen {
  const { guest, initialRoomState } = args;
  let closeOnDispose = true;
  let roomState: RoomState = initialRoomState;
  const myPeerId = guest.myPeerId;

  return {
    render() {
      const game = getGameById(roomState.gameId);
      if (!game) {
        queueMicrotask(() => router.back());
        return document.createElement('div');
      }

      const maxPlayers = game.meta.maxPlayers;
      const optionSummary = buildOptionSummary(roomState, roomState.gameId);

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="leave-btn" title="방 나가기">×</button>

        <div class="card" style="min-width: 460px;">
          <div class="card-title">🎀 대기실</div>
          <div class="card-subtitle">${escapeHtml(game.meta.name)}</div>

          <div class="room-code-box">
            <div class="room-code-label">방 코드</div>
            <div class="room-code-row">
              <span class="room-code">${escapeHtml(roomState.roomId)}</span>
            </div>
          </div>

          <div class="participants" id="participants"></div>

          <div class="room-info">
            <span class="room-info-item">${escapeHtml(optionSummary)}</span>
            <span class="room-info-item">${roomState.isPrivate ? '🔒 비공개' : '🌐 공개'}</span>
            <span class="room-info-item" id="player-count">${roomState.players.length} / ${maxPlayers}</span>
          </div>

          <button class="btn btn-secondary btn-lg btn-block" id="waiting-label" disabled>
            방장이 시작하기를 기다리는 중...
          </button>
        </div>
      `;

      const participantsEl = el.querySelector<HTMLDivElement>('#participants')!;
      const playerCountEl = el.querySelector<HTMLSpanElement>('#player-count')!;
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;

      const refreshUI = (): void => {
        participantsEl.innerHTML = renderParticipantsHTML(roomState.players, maxPlayers, myPeerId);
        playerCountEl.textContent = `${roomState.players.length} / ${maxPlayers}`;
      };
      refreshUI();

      guest.onMessage = (msg) => {
        switch (msg.type) {
          case 'room_state':
            roomState = msg.roomState;
            refreshUI();
            break;
          case 'player_joined':
          case 'player_left':
            // 호스트가 뒤이어 room_state도 보내므로 여기선 무시 (UI는 room_state 때 갱신)
            break;
          case 'game_start': {
            closeOnDispose = false;
            const rs: RoomState = { ...roomState, status: 'playing' };
            router.replace(() => createGameScreenAsGuestScreen({ guest, roomState: rs }));
            break;
          }
          case 'game_end':
          case 'game_msg':
            break;
        }
      };

      guest.onDisconnect = () => {
        alert('방장이 방을 나갔어요');
        router.back();
      };

      leaveBtn.addEventListener('click', () => {
        if (window.confirm('방을 나가시겠어요?')) router.back();
      });

      return el;
    },

    dispose() {
      if (closeOnDispose) guest.close();
      guest.onMessage = null;
      guest.onDisconnect = null;
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
