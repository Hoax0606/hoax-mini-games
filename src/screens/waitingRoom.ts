import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage } from '../core/storage';
import type { HostSession, GuestSession, JoinRequest, JoinDecision } from '../core/peer';
import { getGameById } from '../games/registry';
import type { RoomState } from '../games/types';
import { createGameScreenAsHostScreen, createGameScreenAsGuestScreen } from './gameScreen';

/**
 * 대기실 (호스트 측)
 *
 * 이 화면이 "방 로직"을 책임진다:
 *   1. host.onJoinRequest: 비번 검증 + RoomState 생성해서 수락 결정
 *   2. host.onGuestConnected/Disconnected: UI에 참가자 이름 반영
 *   3. 시작 버튼: 게임 시작 메시지를 게스트에게 전송
 *
 * 왜 peer.ts가 아니라 여기에 두나?
 *   - peer.ts는 전송 계층에만 집중 (WebRTC 라이브러리 교체 가능성 대비)
 *   - 도메인 로직(비번, 옵션, 상태)은 화면/방 로직에서 관리해야 테스트·변경이 쉬움
 */

export interface WaitingRoomAsHostArgs {
  host: HostSession;
  gameId: string;
  isPrivate: boolean;
  password: string;
  roomOptions: Record<string, string>;
}

