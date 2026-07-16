import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage } from '../core/storage';
import { createSettingsScreen } from './settings';
import { createNicknameScreen } from './nickname';
import { createGameListScreen } from './gameList';
import { createCreateRoomScreen } from './createRoom';
import { createStatsScreen } from './statsScreen';
import { createPublicRoomsScreen } from './publicRooms';
import { clearChatHistory } from '../ui/chat';
import { escapeHtml } from '../ui/escape';
import { icon } from '../ui/icons';
import { showBirthdayEvent } from '../ui/birthdayEvent';
import { sound } from '../core/sound';

/**
 * 메인 메뉴
 */
export function createMenuScreen(): Screen {
  return {
    render() {
      // 메뉴 진입 = 방 떠난 시점 — 채팅 히스토리 초기화 (다음 방은 빈 상태에서 시작)
      clearChatHistory();

      const nickname = storage.getNickname();

      const el = document.createElement('div');
      el.className = 'screen';
      // 각 메뉴 아이콘 색 (컬러 모드 — iOS 설정처럼 항목별 파스텔 색)
      const HUE = {
        create: '#ff5a92', find: '#5b9dff', games: '#a06bff',
        stats: '#2eb872', nick: '#ff9838', settings: '#9a86c0',
      };
      el.innerHTML = `
        <div style="text-align: center;">
          <div class="logo pop-in">Hoax Minigames</div>
          <div class="tagline">친구와 함께하는 작은 게임들 · ${escapeHtml(nickname)}</div>

          <div class="menu-card menu-list stagger-in">
            <button class="btn btn-secondary btn-lg btn-block" id="btn-create-room">
              ${icon('home-add', { size: 22, hue: HUE.create })}<span class="btn-label">방 만들기</span>
            </button>
            <button class="btn btn-secondary btn-block" id="btn-public-rooms">
              ${icon('search', { size: 22, hue: HUE.find })}<span class="btn-label">방 찾기</span>
            </button>
            <button class="btn btn-secondary btn-block" id="btn-game-list">
              ${icon('games', { size: 22, hue: HUE.games })}<span class="btn-label">게임 목록</span>
            </button>
            <button class="btn btn-secondary btn-block" id="btn-stats">
              ${icon('chart', { size: 22, hue: HUE.stats })}<span class="btn-label">통계</span>
            </button>
            <button class="btn btn-secondary btn-block" id="btn-nickname">
              ${icon('pen', { size: 22, hue: HUE.nick })}<span class="btn-label">닉네임 변경</span>
            </button>
            <button class="btn btn-secondary btn-block" id="btn-settings">
              ${icon('settings', { size: 22, hue: HUE.settings })}<span class="btn-label">설정</span>
            </button>
          </div>
        </div>
      `;

      el.querySelector('#btn-create-room')!.addEventListener('click', () => {
        // 게임은 방 안(대기실)에서 고른다 → 여기선 게임 없이 방부터 만든다.
        router.push(() => createCreateRoomScreen());
      });

      el.querySelector('#btn-public-rooms')!.addEventListener('click', () => {
        router.push(() => createPublicRoomsScreen());
      });

      el.querySelector('#btn-game-list')!.addEventListener('click', () => {
        router.push(() => createGameListScreen());
      });

      el.querySelector('#btn-stats')!.addEventListener('click', () => {
        router.push(() => createStatsScreen());
      });

      el.querySelector('#btn-nickname')!.addEventListener('click', () => {
        router.push(() => createNicknameScreen({ backToMenu: true }));
      });

      el.querySelector('#btn-settings')!.addEventListener('click', () => {
        router.push(() => createSettingsScreen());
      });

      // 🎂 깜짝 생일 이벤트 — 닉네임 "수경" 으로 시작했으면 폭죽 + 축하 메시지 1회.
      const isBirthday = sessionStorage.getItem('birthday-event') === '수경';
      if (isBirthday) {
        sessionStorage.removeItem('birthday-event');
        // 메뉴 BGM 은 켜지 않고 바로 생일 노래로. 닫힐 때 메뉴 BGM 복귀.
        window.setTimeout(() => {
          showBirthdayEvent({
            title: '수경아 도쿄를 대표해서 생일을 축하한다!',
            sender: '- 도쿄도민 오상&진상',
            onClose: () => sound.startBgm('menu'),
          });
        }, 80);
      } else {
        // 평소 메뉴 — 잔잔한 로비 BGM. 게임/대기실 진입 시 그쪽 BGM 으로 교체됨.
        sound.startBgm('menu');
      }

      return el;
    },
  };
}

