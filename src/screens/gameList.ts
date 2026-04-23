import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { games } from '../games/registry';
import { createLobbyScreen } from './lobby';

/**
 * 게임 선택 화면
 * 레지스트리의 모든 게임을 카드 그리드로 표시.
 * 카드 클릭 → 로비로 이동 (선택한 gameId 전달)
 */
export function createGameListScreen(): Screen {
  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div style="text-align: center; width: 100%; max-width: 960px;">
          <div class="screen-title">🎮 게임 선택</div>
          <div class="screen-subtitle">어떤 게임을 할까요?</div>

          <div class="game-grid">
            ${games.map(g => `
              <button class="game-card" data-game-id="${escapeAttr(g.meta.id)}">
                <img class="game-card-thumb" src="${escapeAttr(g.meta.thumbnail)}" alt="${escapeAttr(g.meta.name)}" />
                <div class="game-card-name">
                  ${escapeHtml(g.meta.name)}
                  <span class="game-card-players">${playersBadge(g.meta.minPlayers, g.meta.maxPlayers)}</span>
                </div>
                <div class="game-card-desc">${escapeHtml(g.meta.description)}</div>
              </button>
            `).join('')}
          </div>
        </div>
      `;

      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());

      el.querySelectorAll<HTMLButtonElement>('.game-card').forEach((card) => {
        card.addEventListener('click', () => {
          const gameId = card.dataset.gameId;
          if (!gameId) return;
          router.push(() => createLobbyScreen(gameId));
        });
      });

      return el;
    },
  };
}

function playersBadge(min: number, max: number): string {
  if (min === max) return `${min}인 전용`;
  return `${min}~${max}인`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
