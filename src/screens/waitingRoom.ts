import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage } from '../core/storage';
import type { HostSession, GuestSession, JoinRequest, JoinDecision } from '../core/peer';
import { getGameById, GLOBAL_MAX_PLAYERS } from '../games/registry';
import type { Player, RoomState } from '../games/types';
import { createGameScreenAsHostScreen, createGameScreenAsGuestScreen } from './gameScreen';
import { createMenuScreen } from './menu';
import { buildReactionBarHTML, wireReactionBar, showReactionBubble } from '../ui/reactions';
import { buildChatPanelHTML, wireChatPanel, appendChatMessage, appendChatSystemMessage } from '../ui/chat';
import { showToast } from '../ui/toast';
import { showConfirm } from '../ui/confirm';
import type { ChatMsg } from '../games/types';
import { publishRoom, updatePublicRoom, unpublishRoom } from '../core/roomDirectory';
import {
  buildGameTilesHTML, buildGameOptionsHTML, buildPickedGameHTML,
  buildPlayerFilterHTML, wirePlayerFilter, reconcileOptions, type PlayerFilter,
  buildCategoryFilterHTML, wireCategoryFilter, type CategoryFilter,
} from '../ui/gamePicker';
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

/**
 * 참가자 리스트 HTML — 방 정원만큼 슬롯 생성, 빈 슬롯은 점선.
 * @param enteringPeerId 방금 들어온 사람. 그 행에만 입장 모션 클래스를 붙인다.
 */
function renderParticipantsHTML(
  players: Player[],
  maxPlayers: number,
  myPeerId: string | null,
  showKick = false,
  enteringPeerId: string | null = null,
): string {
  const cells = players.map((p) => {
    const badgeText = p.isHost ? '방장' : '손님';
    // 배지 색은 아래 hostCls(.participant-host / .participant-guest)가 결정한다.
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
      ? `<button class="participant-kick" data-kick-peer="${escapeHtml(p.peerId)}" title="강퇴" aria-label="강퇴">×</button>`
      : '';
    // data-peer 는 퇴장 애니메이션 때 그 행을 집어내려고 쓴다(없으면 누가 나갔는지 DOM 에서 못 찾음)
    const enterCls = p.peerId === enteringPeerId ? ' is-entering' : '';
    return `
      <div class="participant ${hostCls}${enterCls}" data-peer="${escapeHtml(p.peerId)}">
        <span class="participant-badge">${badgeText}</span>
        <span class="participant-name">${nameHtml}</span>
        ${readyTag}
        ${kickBtn}
      </div>
    `;
  });
  // 남은 정원만큼 점선 "빈 자리" 고스트 슬롯 — 왼쪽 여백을 채워 방이 채워질 공간을 암시
  for (let i = players.length; i < maxPlayers; i++) {
    cells.push(`
      <div class="participant participant-empty">
        <span class="participant-name">친구를 기다리는 중</span>
      </div>
    `);
  }
  return cells.join('');
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
  /**
   * 방장 이양으로 승격된 방. true 면 (1)공개목록 등록 안 함(코드 라우팅 불가) (2)재접속하는
   * 생존자의 비번 검증 스킵(옛 비번을 승계자가 모름 — peerId 를 아는 기존 멤버만 붙으므로 안전).
   */
  migrated?: boolean;
}

