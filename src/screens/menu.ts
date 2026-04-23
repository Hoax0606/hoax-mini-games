import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage } from '../core/storage';
import { createSettingsScreen } from './settings';
import { createNicknameScreen } from './nickname';
import { createGameListScreen } from './gameList';

/**
 * 메인 메뉴
 */
export function createMenuScreen(): Screen {
  return {
    render() {
      const nickname = storage.getNickname();

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <div style="text-align: center;">
          <div class="logo">Hoax Minigames</div>
          <div class="tagline">친구와 함께하는 작은 게임들 · ${escapeHtml(nickname)}</div>

          <div class="menu-list">
            <button class="btn btn-primary btn-lg btn-block" id="btn-start">
              🎮 게임 시작
            </button>
            <button class="btn btn-secondary btn-block" id="btn-nickname">
              ✏️ 닉네임 변경
            </button>
            <button class="btn btn-secondary btn-block" id="btn-settings">
              ⚙️ 설정
            </button>
          </div>
        </div>
      `;

      el.querySelector('#btn-start')!.addEventListener('click', () => {
        router.push(() => createGameListScreen());
      });

      el.querySelector('#btn-nickname')!.addEventListener('click', () => {
        router.push(() => createNicknameScreen({ backToMenu: true }));
      });

      el.querySelector('#btn-settings')!.addEventListener('click', () => {
        router.push(() => createSettingsScreen());
      });

      return el;
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
