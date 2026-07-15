import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import type { HostSession, GuestSession } from '../core/peer';
import type { RoomState, GameResult, GameRoomOption, ChatMsg } from '../games/types';
import { createMenuScreen } from './menu';
import { createGameScreenAsHostScreen, createGameScreenAsGuestScreen } from './gameScreen';
import { storage } from '../core/storage';
import { games, getGameById } from '../games/registry';
import { buildChatPanelHTML, wireChatPanel, appendChatMessage } from '../ui/chat';
import { escapeHtml, escapeAttr } from '../ui/escape';

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

/** 액션 영역 HTML (호스트=다시하기/다른게임/메뉴, 게스트=대기/메뉴)
 *  type="button" 명시: 채팅 form 같은 form context 안에서 default submit 으로 동작하는 걸 차단. */
function buildActionsHTML(isHost: boolean): string {
  return isHost
    ? `
        <button type="button" class="btn btn-primary btn-lg btn-block" id="retry-btn">🔄 다시하기</button>
        <button type="button" class="btn btn-secondary btn-block" id="change-game-btn">🎲 다른 게임 선택</button>
        <button type="button" class="btn btn-ghost btn-block" id="menu-btn">메뉴로</button>
      `
    : `
        <div class="result-waiting-msg" id="waiting-msg">⏳ 방장이 다음을 고르고 있어요</div>
        <button type="button" class="btn btn-ghost btn-block" id="menu-btn">메뉴로 (방 나가기)</button>
      `;
}

// ============================================
// "다른 게임 선택" 오버레이 — 호스트가 같은 방 멤버로 다른 게임 시작
// ============================================

/**
 * 결과 화면 위에 띄우는 게임 선택 + 옵션 모달.
 * 작동 방식:
 *   1. 좌측 게임 카드 그리드 — 현재 인원에 안 맞는 게임은 비활성화 (회색)
 *   2. 카드 클릭 → 우측에 그 게임의 옵션 폼 자동 표시
 *   3. "시작" → host.send(room_state with new gameId/options) + game_start → 양쪽 gameScreen 진입
 *   4. "취소" → 오버레이만 제거, 결과 화면으로 복귀
 */
function buildChangeGameOverlayHTML(currentPlayerCount: number, currentGameId: string): string {
  const cards = games.map((g) => {
    const fits = currentPlayerCount >= g.meta.minPlayers && currentPlayerCount <= g.meta.maxPlayers;
    const playerLabel = g.meta.minPlayers === g.meta.maxPlayers
      ? `${g.meta.minPlayers}인 전용`
      : `${g.meta.minPlayers}~${g.meta.maxPlayers}인`;
    const reason = fits
      ? playerLabel
      : `${playerLabel} (현재 ${currentPlayerCount}명)`;
    const isCurrent = g.meta.id === currentGameId;
    return `
      <button class="change-game-card${fits ? '' : ' is-disabled'}${isCurrent ? ' is-current' : ''}"
              data-game-id="${escapeAttr(g.meta.id)}" ${fits ? '' : 'disabled'}>
        <img class="change-game-card-thumb" src="${escapeAttr(g.meta.thumbnail)}" alt="" />
        <div class="change-game-card-name">${escapeHtml(g.meta.name)}</div>
        <div class="change-game-card-meta">${escapeHtml(reason)}${isCurrent ? ' · 방금 한 게임' : ''}</div>
      </button>
    `;
  }).join('');

  return `
    <div class="change-game-overlay" id="change-game-overlay">
      <div class="change-game-card-wrap">
        <div class="change-game-title">🎲 다른 게임 선택</div>
        <div class="change-game-subtitle">현재 방 멤버 ${currentPlayerCount}명 그대로 시작해요</div>

        <div class="change-game-grid">${cards}</div>

        <div class="change-game-options" id="change-game-options"></div>

        <div class="change-game-actions">
          <button class="btn btn-ghost" id="change-game-cancel-btn">취소</button>
          <button class="btn btn-primary" id="change-game-start-btn" disabled>시작</button>
        </div>
      </div>
    </div>
  `;
}

/** createRoom 의 renderOption 과 동일 — 결과 화면 모달용 옵션 select 렌더 */
function renderOptionForOverlay(opt: GameRoomOption): string {
  return `
    <div class="form-group">
      <label class="input-label">${escapeHtml(opt.label)}</label>
      <select class="select" id="opt-${escapeAttr(opt.key)}">
        ${opt.choices.map((c) => `
          <option value="${escapeAttr(c.value)}"${c.value === opt.defaultValue ? ' selected' : ''}>
            ${escapeHtml(c.label)}
          </option>
        `).join('')}
      </select>
    </div>
  `;
}

/**
 * 결과 화면 위에 "다른 게임 선택" 오버레이 띄움 + 동작 연결.
 *  - 게임 카드 클릭 시 우측에 옵션 폼 자동 갱신
 *  - "시작" 누르면 onStart(gameId, options) 호출
 *  - "취소" 누르면 오버레이 제거 (결과 화면 그대로)
 */
