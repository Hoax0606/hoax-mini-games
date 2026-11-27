/**
 * 게임 입력창에 포커스 주기 — **남이 치고 있으면 뺏지 않는다.**
 *
 * 왜:
 *   채팅을 치고 있는데 내 차례가 돌아오면 포커스가 게임 입력창으로 홱 튄다.
 *   그러면 치던 말이 그대로 게임 입력창에 들어가고, 엔터까지 누르면 엉뚱한 게
 *   제출된다 (라이어게임에서 설명을 잘못 내보내는 사고가 실제로 났다).
 *
 * 규칙은 하나다. **다른 글자 입력창에 포커스가 있으면 건드리지 않는다.**
 * 버튼이나 body 에 있으면 가져온다 — 그건 아무도 글을 쓰고 있지 않다는 뜻이다.
 */

type TextField = HTMLInputElement | HTMLTextAreaElement;

function isTyping(el: Element | null, target: TextField): boolean {
  if (!el || el === document.body || el === target) return false;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/**
 * 잠시 뒤 포커스를 준다 (화면을 다시 그린 직후라 엘리먼트가 막 붙은 경우가 많아 한 틱 쉰다).
 * 그 사이 사람이 채팅을 치기 시작했으면 그대로 둔다.
 */
export function focusSoon(el: TextField | null | undefined, delayMs = 10): void {
  if (!el) return;
  window.setTimeout(() => {
    if (isTyping(document.activeElement, el)) return;
    el.focus();
  }, delayMs);
}
