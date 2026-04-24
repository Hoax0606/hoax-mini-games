import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import type { HostSession, GuestSession } from '../core/peer';
import type { RoomState, GameResult } from '../games/types';
import { createMenuScreen } from './menu';
import { createGameScreenAsHostScreen, createGameScreenAsGuestScreen } from './gameScreen';
import { storage } from '../core/storage';

/**
 * 결과 화면 (호스트/게스트 factory 2종)
 *
 * 호스트 측: 🔄 다시하기 / 메뉴로
 *   - 다시하기: 'game_start' 메시지 송신 → 양쪽 gameScreen 재진입
 *   - 게스트 연결 끊김 시 다시하기 비활성화
 *
 * 게스트 측: 방장의 결정 대기 / 메뉴로
 *   - 'game_start' 수신 시 자동 gameScreen 진입
 *   - 호스트 연결 끊김 시 "방장이 나갔어요" 후 메뉴로
 *
 * 소유권:
 *   gameScreen → resultScreen 전이 시 세션 이관 (closeOnDispose=false).
 *   다시하기로 gameScreen 복귀 시에도 마찬가지.
 *   메뉴로 나가면 dispose에서 세션 close.
 */

// ============================================
// 공통 유틸
// ============================================

/** 타이틀/이모지 — 내 승패 기준 */
function winnerVisuals(myWinner: 'me' | 'opponent' | null): {
  emoji: string;
  title: string;
  titleClass: string;
} {
  if (myWinner === 'me')       return { emoji: '🏆', title: '승리!',   titleClass: 'result-title-win' };
  if (myWinner === 'opponent') return { emoji: '💫', title: '패배…', titleClass: 'result-title-lose' };
  return                              { emoji: '⚖️', title: '무승부',   titleClass: 'result-title-draw' };
}

/** 액션 영역 HTML (호스트=다시하기/메뉴, 게스트=대기/메뉴) */
function buildActionsHTML(isHost: boolean): string {
  return isHost
    ? `
        <button class="btn btn-primary btn-lg btn-block" id="retry-btn">🔄 다시하기</button>
        <button class="btn btn-ghost btn-block" id="menu-btn">메뉴로</button>
      `
    : `
        <div class="result-waiting-msg" id="waiting-msg">⏳ 방장이 다음을 고르고 있어요</div>
        <button class="btn btn-ghost btn-block" id="menu-btn">메뉴로 (방 나가기)</button>
      `;
}

