import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import { storage } from '../core/storage';
import { sound } from '../core/sound';

/**
 * 설정 화면
 * - 마스터 볼륨
 * - BGM on/off
 * - 효과음 on/off
 * - (닉네임은 메인 메뉴에서 바로 변경)
 */
export function createSettingsScreen(): Screen {
  return {
    render() {
      const settings = storage.getSettings();

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = `
        <button class="back-btn" id="back-btn" title="뒤로">←</button>

        <div class="card">
          <div class="card-title">⚙️ 설정</div>
          <div class="card-subtitle">사운드 설정을 조절해보세요</div>

          <div class="slider-row">
            <span class="slider-label">🔊 마스터 볼륨</span>
            <input type="range" class="slider" id="vol" min="0" max="100" value="${settings.masterVolume}" />
            <span class="slider-value" id="vol-val">${settings.masterVolume}</span>
          </div>

          <div class="toggle-row">
            <span class="toggle-label">🎵 배경음악 (BGM)</span>
            <div class="toggle ${settings.bgmEnabled ? 'on' : ''}" id="bgm-toggle"></div>
          </div>

          <div class="toggle-row">
            <span class="toggle-label">🔔 효과음 (SFX)</span>
            <div class="toggle ${settings.sfxEnabled ? 'on' : ''}" id="sfx-toggle"></div>
          </div>
        </div>
      `;

      // 뒤로가기
      el.querySelector('#back-btn')!.addEventListener('click', () => router.back());

      // 볼륨
      const volInput = el.querySelector<HTMLInputElement>('#vol')!;
      const volVal = el.querySelector<HTMLSpanElement>('#vol-val')!;
      volInput.addEventListener('input', () => {
        const v = Number(volInput.value);
        volVal.textContent = String(v);
        storage.setSettings({ masterVolume: v });
        // 즉시 반영: BGM masterGain 갱신 (재생 중이면 즉시 볼륨 변경됨).
        // SFX 는 매 play() 마다 storage 다시 읽으니 자동 반영.
        sound.refreshBgmSettings();
      });

      // BGM 토글
      const bgmToggle = el.querySelector<HTMLDivElement>('#bgm-toggle')!;
      bgmToggle.addEventListener('click', () => {
        const on = bgmToggle.classList.toggle('on');
        storage.setSettings({ bgmEnabled: on });
        sound.play('button_click');
        // 즉시 반영: OFF 면 현재 BGM 정지
        sound.refreshBgmSettings();
      });

      // SFX 토글
      const sfxToggle = el.querySelector<HTMLDivElement>('#sfx-toggle')!;
      sfxToggle.addEventListener('click', () => {
        const on = sfxToggle.classList.toggle('on');
        storage.setSettings({ sfxEnabled: on });
        // 켜는 순간 바로 피드백(끄는 순간에는 applySettings가 차단하므로 안 울림)
        if (on) sound.play('pop');
      });

      return el;
    },
  };
}
