import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { createJoinRoomScreen } from './joinRoom';
import {
  subscribePublicRooms,
  isRoomDirectoryEnabled,
  type PublicRoomEntry,
} from '../core/roomDirectory';
import { escapeHtml, escapeAttr } from '../ui/escape';

/**
 * 공개방 찾기 화면
 *
 * Firebase Realtime DB 의 publicRooms 노드를 실시간 구독해서 카드 리스트로 표시.
 * 카드 클릭 → joinRoom 화면을 initialCode + autoJoin 으로 띄움 → 즉시 입장.
 *
 * Firebase 미설정 시: 안내 문구만 표시하고 빈 상태.
 */
export function createPublicRoomsScreen(): Screen {
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div style="text-align: center; width: 100%; max-width: 880px;">
          <div class="screen-title">🌐 공개방 찾기</div>
          <div class="screen-subtitle">지금 열려있는 공개방에 그냥 들어가요</div>

          <div class="public-rooms-list" id="public-rooms-list">
            <div class="public-rooms-empty">불러오는 중…</div>
          </div>
        </div>
      `;

      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());
      const listEl = el.querySelector<HTMLDivElement>('#public-rooms-list')!;

      if (!isRoomDirectoryEnabled()) {
        listEl.innerHTML = `
          <div class="public-rooms-empty">
            <div style="font-size: 28px; margin-bottom: 8px;">🛠️</div>
            <div>공개방 기능이 아직 설정 안 됐어요</div>
            <div class="public-rooms-empty-sub">
              <code>src/core/firebase.config.ts</code> 에 Firebase 정보를 채워주세요.
            </div>
          </div>
        `;
        return el;
      }

      unsubscribe = subscribePublicRooms((rooms) => {
        if (disposed) return;
        renderList(listEl, rooms);
      });

      return el;
    },

    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

function renderList(listEl: HTMLDivElement, rooms: PublicRoomEntry[]): void {
  if (rooms.length === 0) {
    listEl.innerHTML = `
      <div class="public-rooms-empty">
        <div style="font-size: 28px; margin-bottom: 8px;">📭</div>
        <div>지금 열려있는 공개방이 없어요</div>
        <div class="public-rooms-empty-sub">친구와 공개방을 직접 만들어보세요</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = rooms
    .map((r) => {
      const isFull = r.playerCount >= r.maxPlayers;
      const inGame = r.status === 'playing';
      const statusBadge = inGame
        ? `<span class="public-room-badge is-playing">🎮 게임 중</span>`
        : `<span class="public-room-badge is-waiting">🪑 대기 중</span>`;
      // 비공개방은 자물쇠 표시 — 클릭하면 비번 입력 화면으로 감.
      const lockBadge = r.isPrivate
        ? `<span class="public-room-badge is-locked">🔒 비공개</span>`
        : '';
      // 정원(활성+대기) 초과면 게임 중이든 대기든 못 들어감 → 흐림+비활성.
      //   (게임 중 방도 관전/대기 자리가 정원에 포함되어 꽉 차면 입장 불가)
      const blocked = isFull;
      return `
        <button class="public-room-card${blocked ? ' is-full' : ''}"
                data-room-id="${escapeAttr(r.roomId)}"
                data-private="${r.isPrivate ? '1' : '0'}"
                ${blocked ? 'disabled' : ''}>
          <div class="public-room-game-name">${escapeHtml(r.gameName)}</div>
          <div class="public-room-meta-row">
            <span class="public-room-host">${escapeHtml(r.hostNickname)}</span>
            <span class="public-room-dot">·</span>
            <span class="public-room-count">${r.playerCount} / ${r.maxPlayers}명</span>
          </div>
          <div class="public-room-bottom-row">
            ${statusBadge}
            ${lockBadge}
            <span class="public-room-code">${escapeHtml(r.roomId)}</span>
          </div>
        </button>
      `;
    })
    .join('');

  listEl.querySelectorAll<HTMLButtonElement>('.public-room-card').forEach((card) => {
    card.addEventListener('click', () => {
      const roomId = card.dataset.roomId;
      if (!roomId) return;
      const isPrivate = card.dataset.private === '1';
      // 비공개방: 비번 입력 필요 → 자동입장 대신 비번 필드를 처음부터 보여줌.
      // 공개방: autoJoin 으로 즉시 입장. gameId 는 어차피 join_accepted 의 roomState 가 정답이라 빈 문자열 OK.
      if (isPrivate) {
        router.push(() => createJoinRoomScreen('', { initialCode: roomId, requirePassword: true }));
      } else {
        router.push(() => createJoinRoomScreen('', { initialCode: roomId, autoJoin: true }));
      }
    });
  });
}

