/**
 * 게임별 배경음악 (BGM) 합성 플레이어
 *
 * 왜 합성(Web Audio)?
 *   SFX(sound.ts) 와 동일한 원칙. 외부 오디오 파일 없이 oscillator 로 즉석 생성.
 *   퀄리티는 chiptune 수준이지만 의존성 제로 + 번들 영향 없음 + 파스텔 톤 게임과 어울림.
 *
 * 구조:
 *   각 게임 BGM 은 "짧은 루프(8마디 전후)" 를 계속 반복.
 *   멜로디 라인 + 베이스 라인 두 개를 동시에 AudioContext 에 스케줄링.
 *   루프 끝나면 타이머로 다시 schedule → 끊김 없이 반복.
 *
 * 설정 연동:
 *   storage.bgmEnabled = false 면 start() 가 no-op.
 *   storage.masterVolume 이 마스터 게인에 반영 (SFX 와 공유하진 않고 독립 스케일).
 *   BGM 은 SFX 보다 작게 (최종 게인 × 0.35) — 배경음 역할이니 너무 튀지 않게.
 *
 * 자동 초기화:
 *   브라우저 정책상 AudioContext 는 사용자 interaction 이후에만 활성. 첫 click/keydown 훅.
 */

import { storage } from './storage';

export type BgmId = 'air-hockey' | 'battle-tetris' | 'apple-game';

// ============================================
// 음이름 → 주파수 테이블 (십이평균율, A4=440)
// ============================================

// 패턴 작성 시 `NOTES.C4` 처럼 써서 가독성 확보.
// 필요한 음만 포함 (샤프/플랫은 쓰는 것만 등록).
const NOTES = {
  // 저음 (베이스)
  F2: 87.31,  G2: 98.00,  A2: 110.00, Bb2: 116.54,  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00, A3: 220.00,
  // 중음 (멜로디 저역)
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, Bb4: 466.16, B4: 493.88,
  // 고음 (멜로디 고역)
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.00, Bb5: 932.33, B5: 987.77,
  C6: 1046.50,
} as const;

/** 쉼표 — 주파수 0 은 "소리 안 냄" 신호 */
const R = 0;

// ============================================
// 패턴 타입
// ============================================

interface Note {
  /** 주파수 Hz. 0 = 쉼표. */
  f: number;
  /** 길이 (16분음표 단위). 1=16분, 2=8분, 4=4분, 8=2분, 16=온음표. */
  d: number;
}

interface BgmPattern {
  bpm: number;
  /** 루프 전체 길이 (16분 음표 단위). 멜로디/베이스 합계가 이 값과 같아야 함. */
  lengthSixteenths: number;
  /** 멜로디 라인 (triangle 오실레이터) */
  melody: Note[];
  /** 베이스 라인 (sine 오실레이터, 옵션) */
  bass?: Note[];
  /** 멜로디 오실레이터 파형 — 기본 triangle */
  melodyWave?: OscillatorType;
}

// ============================================
// 게임별 BGM 패턴
// ============================================
// 각 패턴은 8마디(=128 × 16분) 또는 4마디(64) 수준의 짧은 루프.
// 계산: 한 마디(4/4) = 16 × 16분음표.