function buildResultHTML(args: {
  hostNickname: string;
  guestNickname: string;
  hostScore: number;
  guestScore: number;
  myWinner: 'me' | 'opponent' | null;
  isHost: boolean;
}): string {
  const { hostNickname, guestNickname, hostScore, guestScore, myWinner, isHost } = args;

  const { emoji, title, titleClass } = winnerVisuals(myWinner);
  const hostWon = hostScore > guestScore;
  const guestWon = guestScore > hostScore;
  const actionsHTML = buildActionsHTML(isHost);

  return `
    <div class="result-card">
      <div class="result-emoji">${emoji}</div>
      <div class="result-title ${titleClass}">${title}</div>

      <div class="result-score">
        <div class="result-score-item">
          <div class="result-score-name">${escapeHtml(hostNickname)}</div>
          <div class="result-score-value ${hostWon ? 'result-score-win' : ''}">${hostScore}</div>
        </div>
        <div class="result-score-sep">:</div>
        <div class="result-score-item">
          <div class="result-score-name">${escapeHtml(guestNickname)}</div>
          <div class="result-score-value ${guestWon ? 'result-score-win' : ''}">${guestScore}</div>
        </div>
      </div>

      <div class="result-actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

// ============================================
// 테트리스 전용 결과 HTML
// ============================================

/** 테트리스 summary에서 기대하는 타입 (런타임엔 unknown이라 안전 파싱) */
interface TetrisStats {
  linesCleared: number;
  garbageSent: number;
  garbageReceived: number;
  durationMs: number;
  piecesPlaced: number;
  tetrisCount: number;
  maxCombo: number;
}
interface TetrisRankEntry {
  peerId: string;
  nickname: string;
  rank: number;
}

/** summary를 테트리스 형식으로 안전하게 파싱. 실패 시 null. */
function parseTetrisSummary(summary: Record<string, unknown>): {
  myPeerId: string;
  rank: number;
  totalPlayers: number;
  myStats: TetrisStats;
  rankings: TetrisRankEntry[];
} | null {
  if (summary['gameId'] !== 'battle-tetris') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  const rank = typeof summary['rank'] === 'number' ? (summary['rank'] as number) : null;
  const totalPlayers = typeof summary['totalPlayers'] === 'number' ? (summary['totalPlayers'] as number) : null;
  const rawStats = summary['myStats'] as Partial<TetrisStats> | undefined;
  const rawRankings = summary['rankings'] as unknown;
  if (!myPeerId || rank === null || totalPlayers === null || !rawStats) return null;

  const myStats: TetrisStats = {
    linesCleared: Number(rawStats.linesCleared ?? 0),
    garbageSent: Number(rawStats.garbageSent ?? 0),
    garbageReceived: Number(rawStats.garbageReceived ?? 0),
    durationMs: Number(rawStats.durationMs ?? 0),
    piecesPlaced: Number(rawStats.piecesPlaced ?? 0),
    tetrisCount: Number(rawStats.tetrisCount ?? 0),
    maxCombo: Number(rawStats.maxCombo ?? 0),
  };

  const rankings: TetrisRankEntry[] = Array.isArray(rawRankings)
    ? (rawRankings as Partial<TetrisRankEntry>[])
        .filter((r) => typeof r.peerId === 'string' && typeof r.nickname === 'string' && typeof r.rank === 'number')
        .map((r) => ({ peerId: r.peerId!, nickname: r.nickname!, rank: r.rank! }))
    : [];

  return { myPeerId, rank, totalPlayers, myStats, rankings };
}

/** ms → "1분 23초" / "23초" 형식 */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

function buildTetrisResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  rank: number;
  totalPlayers: number;
  myStats: TetrisStats;
  rankings: TetrisRankEntry[];
  myPeerId: string;
  isHost: boolean;
}): string {
  const { myWinner, rank, totalPlayers, myStats, rankings, myPeerId, isHost } = args;
  const { emoji, title, titleClass } = winnerVisuals(myWinner);
  const actionsHTML = buildActionsHTML(isHost);

  const statsHTML = `
    <div class="result-tetris-stats">
      ${statCard('지운 줄', myStats.linesCleared, '줄')}
      ${statCard('공격', myStats.garbageSent, '줄')}
      ${statCard('받은 공격', myStats.garbageReceived, '줄')}
      ${statCard('플레이 시간', formatDuration(myStats.durationMs), '')}
      ${statCard('최대 콤보', myStats.maxCombo, myStats.maxCombo > 0 ? '연속' : '')}
      ${statCard('테트리스', myStats.tetrisCount, '회')}
      ${statCard('쌓은 피스', myStats.piecesPlaced, '개')}
    </div>
  `;

  const rankingsHTML = rankings.length >= 2 ? `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 전체 랭킹</div>
      ${rankings.map((r) => {
        const isMe = r.peerId === myPeerId;
        const badgeClass = r.rank <= 3 ? `rank-${r.rank}` : '';
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${r.rank}</span>
            <span class="result-tetris-rank-name">${escapeHtml(r.nickname)}</span>
            ${isMe ? '<span class="result-tetris-rank-me-tag">나</span>' : ''}
          </div>
        `;
      }).join('')}
    </div>
  ` : '';

  return `
    <div class="result-card result-card-tetris">
      <div class="result-emoji">${emoji}</div>
      <div class="result-title ${titleClass}">${title}</div>
      <div class="result-tetris-rank">
        <span class="result-tetris-rank-num">${rank}</span> / ${totalPlayers}위
      </div>

      ${statsHTML}
      ${rankingsHTML}

      <div class="result-actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

function statCard(label: string, value: number | string, unit: string): string {
  return `
    <div class="result-tetris-stat">
      <div class="result-tetris-stat-label">${label}</div>
      <div class="result-tetris-stat-value">${value}${unit ? `<span class="result-tetris-stat-unit">${unit}</span>` : ''}</div>
    </div>
  `;
}

// ============================================
// 사과 게임 전용 결과 HTML
// ============================================

interface AppleRankEntry {
  peerId: string;
  nickname: string;
  rank: number;
  score: number;
}

function parseAppleSummary(summary: Record<string, unknown>): {
  myPeerId: string;
  rank: number;
  totalPlayers: number;
  myScore: number;
  rankings: AppleRankEntry[];
} | null {
  if (summary['gameId'] !== 'apple-game') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  const rank = typeof summary['rank'] === 'number' ? (summary['rank'] as number) : null;
  const totalPlayers = typeof summary['totalPlayers'] === 'number' ? (summary['totalPlayers'] as number) : null;
  const myScore = typeof summary['myScore'] === 'number' ? (summary['myScore'] as number) : 0;
  const rawRankings = summary['rankings'] as unknown;
  if (!myPeerId || rank === null || totalPlayers === null) return null;

  const rankings: AppleRankEntry[] = Array.isArray(rawRankings)
    ? (rawRankings as Partial<AppleRankEntry>[])
        .filter((r) =>
          typeof r.peerId === 'string' &&
          typeof r.nickname === 'string' &&
          typeof r.rank === 'number' &&
          typeof r.score === 'number'
        )
        .map((r) => ({ peerId: r.peerId!, nickname: r.nickname!, rank: r.rank!, score: r.score! }))
    : [];

  return { myPeerId, rank, totalPlayers, myScore, rankings };
}

function buildAppleResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  rank: number;
  totalPlayers: number;
  myScore: number;
  rankings: AppleRankEntry[];
  myPeerId: string;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, rank, totalPlayers, myScore, rankings, myPeerId, isHost, isSpectator } = args;
  const { emoji, title, titleClass } = winnerVisuals(myWinner);
  const actionsHTML = buildActionsHTML(isHost);

  // 관전자는 "내 점수 / 등수"가 없으므로 랭킹만.
  const myBlockHTML = isSpectator ? '' : `
    <div class="result-tetris-rank">
      <span class="result-tetris-rank-num">${rank}</span> / ${totalPlayers}위
    </div>
    <div class="result-apple-myscore">
      <div class="result-apple-myscore-label">🍎 내 점수</div>
      <div class="result-apple-myscore-value">${myScore}</div>
    </div>
  `;

  const rankingsHTML = rankings.length >= 2 ? `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 최종 랭킹</div>
      ${rankings.map((r) => {
        const isMe = r.peerId === myPeerId;
        const badgeClass = r.rank <= 3 ? `rank-${r.rank}` : '';
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${r.rank}</span>
            <span class="result-tetris-rank-name">${escapeHtml(r.nickname)}</span>
            <span class="result-apple-rank-score">${r.score}점</span>
            ${isMe ? '<span class="result-tetris-rank-me-tag">나</span>' : ''}
          </div>
        `;
      }).join('')}
    </div>
  ` : '';

  // 관전자는 메인 타이틀도 "게임 종료" 정도로
  const headerHTML = isSpectator ? `
    <div class="result-emoji">👀</div>
    <div class="result-title result-title-draw">게임 종료</div>
  ` : `
    <div class="result-emoji">${emoji}</div>
    <div class="result-title ${titleClass}">${title}</div>
  `;

  return `
    <div class="result-card result-card-tetris">
      ${headerHTML}
      ${myBlockHTML}
      ${rankingsHTML}

      <div class="result-actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

// ============================================
// 오목 전용 결과 HTML
// ============================================

interface GomokuSummary {
  myPeerId: string;
  reason: 'five' | 'timeout' | 'draw';
  moveCount: number;
  durationMs: number;
  hostNickname: string;
  guestNickname: string;
  winnerNickname: string | null;
  winnerSide: 'B' | 'W' | null;
}

function parseGomokuSummary(summary: Record<string, unknown>): GomokuSummary | null {
  if (summary['gameId'] !== 'gomoku') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  const reasonRaw = summary['reason'];
  const reason: GomokuSummary['reason'] =
    reasonRaw === 'five' || reasonRaw === 'timeout' || reasonRaw === 'draw'
      ? reasonRaw
      : 'five';
  const moveCount = typeof summary['moveCount'] === 'number' ? (summary['moveCount'] as number) : 0;
  const durationMs = typeof summary['durationMs'] === 'number' ? (summary['durationMs'] as number) : 0;
  const hostNickname = typeof summary['hostNickname'] === 'string' ? (summary['hostNickname'] as string) : '?';
  const guestNickname = typeof summary['guestNickname'] === 'string' ? (summary['guestNickname'] as string) : '?';
  const winnerNickname = typeof summary['winnerNickname'] === 'string' ? (summary['winnerNickname'] as string) : null;
  const winnerSideRaw = summary['winnerSide'];
  const winnerSide: GomokuSummary['winnerSide'] =
    winnerSideRaw === 'B' || winnerSideRaw === 'W' ? winnerSideRaw : null;

  if (!myPeerId) return null;
  return { myPeerId, reason, moveCount, durationMs, hostNickname, guestNickname, winnerNickname, winnerSide };
}

/** 오목 종료 사유를 한국어 뱃지 텍스트로 */
function gomokuReasonLabel(reason: 'five' | 'timeout' | 'draw'): string {
  switch (reason) {
    case 'five':    return '🎯 5목 완성';
    case 'timeout': return '⏱ 시간 초과';
    case 'draw':    return '⚖️ 보드 가득참';
  }
}

function buildGomokuResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  summary: GomokuSummary;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, summary, isHost, isSpectator } = args;
  const { reason, moveCount, durationMs, hostNickname, guestNickname, winnerSide } = summary;

  // 관전자는 중립적 타이틀, 플레이어는 내 승/패/무 기준
  const { emoji, title, titleClass } = isSpectator
    ? { emoji: '🎯', title: '승부!', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);

  const actionsHTML = buildActionsHTML(isHost);
  const reasonLabel = gomokuReasonLabel(reason);

  const hostWon = winnerSide === 'B';
  const guestWon = winnerSide === 'W';

  const playerBlock = (args2: {
    side: 'B' | 'W';
    nickname: string;
    isWinner: boolean;
  }): string => {
    const stoneClass = args2.side === 'B' ? 'is-black' : 'is-white';
    const sideLabel = args2.side === 'B' ? '흑 · 선공' : '백 · 후공';
    return `
      <div class="result-gomoku-player ${args2.isWinner ? 'is-winner' : ''}">
        <div class="result-gomoku-stone ${stoneClass}"></div>
        <div class="result-gomoku-player-side">${sideLabel}</div>
        <div class="result-gomoku-player-name">${escapeHtml(args2.nickname)}</div>
        ${args2.isWinner ? '<div class="result-gomoku-winner-badge">WIN</div>' : ''}
      </div>
    `;
  };

  return `
    <div class="result-card result-card-gomoku">
      <div class="result-emoji">${emoji}</div>
      <div class="result-title ${titleClass}">${title}</div>

      <div class="result-gomoku-reason">${reasonLabel}</div>

      <div class="result-gomoku-players">
        ${playerBlock({ side: 'B', nickname: hostNickname, isWinner: hostWon })}
        <div class="result-gomoku-vs">VS</div>
        ${playerBlock({ side: 'W', nickname: guestNickname, isWinner: guestWon })}
      </div>

      <div class="result-gomoku-stats">
        <span>총 ${moveCount}수</span>
        <span>·</span>
        <span>${formatDuration(durationMs)}</span>
      </div>

      <div class="result-actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

// ============================================
// 반응속도 게임 전용 결과 HTML (간단한 랭킹 표)
// ============================================

interface ReflexRankEntry {
  peerId: string;
  nickname: string;
  rank: number;
  avgMs: number;       // -1 = 전부 실격
  foulCount: number;
}

function parseReflexSummary(summary: Record<string, unknown>): {
  myPeerId: string;
  rank: number;
  totalPlayers: number;
  rankings: ReflexRankEntry[];
} | null {
  if (summary['gameId'] !== 'reflex') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  const rank = typeof summary['rank'] === 'number' ? (summary['rank'] as number) : null;
  const totalPlayers = typeof summary['totalPlayers'] === 'number' ? (summary['totalPlayers'] as number) : null;
  const rawRankings = summary['rankings'] as unknown;
  if (!myPeerId || rank === null || totalPlayers === null) return null;

  const rankings: ReflexRankEntry[] = Array.isArray(rawRankings)
    ? (rawRankings as Partial<ReflexRankEntry>[])
        .filter((r) =>
          typeof r.peerId === 'string' &&
          typeof r.nickname === 'string' &&
          typeof r.rank === 'number' &&
          typeof r.avgMs === 'number'
        )
        .map((r) => ({
          peerId: r.peerId!,
          nickname: r.nickname!,
          rank: r.rank!,
          avgMs: r.avgMs!,
          foulCount: typeof r.foulCount === 'number' ? r.foulCount : 0,
        }))
    : [];

  return { myPeerId, rank, totalPlayers, rankings };
}

function buildReflexResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  rank: number;
  totalPlayers: number;
  rankings: ReflexRankEntry[];
  myPeerId: string;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, rank, totalPlayers, rankings, myPeerId, isHost, isSpectator } = args;
  const { emoji, title, titleClass } = isSpectator
    ? { emoji: '⚡', title: '반응 대결 종료', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);
  const actionsHTML = buildActionsHTML(isHost);

  const myEntry = rankings.find(r => r.peerId === myPeerId);
  const myBlock = isSpectator || !myEntry ? '' : `
    <div class="result-tetris-rank">
      <span class="result-tetris-rank-num">${rank}</span> / ${totalPlayers}위
    </div>
    <div class="result-apple-myscore">
      <div class="result-apple-myscore-label">⚡ 내 평균 반응속도</div>
      <div class="result-apple-myscore-value">${myEntry.avgMs > 0 ? `${Math.round(myEntry.avgMs)}ms` : '—'}</div>
    </div>
  `;

  const rankingsHTML = rankings.length >= 1 ? `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 최종 랭킹</div>
      ${rankings.map((r) => {
        const isMe = r.peerId === myPeerId;
        const badgeClass = r.rank <= 3 ? `rank-${r.rank}` : '';
        const msText = r.avgMs > 0 ? `${Math.round(r.avgMs)}ms` : '실격';
        const foulText = r.foulCount > 0 ? ` (실격 ${r.foulCount})` : '';
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${r.rank}</span>
            <span class="result-tetris-rank-name">${escapeHtml(r.nickname)}</span>
            <span class="result-apple-rank-score">${msText}${foulText}</span>
            ${isMe ? '<span class="result-tetris-rank-me-tag">나</span>' : ''}
          </div>
        `;
      }).join('')}
    </div>
  ` : '';

  return `
    <div class="result-card result-card-tetris">
      <div class="result-emoji">${emoji}</div>
      <div class="result-title ${titleClass}">${title}</div>
      ${myBlock}
      ${rankingsHTML}

      <div class="result-actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

// ============================================
// 다트 전용 결과 HTML
// ============================================

interface DartsRankEntry {
  peerId: string;
  nickname: string;
  rank: number;
  score: number;
  scoreLabel: string;
}

interface DartsSummary {
  myPeerId: string;
  rank: number;
  totalPlayers: number;
  modeLabel: string;
  winnerNickname: string | null;
  rankings: DartsRankEntry[];
  rounds: number;
}

function parseDartsSummary(summary: Record<string, unknown>): DartsSummary | null {
  if (summary['gameId'] !== 'darts') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  const rank = typeof summary['rank'] === 'number' ? (summary['rank'] as number) : null;
  const totalPlayers = typeof summary['totalPlayers'] === 'number' ? (summary['totalPlayers'] as number) : null;
  const modeLabel = typeof summary['modeLabel'] === 'string' ? (summary['modeLabel'] as string) : '';
  const winnerNickname = typeof summary['winnerNickname'] === 'string' ? (summary['winnerNickname'] as string) : null;
  const rounds = typeof summary['rounds'] === 'number' ? (summary['rounds'] as number) : 0;
  if (!myPeerId || rank === null || totalPlayers === null) return null;

  const rawRankings = summary['rankings'] as unknown;
  const rankings: DartsRankEntry[] = Array.isArray(rawRankings)
    ? (rawRankings as Partial<DartsRankEntry>[])
        .filter((r) =>
          typeof r.peerId === 'string' &&
          typeof r.nickname === 'string' &&
          typeof r.rank === 'number' &&
          typeof r.score === 'number'
        )
        .map((r) => ({
          peerId: r.peerId!,
          nickname: r.nickname!,
          rank: r.rank!,
          score: r.score!,
          scoreLabel: typeof r.scoreLabel === 'string' ? r.scoreLabel : '점수',
        }))
    : [];

  return { myPeerId, rank, totalPlayers, modeLabel, winnerNickname, rankings, rounds };
}

function buildDartsResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  summary: DartsSummary;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, summary, isHost, isSpectator } = args;
  const { emoji, title, titleClass } = isSpectator
    ? { emoji: '🎯', title: '다트 대결 종료', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);
  const actionsHTML = buildActionsHTML(isHost);

  const myEntry = summary.rankings.find((r) => r.peerId === summary.myPeerId);
  const myBlock = isSpectator || !myEntry ? '' : `
    <div class="result-tetris-rank">
      <span class="result-tetris-rank-num">${summary.rank}</span> / ${summary.totalPlayers}위
    </div>
    <div class="result-apple-myscore">
      <div class="result-apple-myscore-label">🎯 ${escapeHtml(myEntry.scoreLabel)}</div>
      <div class="result-apple-myscore-value">${myEntry.score}</div>
    </div>
  `;

  const rankingsHTML = summary.rankings.length >= 1 ? `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 최종 랭킹</div>
      ${summary.rankings.map((r) => {
        const isMe = r.peerId === summary.myPeerId;
        const badgeClass = r.rank <= 3 ? `rank-${r.rank}` : '';
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${r.rank}</span>
            <span class="result-tetris-rank-name">${escapeHtml(r.nickname)}</span>
            <span class="result-apple-rank-score">${r.score}</span>
            ${isMe ? '<span class="result-tetris-rank-me-tag">나</span>' : ''}
          </div>
        `;
      }).join('')}
    </div>
  ` : '';

  const modeRoundBadge = summary.rounds > 0
    ? `<div class="result-gomoku-reason">${escapeHtml(summary.modeLabel)} · ${summary.rounds} 라운드</div>`
    : `<div class="result-gomoku-reason">${escapeHtml(summary.modeLabel)}</div>`;

  return `
    <div class="result-card result-card-tetris">
      <div class="result-emoji">${emoji}</div>
      <div class="result-title ${titleClass}">${title}</div>
      ${modeRoundBadge}
      ${myBlock}
      ${rankingsHTML}

      <div class="result-actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

