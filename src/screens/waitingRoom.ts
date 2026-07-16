import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage } from '../core/storage';
import type { HostSession, GuestSession, JoinRequest, JoinDecision } from '../core/peer';
import { getGameById, GLOBAL_MAX_PLAYERS } from '../games/registry';
import type { Player, RoomState } from '../games/types';
import { createGameScreenAsHostScreen, createGameScreenAsGuestScreen } from './gameScreen';
import { createMenuScreen } from './menu';
import { buildReactionBarHTML, wireReactionBar, showReactionBubble } from '../ui/reactions';
import { buildChatPanelHTML, wireChatPanel, appendChatMessage } from '../ui/chat';
import type { ChatMsg } from '../games/types';
import { publishRoom, updatePublicRoom, unpublishRoom } from '../core/roomDirectory';
import { buildGameTilesHTML, buildGameOptionsHTML } from '../ui/gamePicker';
import { escapeHtml } from '../ui/escape';
import { showReconnectOverlay, hideReconnectOverlay } from '../ui/reconnectOverlay';
import { icon } from '../ui/icons';

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
  showKick = false,
): string {
  void maxPlayers; // 빈 자리는 더 이상 나열하지 않음(게임찾기처럼 실제 인원만). 정원은 상단 카운트로 표시.
  return players.map((p) => {
    const badgeText = p.isHost ? '방장' : '손님';
    const badgeCls = p.isHost ? '' : 'participant-badge-lavender';
    const hostCls = p.isHost ? 'participant-host' : 'participant-guest';
    const isMe = myPeerId !== null && p.peerId === myPeerId;
    const nameHtml = isMe
      ? `${escapeHtml(p.nickname)} <span class="participant-you">(나)</span>`
      : escapeHtml(p.nickname);
    // 게스트 준비 배지 — 준비 완료일 때만 표시(방장/미준비는 표시 안 함)
    const readyTag = !p.isHost && p.ready
      ? `<span class="participant-ready is-ready">준비</span>`
      : '';
    // 방장 화면에서만, 방장 본인이 아닌 참가자에게 강퇴(❌) 버튼
    const kickBtn = showKick && !p.isHost
      ? `<button class="participant-kick" data-kick-peer="${escapeHtml(p.peerId)}" title="강퇴">${icon('close', { size: 16 })}</button>`
      : '';
    return `
      <div class="participant ${hostCls}">
        <span class="participant-badge ${badgeCls}">${badgeText}</span>
        <span class="participant-name">${nameHtml}</span>
        ${readyTag}
        ${kickBtn}
      </div>
    `;
  }).join('');
}

/** 현재 URL에 ?room=XXXXX 붙여 공유용 링크 생성 (base 경로/호스트 자동 유지) */
function buildRoomShareUrl(roomCode: string): string {
  const url = new URL(window.location.href);
  // 방 안의 ?는 기존에 있을 리 없지만 안전하게 set
  url.searchParams.set('room', roomCode);
  // hash는 제거 (혹시라도 있을 경우 깔끔한 링크 유지)
  url.hash = '';
  return url.toString();
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
  /**
   * 결과 화면 '대기실로 이동'으로 재진입할 때, 이미 연결돼 있는 게스트들을 그대로 넘김.
   * (새 방일 땐 undefined — 게스트는 join_request 로 들어온다.) 준비 상태는 리셋된다.
   */
  initialPlayers?: Player[];
}

