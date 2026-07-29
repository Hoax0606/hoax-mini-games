/**
 * 가짜 화가 (Fake Artist) — 공유 상태 + 페이즈 전이 + 투표 집계 + 점수 (순수 로직).
 *
 * 라이어 게임 구조를 이식하되 "힌트 말하기"를 "공유 캔버스에 한 획 그리기"로 치환.
 *   - 제시어는 마피아(가짜 화가) 빼고 전원이 앎. 마피아는 자기가 가짜임을 앎(제시어 자리에 없음 표시).
 *   - 턴 돌아가며 각자 정해진 색으로 한 획씩, 총 laps 바퀴.
 *   - 투표로 마피아 지목 → 잡히면 시민 승, 단 마피아가 제시어 맞히면 역전승.
 *
 * FakeArtistGame 은 "전원 공개해도 되는" 상태만 담는다.
 *   비밀(내 역할/제시어, 진짜 제시어, 실제 마피아, 개별 투표)은 호스트가 index.ts 에서만 보관.
 *   그림(strokes)·색 매핑·주제(category)는 공개(누가 뭘 그렸는지 색으로 보이는 게 게임 핵심).
 */

export type Phase = 'draw' | 'vote' | 'guess' | 'result' | 'ended';
export type Role = 'citizen' | 'fake';

export interface StrokePoint { x: number; y: number; }

/** 한 획 (draw-quiz StrokeData 모델 재사용 — 가짜화가는 펜/free 만 씀) */
export interface StrokeData {
  points: StrokePoint[];
  color: string;
  width: number;
  tool: 'pen';
  shape: 'free';
}

export interface PlayerMeta {
  peerId: string;
  nickname: string;
}

export interface FakeArtistGame {
  round: number;
  totalRounds: number;
  phase: Phase;
  /** 이번 라운드 주제 (전원 공개 — 마피아에게도 힌트) */
  category: string;
  /** 그리기 순서 (peerId) */
  order: string[];
  /** 각자 몇 바퀴 그리는지 */
  laps: number;
  /** 지금까지 그은 획 수 = 다음 차례 인덱스. currentDrawer = order[drawIndex % n] */
  drawIndex: number;
  /** 공유 캔버스에 쌓인 획들 (전원 동일하게 렌더) */
  strokes: StrokeData[];
  /** peerId → 고정 펜 색 (공개) */
  colors: Record<string, string>;
  /** 최다 득표 지목자 (동점/미달이면 null) */
  accusedPeerId: string | null;
  /** 결과 공개 후에만: 실제 마피아 */
  revealedFakePeerId: string | null;
  /** 결과 공개 후에만: 마피아 추측 단어 */
  fakeGuess: string | null;
  /** 결과 공개 후에만: 마피아가 이겼는지 */
  fakeWon: boolean | null;
  /** 결과 공개 후에만: 실제 제시어(정답) */
  revealedWord: string | null;
  scores: Record<string, number>;
  players: PlayerMeta[];
}

export const TOTAL_ROUNDS = 5;
export const DRAW_LAPS_DEFAULT = 2;
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 10;
export const GUESS_MAXLEN = 16;
const DUMMY_PREFIX = '__fa_dummy_';

/** 플레이어 고정 색 팔레트 — 서로 확실히 구분되는 10색 (좌석 순서대로 배정) */
export const PLAYER_COLORS = [
  '#e2245e', // 빨강
  '#2e6fd9', // 파랑
  '#2eb872', // 초록
  '#ff8a3c', // 주황
  '#9c5fd9', // 보라
  '#0bb3c4', // 청록
  '#d94ec4', // 자홍
  '#a5682a', // 갈색
  '#3a3f8a', // 남색
  '#7a8b1c', // 올리브
] as const;

export function colorFor(seatIndex: number): string {
  return PLAYER_COLORS[seatIndex % PLAYER_COLORS.length]!;
}

