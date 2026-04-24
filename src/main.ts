import './ui/theme.css';
import { router } from './core/screen';
import { storage } from './core/storage';
import { sound } from './core/sound';
import { createNicknameScreen } from './screens/nickname';
import { createMenuScreen } from './screens/menu';
import { createJoinRoomScreen } from './screens/joinRoom';

const app = document.getElementById('app');
if (!app) throw new Error('#app 요소를 찾을 수 없습니다');

router.mount(app);

// 로딩 splash(index.html inline) 페이드아웃 — JS 번들 로드 완료 + 라우터 마운트 직후
// body 에 클래스 추가하면 CSS transition 으로 자연스럽게 사라짐 (0.4s).
document.body.classList.add('splash-hidden');
// 완전히 사라진 후 DOM 에서 제거 (접근성 — invisible이어도 reader에 읽힘 방지)
window.setTimeout(() => {
  const splash = document.getElementById('splash');
  splash?.remove();
}, 500);

// 모든 .btn 클래스 버튼에 클릭 사운드 자동 연결 (이벤트 위임).
// 개별 화면이 일일이 호출할 필요 없이 여기 한 곳에서.
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest('.btn')) sound.play('button_click');
});

// ============================================
// URL 방 코드 자동 입장 (?room=PK4M9)
// ============================================
// 친구가 "🔗 링크" 공유받은 뒤 접속하면 자동으로 해당 방 참여 플로우로.
// - 닉네임 있으면: joinRoom + autoJoin (즉시 connect 시도)
// - 닉네임 없으면: 닉네임 입력 후 같은 플로우

function getRoomFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('room');
  if (!raw) return null;
  // PeerJS 알파벳과 동일: 대문자 영숫자 5자
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length === 5 ? cleaned : null;
}

function clearRoomFromUrl(): void {
  // 새로고침 시 재입장 루프 방지를 위해 URL에서 room 파라미터 제거
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  history.replaceState({}, '', url.toString());
}

const urlRoomCode = getRoomFromUrl();

if (urlRoomCode) {
  clearRoomFromUrl();
  const startJoin = (): void => {
    router.reset(() =>
      createJoinRoomScreen('', { initialCode: urlRoomCode, autoJoin: true }),
    );
  };
  if (storage.hasNickname()) {
    startJoin();
  } else {
    // 닉네임 입력 끝나면 자동으로 join 진행
    router.reset(() => createNicknameScreen({ onDone: startJoin }));
  }
} else if (storage.hasNickname()) {
  router.reset(() => createMenuScreen());
} else {
  router.reset(() => createNicknameScreen());
}
