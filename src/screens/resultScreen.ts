import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import type { HostSession, GuestSession } from '../core/peer';
import type { RoomState, GameResult } from '../games/types';
import { createMenuScreen } from './menu';
import { createGameScreenAsHostScreen, createGameScreenAsGuestScreen } from './gameScreen';

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
  if (myWinner === 'opponent') return { emoji: '💫', title: '패배...', titleClass: 'result-title-lose' };
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

  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';

      // 게임별 전용 UI 우선 분기, 그 외는 기존 2인 점수판
      const tetris = parseTetrisSummary(result.summary);
      const apple = parseAppleSummary(result.summary);
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

  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';

      const tetris = parseTetrisSummary(result.summary);
      const apple = parseAppleSummary(result.summary);
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
