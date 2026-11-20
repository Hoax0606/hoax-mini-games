import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { games } from '../games/registry';
import { escapeHtml, escapeAttr } from '../ui/escape';
import { icon } from '../ui/icons';
import { buildPlayerFilterHTML, wirePlayerFilter, playableBy, type PlayerFilter } from '../ui/gamePicker';

/**
 * 게임 목록(도감) 화면 — 구경 전용.
 * 레지스트리의 모든 게임을 카드 그리드로 표시. 방 생성은 여기서 안 함(방은 '방 만들기'로,
 * 게임은 방 안에서 방장이 고른다). 카드는 정보 표시용이라 클릭 동작 없음.
 *
 * 인원수 필터는 게임 선택 화면과 같은 컴포넌트를 쓴다(ui/gamePicker).
 */
export function createGameListScreen(): Screen {
  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';
      let filter: PlayerFilter = null;

      const gridHTML = (n: PlayerFilter): string => {
        const shown = games.filter((g) => playableBy(g.meta, n));
        if (shown.length === 0) return `<div class="pf-empty">${n}명이 할 수 있는 게임이 없어요</div>`;
        return shown.map(g => `
          <div class="game-card is-static">
            <img class="game-card-thumb" src="${escapeAttr(g.meta.thumbnail)}" alt="${escapeAttr(g.meta.name)}" />
            <div class="game-card-name">
              ${escapeHtml(g.meta.name)}
              <span class="game-card-players">${playersBadge(g.meta.minPlayers, g.meta.maxPlayers)}</span>
            </div>
            <div class="game-card-desc">${escapeHtml(g.meta.description)}</div>
          </div>
        `).join('');
      };

      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div style="text-align: center; width: 100%; max-width: 960px;">
          <div class="screen-title">${icon('games', { size: 26, hue: '#a06bff' })} 게임 목록</div>
          <div class="screen-subtitle">방을 만든 뒤 안에서 골라요</div>

          <div class="pf-wrap" id="game-filter">${buildPlayerFilterHTML(filter)}</div>

          <div class="game-grid" id="game-grid">${gridHTML(filter)}</div>
        </div>
      `;

      const filterEl = el.querySelector<HTMLDivElement>('#game-filter')!;
      const gridEl = el.querySelector<HTMLDivElement>('#game-grid')!;
      const applyFilter = (n: PlayerFilter): void => {
        filter = n;
        filterEl.innerHTML = buildPlayerFilterHTML(filter);
        wirePlayerFilter(filterEl, applyFilter);
        gridEl.innerHTML = gridHTML(filter);
      };
      wirePlayerFilter(filterEl, applyFilter);

      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());

      return el;
    },
  };
}

function playersBadge(min: number, max: number): string {
  if (min === max) return `${min}인 전용`;
  return `${min}~${max}인`;
}

