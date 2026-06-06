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

export type BgmId = 'air-hockey' | 'battle-tetris' | 'apple-game' | 'gomoku' | 'darts' | 'reflex' | 'algagi' | 'word-chain';

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

// --- 에어하키: C 메이저, 140 BPM, 활기차고 캐치한 훅 ---
// 개선판(2026-04-25): 기존보다 템포 ↑ (130→140) + 반복되는 모티프(훅)로 중독성 강화.
// 베이스는 4분+8분 섞어서 리듬감 확실히.
const PATTERN_AIR_HOCKEY: BgmPattern = {
  bpm: 140,
  lengthSixteenths: 128,
  melodyWave: 'square', // 8-bit 경쾌 느낌
  melody: [
    // 마디 1: 메인 훅 (C-G-E-G 리듬감)
    { f: NOTES.C5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 },
    { f: NOTES.C5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.C6, d: 2 },
    // 마디 2: D 방향 변주
    { f: NOTES.D5, d: 2 }, { f: NOTES.A5, d: 2 }, { f: NOTES.F5, d: 2 }, { f: NOTES.A5, d: 2 },
    { f: NOTES.D5, d: 2 }, { f: NOTES.A5, d: 2 }, { f: NOTES.F5, d: 2 }, { f: NOTES.D5, d: 2 },
    // 마디 3: 상승 라인
    { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.C6, d: 2 }, { f: NOTES.G5, d: 2 },
    { f: NOTES.E5, d: 2 }, { f: NOTES.C5, d: 2 }, { f: NOTES.G4, d: 2 }, { f: NOTES.E5, d: 2 },
    // 마디 4: F-A 훅 + 해결
    { f: NOTES.F5, d: 2 }, { f: NOTES.A5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.E5, d: 2 },
    { f: NOTES.C5, d: 4 }, { f: NOTES.G4, d: 4 },
    // 마디 5: 메인 훅 재사용
    { f: NOTES.C5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 },
    { f: NOTES.C5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.C6, d: 2 },
    // 마디 6: 하강 계단
    { f: NOTES.B5, d: 2 }, { f: NOTES.A5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.F5, d: 2 },
    { f: NOTES.E5, d: 4 }, { f: NOTES.D5, d: 4 },
    // 마디 7: 빌드업
    { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.C6, d: 2 }, { f: NOTES.G5, d: 2 },
    { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.C6, d: 4 },
    // 마디 8: 해결
    { f: NOTES.C5, d: 8 }, { f: R, d: 8 },
  ],
  bass: [
    // 마디 1: C 팝핑
    { f: NOTES.C3, d: 4 }, { f: NOTES.G3, d: 2 }, { f: NOTES.C3, d: 2 }, { f: NOTES.G3, d: 4 }, { f: NOTES.C3, d: 4 },
    // 마디 2: D
    { f: NOTES.D3, d: 4 }, { f: NOTES.A3, d: 2 }, { f: NOTES.D3, d: 2 }, { f: NOTES.A3, d: 4 }, { f: NOTES.D3, d: 4 },
    // 마디 3: C 복귀 + E-G 컬러
    { f: NOTES.C3, d: 4 }, { f: NOTES.E3, d: 2 }, { f: NOTES.G3, d: 2 }, { f: NOTES.C3, d: 4 }, { f: NOTES.G3, d: 4 },
    // 마디 4: F-G-C 해결
    { f: NOTES.F3, d: 4 }, { f: NOTES.G3, d: 4 }, { f: NOTES.C3, d: 8 },
    // 마디 5: 다시 C 팝핑
    { f: NOTES.C3, d: 4 }, { f: NOTES.G3, d: 2 }, { f: NOTES.C3, d: 2 }, { f: NOTES.G3, d: 4 }, { f: NOTES.C3, d: 4 },
    // 마디 6: A 마이너 컬러
    { f: NOTES.A3, d: 4 }, { f: NOTES.E3, d: 4 }, { f: NOTES.F3, d: 4 }, { f: NOTES.G3, d: 4 },
    // 마디 7: 빌드업 4분 pulse
    { f: NOTES.C3, d: 4 }, { f: NOTES.G3, d: 4 }, { f: NOTES.C3, d: 4 }, { f: NOTES.G3, d: 4 },
    // 마디 8: 길게
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

// --- 오목: F 메이저, 88 BPM, 따뜻하고 잔잔 ---
// "너무 처진다" 피드백 후 D 마이너 → F 메이저로 키 변경 + 템포 살짝 업.
// 신중함은 유지하되 따뜻하고 평온한 분위기. 부드러운 triangle.
const PATTERN_GOMOKU: BgmPattern = {
  bpm: 88,
  lengthSixteenths: 128,
  melodyWave: 'triangle',
  melody: [
    // 마디 1: F 토닉 (F-A-C)
    { f: NOTES.F4, d: 4 }, { f: NOTES.A4, d: 4 }, { f: NOTES.C5, d: 4 }, { f: NOTES.A4, d: 4 },
    // 마디 2: 위로 올라가는 호흡 — F5 까지 올라갔다 머무름
    { f: NOTES.G4, d: 4 }, { f: NOTES.A4, d: 4 }, { f: NOTES.F5, d: 8 },
    // 마디 3: 부드러운 하행
    { f: NOTES.E5, d: 4 }, { f: NOTES.C5, d: 4 }, { f: NOTES.A4, d: 4 }, { f: NOTES.G4, d: 4 },
    // 마디 4: F 으로 돌아옴
    { f: NOTES.A4, d: 4 }, { f: NOTES.G4, d: 4 }, { f: NOTES.F4, d: 8 },
    // 마디 5: Bb (IV) 컬러 — 따뜻함
    { f: NOTES.Bb4, d: 4 }, { f: NOTES.A4, d: 4 }, { f: NOTES.G4, d: 4 }, { f: NOTES.F4, d: 4 },
    // 마디 6: C7 (V) — 약간 긴장
    { f: NOTES.G4, d: 4 }, { f: NOTES.E4, d: 4 }, { f: NOTES.G4, d: 8 },
    // 마디 7: 해결 준비
    { f: NOTES.A4, d: 4 }, { f: NOTES.C5, d: 4 }, { f: NOTES.A4, d: 4 }, { f: NOTES.G4, d: 4 },
    // 마디 8: F 토닉 길게 — 다음 루프 이음매
    { f: NOTES.F4, d: 16 },
  ],
  bass: [
    // 매 마디 d=8 × 2 = 16 sixteenths. 잔잔한 2박 펄스.
    // 마디 1: F (I)
    { f: NOTES.F3,  d: 8 }, { f: NOTES.C4,  d: 8 },
    // 마디 2: F (I) — 멜로디가 F5 로 올라가는 동안 안정감
    { f: NOTES.F3,  d: 8 }, { f: NOTES.A3,  d: 8 },
    // 마디 3: D minor (vi) — 차분한 컬러
    { f: NOTES.D3,  d: 8 }, { f: NOTES.A3,  d: 8 },
    // 마디 4: F (I)
    { f: NOTES.F3,  d: 8 }, { f: NOTES.C4,  d: 8 },
    // 마디 5: Bb (IV)
    { f: NOTES.Bb2, d: 8 }, { f: NOTES.F3,  d: 8 },
    // 마디 6: C (V)
    { f: NOTES.C3,  d: 8 }, { f: NOTES.G3,  d: 8 },
    // 마디 7: D minor (vi) → C (V)
    { f: NOTES.D3,  d: 8 }, { f: NOTES.C3,  d: 8 },
    // 마디 8: F (I) 길게
    { f: NOTES.F3,  d: 16 },
  ],
};

// --- 다트: C 메이저, 100 BPM, 경쾌한 아르페지오 ---
// 던지기 전 집중·조준 → 정확히 꽂히는 쾌감. 튕기는 느낌의 bouncy triangle 멜로디.
const PATTERN_DARTS: BgmPattern = {
  bpm: 100,
  lengthSixteenths: 128,
  melodyWave: 'triangle',
  melody: [
    // 마디 1: C 메이저 아르페지오 (C-E-G)
    { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.E5, d: 2 },
    { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 4 },
    // 마디 2: 상승 후 착지
    { f: NOTES.A4, d: 4 }, { f: NOTES.C5, d: 4 }, { f: NOTES.E5, d: 2 }, { f: NOTES.D5, d: 2 }, { f: NOTES.C5, d: 4 },
    // 마디 3: F 메이저 (IV) — 밝은 전환
    { f: NOTES.F4, d: 2 }, { f: NOTES.A4, d: 2 }, { f: NOTES.C5, d: 2 }, { f: NOTES.A4, d: 2 },
    { f: NOTES.F4, d: 2 }, { f: NOTES.A4, d: 2 }, { f: NOTES.C5, d: 4 },
    // 마디 4: G7 (V7) — 긴장
    { f: NOTES.G4, d: 4 }, { f: NOTES.B4, d: 4 }, { f: NOTES.D5, d: 4 }, { f: NOTES.B4, d: 4 },
    // 마디 5: 해결 (I)
    { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.G5, d: 2 }, { f: NOTES.C6, d: 2 },
    { f: NOTES.G5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.C5, d: 4 },
    // 마디 6: A 마이너 컬러
    { f: NOTES.A4, d: 2 }, { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 4 }, { f: NOTES.D5, d: 4 }, { f: NOTES.C5, d: 4 },
    // 마디 7: ii-V 진행
    { f: NOTES.D4, d: 4 }, { f: NOTES.F4, d: 4 }, { f: NOTES.G4, d: 4 }, { f: NOTES.B4, d: 4 },
    // 마디 8: 토닉 길게 — 루프 이음매
    { f: NOTES.C5, d: 8 }, { f: NOTES.E5, d: 4 }, { f: NOTES.C5, d: 4 },
  ],
  bass: [
    // 마디 1: C (tonic)
    { f: NOTES.C3, d: 8 }, { f: NOTES.G3, d: 8 },
    // 마디 2: A minor (vi) — 색채
    { f: NOTES.A2, d: 8 }, { f: NOTES.E3, d: 8 },
    // 마디 3: F (IV)
    { f: NOTES.F2, d: 8 }, { f: NOTES.C3, d: 8 },
    // 마디 4: G (V)
    { f: NOTES.G2, d: 8 }, { f: NOTES.D3, d: 8 },
    // 마디 5: C (I) 다시
    { f: NOTES.C3, d: 8 }, { f: NOTES.G3, d: 8 },
    // 마디 6: A minor (vi)
    { f: NOTES.A2, d: 8 }, { f: NOTES.E3, d: 8 },
    // 마디 7: D minor (ii) → G (V)
    { f: NOTES.D3, d: 8 }, { f: NOTES.G2, d: 8 },
    // 마디 8: C (I) 길게
    { f: NOTES.C3, d: 16 },
  ],
};

// --- 반응속도: G 메이저, 105 BPM, 가벼운 긴장감 + 반복 모티프 ---
// 짧은 라운드 사이 대기 시간이 많은 게임이라 너무 화려하지 않게.
const PATTERN_REFLEX: BgmPattern = {
  bpm: 105,
  lengthSixteenths: 128,
  melodyWave: 'square',
  melody: [
    // 마디 1: G 상승 모티프
    { f: NOTES.G4, d: 2 }, { f: NOTES.B4, d: 2 }, { f: NOTES.D5, d: 2 }, { f: NOTES.B4, d: 2 },
    { f: NOTES.G4, d: 2 }, { f: NOTES.B4, d: 2 }, { f: NOTES.D5, d: 4 },
    // 마디 2: A 마이너 (vi) 변주
    { f: NOTES.A4, d: 2 }, { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.C5, d: 2 },
    { f: NOTES.A4, d: 4 }, { f: NOTES.G4, d: 4 },
    // 마디 3: 하강 라인
    { f: NOTES.E5, d: 2 }, { f: NOTES.D5, d: 2 }, { f: NOTES.C5, d: 2 }, { f: NOTES.B4, d: 2 },
    { f: NOTES.A4, d: 2 }, { f: NOTES.G4, d: 4 }, { f: R,        d: 2 },
    // 마디 4: 빌드업 (G5 도달)
    { f: NOTES.G4, d: 2 }, { f: NOTES.B4, d: 2 }, { f: NOTES.D5, d: 2 }, { f: NOTES.G5, d: 2 },
    { f: NOTES.D5, d: 2 }, { f: NOTES.B4, d: 2 }, { f: NOTES.G4, d: 4 },
    // 마디 5: 모티프 재사용
    { f: NOTES.G4, d: 2 }, { f: NOTES.B4, d: 2 }, { f: NOTES.D5, d: 2 }, { f: NOTES.B4, d: 2 },
    { f: NOTES.G4, d: 2 }, { f: NOTES.B4, d: 2 }, { f: NOTES.D5, d: 4 },
    // 마디 6: ii-V 진행
    { f: NOTES.A4, d: 2 }, { f: NOTES.C5, d: 2 }, { f: NOTES.E5, d: 2 }, { f: NOTES.C5, d: 2 },
    { f: NOTES.A4, d: 4 }, { f: NOTES.G4, d: 4 },
    // 마디 7: 하강 → 해결 준비
    { f: NOTES.E5, d: 2 }, { f: NOTES.D5, d: 2 }, { f: NOTES.C5, d: 2 }, { f: NOTES.B4, d: 2 },
    { f: NOTES.A4, d: 2 }, { f: NOTES.G4, d: 4 }, { f: R,        d: 2 },
    // 마디 8: 토닉 길게 (루프 이음매)
    { f: NOTES.G4, d: 4 }, { f: NOTES.D5, d: 4 }, { f: NOTES.G5, d: 8 },
  ],
  bass: [
    { f: NOTES.G2, d: 8 }, { f: NOTES.D3, d: 8 },
    { f: NOTES.A2, d: 8 }, { f: NOTES.E3, d: 8 },
    { f: NOTES.C3, d: 8 }, { f: NOTES.G2, d: 8 },
    { f: NOTES.D3, d: 8 }, { f: NOTES.G2, d: 8 },
    { f: NOTES.G2, d: 8 }, { f: NOTES.D3, d: 8 },
    { f: NOTES.A2, d: 8 }, { f: NOTES.E3, d: 8 },
    { f: NOTES.C3, d: 8 }, { f: NOTES.G2, d: 8 },
    { f: NOTES.G2, d: 16 },
  ],
};

// --- 알까기: A 마이너 펜타토닉, 90 BPM, 신중·차분 + 살짝 긴장 ---
// 한국 전통 어린이 놀이 분위기 — 펜타토닉(A C D E G) 으로 동양적 색. 오목보다는 살짝 빠르게.
const PATTERN_ALGAGI: BgmPattern = {
  bpm: 90,
  lengthSixteenths: 128,
  melodyWave: 'triangle',
  melody: [
    // 마디 1: A 토닉 — 펜타토닉 상승 (A-C-D-E)
    { f: NOTES.A4, d: 4 }, { f: NOTES.C5, d: 4 }, { f: NOTES.D5, d: 4 }, { f: NOTES.E5, d: 4 },
    // 마디 2: G 컬러 + 머무름
    { f: NOTES.G5, d: 4 }, { f: NOTES.E5, d: 4 }, { f: NOTES.D5, d: 8 },
    // 마디 3: 부드러운 하행 (E-D-C-A)
    { f: NOTES.E5, d: 4 }, { f: NOTES.D5, d: 4 }, { f: NOTES.C5, d: 4 }, { f: NOTES.A4, d: 4 },
    // 마디 4: 호흡 — A 길게 + 짧은 쉼
    { f: NOTES.A4, d: 8 }, { f: R, d: 4 }, { f: NOTES.G4, d: 4 },
    // 마디 5: 변주 — 위쪽 펜타토닉 (C-D-E-G)
    { f: NOTES.C5, d: 4 }, { f: NOTES.D5, d: 4 }, { f: NOTES.E5, d: 4 }, { f: NOTES.G5, d: 4 },
    // 마디 6: A5 정점 → 하행
    { f: NOTES.A5, d: 4 }, { f: NOTES.G5, d: 4 }, { f: NOTES.E5, d: 8 },
    // 마디 7: 해결 준비 (D-C-A-E)
    { f: NOTES.D5, d: 4 }, { f: NOTES.C5, d: 4 }, { f: NOTES.A4, d: 4 }, { f: NOTES.E4, d: 4 },
    // 마디 8: A 토닉 길게 — 루프 이음매
    { f: NOTES.A4, d: 16 },
  ],
  bass: [
    // 마디 1: A (i)
    { f: NOTES.A2, d: 8 }, { f: NOTES.E3, d: 8 },
    // 마디 2: A — 멜로디가 G 로 올라갈 때
    { f: NOTES.A2, d: 8 }, { f: NOTES.G3, d: 8 },
    // 마디 3: C 메이저 (III) — 따뜻한 컬러
    { f: NOTES.C3, d: 8 }, { f: NOTES.G3, d: 8 },
    // 마디 4: A (i) 복귀
    { f: NOTES.A2, d: 8 }, { f: NOTES.E3, d: 8 },
    // 마디 5: D 마이너 (iv)
    { f: NOTES.D3, d: 8 }, { f: NOTES.A3, d: 8 },
    // 마디 6: E (v) — 살짝 긴장
    { f: NOTES.E3, d: 8 }, { f: NOTES.G3, d: 8 },
    // 마디 7: C (III) → E (v)
    { f: NOTES.C3, d: 8 }, { f: NOTES.E3, d: 8 },
    // 마디 8: A (i) 길게
    { f: NOTES.A2, d: 16 },
  ],
};

// --- 끝말잇기: D 마이너 펜타토닉, 92 BPM, 사색적 + 한국 전통풍 ---
// 단어 생각하는 시간 — 너무 화려하지 않게, 단조이지만 어둡지 않은 펜타토닉(D F A C).
const PATTERN_WORD_CHAIN: BgmPattern = {
  bpm: 92,
  lengthSixteenths: 128,
  melodyWave: 'triangle',
  melody: [
    // 마디 1: D 토닉
    { f: NOTES.D4, d: 4 }, { f: NOTES.F4, d: 4 }, { f: NOTES.A4, d: 4 }, { f: NOTES.F4, d: 4 },
    // 마디 2: C 컬러
    { f: NOTES.C5, d: 4 }, { f: NOTES.A4, d: 4 }, { f: NOTES.F4, d: 8 },
    // 마디 3: 상행
    { f: NOTES.A4, d: 4 }, { f: NOTES.C5, d: 4 }, { f: NOTES.D5, d: 4 }, { f: NOTES.F5, d: 4 },
    // 마디 4: 해결
    { f: NOTES.A4, d: 4 }, { f: NOTES.F4, d: 4 }, { f: NOTES.D4, d: 8 },
    // 마디 5: 위쪽 변주
    { f: NOTES.F4, d: 4 }, { f: NOTES.A4, d: 4 }, { f: NOTES.C5, d: 4 }, { f: NOTES.D5, d: 4 },
    // 마디 6: 정점
    { f: NOTES.F5, d: 4 }, { f: NOTES.D5, d: 4 }, { f: NOTES.A4, d: 8 },
    // 마디 7: 하행
    { f: NOTES.A4, d: 4 }, { f: NOTES.F4, d: 4 }, { f: NOTES.C4, d: 4 }, { f: NOTES.D4, d: 4 },
    // 마디 8: 토닉 길게 — 루프 이음매
    { f: NOTES.D4, d: 16 },
  ],
  bass: [
    // 마디 1: D 마이너 (i)
    { f: NOTES.D3, d: 8 }, { f: NOTES.A3, d: 8 },
    // 마디 2: F (III)
    { f: NOTES.F3, d: 8 }, { f: NOTES.A3, d: 8 },
    // 마디 3: D (i) — 상행 멜로디 받쳐줌
    { f: NOTES.D3, d: 8 }, { f: NOTES.A3, d: 8 },
    // 마디 4: D (i) 복귀
    { f: NOTES.D3, d: 8 }, { f: NOTES.F3, d: 8 },
    // 마디 5: G (iv) — 색채 변화
    { f: NOTES.G3, d: 8 }, { f: NOTES.D3, d: 8 },
    // 마디 6: A (v)
    { f: NOTES.A2, d: 8 }, { f: NOTES.E3, d: 8 },
    // 마디 7: F (III) → C (VII)
    { f: NOTES.F3, d: 8 }, { f: NOTES.C3, d: 8 },
    // 마디 8: D (i) 길게
    { f: NOTES.D3, d: 16 },
  ],
};

const PATTERNS: Record<BgmId, BgmPattern> = {
  'air-hockey':    PATTERN_AIR_HOCKEY,
  'battle-tetris': PATTERN_BATTLE_TETRIS,
  'apple-game':    PATTERN_APPLE_GAME,
  'gomoku':        PATTERN_GOMOKU,
  'darts':         PATTERN_DARTS,
  'reflex':        PATTERN_REFLEX,
  'algagi':        PATTERN_ALGAGI,
  'word-chain':    PATTERN_WORD_CHAIN,
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
  /**
   * 마지막으로 요청된 BGM id (정지 후에도 보존).
   * 사용자가 게임 도중 BGM OFF → ON 으로 토글하면, refreshSettings 에서 이 id 로 재시작.
   */
  private lastRequestedId: BgmId | null = null;

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
    // 게임이 요청한 id 기억 — BGM OFF 후 다시 ON 토글 시 재시작 용도
    this.lastRequestedId = id;
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

  /**
   * BGM 정지.
   *   - masterGain 을 즉시 0 으로 떨어뜨려 음소거 (osc.stop() 만으로는 이미 미래 시점으로
   *     stop 예약된 osc 가 즉시 중단 안 될 수 있어, 사용자가 "다음 판부터 적용" 처럼 느낌).
   *   - 예약된 osc 들도 ctx.currentTime 기준으로 명시 정지.
   *   - 다음 loop 타이머도 clear.
   */
  stop(): void {
    if (this.nextLoopTimer !== null) {
      window.clearTimeout(this.nextLoopTimer);
      this.nextLoopTimer = null;
    }
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.masterGain.gain.value = 0;
    }
    for (const osc of this.scheduled) {
      try { osc.stop(this.ctx?.currentTime ?? 0); } catch { /* 이미 끝난 osc — 무시 */ }
      try { osc.disconnect(); } catch { /* 이미 disconnect — 무시 */ }
    }
    this.scheduled = [];
    this.currentId = null;
  }

  /**
   * 설정 변경(masterVolume / bgmEnabled) 즉시 반영.
   * - bgmEnabled OFF → 재생 중이면 정지
   * - bgmEnabled ON → masterGain 즉시 새 볼륨으로 갱신 (이미 예약된 노트도 따라옴)
   *
   * 호출 위치: settings 화면에서 슬라이더/토글 변경 시.
   */
  refreshSettings(): void {
    const settings = storage.getSettings();
    if (!settings.bgmEnabled) {
      // OFF — 재생 중이면 즉시 정지
      if (this.currentId !== null) this.stop();
      return;
    }
    // ON — 재생 중이면 볼륨만 갱신, 정지 상태이지만 직전 요청 id 가 있으면 다시 재생.
    // (사용자가 게임 중 OFF → ON 으로 토글했을 때 즉시 다시 들리도록)
    if (this.currentId !== null) {
      if (this.masterGain) {
        this.masterGain.gain.value = this.computeMasterGain();
      }
    } else if (this.lastRequestedId !== null) {
      this.start(this.lastRequestedId);
    }
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
