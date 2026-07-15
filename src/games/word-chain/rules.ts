/**
 * 끝말잇기 — 게임 상태 + 단어 검증 + 두음법칙 처리
 *
 * 핵심 규칙:
 *   - 2~6인 턴제. 한 턴 30초 제한
 *   - 이전 단어의 마지막 글자로 시작하는 단어 입력
 *   - 두음법칙 자동 허용 — 끝 글자가 'ㄹ' 초성이면 'ㄴ' 또는 'ㅇ' 으로 시작 가능
 *     예: "녹색" 끝나면 다음 시작 후보 = "녹X" 또는 "록X" (한자어 두음)
 *     예: "려행"으로 끝 → "여행" / "려행" 양쪽 OK (실제로는 "려행" 자체가 부자연스럽지만 룰)
 *   - 같은 단어 두 번 X (게임 내 중복 금지)
 *   - 사전(dictionary.ts) 에 있는 단어만 허용 (엄격 검증)
 *   - 첫 단어는 호스트가 무작위 풀에서 골라 시작
 *
 * 한글 유니코드:
 *   가(U+AC00) ~ 힣(U+D7A3). 음절 = 초성 19개 × 중성 21개 × 종성 28개.
 *   (음절코드 - 0xAC00) = 초성*588 + 중성*28 + 종성
 *
 * 두음법칙 (간이판):
 *   ㄹ → ㄴ, ㄴ → ㅇ 변환을 시작 글자에서만 인정.
 *   예: "ㄹ" 초성으로 시작하는 단어는 같은 중성·종성을 가진 "ㄴ" 초성 형태로도 시작 가능.
 *   예: 락 (ㄹ+ㅏ+ㄱ) → 낙 (ㄴ+ㅏ+ㄱ) 도 OK.
 *   엄밀한 사전적 두음법칙은 더 복잡하지만 친구용 게임 수준에서는 이걸로 충분.
 */

import { isInDictionary, getRandomSeedWord } from './dictionary';

// ============================================
// 한글 음절 유틸
// ============================================

const HANGUL_BASE = 0xAC00;
const HANGUL_END = 0xD7A3;

/** 한 음절이 한글 음절인지. (ㄱ, ㅏ 같은 자모 단독은 false) */
function isHangulSyllable(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return code >= HANGUL_BASE && code <= HANGUL_END;
}

/** 단어 전체가 한글 음절로만 구성됐는지 + 길이 2 이상 */
export function isValidHangulWord(word: string): boolean {
  if (word.length < 2) return false;
  for (let i = 0; i < word.length; i++) {
    if (!isHangulSyllable(word[i]!)) return false;
  }
  return true;
}

/** 음절 → 초성 인덱스 (0~18). 한글 음절 아니면 -1. */
function getInitial(syl: string): number {
  if (!isHangulSyllable(syl)) return -1;
  return Math.floor((syl.charCodeAt(0) - HANGUL_BASE) / 588);
}

/** 음절 → 중성 인덱스 (0~20) + 종성 인덱스 (0~27). */
function getJungJong(syl: string): { jung: number; jong: number } {
  const offset = syl.charCodeAt(0) - HANGUL_BASE;
  const remainder = offset % 588;
  return { jung: Math.floor(remainder / 28), jong: remainder % 28 };
}

/** 초성/중성/종성 인덱스 → 한글 음절 */
function composeSyllable(initial: number, jung: number, jong: number): string {
  return String.fromCharCode(HANGUL_BASE + initial * 588 + jung * 28 + jong);
}

// 초성 인덱스: 0=ㄱ 1=ㄲ 2=ㄴ 3=ㄷ 4=ㄸ 5=ㄹ 6=ㅁ 7=ㅂ 8=ㅃ 9=ㅅ 10=ㅆ 11=ㅇ 12=ㅈ 13=ㅉ 14=ㅊ 15=ㅋ 16=ㅌ 17=ㅍ 18=ㅎ
const INIT_R = 5;
const INIT_N = 2;
const INIT_IEUNG = 11;

// 중성 인덱스 중 "반모음 ㅣ(y) 계열" — 두음법칙에서 ㅇ 으로 바뀌는 모음.
//   2=ㅑ 3=ㅒ 6=ㅕ 7=ㅖ 12=ㅛ 17=ㅠ 20=ㅣ
const IOTIZED_JUNG = new Set([2, 3, 6, 7, 12, 17, 20]);

