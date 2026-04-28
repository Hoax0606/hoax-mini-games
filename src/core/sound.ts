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
 *   bgm.ts 의 BgmPlayer 가 담당. 여기선 `startBgm(id)` / `stopBgm()` 로 래퍼만 노출해
 *   게임 모듈이 `sound.startBgm('apple-game')` 처럼 한 곳에서 다 접근 가능하게 한다.
 */

import { storage } from './storage';
import { bgm, type BgmId } from './bgm';

export type SfxId =
  | 'mallet_hit'        // 말렛과 퍽 충돌
  | 'wall_hit'          // 벽 충돌
  | 'goal'              // 골 득점
  | 'button_click'      // 버튼 클릭
  | 'pop'               // 끼임 리셋 등 짧은 알림음
  // --- 배틀 테트리스 ---
  | 'tetris_rotate'     // 피스 회전
  | 'tetris_lock'       // 피스 고정
  | 'tetris_harddrop'   // 하드드롭 (스페이스)
  | 'tetris_hold'       // 홀드 스왑
  | 'tetris_clear'      // 1~3줄 클리어
  | 'tetris_tetris'     // 4줄 동시 클리어 (화려)
  | 'tetris_garbage'    // 가비지 수신 (내 필드에 쌓임)
  | 'tetris_topout';    // 탑아웃 (게임오버)

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
      case 'mallet_hit':      this.playMalletHit(options.intensity ?? 0.5); break;
      case 'wall_hit':        this.playWallHit(); break;
      case 'goal':            this.playGoal(); break;
      case 'button_click':    this.playButtonClick(); break;
      case 'pop':             this.playPop(); break;
      case 'tetris_rotate':   this.playTetrisRotate(); break;
      case 'tetris_lock':     this.playTetrisLock(); break;
      case 'tetris_harddrop': this.playTetrisHardDrop(); break;
      case 'tetris_hold':     this.playTetrisHold(); break;
      case 'tetris_clear':    this.playTetrisClear(); break;
      case 'tetris_tetris':   this.playTetrisTetris(); break;
      case 'tetris_garbage':  this.playTetrisGarbage(); break;
      case 'tetris_topout':   this.playTetrisTopout(); break;
    }
  }

  // ============================================
  // BGM 래퍼 — bgm.ts 에 위임
  // ============================================

  /**
   * 게임별 BGM 재생 시작. 이미 같은 id 면 무시, 다른 id 면 자동 교체.
   * bgmEnabled=false 설정이면 no-op.
   */
  startBgm(id: BgmId): void {
    bgm.start(id);
  }

  /** BGM 정지. 게임 모듈의 destroy 에서 호출. */
  stopBgm(): void {
    bgm.stop();
  }

  /** 설정 화면에서 BGM 토글/볼륨 변경 즉시 반영. */
  refreshBgmSettings(): void {
    bgm.refreshSettings();
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

  // ============================================
  // 배틀 테트리스 SFX
  // ============================================

  /** 회전: 짧은 상승 핀 ("틱") */
  private playTetrisRotate(): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    osc.type = 'square';
    osc.frequency.setValueAtTime(640, now);
    osc.frequency.exponentialRampToValueAtTime(820, now + 0.04);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.05, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(gain).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  /** 피스 고정: 짧고 둔탁한 "툭" (저역 노이즈 + 사인 바디) */
  private playTetrisLock(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    // 저역 사인 바디
    const osc = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.08);
    g1.gain.setValueAtTime(0, now);
    g1.gain.linearRampToValueAtTime(0.12, now + 0.003);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.connect(g1).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /** 하드드롭: "쿵" — lock보다 더 강한 저역 + 짧은 노이즈 */
  private playTetrisHardDrop(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    // 서브 저역
    const osc = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.12);
    g1.gain.setValueAtTime(0, now);
    g1.gain.linearRampToValueAtTime(0.22, now + 0.004);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(g1).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.18);

    // 임팩트 노이즈 한 번
    const len = Math.floor(ctx.sampleRate * 0.05);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.18));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g2 = ctx.createGain();
    g2.gain.value = 0.08;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 800;
    src.connect(lp).connect(g2).connect(this.masterGain!);
    src.start(now);
  }

  /** 홀드: 살짝 휘릭 (두 사인 빠른 슬라이드) */
  private playTetrisHold(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(780, now + 0.06);
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.12);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.09, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(gain).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  /** 라인 클리어 (1~3줄): 경쾌한 상행 아르페지오 */
  private playTetrisClear(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const notes = [587.33, 783.99, 987.77]; // D5, G5, B5
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + i * 0.05;
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.14, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(start);
      osc.stop(start + 0.22);
    });
  }

  /** 테트리스 (4줄 동시): 더 길고 화려한 5음 아르페지오 */
  private playTetrisTetris(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    // C5 - E5 - G5 - C6 - E6 (장조 상행)
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + i * 0.06;
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.32);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(start);
      osc.stop(start + 0.34);
    });
  }

  /** 가비지 수신: 저역 "두둑" 느낌 (짧은 노이즈 버스트) */
  private playTetrisGarbage(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.12);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.25));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0.14;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    src.connect(lp).connect(gain).connect(this.masterGain!);
    src.start(now);

    // 짧은 저역 톤 한 번 더 추가
    const osc = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(70, now + 0.15);
    g2.gain.setValueAtTime(0, now);
    g2.gain.linearRampToValueAtTime(0.1, now + 0.005);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc.connect(g2).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  /** 탑아웃: 하강 글리산도 (절망적인 느낌) */
  private playTetrisTopout(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.6);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    osc.connect(lp).connect(gain).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.75);
  }
}

export const sound = new SoundManager();