// --- 에어하키: C 메이저, 130 BPM, 경쾌 ---
// 8마디 = 128 × 16분. 멜로디는 16분~8분 위주로 속도감.
const PATTERN_AIR_HOCKEY: BgmPattern = {
  bpm: 130,
  lengthSixteenths: 128,
  melodyWave: 'square', // 8-bit 경쾌 느낌
  melody: [
    // 마디 1-2: C 메이저 상승 아르페지오
    { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.E5, d: 2 },
    { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.C6, d: 2 },
    // 마디 3-4: 하강 후 회복
    { f: NOTES.B4, d: 2 }, { f: NOTES.D5, d: 2 }, { f: NOTES.F5, d: 2 }, { f: NOTES.D5, d: 2 },
    { f: NOTES.C5, d: 4 }, { f: NOTES.E5, d: 4 },               { f: R,       d: 4 },
    // 마디 5-6: 비슷한 진행, 살짝 변형
    { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.E5, d: 2 },
    { f: NOTES.A4, d: 2 }, { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.A5, d: 2 },
    // 마디 7-8: 마무리
    { f: NOTES.G5, d: 2 }, { f: NOTES.F5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.D5, d: 2 },
    { f: NOTES.C5, d: 8 }, { f: R,        d: 8 },
  ],
  bass: [
    // 마디 1-2: C-G 반복
    { f: NOTES.C3, d: 4 }, { f: NOTES.C3, d: 4 }, { f: NOTES.G3, d: 4 }, { f: NOTES.G3, d: 4 },
    { f: NOTES.C3, d: 4 }, { f: NOTES.C3, d: 4 }, { f: NOTES.G3, d: 4 }, { f: NOTES.G3, d: 4 },
    // 마디 3-4: F-G-C
    { f: NOTES.F3, d: 4 }, { f: NOTES.F3, d: 4 }, { f: NOTES.G3, d: 4 }, { f: NOTES.G3, d: 4 },
    { f: NOTES.C3, d: 8 }, { f: NOTES.G3, d: 8 },
    // 마디 5-6
    { f: NOTES.C3, d: 4 }, { f: NOTES.C3, d: 4 }, { f: NOTES.G3, d: 4 }, { f: NOTES.G3, d: 4 },
    { f: NOTES.A3, d: 4 }, { f: NOTES.A3, d: 4 }, { f: NOTES.E3, d: 4 }, { f: NOTES.E3, d: 4 },
    // 마디 7-8
    { f: NOTES.F3, d: 4 }, { f: NOTES.G3, d: 4 }, { f: NOTES.C3, d: 8 },
    { f: NOTES.C3, d: 16 },
  ],
};

// --- 배틀 테트리스: A 마이너, 110 BPM, 긴장감 ---
const PATTERN_BATTLE_TETRIS: BgmPattern = {
  bpm: 110,
  lengthSixteenths: 128,
  melodyWave: 'triangle',
  melody: [
    // 마디 1-2: Am 상승-하강
    { f: NOTES.A4, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.A5, d: 2 }, { f: NOTES.G5, d: 2 },
    { f: NOTES.F5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.D5, d: 2 }, { f: NOTES.E5, d: 2 },
    // 마디 3-4: 변형 반복
    { f: NOTES.A4, d: 2 }, { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.A5, d: 2 },
    { f: NOTES.G5, d: 4 }, { f: NOTES.E5, d: 4 }, { f: R,        d: 4 },
    // 마디 5-6: Dm 방향
    { f: NOTES.D5, d: 2 }, { f: NOTES.F5, d: 2 }, { f: NOTES.A5, d: 2 }, { f: NOTES.F5, d: 2 },
    { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.B4, d: 2 }, { f: NOTES.E5, d: 2 },
    // 마디 7-8: 해결
    { f: NOTES.C5, d: 2 }, { f: NOTES.B4, d: 2 }, { f: NOTES.A4, d: 2 }, { f: NOTES.G4, d: 2 },
    { f: NOTES.A4, d: 8 }, { f: R,        d: 8 },
  ],
  bass: [
    { f: NOTES.A2, d: 4 }, { f: NOTES.E3, d: 4 }, { f: NOTES.A2, d: 4 }, { f: NOTES.E3, d: 4 },
    { f: NOTES.A2, d: 4 }, { f: NOTES.E3, d: 4 }, { f: NOTES.A2, d: 4 }, { f: NOTES.E3, d: 4 },
    { f: NOTES.A2, d: 4 }, { f: NOTES.C3, d: 4 }, { f: NOTES.E3, d: 4 }, { f: NOTES.C3, d: 4 },
    { f: NOTES.A2, d: 8 }, { f: NOTES.E3, d: 8 },
    { f: NOTES.D3, d: 4 }, { f: NOTES.F3, d: 4 }, { f: NOTES.A3, d: 4 }, { f: NOTES.F3, d: 4 },
    { f: NOTES.E3, d: 4 }, { f: NOTES.G3, d: 4 }, { f: NOTES.E3, d: 4 }, { f: NOTES.G3, d: 4 },
    { f: NOTES.F3, d: 4 }, { f: NOTES.E3, d: 4 }, { f: NOTES.A2, d: 8 },
    { f: NOTES.A2, d: 16 },
  ],
};

