/**
 * 꼬들 — 순수 규칙 모듈 (DOM·네트워크 없음)
 *
 * 핵심은 **완전 풀어쓰기**: 한글을 기본 자모 24개(자음 14 + 모음 10)로만 쪼갠다.
 * 쌍자음·복합모음·복합받침은 전부 기본 자모의 조합으로 펼친다.
 *   ㅐ = ㅏ+ㅣ   ㄲ = ㄱ+ㄱ   ㅘ = ㅗ+ㅏ   ㅙ = ㅗ+ㅏ+ㅣ (3칸)   ㄺ = ㄹ+ㄱ
 * 그래서 "사과" 는 5칸(ㅅㅏㄱㅗㅏ), "백화점" 은 10칸이 된다.
 *
 * 왜 이렇게 쪼개나: 화면 키보드에 눌러야 할 키가 24개로 고정돼서 Wordle 처럼 깔끔하다.
 * ㅐ·ㄲ 까지 따로 키를 두면 40키가 넘고, 🟩 피드백도 "ㅐ 는 맞고 ㅏ 는 틀림" 같은 모순이 생긴다.
 */

// ============================================
// 1. 자모 분해
// ============================================

/** 초성 19개 → 기본 자모 전개 (쌍자음은 같은 자음 2개) */
const CHO = [
  'ㄱ', 'ㄱㄱ', 'ㄴ', 'ㄷ', 'ㄷㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅂㅂ', 'ㅅ',
  'ㅅㅅ', 'ㅇ', 'ㅈ', 'ㅈㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

/** 중성 21개 → 기본 모음 전개. ㅙ/ㅞ 만 3칸을 먹는다 */
const JUNG = [
  'ㅏ', 'ㅏㅣ', 'ㅑ', 'ㅑㅣ', 'ㅓ', 'ㅓㅣ', 'ㅕ', 'ㅕㅣ', 'ㅗ', 'ㅗㅏ', 'ㅗㅏㅣ',
  'ㅗㅣ', 'ㅛ', 'ㅜ', 'ㅜㅓ', 'ㅜㅓㅣ', 'ㅜㅣ', 'ㅠ', 'ㅡ', 'ㅡㅣ', 'ㅣ',
] as const;

/** 종성 28개 (0번은 받침 없음) → 기본 자음 전개 */
const JONG = [
  '', 'ㄱ', 'ㄱㄱ', 'ㄱㅅ', 'ㄴ', 'ㄴㅈ', 'ㄴㅎ', 'ㄷ', 'ㄹ', 'ㄹㄱ', 'ㄹㅁ',
  'ㄹㅂ', 'ㄹㅅ', 'ㄹㅌ', 'ㄹㅍ', 'ㄹㅎ', 'ㅁ', 'ㅂ', 'ㅂㅅ', 'ㅅ', 'ㅅㅅ',
  'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;

/** 화면 키보드 배열 — 두벌식에서 Shift 키(쌍자음·ㅐㅔ)를 뺀 모양. 합쳐서 정확히 24개 */
export const JAMO_ROWS: readonly (readonly string[])[] = [
  ['ㅂ', 'ㅈ', 'ㄷ', 'ㄱ', 'ㅅ', 'ㅛ', 'ㅕ', 'ㅑ'],
  ['ㅁ', 'ㄴ', 'ㅇ', 'ㄹ', 'ㅎ', 'ㅗ', 'ㅓ', 'ㅏ', 'ㅣ'],
  ['ㅋ', 'ㅌ', 'ㅊ', 'ㅍ', 'ㅠ', 'ㅜ', 'ㅡ'],
];

/** 유효한 기본 자모 24개 집합 (분해 결과 검산용) */
const ALPHABET: ReadonlySet<string> = new Set(JAMO_ROWS.flat());

/**
 * 한글 단어 → 기본 자모 배열. 한글 음절이 아닌 글자가 하나라도 있으면 null.
 * (공백·숫자·영문·자모 단독 입력 'ㄱ' 등은 전부 거부 — 경계 검증이라 여기서 막는다)
 */
export function decompose(word: string): string[] | null {
  const out: string[] = [];
  for (const ch of word) {
    const code = ch.codePointAt(0)!;
    if (code < HANGUL_BASE || code > HANGUL_LAST) return null;
    const idx = code - HANGUL_BASE;
    out.push(...CHO[Math.floor(idx / 588)]!);
    out.push(...JUNG[Math.floor((idx % 588) / 28)]!);
    out.push(...JONG[idx % 28]!);
  }
  // 전개 결과가 전부 기본 자모인지 확인 (표가 틀리면 여기서 걸린다)
  return out.every((j) => ALPHABET.has(j)) ? out : null;
}

/**
 * 호환 자모(U+3131~U+3163) → 기본 자모 전개.
 * 한글 IME 로 치면 완성 전 글자가 'ㄷ' 같은 **단독 자모**로 들어온다.
 * 완성형 음절이 아니라 decompose 가 거부하므로, 입력 중 표시용으로 따로 편다.
 */
const COMPAT: Record<string, string> = {
  'ㄱ':'ㄱ','ㄲ':'ㄱㄱ','ㄳ':'ㄱㅅ','ㄴ':'ㄴ','ㄵ':'ㄴㅈ','ㄶ':'ㄴㅎ','ㄷ':'ㄷ','ㄸ':'ㄷㄷ',
  'ㄹ':'ㄹ','ㄺ':'ㄹㄱ','ㄻ':'ㄹㅁ','ㄼ':'ㄹㅂ','ㄽ':'ㄹㅅ','ㄾ':'ㄹㅌ','ㄿ':'ㄹㅍ','ㅀ':'ㄹㅎ',
  'ㅁ':'ㅁ','ㅂ':'ㅂ','ㅃ':'ㅂㅂ','ㅄ':'ㅂㅅ','ㅅ':'ㅅ','ㅆ':'ㅅㅅ','ㅇ':'ㅇ','ㅈ':'ㅈ',
  'ㅉ':'ㅈㅈ','ㅊ':'ㅊ','ㅋ':'ㅋ','ㅌ':'ㅌ','ㅍ':'ㅍ','ㅎ':'ㅎ',
  'ㅏ':'ㅏ','ㅐ':'ㅏㅣ','ㅑ':'ㅑ','ㅒ':'ㅑㅣ','ㅓ':'ㅓ','ㅔ':'ㅓㅣ','ㅕ':'ㅕ','ㅖ':'ㅕㅣ',
  'ㅗ':'ㅗ','ㅘ':'ㅗㅏ','ㅙ':'ㅗㅏㅣ','ㅚ':'ㅗㅣ','ㅛ':'ㅛ','ㅜ':'ㅜ','ㅝ':'ㅜㅓ','ㅞ':'ㅜㅓㅣ',
  'ㅟ':'ㅜㅣ','ㅠ':'ㅠ','ㅡ':'ㅡ','ㅢ':'ㅡㅣ','ㅣ':'ㅣ',
};

/**
 * **입력 중인** 글자를 자모로 편다. 완성형 음절(가~힣)과 단독 자모(ㄷ, ㅘ …)를 둘 다 받는다.
 * 한글 IME 가 "돼" 를 만들기까지 ㄷ → 도 → 돠 → 돼 로 바뀌는데, 매 단계가 전부 펼쳐져서
 * 결과적으로 ㄷ ㅗ ㅏ ㅣ 가 칸에 하나씩 쌓이는 것처럼 보인다.
 * 한글이 아닌 글자가 섞이면 null.
 */
export function decomposeInput(text: string): string[] | null {
  const out: string[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= HANGUL_BASE && code <= HANGUL_LAST) {
      const idx = code - HANGUL_BASE;
      out.push(...CHO[Math.floor(idx / 588)]!);
      out.push(...JUNG[Math.floor((idx % 588) / 28)]!);
      out.push(...JONG[idx % 28]!);
    } else if (COMPAT[ch]) {
      out.push(...COMPAT[ch]!);
    } else {
      return null;
    }
  }
  return out;
}

/** 기본 모음 10개 — 종성/초성 판별에 쓴다 */
const VOWELS: ReadonlySet<string> = new Set('ㅏㅑㅓㅕㅗㅛㅜㅠㅡㅣ');

/** 전개문자열 → 인덱스 역방향 표 (조합용) */
function reverseOf(table: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  table.forEach((v, i) => { if (v) m.set(v, i); });
  return m;
}
const CHO_REV = reverseOf(CHO);
const JUNG_REV = reverseOf(JUNG);
const JONG_REV = reverseOf(JONG);

/**
 * 기본 자모 배열을 한글 단어로 **되돌릴 수 있는 모든 경우**를 훑어서,
 * `accept` 가 참을 주는 첫 단어를 돌려준다. 없으면 null.
 *
 * ⚠️ 완전 풀어쓰기는 **역연산이 하나로 안 떨어진다.**
 *     각가이 = ㄱㅏㄱ + ㄱㅏ + ㅇㅣ
 *     가까이 = ㄱㅏ  + ㄱㄱㅏ + ㅇㅣ   → 자모 배열이 똑같다
 *   그래서 "하나로 합치기" 는 애초에 불가능하고, 사전 조회처럼
 *   "가능한 조합 중 쓸 만한 게 있나" 를 묻는 식으로만 쓸 수 있다.
 *
 * 탐색은 음절 단위 백트래킹 — 초성(2|1) × 중성(3|2|1) × 종성(2|1|없음).
 * 단어가 길어야 자모 12개(음절 6개)라 가지 수가 금방 말라붙는다.
 */
export function findComposition(
  jamo: readonly string[],
  accept: (word: string) => boolean,
): string | null {
  const rec = (i: number, acc: string): string | null => {
    if (i >= jamo.length) return accept(acc) ? acc : null;
    for (const cl of [2, 1]) {
      const cho = CHO_REV.get(jamo.slice(i, i + cl).join(''));
      if (cho === undefined) continue;
      for (const vl of [3, 2, 1]) {
        const jung = JUNG_REV.get(jamo.slice(i + cl, i + cl + vl).join(''));
        if (jung === undefined) continue;
        const base = i + cl + vl;
        for (const tl of [2, 1, 0]) {
          let jong = 0;
          if (tl > 0) {
            const idx = JONG_REV.get(jamo.slice(base, base + tl).join(''));
            if (idx === undefined) continue;
            jong = idx;
          }
          const ch = String.fromCharCode(HANGUL_BASE + (cho * 21 + jung) * 28 + jong);
          const hit = rec(base + tl, acc + ch);
          if (hit !== null) return hit;
        }
      }
    }
    return null;
  };
  return rec(0, '');
}

/** 보여주기용 — 조합 가능한 아무 단어나 하나 (없으면 null) */
export function composeAny(jamo: readonly string[]): string | null {
  return findComposition(jamo, () => true);
}

/**
 * 물리 키 → 기본 자모 (두벌식 자리 그대로).
 * `event.code` 로 보기 때문에 **한영 상태와 무관하게** 동작하고,
 * ㅐ(KeyO)·ㅔ(KeyP)·쌍자음(Shift) 은 아예 매핑이 없어서 자연히 막힌다.
 */
export const KEY_TO_JAMO: Readonly<Record<string, string>> = {
  KeyQ: 'ㅂ', KeyW: 'ㅈ', KeyE: 'ㄷ', KeyR: 'ㄱ', KeyT: 'ㅅ',
  KeyY: 'ㅛ', KeyU: 'ㅕ', KeyI: 'ㅑ',
  KeyA: 'ㅁ', KeyS: 'ㄴ', KeyD: 'ㅇ', KeyF: 'ㄹ', KeyG: 'ㅎ',
  KeyH: 'ㅗ', KeyJ: 'ㅓ', KeyK: 'ㅏ', KeyL: 'ㅣ',
  KeyZ: 'ㅋ', KeyX: 'ㅌ', KeyC: 'ㅊ', KeyV: 'ㅍ',
  KeyB: 'ㅠ', KeyN: 'ㅜ', KeyM: 'ㅡ',
};

// ============================================
// 2. 채점
// ============================================

/** 칸 하나의 판정 — 자리까지 맞음 / 있지만 자리 틀림 / 없음 */
export type Mark = 'hit' | 'present' | 'miss';

/**
 * Wordle 채점. 중복 자모 처리 때문에 **2패스**로 간다.
 *   1패스: 자리까지 맞는 칸(hit)을 먼저 확정하고, 그만큼 정답 쪽 재고를 깎는다.
 *   2패스: 남은 재고가 있는 자모만 present. 재고를 안 깎으면
 *          정답에 ㅇ 이 1개인데 추측에 3개일 때 3개 모두 노랑이 되는 버그가 난다.
 */
export function judgeGuess(guess: readonly string[], answer: readonly string[]): Mark[] {
  const marks: Mark[] = new Array(guess.length).fill('miss');
  const pool = new Map<string, number>();

  for (let i = 0; i < answer.length; i++) {
    const a = answer[i]!;
    if (guess[i] === a) marks[i] = 'hit';
    else pool.set(a, (pool.get(a) ?? 0) + 1);
  }
  for (let i = 0; i < guess.length; i++) {
    if (marks[i] === 'hit') continue;
    const g = guess[i]!;
    const left = pool.get(g) ?? 0;
    if (left > 0) {
      marks[i] = 'present';
      pool.set(g, left - 1);
    }
  }
  return marks;
}

/** 자모별 키보드 색 — 더 좋은 결과만 남긴다 (miss 였어도 나중에 hit 이면 hit) */
const RANK: Record<Mark, number> = { miss: 0, present: 1, hit: 2 };

export function mergeKeyboard(
  prev: Readonly<Record<string, Mark>>,
  guess: readonly string[],
  marks: readonly Mark[],
): Record<string, Mark> {
  const next: Record<string, Mark> = { ...prev };
  for (let i = 0; i < guess.length; i++) {
    const j = guess[i]!;
    const m = marks[i]!;
    const cur = next[j];
    if (cur === undefined || RANK[m] > RANK[cur]) next[j] = m;
  }
  return next;
}

// ============================================
// 3. 점수
// ============================================

/** 한 라운드 최대 시도 횟수 */
export const MAX_TRIES = 6;

export const SCORE_BASE = 100;
/** 시도 1회당 차감 */
export const SCORE_PER_TRY = 10;
/** 경과 10초당 1점 차감 */
export const SCORE_TIME_UNIT_MS = 10_000;

/**
 * 라운드 점수 = 100 − (시도 × 10) − (경과 10초당 1). 못 맞히면 0, 음수면 0.
 * 시간보다 시도 횟수를 훨씬 무겁게 둬서 "찍어서 빨리" 보다 "추리해서" 가 이기게 했다.
 */
export function roundScore(solved: boolean, tries: number, elapsedMs: number): number {
  if (!solved) return 0;
  const penalty = tries * SCORE_PER_TRY + Math.floor(elapsedMs / SCORE_TIME_UNIT_MS);
  return Math.max(0, SCORE_BASE - penalty);
}

// ============================================
// 4. 방 옵션 / 상태 타입
// ============================================

/** 고를 수 있는 칸 수 */
export type JamoLen = 6 | 12;

export function parseJamoLen(raw: string | undefined): JamoLen {
  return raw === '12' ? 12 : 6;
}

/** 0 이면 무제한 (둘이서 계속 노는 모드) */
export function parseRounds(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 라운드 진행 단계.
 * - 'setword'  출제자가 단어를 정하는 중 (1인 모드는 건너뛴다 — 랜덤 정답)
 * - 'guess'    맞히는 중
 * - 'reveal'   라운드 끝, 정답 공개 + 점수 정산
 * - 'ended'    게임 종료
 */
export type Phase = 'setword' | 'guess' | 'reveal' | 'ended';

/** 한 사람의 이번 라운드 진행 상황 */
export interface PlayerRound {
  /** 제출한 추측들 (완성형 한글) */
  guesses: string[];
  /** 각 추측의 채점 결과 */
  marks: Mark[][];
  solved: boolean;
  /** 6번 다 쓰고 못 맞힘 */
  failed: boolean;
  /** 맞힌(또는 소진한) 시각까지 걸린 ms. 아직 진행 중이면 null */
  elapsedMs: number | null;
  /** 이번 라운드에서 번 점수 (reveal 시 확정) */
  score: number;
}

export function emptyPlayerRound(): PlayerRound {
  return { guesses: [], marks: [], solved: false, failed: false, elapsedMs: null, score: 0 };
}

/** 그 사람이 이번 라운드를 끝냈는지 (맞혔거나 6번 다 씀) */
export function isDone(r: PlayerRound): boolean {
  return r.solved || r.failed;
}
