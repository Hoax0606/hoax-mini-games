/**
 * 이모지 반응 UI 공통 유틸 — 대기실 / 게임 화면 / 결과 화면에서 재사용.
 *
 * 제공하는 것:
 *   1. 이모지 버튼 바 HTML (인라인 .reaction-bar)
 *   2. 하단 풍선 스트림 영역 HTML (position: fixed)
 *   3. 클릭 이벤트 배선 (스팸 방지 throttle 포함)
 *   4. 원격 반응 수신 시 풍선 띄우기
 *
 * 풍선은 body 에 항상 고정 위치로 뜨는 div("#reaction-stream") 를 공유.
 * 없으면 자동 생성. 화면 전환 시에도 유지 (main.ts 레벨 싱글톤).
 */

import { escapeHtml } from './escape';

export const REACTION_EMOJIS = [
  '👍', '👏', '🔥', '🎉', '💯', '✨', '🏆', '💪',
  '😂', '🤣', '😍', '🥰', '🤩', '😎', '🥳', '😏',
  '🤔', '😅', '😳', '😱', '🤯', '😴', '🙄', '😤',
  '😭', '🥺', '😢', '😡', '🫢', '🙏', '❤️', '💖',
  '👀', '👋', '🤝', '⚡', '🌟', '🍀', '🎯', '😇',
] as const;
export type ReactionEmoji = typeof REACTION_EMOJIS[number];

/**
 * 이모지 버튼 바 HTML 반환.
 *
 * 최소화(접힘) 기본: 평소엔 😊 토글 버튼 하나만 보이고, 누르면 전체 이모지 목록이 펼쳐진다.
 * 이모지 하나 고르면 다시 접힘. 대기실(인라인) / 게임화면(좌하단 고정) 양쪽에서 같은 마크업 사용.
 */
export function buildReactionBarHTML(): string {
  return `
    <div class="reaction-bar" data-reaction-bar>
      <button class="reaction-toggle" data-reaction-toggle title="반응 보내기" aria-expanded="false">😊</button>
      <div class="reaction-picker">
        ${REACTION_EMOJIS.map((e) => `
          <button class="reaction-btn" data-emoji="${e}" title="반응 ${e}">${e}</button>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * 버튼 클릭 이벤트 배선.
 * @param container 위 HTML 을 포함한 부모 요소 (예: 대기실 카드)
 * @param onEmoji   버튼 눌렀을 때 호출. 이미 throttle 로 필터링됨.
 * @param throttleMs 기본 400ms — 스팸 연타 방지
 */
export function wireReactionBar(
  container: HTMLElement,
  onEmoji: (emoji: string) => void,
  throttleMs = 400,
): void {
  let lastAt = 0;
  const bar = container.querySelector<HTMLElement>('[data-reaction-bar]');
  const toggle = container.querySelector<HTMLButtonElement>('[data-reaction-toggle]');

  // 바깥 클릭 시 접기 — 펼쳐진 동안에만 document 리스너를 붙였다 떼어 누수 방지.
  const onDocClick = (e: MouseEvent): void => {
    if (!bar?.classList.contains('is-open')) return;
    const t = e.target as Node | null;
    if (t && !bar.contains(t)) setOpen(false);
  };
  const setOpen = (open: boolean): void => {
    bar?.classList.toggle('is-open', open);
    toggle?.setAttribute('aria-expanded', String(open));
    if (open) document.addEventListener('click', onDocClick);
    else document.removeEventListener('click', onDocClick);
  };

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;

    // 토글 버튼 — 목록 펼치기/접기 (throttle 대상 아님)
    if (target?.closest('[data-reaction-toggle]')) {
      setOpen(!bar?.classList.contains('is-open'));
      return;
    }

    // 이모지 버튼 — 반응 전송 후 접기
    const btn = target?.closest<HTMLButtonElement>('.reaction-btn');
    if (!btn) return;
    const now = performance.now();
    if (now - lastAt < throttleMs) return;
    lastAt = now;
    const emoji = btn.dataset.emoji;
    if (emoji) onEmoji(emoji);
    // 이모지를 골라도 창은 유지 — 연속으로 여러 개 보낼 수 있게.
    // 닫기는 토글 버튼 or 바깥 클릭(onDocClick)으로만.
  });
}