export function createWaitingRoomAsHostScreen(args: WaitingRoomAsHostArgs): Screen {
  const { host, isPrivate, password } = args;
  // gameId/roomOptions 는 방 안에서 방장이 게임을 고르면 바뀐다 → let.
  let gameId = args.gameId;
  let roomOptions: Record<string, string> = { ...args.roomOptions };

  let closeOnDispose = true;
  let cleanupChatHost: (() => void) | null = null;
  const hostNickname = storage.getNickname();

  // 방 내부 상태 — guestPlayers는 방장 제외한 참가자들.
  // 결과 화면에서 되돌아온 경우 이미 연결된 게스트를 seed (준비는 리셋 → 다시 준비해야 시작 가능).
  let guestPlayers: Player[] = (args.initialPlayers ?? [])
    .filter((p) => !p.isHost)
    .map((p) => ({ ...p, role: 'player', ready: false }));

  // 게임이 아직 안 정해졌을 수 있음(gameId='') → 그때 정원은 전체 상한.
  const currentGame = () => getGameById(gameId);
  const maxPlayers = (): number => currentGame()?.meta.maxPlayers ?? GLOBAL_MAX_PLAYERS;
  const minPlayers = (): number => currentGame()?.meta.minPlayers ?? 2;
  const gameName = (): string => currentGame()?.meta.name ?? '게임 고르는 중';

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
      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="leave-btn" title="방 나가기">×</button>

        <div class="card waiting-card">
          <div class="waiting-head">
            <div class="waiting-head-title">
              <div class="card-title">🎀 대기실</div>
              <div class="card-subtitle" id="game-name">${escapeHtml(gameName())}</div>
            </div>
            <button class="btn btn-secondary btn-sm" id="share-btn" title="초대 링크 복사">${icon('link', { size: 16, hue: '#5b9dff' })} 초대</button>
          </div>

          <div class="waiting-body">
            <div class="waiting-left">
              <div class="waiting-section-title">${icon('users', { size: 18, hue: '#5b9dff' })} 참가자 <span class="waiting-count" id="player-count">1 / ${maxPlayers()}명</span></div>
              <div class="participants" id="participants"></div>
              <button class="btn btn-primary btn-lg btn-block" id="start-btn" disabled>
                친구를 기다리는 중
              </button>
              <div style="margin-top: 10px;">${buildReactionBarHTML()}</div>
            </div>

            <div class="waiting-right">
              <div class="waiting-section-title">${icon('games', { size: 18, hue: '#a06bff' })} 게임 선택 <span class="waiting-section-hint">인원 초과 게임은 잠겨요</span></div>
              <div class="change-game-grid waiting-grid" id="game-grid"></div>
              <div class="change-game-options waiting-options" id="game-options"></div>
            </div>
          </div>
        </div>

        ${buildChatPanelHTML()}

        <div class="toast" id="toast"></div>
      `;

      const participantsEl = el.querySelector<HTMLDivElement>('#participants')!;
      const startBtn = el.querySelector<HTMLButtonElement>('#start-btn')!;
      const gameGridEl = el.querySelector<HTMLDivElement>('#game-grid')!;
      const gameOptionsEl = el.querySelector<HTMLDivElement>('#game-options')!;
      const shareBtn = el.querySelector<HTMLButtonElement>('#share-btn')!;
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;
      const toastEl = el.querySelector<HTMLDivElement>('#toast')!;
      const playerCountEl = el.querySelector<HTMLSpanElement>('#player-count')!;
      const gameNameEl = el.querySelector<HTMLDivElement>('#game-name')!;

      // 공개/비공개 모두 디렉토리(Firebase)에 등록. 비공개방은 isPrivate=true 로 목록에 🔒 표시되고,
      // 입장하려면 비번을 입력해야 함(호스트 onJoinRequest 에서 검증). 게스트 입장/퇴장 때 인원 갱신.
      // 이 항목은 대기→게임→결과 화면 내내 유지되고, 호스트가 방을 완전히 닫을 때만(dispose+closeOnDispose) 제거.
      publishRoom({
        roomId: host.roomId,
        hostNickname,
        gameId,
        gameName: gameName(),
        playerCount: 1,
        maxPlayers: maxPlayers(),
        status: 'waiting',
        isPrivate,
        createdAt: Date.now(),
      }).catch((err) => console.error('[waitingRoom] publishRoom failed', err));

      /** 참가자 리스트 / 카운터 / 게임이름 / 옵션 / 시작·게임선택 버튼 상태 동기화 */
      const refreshUI = (): void => {
        const players = [hostPlayer, ...guestPlayers];
        const max = maxPlayers();
        gameNameEl.textContent = gameName();
        participantsEl.innerHTML = renderParticipantsHTML(players, max, hostPlayer.peerId, true);
        playerCountEl.textContent = `${players.length} / ${max}명`;

        // 게임 타일 그리드 (항상 노출, 인원 초과 게임은 잠금) + 선택 게임 옵션
        gameGridEl.innerHTML = buildGameTilesHTML(players.length, gameId, { enforceMin: false });
        // 옵션은 우측 타일 그리드 아래 고정 바. 크기 고정이라 옵션 유무와 무관하게 그리드 높이 안 변함.
        // 옵션 없는 게임/미선택이면 빈 크림 박스만 그대로 둔다(숨기지 않음).
        const selectedGame = gameId ? getGameById(gameId) : null;
        const hasOptions = !!selectedGame && selectedGame.meta.roomOptions.length > 0;
        gameOptionsEl.innerHTML = hasOptions ? buildGameOptionsHTML(gameId, roomOptions) : '';
        wireGameArea();

        // 강퇴 버튼 배선 — 방장이 해당 게스트 연결을 끊음(onGuestDisconnected 가 정리)
        participantsEl.querySelectorAll<HTMLButtonElement>('.participant-kick').forEach((btn) => {
          btn.addEventListener('click', () => {
            const peerId = btn.dataset.kickPeer;
            if (!peerId) return;
            const target = guestPlayers.find((g) => g.peerId === peerId);
            if (!target) return;
            if (window.confirm(`${target.nickname} 님을 강퇴할까요?`)) {
              host.kick(peerId);
            }
          });
        });

        // 전원 준비돼야 시작 가능(방장은 항상 준비된 것으로 취급 → 게스트만 검사).
        const notReady = guestPlayers.filter((g) => !g.ready).length;
        if (!gameId) {
          startBtn.disabled = true;
          startBtn.textContent = '게임을 먼저 골라주세요';
        } else if (players.length < minPlayers()) {
          startBtn.disabled = true;
          startBtn.textContent = `${minPlayers() - players.length}명 더 필요해요`;
        } else if (notReady > 0) {
          startBtn.disabled = true;
          startBtn.textContent = `준비 대기 중 (${notReady}명)`;
        } else {
          startBtn.disabled = false;
          startBtn.textContent = '게임 시작';
        }
      };
      refreshUI();

      /** 방장이 게임을 고르거나 바꿈 — gameId/옵션/정원/디렉토리 갱신 후 전원 동기화 */
      const selectGame = (newGameId: string, newOptions: Record<string, string>): void => {
        const g = getGameById(newGameId);
        if (!g) return;
        const playerCount = 1 + guestPlayers.length;
        // 현재 인원이 그 게임 최대 인원을 넘으면 못 고름 (picker 에서 이미 비활성이지만 방어)
        if (playerCount > g.meta.maxPlayers) {
          showToast(`${g.meta.name}은(는) ${g.meta.maxPlayers}명까지예요 (현재 ${playerCount}명)`);
          return;
        }
        gameId = newGameId;
        roomOptions = { ...newOptions };
        // 게임이 바뀌면 모두 다시 준비해야 함 → 게스트 ready 리셋
        guestPlayers.forEach((p) => { p.ready = false; });
        // 정원 좁힘 — 이후 입장은 이 게임 기준으로 막힘
        host.maxAccepted = Math.max(1, g.meta.maxPlayers - 1);
        // 전원에게 새 방 상태 통지 + 공개목록 갱신(게임이름/정원)
        host.send({ type: 'room_state', roomState: snapshotRoomState() });
        updatePublicRoom(host.roomId, {
          gameId,
          gameName: g.meta.name,
          maxPlayers: g.meta.maxPlayers,
          playerCount,
        }).catch(() => {});
        refreshUI();
      };

      // 게임 타일 클릭 / 옵션 변경 배선 — refreshUI 가 그리드를 다시 그릴 때마다 재호출.
      function wireGameArea(): void {
        gameGridEl.querySelectorAll<HTMLButtonElement>('.change-game-card:not(.is-disabled)').forEach((card) => {
          card.addEventListener('click', () => {
            const gid = card.dataset.gameId;
            if (!gid || gid === gameId) return; // 이미 고른 게임이면 무시(옵션 리셋 방지)
            const g = getGameById(gid);
            if (!g) return;
            const opts: Record<string, string> = {};
            for (const o of g.meta.roomOptions) opts[o.key] = o.defaultValue;
            selectGame(gid, opts); // 즉시 적용 → refreshUI 로 강조/옵션 갱신
          });
        });
        // 옵션 select 변경 — 그리드 재렌더 없이 옵션만 반영(select 값은 native 유지)
        gameOptionsEl.querySelectorAll<HTMLSelectElement>('select[id^="opt-"]').forEach((sel) => {
          sel.addEventListener('change', () => {
            const key = sel.id.replace('opt-', '');
            roomOptions = { ...roomOptions, [key]: sel.value };
            // 설정이 바뀌면 게스트가 본 조건이 달라짐 → 준비 리셋(다시 확인하고 준비하도록)
            guestPlayers.forEach((p) => { p.ready = false; });
            host.send({ type: 'room_state', roomState: snapshotRoomState() });
            updatePublicRoom(host.roomId, { playerCount: 1 + guestPlayers.length }).catch(() => {});
            refreshUI(); // 시작 버튼/참가자 준비 배지 갱신
          });
        });
      }

      // ---- 방 로직 콜백 ----
      host.onJoinRequest = (req: JoinRequest, fromPeerId: string): JoinDecision => {
        if (guestPlayers.length >= maxPlayers() - 1) {
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
        updatePublicRoom(host.roomId, { playerCount: 1 + guestPlayers.length }).catch(() => {});
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
        updatePublicRoom(host.roomId, { playerCount: 1 + guestPlayers.length }).catch(() => {});
        showToast(`${removed?.nickname ?? '게스트'} 님이 나갔어요`);
      };

      // 게스트가 일시적으로 끊겼다 유예 안에 재연결 — 현재 방 상태를 돌려줘 그대로 복구
      // (플레이어 목록은 유지되므로 다른 사람 화면엔 나감/재입장이 안 보인다)
      host.onGuestReconnected = () => snapshotRoomState();

      host.onMessage = (msg, fromPeerId) => {
        // 이모지 반응: 내 화면에 표시 + 다른 게스트들에게 forward (호스트 = relay 허브)
        if (msg.type === 'reaction') {
          showReactionBubble(msg.emoji, msg.nickname);
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) host.sendTo(pid, msg);
          }
          return;
        }
        // 채팅: 내 화면에 표시 + 다른 게스트들에게 relay (송신자 제외)
        if (msg.type === 'chat') {
          appendChatMessage(el, msg, false);
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) host.sendTo(pid, msg);
          }
          return;
        }
        // 준비 토글: 해당 게스트 ready 갱신 후 전원에 방 상태 동기화 (참가자 배지 + 시작 버튼 반영)
        if (msg.type === 'ready') {
          const g = guestPlayers.find((p) => p.peerId === fromPeerId);
          if (g) {
            g.ready = msg.ready;
            host.send({ type: 'room_state', roomState: snapshotRoomState() });
            refreshUI();
          }
          return;
        }
        // 그 외 메시지(현재는 정의된 게 없음) 는 대기실에서 무시.
      };

      // 이모지 반응 버튼 배선 (호스트 측) — 클릭 시 자기 화면 + 모든 게스트에게 broadcast
      wireReactionBar(el, (emoji) => {
        const myNick = storage.getNickname();
        showReactionBubble(emoji, myNick);
        host.send({ type: 'reaction', emoji, nickname: myNick });
      });

      // 채팅 패널 — 호스트는 자기 화면 append + 모든 게스트 broadcast
      cleanupChatHost = wireChatPanel(el, {
        onSend: (text) => {
          const msg: ChatMsg = {
            type: 'chat',
            peerId: host.myPeerId,
            nickname: hostNickname,
            text,
            timestamp: Date.now(),
          };
          appendChatMessage(el, msg, true);
          host.send(msg);
        },
      });

      // ---- 방 링크 복사 (카톡 등 공유 편의용) ----
      shareBtn.addEventListener('click', async () => {
        const shareUrl = buildRoomShareUrl(host.roomId);
        try {
          await navigator.clipboard.writeText(shareUrl);
          showToast('링크를 복사했어요! 카톡에 붙여넣으세요');
        } catch {
          const ok = window.prompt('링크를 복사하세요:', shareUrl);
          if (ok !== null) showToast('링크를 확인했어요');
        }
      });

      // ---- 시작 버튼 ----
      startBtn.addEventListener('click', () => {
        const players = [hostPlayer, ...guestPlayers];
        if (!gameId || players.length < minPlayers()) return;

        host.send({ type: 'game_start' });

        closeOnDispose = false;
        const rs: RoomState = { ...snapshotRoomState(), status: 'playing' };
        // 게임 도중 관전자 입장 요청 시 비번 검증을 위해 password/isPrivate 도 gameScreen 에 넘김
        router.replace(() => createGameScreenAsHostScreen({ host, roomState: rs, isPrivate, password }));
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
      // 게임 시작으로 떠나는 경우(closeOnDispose=false)엔 항목을 유지 → 게임 화면이 status='playing'
      // 으로 갱신하고, 목록엔 '게임 중'으로 계속 노출된다(중간 입장 관전 가능).
      // 호스트가 방을 완전히 닫을 때(메뉴 복귀 등, closeOnDispose=true)만 디렉토리에서 제거.
      if (closeOnDispose) {
        unpublishRoom(host.roomId).catch(() => {});
      }
      if (closeOnDispose) {
        host.close();
      }
      cleanupChatHost?.();
      cleanupChatHost = null;
      host.onJoinRequest = null;
      host.onGuestConnected = null;
      host.onGuestDisconnected = null;
      host.onGuestReconnected = null;
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
  let cleanupChatGuest: (() => void) | null = null;
  let roomState: RoomState = initialRoomState;
  let wasKicked = false; // 강퇴 안내(kicked)와 방장 나감(onDisconnect) 중복 알림 방지
  const myPeerId = guest.myPeerId;

  // 게임은 방장이 방 안에서 고름 → gameId 가 '' 일 수 있고, 도중에 바뀔 수도 있음(room_state 로 반영).
  const guestMaxPlayers = (): number => getGameById(roomState.gameId)?.meta.maxPlayers ?? GLOBAL_MAX_PLAYERS;
  const guestGameName = (): string => getGameById(roomState.gameId)?.meta.name ?? '게임 고르는 중';

  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="leave-btn" title="방 나가기">×</button>

        <div class="card waiting-card">
          <div class="waiting-head">
            <div class="waiting-head-title">
              <div class="card-title">🎀 대기실</div>
              <div class="card-subtitle" id="game-name">${escapeHtml(guestGameName())}</div>
            </div>
          </div>

          <div class="waiting-body">
            <div class="waiting-left">
              <div class="waiting-section-title">${icon('users', { size: 18, hue: '#5b9dff' })} 참가자 <span class="waiting-count" id="player-count">${roomState.players.length} / ${guestMaxPlayers()}명</span></div>
              <div class="participants" id="participants"></div>
              <button class="btn btn-primary btn-lg btn-block" id="ready-btn" disabled>
                방장이 게임을 고르는 중
              </button>
              <div style="margin-top: 10px;">${buildReactionBarHTML()}</div>
            </div>

            <div class="waiting-right">
              <div class="waiting-section-title">${icon('games', { size: 18, hue: '#a06bff' })} 방장이 고른 게임</div>
              <!-- 게스트는 보기 전용: 클릭 못 하게 is-readonly (CSS pointer-events:none) -->
              <div class="change-game-grid waiting-grid is-readonly" id="game-grid"></div>
              <div class="change-game-options waiting-options" id="game-options"></div>
            </div>
          </div>
        </div>

        ${buildChatPanelHTML()}
      `;

      const participantsEl = el.querySelector<HTMLDivElement>('#participants')!;
      const playerCountEl = el.querySelector<HTMLSpanElement>('#player-count')!;
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;
      const gameNameEl = el.querySelector<HTMLDivElement>('#game-name')!;
      const gameGridEl = el.querySelector<HTMLDivElement>('#game-grid')!;
      const gameOptionsEl = el.querySelector<HTMLDivElement>('#game-options')!;
      const readyBtn = el.querySelector<HTMLButtonElement>('#ready-btn')!;

      /** roomState 안의 내 ready 값 (없으면 false) */
      const amIReady = (): boolean =>
        !!roomState.players.find((p) => p.peerId === myPeerId)?.ready;

      const refreshUI = (): void => {
        const max = guestMaxPlayers();
        const count = roomState.players.length;
        gameNameEl.textContent = guestGameName();
        participantsEl.innerHTML = renderParticipantsHTML(roomState.players, max, myPeerId);
        playerCountEl.textContent = `${count} / ${max}명`;
        // 방장이 고른 게임/설정을 그대로(읽기 전용) 표시 — 방장 화면과 동일 UI.
        gameGridEl.innerHTML = buildGameTilesHTML(count, roomState.gameId, { enforceMin: false });
        const selectedGame = roomState.gameId ? getGameById(roomState.gameId) : null;
        const hasOptions = !!selectedGame && selectedGame.meta.roomOptions.length > 0;
        gameOptionsEl.innerHTML = hasOptions
          ? buildGameOptionsHTML(roomState.gameId, roomState.roomOptions)
          : '';
        // 게스트는 설정을 못 바꿈 → 셀렉트 비활성화
        gameOptionsEl.querySelectorAll('select').forEach((s) => { s.disabled = true; });

        // 준비 버튼 — 게임이 정해지기 전엔 비활성, 정해지면 준비/준비완료 토글
        if (!roomState.gameId) {
          readyBtn.disabled = true;
          readyBtn.className = 'btn btn-secondary btn-lg btn-block';
          readyBtn.textContent = '방장이 게임을 고르는 중';
        } else if (amIReady()) {
          readyBtn.disabled = false;
          readyBtn.className = 'btn btn-secondary btn-lg btn-block';
          readyBtn.textContent = '준비 취소';
        } else {
          readyBtn.disabled = false;
          readyBtn.className = 'btn btn-primary btn-lg btn-block';
          readyBtn.textContent = '준비';
        }
      };
      refreshUI();

      // 준비 토글 — 낙관적으로 내 상태를 로컬 반영 후 호스트에 통지(호스트가 room_state 로 되돌려줌)
      readyBtn.addEventListener('click', () => {
        if (!roomState.gameId) return;
        const me = roomState.players.find((p) => p.peerId === myPeerId);
        const next = !me?.ready;
        if (me) me.ready = next;
        guest.send({ type: 'ready', ready: next });
        refreshUI();
      });

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
          case 'reaction':
            // 호스트가 broadcast/relay 한 이모지 반응
            showReactionBubble(msg.emoji, msg.nickname);
            break;
          case 'chat':
            // 다른 사람이 보낸 채팅 (호스트가 보냈거나 다른 게스트가 보낸 걸 호스트가 relay)
            appendChatMessage(el, msg, false);
            break;
          case 'game_start': {
            closeOnDispose = false;
            const rs: RoomState = { ...roomState, status: 'playing' };
            router.replace(() => createGameScreenAsGuestScreen({ guest, roomState: rs }));
            break;
          }
          case 'kicked':
            // 방장이 내보냄 — onDisconnect 의 "방장이 나갔어요" 와 구분하기 위해 플래그.
            wasKicked = true;
            alert('방장이 내보냈어요');
            router.reset(() => createMenuScreen());
            break;
          case 'game_end':
          case 'game_msg':
            break;
        }
      };

      // 이모지 반응 버튼 — 게스트: 호스트에게만 송신 (호스트가 다른 게스트로 relay)
      wireReactionBar(el, (emoji) => {
        const myNick = storage.getNickname();
        showReactionBubble(emoji, myNick);
        guest.send({ type: 'reaction', emoji, nickname: myNick });
      });

      // 채팅 패널 — 게스트: 자기 화면 append + 호스트로 송신 (호스트가 다른 게스트로 relay)
      cleanupChatGuest = wireChatPanel(el, {
        onSend: (text) => {
          const myNick = storage.getNickname();
          const msg: ChatMsg = {
            type: 'chat',
            peerId: myPeerId,
            nickname: myNick,
            text,
            timestamp: Date.now(),
          };
          appendChatMessage(el, msg, true);
          guest.send(msg);
        },
      });

      // 일시적 끊김 — 바로 튕기지 않고 재연결 오버레이를 띄운다(peer.ts 가 자동 재시도)
      guest.onReconnecting = () => showReconnectOverlay();
      guest.onReconnected = () => hideReconnectOverlay();

      guest.onDisconnect = () => {
        hideReconnectOverlay();
        if (wasKicked) return; // 강퇴는 'kicked' 에서 이미 안내+이동함
        alert('방장이 방을 나갔어요');
        router.back();
      };

      leaveBtn.addEventListener('click', () => {
        if (window.confirm('방을 나가시겠어요?')) router.back();
      });

      return el;
    },

    dispose() {
      hideReconnectOverlay();
      if (closeOnDispose) guest.close();
      cleanupChatGuest?.();
      cleanupChatGuest = null;
      guest.onMessage = null;
      guest.onDisconnect = null;
      guest.onReconnecting = null;
      guest.onReconnected = null;
    },
  };
}

