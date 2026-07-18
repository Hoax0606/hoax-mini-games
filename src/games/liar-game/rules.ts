/**
 * 라이어 게임 — 공유 상태 + 페이즈 전이 + 투표 집계 + 점수 (순수 로직).
 *
 * 여기 LiarGame 은 "전원에게 공개해도 되는" 상태만 담는다.
 *   비밀(내 역할/제시어, 진짜 제시어, 실제 라이어, 개별 투표)은 여기 두지 않고
 *   호스트가 index.ts 에서 따로 보관 + per-peer 메시지로만 전달한다.
 *   revealedLiarPeerId/liarWon/liarGuess 는 라운드 결과 공개(reveal) 이후에만 채워짐.
 */

export type Phase = 'hint' | 'vote' | 'guess' | 'result' | 'ended';

export interface Hint {
  peerId: string;
  nickname: string;
  text: string;
}

export interface PlayerMeta {
  peerId: string;
  nickname: string;
}

export interface LiarGame {
  round: number;
  totalRounds: number;
  phase: Phase;
  /** 이번 라운드 주제 (전원 공개) */
  category: string;
  /** 힌트 순서 (peerId) */
  order: string[];
  /** 몇 바퀴째 (1..totalPasses) */
  hintPass: number;
  /** 이 게임의 힌트 바퀴 수 — 인원 많으면(7+) 1바퀴로 줄여 길이/피드 과다 방지 */
  totalPasses: number;
  /** order 내 현재 차례 인덱스 */
  hintIndex: number;
  hints: Hint[];
  /** 최다 득표 지목자 (동점/미달이면 null) */
  accusedPeerId: string | null;
  /** 결과 공개 후에만: 실제 라이어 */
  revealedLiarPeerId: string | null;
  /** 결과 공개 후에만: 라이어 추측 단어 */
  liarGuess: string | null;
  /** 결과 공개 후에만: 라이어가 이겼는지 */
  liarWon: boolean | null;
  /** 결과 공개 후에만: 실제 제시어(정답) — 라이어 승패와 무관하게 전원에게 공개 */
  revealedWord: string | null;
  scores: Record<string, number>;
  players: PlayerMeta[];
}

export const TOTAL_ROUNDS = 5;
export const HINT_MAXLEN = 40;
export const HINT_PASSES = 2;
/** 힌트 바퀴 수 — 7인 이상은 1바퀴(설명 20개→10개, 게임 길이·피드 과다 방지) */
export function hintPassesFor(n: number): number {
  return n >= 7 ? 1 : HINT_PASSES;
}

// ============================================
// 초기화 / 라운드 리셋
// ============================================

export function createInitialGame(players: PlayerMeta[]): LiarGame {
  // 솔로(AlphaTest) UI 미리보기 — 최소 3인 미달이면 더미 상대로 채운다(실제 대국은 시작 버튼에서 강제).
  if (players.length === 1) {
    players = [
      ...players,
      { peerId: '__preview_dummy_1__', nickname: '연습 상대 1' },
      { peerId: '__preview_dummy_2__', nickname: '연습 상대 2' },
    ];
  }
  if (players.length < 3 || players.length > 10) {
    throw new Error(`라이어 게임은 3~10인만 지원해요 (현재 ${players.length}인)`);
  }
  const scores: Record<string, number> = {};
  for (const p of players) scores[p.peerId] = 0;
  return {
    round: 1,
    totalRounds: TOTAL_ROUNDS,
    phase: 'hint',
    category: '',
    order: players.map((p) => p.peerId),
    hintPass: 1,
    totalPasses: hintPassesFor(players.length),
    hintIndex: 0,
    hints: [],
    accusedPeerId: null,
    revealedLiarPeerId: null,
    liarGuess: null,
    liarWon: null,
    revealedWord: null,
    scores,
    players: players.slice(),
  };
}

/** 새 라운드 시작 — 공개 필드 리셋. round/scores 는 유지. */
export function resetForRound(game: LiarGame, category: string, order: string[]): void {
  game.phase = 'hint';
  game.category = category;
  game.order = order;
  game.hintPass = 1;
  game.hintIndex = 0;
  game.hints = [];
  game.accusedPeerId = null;
  game.revealedLiarPeerId = null;
  game.liarGuess = null;
  game.liarWon = null;
  game.revealedWord = null;
}

// ============================================
// 힌트 진행
// ============================================

/** 현재 힌트 차례 peerId (hint 페이즈일 때만 유효) */
export function currentHinter(game: LiarGame): string | undefined {
  return game.order[game.hintIndex];
}

/** 다음 차례로. 2바퀴 다 돌면 { done: true } → 호출부가 투표 페이즈로 전환. */
export function advanceHinter(game: LiarGame): { done: boolean } {
  game.hintIndex += 1;
  if (game.hintIndex >= game.order.length) {
    game.hintIndex = 0;
    game.hintPass += 1;
  }
  return { done: game.hintPass > game.totalPasses };
}

export type HintCheck = { ok: true } | { ok: false; message: string };

/** 힌트 검증 (호스트). 빈칸/길이/진짜 제시어 직접언급 금지. */
export function validateHint(text: string, realKeyword: string): HintCheck {
  const t = text.trim();
  if (!t) return { ok: false, message: '설명을 입력해주세요' };
  if (t.length > HINT_MAXLEN) return { ok: false, message: `${HINT_MAXLEN}자 이하로 입력해주세요` };
  // 제시어를 그대로 포함하면 게임이 무의미 → 거절 (공백 제거 후 비교)
  const norm = t.replace(/\s/g, '');
  if (realKeyword && norm.includes(realKeyword)) {
    return { ok: false, message: '제시어를 직접 말하면 안 돼요' };
  }
  return { ok: true };
}

// ============================================
// 투표 집계 / 점수
// ============================================

/**
 * 투표 집계 → 지목자. 단독 최다득표면 그 사람, 동점/무효면 null (라이어 승 처리).
 * @param votes voter peerId → target peerId
 */
export function tallyVotes(votes: Record<string, string>): string | null {
  const counts = new Map<string, number>();
  for (const target of Object.values(votes)) {
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  let max = 0;
  let top: string | null = null;
  let tie = false;
  for (const [peerId, n] of counts) {
    if (n > max) { max = n; top = peerId; tie = false; }
    else if (n === max) { tie = true; }
  }
  return tie || max === 0 ? null : top;
}

/**
 * 라운드 점수 반영.
 *   라이어 승 → 라이어 +2.
 *   시민 승 → 라이어에게 투표한 시민 각 +1.
 */
export function scoreRound(
  game: LiarGame,
  liarPeerId: string,
  votes: Record<string, string>,
  liarWon: boolean,
): void {
  if (liarWon) {
    game.scores[liarPeerId] = (game.scores[liarPeerId] ?? 0) + 2;
    return;
  }
  for (const [voter, target] of Object.entries(votes)) {
    if (target === liarPeerId && voter !== liarPeerId) {
      game.scores[voter] = (game.scores[voter] ?? 0) + 1;
    }
  }
}

/** 최종 순위 (누적 점수 내림차순, 동점 공동) */
export function finalRanking(game: LiarGame): Array<{ peerId: string; nickname: string; score: number; rank: number }> {
  const rows = game.players
    .map((p) => ({ peerId: p.peerId, nickname: p.nickname, score: game.scores[p.peerId] ?? 0 }))
    .sort((a, b) => b.score - a.score);
  let rank = 0;
  let prev = Number.POSITIVE_INFINITY;
  return rows.map((r, i) => {
    if (r.score < prev) { rank = i + 1; prev = r.score; }
    return { ...r, rank };
  });
}
