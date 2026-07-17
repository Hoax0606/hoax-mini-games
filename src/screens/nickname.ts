import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage } from '../core/storage';
import { createMenuScreen } from './menu';
import { icon } from '../ui/icons';

/**
 * 닉네임 입력 화면
 * 최초 실행 시 또는 닉네임 변경 시 사용
 *
 * @param options.backToMenu  닉네임 변경 모드(취소 버튼 표시)
 * @param options.onDone      입력 완료 후 실행할 콜백 — 없으면 기본: 메뉴로 이동.
 *                            URL 방 코드로 진입 시 "입력 완료 → 바로 joinRoom" 용도로 씀.
 */
export function createNicknameScreen(options?: {
  backToMenu?: boolean;
  onDone?: () => void;
}): Screen {
  const backToMenu = options?.backToMenu ?? false;
  const onDone = options?.onDone;

  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        ${backToMenu ? `<button class="back-btn" id="back-btn" title="뒤로">←</button>` : ''}
        <div class="card pop-in" style="min-width: 380px;">
          <div class="card-title">${icon('pen', { size: 24, hue: '#ff9838' })} 닉네임을 알려주세요</div>
          <div class="card-subtitle">친구와 함께할 때 보일 이름이에요</div>

          <div class="form-group">
            <input
              type="text"
              class="input"
              id="nickname-input"
              placeholder="예: 헨리"
              maxlength="12"
              autocomplete="off"
            />
          </div>

          <button class="btn btn-primary btn-block btn-lg" id="confirm-btn">
            시작하기
          </button>
        </div>
      `;

      const input = el.querySelector<HTMLInputElement>('#nickname-input')!;
      const confirmBtn = el.querySelector<HTMLButtonElement>('#confirm-btn')!;
      const backBtn = el.querySelector<HTMLButtonElement>('#back-btn');

      // 기존 닉네임이 있으면 채워두기
      input.value = storage.getNickname();
      // 포커스
      setTimeout(() => input.focus(), 50);

      const confirm = () => {
        const name = input.value.trim();
        if (name.length === 0) {
          input.focus();
          input.style.borderColor = 'var(--pink-500)';
          return;
        }
        storage.setNickname(name);
        // 🎂 깜짝 생일 이벤트 — "수경" 으로 시작하면 메인 진입 시 폭죽 1회.
        //   sessionStorage 플래그로 menu 화면에 신호 (이 탭 세션에 한 번만).
        if (name === '수경') {
          sessionStorage.setItem('birthday-event', '수경');
        }
        if (onDone) {
          onDone();
        } else {
          router.reset(() => createMenuScreen());
        }
      };

      confirmBtn.addEventListener('click', confirm);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirm();
        input.style.borderColor = '';
      });

      backBtn?.addEventListener('click', () => router.back());

      return el;
    },
  };
}
