/**
 * 다트 6모드 규칙 — 순수 상태 머신 (render/network 없음)
 *
 * 입력:
 *   - createDartsGame: 모드/변형/플레이어 → 초기 state
 *   - applyDartHit:    현재 플레이어 턴에 다트 하나 적용 → 점수/마크/종료 플래그 갱신
 *   - advanceTurn:     다음 플레이어로 넘김 (턴 종료 후 호출)
 *
 * 모드별 규칙 요약:
 *   • X01 (101/201/301): 시작 점수에서 히트 점수 빼기. 0 도달 → 승.
 *       - Normal: 0 도달하면 즉시 승.
 *       - Hard  : 마지막 다트가 Double (또는 Bull=Double Bull) 이어야 승. 그 외 0 도달은 bust.
 *       - Bust  : 남은 점수가 음수 또는 (Hard일 때 1) 이 되는 히트가 나오면 이번 턴 전체 원복.
 *   • Count-up:    7라운드 누적. 최고 점수 승.
 *   • Low Count-up: 1라운드 3다트만. 1st×1 / 2nd×2 / 3rd×3, miss=50점. 최저 점수 승.
 *   • Cricket:     15~20 + Bull. 각 섹터 3마크로 close. close 후 상대가 다 close 안 했으면 추가
 *                  마크가 점수화. 7개 전부 close + 점수 ≥ 모든 상대 → 승.
 */

import type { HitResult } from './board';
import type { DartsMode, X01Variant, PlayerDisplay } from './render';

// ============================================
// 타입
// ============================================

export interface DartsPlayer {
  peerId: string;
  nickname: string;

  /** 이번 턴에 던진 다트 (0~3). 턴 종료 시 비워짐 */
  throwsThisTurn: HitResult[];
  /** 이번 턴 bust 여부 (X01). 표시용 */
  bustThisTurn: boolean;

  // --- 모드별 상태 (안 쓰는 필드는 초기값 그대로) ---
  /** X01: 남은 점수 */
  x01Remaining: number;
  /** X01: 턴 시작 시 snapshot — bust 시 원복 대상 */
  x01PreTurnRemaining: number;
  /** Count-up / Low Count-up 누적 점수 */
  countupTotal: number;
  /** Cricket: 섹터별 마크 (0~3). 키 = "15".."20" | "bull" */
  cricketMarks: Record<string, number>;
  /** Cricket: 누적 점수 */
  cricketScore: number;

  /**
   * 플레이어 개별 종료 플래그.
   *   - low-countup: 3다트 던지면 true
   *   - X01: 0 도달 (승자)
   *   - 기타 모드는 false 유지
   */
  finished: boolean;
}

export interface DartsGame {
  mode: DartsMode;
  x01Variant: X01Variant;

  /** 현재 라운드 (1-based). 모든 플레이어가 한 턴씩 끝내면 +1. */
  round: number;
  /** 라운드 상한. null = 무제한 (X01/cricket 은 종료 조건으로 끝남) */
  maxRounds: number | null;

  players: DartsPlayer[];
  /** 현재 다트 던질 플레이어 인덱스 */
  currentIdx: number;

  /** 게임 종료 여부 */
  finished: boolean;
  /** 승자 peerId. 무승부는 null */
  winnerPeerId: string | null;
}

export interface PlayerSeed {
  peerId: string;
  nickname: string;
}

/** applyDartHit 반환 — 호출자가 애니메이션/타이밍을 제어할 수 있게 플래그 반환 */
export interface ApplyResult {
  /** 이번 턴이 종료되었는지 (3다트 완료 / bust / 승리) */
  turnEnded: boolean;
  /** 게임 전체가 종료되었는지 */
  gameEnded: boolean;
}

// ============================================
// 생성
// ============================================

const CRICKET_TARGETS = ['15', '16', '17', '18', '19', '20', 'bull'] as const;

