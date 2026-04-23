/**
 * 시드 기반 난수 생성기 (Mulberry32)
 *
 * 사과 게임은 모든 플레이어가 **같은 보드**로 시작해야 공정함.
 * 호스트가 seed 를 하나 만들어 broadcast → 각자 같은 seed 로 Mulberry32 를 돌리면
 * 완전히 동일한 보드가 나온다.
 *
 * 왜 Mulberry32?
 *   구현이 7줄이고 분포도 균일하다. 암호용은 아니지만 게임용으론 충분.
 *   Math.random() 은 seed 지정이 불가능해서 못 쓴다.
 */

/** 0~2^32-1 범위 정수 seed 생성 (호스트가 게임 시작 시 한 번 뽑음) */
export function createRandomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/**
 * Mulberry32 — seed 로 초기화하는 결정적 PRNG.
 * 반환값은 호출할 때마다 0~1 사이 실수. 내부 state 는 32비트 정수 하나.
 */
export function createRng(seed: number): () => number {
  // 내부 state — 매 호출마다 갱신됨
  let state = seed >>> 0;
  return function next(): number {
    // 32비트 연산으로 state 를 섞어서 0~2^32-1 정수로 변환 → 0~1 실수
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0 <= result < max 인 정수 반환 (rng 는 createRng 결과) */
export function randInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}
