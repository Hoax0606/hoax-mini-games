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

export const TERRAIN_WIDTH = 800;
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
export function generateTerrain(seed: number): number[] {
  const rng = mulberry32(seed);
  // 겹겹의 사인파 — 낮은 주파수(큰 언덕) + 높은 주파수(잔굴곡)
  const layers = [
    { amp: 55 + rng() * 35, freq: (0.6 + rng() * 0.5) / 100, phase: rng() * Math.PI * 2 },
    { amp: 22 + rng() * 18, freq: (1.4 + rng() * 0.8) / 100, phase: rng() * Math.PI * 2 },
    { amp: 10 + rng() * 8,  freq: (3.0 + rng() * 1.5) / 100, phase: rng() * Math.PI * 2 },
  ];
  const hm = new Array<number>(TERRAIN_WIDTH);
  for (let x = 0; x < TERRAIN_WIDTH; x++) {
    let h = BASE_Y;
    for (const l of layers) h -= l.amp * Math.sin(l.freq * x + l.phase);
    hm[x] = Math.max(MIN_TOP, Math.min(MAX_TOP, h));
  }
  return hm;
}

/** 안전한 지면 높이 조회 (x 범위 밖은 가장자리 값) */
export function terrainTopAt(hm: number[], x: number): number {
  const ix = Math.max(0, Math.min(TERRAIN_WIDTH - 1, Math.round(x)));
  return hm[ix]!;
}

/**
 * 착탄 지점(cx, cy) 중심 반지름 r 의 원형으로 지면을 깎는다 (크레이터).
 *   지면 top 을 아래로 내려(값 증가) 파인 구덩이를 만든다. heightmap 을 직접 mutate.
 */
export function carveCrater(hm: number[], cx: number, cy: number, r: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(TERRAIN_WIDTH - 1, Math.ceil(cx + r));
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