function openChangeGameOverlay(
  parent: HTMLElement,
  args: {
    roomState: RoomState;
    onStart: (gameId: string, options: Record<string, string>) => void;
  },
): () => void {
  // 이미 열려있으면 무시 (정리할 것 없음)
  if (parent.querySelector('#change-game-overlay')) return () => {};

  const overlayHTML = buildChangeGameOverlayHTML(
    args.roomState.players.length,
    args.roomState.gameId,
  );
  parent.insertAdjacentHTML('beforeend', overlayHTML);
  const overlay = parent.querySelector<HTMLDivElement>('#change-game-overlay')!;
  const optsContainer = overlay.querySelector<HTMLDivElement>('#change-game-options')!;
  const startBtn = overlay.querySelector<HTMLButtonElement>('#change-game-start-btn')!;
  const cancelBtn = overlay.querySelector<HTMLButtonElement>('#change-game-cancel-btn')!;

  let selectedGameId: string | null = null;
  let selectedOptions: Record<string, string> = {};

  const enabledCards = overlay.querySelectorAll<HTMLButtonElement>('.change-game-card:not(.is-disabled)');

  // 게임 카드 클릭 → 옵션 폼 + 시작 버튼 활성
  enabledCards.forEach((card) => {
    card.addEventListener('click', () => {
      const gid = card.dataset.gameId;
      if (!gid) return;
      const game = getGameById(gid);
      if (!game) return;

      selectedGameId = gid;
      selectedOptions = {};
      for (const opt of game.meta.roomOptions) {
        selectedOptions[opt.key] = opt.defaultValue;
      }

      // 카드 active 시각 처리
      overlay.querySelectorAll('.change-game-card').forEach((c) => c.classList.remove('is-selected'));
      card.classList.add('is-selected');

      // 옵션 폼 갱신 — 옵션 없는 게임은 안내만
      if (game.meta.roomOptions.length > 0) {
        optsContainer.innerHTML = `
          <div class="change-game-options-title">⚙️ 게임 설정</div>
          ${game.meta.roomOptions.map(renderOptionForOverlay).join('')}
        `;
        for (const opt of game.meta.roomOptions) {
          const sel = optsContainer.querySelector<HTMLSelectElement>(`#opt-${opt.key}`);
          sel?.addEventListener('change', () => {
            selectedOptions[opt.key] = sel.value;
          });
        }
      } else {
        optsContainer.innerHTML = `<div class="change-game-no-options">설정 없이 바로 시작할 수 있어요</div>`;
      }

      startBtn.disabled = false;
    });
  });

  const closeOverlay = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeOverlay();
  };
  document.addEventListener('keydown', onKeyDown);

  cancelBtn.addEventListener('click', closeOverlay);
  // 배경 클릭 닫기는 의도치 않은 닫힘 유발 — 닫으려면 취소 버튼 또는 ESC.

  startBtn.addEventListener('click', () => {
    if (!selectedGameId) return;
    document.removeEventListener('keydown', onKeyDown);
    args.onStart(selectedGameId, selectedOptions);
  });

  // 결과 화면이 (취소/시작/ESC 없이) 다른 경로로 dispose 될 때 document keydown 리스너가
  // 남지 않도록 정리 함수를 돌려준다. closeOverlay 는 중복 호출해도 안전.
  return closeOverlay;
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
// 스토리텔링 전용 결과 HTML (승패 없음)
// ============================================

/** story-draw 요약인지 (점수/랭킹 없음 — gameId 로만 식별) */
function isStoryDrawSummary(summary: Record<string, unknown>): boolean {
  return summary['gameId'] === 'story-draw';
}

