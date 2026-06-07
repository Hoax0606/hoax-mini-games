/**
 * 그림 퀴즈 — 게임 상태 + 점수 + 라운드 진행 (순수 로직)
 *
 * 게임 흐름:
 *   - 플레이어 전원이 한 번씩 출제자가 됨 (N명 = N라운드, 옵션으로 2바퀴 가능)
 *   - 각 라운드: 출제자가 후보 3개 중 단어 선택 → 60초 그리기 → 추측자들 채팅 정답
 *   - 점수:
 *     · 맞힌 사람: 빨리 맞힐수록 높게 (1등 100, 그 다음 -10씩, 최소 50)
 *     · 출제자: 맞힌 사람 수에 비례 (맞힌 사람 1명당 +30, 전원 못 맞히면 0)
 *   - 모든 라운드 끝나면 누적 점수 최고 = 승
 *
 * 정답 판정:
 *   공백/대소문자 무시한 정확 일치. 한글이라 대소문자는 무관하지만 영문 섞일 때 대비.
 */

export type GamePhase =
  /** 출제자가 후보 단어 고르는 중 */
  | 'choosing'
  /** 그리기 + 추측 진행 중 */
  | 'drawing'
  /** 라운드 결과 표시 (정답 공개) */
  | 'round_result'
  /** 전체 게임 종료 */
  | 'ended';

export interface StrokePoint {
  x: number;
  y: number;
}

export interface PlayerMeta {
  peerId: string;
  nickname: string;
  /** 누적 점수 */
  score: number;
  /** 이번 게임에서 이미 출제했는지 (출제자 로테이션용) */
  hasDrawn: boolean;
}

export interface DrawQuizGame {
  phase: GamePhase;
  /** 현재 라운드 (1부터) */
  round: number;
  /** 전체 라운드 수 (= 플레이어 수 × 바퀴) */
  totalRounds: number;
  /** 현재 출제자 peerId */
  drawerPeerId: string;
  /** 현재 라운드 제시어 (비출제자에겐 sync 시 빈 문자열로 가려짐) */
  currentWord: string;
  /** 라운드 시작 시각 (performance.now) */
  turnStartedAt: number;
  players: PlayerMeta[];
  /** 이번 게임에서 이미 출제된 단어 (중복 방지) */
  usedWords: Set<string>;
  /** 이번 라운드에 이미 정답 맞힌 peerId 들 (순서 = 맞힌 순) */
  correctThisRound: string[];
  winnerPeerId: string | null;
}

/** 라운드 제한 시간 */
export const ROUND_DURATION_MS = 70_000;
export const TIMEOUT_GRACE_MS = 500;
/** 정답 1등 점수, 이후 순위마다 차감, 최소 점수 */
const SCORE_FIRST = 100;
const SCORE_STEP = 10;
const SCORE_MIN = 50;
/** 출제자가 받는 점수 (맞힌 사람 1명당) */
const DRAWER_SCORE_PER_CORRECT = 30;

// ============================================
// 초기화
// ============================================

export function createInitialGame(
  players: Array<{ peerId: string; nickname: string }>,
  rounds: number,
): DrawQuizGame {
  if (players.length < 2) {
    throw new Error('그림 퀴즈는 2인 이상이어야 해요');
  }
  const metas: PlayerMeta[] = players.map((p) => ({
    peerId: p.peerId,
    nickname: p.nickname,
    score: 0,
    hasDrawn: false,
  }));
  return {
    phase: 'choosing',
    round: 0,
    totalRounds: rounds,
    drawerPeerId: '',
    currentWord: '',
    turnStartedAt: 0,
    players: metas,
    usedWords: new Set(),
    correctThisRound: [],
    winnerPeerId: null,
  };
}

// ============================================
// 출제자 선정 / 라운드 진행
// ============================================

/** 아직 출제 안 한 플레이어 중 다음 출제자. 모두 출제했으면 hasDrawn 리셋(2바퀴). */
export function pickNextDrawer(game: DrawQuizGame): PlayerMeta | null {
  let candidates = game.players.filter((p) => !p.hasDrawn);
  if (candidates.length === 0) {
    // 2바퀴 이상 — 전원 리셋
    for (const p of game.players) p.hasDrawn = false;
    candidates = game.players.slice();
  }
  return candidates[0] ?? null;
}

/** 정답 판정 — 공백 제거 + 소문자화 후 정확 일치 */
export function isCorrectGuess(guess: string, answer: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase();
  return norm(guess) === norm(answer);
}

/**
 * 정답 맞힌 사람에게 점수 부여 (호스트만).
 * 이미 맞힌 사람이면 무시. 순위(빠른 순)에 따라 점수 차등.
 * 반환: 부여된 점수 (이미 맞혔으면 0)
 */
export function awardCorrect(game: DrawQuizGame, peerId: string): number {
  if (game.correctThisRound.includes(peerId)) return 0;
  if (peerId === game.drawerPeerId) return 0; // 출제자는 못 맞힘
  const rank = game.correctThisRound.length; // 0-based
  const score = Math.max(SCORE_MIN, SCORE_FIRST - rank * SCORE_STEP);
  const player = game.players.find((p) => p.peerId === peerId);
  if (!player) return 0;
  player.score += score;
  game.correctThisRound.push(peerId);
  return score;
}

/** 라운드 종료 시 출제자 점수 정산 (맞힌 사람 수 비례). */
export function awardDrawer(game: DrawQuizGame): void {
  const drawer = game.players.find((p) => p.peerId === game.drawerPeerId);
  if (!drawer) return;
  drawer.score += game.correctThisRound.length * DRAWER_SCORE_PER_CORRECT;
}

/** 비출제자(추측 가능한 사람) 전원이 맞혔는지 — 라운드 조기 종료 판정. */
export function allGuessersCorrect(game: DrawQuizGame): boolean {
  const guessers = game.players.filter((p) => p.peerId !== game.drawerPeerId);
  return guessers.length > 0 && game.correctThisRound.length >= guessers.length;
}

/** 점수 맵 추출 (네트워크 전송용) */
export function scoreMap(game: DrawQuizGame): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of game.players) out[p.peerId] = p.score;
  return out;
}

/** 최종 우승자 판정 — 최고 점수. 동점이면 첫 번째. */
export function computeWinner(game: DrawQuizGame): string | null {
  if (game.players.length === 0) return null;
  let best = game.players[0]!;
  for (const p of game.players) {
    if (p.score > best.score) best = p;
  }
  return best.peerId;
}