// --- 사과 게임: F 메이저, 95 BPM, 밝고 느긋 ---
const PATTERN_APPLE_GAME: BgmPattern = {
  bpm: 95,
  lengthSixteenths: 128,
  melodyWave: 'triangle',
  melody: [
    { f: NOTES.F4,  d: 4 }, { f: NOTES.A4,  d: 4 }, { f: NOTES.C5,  d: 4 }, { f: NOTES.A4,  d: 4 },
    { f: NOTES.G4,  d: 4 }, { f: NOTES.Bb4, d: 4 }, { f: NOTES.D5,  d: 4 }, { f: NOTES.Bb4, d: 4 },
    { f: NOTES.A4,  d: 4 }, { f: NOTES.C5,  d: 4 }, { f: NOTES.F5,  d: 4 }, { f: NOTES.C5,  d: 4 },
    { f: NOTES.G4,  d: 4 }, { f: NOTES.A4,  d: 4 }, { f: NOTES.Bb4, d: 4 }, { f: NOTES.A4,  d: 4 },
    { f: NOTES.F4,  d: 2 }, { f: NOTES.G4,  d: 2 }, { f: NOTES.A4,  d: 4 }, { f: NOTES.C5,  d: 2 }, { f: NOTES.A4,  d: 2 }, { f: NOTES.F4,  d: 4 },
    { f: NOTES.G4,  d: 4 }, { f: NOTES.Bb4, d: 4 }, { f: NOTES.A4,  d: 4 }, { f: NOTES.G4,  d: 4 },
    { f: NOTES.A4,  d: 4 }, { f: NOTES.F4,  d: 4 }, { f: NOTES.C5,  d: 4 }, { f: NOTES.A4,  d: 4 },
    { f: NOTES.F4,  d: 8 }, { f: R,         d: 8 },
  ],
  bass: [
    { f: NOTES.F2,  d: 8 }, { f: NOTES.C3,  d: 8 },
    { f: NOTES.G2,  d: 8 }, { f: NOTES.D3,  d: 8 },
    { f: NOTES.A2,  d: 8 }, { f: NOTES.F3,  d: 8 },
    { f: NOTES.G2,  d: 8 }, { f: NOTES.C3,  d: 8 },
    { f: NOTES.F2,  d: 8 }, { f: NOTES.A2,  d: 8 },
    { f: NOTES.G2,  d: 8 }, { f: NOTES.Bb2, d: 8 },
    { f: NOTES.F2,  d: 8 }, { f: NOTES.C3,  d: 8 },
    { f: NOTES.F2,  d: 16 },
  ],
};

const PATTERNS: Record<BgmId, BgmPattern> = {
  'air-hockey':    PATTERN_AIR_HOCKEY,
  'battle-tetris': PATTERN_BATTLE_TETRIS,
  'apple-game':    PATTERN_APPLE_GAME,
};

// ============================================
// BgmPlayer
// ============================================

/** BGM 은 SFX 보다 조용히 — 배경음 역할 */
const BGM_MIX_SCALE = 0.35;

class BgmPlayer {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private currentId: BgmId | null = null;

  /** 예약된 oscillator 들 — stop() 호출 시 전부 cancel */
  private scheduled: OscillatorNode[] = [];
  /** 다음 루프 재스케줄 타이머 */
  private nextLoopTimer: number | null = null;

  constructor() {
    // 브라우저 자동재생 정책: 첫 사용자 interaction 이후에야 AudioContext 생성 가능.
    const unlock = (): void => this.ensureInit();
    document.addEventListener('click', unlock);
    document.addEventListener('keydown', unlock);
  }

  private ensureInit(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.computeMasterGain();
    this.masterGain.connect(this.ctx.destination);
  }