/** 승패 없는 "감상 완료" 카드 — 2인 점수판(0:0) 대신 이걸 보여준다 */
function buildStoryDrawResultHTML(isHost: boolean): string {
  const actionsHTML = buildActionsHTML(isHost);
  return `
    <div class="result-card">
      <div class="result-emoji">🎨</div>
      <div class="result-title">이야기 완성!</div>
      <p class="result-note">모두가 이어 그린 그림 이야기, 재밌었나요?<br>승패 없이 다 같이 감상하는 게임이에요.</p>
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
  /** 이번 판 호스트가 잡은 색 — 흑/백 닉네임 매핑에 사용 (다시하기마다 swap) */
  hostSide: 'B' | 'W';
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
  // 구버전 summary 호환: hostSide 누락 시 'B' (기존 호스트=흑 고정 동작)
  const hostSideRaw = summary['hostSide'];
  const hostSide: 'B' | 'W' = hostSideRaw === 'W' ? 'W' : 'B';

  if (!myPeerId) return null;
  return { myPeerId, reason, moveCount, durationMs, hostNickname, guestNickname, hostSide, winnerNickname, winnerSide };
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
  const { reason, moveCount, durationMs, hostNickname, guestNickname, hostSide, winnerSide } = summary;

  // 관전자는 중립적 타이틀, 플레이어는 내 승/패/무 기준
  const { emoji, title, titleClass } = isSpectator
    ? { emoji: '🎯', title: '승부!', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);

  const actionsHTML = buildActionsHTML(isHost);
  const reasonLabel = gomokuReasonLabel(reason);

  // hostSide 기반으로 흑/백 닉네임 매핑 (swap 된 게임 대응)
  const blackNickname = hostSide === 'B' ? hostNickname : guestNickname;
  const whiteNickname = hostSide === 'W' ? hostNickname : guestNickname;
  const blackWon = winnerSide === 'B';
  const whiteWon = winnerSide === 'W';

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
        ${playerBlock({ side: 'B', nickname: blackNickname, isWinner: blackWon })}
        <div class="result-gomoku-vs">VS</div>
        ${playerBlock({ side: 'W', nickname: whiteNickname, isWinner: whiteWon })}
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
// 라이어 게임 전용 결과 HTML
// ============================================

interface LiarRankEntry {
  peerId: string;
  nickname: string;
  rank: number;
  score: number;
}

function parseLiarSummary(summary: Record<string, unknown>): {
  myPeerId: string;
  rank: number;
  totalPlayers: number;
  rankings: LiarRankEntry[];
} | null {
  if (summary['gameId'] !== 'liar-game') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  const rank = typeof summary['rank'] === 'number' ? (summary['rank'] as number) : null;
  const totalPlayers = typeof summary['totalPlayers'] === 'number' ? (summary['totalPlayers'] as number) : null;
  const rawRankings = summary['rankings'] as unknown;
  if (!myPeerId || rank === null || totalPlayers === null) return null;

  const rankings: LiarRankEntry[] = Array.isArray(rawRankings)
    ? (rawRankings as Partial<LiarRankEntry>[])
        .filter((r) =>
          typeof r.peerId === 'string' &&
          typeof r.nickname === 'string' &&
          typeof r.rank === 'number' &&
          typeof r.score === 'number')
        .map((r) => ({ peerId: r.peerId!, nickname: r.nickname!, rank: r.rank!, score: r.score! }))
    : [];

  return { myPeerId, rank, totalPlayers, rankings };
}

function buildLiarResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  rank: number;
  totalPlayers: number;
  rankings: LiarRankEntry[];
  myPeerId: string;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, rank, totalPlayers, rankings, myPeerId, isHost, isSpectator } = args;
  const { emoji, title, titleClass } = isSpectator
    ? { emoji: '🕵️', title: '라이어 게임 종료', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);
  const actionsHTML = buildActionsHTML(isHost);

  const myBlock = isSpectator ? '' : `
    <div class="result-tetris-rank">
      <span class="result-tetris-rank-num">${rank}</span> / ${totalPlayers}위
    </div>
  `;

  const rankingsHTML = rankings.length >= 1 ? `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 최종 순위</div>
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
// 라면가게 전용 결과 HTML
// ============================================

interface RamenRankEntry {
  peerId: string;
  nickname: string;
  rank: number;
  score: number;
}

function parseRamenSummary(summary: Record<string, unknown>): {
  myPeerId: string;
  rank: number;
  totalPlayers: number;
  myScore: number;
  rankings: RamenRankEntry[];
} | null {
  if (summary['gameId'] !== 'ramen-shop') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  const rank = typeof summary['rank'] === 'number' ? (summary['rank'] as number) : null;
  const totalPlayers = typeof summary['totalPlayers'] === 'number' ? (summary['totalPlayers'] as number) : null;
  const myScore = typeof summary['myScore'] === 'number' ? (summary['myScore'] as number) : 0;
  const rawRankings = summary['rankings'] as unknown;
  if (!myPeerId || rank === null || totalPlayers === null) return null;

  const rankings: RamenRankEntry[] = Array.isArray(rawRankings)
    ? (rawRankings as Partial<RamenRankEntry>[])
        .filter((r) =>
          typeof r.peerId === 'string' &&
          typeof r.nickname === 'string' &&
          typeof r.rank === 'number' &&
          typeof r.score === 'number')
        .map((r) => ({ peerId: r.peerId!, nickname: r.nickname!, rank: r.rank!, score: r.score! }))
    : [];

  return { myPeerId, rank, totalPlayers, myScore, rankings };
}

function buildRamenResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  rank: number;
  totalPlayers: number;
  myScore: number;
  rankings: RamenRankEntry[];
  myPeerId: string;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, rank, totalPlayers, myScore, rankings, myPeerId, isHost, isSpectator } = args;
  const { emoji, title, titleClass } = isSpectator
    ? { emoji: '🍜', title: '라면가게 영업 종료', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);
  const actionsHTML = buildActionsHTML(isHost);

  const myBlock = isSpectator ? '' : `
    <div class="result-tetris-rank">
      <span class="result-tetris-rank-num">${rank}</span> / ${totalPlayers}위
    </div>
    <div class="result-apple-myscore">
      <div class="result-apple-myscore-label">💰 내 매출</div>
      <div class="result-apple-myscore-value">${myScore.toLocaleString()}원</div>
    </div>
  `;

  const rankingsHTML = rankings.length >= 1 ? `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 매출 순위</div>
      ${rankings.map((r) => {
        const isMe = r.peerId === myPeerId;
        const badgeClass = r.rank <= 3 ? `rank-${r.rank}` : '';
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${r.rank}</span>
            <span class="result-tetris-rank-name">${escapeHtml(r.nickname)}</span>
            <span class="result-apple-rank-score">${r.score.toLocaleString()}원</span>
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
// 폭탄 끝말잇기 전용 결과 HTML
// ============================================

interface BombPlayerEntry {
  peerId: string;
  nickname: string;
  survived: boolean;
}

function parseBombSummary(summary: Record<string, unknown>): {
  myPeerId: string;
  loserPeerId: string | null;
  loserNickname: string;
  wordCount: number;
  players: BombPlayerEntry[];
} | null {
  if (summary['gameId'] !== 'bomb-wordchain') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  if (!myPeerId) return null;
  const loserPeerId = typeof summary['loserPeerId'] === 'string' ? (summary['loserPeerId'] as string) : null;
  const loserNickname = typeof summary['loserNickname'] === 'string' ? (summary['loserNickname'] as string) : '?';
  const wordCount = typeof summary['wordCount'] === 'number' ? (summary['wordCount'] as number) : 0;
  const rawPlayers = summary['players'] as unknown;
  const players: BombPlayerEntry[] = Array.isArray(rawPlayers)
    ? (rawPlayers as Partial<BombPlayerEntry>[])
        .filter((p) => typeof p.peerId === 'string' && typeof p.nickname === 'string')
        .map((p) => ({ peerId: p.peerId!, nickname: p.nickname!, survived: !!p.survived }))
    : [];
  return { myPeerId, loserPeerId, loserNickname, wordCount, players };
}

function buildBombResultHTML(args: {
  summary: ReturnType<typeof parseBombSummary>;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const s = args.summary!;
  const { isHost, isSpectator } = args;
  const iLost = !isSpectator && s.loserPeerId === s.myPeerId;
  const emoji = isSpectator ? '💣' : iLost ? '💥' : '😌';
  const title = isSpectator ? '폭탄 터짐!' : iLost ? '펑! 내가 폭탄을…' : '살았다!';
  const titleClass = iLost ? 'result-title-lose' : 'result-title-win';
  const actionsHTML = buildActionsHTML(isHost);

  // 폭발한 사람 먼저(강조), 나머지 생존자.
  const sorted = [...s.players].sort((a, b) => Number(a.survived) - Number(b.survived));

  const rankingsHTML = `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 결과</div>
      ${sorted.map((p) => {
        const isMe = p.peerId === s.myPeerId;
        const badgeClass = p.survived ? '' : 'rank-1';
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${p.survived ? '😌' : '💥'}</span>
            <span class="result-tetris-rank-name">${escapeHtml(p.nickname)}</span>
            <span class="result-apple-rank-score">${p.survived ? '생존' : '폭발'}</span>
            ${isMe ? '<span class="result-tetris-rank-me-tag">나</span>' : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;

  const reasonBadge = `<div class="result-gomoku-reason">💣 ${escapeHtml(s.loserNickname)} 폭발 · ${s.wordCount}단어 이어감</div>`;

  return `
    <div class="result-card result-card-tetris">
      <div class="result-emoji">${emoji}</div>
      <div class="result-title ${titleClass}">${title}</div>
      ${reasonBadge}
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
// 알까기 전용 결과 HTML
// ============================================

interface AlgagiPlayerEntry {
  peerId: string;
  nickname: string;
  liveCount: number;
}

interface AlgagiSummary {
  myPeerId: string;
  winnerNickname: string | null;
  turnCount: number;
  players: AlgagiPlayerEntry[];
}

function parseAlgagiSummary(summary: Record<string, unknown>): AlgagiSummary | null {
  if (summary['gameId'] !== 'algagi') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  const winnerNickname = typeof summary['winnerNickname'] === 'string' ? (summary['winnerNickname'] as string) : null;
  const turnCount = typeof summary['turnCount'] === 'number' ? (summary['turnCount'] as number) : 0;
  if (!myPeerId) return null;

  const rawPlayers = summary['players'] as unknown;
  const players: AlgagiPlayerEntry[] = Array.isArray(rawPlayers)
    ? (rawPlayers as Partial<AlgagiPlayerEntry>[])
        .filter((p) =>
          typeof p.peerId === 'string' &&
          typeof p.nickname === 'string' &&
          typeof p.liveCount === 'number',
        )
        .map((p) => ({
          peerId: p.peerId!,
          nickname: p.nickname!,
          liveCount: p.liveCount!,
        }))
    : [];

  return { myPeerId, winnerNickname, turnCount, players };
}

function buildAlgagiResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  summary: AlgagiSummary;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, summary, isHost, isSpectator } = args;
  const { emoji, title, titleClass } = isSpectator
    ? { emoji: '🪨', title: '알까기 종료', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);
  const actionsHTML = buildActionsHTML(isHost);

  // 살아있는 알 많은 순 정렬 (= 우승자 먼저). 동률이면 닉네임 사전순.
  const sorted = [...summary.players].sort((a, b) => {
    if (b.liveCount !== a.liveCount) return b.liveCount - a.liveCount;
    return a.nickname.localeCompare(b.nickname);
  });

  const rankingsHTML = `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 남은 알</div>
      ${sorted.map((p, idx) => {
        const isMe = p.peerId === summary.myPeerId;
        const isWinner = summary.winnerNickname !== null && p.nickname === summary.winnerNickname;
        const badgeClass = isWinner ? 'rank-1' : '';
        const rankNum = isWinner ? 1 : idx + 1;
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${rankNum}</span>
            <span class="result-tetris-rank-name">${escapeHtml(p.nickname)}</span>
            <span class="result-apple-rank-score">${p.liveCount === 0 ? 'OUT' : `${p.liveCount}개`}</span>
            ${isMe ? '<span class="result-tetris-rank-me-tag">나</span>' : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;

  const reasonBadge = summary.winnerNickname
    ? `<div class="result-gomoku-reason">${escapeHtml(summary.winnerNickname)} 승리 · ${summary.turnCount}턴 진행</div>`
    : `<div class="result-gomoku-reason">무승부 · ${summary.turnCount}턴 진행</div>`;

  return `
    <div class="result-card result-card-tetris">
      <div class="result-emoji">${emoji}</div>
      <div class="result-title ${titleClass}">${title}</div>
      ${reasonBadge}
      ${rankingsHTML}

      <div class="result-actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

// ============================================
// 끝말잇기 전용 결과 HTML
// ============================================

interface WordChainPlayerEntry {
  peerId: string;
  nickname: string;
  alive: boolean;
  outReason: string | null;
}

interface WordChainSummary {
  myPeerId: string;
  winnerNickname: string | null;
  totalRounds: number;
  players: WordChainPlayerEntry[];
}

function parseWordChainSummary(summary: Record<string, unknown>): WordChainSummary | null {
  if (summary['gameId'] !== 'word-chain') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  const winnerNickname = typeof summary['winnerNickname'] === 'string' ? (summary['winnerNickname'] as string) : null;
  const totalRounds = typeof summary['totalRounds'] === 'number' ? (summary['totalRounds'] as number) : 0;
  if (!myPeerId) return null;

  const rawPlayers = summary['players'] as unknown;
  const players: WordChainPlayerEntry[] = Array.isArray(rawPlayers)
    ? (rawPlayers as Array<Partial<WordChainPlayerEntry>>)
        .filter((p) => typeof p.peerId === 'string' && typeof p.nickname === 'string')
        .map((p) => ({
          peerId: p.peerId!,
          nickname: p.nickname!,
          alive: !!p.alive,
          outReason: typeof p.outReason === 'string' ? p.outReason : null,
        }))
    : [];

  return { myPeerId, winnerNickname, totalRounds, players };
}

function wcReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'timeout':    return '시간 초과';
    case 'invalid':    return '잘못된 형식';
    case 'wrongStart': return '시작 글자 틀림';
    case 'duplicate':  return '중복 사용';
    case 'notInDict':  return '사전에 없음';
    default:           return '';
  }
}

function buildWordChainResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  summary: WordChainSummary;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, summary, isHost, isSpectator } = args;
  const { emoji, title, titleClass } = isSpectator
    ? { emoji: '🔤', title: '끝말잇기 종료', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);
  const actionsHTML = buildActionsHTML(isHost);

  // 생존자 먼저, 그 다음 탈락자. 같은 그룹 안에선 닉네임 순.
  const sorted = [...summary.players].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return a.nickname.localeCompare(b.nickname);
  });

  const rankingsHTML = `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 결과</div>
      ${sorted.map((p, idx) => {
        const isMe = p.peerId === summary.myPeerId;
        const isWinner = summary.winnerNickname !== null && p.nickname === summary.winnerNickname;
        const badgeClass = isWinner ? 'rank-1' : '';
        const rankNum = isWinner ? 1 : idx + 1;
        const status = p.alive
          ? '🏆 생존'
          : `💀 ${wcReasonLabel(p.outReason)}`;
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${rankNum}</span>
            <span class="result-tetris-rank-name">${escapeHtml(p.nickname)}</span>
            <span class="result-apple-rank-score">${status}</span>
            ${isMe ? '<span class="result-tetris-rank-me-tag">나</span>' : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;

  const reasonBadge = summary.winnerNickname
    ? `<div class="result-gomoku-reason">${escapeHtml(summary.winnerNickname)} 승리 · ${summary.totalRounds}단어 진행</div>`
    : `<div class="result-gomoku-reason">무승부 · ${summary.totalRounds}단어 진행</div>`;

  return `
    <div class="result-card result-card-tetris">
      <div class="result-emoji">${emoji}</div>
      <div class="result-title ${titleClass}">${title}</div>
      ${reasonBadge}
      ${rankingsHTML}

      <div class="result-actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

// ============================================
// 그림 퀴즈 전용 결과 HTML
// ============================================

interface DrawQuizRankEntry {
  peerId: string;
  nickname: string;
  score: number;
  rank: number;
}

interface DrawQuizSummary {
  myPeerId: string;
  coWinnerNicknames: string[];
  isCoWin: boolean;
  rankings: DrawQuizRankEntry[];
}

function parseDrawQuizSummary(summary: Record<string, unknown>): DrawQuizSummary | null {
  if (summary['gameId'] !== 'draw-quiz') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  if (!myPeerId) return null;

  const rawWinners = summary['coWinnerNicknames'] as unknown;
  const coWinnerNicknames: string[] = Array.isArray(rawWinners)
    ? (rawWinners as unknown[]).filter((w): w is string => typeof w === 'string')
    : [];

  const rawRankings = summary['rankings'] as unknown;
  const rankings: DrawQuizRankEntry[] = Array.isArray(rawRankings)
    ? (rawRankings as Array<Partial<DrawQuizRankEntry>>)
        .filter((r) => typeof r.peerId === 'string' && typeof r.nickname === 'string' && typeof r.score === 'number')
        .map((r) => ({ peerId: r.peerId!, nickname: r.nickname!, score: r.score!, rank: typeof r.rank === 'number' ? r.rank : 0 }))
    : [];

  return { myPeerId, coWinnerNicknames, isCoWin: summary['isCoWin'] === true, rankings };
}

function buildDrawQuizResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  summary: DrawQuizSummary;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, summary, isHost, isSpectator } = args;
  // 공동 우승이면 승리 타이틀을 "공동 우승" 으로 (내가 그 안에 들면 강조)
  let visuals = isSpectator
    ? { emoji: '🎨', title: '그림 퀴즈 종료', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);
  if (!isSpectator && summary.isCoWin && myWinner === 'me') {
    visuals = { emoji: '🏆', title: '공동 우승!', titleClass: 'result-title-win' };
  }
  const { emoji, title, titleClass } = visuals;
  const actionsHTML = buildActionsHTML(isHost);

  const rankingsHTML = `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 맞춘 개수</div>
      ${summary.rankings.map((r) => {
        const isMe = r.peerId === summary.myPeerId;
        const badgeClass = r.rank <= 3 ? `rank-${r.rank}` : '';
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${r.rank}</span>
            <span class="result-tetris-rank-name">${escapeHtml(r.nickname)}</span>
            <span class="result-apple-rank-score">${r.score}개</span>
            ${isMe ? '<span class="result-tetris-rank-me-tag">나</span>' : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;

  const reasonBadge = summary.coWinnerNicknames.length === 0
    ? `<div class="result-gomoku-reason">무승부 🤝</div>`
    : summary.coWinnerNicknames.length >= 2
      ? `<div class="result-gomoku-reason">🤝 공동 우승 · ${summary.coWinnerNicknames.map(escapeHtml).join(', ')}</div>`
      : `<div class="result-gomoku-reason">${escapeHtml(summary.coWinnerNicknames[0]!)} 우승 🎉</div>`;

  return `
    <div class="result-card result-card-tetris">
      <div class="result-emoji">${emoji}</div>
      <div class="result-title ${titleClass}">${title}</div>
      ${reasonBadge}
      ${rankingsHTML}

      <div class="result-actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

// ============================================
// 포트리스 전용 결과 HTML
// ============================================

interface FortressRankEntry {
  peerId: string;
  nickname: string;
  hp: number;
  rank: number;
}

interface FortressSummary {
  myPeerId: string;
  coWinnerNicknames: string[];
  isCoWin: boolean;
  rankings: FortressRankEntry[];
}

function parseFortressSummary(summary: Record<string, unknown>): FortressSummary | null {
  if (summary['gameId'] !== 'fortress') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  if (!myPeerId) return null;
  const rawWinners = summary['coWinnerNicknames'] as unknown;
  const coWinnerNicknames: string[] = Array.isArray(rawWinners)
    ? (rawWinners as unknown[]).filter((w): w is string => typeof w === 'string')
    : [];
  const rawRankings = summary['rankings'] as unknown;
  const rankings: FortressRankEntry[] = Array.isArray(rawRankings)
    ? (rawRankings as Array<Partial<FortressRankEntry>>)
        .filter((r) => typeof r.peerId === 'string' && typeof r.nickname === 'string' && typeof r.hp === 'number')
        .map((r) => ({ peerId: r.peerId!, nickname: r.nickname!, hp: r.hp!, rank: typeof r.rank === 'number' ? r.rank : 0 }))
    : [];
  return { myPeerId, coWinnerNicknames, isCoWin: summary['isCoWin'] === true, rankings };
}

function buildFortressResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  summary: FortressSummary;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, summary, isHost, isSpectator } = args;
  let visuals = isSpectator
    ? { emoji: '💥', title: '포트리스 종료', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);
  if (!isSpectator && summary.isCoWin && myWinner === 'me') {
    visuals = { emoji: '🏆', title: '공동 우승!', titleClass: 'result-title-win' };
  }
  const { emoji, title, titleClass } = visuals;
  const actionsHTML = buildActionsHTML(isHost);

  const rankingsHTML = `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 결과</div>
      ${summary.rankings.map((r) => {
        const isMe = r.peerId === summary.myPeerId;
        const badgeClass = r.rank <= 3 ? `rank-${r.rank}` : '';
        const status = r.hp > 0 ? `❤️ ${r.hp}` : '💥 파괴';
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${r.rank}</span>
            <span class="result-tetris-rank-name">${escapeHtml(r.nickname)}</span>
            <span class="result-apple-rank-score">${status}</span>
            ${isMe ? '<span class="result-tetris-rank-me-tag">나</span>' : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;

  const reasonBadge = summary.coWinnerNicknames.length === 0
    ? `<div class="result-gomoku-reason">무승부 🤝</div>`
    : summary.coWinnerNicknames.length >= 2
      ? `<div class="result-gomoku-reason">🤝 공동 우승 · ${summary.coWinnerNicknames.map(escapeHtml).join(', ')}</div>`
      : `<div class="result-gomoku-reason">${escapeHtml(summary.coWinnerNicknames[0]!)} 승리 🎉</div>`;

  return `
    <div class="result-card result-card-tetris">
      <div class="result-emoji">${emoji}</div>
      <div class="result-title ${titleClass}">${title}</div>
      ${reasonBadge}
      ${rankingsHTML}

      <div class="result-actions">
        ${actionsHTML}
      </div>
    </div>
  `;
}

// ============================================
// 똥 피하기 전용 결과 HTML
// ============================================

interface DodgeRankEntry {
  peerId: string;
  nickname: string;
  rank: number;
  survivalMs: number;
}

interface DodgeSummary {
  myPeerId: string;
  totalPlayers: number;
  rankings: DodgeRankEntry[];
}

function parseDodgeSummary(summary: Record<string, unknown>): DodgeSummary | null {
  if (summary['gameId'] !== 'dodge') return null;
  const myPeerId = typeof summary['myPeerId'] === 'string' ? (summary['myPeerId'] as string) : null;
  const totalPlayers = typeof summary['totalPlayers'] === 'number' ? (summary['totalPlayers'] as number) : null;
  if (!myPeerId || totalPlayers === null) return null;
  const rawRankings = summary['rankings'] as unknown;
  const rankings: DodgeRankEntry[] = Array.isArray(rawRankings)
    ? (rawRankings as Array<Partial<DodgeRankEntry>>)
        .filter((r) =>
          typeof r.peerId === 'string' &&
          typeof r.nickname === 'string' &&
          typeof r.rank === 'number' &&
          typeof r.survivalMs === 'number')
        .map((r) => ({ peerId: r.peerId!, nickname: r.nickname!, rank: r.rank!, survivalMs: r.survivalMs! }))
    : [];
  return { myPeerId, totalPlayers, rankings };
}

function buildDodgeResultHTML(args: {
  myWinner: 'me' | 'opponent' | null;
  summary: DodgeSummary;
  isHost: boolean;
  isSpectator: boolean;
}): string {
  const { myWinner, summary, isHost, isSpectator } = args;
  const { emoji, title, titleClass } = isSpectator
    ? { emoji: '💩', title: '똥 피하기 종료', titleClass: 'result-title-draw' }
    : winnerVisuals(myWinner);
  const actionsHTML = buildActionsHTML(isHost);

  const myEntry = summary.rankings.find((r) => r.peerId === summary.myPeerId);
  const myBlock = isSpectator || !myEntry ? '' : `
    <div class="result-tetris-rank">
      <span class="result-tetris-rank-num">${myEntry.rank}</span> / ${summary.totalPlayers}위
    </div>
    <div class="result-apple-myscore">
      <div class="result-apple-myscore-label">⏱ 내 생존시간</div>
      <div class="result-apple-myscore-value">${(myEntry.survivalMs / 1000).toFixed(1)}초</div>
    </div>
  `;

  const rankingsHTML = summary.rankings.length >= 1 ? `
    <div class="result-tetris-rankings">
      <div class="result-tetris-rankings-title">🏅 생존 순위</div>
      ${summary.rankings.map((r) => {
        const isMe = r.peerId === summary.myPeerId;
        const badgeClass = r.rank <= 3 ? `rank-${r.rank}` : '';
        return `
          <div class="result-tetris-rank-row ${isMe ? 'is-me' : ''}">
            <span class="result-tetris-rank-badge ${badgeClass}">${r.rank}</span>
            <span class="result-tetris-rank-name">${escapeHtml(r.nickname)}</span>
            <span class="result-apple-rank-score">${(r.survivalMs / 1000).toFixed(1)}초</span>
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
  let cleanupChat: (() => void) | null = null;
  /** "다른 게임 선택" 오버레이 정리 함수 (열려있으면 document keydown 리스너 제거) */
  let cleanupChangeGame: (() => void) | null = null;

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
      const algagi = parseAlgagiSummary(result.summary);
      const wordChain = parseWordChainSummary(result.summary);
      const drawQuiz = parseDrawQuizSummary(result.summary);
      const fortress = parseFortressSummary(result.summary);
      const liar = parseLiarSummary(result.summary);
      const ramen = parseRamenSummary(result.summary);
      const bomb = parseBombSummary(result.summary);
      const dodge = parseDodgeSummary(result.summary);
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
      } else if (dodge) {
        el.innerHTML = buildDodgeResultHTML({
          myWinner: result.winner, summary: dodge, isHost: true, isSpectator: false,
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
      } else if (algagi) {
        el.innerHTML = buildAlgagiResultHTML({
          myWinner: result.winner,
          summary: algagi,
          isHost: true,
          isSpectator: false,
        });
      } else if (wordChain) {
        el.innerHTML = buildWordChainResultHTML({
          myWinner: result.winner,
          summary: wordChain,
          isHost: true,
          isSpectator: false,
        });
      } else if (drawQuiz) {
        el.innerHTML = buildDrawQuizResultHTML({
          myWinner: result.winner,
          summary: drawQuiz,
          isHost: true,
          isSpectator: false,
        });
      } else if (fortress) {
        el.innerHTML = buildFortressResultHTML({
          myWinner: result.winner,
          summary: fortress,
          isHost: true,
          isSpectator: false,
        });
      } else if (liar) {
        el.innerHTML = buildLiarResultHTML({
          myWinner: result.winner,
          rank: liar.rank,
          totalPlayers: liar.totalPlayers,
          rankings: liar.rankings,
          myPeerId: liar.myPeerId,
          isHost: true,
          isSpectator: false,
        });
      } else if (ramen) {
        el.innerHTML = buildRamenResultHTML({
          myWinner: result.winner,
          rank: ramen.rank,
          totalPlayers: ramen.totalPlayers,
          myScore: ramen.myScore,
          rankings: ramen.rankings,
          myPeerId: ramen.myPeerId,
          isHost: true,
          isSpectator: false,
        });
      } else if (bomb) {
        el.innerHTML = buildBombResultHTML({ summary: bomb, isHost: true, isSpectator: false });
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
      } else if (isStoryDrawSummary(result.summary)) {
        el.innerHTML = buildStoryDrawResultHTML(true);
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

      // 채팅 패널을 결과 카드 옆에 추가
      el.insertAdjacentHTML('beforeend', buildChatPanelHTML());

      const retryBtn = el.querySelector<HTMLButtonElement>('#retry-btn')!;
      const menuBtn = el.querySelector<HTMLButtonElement>('#menu-btn')!;
      const changeGameBtn = el.querySelector<HTMLButtonElement>('#change-game-btn')!;

      // 채팅 패널 — 호스트: 자기 화면 append + 모든 게스트 broadcast
      const hostNick = roomState.hostNickname;
      cleanupChat = wireChatPanel(el, {
        onSend: (text) => {
          const msg: ChatMsg = {
            type: 'chat',
            peerId: host.myPeerId,
            nickname: hostNick,
            text,
            timestamp: Date.now(),
          };
          appendChatMessage(el, msg, true);
          host.send(msg);
        },
      });

      retryBtn.addEventListener('click', () => {
        // 오목: 매 다시하기마다 호스트 흑/백 토글. 다른 게임은 그대로.
        let nextRoomOptions = roomState.roomOptions;
        if (roomState.gameId === 'gomoku') {
          const prev = roomState.roomOptions['gomoku_hostSide'] ?? 'B';
          nextRoomOptions = {
            ...roomState.roomOptions,
            gomoku_hostSide: prev === 'B' ? 'W' : 'B',
          };
        }
        const rs: RoomState = { ...roomState, roomOptions: nextRoomOptions, status: 'playing' };
        // 옵션이 바뀌었으면 게스트에게도 갱신된 방 상태 알림 (game_start 전에)
        if (nextRoomOptions !== roomState.roomOptions) {
          host.send({ type: 'room_state', roomState: rs });
        }
        host.send({ type: 'game_start' });
        closeOnDispose = false;
        router.replace(() => createGameScreenAsHostScreen({ host, roomState: rs, isPrivate, password }));
      });

      menuBtn.addEventListener('click', () => {
        // dispose에서 host.close() 자동 호출 → 게스트도 연결 끊김 알림
        router.reset(() => createMenuScreen());
      });

      // 다른 게임 선택 — 결과 카드 위에 오버레이로 게임/옵션 선택 모달 띄움
      changeGameBtn.addEventListener('click', () => {
        cleanupChangeGame = openChangeGameOverlay(el, {
          roomState,
          onStart: (newGameId, newOptions) => {
            const newRoomState: RoomState = {
              ...roomState,
              gameId: newGameId,
              roomOptions: { ...newOptions },
              status: 'playing',
            };
            // 게스트에게 새 방 상태 + 게임 시작 통지 (room_state → game_start 순서)
            host.send({ type: 'room_state', roomState: newRoomState });
            host.send({ type: 'game_start' });
            closeOnDispose = false;
            router.replace(() => createGameScreenAsHostScreen({
              host,
              roomState: newRoomState,
              isPrivate,
              password,
            }));
          },
        });
      });

      // 상대가 먼저 나가면 다시하기 + 다른 게임 선택 비활성
      host.onGuestDisconnected = () => {
        retryBtn.disabled = true;
        retryBtn.textContent = '상대가 나갔어요';
        retryBtn.classList.remove('btn-primary');
        retryBtn.classList.add('btn-secondary');
        changeGameBtn.disabled = true;
      };

      // 결과 화면에선 게임 관련 메시지는 무시하고 chat 만 처리 + relay
      host.onMessage = (msg, fromPeerId) => {
        if (msg.type === 'chat') {
          appendChatMessage(el, msg, false);
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) host.sendTo(pid, msg);
          }
        }
      };

      return el;
    },

    dispose() {
      host.onGuestDisconnected = null;
      host.onMessage = null;
      cleanupChat?.();
      cleanupChat = null;
      cleanupChangeGame?.();
      cleanupChangeGame = null;
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
  const { guest, result } = args;
  // 호스트가 다른 게임을 고르면 room_state 메시지로 갱신될 수 있음 → mutable.
  // game_start 받을 때 이 최신 state 로 gameScreen 진입.
  let currentRoomState = args.roomState;
  let closeOnDispose = true;
  let cleanupChat: (() => void) | null = null;

  // 전적 기록 (내가 관전자인지 roomState.players 로 판정)
  const mySelf = currentRoomState.players.find((p) => p.peerId === guest.myPeerId);
  const isSpec = mySelf?.role === 'spectator';
  recordResultToStats(currentRoomState.gameId, result.winner, result.summary, isSpec);

  return {
    render() {
      const el = document.createElement('div');
      el.className = 'screen';

      const tetris = parseTetrisSummary(result.summary);
      const apple = parseAppleSummary(result.summary);
      const gomoku = parseGomokuSummary(result.summary);
      const reflex = parseReflexSummary(result.summary);
      const darts = parseDartsSummary(result.summary);
      const algagi = parseAlgagiSummary(result.summary);
      const wordChain = parseWordChainSummary(result.summary);
      const drawQuiz = parseDrawQuizSummary(result.summary);
      const fortress = parseFortressSummary(result.summary);
      const liar = parseLiarSummary(result.summary);
      const ramen = parseRamenSummary(result.summary);
      const bomb = parseBombSummary(result.summary);
      const dodge = parseDodgeSummary(result.summary);
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
      } else if (dodge) {
        const isSpec = !dodge.rankings.some((r) => r.peerId === myPeerIdForResult);
        el.innerHTML = buildDodgeResultHTML({
          myWinner: result.winner,
          summary: isSpec ? { ...dodge, myPeerId: myPeerIdForResult } : dodge,
          isHost: false,
          isSpectator: isSpec,
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
      } else if (algagi) {
        const isSpec = !algagi.players.some((p) => p.peerId === myPeerIdForResult);
        el.innerHTML = buildAlgagiResultHTML({
          myWinner: result.winner,
          summary: isSpec ? { ...algagi, myPeerId: myPeerIdForResult } : algagi,
          isHost: false,
          isSpectator: isSpec,
        });
      } else if (wordChain) {
        const isSpec = !wordChain.players.some((p) => p.peerId === myPeerIdForResult);
        el.innerHTML = buildWordChainResultHTML({
          myWinner: result.winner,
          summary: isSpec ? { ...wordChain, myPeerId: myPeerIdForResult } : wordChain,
          isHost: false,
          isSpectator: isSpec,
        });
      } else if (drawQuiz) {
        const isSpec = !drawQuiz.rankings.some((r) => r.peerId === myPeerIdForResult);
        el.innerHTML = buildDrawQuizResultHTML({
          myWinner: result.winner,
          summary: isSpec ? { ...drawQuiz, myPeerId: myPeerIdForResult } : drawQuiz,
          isHost: false,
          isSpectator: isSpec,
        });
      } else if (fortress) {
        const isSpec = !fortress.rankings.some((r) => r.peerId === myPeerIdForResult);
        el.innerHTML = buildFortressResultHTML({
          myWinner: result.winner,
          summary: isSpec ? { ...fortress, myPeerId: myPeerIdForResult } : fortress,
          isHost: false,
          isSpectator: isSpec,
        });
      } else if (liar) {
        const isSpec = !liar.rankings.some((r) => r.peerId === myPeerIdForResult);
        el.innerHTML = buildLiarResultHTML({
          myWinner: result.winner,
          rank: liar.rank,
          totalPlayers: liar.totalPlayers,
          rankings: liar.rankings,
          myPeerId: isSpec ? myPeerIdForResult : liar.myPeerId,
          isHost: false,
          isSpectator: isSpec,
        });
      } else if (ramen) {
        const isSpec = !ramen.rankings.some((r) => r.peerId === myPeerIdForResult);
        el.innerHTML = buildRamenResultHTML({
          myWinner: result.winner,
          rank: ramen.rank,
          totalPlayers: ramen.totalPlayers,
          myScore: ramen.myScore,
          rankings: ramen.rankings,
          myPeerId: isSpec ? myPeerIdForResult : ramen.myPeerId,
          isHost: false,
          isSpectator: isSpec,
        });
      } else if (bomb) {
        const isSpec = !bomb.players.some((p) => p.peerId === myPeerIdForResult);
        el.innerHTML = buildBombResultHTML({
          summary: isSpec ? { ...bomb, myPeerId: myPeerIdForResult } : bomb,
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
        const mySelf = currentRoomState.players.find((p) => p.peerId === myPeerIdForResult);
        const isSpec = mySelf?.role === 'spectator';
        el.innerHTML = buildGomokuResultHTML({
          myWinner: result.winner,
          summary: gomoku,
          isHost: false,
          isSpectator: isSpec,
        });
      } else if (isStoryDrawSummary(result.summary)) {
        el.innerHTML = buildStoryDrawResultHTML(false);
      } else {
        const hostScore = Number(result.summary['hostScore']) || 0;
        const guestScore = Number(result.summary['guestScore']) || 0;
        el.innerHTML = buildResultHTML({
          hostNickname: currentRoomState.hostNickname,
          guestNickname: currentRoomState.guestNickname ?? '나',
          hostScore,
          guestScore,
          myWinner: result.winner,
          isHost: false,
        });
      }

      // 채팅 패널 — 결과 카드 옆 우측 고정
      el.insertAdjacentHTML('beforeend', buildChatPanelHTML());

      const menuBtn = el.querySelector<HTMLButtonElement>('#menu-btn')!;
      const waitingMsgEl = el.querySelector<HTMLDivElement>('#waiting-msg');

      // 채팅 패널 와이어링 — 게스트는 호스트에게 송신
      const myNick = storage.getNickname();
      cleanupChat = wireChatPanel(el, {
        onSend: (text) => {
          const msg: ChatMsg = {
            type: 'chat',
            peerId: guest.myPeerId,
            nickname: myNick,
            text,
            timestamp: Date.now(),
          };
          appendChatMessage(el, msg, true);
          guest.send(msg);
        },
      });

      // 방장이 다른 게임 선택하면 room_state 먼저 옴 → 내부 state 갱신 + UI 안내 갱신.
      // 그 직후 game_start 받으면 갱신된 state 로 gameScreen 진입.
      guest.onMessage = (msg) => {
        if (msg.type === 'chat') {
          appendChatMessage(el, msg, false);
          return;
        }
        if (msg.type === 'room_state') {
          currentRoomState = msg.roomState;
          if (waitingMsgEl) {
            const newGame = getGameById(currentRoomState.gameId);
            if (newGame) {
              waitingMsgEl.textContent = `🎲 방장이 "${newGame.meta.name}" 게임을 골랐어요`;
            }
          }
          return;
        }
        if (msg.type === 'game_start') {
          closeOnDispose = false;
          const rs: RoomState = { ...currentRoomState, status: 'playing' };
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
      cleanupChat?.();
      cleanupChat = null;
      if (closeOnDispose) guest.close();
    },
  };
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
  } else if (id === 'ramen-shop') {
    const ms = Number(summary['myScore']);
    if (Number.isFinite(ms)) bestEntries.push({ key: 'bestEarnings', value: ms, higherIsBetter: true });
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
  } else if (id === 'algagi') {
    // 알까기: 이긴 판의 최단 턴 수 (적은 턴에 정리할수록 잘 친 거)
    if (winner === 'me') {
      const tc = Number(summary['turnCount']);
      if (Number.isFinite(tc) && tc > 0) {
        bestEntries.push({ key: 'bestWinTurns', value: tc, higherIsBetter: false });
      }
    }
  } else if (id === 'word-chain') {
    // 끝말잇기: 게임에서 진행된 단어 수 (길수록 잘 굴린 판)
    const total = Number(summary['totalRounds']);
    if (Number.isFinite(total) && total > 0) {
      bestEntries.push({ key: 'longestChain', value: total, higherIsBetter: true });
    }
  } else if (id === 'draw-quiz') {
    // 그림 퀴즈: 내 최종 점수 (높을수록 좋음)
    const rankings = summary['rankings'] as Array<{ peerId: string; score: number }> | undefined;
    const myPeerId = summary['myPeerId'] as string | undefined;
    const mine = rankings?.find((r) => r.peerId === myPeerId);
    if (mine && Number.isFinite(mine.score)) {
      bestEntries.push({ key: 'bestScore', value: mine.score, higherIsBetter: true });
    }
  } else if (id === 'dodge') {
    // 똥 피하기: 내 최고 생존시간(초, 높을수록 좋음)
    const rankings = summary['rankings'] as Array<{ peerId: string; survivalMs: number }> | undefined;
    const myPeerId = summary['myPeerId'] as string | undefined;
    const mine = rankings?.find((r) => r.peerId === myPeerId);
    if (mine && Number.isFinite(mine.survivalMs) && mine.survivalMs > 0) {
      bestEntries.push({ key: 'bestSurvivalSec', value: Math.round(mine.survivalMs / 100) / 10, higherIsBetter: true });
    }
  }
  // 에어하키/오목은 승/패만 기록

  storage.recordGameResult(gameId, winner, bestEntries);
}
