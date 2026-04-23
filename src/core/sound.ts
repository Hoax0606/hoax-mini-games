/**
 * 사운드 매니저 — Web Audio API 기반 SFX 합성
 *
 * 왜 합성(합성음)?
 *   외부 오디오 파일 없이 oscillator/noise로 즉석 생성.
 *   의존성·에셋 없이 즉시 동작하고, 나중에 실제 CC0 파일로 교체하기도 쉬움.
 *
 * 설정 반영:
 *   play() 호출마다 storage.getSettings()를 참조해 sfxEnabled 여부와
 *   masterVolume을 실시간 적용. 설정 화면에서 바꾸면 다음 play부터 즉시 반영됨.
 *
 * 자동 초기화:
 *   브라우저 정책상 AudioContext는 사용자 interaction 후에만 활성화된다.
 *   첫 click/keydown을 받아 생성 + resume.
 *
 * BGM:
 *   아직 미구현. 설정 토글(`bgmEnabled`)은 저장만 되고 실제 재생은 없음.
 *   추후 실제 BGM 파일 추가 시 이 파일에 `playBgm / stopBgm` 붙일 예정.
 */

import { storage } from './storage';

export type SfxId =
  | 'mallet_hit'    // 말렛과 퍽 충돌
  | 'wall_hit'      // 벽 충돌
  | 'goal'          // 골 득점
  | 'button_click'  // 버튼 클릭
  | 'pop';          // 끼임 리셋 등 짧은 알림음

class SoundManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  constructor() {
    // 사용자 interaction 이후에 AudioContext 만들 수 있음 (브라우저 정책)
    const unlock = (): void => this.ensureInit();
    document.addEventListener('click', unlock);
    document.addEventListener('keydown', unlock);
  }

  private ensureInit(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.7;
    this.masterGain.connect(this.ctx.destination);
  }

  /** storage에서 최신 설정 읽어 마스터 게인에 반영. SFX off면 false 반환 */
  private applySettings(): boolean {
    const settings = storage.getSettings();
    if (!settings.sfxEnabled) return false;
    if (this.masterGain) {
      this.masterGain.gain.value = settings.masterVolume / 100;
    }
    return true;
  }

  /**
   * 효과음 재생.
   * @param id 사운드 종류
   * @param options.intensity 0~1, 일부 사운드(말렛 충돌)의 피치/볼륨 조절용
   */
  play(id: SfxId, options: { intensity?: number } = {}): void {
    this.ensureInit();
    if (!this.ctx || !this.masterGain) return;
    if (!this.applySettings()) return;

    switch (id) {
      case 'mallet_hit':   this.playMalletHit(options.intensity ?? 0.5); break;
      case 'wall_hit':     this.playWallHit(); break;
      case 'goal':         this.playGoal(); break;
      case 'button_click': this.playButtonClick(); break;
      case 'pop':          this.playPop(); break;
    }
  }

  // ============================================
  // 개별 합성 함수들 — Web Audio의 oscillator/noise 조합
  // ============================================

  /** 말렛 충돌: "탁" — 세기에 따라 피치/볼륨 변화 */
  private playMalletHit(intensity: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(220 + intensity * 260, now);
    osc.frequency.exponentialRampToValueAtTime(85, now + 0.08);

    const peak = 0.16 + intensity * 0.14;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

    osc.connect(gain).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  /** 벽 충돌: 짧은 저역 노이즈 — "퉁" 둔탁한 느낌 */
  private playWallHit(): void {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * 0.08);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      // 노이즈 샘플 생성 + 지수 감쇠 envelope
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.22));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0.13;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 550;
    src.connect(lp).connect(gain).connect(this.masterGain!);
    src.start();
  }

  /** 골: C5 → E5 → G5 삼화음 아르페지오 */
  private playGoal(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + i * 0.09;
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.2, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  }

  /** 버튼 클릭: 짧고 높은 핀 */
  private playButtonClick(): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900, now);
    osc.frequency.exponentialRampToValueAtTime(450, now + 0.05);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    osc.connect(gain).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  /** 일반 pop (끼임 리셋 등) */
  private playPop(): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.08);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.1, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.15);
  }
}

export const sound = new SoundManager();
