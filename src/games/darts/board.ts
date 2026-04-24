/**
 * 다트보드 점수 계산 — 순수 로직만 (render 없음, 네트워크 없음).
 *
 * 좌표계:
 *   과녁 중심을 (0, 0) 으로 하는 **상대 좌표** (localX, localY)를 받음.
 *   render.ts 는 캔버스 픽셀 좌표를 과녁 중심 기준 상대 좌표로 변환해서 호출.
 *
 * 영역 비율 (표준 다트보드):
 *   보드 외곽 반지름(R)을 1로 놓고 각 영역의 안/바깥 반지름을 비율로 저장.
 *   render.ts 도 이 비율을 공유해 일관성 유지.
 *
 *   Inner Bull      0 ~ 0.038   → 50점
 *   Outer Bull   0.038 ~ 0.094  → 25점
 *   Inner single 0.094 ~ 0.544  → 세그먼트 × 1
 *   Triple ring  0.544 ~ 0.600  → 세그먼트 × 3
 *   Outer single 0.600 ~ 0.905  → 세그먼트 × 1
 *   Double ring  0.905 ~ 1.000  → 세그먼트 × 2
 *   밖           > 1.000         → 0점 (miss)
 *
 * 세그먼트 배치 (시계방향, 12시=20):
 *   20 · 1 · 18 · 4 · 13 · 6 · 10 · 15 · 2 · 17 · 3 · 19 · 7 · 16 · 8 · 11 · 14 · 9 · 12 · 5
 */

// ============================================
// 상수
// ============================================

/** 영역 경계 반지름 비율 (과녁 R을 1로 놓음). render.ts 와 공유. */
export const BOARD_RATIOS = {
  BULL_OUTER:        0.038,
  OUTER_BULL_OUTER:  0.094,
  TRIPLE_INNER:      0.544,
  TRIPLE_OUTER:      0.600,
  DOUBLE_INNER:      0.905,
  DOUBLE_OUTER:      1.000,
} as const;

/** 시계 12시부터 시계방향으로 나열된 20개 세그먼트 번호 */
export const SEGMENTS: readonly number[] = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
  3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
];

/** 한 세그먼트의 각도 폭 (라디안) */
const SEGMENT_ARC = Math.PI / 10; // 360°/20 = 18°

// ============================================
// 결과 타입
// ============================================

/**
 * 한 다트가 꽂힌 지점의 판정 결과.
 *
 * - `kind` : 영역 종류
 *   - 'miss'        : 과녁 밖
 *   - 'single'      : 일반 영역 (배수 1)
 *   - 'double'      : Double 링 (배수 2)
 *   - 'triple'      : Triple 링 (배수 3)
 *   - 'outer-bull'  : Outer Bull (25점 고정)
 *   - 'inner-bull'  : Bullseye (50점 고정, 일반적으로 Double Bull 취급)
 * - `segment` : 1~20 세그먼트 번호 (bull 계열은 0, miss 도 0)
 * - `multiplier` : 점수 배수 — single=1 / double=2 / triple=3 / bull 계열=1 또는 2 / miss=0
 * - `score` : 최종 점수 (segment × multiplier 또는 bull 고정값 또는 0)
 * - `label` : UI 표시용 짧은 라벨 (예: "T20", "D16", "Bull", "Miss")
 */
export type HitKind = 'miss' | 'single' | 'double' | 'triple' | 'outer-bull' | 'inner-bull';

export interface HitResult {
  kind: HitKind;
  segment: number;
  multiplier: 0 | 1 | 2 | 3;
  score: number;
  label: string;
}

// ============================================
// 판정 — 메인 함수
// ============================================

/**
 * 과녁 중심 기준 상대 좌표 (localX, localY) 에 떨어진 다트의 점수를 계산.
 *
 * @param localX 과녁 중심에서의 x offset (오른쪽이 +)
 * @param localY 과녁 중심에서의 y offset (아래쪽이 +, canvas 관습)
 * @param boardRadius Double 링 바깥의 실제 반지름 (픽셀 or 논리 단위)
 */
