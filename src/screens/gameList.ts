import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { games } from '../games/registry';
import { escapeHtml, escapeAttr } from '../ui/escape';
import { icon } from '../ui/icons';
import {
  buildPlayerFilterHTML, wirePlayerFilter, playableBy, type PlayerFilter,
  buildCategoryFilterHTML, wireCategoryFilter, inCategory, type CategoryFilter,
} from '../ui/gamePicker';

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
      let cat: CategoryFilter = null;

      const gridHTML = (n: PlayerFilter): string => {
        const shown = games.filter((g) => playableBy(g.meta, n) && inCategory(g.meta, cat));
        if (shown.length === 0) {
          // 두 필터가 겹쳐 0개가 될 수 있어서 어느 조건 때문인지 같이 알려준다
          const why = [cat, n === null ? null : `${n}명`].filter(Boolean).join(' · ');
          return `<div class="pf-empty">${escapeHtml(why)} 조건에 맞는 게임이 없어요</div>`;
        }
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

          <div class="pf-wrap" id="game-filter">${buildCategoryFilterHTML(cat)}${buildPlayerFilterHTML(filter)}</div>

          <div class="game-grid" id="game-grid">${gridHTML(filter)}</div>
        </div>
      `;

      const filterEl = el.querySelector<HTMLDivElement>('#game-filter')!;
      const gridEl = el.querySelector<HTMLDivElement>('#game-grid')!;
      /** 두 필터 중 뭐가 바뀌든 같은 경로로 다시 그린다(드롭다운은 재렌더라 배선도 다시) */
      const rerender = (): void => {
        filterEl.innerHTML = buildCategoryFilterHTML(cat) + buildPlayerFilterHTML(filter);
        wireCategoryFilter(filterEl, (c) => { cat = c; rerender(); });
        wirePlayerFilter(filterEl, (n) => { filter = n; rerender(); });
        gridEl.innerHTML = gridHTML(filter);
      };
      wireCategoryFilter(filterEl, (c) => { cat = c; rerender(); });
      wirePlayerFilter(filterEl, (n) => { filter = n; rerender(); });

      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());

      return el;
    },
  };
}

function playersBadge(min: number, max: number): string {
  if (min === max) return `${min}인 전용`;
  return `${min}~${max}인`;
}