/**
 * 어떤 글자로 다음 단어를 시작할 수 있는가 — 두음법칙 변환 포함한 허용 시작 글자 집합.
 *
 * 두음법칙 (한국어 표준):
 *   - 초성 ㄹ + ㅣ계열 모음 → ㅇ  (력→역, 료→요, 류→유, 리→이, 례→예)
 *   - 초성 ㄹ + 그 외 모음   → ㄴ  (라→나, 로→노, 루→누, 래→내, 뢰→뇌)
 *   - 초성 ㄴ + ㅣ계열 모음 → ㅇ  (녀→여, 뇨→요, 뉴→유, 니→이)
 *   - 원래 글자 자체도 항상 허용 (그냥 ㄹ/ㄴ 로 시작하는 단어도 OK)
 *
 * 예: '력' → {'력','역'}, '로' → {'로','노'}, '녀' → {'녀','여'}, '가' → {'가'}
 */
export function allowedStartLetters(lastChar: string): Set<string> {
  const out = new Set<string>([lastChar]);
  const init = getInitial(lastChar);
  if (init < 0) return out;
  const { jung, jong } = getJungJong(lastChar);
  const iotized = IOTIZED_JUNG.has(jung);
  if (init === INIT_R) {
    out.add(composeSyllable(iotized ? INIT_IEUNG : INIT_N, jung, jong));
  } else if (init === INIT_N && iotized) {
    out.add(composeSyllable(INIT_IEUNG, jung, jong));
  }
  return out;
}

// ============================================
// 게임 상태
// ============================================

export type PlayerIndex = number; // 좌석(플레이어) 인덱스 0..N-1 (최대 10인)

export interface PlayerMeta {
  peerId: string;
  nickname: string;
  index: PlayerIndex;
  /** 탈락했으면 false. 마지막 한 명 남으면 우승 */
  alive: boolean;
  /** 탈락 사유 (UI 표시용) */
  outReason?: 'timeout' | 'invalid' | 'duplicate' | 'wrongStart' | 'notInDict';
}

export interface WordEntry {
  word: string;
  byPeerId: string;
  byNickname: string;
}

export type GamePhase = 'waiting' | 'aiming' | 'ended';

export interface WordChainGame {
  /** 0~3. 현재 차례 플레이어 (alive 인 사람만 순환) */
  currentTurn: PlayerIndex;
  phase: GamePhase;
  /** 지금까지 제출된 단어들 — 마지막 게 다음 시작 글자 결정 */
  history: WordEntry[];
  /** history 의 모든 단어를 lowercase set 으로 — 중복 검사 빠르게. 한글이라 lowercase 무관. */
  usedWords: Set<string>;
  players: PlayerMeta[];
  /** 현재 턴 시작 시각 (performance.now). 호스트가 timeout 판정 */
  turnStartedAt: number;
  /** 우승자 peerId. 무승부면 null */
  winnerPeerId: string | null;
}

export const TURN_TIME_MS = 30_000;
export const TIMEOUT_GRACE_MS = 500;

/**
 * 라운드가 길어질수록 제한 시간 단축 (긴장감).
 *   제출된 단어 10개마다 5초씩 감소, 하한 15초.
 *   (0~9단어: 30초 / 10~19: 25 / 20~29: 20 / 30+: 15)
 * @param wordCount 지금까지 제출된 단어 수 (game.history.length — 시드 포함이라 대략치로 충분)
 */
export function getTurnTimeMs(wordCount: number): number {
  const reduced = TURN_TIME_MS - Math.floor(wordCount / 10) * 5_000;
  return Math.max(15_000, reduced);
}

// ============================================
// 초기 게임 생성
// ============================================

/**
 * 플레이어 peerId 목록 → 결정론적 정수 시드.
 *
 * 왜 필요한가: 시작 단어를 각 클라이언트가 각자 Math.random 으로 뽑으면 서로 달라진다.
 *   원래는 호스트 wc:sync 로 맞췄지만, 호스트 게임모듈이 아직 로딩 중일 때 게스트의
 *   hello 가 도착하면 sync 응답을 놓쳐 그 게스트만 자기 랜덤 단어로 굳는 버그가 있었음.
 *   → 모든 클라이언트가 공유하는 값(플레이어 peerId 집합)에서 시드를 뽑으면
 *     sync 없이도 시작 단어가 전원 동일해진다. (peerId 목록은 roomState 로 이미 공유됨)
 *
 * 순서 무관하게 같은 값이 나오도록 정렬 후 해시(djb2 변형).
 */
export function seedFromPeers(peerIds: string[]): number {
  const joined = [...peerIds].sort().join('|');
  let h = 5381;
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) + h + joined.charCodeAt(i)) | 0; // h*33 + c, 32비트로 유지
  }
  return Math.abs(h);
}

