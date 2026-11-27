/**
 * 새 소식 팝업 — 접속했을 때 아직 안 본 변경 내역을 한 번 띄운다.
 *
 * 버튼이 둘인 이유:
 *   · 닫기        — 이번만 닫는다. 다음에 접속하면 또 뜬다.
 *   · 다시 보지 않기 — 지금 항목까지 봤다고 기록한다. 다음 새 게임·버그 수정이
 *                    올라오기 전까지는 안 뜬다 (영영 안 뜨는 게 아니다).
 *
 * 모달 뼈대는 ui/confirm.ts 와 같은 방식(overlay + is-in/is-out).
 */

import { escapeHtml } from './escape';
import { icon } from './icons';
import { markChangelogSeen, KIND_LABEL, type ChangeEntry } from '../data/changelog';
import { buildMiniGameCardHTML } from './gameCardMini';

/** 머리글은 가장 눈에 띄는 종류를 따라간다 — 새 게임이 하나라도 있으면 그게 주인공 */
function headline(entries: ChangeEntry[]): string {
  if (entries.some((e) => e.kind === 'game')) return '새로운 게임이 나왔어요!';
  if (entries.some((e) => e.kind === 'fix')) return '고친 것들이 있어요';
  return '새로워진 점이 있어요';
}

export function showNewsPopup(entries: ChangeEntry[]): void {
  if (entries.length === 0) return;

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay news-overlay';
  overlay.innerHTML = `
    <div class="confirm-card news-card" role="dialog" aria-modal="true">
      <div class="confirm-icon">${icon('bell', { size: 26, hue: '#ffb12e' })}</div>
      <div class="confirm-title">${escapeHtml(headline(entries))}</div>
      <div class="news-body">
        ${entries.map((e) => `
          <div class="news-entry">
            <div class="news-entry-head">
              <span class="news-kind k-${e.kind}">${KIND_LABEL[e.kind]}</span>
              <span class="news-entry-title">${escapeHtml(e.title)}</span>
            </div>
            ${e.gameId ? buildMiniGameCardHTML(e.gameId) : ''}
            <ul class="news-items">
              ${e.items.map((it) => `<li>${escapeHtml(it)}</li>`).join('')}
            </ul>
          </div>`).join('')}
      </div>
      <div class="confirm-actions">
        <button class="btn btn-ghost" data-act="never">다시 보지 않기</button>
        <button class="btn btn-primary" data-act="close">닫기</button>
      </div>
    </div>`;

  let settled = false;
  const close = (never: boolean): void => {
    if (settled) return;
    settled = true;
    if (never) markChangelogSeen();
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.add('is-out');
    window.setTimeout(() => overlay.remove(), 160);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); close(false); }
  };

  overlay.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset['act'];
    if (act) { close(act === 'never'); return; }
    if (e.target === overlay) close(false); // 바깥 클릭 = 그냥 닫기
  });
  document.addEventListener('keydown', onKey, true);

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  overlay.querySelector<HTMLButtonElement>('[data-act="close"]')?.focus();
}
