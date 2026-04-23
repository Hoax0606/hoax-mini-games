import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage } from '../core/storage';
import { createMenuScreen } from './menu';

/**
 * 닉네임 입력 화면
 * 최초 실행 시 또는 닉네임 변경 시 사용
 */
export function createNicknameScreen(options?: { backToMenu?: boolean }): Screen {
  const backToMenu = options?.backToMenu ?? false;

  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <div class="card" style="min-width: 380px;">
          <div class="card-title">✨ 닉네임을 알려주세요</div>
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

          ${backToMenu ? `
            <button class="btn btn-ghost btn-block" id="cancel-btn" style="margin-top: 8px;">
              취소
            </button>
          ` : ''}
        </div>
      `;

      const input = el.querySelector<HTMLInputElement>('#nickname-input')!;
      const confirmBtn = el.querySelector<HTMLButtonElement>('#confirm-btn')!;
      const cancelBtn = el.querySelector<HTMLButtonElement>('#cancel-btn');

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
        router.reset(() => createMenuScreen());
      };

      confirmBtn.addEventListener('click', confirm);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirm();
        input.style.borderColor = '';
      });

      cancelBtn?.addEventListener('click', () => router.back());

      return el;
    },
  };
}