export function createInitialGame(
  players: Array<{ peerId: string; nickname: string }>,
  rngSeed?: number,
): WordChainGame {
  if (players.length < 2 || players.length > 10) {
    throw new Error(`끝말잇기는 2~10인만 지원해요 (현재 ${players.length}인)`);
  }
  const seedWord = getRandomSeedWord(rngSeed);
  const playerMetas: PlayerMeta[] = players.map((p, idx) => ({
    peerId: p.peerId,
    nickname: p.nickname,
    index: idx as PlayerIndex,
    alive: true,
  }));
  return {
    currentTurn: 0,
    phase: 'aiming',
    history: [{ word: seedWord, byPeerId: '', byNickname: '시작' }],
    usedWords: new Set([seedWord]),
    players: playerMetas,
    turnStartedAt: 0, // 시작 시점에 host 가 세팅
    winnerPeerId: null,
  };
}

// ============================================
// 단어 제출 검증
// ============================================

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'wrongStart' | 'duplicate' | 'notInDict'; message: string };

/**
 * (호스트만 호출) 제출된 단어 검증.
 * 1) 한글 음절 2자 이상
 * 2) 시작 글자가 이전 마지막 글자의 두음 변형 후보 안에 있는지
 * 3) 중복 사용 안 됐는지
 * 4) 사전에 있는지
 */
export function validateSubmission(game: WordChainGame, word: string): SubmitResult {
  const trimmed = word.trim();
  if (!isValidHangulWord(trimmed)) {
    return { ok: false, reason: 'invalid', message: '한글 두 글자 이상의 단어만 가능해요' };
  }
  // 같은 글자만 반복되는 단어(라라, 고고, 가가가 등) 금지
  if (new Set([...trimmed]).size === 1) {
    return { ok: false, reason: 'invalid', message: '같은 글자만 반복되는 단어는 안 돼요' };
  }
  const lastWord = game.history[game.history.length - 1]!.word;
  const lastChar = lastWord[lastWord.length - 1]!;
  const allowed = allowedStartLetters(lastChar);
  if (!allowed.has(trimmed[0]!)) {
    return {
      ok: false,
      reason: 'wrongStart',
      message: `"${[...allowed].join(' / ')}" 로 시작해야 해요`,
    };
  }
  if (game.usedWords.has(trimmed)) {
    return { ok: false, reason: 'duplicate', message: '이미 나온 단어예요' };
  }
  if (!isInDictionary(trimmed)) {
    return { ok: false, reason: 'notInDict', message: '사전에 없는 단어예요' };
  }
  return { ok: true };
}

/** 단어를 history 에 추가하고 다음 턴으로 넘어감. 호스트만 호출. */
export function applySubmission(game: WordChainGame, word: string, byPeerId: string, byNickname: string, now: number): void {
  game.history.push({ word, byPeerId, byNickname });
  game.usedWords.add(word);
  game.currentTurn = getNextTurn(game);
  game.turnStartedAt = now;
}

// ============================================
// 탈락 처리 / 턴 진행 / 승패
// ============================================

/**
 * 다음 턴 — 현재 좌석 "다음 위치"부터 한 바퀴 돌며 처음 살아있는 사람.
 * 현재 플레이어가 탈락(타임아웃)해도 좌석 순서를 유지한다.
 * (과거 aliveIdx.indexOf(-1)→0 으로 최저 인덱스로 점프해 뒤 사람을 건너뛰던 버그 수정)
 */
export function getNextTurn(game: WordChainGame): PlayerIndex {
  const n = game.players.length;
  if (n === 0) return 0;
  for (let step = 1; step <= n; step++) {
    const cand = ((game.currentTurn + step) % n) as PlayerIndex;
    const p = game.players.find((pp) => pp.index === cand);
    if (p && p.alive) return cand;
  }
  return game.currentTurn;
}

/** 플레이어를 탈락 처리하고 다음 턴으로 넘어감. 한 명만 살아남으면 phase='ended' + winnerPeerId. */
export function eliminatePlayer(
  game: WordChainGame,
  victimIndex: PlayerIndex,
  reason: PlayerMeta['outReason'],
  now: number,
): { ended: boolean } {
  const victim = game.players.find((p) => p.index === victimIndex);
  if (!victim || !victim.alive) return { ended: false };
  victim.alive = false;
  victim.outReason = reason;

  const survivors = game.players.filter((p) => p.alive);
  if (survivors.length <= 1) {
    game.phase = 'ended';
    game.winnerPeerId = survivors[0]?.peerId ?? null;
    return { ended: true };
  }

  // 다음 턴 진행
  game.currentTurn = getNextTurn(game);
  game.turnStartedAt = now;
  return { ended: false };
}
