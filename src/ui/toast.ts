/**
 * 공용 토스트 알림.
 *
 * 왜 모았나:
 *   예전엔 화면마다 자기 토스트를 들고 있었다 — 대기실의 `#toast` 와 브루마블의
 *   `.bm-cardtoast`. 모양이 제각각인 데다, 대기실 쪽은 엘리먼트 하나를 재사용해서
 *   알림이 연달아 뜨면 앞엣것이 그냥 덮어써졌다(입장 + 복사가 겹치면 하나만 보임).
 *
 * 어떻게:
 *   - 컨테이너는 처음 호출될 때 body 에 한 번만 만든다. 화면이 바뀌어도 살아있다.
 *   - 여러 개면 아래에서 위로 쌓는다. MAX 를 넘으면 가장 오래된 것부터 걷어낸다.
 *   - kind 로 색과 기본 아이콘이 정해진다 — 의미가 색으로 드러나게.
 *     (성공=민트 / 경고=주황 / 정보=청록. CLAUDE.md 의 "경고를 핑크로 쓰지 말 것" 규약)
 */

import { icon } from './icons';

export type ToastKind = 'info' | 'success' | 'warn';

interface ToastOpts {
  /** 색·기본 아이콘을 정한다. 기본 info */
  kind?: ToastKind;
  /** 기본 아이콘 대신 쓸 아이콘 이름(icons.ts 의 키). 빈 문자열이면 아이콘 없음 */
  icon?: string;
  /** 표시 시간(ms). 기본 2400 */
  ms?: number;
}

/**
 * 동시에 "보이는" 최대 개수. 넘치는 건 버리지 않고 대기열에 넣었다가 자리가 나면 띄운다.
 * 처음엔 넘치면 오래된 것부터 걷어냈는데, 그러면 한꺼번에 여러 일이 생겼을 때
 * 맨 처음 알림을 아무도 못 본다. 알림은 밀릴 수는 있어도 사라지면 안 된다.
 */
const MAX = 3;
/** 사라지는 모션 길이. CSS 의 transition 과 맞춰야 한다 */
const EXIT_MS = 220;

const DEFAULT_ICON: Record<ToastKind, string> = {
  info: 'bell',
  success: 'check',
  warn: 'bell',
};

let stack: HTMLDivElement | null = null;
/** 자리가 없어 아직 못 띄운 것들. 버리지 않고 여기서 기다린다 */
const queue: { text: string; opts: ToastOpts }[] = [];
/** 지금 화면에 떠 있는 개수 (사라지는 중인 건 제외 — 자리를 바로 내준다) */
let live = 0;

function ensureStack(): HTMLDivElement {
  if (stack?.isConnected) return stack;
  stack = document.createElement('div');
  stack.className = 'toast-stack';
  document.body.appendChild(stack);
  return stack;
}

function dismiss(el: HTMLElement): void {
  if (el.classList.contains('is-out')) return; // 타이머가 두 번 돌아도 안전하게
  el.classList.add('is-out');
  live--;
  window.setTimeout(() => el.remove(), EXIT_MS);
  pump(); // 비워진 자리에 대기열의 다음 것
}

/** 자리가 있으면 대기열에서 꺼내 띄운다 */
function pump(): void {
  while (live < MAX && queue.length > 0) render(queue.shift()!);
}

function render({ text, opts }: { text: string; opts: ToastOpts }): void {
  const kind = opts.kind ?? 'info';
  const iconName = opts.icon ?? DEFAULT_ICON[kind];
  const root = ensureStack();

  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  // 아이콘은 icon() 이 만든 신뢰 가능한 HTML, 본문은 닉네임이 섞일 수 있으니 textContent 로.
  if (iconName) el.innerHTML = icon(iconName, { size: 17 });
  const span = document.createElement('span');
  span.className = 'toast-text';
  span.textContent = text;
  el.appendChild(span);

  root.appendChild(el);
  live++;
  // 다음 프레임에 is-in 을 붙여야 등장 트랜지션이 먹는다(붙자마자 주면 시작 상태가 없음)
  requestAnimationFrame(() => el.classList.add('is-in'));
  window.setTimeout(() => dismiss(el), opts.ms ?? 2400);
}

/**
 * 토스트 한 개 띄우기. 많이 몰려도 사라지지 않고 순서대로 다 나온다.
 *
 * @example showToast('링크를 복사했어요', { kind: 'success', icon: 'link' })
 */
export function showToast(text: string, opts: ToastOpts = {}): void {
  queue.push({ text, opts });
  pump();
}