export function createGameState(
  mode: DartsMode,
  x01Variant: X01Variant,
  seeds: PlayerSeed[],
): DartsGame {
  const maxRounds =
    mode === 'countup' ? 7 :
    mode === 'low-countup' ? 10 :
    null;

  const x01Start =
    mode === '101' ? 101 :
    mode === '201' ? 201 :
    mode === '301' ? 301 :
    0;

  const players: DartsPlayer[] = seeds.map((s) => ({
    peerId: s.peerId,
    nickname: s.nickname,
    throwsThisTurn: [],
    bustThisTurn: false,
    x01Remaining: x01Start,
    x01PreTurnRemaining: x01Start,
    countupTotal: 0,
    cricketMarks: {},
    cricketScore: 0,
    finished: false,
  }));

  return {
    mode,
    x01Variant,
    round: 1,
    maxRounds,
    players,
    currentIdx: 0,
    finished: false,
    winnerPeerId: null,
  };
}

// ============================================
// 다트 적용
// ============================================

export function applyDartHit(game: DartsGame, hit: HitResult): ApplyResult {
  if (game.finished) return { turnEnded: false, gameEnded: true };
  const p = game.players[game.currentIdx];
  if (!p || p.finished) return { turnEnded: true, gameEnded: game.finished };

  p.throwsThisTurn.push(hit);

  switch (game.mode) {
    case '101':
    case '201':
    case '301':
      return applyX01(game, p, hit);
    case 'countup':
      return applyCountup(p, hit);
    case 'low-countup':
      return applyLowCountup(p, hit);
    case 'cricket':
      return applyCricket(game, p, hit);
  }
}

function applyX01(game: DartsGame, p: DartsPlayer, hit: HitResult): ApplyResult {
  const newRemaining = p.x01Remaining - hit.score;
  let bust = false;
  let wins = false;

  if (newRemaining < 0) {
    bust = true;
  } else if (game.x01Variant === 'hard' && newRemaining === 1) {
    // Hard: 1 남으면 Double 로 떨어뜨릴 방법이 없어서 bust 처리 (표준 규칙)
    bust = true;
  } else if (newRemaining === 0) {
    if (game.x01Variant === 'normal') {
      wins = true;
    } else {
      // Hard: 마지막 다트가 Double 링 또는 Bull(=Double Bull) 이어야 승
      if (hit.kind === 'double' || hit.kind === 'inner-bull') {
        wins = true;
      } else {
        bust = true;
      }
    }
  }

  if (bust) {
    p.bustThisTurn = true;
    p.x01Remaining = p.x01PreTurnRemaining;
    return { turnEnded: true, gameEnded: false };
  }

  p.x01Remaining = newRemaining;
  if (wins) {
    p.finished = true;
    game.finished = true;
    game.winnerPeerId = p.peerId;
    return { turnEnded: true, gameEnded: true };
  }
  if (p.throwsThisTurn.length >= 3) return { turnEnded: true, gameEnded: false };
  return { turnEnded: false, gameEnded: false };
}

function applyCountup(p: DartsPlayer, hit: HitResult): ApplyResult {
  p.countupTotal += hit.score;
  if (p.throwsThisTurn.length >= 3) return { turnEnded: true, gameEnded: false };
  return { turnEnded: false, gameEnded: false };
}

function applyLowCountup(p: DartsPlayer, hit: HitResult): ApplyResult {
  // 매 라운드마다 3다트, 1번째 ×1 / 2번째 ×2 / 3번째 ×3. miss = 50점 고정.
  // 총 10라운드 누적 — finished 플래그는 세우지 않음 (라운드 상한으로 게임 종료)
  const n = p.throwsThisTurn.length; // 이미 push 했으니 1/2/3
  const points = hit.kind === 'miss' ? 50 : hit.score * n;
  p.countupTotal += points;
  if (p.throwsThisTurn.length >= 3) return { turnEnded: true, gameEnded: false };
  return { turnEnded: false, gameEnded: false };
}

