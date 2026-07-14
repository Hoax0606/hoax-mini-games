import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { getGameById } from '../games/registry';
import { createCreateRoomScreen } from './createRoom';
import { createJoinRoomScreen } from './joinRoom';
import { escapeHtml } from '../ui/escape';
import { clearChatHistory } from '../ui/chat';

/**
 * 로비 화면
 * 선택한 게임으로 "방 만들기" 또는 "방 참여하기" 분기.
 *
 * @param gameId 게임 선택 화면에서 고른 게임의 id
 */
export function createLobbyScreen(gameId: string): Screen {
  return {
    render() {
      // 방을 나오면(로비 복귀) 이전 방 채팅 기록 초기화 — 다음 방에 옛 대화가 새는 것 방지.
      //   (메뉴 복귀 외에 로비 복귀 경로에선 안 지워지던 누수)
      clearChatHistory();
      const game = getGameById(gameId);
      // 레지스트리에 없는 id가 들어오면(=정상 플로우에선 생길 일 없음) 선택 화면으로 복귀
      if (!game) {
        queueMicrotask(() => router.back());
        return document.createElement('div');
      }

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div style="text-align: center;">
          <div class="screen-title">${escapeHtml(game.meta.name)}</div>
          <div class="screen-subtitle">친구와 방을 만들거나, 친구가 만든 방에 참여하세요</div>

          <div class="menu-list">
            <button class="btn btn-primary btn-lg btn-block" id="btn-create">
              🏠 방 만들기
            </button>
            <button class="btn btn-secondary btn-lg btn-block" id="btn-join">
              🚪 방 참여하기
            </button>
          </div>
        </div>
      `;

      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());

      el.querySelector('#btn-create')!.addEventListener('click', () => {
        router.push(() => createCreateRoomScreen(gameId));
      });

      el.querySelector('#btn-join')!.addEventListener('click', () => {
        router.push(() => createJoinRoomScreen(gameId));
      });

      return el;
    },
  };
}

