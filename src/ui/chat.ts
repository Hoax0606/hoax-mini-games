/**
 * 채팅 사이드패널
 *
 * 사용처: 대기실 / 게임 화면 / 결과 화면 — 같은 패턴.
 *   1. buildChatPanelHTML() 결과를 screen el 끝에 박는다.
 *   2. wireChatPanel(el, { onSend }) 로 입력 핸들러 연결.
 *   3. 메시지 수신/송신 시 appendChatMessage(el, msg, isMe) 로 stream 에 한 줄 추가.
 *
 * 네트워크 모델 (호스트 = 허브):
 *   - 게스트가 보내면 host 에게만 송신. 호스트가 자기 화면 append + 다른 게스트 relay.
 *   - 호스트가 보내면 자기 화면 append + 전체 broadcast.
 *   - 자기 메시지는 네트워크 echo 가 없으므로 송신 시점에 직접 append.
 */

import type { ChatMsg } from '../games/types';

/** 한 사람이 1초에 보낼 수 있는 최대 메시지 수 (스팸 방어) */
const SEND_COOLDOWN_MS = 250;
/** 본문 최대 길이 — 너무 길면 잘림 */
const MAX_TEXT_LEN = 200;
/** stream 에 유지할 최대 메시지 수 (오래된 건 제거) */
const MAX_STREAM_ROWS = 100;

// ============================================
// 채팅 히스토리 — 화면 전환 시에도 같은 방에 있으면 유지
// ============================================
//
// 매 화면(대기실/게임화면/결과화면) 진입 시 chat-stream DOM 은 새로 그려지지만,
// 메시지들은 이 모듈 레벨 배열에 누적되어 있어 restoreChatHistory 로 복원 가능.
// 방을 떠날 때(메뉴 복귀/연결 끊김) clearChatHistory 로 초기화.

interface StoredChatMsg {
  msg: ChatMsg;
  isMe: boolean;
  /** 시스템 메시지(입장/퇴장)인지 — true 면 msg.nickname 사용 안 함 */
  system?: boolean;
}

const chatHistory: StoredChatMsg[] = [];

/** 방 떠날 때(메뉴/연결 끊김) 호출해서 히스토리 비움. */
export function clearChatHistory(): void {
  chatHistory.length = 0;
}

/** 화면 진입 후 buildChatPanelHTML 을 박은 직후 호출 — 기존 히스토리 전부 다시 그려줌. */
export function restoreChatHistory(parent: HTMLElement): void {
  for (const item of chatHistory) {
    if (item.system) {
      renderSystemRow(parent, item.msg.text);
    } else {
      renderMessageRow(parent, item.msg, item.isMe);
    }
  }
  const stream = parent.querySelector<HTMLDivElement>('#chat-stream');
  if (stream) stream.scrollTop = stream.scrollHeight;
}

export function buildChatPanelHTML(): string {
  return `
    <aside class="chat-panel" id="chat-panel">
      <button class="chat-collapsed-btn" id="chat-collapsed-btn" type="button"
              aria-label="채팅 열기" title="채팅 열기">💬</button>
      <div class="chat-header">
        <span class="chat-title">💬 채팅</span>
        <button class="chat-toggle" id="chat-toggle" type="button"
                aria-label="접기" title="접기">▾</button>
      </div>
      <div class="chat-stream" id="chat-stream"></div>
      <form class="chat-form" id="chat-form" autocomplete="off">
        <input type="text" class="chat-input" id="chat-input"
               placeholder="메시지 입력 후 Enter" maxlength="${MAX_TEXT_LEN}" />
        <button type="submit" class="chat-send-btn" aria-label="보내기" title="보내기">↑</button>
      </form>
    </aside>
  `;
}

export interface ChatCallbacks {
  /** 사용자가 입력 후 Enter — 트림된 본문이 비어있지 않을 때만 호출됨 */
  onSend: (text: string) => void;
}

/**
 * 채팅 패널 와이어링. 반환값은 cleanup 함수 (화면 dispose 시 호출 권장).
 */
