import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage } from '../core/storage';
import { GuestSession, type PeerConnectError } from '../core/peer';
import type { NetworkMessage } from '../games/types';
import { createWaitingRoomAsGuestScreen } from './waitingRoom';
import { createGameScreenAsGuestScreen } from './gameScreen';

/**
 * 방 참여 화면
 *
 * 흐름:
 *   1. 방 코드 입력 → "참여하기"
 *   2. GuestSession.connect (호스트에 물리 연결)
 *   3. join_request 전송 → 호스트 응답 대기
 *      - join_accepted      → 게스트 대기실로 이동
 *      - wrong_password     → 비밀번호 입력 필드 노출 후 재시도 유도
 *      - room_full / 기타   → 에러 메시지
 *
 * 비밀번호 UX:
 *   처음엔 비번 필드 숨김. 비공개방이면 첫 시도에서 wrong_password 받고 필드 노출.
 *   공개방은 비번 없이 한 번에 통과되므로 사용자 입장에선 입력이 최소화된다.
 *
 * @param gameId 로비에서 선택한 게임 (참여 직후 화면 플로우 일관성용이지만,
 *               실제 수락된 roomState의 gameId가 정답이라서 서로 다를 경우 후자를 따름)
 * @param options.initialCode  방 코드 필드를 이 값으로 미리 채움 (URL 공유 입장용)
 * @param options.autoJoin     initialCode가 5자 완전하면 화면 뜨자마자 자동 join 시도
 */