export function hitScore(localX: number, localY: number, boardRadius: number): HitResult {
  const r = Math.hypot(localX, localY);

  // 과녁 밖
  if (r > boardRadius * BOARD_RATIOS.DOUBLE_OUTER) {
    return { kind: 'miss', segment: 0, multiplier: 0, score: 0, label: 'Miss' };
  }

  // Bull 영역 — 세그먼트/각도와 무관
  if (r <= boardRadius * BOARD_RATIOS.BULL_OUTER) {
    return { kind: 'inner-bull', segment: 0, multiplier: 2, score: 50, label: 'Bull' };
  }
  if (r <= boardRadius * BOARD_RATIOS.OUTER_BULL_OUTER) {
    return { kind: 'outer-bull', segment: 0, multiplier: 1, score: 25, label: '25' };
  }

  // 세그먼트 계산
  const segment = angleToSegment(localX, localY);

  // 반지름에 따라 일반/Triple/Double 결정
  const rRatio = r / boardRadius;
  let kind: 'single' | 'double' | 'triple';
  let multiplier: 1 | 2 | 3;
  let labelPrefix: string;

  if (rRatio >= BOARD_RATIOS.DOUBLE_INNER) {
    kind = 'double';
    multiplier = 2;
    labelPrefix = 'D';
  } else if (rRatio >= BOARD_RATIOS.TRIPLE_INNER && rRatio <= BOARD_RATIOS.TRIPLE_OUTER) {
    kind = 'triple';
    multiplier = 3;
    labelPrefix = 'T';
  } else {
    kind = 'single';
    multiplier = 1;
    labelPrefix = '';
  }

  return {
    kind,
    segment,
    multiplier,
    score: segment * multiplier,
    label: `${labelPrefix}${segment}`,
  };
}

/**
 * 과녁 중심 기준 좌표의 각도 → 세그먼트 번호(1~20).
 *
 * 내부 로직:
 *   atan2(y, x) 는 +x축을 0, y+ 방향으로 증가 (canvas 관습에서 12시는 -π/2).
 *   다트보드는 12시 방향(각도 −π/2)이 20의 중심 → 이 방향을 "0"으로 맞춘 뒤,
 *   세그먼트 arc(π/10)의 절반만큼 오프셋 보정해서 반올림 인덱스로 변환.
 */
function angleToSegment(x: number, y: number): number {
  // 12시 방향이 0이 되도록 +π/2 오프셋 (canvas y가 아래쪽이라 그대로 더하면 12시=0)
  let angle = Math.atan2(y, x) + Math.PI / 2;
  // 양수 범위로 정규화
  if (angle < 0) angle += Math.PI * 2;
  // 각 세그먼트 경계는 ±(SEGMENT_ARC / 2). 오프셋 후 floor.
  const idx = Math.floor((angle + SEGMENT_ARC / 2) / SEGMENT_ARC) % 20;
  return SEGMENTS[idx]!;
}

// ============================================
// Cricket 전용 헬퍼
// ============================================

/** Cricket 모드에서 유효한 타겟 섹터들 */
export const CRICKET_TARGETS = [15, 16, 17, 18, 19, 20] as const;
export type CricketTarget = typeof CRICKET_TARGETS[number] | 'bull';

/**
 * 히트 결과를 Cricket 타겟과 마킹 수로 변환.
 * - segment 15~20 맞히면 그 번호 + multiplier 만큼 마킹
 * - outer-bull / inner-bull 은 'bull' 타겟 (inner=+2, outer=+1)
 * - 그 외는 target=null (무효)
 */
export function cricketMarking(
  hit: HitResult,
): { target: CricketTarget | null; marks: number } {
  // Bull 계열
  if (hit.kind === 'inner-bull') return { target: 'bull', marks: 2 };
  if (hit.kind === 'outer-bull') return { target: 'bull', marks: 1 };

  // 일반 세그먼트: 15~20만 인정
  if (hit.segment >= 15 && hit.segment <= 20) {
    return { target: hit.segment as CricketTarget, marks: hit.multiplier };
  }
  return { target: null, marks: 0 };
}