// ============================================
// 호스트 결과 화면
// ============================================

export interface ResultScreenAsHostArgs {
  host: HostSession;
  roomState: RoomState;
  result: GameResult;
  /** 게임 재시작 시 gameScreen에 다시 넘길 방 비번 정보 */
  isPrivate: boolean;
  password: string;
}

export function createResultScreenAsHostScreen(args: ResultScreenAsHostArgs): Screen {
  const { host, roomState, result, isPrivate, password } = args;
  let closeOnDispose = true;

  // 전적 기록 (호스트는 관전자 될 일 없음 → isSpectator=false 고정)
  recordResultToStats(roomState.gameId, result.winner, result.summary, false);

  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';

      // 게임별 전용 UI 우선 분기, 그 외는 기존 2인 점수판
      const tetris = parseTetrisSummary(result.summary);
      const apple = parseAppleSummary(result.summary);
      const gomoku = parseGomokuSummary(result.summary);
      const reflex = parseReflexSummary(result.summary);
      const darts = parseDartsSummary(result.summary);
      if (tetris) {
        el.innerHTML = buildTetrisResultHTML({
          myWinner: result.winner,
          rank: tetris.rank,
          totalPlayers: tetris.totalPlayers,
          myStats: tetris.myStats,
          rankings: tetris.rankings,
          myPeerId: tetris.myPeerId,
          isHost: true,
        });
      } else if (reflex) {
        el.innerHTML = buildReflexResultHTML({
          myWinner: result.winner,
          rank: reflex.rank,
          totalPlayers: reflex.totalPlayers,
          rankings: reflex.rankings,
          myPeerId: reflex.myPeerId,
          isHost: true,
          isSpectator: false,
        });
      } else if (darts) {
        el.innerHTML = buildDartsResultHTML({
          myWinner: result.winner,
          summary: darts,
          isHost: true,
          isSpectator: false,
        });
      } else if (apple) {
        el.innerHTML = buildAppleResultHTML({
          myWinner: result.winner,
          rank: apple.rank,
          totalPlayers: apple.totalPlayers,
          myScore: apple.myScore,
          rankings: apple.rankings,
          myPeerId: apple.myPeerId,
          isHost: true,
          isSpectator: false, // 호스트는 관전자일 수 없음
        });
      } else if (gomoku) {
        el.innerHTML = buildGomokuResultHTML({
          myWinner: result.winner,
          summary: gomoku,
          isHost: true,
          isSpectator: false, // 호스트는 항상 플레이어
        });
      } else {
        const hostScore = Number(result.summary['hostScore']) || 0;
        const guestScore = Number(result.summary['guestScore']) || 0;
        el.innerHTML = buildResultHTML({
          hostNickname: roomState.hostNickname,
          guestNickname: roomState.guestNickname ?? '상대',
          hostScore,
          guestScore,
          myWinner: result.winner,
          isHost: true,
        });
      }

      const retryBtn = el.querySelector<HTMLButtonElement>('#retry-btn')!;
      const menuBtn = el.querySelector<HTMLButtonElement>('#menu-btn')!;

      retryBtn.addEventListener('click', () => {
        // 같은 방 설정으로 재시작 — 게스트에게 game_start 알림
        host.send({ type: 'game_start' });
        closeOnDispose = false;
        const rs: RoomState = { ...roomState, status: 'playing' };
        router.replace(() => createGameScreenAsHostScreen({ host, roomState: rs, isPrivate, password }));
      });

      menuBtn.addEventListener('click', () => {
        // dispose에서 host.close() 자동 호출 → 게스트도 연결 끊김 알림
        router.reset(() => createMenuScreen());
      });

      // 상대가 먼저 나가면 다시하기 비활성
      host.onGuestDisconnected = () => {
        retryBtn.disabled = true;
        retryBtn.textContent = '상대가 나갔어요';
        retryBtn.classList.remove('btn-primary');
        retryBtn.classList.add('btn-secondary');
      };

      // 결과 화면에선 게스트 메시지 무시
      host.onMessage = null;

      return el;
    },

    dispose() {
      host.onGuestDisconnected = null;
      host.onMessage = null;
      if (closeOnDispose) host.close();
    },
  };
}