export function createWaitingRoomAsHostScreen(args: WaitingRoomAsHostArgs): Screen {
  const { host, isPrivate, password } = args;
  const migrated = args.migrated === true;
  // gameId/roomOptions 는 방 안에서 방장이 게임을 고르면 바뀐다 → let.
  let gameId = args.gameId;
  let roomOptions: Record<string, string> = { ...args.roomOptions };

  let closeOnDispose = true;
  let cleanupChatHost: (() => void) | null = null;
  const hostNickname = storage.getNickname();
  // 개발용 솔로 테스트 — 닉네임 'AlphaTest' 면 최소인원 무시하고 혼자 게임 시작 가능(인게임 UI 미리보기용).
  const devSolo = hostNickname === 'AlphaTest';

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
          <!-- 제목 줄은 아래 body 와 같은 2단(260px + 나머지). '대기실'은 참가자 칼럼 위,
               '게임 선택'은 그리드 위에 정확히 얹힌다. -->
          <div class="waiting-head">
            <div class="waiting-head-title">
              <div class="card-title">대기실</div>
            </div>
            <div class="waiting-section-title waiting-head-game">
              게임 선택
              <span class="pf-wrap" id="game-filter"></span>
            </div>
          </div>

          <div class="waiting-body">
            <div class="waiting-left">
              <div class="waiting-section-title">
                참가자 <span class="waiting-count" id="player-count">1 / ${maxPlayers()}명</span>
                <button class="btn btn-secondary btn-sm waiting-invite-btn" id="share-btn"
                        title="초대 링크 복사">${icon('link', { size: 16, hue: '#5b9dff' })} 초대</button>
              </div>
              <div class="participants" id="participants"></div>
              <button class="btn btn-primary btn-lg btn-block" id="start-btn" disabled>
                친구를 기다리는 중
              </button>
              <div style="margin-top: 10px;">${buildReactionBarHTML()}</div>
            </div>

            <div class="waiting-right">
              <div class="change-game-grid waiting-grid" id="game-grid"></div>
              <div class="change-game-options waiting-options" id="game-options"></div>
            </div>
          </div>
        </div>

        ${buildChatPanelHTML()}

      `;

      const participantsEl = el.querySelector<HTMLDivElement>('#participants')!;
      const startBtn = el.querySelector<HTMLButtonElement>('#start-btn')!;
      const gameGridEl = el.querySelector<HTMLDivElement>('#game-grid')!;
      const gameFilterEl = el.querySelector<HTMLDivElement>('#game-filter')!;
      const gameOptionsEl = el.querySelector<HTMLDivElement>('#game-options')!;
      /** 인원수 필터. refreshUI 가 자주 도니까 바깥에 둬서 사람이 고른 값이 안 날아가게 한다 */
      let gameFilter: PlayerFilter = null;
      let catFilter: CategoryFilter = null;
      /** 강퇴한 사람(닉네임). 같은 방이 살아있는 동안만 유지된다 — 방을 다시 만들면 초기화 */
      const bannedNicknames = new Set<string>();
      /** 방금 들어온 사람 — refreshUI 가 그 행에만 입장 모션을 건다. 그리고 바로 비운다 */
      let enteringPeerId: string | null = null;

      /**
       * 나간 사람 행을 접은 뒤 다시 그린다.
       * 바로 refreshUI 를 돌리면 행이 순간삭제돼서 아래 칸들이 덜컥 올라온다.
       * 행을 못 찾으면(이미 다시 그려졌거나 게스트가 아니면) 그냥 즉시 재렌더.
       */
      const collapseParticipant = (peerId: string, done: () => void): void => {
        const row = participantsEl.querySelector<HTMLElement>(`.participant[data-peer="${CSS.escape(peerId)}"]`);
        if (!row) { done(); return; }
        row.classList.add('is-leaving');
        window.setTimeout(done, 260); // CSS participant-out 길이와 맞춤
      };
      const shareBtn = el.querySelector<HTMLButtonElement>('#share-btn')!;
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;
      const playerCountEl = el.querySelector<HTMLSpanElement>('#player-count')!;

      // 공개/비공개 모두 디렉토리(Firebase)에 등록. 비공개방은 isPrivate=true 로 목록에 🔒 표시되고,
      // 입장하려면 비번을 입력해야 함(호스트 onJoinRequest 에서 검증). 게스트 입장/퇴장 때 인원 갱신.
      // 이 항목은 대기→게임→결과 화면 내내 유지되고, 호스트가 방을 완전히 닫을 때만(dispose+closeOnDispose) 제거.
      // 승격 방(migrated)은 코드-라우팅이 안 되므로 공개목록에 올리지 않는다(누르면 못 들어감).
      if (!migrated) {
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
      }

      /** 참가자 리스트 / 카운터 / 게임이름 / 옵션 / 시작·게임선택 버튼 상태 동기화 */
      const refreshUI = (): void => {
        const players = [hostPlayer, ...guestPlayers];
        const max = maxPlayers();
        participantsEl.innerHTML = renderParticipantsHTML(players, max, hostPlayer.peerId, true, enteringPeerId);
        playerCountEl.textContent = `${players.length} / ${max}명`;

        // 게임 타일 그리드 (항상 노출, 인원 초과 게임은 잠금). 재렌더 시 스크롤 위치 보존
        //   (게임 고를 때마다 innerHTML 재생성돼 스크롤이 위로 튀던 문제 방지)
        const gridScroll = gameGridEl.scrollTop;
        gameGridEl.innerHTML = buildGameTilesHTML(players.length, gameId, {
          enforceMin: false,
          filter: gameFilter,
          category: catFilter,
        });
        gameGridEl.scrollTop = gridScroll;
        // 필터도 같이 갱신 — 인원이 바뀌면 '지금 방 인원' 표시가 따라가야 한다
        gameFilterEl.innerHTML =
          buildCategoryFilterHTML(catFilter) + buildPlayerFilterHTML(gameFilter, players.length);
        wireCategoryFilter(gameFilterEl, (c) => { catFilter = c; refreshUI(); });
        wirePlayerFilter(gameFilterEl, (n) => { gameFilter = n; refreshUI(); });
        // 옵션 박스는 항상 노출(통일성) — 옵션 있으면 셀렉트, 없으면 '설정 없음', 미선택이면 안내.
        gameOptionsEl.innerHTML = buildGameOptionsHTML(gameId, roomOptions);
        wireGameArea();

        // 강퇴 버튼 배선 — 방장이 해당 게스트 연결을 끊음(onGuestDisconnected 가 정리)
        participantsEl.querySelectorAll<HTMLButtonElement>('.participant-kick').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const peerId = btn.dataset.kickPeer;
            if (!peerId) return;
            const target = guestPlayers.find((g) => g.peerId === peerId);
            if (!target) return;
            const ok = await showConfirm({
              title: '강퇴할까요?',
              message: `${target.nickname} 님이 방에서 나가고,\n이 방에 다시 들어올 수 없어요.`,
              confirmLabel: '강퇴',
              danger: true,
            });
            if (!ok) return;
            bannedNicknames.add(target.nickname);
            host.kick(peerId);
          });
        });

        // 전원 준비돼야 시작 가능(방장은 항상 준비된 것으로 취급 → 게스트만 검사).
        const notReady = guestPlayers.filter((g) => !g.ready).length;
        const needMin = devSolo ? 1 : minPlayers(); // AlphaTest = dev 솔로: 최소인원 무시(혼자 시작)
        if (!gameId) {
          startBtn.disabled = true;
          startBtn.textContent = '게임을 먼저 골라주세요';
        } else if (players.length < needMin) {
          startBtn.disabled = true;
          startBtn.textContent = `${needMin - players.length}명 더 필요해요`;
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
          showToast(`${g.meta.name}은(는) ${g.meta.maxPlayers}명까지예요 (현재 ${playerCount}명)`, { kind: 'warn' });
          return;
        }
        gameId = newGameId;
        roomOptions = reconcileOptions(newGameId, { ...newOptions });
        // 게임이 바뀌면 모두 다시 준비해야 함 → 게스트 ready 리셋
        guestPlayers.forEach((p) => { p.ready = false; });
        // 정원 좁힘 — 이후 입장은 이 게임 기준으로 막힘
        host.maxAccepted = Math.max(1, g.meta.maxPlayers - 1);
        // 전원에게 새 방 상태 통지 + 공개목록 갱신(게임이름/정원)
        host.send({ type: 'room_state', roomState: snapshotRoomState() });
        if (!migrated) updatePublicRoom(host.roomId, {
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
            // reconcile — 상위 옵션(국가 등)이 바뀌면 거기 안 맞는 하위 값(노선)을 첫 유효값으로.
            // 안 하면 국가를 한국으로 바꿔도 노선엔 일본 노선이 남아 그대로 시작된다.
            roomOptions = reconcileOptions(gameId, { ...roomOptions, [key]: sel.value });
            // 설정이 바뀌면 게스트가 본 조건이 달라짐 → 준비 리셋(다시 확인하고 준비하도록)
            guestPlayers.forEach((p) => { p.ready = false; });
            host.send({ type: 'room_state', roomState: snapshotRoomState() });
            if (!migrated) updatePublicRoom(host.roomId, { playerCount: 1 + guestPlayers.length }).catch(() => {});
            refreshUI(); // 시작 버튼/참가자 준비 배지 갱신
          });
        });
      }

      // ---- 방 로직 콜백 ----
      host.onJoinRequest = (req: JoinRequest, fromPeerId: string): JoinDecision => {
        // 강퇴한 사람이 같은 링크로 곧장 다시 들어오던 문제. 호스트가 차단 목록을 들고 거른다.
        // 기준이 닉네임인 이유: peerId 는 새로고침하면 바뀌어서 재입장을 못 막는다.
        // 닉네임을 바꾸면 뚫리지만 친구끼리 쓰는 방이라 이 정도면 충분하다.
        if (bannedNicknames.has(req.nickname)) {
          return { accept: false, reason: 'kicked' };
        }
        if (guestPlayers.length >= maxPlayers() - 1) {
          return { accept: false, reason: 'room_full' };
        }
        if (isPrivate && !migrated && req.password !== password) {
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

        // 입장은 토스트 대신 참가자 칸에서 직접 보여준다 — 바로 옆에서 목록이 바뀌는데
        // 화면 반대편 하단에 글자로 또 알릴 이유가 없다. 놓쳐도 채팅에 소식으로 남는다.
        enteringPeerId = newPlayer.peerId;
        refreshUI();
        enteringPeerId = null;
        appendChatSystemMessage(el, `${nickname} 님이 들어왔어요`);
        if (!migrated) updatePublicRoom(host.roomId, { playerCount: 1 + guestPlayers.length }).catch(() => {});
      };

      host.onGuestDisconnected = (peerId) => {
        const removed = guestPlayers.find((p) => p.peerId === peerId);
        guestPlayers = guestPlayers.filter((p) => p.peerId !== peerId);
        if (removed) {
          host.send({ type: 'player_left', peerId, nickname: removed.nickname });
          host.send({ type: 'room_state', roomState: snapshotRoomState() });
        }
        // 퇴장도 자리에서 — 행을 바로 지우면 아래 칸들이 덜컥 당겨 올라온다.
        // 접히는 모션이 끝난 뒤에 다시 그린다.
        appendChatSystemMessage(el, `${removed?.nickname ?? '게스트'} 님이 나갔어요`);
        collapseParticipant(peerId, refreshUI);
        if (!migrated) updatePublicRoom(host.roomId, { playerCount: 1 + guestPlayers.length }).catch(() => {});
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

      // 방장 입장도 소식으로 — 게스트는 "들어왔어요" 가 뜨는데 방장만 조용히 있으면
      // 채팅이 누가 있는지 모르는 채로 시작한다. 방이 열린 시점을 첫 줄로 남긴다.
      appendChatSystemMessage(el, `${hostNickname} 님이 방을 만들었어요`);

      // ---- 방 링크 복사 (카톡 등 공유 편의용) ----
      shareBtn.addEventListener('click', async () => {
        const shareUrl = buildRoomShareUrl(host.roomId);
        try {
          await navigator.clipboard.writeText(shareUrl);
          showToast('링크를 복사했어요! 카톡에 붙여넣으세요', { kind: 'success', icon: 'link' });
        } catch {
          const ok = window.prompt('링크를 복사하세요:', shareUrl);
          if (ok !== null) showToast('링크를 확인했어요', { kind: 'success', icon: 'link' });
        }
      });

      // ---- 시작 버튼 ----
      startBtn.addEventListener('click', () => {
        const players = [hostPlayer, ...guestPlayers];
        if (!gameId || players.length < (devSolo ? 1 : minPlayers())) return;

        host.send({ type: 'game_start' });

        closeOnDispose = false;
        const rs: RoomState = { ...snapshotRoomState(), status: 'playing' };
        // 게임 도중 관전자 입장 요청 시 비번 검증을 위해 password/isPrivate 도 gameScreen 에 넘김
        router.replace(() => createGameScreenAsHostScreen({ host, roomState: rs, isPrivate, password }));
      });

      // ---- 방 나가기 ----
      leaveBtn.addEventListener('click', async () => {
        // 방장이 나가면 방이 통째로 닫히니, 사람이 있을 때는 그 사실을 분명히 말해준다
        const hasGuests = guestPlayers.length > 0;
        const ok = await showConfirm({
          title: '방을 나갈까요?',
          message: hasGuests
            ? `지금 ${guestPlayers.length}명이 함께 있어요.\n방장이 나가면 모두의 연결이 끊겨요.`
            : '만든 방이 사라져요.',
          confirmLabel: '나가기',
          danger: hasGuests,
        });
        if (ok) router.back();
      });

      return el;
    },

    dispose() {
      // 게임 시작으로 떠나는 경우(closeOnDispose=false)엔 항목을 유지 → 게임 화면이 status='playing'
      // 으로 갱신하고, 목록엔 '게임 중'으로 계속 노출된다(중간 입장 관전 가능).
      // 호스트가 방을 완전히 닫을 때(메뉴 복귀 등, closeOnDispose=true)만 디렉토리에서 제거.
      if (closeOnDispose && !migrated) {
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

/**
 * 방장 이양 (host migration, 범위=게임중단→새 방장 대기실).
 * 호스트가 나가 게스트가 완전히 끊긴 시점에 호출. 공유된 roomState.players 로 후계자를 결정론적으로 뽑아
 *  - 내가 후계자면 내 peer 를 호스트로 승격시켜 대기실(호스트) 진입,
 *  - 아니면 후계자 peerId 로 재연결 → 대기실(게스트) 진입.
 * 진행 중이던 게임은 중단하고 전원 대기실로 모인다. 후계자도 없으면 onFallback(메뉴 등).
 * ⚠️ 멀티 클라 실테스트 필요(현재 미검증).
 */
export function attemptHostMigration(
  guest: GuestSession,
  roomState: RoomState,
  onFallback: () => void,
): void {
  const players = roomState.players ?? [];
  const oldHost = players.find((p) => p.isHost) ?? players[0];
  // 후계자 후보 = 옛 호스트·관전자 제외한 플레이어. players 순서는 전원 동일(호스트가 broadcast) → 합의됨.
  const survivors = players.filter((p) => p.role !== 'spectator' && p.peerId !== oldHost?.peerId);
  if (survivors.length === 0) { onFallback(); return; }
  const successor = survivors[0]!;
  const me = guest.myPeerId;

  if (me === successor.peerId) {
    // 내가 새 방장 — 기존 peer 를 그대로 호스트로 승격
    const host = guest.promoteToHost(me);
    host.maxAccepted = Math.max(1, GLOBAL_MAX_PLAYERS - 1);
    router.replace(() => createWaitingRoomAsHostScreen({
      host,
      gameId: roomState.gameId,
      isPrivate: true,
      password: '',
      roomOptions: roomState.roomOptions ?? {},
      migrated: true,   // 공개목록 등록·비번검증 스킵(코드 라우팅 불가, peerId 아는 기존 멤버만)
    }));
  } else {
    // 나는 새 방장에게 재연결
    guest.reconnectToNewHost(successor.peerId);
    const prov: RoomState = {
      ...roomState,
      status: 'waiting',
      players: survivors.map((p) => ({ ...p, isHost: p.peerId === successor.peerId, role: 'player' as const, ready: false })),
    };
    router.replace(() => createWaitingRoomAsGuestScreen({ guest, initialRoomState: prov }));
  }
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

  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="leave-btn" title="방 나가기">×</button>

        <div class="card waiting-card">
          <div class="waiting-head">
            <div class="waiting-head-title">
              <div class="card-title">대기실</div>
            </div>
            <div class="waiting-section-title waiting-head-game">방장이 고른 게임</div>
          </div>

          <div class="waiting-body">
            <div class="waiting-left">
              <div class="waiting-section-title">참가자 <span class="waiting-count" id="player-count">${roomState.players.length} / ${guestMaxPlayers()}명</span></div>
              <div class="participants" id="participants"></div>
              <button class="btn btn-primary btn-lg btn-block" id="ready-btn" disabled>
                방장이 게임을 고르는 중
              </button>
              <div style="margin-top: 10px;">${buildReactionBarHTML()}</div>
            </div>

            <div class="waiting-right">
              <!-- 게스트는 고를 수 없으니 전체 목록 대신 고른 게임 한 장만 크게 (설명 포함) -->
              <div class="waiting-picked" id="game-picked"></div>
              <div class="change-game-options waiting-options" id="game-options"></div>
            </div>
          </div>
        </div>

        ${buildChatPanelHTML()}
      `;

      const participantsEl = el.querySelector<HTMLDivElement>('#participants')!;
      const playerCountEl = el.querySelector<HTMLSpanElement>('#player-count')!;
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;
      const gamePickedEl = el.querySelector<HTMLDivElement>('#game-picked')!;
      const gameOptionsEl = el.querySelector<HTMLDivElement>('#game-options')!;
      const readyBtn = el.querySelector<HTMLButtonElement>('#ready-btn')!;

      /** roomState 안의 내 ready 값 (없으면 false) */
      const amIReady = (): boolean =>
        !!roomState.players.find((p) => p.peerId === myPeerId)?.ready;

      /** 방금 들어온 사람 — 다음 재렌더에서 그 행에만 입장 모션을 건다 */
      let enteringPeerId: string | null = null;
      /** 퇴장 모션이 끝나는 시각. 그 전에 다시 그리면 접히는 중에 행이 사라진다 */
      let holdUntil = 0;

      /** 나간 사람 행을 접기 시작. 재렌더는 refreshSoon 이 알아서 미뤄준다 */
      const collapseLeavingRow = (peerId: string): void => {
        const row = participantsEl.querySelector<HTMLElement>(`.participant[data-peer="${CSS.escape(peerId)}"]`);
        if (!row) return;
        row.classList.add('is-leaving');
        holdUntil = Date.now() + 260; // CSS participant-out 길이와 맞춤
      };

      /** 접히는 중이면 끝난 뒤에, 아니면 바로 */
      const refreshSoon = (): void => {
        const wait = holdUntil - Date.now();
        if (wait > 0) { window.setTimeout(refreshUI, wait); return; }
        refreshUI();
      };

      const refreshUI = (): void => {
        const max = guestMaxPlayers();
        const count = roomState.players.length;
        participantsEl.innerHTML = renderParticipantsHTML(roomState.players, max, myPeerId, false, enteringPeerId);
        enteringPeerId = null;
        playerCountEl.textContent = `${count} / ${max}명`;
        // 방장이 고른 게임 한 장만 크게(설명 포함). 미선택이면 안내 문구.
        gamePickedEl.innerHTML = buildPickedGameHTML(roomState.gameId);
        gameOptionsEl.innerHTML = buildGameOptionsHTML(roomState.gameId, roomState.roomOptions);
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
            refreshSoon();
            break;
          // 아래 둘은 UI 를 직접 갱신하지 않는다(뒤따라오는 room_state 가 한다).
          // 여기선 모션/소식처럼 "그 순간에만 할 수 있는 것"만 처리한다.
          case 'player_joined':
            // 내 입장은 화면 켜질 때 이미 첫 줄로 적었다. 브로드캐스트가 나한테도 와서 두 번 찍히는 걸 막는다.
            if (msg.player.peerId === myPeerId) break;
            enteringPeerId = msg.player.peerId;
            appendChatSystemMessage(el, `${msg.player.nickname} 님이 들어왔어요`);
            break;
          case 'player_left':
            appendChatSystemMessage(el, `${msg.nickname} 님이 나갔어요`);
            collapseLeavingRow(msg.peerId);
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

      // 들어온 사람 입장에서도 "누가 있는 방인지"를 첫 줄로. 방장이 방을 만든 건
      // 내가 오기 전 일이라 네트워크로는 안 오니, roomState 의 방장 닉네임으로 직접 적는다.
      {
        const hostName = roomState.players.find((p) => p.isHost)?.nickname;
        if (hostName) appendChatSystemMessage(el, `${hostName} 님이 방을 만들었어요`);
        appendChatSystemMessage(el, `${storage.getNickname()} 님이 들어왔어요`);
      }

      // 일시적 끊김 — 바로 튕기지 않고 재연결 오버레이를 띄운다(peer.ts 가 자동 재시도)
      guest.onReconnecting = () => showReconnectOverlay();
      guest.onReconnected = () => hideReconnectOverlay();

      guest.onDisconnect = () => {
        hideReconnectOverlay();
        if (wasKicked) return; // 강퇴는 'kicked' 에서 이미 안내+이동함
        // 방장이 나감 → 방장 이양 시도(후계자 승격/재연결). 후계자도 없으면 방 나감.
        attemptHostMigration(guest, roomState, () => { alert('방장이 방을 나갔어요'); router.back(); });
      };

      leaveBtn.addEventListener('click', async () => {
        const ok = await showConfirm({
          title: '방을 나갈까요?',
          message: '다시 들어오려면 방 코드가 필요해요.',
          confirmLabel: '나가기',
        });
        if (ok) router.back();
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

