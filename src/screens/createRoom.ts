import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { GLOBAL_MAX_PLAYERS } from '../games/registry';
import { HostSession, type PeerConnectError } from '../core/peer';
import { createWaitingRoomAsHostScreen } from './waitingRoom';

/**
 * 방 만들기 화면
 *
 * 설계 요약 (구조 개편):
 *   - 게임은 방 안(대기실)에서 방장이 고른다 → 이 화면은 게임을 정하지 않는다.
 *   - 여기선 공개/비공개(+비밀번호)만 정하고 HostSession 을 생성한다.
 *   - "방 만들기" → HostSession.create → 대기실(waitingRoom)로 이동 (gameId 는 아직 빈 값).
 *   - 정원은 전체 게임 중 최대 인원(GLOBAL_MAX_PLAYERS)까지 받아두고,
 *     방 안에서 게임을 고르면 그 게임의 maxPlayers 로 좁혀진다.
 */
export function createCreateRoomScreen(): Screen {
  let disposed = false;
  let pendingHost: HostSession | null = null;

  return {
    render() {
      let isPrivate = false;
      let password = '';

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div class="card">
          <div class="card-title">🏠 방 만들기</div>
          <div class="card-subtitle">방을 만든 뒤 안에서 게임을 골라요</div>

          <div class="toggle-row">
            <span class="toggle-label">🔒 비공개방 (비밀번호)</span>
            <div class="toggle" id="private-toggle"></div>
          </div>

          <div class="form-group" id="password-group" style="display: none; margin-top: 8px;">
            <input
              type="text"
              class="input"
              id="password-input"
              placeholder="비밀번호 (4~12자)"
              maxlength="12"
              autocomplete="off"
            />
          </div>

          <div class="error-message" id="error-message"></div>

          <button class="btn btn-primary btn-lg btn-block" id="create-btn" style="margin-top: 20px;">
            방 만들기
          </button>
        </div>
      `;

      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());

      // 비공개 토글 / 비번 입력
      const toggle = el.querySelector<HTMLDivElement>('#private-toggle')!;
      const passwordGroup = el.querySelector<HTMLDivElement>('#password-group')!;
      const passwordInput = el.querySelector<HTMLInputElement>('#password-input')!;

      toggle.addEventListener('click', () => {
        isPrivate = toggle.classList.toggle('on');
        passwordGroup.style.display = isPrivate ? 'block' : 'none';
        if (isPrivate) {
          setTimeout(() => passwordInput.focus(), 50);
        } else {
          password = '';
          passwordInput.value = '';
        }
      });

      passwordInput.addEventListener('input', () => {
        password = passwordInput.value;
      });

      const errorEl = el.querySelector<HTMLDivElement>('#error-message')!;
      const showError = (msg: string): void => {
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
      };
      const clearError = (): void => {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
      };

      const createBtn = el.querySelector<HTMLButtonElement>('#create-btn')!;
      createBtn.addEventListener('click', async () => {
        clearError();

        if (isPrivate && (password.length < 4 || password.length > 12)) {
          showError('비밀번호는 4~12자로 입력해주세요');
          passwordInput.focus();
          return;
        }

        createBtn.disabled = true;
        createBtn.textContent = '방 만드는 중…';

        try {
          const host = await HostSession.create();
          if (disposed) {
            host.close();
            return;
          }

          // 게임이 아직 안 정해졌으므로 전체 최대 인원까지 수락 (방장 제외).
          // 게임을 고르면 대기실에서 그 게임 maxPlayers 로 maxAccepted 를 좁힌다.
          host.maxAccepted = Math.max(1, GLOBAL_MAX_PLAYERS - 1);

          pendingHost = null;
          router.replace(() =>
            createWaitingRoomAsHostScreen({
              host,
              gameId: '', // 아직 게임 안 고름
              isPrivate,
              password,
              roomOptions: {},
            })
          );
        } catch (err) {
          if (disposed) return;
          showError(getErrorMessage(err as PeerConnectError));
          createBtn.disabled = false;
          createBtn.textContent = '방 만들기';
        }
      });

      return el;
    },

    dispose() {
      disposed = true;
      pendingHost?.close();
      pendingHost = null;
    },
  };
}

/** PeerConnectError를 한국어 메시지로 변환 */
function getErrorMessage(err: PeerConnectError): string {
  switch (err.kind) {
    case 'network':
      return '네트워크 연결을 확인해주세요';
    case 'timeout':
      return '응답 시간이 초과됐어요. 다시 시도해주세요';
    case 'room_not_found':
      return '방을 찾을 수 없어요';
    default:
      return err.detail || '알 수 없는 오류가 발생했어요';
  }
}
