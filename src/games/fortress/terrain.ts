/**
 * 포트리스 지형 — 높이맵 기반 (사이드뷰)
 *
 * 좌표계 (canvas 논리 800×400):
 *   x = 0~799 (가로), y = 0(위) ~ 400(아래).
 *   heightmap[x] = 그 x 위치의 "지면 top y". 값이 작을수록 높은 산.
 *   지면은 heightmap[x] ~ 400 (아래) 까지 흙으로 채워짐.
 *
 * 결정론적 생성:
 *   호스트가 seed 하나만 정해 sync 하면 모든 클라가 동일 지형 생성.
 *   크레이터도 착탄점(결정론)만 공유하면 동일하게 파괴 → 높이맵 통째 전송 불필요.
 *
 * 파괴:
 *   착탄 지점 중심 반원으로 지면을 아래로 깎는다(= heightmap 값 증가).
 */

/** 기본(2인) 지형 폭 = canvas 논리 폭 */
export const TERRAIN_WIDTH = 800;
/** 논리 세로(고정) */
export const TERRAIN_HEIGHT = 400;

/** 인원수에 따른 지형 폭 — 많을수록 넓게 (2인 800 → 6인 1320). (구버전 호환용) */
export function mapWidthForPlayers(n: number): number {
  return TERRAIN_WIDTH + Math.max(0, n - 2) * 130;
}

/** 포대 '개수' 기준 지형 폭 — 카메라 스크롤 전제. 포대당 ~190px + 여백, 최소 900. */
export function mapWidthForForts(fortCount: number): number {
  const MARGIN = 90;
  const SPACING = 190;
  return Math.max(900, MARGIN * 2 + Math.max(0, fortCount - 1) * SPACING);
}

/** 지면 평균 top y. 이 아래로 흙. 위쪽(0~) 은 하늘 = 포탄 궤적 공간. */
const BASE_Y = 300;
/** 지면 top y 허용 범위 (너무 높거나 낮지 않게) */
const MIN_TOP = 150;
const MAX_TOP = 385;

/** 결정론적 PRNG (mulberry32) — 같은 seed → 같은 난수열 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * seed 로 부드러운 언덕 지형 생성. 사인파 3겹 합성.
 * 반환: 길이 TERRAIN_WIDTH 의 높이맵 (각 x 의 지면 top y).
 */
export function generateTerrain(seed: number, width: number = TERRAIN_WIDTH): number[] {
  const rng = mulberry32(seed);
  // 겹겹의 사인파 — 낮은 주파수(큰 언덕) + 높은 주파수(잔굴곡)
  // 겹겹 사인파 — 큰 언덕(낮은 주파수) + 중간 굴곡 + 잔굴곡. 넓은 맵에 지형이 밋밋하지 않게 진폭을 키움.
  const layers = [
    { amp: 68 + rng() * 42, freq: (0.5 + rng() * 0.45) / 100, phase: rng() * Math.PI * 2 },
    { amp: 32 + rng() * 22, freq: (1.1 + rng() * 0.7) / 100, phase: rng() * Math.PI * 2 },
    { amp: 15 + rng() * 11, freq: (2.4 + rng() * 1.3) / 100, phase: rng() * Math.PI * 2 },
    { amp: 7  + rng() * 6,  freq: (4.4 + rng() * 2.0) / 100, phase: rng() * Math.PI * 2 },
  ];
  const hm = new Array<number>(width);
  for (let x = 0; x < width; x++) {
    let h = BASE_Y;
    for (const l of layers) h -= l.amp * Math.sin(l.freq * x + l.phase);
    hm[x] = Math.max(MIN_TOP, Math.min(MAX_TOP, h));
  }
  return hm;
}

/** 안전한 지면 높이 조회 (x 범위 밖은 가장자리 값) */
export function terrainTopAt(hm: number[], x: number): number {
  const ix = Math.max(0, Math.min(hm.length - 1, Math.round(x)));
  return hm[ix]!;
}

/**
 * 착탄 지점(cx, cy) 중심 반지름 r 의 원형으로 지면을 깎는다 (크레이터).
 *   지면 top 을 아래로 내려(값 증가) 파인 구덩이를 만든다. heightmap 을 직접 mutate.
 */
export function carveCrater(hm: number[], cx: number, cy: number, r: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(hm.length - 1, Math.ceil(cx + r));
  for (let x = x0; x <= x1; x++) {
    const dx = x - cx;
    const inside = r * r - dx * dx;
    if (inside <= 0) continue;
    const dy = Math.sqrt(inside);
    // 크레이터 바닥 = 착탄점 아래로 dy 만큼. 기존 지면보다 낮으면(값 크면) 내려서 파냄.
    const craterBottom = cy + dy;
    if (craterBottom > hm[x]!) {
      hm[x] = Math.min(MAX_TOP + 10, craterBottom);
    }
  }
}
