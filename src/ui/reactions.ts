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
    setOpen(false); // 고르면 다시 최소화
  });
}

/**
 * 화면 하단에 풍선 띄우기 (2.4s fade out + 자동 제거).
 * body 에 싱글톤 container(#reaction-stream) 가 없으면 자동 생성.
 */
export function showReactionBubble(emoji: string, nickname: string): void {
  let stream = document.getElementById('reaction-stream');
  if (!stream) {
    stream = document.createElement('div');
    stream.id = 'reaction-stream';
    stream.className = 'reaction-stream';
    document.body.appendChild(stream);
  }
  const el = document.createElement('div');
  el.className = 'reaction-bubble';
  el.innerHTML = `
    <span class="reaction-bubble-emoji">${emoji}</span>
    <span class="reaction-bubble-name">${escapeHtml(nickname)}</span>
  `;
  stream.appendChild(el);
  window.setTimeout(() => el.remove(), 2400);
}