export function isDummy(peerId: string): boolean {
  return peerId.startsWith(DUMMY_PREFIX);
}

// ============================================
// 초기화 / 라운드 리셋
// ============================================

export function createInitialGame(players: PlayerMeta[], laps: number): FakeArtistGame {
  // 솔로(AlphaTest) 프리뷰 — 최소 인원 미달이면 더미로 채움(실제 대국은 시작 버튼에서 강제).
  const padded = [...players];
  let d = 1;
  while (padded.length < MIN_PLAYERS) {
    padded.push({ peerId: `${DUMMY_PREFIX}${d}__`, nickname: `연습 상대 ${d}` });
    d += 1;
  }
  if (padded.length < MIN_PLAYERS || padded.length > MAX_PLAYERS) {
    throw new Error(`가짜 화가는 ${MIN_PLAYERS}~${MAX_PLAYERS}인만 지원해요 (현재 ${padded.length}인)`);
  }
  const scores: Record<string, number> = {};
  const colors: Record<string, string> = {};
  padded.forEach((p, i) => { scores[p.peerId] = 0; colors[p.peerId] = colorFor(i); });
  return {
    round: 1,
    totalRounds: TOTAL_ROUNDS,
    phase: 'draw',
    category: '',
    order: padded.map((p) => p.peerId),
    laps,
    drawIndex: 0,
    strokes: [],
    colors,
    accusedPeerId: null,
    revealedFakePeerId: null,
    fakeGuess: null,
    fakeWon: null,
    revealedWord: null,
    scores,
    players: padded.slice(),
  };
}

/** 새 라운드 시작 — 공개 필드 리셋. round/scores/colors 는 유지. */
export function resetForRound(game: FakeArtistGame, category: string, order: string[]): void {
  game.phase = 'draw';
  game.category = category;
  game.order = order;
  game.drawIndex = 0;
  game.strokes = [];
  game.accusedPeerId = null;
  game.revealedFakePeerId = null;
  game.fakeGuess = null;
  game.fakeWon = null;
  game.revealedWord = null;
}

// ============================================
// 그리기 턴 진행
// ============================================

/** 현재 그릴 차례 peerId (draw 페이즈일 때만 유효) */
export function currentDrawer(game: FakeArtistGame): string | undefined {
  return game.order[game.drawIndex % game.order.length];
}

/** 몇 바퀴째인지 (1-base, 표시용) */
export function currentLap(game: FakeArtistGame): number {
  return Math.floor(game.drawIndex / game.order.length) + 1;
}

/** 한 획 그린 뒤 다음 차례로. 모든 바퀴 끝나면 { done: true } → 호출부가 투표로 전환. */
export function advanceDraw(game: FakeArtistGame): { done: boolean } {
  game.drawIndex += 1;
  return { done: game.drawIndex >= game.order.length * game.laps };
}

// ============================================
// 투표 집계 / 점수 (라이어 게임과 동일)
// ============================================

/**
 * 투표 집계 → 지목자. 단독 최다득표면 그 사람, 동점/무효면 null (마피아 승 처리).
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
 *   마피아 승 → 마피아 +2.
 *   시민 승 → 마피아에게 투표한 시민 각 +1.
 */
export function scoreRound(
  game: FakeArtistGame,
  fakePeerId: string,
  votes: Record<string, string>,
  fakeWon: boolean,
): void {
  if (fakeWon) {
    game.scores[fakePeerId] = (game.scores[fakePeerId] ?? 0) + 2;
    return;
  }
  for (const [voter, target] of Object.entries(votes)) {
    if (target === fakePeerId && voter !== fakePeerId) {
      game.scores[voter] = (game.scores[voter] ?? 0) + 1;
    }
  }
}

/** 최종 순위 (누적 점수 내림차순, 동점 공동) */
export function finalRanking(game: FakeArtistGame): Array<{ peerId: string; nickname: string; score: number; rank: number }> {
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