function applyCricket(game: DartsGame, p: DartsPlayer, hit: HitResult): ApplyResult {
  // 섹터 결정 (15~20, bull, 그 외는 무시)
  let key: string | null = null;
  let marksToAdd = 0;
  let perMark = 0;

  if (hit.kind === 'inner-bull') {
    key = 'bull';
    marksToAdd = 2;
    perMark = 25;
  } else if (hit.kind === 'outer-bull') {
    key = 'bull';
    marksToAdd = 1;
    perMark = 25;
  } else if (hit.segment >= 15 && hit.segment <= 20) {
    key = String(hit.segment);
    marksToAdd = hit.multiplier;
    perMark = hit.segment;
  }

  if (key !== null) {
    const before = p.cricketMarks[key] ?? 0;
    const after = before + marksToAdd;
    const capped = Math.min(3, after);
    p.cricketMarks[key] = capped;
    const overflow = after - capped;
    if (overflow > 0) {
      // 상대 중 아직 close 안 한 사람이 하나라도 있으면 점수화
      const anyOpen = game.players.some(
        (o) => o !== p && (o.cricketMarks[key!] ?? 0) < 3,
      );
      if (anyOpen) {
        p.cricketScore += overflow * perMark;
      }
    }
  }

  // 승리 체크: 모든 타겟 close + 점수 ≥ 모든 상대
  if (checkCricketWin(game, p)) {
    p.finished = true;
    game.finished = true;
    game.winnerPeerId = p.peerId;
    return { turnEnded: true, gameEnded: true };
  }

  if (p.throwsThisTurn.length >= 3) return { turnEnded: true, gameEnded: false };
  return { turnEnded: false, gameEnded: false };
}

function checkCricketWin(game: DartsGame, p: DartsPlayer): boolean {
  const allClosed = CRICKET_TARGETS.every((t) => (p.cricketMarks[t] ?? 0) >= 3);
  if (!allClosed) return false;
  const maxOpp = game.players
    .filter((o) => o !== p)
    .reduce((m, o) => Math.max(m, o.cricketScore), 0);
  return p.cricketScore >= maxOpp;
}

// ============================================
// 턴 진행
// ============================================

export function advanceTurn(game: DartsGame): void {
  if (game.finished) return;

  // 현재 플레이어 턴 정리
  const cur = game.players[game.currentIdx];
  if (cur) {
    cur.throwsThisTurn = [];
    cur.bustThisTurn = false;
  }

  // 다음 unfinished 플레이어 찾기
  const n = game.players.length;
  let nextIdx = -1;
  for (let i = 1; i <= n; i++) {
    const candidate = (game.currentIdx + i) % n;
    if (!game.players[candidate]!.finished) {
      nextIdx = candidate;
      break;
    }
  }

  if (nextIdx < 0) {
    finalizeGame(game);
    return;
  }

  // 라운드 증가: 인덱스가 되감겼을 때 (N명 중 마지막 → 첫번째로 돌아올 때)
  if (nextIdx <= game.currentIdx) {
    game.round++;
    if (game.maxRounds !== null && game.round > game.maxRounds) {
      finalizeGame(game);
      return;
    }
  }

  game.currentIdx = nextIdx;
  const next = game.players[nextIdx]!;
  next.x01PreTurnRemaining = next.x01Remaining;
}

function finalizeGame(game: DartsGame): void {
  game.finished = true;
  // 종료 시점에 승자가 아직 없으면 모드별 판정 (X01/cricket 은 이미 세팅됨)
  if (game.winnerPeerId !== null) return;

  switch (game.mode) {
    case 'countup': {
      // 최고 점수 승
      let maxTotal = -Infinity;
      let leader: DartsPlayer | null = null;
      let tie = false;
      for (const p of game.players) {
        if (p.countupTotal > maxTotal) {
          maxTotal = p.countupTotal;
          leader = p;
          tie = false;
        } else if (p.countupTotal === maxTotal) {
          tie = true;
        }
      }
      game.winnerPeerId = tie ? null : leader?.peerId ?? null;
      break;
    }
    case 'low-countup': {
      // 최저 점수 승
      let minTotal = Infinity;
      let leader: DartsPlayer | null = null;
      let tie = false;
      for (const p of game.players) {
        if (p.countupTotal < minTotal) {
          minTotal = p.countupTotal;
          leader = p;
          tie = false;
        } else if (p.countupTotal === minTotal) {
          tie = true;
        }
      }
      game.winnerPeerId = tie ? null : leader?.peerId ?? null;
      break;
    }
    default:
      // X01/cricket 은 apply 단계에서 세팅됐어야 함. 없으면 null 유지.
      break;
  }
}

// ============================================
// 표시 헬퍼
// ============================================