// ============================================
// 게스트 결과 화면
// ============================================

export interface ResultScreenAsGuestArgs {
  guest: GuestSession;
  roomState: RoomState;
  result: GameResult;
}

export function createResultScreenAsGuestScreen(args: ResultScreenAsGuestArgs): Screen {
  const { guest, roomState, result } = args;
  let closeOnDispose = true;

  // 전적 기록 (내가 관전자인지 roomState.players 로 판정)
  const mySelf = roomState.players.find((p) => p.peerId === guest.myPeerId);
  const isSpec = mySelf?.role === 'spectator';
  recordResultToStats(roomState.gameId, result.winner, result.summary, isSpec);

  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';

      const tetris = parseTetrisSummary(result.summary);
      const apple = parseAppleSummary(result.summary);
      const gomoku = parseGomokuSummary(result.summary);
      const reflex = parseReflexSummary(result.summary);
      const darts = parseDartsSummary(result.summary);
      // 관전자는 summary.myPeerId 가 자기가 아닐 수 있음 — 자기 peerId 는 guest.myPeerId.
      // rankings 에 "나" 가 없으면 관전자로 간주.
      const myPeerIdForResult = guest.myPeerId;
      if (tetris) {
        el.innerHTML = buildTetrisResultHTML({
          myWinner: result.winner,
          rank: tetris.rank,
          totalPlayers: tetris.totalPlayers,
          myStats: tetris.myStats,
          rankings: tetris.rankings,
          myPeerId: tetris.myPeerId,
          isHost: false,
        });
      } else if (reflex) {
        const isSpec = !reflex.rankings.some((r) => r.peerId === myPeerIdForResult);
        el.innerHTML = buildReflexResultHTML({
          myWinner: result.winner,
          rank: reflex.rank,
          totalPlayers: reflex.totalPlayers,
          rankings: reflex.rankings,
          myPeerId: isSpec ? myPeerIdForResult : reflex.myPeerId,
          isHost: false,
          isSpectator: isSpec,
        });
      } else if (darts) {
        const isSpec = !darts.rankings.some((r) => r.peerId === myPeerIdForResult);
        el.innerHTML = buildDartsResultHTML({
          myWinner: result.winner,
          summary: isSpec ? { ...darts, myPeerId: myPeerIdForResult } : darts,
          isHost: false,
          isSpectator: isSpec,
        });
      } else if (apple) {
        const isSpec = !apple.rankings.some((r) => r.peerId === myPeerIdForResult);
        el.innerHTML = buildAppleResultHTML({
          myWinner: result.winner,
          rank: apple.rank,
          totalPlayers: apple.totalPlayers,
          myScore: apple.myScore,
          rankings: apple.rankings,
          myPeerId: isSpec ? myPeerIdForResult : apple.myPeerId,
          isHost: false,
          isSpectator: isSpec,
        });
      } else if (gomoku) {
        // 오목은 2인 전용이라 관전자 감지는 roomState.players 로 판단.
        const mySelf = roomState.players.find((p) => p.peerId === myPeerIdForResult);
        const isSpec = mySelf?.role === 'spectator';
        el.innerHTML = buildGomokuResultHTML({
          myWinner: result.winner,
          summary: gomoku,
          isHost: false,
          isSpectator: isSpec,
        });
      } else {
        const hostScore = Number(result.summary['hostScore']) || 0;
        const guestScore = Number(result.summary['guestScore']) || 0;
        el.innerHTML = buildResultHTML({
          hostNickname: roomState.hostNickname,
          guestNickname: roomState.guestNickname ?? '나',
          hostScore,
          guestScore,
          myWinner: result.winner,
          isHost: false,
        });
      }

      const menuBtn = el.querySelector<HTMLButtonElement>('#menu-btn')!;

      // 방장이 다시하기 누르면 game_start 수신 → 게임 화면 재진입
      guest.onMessage = (msg) => {
        if (msg.type === 'game_start') {
          closeOnDispose = false;
          const rs: RoomState = { ...roomState, status: 'playing' };
          router.replace(() => createGameScreenAsGuestScreen({ guest, roomState: rs }));
        }
      };

      guest.onDisconnect = () => {
        alert('방장이 방을 나갔어요');
        router.reset(() => createMenuScreen());
      };

      menuBtn.addEventListener('click', () => {
        router.reset(() => createMenuScreen());
      });

      return el;
    },

    dispose() {
      guest.onMessage = null;
      guest.onDisconnect = null;
      if (closeOnDispose) guest.close();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

/**
 * 결과 화면 진입 시 통계에 기록.
 * - 관전자는 기록 안 함 (isSpectator=true면 skip)
 * - 게임별 summary 에서 "최고기록 후보"를 뽑아 storage 에 전달
 */
export function recordResultToStats(
  gameId: string,
  winner: 'me' | 'opponent' | null,
  summary: Record<string, unknown>,
  isSpectator: boolean,
): void {
  if (isSpectator) return; // 관전자는 전적 기록 X

  const bestEntries: Array<{ key: string; value: number; higherIsBetter: boolean }> = [];

  // 게임별 best 기록 후보 추출 — summary 에 gameId 마커 있으면 해당 형식으로 파싱
  const id = summary['gameId'];
  if (id === 'battle-tetris') {
    const myStats = summary['myStats'] as Record<string, unknown> | undefined;
    if (myStats) {
      const lc = Number(myStats['linesCleared']);
      if (Number.isFinite(lc)) bestEntries.push({ key: 'linesCleared', value: lc, higherIsBetter: true });
      const tc = Number(myStats['tetrisCount']);
      if (Number.isFinite(tc)) bestEntries.push({ key: 'tetrisCount', value: tc, higherIsBetter: true });
      const mc = Number(myStats['maxCombo']);
      if (Number.isFinite(mc)) bestEntries.push({ key: 'maxCombo', value: mc, higherIsBetter: true });
    }
  } else if (id === 'apple-game') {
    const ms = Number(summary['myScore']);
    if (Number.isFinite(ms)) bestEntries.push({ key: 'score', value: ms, higherIsBetter: true });
  } else if (id === 'reflex') {
    const rankings = summary['rankings'] as Array<{ peerId: string; avgMs: number }> | undefined;
    const myPeerId = summary['myPeerId'] as string | undefined;
    const mine = rankings?.find(r => r.peerId === myPeerId);
    if (mine && mine.avgMs > 0) {
      // 낮을수록 좋음 (빠른 반응속도)
      bestEntries.push({ key: 'bestMs', value: Math.round(mine.avgMs), higherIsBetter: false });
    }
  } else if (id === 'darts') {
    // 모드별 최고기록 키 분리 — 각 모드가 "승리 의미"와 지표가 다르므로
    const mode = typeof summary['mode'] === 'string' ? (summary['mode'] as string) : '';
    const rounds = Number(summary['rounds']);
    const rankings = summary['rankings'] as Array<{ peerId: string; score: number }> | undefined;
    const myPeerId = summary['myPeerId'] as string | undefined;
    const mine = rankings?.find(r => r.peerId === myPeerId);
    const myScore = mine ? Number(mine.score) : NaN;
    const isWinner = winner === 'me';

    if (mode === '101' || mode === '201' || mode === '301') {
      // X01 은 이긴 판의 소요 라운드만 의미 있음 (적을수록 잘 침)
      if (isWinner && Number.isFinite(rounds) && rounds > 0) {
        bestEntries.push({ key: `bestX01_${mode}_rounds`, value: rounds, higherIsBetter: false });
      }
    } else if (mode === 'countup') {
      if (Number.isFinite(myScore)) {
        bestEntries.push({ key: 'bestCountupHigh', value: myScore, higherIsBetter: true });
      }
    } else if (mode === 'low-countup') {
      // 0점은 한 번도 못 던진 상태라 의미 없음 — 0 보다 클 때만 기록
      if (Number.isFinite(myScore) && myScore > 0) {
        bestEntries.push({ key: 'bestLowCountup', value: myScore, higherIsBetter: false });
      }
    } else if (mode === 'cricket') {
      if (Number.isFinite(myScore)) {
        bestEntries.push({ key: 'bestCricketScore', value: myScore, higherIsBetter: true });
      }
    }
  }
  // 에어하키/오목은 승/패만 기록

  storage.recordGameResult(gameId, winner, bestEntries);
}