/**
 * 게임화면의 떠있는 반응 바(.reaction-bar-floating)를 드래그로 옮길 수 있게 한다.
 * 위치는 localStorage 에 저장 → 다음에도 그 자리. 게임 HUD 와 겹칠 때 치워두는 용도.
 *
 * 클릭 vs 드래그 구분: 6px 이상 움직이면 드래그로 보고, 놓을 때 그 클릭이
 * 토글(이모지 열기)로 새지 않게 막는다. 안 움직이면 평소처럼 토글 동작.
 */
const REACTION_POS_KEY = 'hoax_reaction_pos';

export function makeReactionBarDraggable(floating: HTMLElement): void {
  applySavedPos(floating);

  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, originLeft = 0, originTop = 0;

  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 6) { moved = true; floating.classList.add('is-dragging'); }
    if (!moved) return;
    const left = clamp(originLeft + dx, 4, window.innerWidth - floating.offsetWidth - 4);
    const top = clamp(originTop + dy, 4, window.innerHeight - floating.offsetHeight - 4);
    floating.style.left = `${left}px`;
    floating.style.top = `${top}px`;
  };
  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (moved) {
      floating.classList.remove('is-dragging');
      savePos(floating);
      // 이 드래그의 마무리 클릭이 토글로 새지 않게 한 번만 차단 (capture 단계)
      const block = (ev: Event): void => { ev.stopPropagation(); ev.preventDefault(); };
      floating.addEventListener('click', block, { capture: true, once: true });
    }
  };
  floating.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    const rect = floating.getBoundingClientRect();
    originLeft = rect.left; originTop = rect.top;
    // bottom/left 앵커 대신 left/top 절대값으로 고정
    floating.style.left = `${originLeft}px`;
    floating.style.top = `${originTop}px`;
    floating.style.right = 'auto';
    floating.style.bottom = 'auto';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function applySavedPos(floating: HTMLElement): void {
  try {
    const raw = localStorage.getItem(REACTION_POS_KEY);
    if (!raw) return;
    const pos = JSON.parse(raw) as { x: number; y: number };
    if (typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
    // 저장 당시보다 화면이 작아졌어도 안 보이는 곳으로 안 가게 클램프
    const w = floating.offsetWidth || 44;
    const h = floating.offsetHeight || 44;
    floating.style.left = `${clamp(pos.x, 4, window.innerWidth - w - 4)}px`;
    floating.style.top = `${clamp(pos.y, 4, window.innerHeight - h - 4)}px`;
    floating.style.right = 'auto';
    floating.style.bottom = 'auto';
  } catch { /* 무시 */ }
}

function savePos(floating: HTMLElement): void {
  try {
    const rect = floating.getBoundingClientRect();
    localStorage.setItem(REACTION_POS_KEY, JSON.stringify({ x: rect.left, y: rect.top }));
  } catch { /* 무시 */ }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 화면 하단에 풍선 띄우기 (2.4s fade out + 자동 제거).
 * body 에 싱글톤 container(#reaction-stream) 가 없으면 자동 생성.
 */
export function showReactionBubble(emoji: string, nickname: string): void {
  // 원격 피어가 보낸 emoji 는 신뢰 불가 — 허용 목록에 없으면 무시(XSS 방지).
  //   (조작된 reaction 메시지로 innerHTML 에 스크립트가 주입되던 취약점 차단)
  if (!(REACTION_EMOJIS as readonly string[]).includes(emoji)) return;

  let stream = document.getElementById('reaction-stream');
  if (!stream) {
    stream = document.createElement('div');
    stream.id = 'reaction-stream';
    stream.className = 'reaction-stream';
    document.body.appendChild(stream);
  }
  const el = document.createElement('div');
  el.className = 'reaction-bubble';
  // emoji 는 위에서 화이트리스트 통과분이지만, 이중 방어로 escape 까지 적용
  el.innerHTML = `
    <span class="reaction-bubble-emoji">${escapeHtml(emoji)}</span>
    <span class="reaction-bubble-name">${escapeHtml(nickname)}</span>
  `;
  stream.appendChild(el);
  window.setTimeout(() => el.remove(), 2400);
}
