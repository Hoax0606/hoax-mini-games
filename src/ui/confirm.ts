/**
 * 공용 확인 모달 — `window.confirm` 대체.
 *
 * 왜:
 *   네이티브 confirm 은 브라우저 크롬이 그려서 사이트 톤과 완전히 겉돈다(주소까지 같이 뜸).
 *   버튼 글자도 "확인/취소" 로 고정이라 "나가기" 같은 행동 이름을 못 쓴다.
 *
 * 쓰는 법:
 *   if (await showConfirm({ message: '방을 나가시겠어요?', confirmLabel: '나가기' })) { ... }
 *
 * 주의: Promise 라서 호출부가 async 가 돼야 한다. 브라우저 네비게이션을 동기로 막아야 하는
 * 자리(backGuard 의 popstate)에서는 네이티브 confirm 을 그대로 둔다 — 거기선 비동기로
 * 물어보는 사이에 사용자가 뒤로 가기를 또 눌러 사이트를 떠날 수 있다.
 */

import { icon } from './icons';
import { escapeHtml } from './escape';

interface ConfirmOpts {
  /** 본문. 줄바꿈(\n)은 그대로 반영된다 */
  message: string;
  /** 굵은 제목. 없으면 본문만 */
  title?: string;
  /** 확인 버튼 글자. 기본 '확인' */
  confirmLabel?: string;
  /** 취소 버튼 글자. 기본 '취소' */
  cancelLabel?: string;
  /** 되돌릴 수 없는 행동이면 true — 확인 버튼이 빨강이 된다 */
  danger?: boolean;
}

export function showConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-card" role="dialog" aria-modal="true">
        <div class="confirm-icon">${icon(opts.danger ? 'bell' : 'chat', { size: 26 })}</div>
        ${opts.title ? `<div class="confirm-title">${escapeHtml(opts.title)}</div>` : ''}
        <div class="confirm-message">${escapeHtml(opts.message)}</div>
        <div class="confirm-actions">
          <button class="btn btn-secondary" data-act="cancel">${escapeHtml(opts.cancelLabel ?? '취소')}</button>
          <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(opts.confirmLabel ?? '확인')}</button>
        </div>
      </div>`;

    let settled = false;
    const close = (ok: boolean): void => {
      if (settled) return; // ESC + 클릭이 겹쳐도 한 번만
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.classList.add('is-out');
      window.setTimeout(() => overlay.remove(), 160);
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      if (e.key === 'Enter') { e.stopPropagation(); close(true); }
    };

    overlay.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset['act'];
      if (act) { close(act === 'ok'); return; }
      if (e.target === overlay) close(false); // 바깥 클릭 = 취소
    });
    // capture 로 먼저 잡는다 — 게임 화면들이 document 에 ESC 핸들러를 걸어둬서
    // 모달이 떠 있는 동안엔 그쪽으로 새어나가면 안 된다.
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-in'));
    overlay.querySelector<HTMLButtonElement>('[data-act="ok"]')?.focus();
  });
}
