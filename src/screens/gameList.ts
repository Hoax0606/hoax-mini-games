import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { games } from '../games/registry';
import { escapeHtml, escapeAttr } from '../ui/escape';
import { icon } from '../ui/icons';

/**
 * 게임 목록(도감) 화면 — 구경 전용.
 * 레지스트리의 모든 게임을 카드 그리드로 표시. 방 생성은 여기서 안 함(방은 '방 만들기'로,
 * 게임은 방 안에서 방장이 고른다). 카드는 정보 표시용이라 클릭 동작 없음.
 */
export function createGameListScreen(): Screen {
  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div style="text-align: center; width: 100%; max-width: 960px;">
          <div class="screen-title">${icon('games', { size: 26, hue: '#a06bff' })} 게임 목록</div>
          <div class="screen-subtitle">방을 만든 뒤 안에서 골라요</div>

          <div class="game-grid">
            ${games.map(g => `
              <div class="game-card is-static">
                <img class="game-card-thumb" src="${escapeAttr(g.meta.thumbnail)}" alt="${escapeAttr(g.meta.name)}" />
                <div class="game-card-name">
                  ${escapeHtml(g.meta.name)}
                  <span class="game-card-players">${playersBadge(g.meta.minPlayers, g.meta.maxPlayers)}</span>
                </div>
                <div class="game-card-desc">${escapeHtml(g.meta.description)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;

      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());

      return el;
    },
  };
}

function playersBadge(min: number, max: number): string {
  if (min === max) return `${min}인 전용`;
  return `${min}~${max}인`;
}

