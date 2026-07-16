/**
 * 재연결 오버레이 — 게스트 연결이 일시적으로 끊겼을 때 화면 위에 잠깐 띄운다.
 *
 * peer.ts 의 GuestSession 이 끊김을 감지하면 유예 시간 동안 재연결을 시도하는데,
 * 그 사이 사용자에게 "튕긴 게 아니라 재연결 중"임을 알려 불안감을 줄인다.
 * 성공하면 hide, 끝내 실패하면 호출부가 기존처럼 "방장이 나갔어요" 안내를 한다.
 *
 * body 에 단 하나만 존재(중복 호출 안전). 화면 전환과 무관하게 전역으로 뜬다.
 */
let overlayEl: HTMLDivElement | null = null;

export function showReconnectOverlay(message = '연결이 불안정해요. 재연결 중'): void {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.className = 'reconnect-overlay';
  overlayEl.innerHTML = `
    <div class="reconnect-box">
      <div class="reconnect-spinner"></div>
      <div class="reconnect-msg">${message}</div>
      <div class="reconnect-sub">잠깐만 기다려 주세요</div>
    </div>
  `;
  document.body.appendChild(overlayEl);
}

export function hideReconnectOverlay(): void {
  overlayEl?.remove();
  overlayEl = null;
}
