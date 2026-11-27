/**
 * 변경 로그 화면 — 날짜별 타임라인 + 종류 필터.
 *
 * 데이터는 `src/data/changelog.ts` 하나뿐이다 (접속 팝업과 같은 배열).
 *
 * 이 화면은 팝업을 끄지 않는다. 한때 "여기까지 들어와 읽었으면 다 본 것" 으로
 * 쳤는데, 로그를 구경했을 뿐인데 알림이 조용히 꺼져서 왜 안 뜨는지 알 수가 없었다.
 * 팝업을 끄는 스위치는 팝업 안의 "다시 보지 않기" 체크 하나뿐이다.
 */

import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { CHANGELOG, KIND_LABEL, type ChangeEntry, type ChangeKind } from '../data/changelog';
import { escapeHtml } from '../ui/escape';
import { icon } from '../ui/icons';
import { buildMiniGameCardHTML } from '../ui/gameCardMini';
import { wireDropdown } from '../ui/gamePicker';

/** null = 전체 */
type KindFilter = ChangeKind | null;

const KINDS: KindFilter[] = [null, 'game', 'feature', 'fix'];

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

function countOf(kind: KindFilter): number {
  return kind === null ? CHANGELOG.length : CHANGELOG.filter((e) => e.kind === kind).length;
}

function labelOf(kind: KindFilter): string {
  return kind === null ? '전체' : KIND_LABEL[kind];
}

/** 게임 목록의 분류 필터와 같은 모양 (pf-dd). 옆에 개수를 붙여 뭐가 많은지 보이게 */
function buildKindFilterHTML(selected: KindFilter): string {
  const items = KINDS.map((k) => `
    <button type="button" class="pf-dd-item${k === selected ? ' is-on' : ''}" data-kind="${k ?? ''}">
      <span>${labelOf(k)}</span><i class="cl-count">${countOf(k)}</i>
    </button>`).join('');
  return `
    <div class="pf-dd pf-dd-kind">
      <button type="button" class="pf-dd-btn" aria-expanded="false" aria-haspopup="listbox">
        ${icon('list', { size: 14, hue: '#2a9488' })}
        <span class="pf-dd-label">종류</span>
        <b>${labelOf(selected)}</b>
        <span class="pf-dd-caret" aria-hidden="true"></span>
      </button>
      <div class="pf-dd-menu" role="listbox" hidden>${items}</div>
    </div>`;
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

function buildDaysHTML(kind: KindFilter): string {
  const entries = kind === null ? CHANGELOG : CHANGELOG.filter((e) => e.kind === kind);
  if (entries.length === 0) return '<div class="cl-empty">해당하는 내역이 없어요</div>';
  return groupByDate(entries).map(({ date, list }) => {
    const { day, year } = splitDate(date);
    return `
      <div class="cl-day">
        <div class="cl-date">${day}<span class="cl-year">${year}</span></div>
        ${list.map(buildEntryHTML).join('')}
      </div>`;
  }).join('');
}

export function createChangelogScreen(): Screen {
  return {
    render() {
      let kind: KindFilter = null;

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div style="width: 100%; max-width: 680px;">
          <div class="screen-title">${icon('list', { size: 24, hue: '#2a9488' })} 변경 로그</div>

          <div class="pf-wrap" id="cl-filter">${buildKindFilterHTML(kind)}</div>

          <div class="cl-list" id="cl-list">${buildDaysHTML(kind)}</div>
        </div>
      `;

      const filterEl = el.querySelector<HTMLDivElement>('#cl-filter')!;
      const listEl = el.querySelector<HTMLDivElement>('#cl-list')!;

      // 게임 목록과 같은 방식 — 고를 때마다 필터 markup 을 새로 깔고 다시 배선한다.
      // 새 markup 은 menu 가 hidden 이라 드롭다운이 자연히 닫힌다.
      const rerender = (): void => {
        filterEl.innerHTML = buildKindFilterHTML(kind);
        wire();
        listEl.innerHTML = buildDaysHTML(kind);
      };
      const wire = (): void => {
        wireDropdown(filterEl.querySelector<HTMLElement>('.pf-dd-kind'), (it) => {
          const raw = it.dataset['kind'];
          kind = raw ? (raw as ChangeKind) : null;
          rerender();
        });
      };
      wire();

      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());
      return el;
    },
  };
}
