/**
 * 브라우저 "뒤로 가기" 가드
 *
 * 왜 필요한가:
 *   이 앱은 SPA 인데 화면 전환에 브라우저 history 를 전혀 안 쓴다(router 가 자체 배열로 관리).
 *   그래서 뒤로 가기 = 곧 "사이트 이탈"이고, peer.ts 의 pagehide 핸들러가 Peer 를 전부
 *   destroy 해버려서 방이 통째로 날아간다.
 *   뒤로 가기는 생각보다 쉽게 눌린다 — 마우스 옆 버튼, Alt+←, 그리고 일부 환경(Firefox 의
 *   browser.backspace_action=0 등)에선 빈 입력창에서의 백스페이스까지.
 *   실제로 "결과 화면 채팅에서 백스페이스 누르다 방에서 튕겼다"는 제보가 이 경로였다.
 *
 * 어떻게 막는가:
 *   방 연결이 살아있는 동안 더미 history 엔트리를 하나 쌓아둔다.
 *   뒤로 가기를 누르면 그 더미가 먼저 소모되면서 popstate 가 뜨고(= 사이트는 안 떠남),
 *   여기서 가로채 확인을 받는다.
 *     - 나간다 → 사이트를 떠나는 대신 앱 안에서 메뉴로 복귀(연결 정리는 화면 dispose 가 함)
 *     - 취소   → 더미를 다시 쌓아 제자리로
 *   엔트리는 최대 1개만 유지한다(history.state 로 우리가 쌓은 건지 확인).
 */

/** 우리가 쌓은 더미 엔트리인지 구분하는 표식 */
interface GuardState {
  hoaxBackGuard?: boolean;
}

/** 살아있는 방 연결이 있는지 — peer.ts 가 갱신해준다 */
let roomActive = false;
let onLeaveRoom: (() => void) | null = null;

function isGuardEntry(): boolean {
  return (history.state as GuardState | null)?.hoaxBackGuard === true;
}

function pushGuardEntry(): void {
  if (isGuardEntry()) return; // 이미 쌓여있으면 중복으로 쌓지 않는다
  history.pushState({ hoaxBackGuard: true } satisfies GuardState, '', location.href);
}

/**
 * 앱 시작 시 1회 호출.
 * @param onLeave 사용자가 "나간다"를 선택했을 때 실행할 동작(메뉴 복귀)
 */
export function installBackGuard(onLeave: () => void): void {
  onLeaveRoom = onLeave;
  window.addEventListener('popstate', () => {
    // 방 밖(메뉴/닉네임 등)에선 평소처럼 뒤로 가기를 허용한다.
    if (!roomActive) return;
    if (window.confirm('뒤로 가면 방에서 나가게 돼요. 나갈까요?')) {
      roomActive = false;
      onLeaveRoom?.();
      return;
    }
    pushGuardEntry();
  });
}

/**
 * 방 연결 상태 변화 알림 — peer.ts 의 Peer 등록/해제 시점에 호출된다.
 * 켜질 때 더미 엔트리를 쌓아두고, 꺼질 때는 굳이 걷어내지 않는다
 * (걷어내려면 history.back() 을 또 불러야 해서 오히려 꼬인다. 남아있어도 해는 없다).
 */
export function setRoomActive(active: boolean): void {
  roomActive = active;
  if (active) pushGuardEntry();
}
