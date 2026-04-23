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

function buildResultHTML(args: {
  hostNickname: string;
  guestNickname: string;
  hostScore: number;
  guestScore: number;
  myWinner: 'me' | 'opponent' | null;
  isHost: boolean;
}): string {
  const { hostNickname, guestNickname, hostScore, guestScore, myWinner, isHost } = args;

  let emoji: string;
  let title: string;
  let titleClass: string;
  if (myWinner === 'me') {
    emoji = '🏆';
    title = '승리!';
    titleClass = 'result-title-win';
  } else if (myWinner === 'opponent') {
    emoji = '💫';
    title = '패배...';
    titleClass = 'result-title-lose';
  } else {
    emoji = '⚖️';
    title = '무승부';
    titleClass = 'result-title-draw';
  }

  const hostWon = hostScore > guestScore;
  const guestWon = guestScore > hostScore;

  const actionsHTML = isHost
    ? `
        <button class="btn btn-primary btn-lg btn-block" id="retry-btn">🔄 다시하기</button>
        <button class="btn btn-ghost btn-block" id="menu-btn">메뉴로</button>
      `
    : `
        <div class="result-waiting-msg" id="waiting-msg">⏳ 방장이 다음을 고르고 있어요</div>
        <button class="btn btn-ghost btn-block" id="menu-btn">메뉴로 (방 나가기)</button>
      `;

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
// 호스트 결과 화면
// ============================================

export interface ResultScreenAsHostArgs {
  host: HostSession;
  roomState: RoomState;
  result: GameResult;
}

export function createResultScreenAsHostScreen(args: ResultScreenAsHostArgs): Screen {
  const { host, roomState, result } = args;
  let closeOnDispose = true;

  return {
    render() {
      const hostScore = Number(result.summary['hostScore']) || 0;
      const guestScore = Number(result.summary['guestScore']) || 0;

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = buildResultHTML({
        hostNickname: roomState.hostNickname,
        guestNickname: roomState.guestNickname ?? '상대',
        hostScore,
        guestScore,
        myWinner: result.winner,
        isHost: true,
      });

      const retryBtn = el.querySelector<HTMLButtonElement>('#retry-btn')!;
      const menuBtn = el.querySelector<HTMLButtonElement>('#menu-btn')!;

      retryBtn.addEventListener('click', () => {
        // 같은 방 설정으로 재시작 — 게스트에게 game_start 알림
        host.send({ type: 'game_start' });
        closeOnDispose = false;
        const rs: RoomState = { ...roomState, status: 'playing' };
        router.replace(() => createGameScreenAsHostScreen({ host, roomState: rs }));
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
      const hostScore = Number(result.summary['hostScore']) || 0;
      const guestScore = Number(result.summary['guestScore']) || 0;

      const el = document.createElement('div');
      el.className = 'screen';
      el.innerHTML = buildResultHTML({
        hostNickname: roomState.hostNickname,
        guestNickname: roomState.guestNickname ?? '나',
        hostScore,
        guestScore,
        myWinner: result.winner,
        isHost: false,
      });

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