export function createJoinRoomScreen(
  _gameId: string,
  options?: { initialCode?: string; autoJoin?: boolean },
): Screen {
  let disposed = false;
  /** 연결 중에 뒤로가기 누르면 정리하기 위한 레퍼런스 */
  let pendingGuest: GuestSession | null = null;

  return {
    render() {
      // URL 공유 입장: 코드 미리 채움 + 필요시 자동 시도
      const initialCodeRaw = (options?.initialCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      let roomCode = initialCodeRaw.slice(0, 5);
      let password = '';
      let needsPassword = false;

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div class="card" style="min-width: 420px;">
          <div class="card-title">🚪 방 참여하기</div>
          <div class="card-subtitle">친구에게 받은 방 코드를 입력하세요</div>

          <div class="form-group">
            <label class="input-label">방 코드 (5자)</label>
            <input
              type="text"
              class="input room-code-input"
              id="code-input"
              placeholder="PK4M9"
              maxlength="5"
              autocomplete="off"
              autocapitalize="characters"
            />
          </div>

          <div class="form-group" id="password-group" style="display: none;">
            <label class="input-label">🔒 비밀번호</label>
            <input
              type="text"
              class="input"
              id="password-input"
              placeholder="비밀번호를 입력하세요"
              maxlength="12"
              autocomplete="off"
            />
          </div>

          <div class="error-message" id="error-message"></div>

          <button class="btn btn-primary btn-lg btn-block" id="join-btn" style="margin-top: 20px;">
            참여하기
          </button>
        </div>
      `;

      const codeInput = el.querySelector<HTMLInputElement>('#code-input')!;
      const passwordGroup = el.querySelector<HTMLDivElement>('#password-group')!;
      const passwordInput = el.querySelector<HTMLInputElement>('#password-input')!;
      const errorEl = el.querySelector<HTMLDivElement>('#error-message')!;
      const joinBtn = el.querySelector<HTMLButtonElement>('#join-btn')!;

      // 미리 채움: URL 공유로 들어온 경우
      if (roomCode.length > 0) {
        codeInput.value = roomCode;
      }
      setTimeout(() => codeInput.focus(), 50);

      // 방 코드는 대문자 + 영숫자만 허용 (서버 영문+숫자 조합)
      codeInput.addEventListener('input', () => {
        const filtered = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        codeInput.value = filtered;
        roomCode = filtered;
      });

      passwordInput.addEventListener('input', () => {
        password = passwordInput.value;
      });

      const showError = (msg: string): void => {
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
      };
      const clearError = (): void => {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
      };

      const setBusy = (busy: boolean): void => {
        joinBtn.disabled = busy;
        joinBtn.textContent = busy ? '연결 중...' : '참여하기';
      };

      const tryJoin = async (): Promise<void> => {
        clearError();

        // 입력 검증
        if (roomCode.length !== 5) {
          showError('방 코드는 5자리예요');
          codeInput.focus();
          return;
        }
        if (needsPassword && (password.length < 4 || password.length > 12)) {
          showError('비밀번호는 4~12자로 입력해주세요');
          passwordInput.focus();
          return;
        }

        setBusy(true);

        // 1) 호스트에 물리 연결
        let guest: GuestSession;
        try {
          guest = await GuestSession.connect(roomCode);
        } catch (err) {
          if (disposed) return;
          setBusy(false);
          showError(getErrorMessage(err as PeerConnectError));
          return;
        }
        if (disposed) {
          guest.close();
          return;
        }
        pendingGuest = guest;

        // 2) join_request 전송 후 응답 수신 대기
        const response = await sendJoinRequestAndWait(guest, {
          nickname: storage.getNickname(),
          password: needsPassword ? password : undefined,
        });

        if (disposed) {
          guest.close();
          return;
        }

        // 3) 응답 분기
        if (response.type === 'timeout') {
          guest.close();
          pendingGuest = null;
          setBusy(false);
          showError('호스트가 응답하지 않아요. 방 코드를 다시 확인해주세요');
          return;
        }

        if (response.type === 'join_rejected') {
          guest.close();
          pendingGuest = null;
          setBusy(false);

          switch (response.reason) {
            case 'wrong_password':
              needsPassword = true;
              passwordGroup.style.display = 'block';
              setTimeout(() => passwordInput.focus(), 50);
              showError(
                password
                  ? '비밀번호가 틀렸어요'
                  : '비공개방이에요. 비밀번호를 입력해주세요'
              );
              break;
            case 'room_full':
              showError('방이 가득 찼어요');
              break;
            case 'game_in_progress':
              showError('이미 게임이 진행 중이에요');
              break;
          }
          return;
        }

        if (response.type === 'join_accepted') {
          // 수락: 게스트 소유권을 넘김.
          // 방이 이미 게임 중(status='playing')이면 관전자로 바로 gameScreen 진입.
          // 호스트 쪽에서 내 role='spectator' 로 이미 마킹해서 roomState를 내려줬으므로
          // gameScreen 에서 isSpectator 를 자동으로 인식한다.
          pendingGuest = null;
          const rs = response.roomState;
          if (rs.status === 'playing') {
            router.replace(() =>
              createGameScreenAsGuestScreen({ guest, roomState: rs })
            );
          } else {
            router.replace(() =>
              createWaitingRoomAsGuestScreen({ guest, initialRoomState: rs })
            );
          }
          return;
        }
      };

      joinBtn.addEventListener('click', tryJoin);
      codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') tryJoin();
      });
      passwordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') tryJoin();
      });
      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());

      // 자동 join — URL 공유 입장에서만 발동. 코드가 5자 유효일 때만.
      if (options?.autoJoin && roomCode.length === 5) {
        // DOM mount 후 살짝 지연 (피어 브로커 핸드셰이크 여유)
        window.setTimeout(() => {
          if (!disposed) void tryJoin();
        }, 200);
      }

      return el;
    },

    dispose() {
      disposed = true;
      pendingGuest?.close();
      pendingGuest = null;
    },
  };
}

/**
 * join_request를 보내고 호스트의 응답(join_accepted/join_rejected) 또는 타임아웃을 기다린다.
 * 응답을 받은 후에는 콜백을 반드시 해제해 대기실이 onMessage를 새로 등록할 때 충돌 안 남도록.
 */
type JoinResponse = NetworkMessage | { type: 'timeout' };

function sendJoinRequestAndWait(
  guest: GuestSession,
  req: { nickname: string; password?: string },
  timeoutMs = 10_000,
): Promise<JoinResponse> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: JoinResponse): void => {
      if (done) return;
      done = true;
      guest.onMessage = null;
      guest.onDisconnect = null;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = window.setTimeout(() => finish({ type: 'timeout' }), timeoutMs);

    guest.onMessage = (msg) => {
      if (msg.type === 'join_accepted' || msg.type === 'join_rejected') {
        finish(msg);
      }
    };
    guest.onDisconnect = () => {
      // 메시지 받기 전에 끊기면 응답 없음으로 간주
      finish({ type: 'timeout' });
    };

    guest.send({ type: 'join_request', nickname: req.nickname, password: req.password });
  });
}

function getErrorMessage(err: PeerConnectError): string {
  switch (err.kind) {
    case 'room_not_found':
      return '방을 찾을 수 없어요. 방 코드를 다시 확인해주세요';
    case 'network':
      return '네트워크 연결을 확인해주세요';
    case 'timeout':
      return '응답 시간이 초과됐어요. 다시 시도해주세요';
    default:
      return err.detail || '알 수 없는 오류가 발생했어요';
  }
}
