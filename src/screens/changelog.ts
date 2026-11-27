/**
 * 변경 로그 화면 — 날짜별 타임라인.
 *
 * 데이터는 `src/data/changelog.ts` 하나뿐이다 (접속 팝업과 같은 배열).
 *
 * 이 화면은 팝업을 끄지 않는다. 한때 "여기까지 들어와 읽었으면 다 본 것" 으로
 * 쳤는데, 로그를 구경했을 뿐인데 알림이 조용히 꺼져서 왜 안 뜨는지 알 수가 없었다.
 * 팝업을 끄는 스위치는 팝업 안의 "다시 보지 않기" 체크 하나뿐이다.
 */

import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { CHANGELOG, KIND_LABEL, type ChangeEntry } from '../data/changelog';
import { escapeHtml } from '../ui/escape';
import { icon } from '../ui/icons';
import { buildMiniGameCardHTML } from '../ui/gameCardMini';

/** '2026-11-27' → { day: '11월 27일', year: '2026' } */
function splitDate(iso: string): { day: string; year: string } {
  const [y, m, d] = iso.split('-');
  return { day: `${Number(m)}월 ${Number(d)}일`, year: y ?? '' };
}

/** 같은 날짜끼리 묶는다. 배열이 이미 최신순이라 순서는 그대로 쓰면 된다 */
function groupByDate(entries: ChangeEntry[]): Array<{ date: string; list: ChangeEntry[] }> {
  const out: Array<{ date: string; list: ChangeEntry[] }> = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.date === e.date) last.list.push(e);
    else out.push({ date: e.date, list: [e] });
  }
  return out;
}

function buildEntryHTML(e: ChangeEntry): string {
  return `
    <div class="cl-entry">
      <div class="cl-entry-head">
        <span class="news-kind k-${e.kind}">${KIND_LABEL[e.kind]}</span>
        <span class="cl-entry-title">${escapeHtml(e.title)}</span>
      </div>
      ${e.gameId ? buildMiniGameCardHTML(e.gameId) : ''}
      <ul class="news-items">
        ${e.items.map((it) => `<li>${escapeHtml(it)}</li>`).join('')}
      </ul>
    </div>`;
}

export function createChangelogScreen(): Screen {
  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';

      const daysHTML = groupByDate(CHANGELOG).map(({ date, list }) => {
        const { day, year } = splitDate(date);
        return `
          <div class="cl-day">
            <div class="cl-date">${day}<span class="cl-year">${year}</span></div>
            ${list.map(buildEntryHTML).join('')}
          </div>`;
      }).join('');

      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div style="width: 100%; max-width: 680px;">
          <div class="screen-title">${icon('list', { size: 24, hue: '#2a9488' })} 변경 로그</div>

          <div class="cl-list">
            ${daysHTML}
          </div>
        </div>
      `;

      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());
      return el;
    },
  };
}
