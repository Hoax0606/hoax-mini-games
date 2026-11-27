/**
 * 새 소식 팝업 — 접속했을 때 아직 안 본 변경 내역을 한 번 띄운다.
 *
 * 닫는 버튼은 하나고, "다시 보지 않기" 는 체크박스다:
 *   · 그냥 닫으면    — 다음에 접속하면 또 뜬다.
 *   · 체크하고 닫으면 — 지금 항목까지 봤다고 기록한다. 다음 새 게임·버그 수정이
 *                    올라오기 전까지는 안 뜬다 (영영 안 뜨는 게 아니다).
 * ESC 나 바깥 클릭으로 닫아도 체크 상태를 그대로 따른다.
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
      <div class="news-foot">
        <label class="news-never" title="다음 새 게임이나 버그 수정이 올라오기 전까지 안 보여요">
          <input type="checkbox" id="news-never" /> 다시 보지 않기
        </label>
        <button class="btn btn-primary" data-act="close">닫기</button>
      </div>
    </div>`;

  const neverBox = overlay.querySelector<HTMLInputElement>('#news-never')!;

  let settled = false;
  /** 어떤 식으로 닫든(버튼·ESC·바깥 클릭) 체크 상태를 그대로 반영한다 */
  const close = (): void => {
    if (settled) return;
    settled = true;
    if (neverBox.checked) markChangelogSeen();
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.add('is-out');
    window.setTimeout(() => overlay.remove(), 160);
  };
  const onKey = (e: KeyboardEvent): void => {
    // Space 는 가로채지 않는다 — 체크박스에 포커스가 갔을 때 토글이 돼야 한다
    if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); close(); }
  };

  overlay.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-act="close"]')) { close(); return; }
    if (e.target === overlay) close(); // 바깥 클릭
  });
  document.addEventListener('keydown', onKey, true);

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  overlay.querySelector<HTMLButtonElement>('[data-act="close"]')?.focus();
}