  /** storage.masterVolume × BGM_MIX_SCALE */
  private computeMasterGain(): number {
    const settings = storage.getSettings();
    if (!settings.bgmEnabled) return 0;
    return (settings.masterVolume / 100) * BGM_MIX_SCALE;
  }

  /**
   * BGM 재생 시작. 이미 같은 id 재생 중이면 무시.
   * bgmEnabled=false 인 설정이면 no-op.
   */
  start(id: BgmId): void {
    if (this.currentId === id) return;
    this.stop();

    this.ensureInit();
    if (!this.ctx || !this.masterGain) return;
    if (!storage.getSettings().bgmEnabled) return;

    // 설정이 바뀌었을 수 있으므로 마스터 게인 재계산
    this.masterGain.gain.value = this.computeMasterGain();

    this.currentId = id;
    // 시작 시점 살짝 여유(0.1s) 주어 스케줄 충돌 방지
    this.scheduleLoop(this.ctx.currentTime + 0.1);
  }

  /** BGM 정지. 예약된 모든 oscillator 취소 + 타이머 clear. */
  stop(): void {
    if (this.nextLoopTimer !== null) {
      window.clearTimeout(this.nextLoopTimer);
      this.nextLoopTimer = null;
    }
    for (const osc of this.scheduled) {
      try { osc.stop(); } catch { /* 이미 끝난 osc 는 예외 — 무시 */ }
    }
    this.scheduled = [];
    this.currentId = null;
  }

  /**
   * 한 루프를 AudioContext 스케줄러에 예약.
   * startTime = 이 루프가 시작되는 ctx.currentTime 기준 시각.
   * 루프가 끝나는 타이밍에 setTimeout 으로 자기 자신을 다시 호출 → 끊김 없이 반복.
   */
  private scheduleLoop(startTime: number): void {
    if (!this.ctx || !this.masterGain || !this.currentId) return;
    const pattern = PATTERNS[this.currentId];
    const secPer16th = 60 / pattern.bpm / 4;

    // 멜로디
    let t = 0;
    for (const note of pattern.melody) {
      const dur = note.d * secPer16th;
      if (note.f > 0) {
        this.scheduleNote(note.f, startTime + t, dur, pattern.melodyWave ?? 'triangle', 0.22);
      }
      t += dur;
    }
    // 베이스
    if (pattern.bass) {
      let bt = 0;
      for (const note of pattern.bass) {
        const dur = note.d * secPer16th;
        if (note.f > 0) {
          this.scheduleNote(note.f, startTime + bt, dur, 'sine', 0.3);
        }
        bt += dur;
      }
    }

    // 루프 반복: 루프 길이에 맞춰 다음 scheduleLoop 예약.
    // setTimeout 해상도가 낮아 오차 있을 수 있지만, 다음 루프 startTime 은 정확한 ctx 시각으로 계산.
    const loopDurSec = pattern.lengthSixteenths * secPer16th;
    const loopDurMs = loopDurSec * 1000;
    this.nextLoopTimer = window.setTimeout(() => {
      if (this.currentId === null) return;
      this.scheduleLoop(startTime + loopDurSec);
    }, loopDurMs - 50); // 50ms 먼저 스케줄해 끊김 방지
  }

  /** 한 음표 예약. ADSR: 짧은 attack/release 로 부드럽게. */
  private scheduleNote(
    freq: number,
    when: number,
    duration: number,
    type: OscillatorType,
    peak: number,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;

    const attack = 0.01;
    const release = Math.min(0.08, duration * 0.3);
    const sustainEnd = when + duration - release;

    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.setValueAtTime(peak, Math.max(sustainEnd, when + attack));
    gain.gain.exponentialRampToValueAtTime(0.001, when + duration);

    osc.connect(gain).connect(this.masterGain!);
    osc.start(when);
    osc.stop(when + duration + 0.05);
    this.scheduled.push(osc);

    // osc 종료 후 scheduled 배열에서 제거 — 메모리 누수 방지
    osc.onended = (): void => {
      const idx = this.scheduled.indexOf(osc);
      if (idx >= 0) this.scheduled.splice(idx, 1);
    };
  }
}

export const bgm = new BgmPlayer();
