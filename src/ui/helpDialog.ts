/**
 * 게임 도움말 창.
 *
 * 한 게임의 규칙을 같은 모양으로 보여준다 — 게임 목록, 대기실, 게임 중 세 군데가
 * 이걸 같이 쓴다. 내용은 `registry.ts` 의 `meta.help` 한 군데에만 적는다.
 *
 * 모달 뼈대는 ui/confirm.ts 와 같은 방식(overlay + is-in/is-out).
 */

import { escapeHtml } from './escape';
import { icon } from './icons';
import type { GameMeta } from '../games/types';

function playersText(m: GameMeta): string {
  return m.minPlayers === m.maxPlayers ? `${m.minPlayers}인 전용` : `${m.minPlayers}~${m.maxPlayers}인`;
}

export function showGameHelp(meta: GameMeta): void {
  const h = meta.help;

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay help-overlay';
  overlay.innerHTML = `
    <div class="confirm-card help-card" role="dialog" aria-modal="true">
      <div class="help-head">
        <img class="help-thumb" src="${meta.thumbnail}" alt="" />
        <div class="help-head-text">
          <div class="help-title">${escapeHtml(meta.name)}</div>
          <div class="help-meta">${escapeHtml(meta.categories.join(' · '))} · ${playersText(meta)}</div>
        </div>
      </div>
      <div class="help-body">
        ${h ? `
          <div class="help-goal">${escapeHtml(h.goal)}</div>
          <div class="help-sec">
            <div class="help-sec-title">진행</div>
            <ol class="help-steps">${h.steps.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ol>
          </div>
          ${h.tips && h.tips.length > 0 ? `
            <div class="help-sec">
              <div class="help-sec-title">알아둘 것</div>
              <ul class="help-tips">${h.tips.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
            </div>` : ''}
        ` : `<div class="help-goal">${escapeHtml(meta.description)}</div>
             <div class="help-none">아직 도움말을 안 적어둔 게임이에요</div>`}
      </div>
      <div class="confirm-actions">
        <button class="btn btn-primary" data-act="close">닫기</button>
      </div>
    </div>`;

  let settled = false;
  const close = (): void => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.add('is-out');
    window.setTimeout(() => overlay.remove(), 160);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); close(); }
  };

  overlay.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-act="close"]')) { close(); return; }
    if (e.target === overlay) close();
  });
  // capture 로 먼저 잡는다 — 게임 화면들이 document 에 ESC 핸들러를 걸어둬서
  // 도움말이 떠 있는 동안엔 그쪽으로 새어나가면 안 된다 (confirm.ts 와 같은 이유)
  document.addEventListener('keydown', onKey, true);

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  overlay.querySelector<HTMLButtonElement>('[data-act="close"]')?.focus();
}

/** 어디에나 붙이는 `?` 버튼 HTML. 누르면 호출부가 showGameHelp 를 연다 */
export function helpButtonHTML(id: string, title = '도움말'): string {
  return `<button type="button" class="help-btn" id="${id}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${
    icon('list', { size: 15, hue: '#2a9488' })}<span>도움말</span></button>`;
}
