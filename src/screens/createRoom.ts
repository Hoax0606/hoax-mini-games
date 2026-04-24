import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { getGameById } from '../games/registry';
import { HostSession, type PeerConnectError } from '../core/peer';
import type { GameRoomOption } from '../games/types';
import { createWaitingRoomAsHostScreen } from './waitingRoom';

/**
 * 방 만들기 화면
 *
 * 설계 요약:
 *   - 게임 옵션(승리 점수 등) + 공개/비공개 + 비밀번호 수집
 *   - "방 만들기" 누르면 HostSession 생성 (PeerJS 브로커에 등록)
 *   - 성공하면 대기실(waitingRoom)로 이동
 *   - 생성 도중 뒤로가기 하면 dispose에서 연결 정리
 *
 * 방 로직(비번 검증, RoomState 관리)은 다음 파일 waitingRoom.ts에 있다.
 * 이 화면은 "설정 수집 + HostSession 생성"까지만 담당.
 */
export function createCreateRoomScreen(gameId: string): Screen {
  let disposed = false;
  /** 생성 중에 뒤로가기 누르면 여기에 담아두고 dispose에서 close() */
  let pendingHost: HostSession | null = null;

  return {
    render() {
      const game = getGameById(gameId);
      if (!game) {
        queueMicrotask(() => router.back());
        return document.createElement('div');
      }

      // 로컬 상태 (DOM 이벤트가 갱신)
      const optionValues: Record<string, string> = {};
      for (const opt of game.meta.roomOptions) {
        optionValues[opt.key] = opt.defaultValue;
      }
      let isPrivate = false;
      let password = '';

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div class="card">
          <div class="card-title">🏠 방 만들기</div>
          <div class="card-subtitle">${escapeHtml(game.meta.name)}</div>

          ${game.meta.roomOptions.map(renderOption).join('')}

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

      // 뒤로가기
      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());

      // 게임 옵션 select 리스너 등록
      for (const opt of game.meta.roomOptions) {
        const select = el.querySelector<HTMLSelectElement>(`#opt-${opt.key}`);
        select?.addEventListener('change', () => {
          optionValues[opt.key] = select.value;
        });
      }

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

      // 에러 메시지 헬퍼
      const errorEl = el.querySelector<HTMLDivElement>('#error-message')!;
      const showError = (msg: string): void => {
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
      };
      const clearError = (): void => {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
      };

      // "방 만들기" 버튼
      const createBtn = el.querySelector<HTMLButtonElement>('#create-btn')!;
      createBtn.addEventListener('click', async () => {
        clearError();

        // 비밀번호 검증
        if (isPrivate) {
          if (password.length < 4 || password.length > 12) {
            showError('비밀번호는 4~12자로 입력해주세요');
            passwordInput.focus();
            return;
          }
        }

        // 로딩 상태
        createBtn.disabled = true;
        createBtn.textContent = '방 만드는 중…';

        try {
          const host = await HostSession.create();

          // 화면에서 벗어난 뒤에 생성 완료된 경우 → 조용히 정리
          if (disposed) {
            host.close();
            return;
          }

          // 게임의 최대 인원 - 1 명의 게스트까지 수락 (방장 본인은 제외)
          host.maxAccepted = Math.max(1, game.meta.maxPlayers - 1);

          // host 소유권을 대기실로 넘긴다. 이 시점 이후엔 host 정리는 대기실의 책임.
          pendingHost = null;

          // replace로 이동: 대기실에서 뒤로가기 하면 로비로 바로 가도록
          // (createRoom 화면은 히스토리에서 제거)
          router.replace(() =>
            createWaitingRoomAsHostScreen({
              host,
              gameId,
              isPrivate,
              password,
              roomOptions: optionValues,
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
      // 생성 로딩 중 뒤로가기 → 완료된 HostSession을 브로커에서 해제
      pendingHost?.close();
      pendingHost = null;
    },
  };
}

/**
 * 게임 옵션 하나를 HTML로 렌더링.
 * 지금은 select만 지원 (GameRoomOption.type이 'select'만 있음).
 */
function renderOption(opt: GameRoomOption): string {
  return `
    <div class="form-group">
      <label class="input-label">${escapeHtml(opt.label)}</label>
      <select class="select" id="opt-${escapeAttr(opt.key)}">
        ${opt.choices.map((c) => `
          <option value="${escapeAttr(c.value)}"${c.value === opt.defaultValue ? ' selected' : ''}>
            ${escapeHtml(c.label)}
          </option>
        `).join('')}
      </select>
    </div>
  `;
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