export function createWaitingRoomAsHostScreen(args: WaitingRoomAsHostArgs): Screen {
  const { host, gameId, isPrivate, password, roomOptions } = args;

  // dispose 시점에 host를 닫을지 여부.
  // 게임 시작으로 이동할 땐 게임 화면이 host 소유권을 가져가야 하므로 false로 바꾼다.
  let closeOnDispose = true;
  // 현재 연결된 게스트의 닉네임 (없으면 null)
  let guestNickname: string | null = null;

  // 게스트에게 전달할 RoomState를 현재 값으로 스냅샷
  const snapshotRoomState = (guestName: string | null): RoomState => ({
    roomId: host.roomId,
    gameId,
    hostNickname: storage.getNickname(),
    guestNickname: guestName,
    isPrivate,
    roomOptions,
    status: 'waiting',
  });

  return {
    render() {
      const game = getGameById(gameId);
      if (!game) {
        queueMicrotask(() => router.back());
        return document.createElement('div');
      }

      // 옵션 값을 사람 친화 라벨로 변환 (예: { winScore: "7" } → "승리 점수: 보통 · 7점")
      const optionSummary = game.meta.roomOptions
        .map((opt) => {
          const val = roomOptions[opt.key] ?? opt.defaultValue;
          const choice = opt.choices.find((c) => c.value === val);
          return `${opt.label}: ${choice?.label ?? val}`;
        })
        .join(' · ');

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

          <div class="participants">
            <div class="participant participant-host">
              <span class="participant-badge">방장</span>
              <span class="participant-name">${escapeHtml(storage.getNickname())}</span>
            </div>
            <div class="participant participant-guest participant-empty" id="guest-slot">
              <span class="participant-badge">손님</span>
              <span class="participant-name" id="guest-name">친구를 기다리는 중...</span>
            </div>
          </div>

          <div class="room-info">
            <span class="room-info-item">${escapeHtml(optionSummary)}</span>
            <span class="room-info-item">${isPrivate ? '🔒 비공개' : '🌐 공개'}</span>
          </div>

          <button class="btn btn-primary btn-lg btn-block" id="start-btn" disabled>
            친구를 기다리는 중...
          </button>
        </div>

        <div class="toast" id="toast"></div>
      `;

      // ---- DOM 참조 ----
      const guestSlot = el.querySelector<HTMLDivElement>('#guest-slot')!;
      const guestNameEl = el.querySelector<HTMLSpanElement>('#guest-name')!;
      const startBtn = el.querySelector<HTMLButtonElement>('#start-btn')!;
      const copyBtn = el.querySelector<HTMLButtonElement>('#copy-btn')!;
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;
      const toastEl = el.querySelector<HTMLDivElement>('#toast')!;

      // ---- 참가자 UI 갱신 ----
      const refreshGuestUI = (): void => {
        if (guestNickname) {
          guestSlot.classList.remove('participant-empty');
          guestNameEl.textContent = guestNickname;
          guestNameEl.style.fontStyle = 'normal';
          startBtn.disabled = false;
          startBtn.textContent = '게임 시작';
        } else {
          guestSlot.classList.add('participant-empty');
          guestNameEl.textContent = '친구를 기다리는 중...';
          startBtn.disabled = true;
          startBtn.textContent = '친구를 기다리는 중...';
        }
      };

      // ---- 방 로직 콜백 등록 (HostSession의 onJoinRequest 등) ----
      host.onJoinRequest = (req: JoinRequest): JoinDecision => {
        // 이미 게스트 있으면 room_full
        if (guestNickname) {
          return { accept: false, reason: 'room_full' };
        }
        // 비공개방이면 비번 검증
        if (isPrivate && req.password !== password) {
          return { accept: false, reason: 'wrong_password' };
        }
        // 수락: 현재 기준 roomState를 게스트에게 전달
        return { accept: true, roomState: snapshotRoomState(req.nickname) };
      };

      host.onGuestConnected = (nickname) => {
        guestNickname = nickname;
        refreshGuestUI();
      };

      host.onGuestDisconnected = () => {
        guestNickname = null;
        refreshGuestUI();
        showToast('게스트가 나갔어요');
      };

      // 대기실 단계에선 일반 메시지는 들어올 일이 거의 없지만,
      // 혹시 모를 경우 단순 로깅.
      host.onMessage = (msg) => {
        console.debug('[waitingRoom] message from guest:', msg);
      };

      // ---- 방 코드 복사 ----
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(host.roomId);
          showToast('방 코드를 복사했어요!');
        } catch {
          // clipboard API 실패 시 fallback (HTTPS가 아닌 환경 등)
          const ok = window.prompt('방 코드를 복사하세요:', host.roomId);
          if (ok !== null) showToast('방 코드를 확인했어요');
        }
      });

      // ---- 시작 버튼 ----
      startBtn.addEventListener('click', () => {
        if (!guestNickname) return;
        host.send({ type: 'game_start' });

        // host 소유권을 게임 화면으로 이전
        closeOnDispose = false;
        const rs = snapshotRoomState(guestNickname);
        rs.status = 'playing';
        router.replace(() => createGameScreenAsHostScreen({ host, roomState: rs }));
      });

      // ---- 방 나가기 ----
      leaveBtn.addEventListener('click', () => {
        const confirmed = window.confirm('방을 나가면 손님도 연결이 끊겨요. 나가시겠어요?');
        if (confirmed) {
          // dispose()에서 host.close() 호출되므로 router.back()만 하면 충분
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
        }, 2000);
      }

      return el;
    },

    dispose() {
      // 게임 화면으로 이동한 경우엔 host 소유권이 넘어갔으므로 닫지 않음.
      // 그 외 모든 경우(뒤로가기, 새 화면으로 이동 등)는 방을 정리한다.
      if (closeOnDispose) {
        host.close();
      }
      // 콜백 참조 해제 — 혹시 남아서 부르게 되는 경우 방지
      host.onJoinRequest = null;
      host.onGuestConnected = null;
      host.onGuestDisconnected = null;
      host.onMessage = null;
    },
  };
}

// ============================================
// 게스트 측 대기실
// ============================================

export interface WaitingRoomAsGuestArgs {
  guest: GuestSession;
  /** join_accepted로 받은 초기 방 상태 */
  initialRoomState: RoomState;
}

export function createWaitingRoomAsGuestScreen(args: WaitingRoomAsGuestArgs): Screen {
  const { guest, initialRoomState } = args;
  let closeOnDispose = true;
  let roomState: RoomState = initialRoomState;

  return {
    render() {
      const game = getGameById(roomState.gameId);
      if (!game) {
        queueMicrotask(() => router.back());
        return document.createElement('div');
      }

      const optionSummary = game.meta.roomOptions
        .map((opt) => {
          const val = roomState.roomOptions[opt.key] ?? opt.defaultValue;
          const choice = opt.choices.find((c) => c.value === val);
          return `${opt.label}: ${choice?.label ?? val}`;
        })
        .join(' · ');

      // 게스트 닉네임: 호스트가 준 roomState에 없으면 내 저장된 닉네임 사용 (정상 플로우에선 항상 있음)
      const myNickname = roomState.guestNickname ?? storage.getNickname();

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

          <div class="participants">
            <div class="participant participant-host">
              <span class="participant-badge">방장</span>
              <span class="participant-name">${escapeHtml(roomState.hostNickname)}</span>
            </div>
            <div class="participant participant-guest">
              <span class="participant-badge">손님</span>
              <span class="participant-name">${escapeHtml(myNickname)}</span>
            </div>
          </div>

          <div class="room-info">
            <span class="room-info-item">${escapeHtml(optionSummary)}</span>
            <span class="room-info-item">${roomState.isPrivate ? '🔒 비공개' : '🌐 공개'}</span>
          </div>

          <button class="btn btn-secondary btn-lg btn-block" id="waiting-label" disabled>
            방장이 시작하기를 기다리는 중...
          </button>
        </div>
      `;

      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;

      // 호스트로부터 오는 메시지 라우팅
      guest.onMessage = (msg) => {
        switch (msg.type) {
          case 'room_state':
            // 호스트가 방 상태 변경 브로드캐스트 (지금 단계에선 거의 안 옴)
            roomState = msg.roomState;
            break;
          case 'game_start': {
            // guest 소유권을 게임 화면으로 이전
            closeOnDispose = false;
            const rs: RoomState = { ...roomState, status: 'playing' };
            router.replace(() => createGameScreenAsGuestScreen({ guest, roomState: rs }));
            break;
          }
          case 'game_end':
          case 'game_msg':
            // 대기실에선 무시 (게임 화면이 쓸 메시지)
            break;
        }
      };

      // 호스트가 연결 끊으면 (나가거나 튕김)
      guest.onDisconnect = () => {
        alert('방장이 방을 나갔어요');
        router.back();
      };

      leaveBtn.addEventListener('click', () => {
        const confirmed = window.confirm('방을 나가시겠어요?');
        if (confirmed) router.back();
      });

      return el;
    },

    dispose() {
      if (closeOnDispose) {
        guest.close();
      }
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