export function toPlayerDisplays(game: DartsGame): PlayerDisplay[] {
  return game.players.map((p) => {
    let primaryLabel: string;
    let primaryValue: number;
    let cricketMarks: Record<string, number> | undefined;

    switch (game.mode) {
      case '101':
      case '201':
      case '301':
        primaryLabel = '남은 점수';
        primaryValue = p.x01Remaining;
        break;
      case 'countup':
        primaryLabel = '총점';
        primaryValue = p.countupTotal;
        break;
      case 'low-countup':
        primaryLabel = '총점 (낮을수록 ↑)';
        primaryValue = p.countupTotal;
        break;
      case 'cricket':
        primaryLabel = '점수';
        primaryValue = p.cricketScore;
        cricketMarks = p.cricketMarks;
        break;
    }

    return {
      peerId: p.peerId,
      nickname: p.nickname,
      primaryValue,
      primaryLabel,
      throwsThisRound: p.throwsThisTurn,
      finished: p.finished,
      cricketMarks,
      bustThisTurn: p.bustThisTurn,
    };
  });
}

export function modeLabel(mode: DartsMode, x01Variant: X01Variant): string {
  switch (mode) {
    case '101': return `101 · ${x01Variant === 'hard' ? 'Hard' : 'Normal'}`;
    case '201': return `201 · ${x01Variant === 'hard' ? 'Hard' : 'Normal'}`;
    case '301': return `301 · ${x01Variant === 'hard' ? 'Hard' : 'Normal'}`;
    case 'countup': return 'Count-up';
    case 'low-countup': return 'Low Count-up';
    case 'cricket': return 'Cricket';
  }
}

export function gameOverSubtitle(game: DartsGame): string {
  if (!game.finished) return '';
  if (game.winnerPeerId === null) return '무승부';
  const w = game.players.find((p) => p.peerId === game.winnerPeerId);
  if (!w) return '게임 종료';
  switch (game.mode) {
    case '101':
    case '201':
    case '301':
      return `${w.nickname} 먼저 0점 도달!`;
    case 'countup':
      return `${w.nickname} · ${w.countupTotal}점`;
    case 'low-countup':
      return `${w.nickname} · ${w.countupTotal}점 (최저)`;
    case 'cricket':
      return `${w.nickname} · ${w.cricketScore}점 · 전 타겟 close`;
  }
}

/** 결과 화면 랭킹용 — 모드별로 정렬 후 순위 + 점수 반환 */
export interface DartsRankingEntry {
  peerId: string;
  nickname: string;
  rank: number;
  score: number;
  /** X01: 남은 점수, countup/low-countup: 누적, cricket: 점수 */
  scoreLabel: string;
}

export function buildRankings(game: DartsGame): DartsRankingEntry[] {
  const players = [...game.players];
  // 승자 먼저 고정 — 그 다음 모드별 정렬
  const winnerFirst = (a: DartsPlayer, b: DartsPlayer): number => {
    if (a.peerId === game.winnerPeerId) return -1;
    if (b.peerId === game.winnerPeerId) return 1;
    return 0;
  };

  switch (game.mode) {
    case '101':
    case '201':
    case '301':
      // 승자 → 남은 점수 오름차순 (적을수록 가까운)
      players.sort((a, b) => {
        const w = winnerFirst(a, b);
        if (w !== 0) return w;
        return a.x01Remaining - b.x01Remaining;
      });
      return players.map((p, i) => ({
        peerId: p.peerId,
        nickname: p.nickname,
        rank: i + 1,
        score: p.x01Remaining,
        scoreLabel: '남은 점수',
      }));
    case 'countup':
      players.sort((a, b) => b.countupTotal - a.countupTotal);
      return players.map((p, i) => ({
        peerId: p.peerId,
        nickname: p.nickname,
        rank: i + 1,
        score: p.countupTotal,
        scoreLabel: '총점',
      }));
    case 'low-countup':
      players.sort((a, b) => a.countupTotal - b.countupTotal);
      return players.map((p, i) => ({
        peerId: p.peerId,
        nickname: p.nickname,
        rank: i + 1,
        score: p.countupTotal,
        scoreLabel: '총점',
      }));
    case 'cricket':
      players.sort((a, b) => b.cricketScore - a.cricketScore);
      return players.map((p, i) => ({
        peerId: p.peerId,
        nickname: p.nickname,
        rank: i + 1,
        score: p.cricketScore,
        scoreLabel: '점수',
      }));
  }
}
