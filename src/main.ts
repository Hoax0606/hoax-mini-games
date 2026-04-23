import './ui/theme.css';
import { router } from './core/screen';
import { storage } from './core/storage';
import { sound } from './core/sound';
import { createNicknameScreen } from './screens/nickname';
import { createMenuScreen } from './screens/menu';

const app = document.getElementById('app');
if (!app) throw new Error('#app 요소를 찾을 수 없습니다');

router.mount(app);

// 모든 .btn 클래스 버튼에 클릭 사운드 자동 연결 (이벤트 위임).
// 개별 화면이 일일이 호출할 필요 없이 여기 한 곳에서.
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest('.btn')) sound.play('button_click');
});

// 닉네임이 있으면 바로 메인 메뉴로, 없으면 닉네임 입력 먼저
if (storage.hasNickname()) {
  router.reset(() => createMenuScreen());
} else {
  router.reset(() => createNicknameScreen());
}
