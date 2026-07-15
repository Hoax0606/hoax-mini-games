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
  /** 전체 라운드 수 (플레이어 수 × 바퀴, 단 최대 15 상한) */
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
  /** 최종 우승자 peerId 들 — 동점이면 여럿(공동 우승), 무승부면 빈 배열 */
  winnerPeerIds: string[];
}

/** 라운드 제한 시간 */
export const ROUND_DURATION_MS = 70_000;
export const TIMEOUT_GRACE_MS = 500;

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
    winnerPeerIds: [],
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
 * 정답 맞힌 사람의 "맞춘 개수" +1 (호스트만).
 * **가장 먼저 맞힌 1명만** 점수 — 이미 이번 라운드에 정답자가 있거나, 출제자면 무시.
 * 반환: 맞힌 것으로 처리됐으면 true (= 라운드 종료 트리거).
 */
export function awardCorrect(game: DrawQuizGame, peerId: string): boolean {
  if (game.correctThisRound.length > 0) return false; // 첫 정답자 이미 나옴 → 1명만 인정
  if (peerId === game.drawerPeerId) return false; // 출제자는 못 맞힘
  const player = game.players.find((p) => p.peerId === peerId);
  if (!player) return false;
  player.score += 1; // 맞춘 개수 누적 (순위 = 누적 정답 수)
  game.correctThisRound.push(peerId);
  return true;
}

/** 이번 라운드에 정답자가 나왔는지 — 첫 정답 시 라운드 조기 종료 판정. */
export function roundHasCorrect(game: DrawQuizGame): boolean {
  return game.correctThisRound.length > 0;
}

/** 인원수에 따른 "1인당 그리는 횟수" — 적을수록 많이(최대 10), 많을수록 적게(최소 3). */
export function roundsPerPlayer(playerCount: number): number {
  const raw = Math.round(15 / Math.max(1, playerCount));
  return Math.max(3, Math.min(10, raw));
}

/** 점수 맵 추출 (네트워크 전송용) */
export function scoreMap(game: DrawQuizGame): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of game.players) out[p.peerId] = p.score;
  return out;
}

/**
 * 최종 우승자들 — 최고 점수인 사람 전원 (동점이면 공동 우승).
 * 아무도 점수를 못 냈으면(최고점 0) 빈 배열 = 무승부.
 */
export function computeWinners(game: DrawQuizGame): PlayerMeta[] {
  let maxScore = 0;
  for (const p of game.players) if (p.score > maxScore) maxScore = p.score;
  if (maxScore <= 0) return [];
  return game.players.filter((p) => p.score === maxScore);
}
