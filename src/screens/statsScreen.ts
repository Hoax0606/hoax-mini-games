import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage, type GameStats } from '../core/storage';
import { games } from '../games/registry';

/**
 * 통계 화면
 * 모든 게임의 누적 전적/최고기록을 카드로 보여준다.
 * localStorage 기반이므로 머신별 독립 (여러 PC에서 같이 쌓이지 않음).
 *
 * 하단에 "초기화" 버튼: 확인 후 storage.clearStats() — 복구 불가.
 */

export function createStatsScreen(): Screen {
  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';

      const allStats = storage.getStats();

      const cardsHTML = games.map((g) => {
        const s: GameStats | undefined = allStats[g.meta.id];
        return buildStatCard(g.meta.id, g.meta.name, g.meta.thumbnail, s);
      }).join('');

      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div style="width: 100%; max-width: 720px;">
          <div class="screen-title" style="text-align: center;">📊 전체 통계</div>
          <div class="screen-subtitle" style="text-align: center;">이 컴퓨터에 기록된 누적 전적이에요</div>

          <div class="stats-grid">
            ${cardsHTML}
          </div>

          <div class="stats-footer">
            <button class="btn btn-ghost" id="reset-btn">🗑️ 전체 초기화</button>
          </div>
        </div>
      `;

      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());
      el.querySelector('#reset-btn')!.addEventListener('click', () => {
        if (window.confirm('모든 전적과 최고기록이 삭제돼요. 되돌릴 수 없어요.\n\n정말 초기화할까요?')) {
          storage.clearStats();
          // 즉시 재렌더
          router.replace(() => createStatsScreen());
        }
      });

      return el;
    },
  };
}

/**
 * 게임 하나의 카드 HTML.
 * - 전적 없으면 "아직 기록이 없어요" 안내
 * - 있으면 승/패/무 + 승률 + 플레이 횟수 + 최고기록
 */
function buildStatCard(
  gameId: string,
  gameName: string,
  thumbnail: string,
  stats: GameStats | undefined,
): string {
  const hasPlays = stats && stats.plays > 0;
  const winRate = hasPlays && (stats.wins + stats.losses) > 0
    ? Math.round((stats.wins / (stats.wins + stats.losses)) * 100)
    : null;

  const recordsHTML = hasPlays ? renderBestRecords(gameId, stats.best) : '';

  const body = hasPlays ? `
    <div class="stats-card-row">
      <span class="stats-label">전적</span>
      <span class="stats-value">
        <strong class="stats-wins">${stats.wins}승</strong>
        · ${stats.losses}패
        ${stats.draws > 0 ? `· ${stats.draws}무` : ''}
        ${winRate !== null ? `<span class="stats-winrate">(${winRate}%)</span>` : ''}
      </span>
    </div>
    <div class="stats-card-row">
      <span class="stats-label">플레이</span>
      <span class="stats-value">${stats.plays}번</span>
    </div>
    ${recordsHTML}
  ` : `
    <div class="stats-card-empty">아직 기록이 없어요</div>
  `;

  return `
    <div class="stats-card">
      <div class="stats-card-header">
        <img class="stats-card-thumb" src="${escapeAttr(thumbnail)}" alt="${escapeAttr(gameName)}" />
        <div class="stats-card-name">${escapeHtml(gameName)}</div>
      </div>
      ${body}
    </div>
  `;
}

/** 게임별 최고기록 라벨 매핑 */
function renderBestRecords(gameId: string, best?: Record<string, number>): string {
  if (!best || Object.keys(best).length === 0) return '';

  const items: Array<{ label: string; formatted: string }> = [];
  switch (gameId) {
    case 'battle-tetris':
      if (best['linesCleared'] != null) items.push({ label: '최고 라인', formatted: `${best['linesCleared']}줄` });
      if (best['tetrisCount'] != null)  items.push({ label: '최다 테트리스', formatted: `${best['tetrisCount']}회` });
      if (best['maxCombo'] != null)     items.push({ label: '최대 콤보', formatted: `${best['maxCombo']}연속` });
      break;
    case 'apple-game':
      if (best['score'] != null) items.push({ label: '최고 점수', formatted: `${best['score']}점` });
      break;
    case 'reflex':
      if (best['bestMs'] != null) items.push({ label: '최고 기록', formatted: `${best['bestMs']}ms` });
      break;
    // 에어하키/오목은 승/패만
  }
  if (items.length === 0) return '';

  return `
    <div class="stats-card-records">
      ${items.map(it => `
        <div class="stats-record">
          <span class="stats-record-label">${escapeHtml(it.label)}</span>
          <span class="stats-record-value">${escapeHtml(it.formatted)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