export function wireChatPanel(parent: HTMLElement, callbacks: ChatCallbacks): () => void {
  const panel = parent.querySelector<HTMLElement>('#chat-panel');
  const form = parent.querySelector<HTMLFormElement>('#chat-form');
  const input = parent.querySelector<HTMLInputElement>('#chat-input');
  const toggle = parent.querySelector<HTMLButtonElement>('#chat-toggle');
  const expander = parent.querySelector<HTMLButtonElement>('#chat-collapsed-btn');
  if (!panel || !form || !input || !toggle || !expander) return () => {};

  // 같은 방에 머무는 동안 화면 전환되어도 채팅이 유지되도록, 직전에 쌓인 히스토리 복원.
  // clearChatHistory 는 메뉴 복귀 시점에 호출되므로 새 방에 들어가면 빈 상태로 시작.
  restoreChatHistory(parent);

  let lastSentAt = 0;

  const onSubmit = (e: Event): void => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastSentAt < SEND_COOLDOWN_MS) return;
    const text = input.value.trim().slice(0, MAX_TEXT_LEN);
    if (!text) return;
    lastSentAt = now;
    callbacks.onSend(text);
    input.value = '';
  };

  const collapse = (): void => {
    panel.classList.add('is-collapsed');
  };
  const expand = (): void => {
    panel.classList.remove('is-collapsed');
    // 펼치면 마지막 메시지로 스크롤
    const stream = parent.querySelector<HTMLDivElement>('#chat-stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  };

  form.addEventListener('submit', onSubmit);
  toggle.addEventListener('click', collapse);
  expander.addEventListener('click', expand);

  return () => {
    form.removeEventListener('submit', onSubmit);
    toggle.removeEventListener('click', collapse);
    expander.removeEventListener('click', expand);
  };
}

/**
 * 메시지 한 줄을 stream 에 추가하고 자동 스크롤.
 * isMe=true 면 우측 정렬 + 핑크 톤으로 자기 메시지 강조.
 *
 * 히스토리에도 push 해서 화면 전환 후 restoreChatHistory 로 복원 가능.
 */
export function appendChatMessage(parent: HTMLElement, msg: ChatMsg, isMe: boolean): void {
  chatHistory.push({ msg, isMe });
  trimHistory();
  renderMessageRow(parent, msg, isMe);
}

/** 누가 입장/퇴장했음을 시스템 메시지로 표시 (회색 가운데 정렬) */
export function appendChatSystemMessage(parent: HTMLElement, text: string): void {
  // 시스템 메시지는 nickname 필드 사용 안 하지만 ChatMsg 타입 맞춰서 dummy 채움
  const sysMsg: ChatMsg = { type: 'chat', peerId: '', nickname: '', text, timestamp: Date.now() };
  chatHistory.push({ msg: sysMsg, isMe: false, system: true });
  trimHistory();
  renderSystemRow(parent, text);
}

function trimHistory(): void {
  while (chatHistory.length > MAX_STREAM_ROWS) {
    chatHistory.shift();
  }
}

/** DOM 한 줄 추가 (히스토리 갱신 없이) — 메시지 / 히스토리 복원 둘 다에서 사용 */
function renderMessageRow(parent: HTMLElement, msg: ChatMsg, isMe: boolean): void {
  const stream = parent.querySelector<HTMLDivElement>('#chat-stream');
  if (!stream) return;

  const row = document.createElement('div');
  row.className = `chat-row${isMe ? ' is-me' : ''}`;
  row.innerHTML = `
    <div class="chat-row-nick">${escapeText(msg.nickname)}</div>
    <div class="chat-row-bubble">${escapeText(msg.text)}</div>
  `;
  stream.appendChild(row);

  while (stream.children.length > MAX_STREAM_ROWS) {
    stream.removeChild(stream.firstChild!);
  }

  // 사용자가 거의 맨 아래를 보고 있을 때만 자동 스크롤
  const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
  if (nearBottom || isMe) {
    stream.scrollTop = stream.scrollHeight;
  }
}

function renderSystemRow(parent: HTMLElement, text: string): void {
  const stream = parent.querySelector<HTMLDivElement>('#chat-stream');
  if (!stream) return;
  const row = document.createElement('div');
  row.className = 'chat-row is-system';
  row.textContent = text;
  stream.appendChild(row);
  while (stream.children.length > MAX_STREAM_ROWS) {
    stream.removeChild(stream.firstChild!);
  }
  stream.scrollTop = stream.scrollHeight;
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
