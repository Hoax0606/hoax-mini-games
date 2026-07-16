import type { Screen } from '../core/screen';
import { router } from '../core/screen';
import type { HostSession, GuestSession, JoinRequest, JoinDecision } from '../core/peer';
import { getGameById } from '../games/registry';
import { updatePublicRoom, unpublishRoom } from '../core/roomDirectory';
import type { GameContext, GameModule, Player, RoomState } from '../games/types';
import { createMenuScreen } from './menu';
import { createResultScreenAsHostScreen, createResultScreenAsGuestScreen } from './resultScreen';
import { buildReactionBarHTML, wireReactionBar, showReactionBubble } from '../ui/reactions';
import { buildChatPanelHTML, wireChatPanel, appendChatMessage } from '../ui/chat';
import type { ChatMsg } from '../games/types';
import { storage } from '../core/storage';
import { sound } from '../core/sound';
import { escapeHtml } from '../ui/escape';
import { showReconnectOverlay, hideReconnectOverlay } from '../ui/reconnectOverlay';

/**
 * 게임 실행 화면 (호스트용 / 게스트용 factory 2종)
 *
 * 역할:
 *   1. canvas 마운트 + 헤더 DOM (점수/닉네임/옵션 요약)
 *   2. 레지스트리에서 GameModule lazy 로드 후 start(ctx) 호출
 *   3. Peer 세션 메시지를 'game_msg' 필터링해서 GameModule.onPeerMessage로 전달
 *   4. GameContext.onStatusUpdate → 헤더 점수 DOM 반영
 *   5. ctx.endGame(result) → resultScreen 으로 전환 (호스트는 game_end broadcast 도 함)
 *   6. 나가기 / 상대 이탈 시 방 정리
 *
 * 소유권:
 *   host/guest 세션은 대기실에서 이 화면으로 "인계"받음 (대기실은 closeOnDispose=false).
 *   결과 화면으로 전환할 때만 closeOnDispose=false 로 다시 넘기고, 그 외 dispose 에선 close.
 */

// ============================================
// 공통 유틸
// ============================================

function buildOptionSummary(gameId: string, roomOptions: Record<string, string>): string {
  const game = getGameById(gameId);
  if (!game) return '';
  return game.meta.roomOptions
    .map((opt) => {
      const val = roomOptions[opt.key] ?? opt.defaultValue;
      const choice = opt.choices.find((c) => c.value === val);
      return `${opt.label}: ${choice?.label ?? val}`;
    })
    .join(' · ');
}

/**
 * 게임 시작 전 카운트다운 오버레이 (3, 2, 1, 시작!).
 * 화면 전체를 흐리게 가린 채 큰 숫자를 1초씩 보여주고 promise resolve.
 * 호스트/게스트가 거의 동시에 진입하므로 양쪽이 거의 같은 타이밍에 게임 시작.
 * 1인 플레이/관전자는 호출하지 않는다.
 */
function playStartCountdown(parent: HTMLElement, seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'game-countdown-overlay';
    overlay.innerHTML = `<div class="game-countdown-number animate">${seconds}</div>`;
    parent.appendChild(overlay);
    const numEl = overlay.querySelector<HTMLDivElement>('.game-countdown-number');
    if (!numEl) {
      overlay.remove();
      resolve();
      return;
    }

    let n = seconds;
    const tick = (): void => {
      n -= 1;
      if (n > 0) {
        numEl.textContent = String(n);
        // 매 카운트마다 pop 애니메이션 재시작 (CSS animation 재실행 트릭)
        numEl.classList.remove('animate');
        void numEl.offsetWidth;
        numEl.classList.add('animate');
        setTimeout(tick, 1000);
      } else {
        numEl.textContent = '시작!';
        numEl.classList.remove('animate');
        void numEl.offsetWidth;
        numEl.classList.add('animate', 'is-go');
        setTimeout(() => {
          overlay.remove();
          resolve();
        }, 500);
      }
    };
    setTimeout(tick, 1000);
  });
}

function buildHeaderHTML(args: {
  hostNickname: string;
  guestNickname: string;
  optionSummary: string;
  /** 관전자 뷰면 점수판 대신 "관전 중" 배지 표시 */
  spectator?: boolean;
}): string {
  // 점수판은 기본 숨김 — 실제로 점수를 쓰는 게임(에어하키 등)이 onStatusUpdate 로
  //   hostScore/guestScore 를 보낼 때만 표시. 알까기·끝말·그림처럼 자체 UI 로
  //   점수/상태를 그리는 게임엔 "0:0" 이 뜨지 않게.
  const centerHTML = args.spectator
    ? `<div class="game-score game-score-spectator">👀 관전 중</div>`
    : `
      <div class="game-score" id="game-score" style="display:none">
        <span class="game-score-home" id="score-home">0</span>
        <span class="game-score-sep">:</span>
        <span class="game-score-away" id="score-away">0</span>
      </div>
    `;

  return `
    <div class="game-header">
      <button class="back-btn-inline" id="leave-btn" title="나가기">×</button>

      <div class="game-header-player game-header-player-host">
        <span class="participant-badge">🐱 방장</span>
        <span class="game-player-name">${escapeHtml(args.hostNickname)}</span>
      </div>

      ${centerHTML}

      <div class="game-header-player game-header-player-guest">
        <span class="game-player-name">${escapeHtml(args.guestNickname)}</span>
        <span class="participant-badge participant-badge-lavender">🐻 손님</span>
      </div>

      <div class="game-room-info">
        <span class="game-room-info-text">${escapeHtml(args.optionSummary)}</span>
        <span class="ping-badge ping-pending" id="ping-badge">⏳ 측정 중</span>
        <button class="game-menu-btn" id="game-menu-btn" title="게임 설정 (Esc)">⚙️</button>
      </div>
    </div>

    <div class="game-canvas-wrap">
      <canvas id="game-canvas" class="game-canvas"></canvas>
    </div>

    <div class="reaction-bar-floating">${buildReactionBarHTML()}</div>

    ${buildChatPanelHTML()}

    ${buildGameMenuModalHTML()}

    <div class="game-pause-overlay" id="game-pause-overlay" hidden>
      <div class="game-pause-card">
        <div class="game-pause-icon">⏸️</div>
        <div class="game-pause-title" id="pause-title">일시정지</div>
        <div class="game-pause-sub">다시 시작될 때까지 기다려 주세요</div>
      </div>
    </div>
  `;
}

/** 다른 플레이어가 일시정지했을 때 dim 오버레이 표시 */
function showPauseOverlay(el: HTMLElement, byNickname: string): void {
  const overlay = el.querySelector<HTMLDivElement>('#game-pause-overlay');
  const title = el.querySelector<HTMLDivElement>('#pause-title');
  if (!overlay || !title) return;
  title.textContent = `⏸️ ${byNickname} 님이 잠시 멈췄어요`;
  overlay.hidden = false;
}

function hidePauseOverlay(el: HTMLElement): void {
  const overlay = el.querySelector<HTMLDivElement>('#game-pause-overlay');
  if (overlay) overlay.hidden = true;
}

/**
 * 인게임 설정 모달 HTML.
 * 게임 화면 안에서 BGM/SFX/볼륨 빠르게 조정 + 메뉴로 나가기.
 * 멀티플레이라 게임 자체는 정지하지 않고 모달만 떠있음.
 */
function buildGameMenuModalHTML(): string {
  return `
    <div class="game-menu-overlay" id="game-menu-overlay" hidden>
      <div class="game-menu-card">
        <div class="game-menu-title">⚙️ 게임 설정</div>

        <div class="slider-row">
          <span class="slider-label">🔊 마스터 볼륨</span>
          <input type="range" class="slider" id="gm-vol" min="0" max="100" value="70" />
          <span class="slider-value" id="gm-vol-val">70</span>
        </div>

        <div class="toggle-row">
          <span class="toggle-label">🎵 배경음악 (BGM)</span>
          <div class="toggle" id="gm-bgm-toggle"></div>
        </div>

        <div class="toggle-row">
          <span class="toggle-label">🔔 효과음 (SFX)</span>
          <div class="toggle" id="gm-sfx-toggle"></div>
        </div>

        <button class="btn btn-primary btn-block" id="gm-close" style="margin-top: 16px;">
          계속하기
        </button>
        <button class="btn btn-ghost btn-block" id="gm-leave">
          메뉴로 (방 나가기)
        </button>
      </div>
    </div>
  `;
}

/**
 * 인게임 메뉴 모달 와이어링.
 * - ⚙️ 버튼 클릭 / Esc 키 → 토글
 * - 오버레이 빈 영역 / "계속하기" → 닫기
 * - "메뉴로" → callbacks.onLeaveRequest
 * - 모달 열림/닫힘 시 callbacks.onOpen / onClose (pause broadcast 용)
 * - 슬라이더/토글 변경 → storage 저장 + sound.refreshBgmSettings()
 *
 * 반환값: window 키 리스너 해제 cleanup 함수. dispose 에서 호출.
 */
interface GameMenuCallbacks {
  onLeaveRequest: () => void;
  onOpen?: () => void;
  onClose?: () => void;
}
function wireGameMenuModal(el: HTMLElement, callbacks: GameMenuCallbacks): () => void {
  const overlay = el.querySelector<HTMLDivElement>('#game-menu-overlay')!;
  const menuBtn = el.querySelector<HTMLButtonElement>('#game-menu-btn')!;
  const closeBtn = overlay.querySelector<HTMLButtonElement>('#gm-close')!;
  const leaveBtn = overlay.querySelector<HTMLButtonElement>('#gm-leave')!;
  const volInput = overlay.querySelector<HTMLInputElement>('#gm-vol')!;
  const volVal = overlay.querySelector<HTMLSpanElement>('#gm-vol-val')!;
  const bgmToggle = overlay.querySelector<HTMLDivElement>('#gm-bgm-toggle')!;
  const sfxToggle = overlay.querySelector<HTMLDivElement>('#gm-sfx-toggle')!;

  const syncFromStorage = (): void => {
    const s = storage.getSettings();
    volInput.value = String(s.masterVolume);
    volVal.textContent = String(s.masterVolume);
    bgmToggle.classList.toggle('on', s.bgmEnabled);
    sfxToggle.classList.toggle('on', s.sfxEnabled);
  };

  const open = (): void => {
    if (!overlay.hidden) return;
    syncFromStorage();
    overlay.hidden = false;
    callbacks.onOpen?.();
  };
  const close = (): void => {
    if (overlay.hidden) return;
    overlay.hidden = true;
    callbacks.onClose?.();
  };

  menuBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  leaveBtn.addEventListener('click', () => { close(); callbacks.onLeaveRequest(); });

  // 오버레이 빈 영역 클릭 시 닫기 (카드 내부 클릭은 stopPropagation 안 해도 e.target 으로 거름)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  volInput.addEventListener('input', () => {
    const v = Number(volInput.value);
    volVal.textContent = String(v);
    storage.setSettings({ masterVolume: v });
    sound.refreshBgmSettings();
  });

  bgmToggle.addEventListener('click', () => {
    const on = bgmToggle.classList.toggle('on');
    storage.setSettings({ bgmEnabled: on });
    sound.refreshBgmSettings();
  });

  sfxToggle.addEventListener('click', () => {
    const on = sfxToggle.classList.toggle('on');
    storage.setSettings({ sfxEnabled: on });
    if (on) sound.play('pop');
  });

  // 보스키(Esc)는 gameScreen render 에서 직접 mount 한다(네트워크 동기화 콜백 필요) → 여기선 안 다룸.
  //   설정 모달은 ⚙️ 버튼으로만 연다.
  return (): void => {};
}

/**
 * 보스키 — Esc 를 누르면 윈도우 업데이트 화면(가짜)을 전체화면으로 띄우고 게임을 정지한다.
 * 다시 Esc(또는 클릭)로 닫으면서 재개. 진행률은 30% 고정(끝나지 않는 업데이트처럼 보임).
 * @param onShow 보스키 뜰 때(게임 정지) / @param onHide 닫을 때(재개)
 * @returns cleanup
 */
interface BossKeyHandle {
  cleanup: () => void;
  /** 다른 사람이 보스키를 켜서 원격으로 오버레이만 표시(콜백 재브로드캐스트 없이) */
  showRemote: () => void;
  hideRemote: () => void;
}
function mountBossKey(onShow?: () => void, onHide?: () => void): BossKeyHandle {
  const el = document.createElement('div');
  el.className = 'boss-update';
  el.innerHTML = `
    <div class="boss-inner">
      <div class="boss-spinner">${'<span></span>'.repeat(8)}</div>
      <div class="boss-title">업데이트를 구성하는 중 30% 완료</div>
      <div class="boss-sub">컴퓨터를 끄지 마세요.</div>
    </div>
  `;
  document.body.appendChild(el);

  let on = false;
  const setOverlay = (v: boolean): void => {
    on = v;
    el.classList.toggle('is-on', v);
  };
  // 내가 직접 켬/끔 — 콜백을 태워 전원에게 broadcast(동기화)
  const show = (): void => { if (!on) { setOverlay(true); onShow?.(); } };
  const hide = (): void => { if (on) { setOverlay(false); onHide?.(); } };

  const isEscape = (e: KeyboardEvent): boolean =>
    e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27;
  const onKey = (e: KeyboardEvent): void => {
    if (!isEscape(e)) return;
    // 길게 눌러 연타(repeat) 로 show→hide→show 가 짝수번 토글돼 "안 뜬 것처럼" 되던 문제 방지 —
    //   최초 keydown 1회만 처리.
    if (e.repeat) return;
    e.preventDefault();
    on ? hide() : show();
  };
  el.addEventListener('mousedown', (e) => { e.preventDefault(); hide(); }); // 클릭으로도 복귀
  // 캡처 단계로 등록 — 게임/입력창 어떤 핸들러보다 먼저 Esc 를 가로채 확실히 뜨게 한다.
  window.addEventListener('keydown', onKey, true);

  return {
    cleanup: (): void => {
      window.removeEventListener('keydown', onKey, true);
      el.remove();
    },
    // 원격 동기화: 오버레이만 토글(재브로드캐스트 방지 위해 콜백 안 태움)
    showRemote: (): void => setOverlay(true),
    hideRemote: (): void => setOverlay(false),
  };
}

/** 점수 DOM에 번쩍임 애니메이션 재시작 */
function flashScore(el: HTMLElement): void {
  el.classList.remove('score-flash');
  // 강제 reflow — 동일 클래스 다시 추가해도 애니메이션이 새로 시작되도록
  void el.offsetWidth;
  el.classList.add('score-flash');
}

/** ping(ms)를 배지 엘리먼트에 반영. null = 끊김/측정불가 */
function updatePingBadge(el: HTMLElement, ms: number | null): void {
  if (ms === null) {
    el.textContent = '⚠️ 끊김';
    el.className = 'ping-badge ping-dead';
    return;
  }
  let cls: string;
  let icon: string;
  if (ms < 60)       { cls = 'ping-good'; icon = '🟢'; }
  else if (ms < 150) { cls = 'ping-ok';   icon = '🟡'; }
  else               { cls = 'ping-slow'; icon = '🔴'; }
  el.textContent = `${icon} ${ms}ms`;
  el.className = `ping-badge ${cls}`;
}

// ============================================
// 호스트 게임 화면
// ============================================

export interface GameScreenAsHostArgs {
  host: HostSession;
  roomState: RoomState;
  /** 비공개방 여부 — 게임 중 관전자 입장 요청 시 비번 검증에 사용 */
  isPrivate: boolean;
  /** 방장이 방 만들 때 지정한 비번 (공개방이면 빈 문자열) — 관전자 입장 비번 검증용 */
  password: string;
}

export function createGameScreenAsHostScreen(args: GameScreenAsHostArgs): Screen {
  const { host, roomState, isPrivate, password } = args;
  let gameModule: GameModule | null = null;
  let disposed = false;
  // 결과 화면으로 이동할 땐 세션 소유권 넘기므로 close 하지 않음
  let closeOnDispose = true;
  /** 모듈 start() 완료 여부 + 그 전에 도착한 game_msg 버퍼.
   *  (게스트 hello 가 호스트 모듈 로드/시작 전에 도착하면 조용히 버려져 게스트가 멈추던 문제 방지) */
  let gameStarted = false;
  const pendingPayloads: Parameters<GameModule['onPeerMessage']>[0][] = [];
  /** 인게임 메뉴 모달 cleanup (window keydown 리스너 해제) */
  let cleanupMenu: (() => void) | null = null;
  /** 채팅 패널 cleanup */
  let cleanupChat: (() => void) | null = null;
  /** 현재 일시정지를 건 사람들의 peerId 집합. 전원이 해제해야(비어야) 게임 재개 —
   *  여러 명이 동시에 메뉴를 열어도 한 명이 닫으면 게임이 재개되던 desync 방지. */
  const pausedBy = new Set<string>();
  /** 보스키(가짜 윈도우 업데이트) 켜짐 여부 — 전원 공유 래치. 누가 켜든 켜지고, 누가 끄든 전원 해제. */
  let bossOn = false;
  /** 보스키 오버레이 핸들 (render 에서 mount) */
  let bossHandle: BossKeyHandle | null = null;
  /** 게임 실제 정지 상태 = 보스키 || 메뉴정지(pausedBy) 중 하나라도 활성. 한 곳에서만 setPaused 호출. */
  const recomputePause = (): void => { gameModule?.setPaused?.(bossOn || pausedBy.size > 0); };

  // 게임 시작 시점에 들어와 있던 플레이어들 (관전자와 구분).
  // 게임 도중에 들어오는 사람은 전부 spectators 로. role='spectator' 마킹.
  const activePlayers: Player[] = [...roomState.players];
  const spectators: Player[] = [];

  /** 현재 방 상태 스냅샷 — 관전자에게 join_accepted 보낼 때 + player_joined broadcast 시 사용 */
  const snapshotRoomState = (): RoomState => ({
    ...roomState,
    players: [...activePlayers, ...spectators],
    status: 'playing',
  });

  /** 정원 = 활성 플레이어 + 관전(대기)자. 이 수가 maxPlayers 넘으면 입장 거부. */
  const roomMaxPlayers = getGameById(roomState.gameId)?.meta.maxPlayers ?? 2;
  const currentOccupancy = (): number => activePlayers.length + spectators.length;
  /** 공개/비공개방 인원수(대기 포함)+상태 갱신 — 게임 시작 시 + 관전자 들어오고 나갈 때.
   *  항목 자체는 대기실에서 publish 됐고 여기선 부분 갱신만(status='playing'). */
  const publishCount = (): void => {
    updatePublicRoom(roomState.roomId, { playerCount: currentOccupancy(), status: 'playing' });
  };

  return {
    render() {
      const game = getGameById(roomState.gameId);
      if (!game) {
        queueMicrotask(() => router.reset(() => createMenuScreen()));
        return document.createElement('div');
      }

      // 게임 시작 → 공개방 목록에서 '게임 중'으로 표시되도록 상태 갱신(항목은 대기실에서 이미 publish됨).
      publishCount();

      const hostNickname = roomState.hostNickname;
      const guestNickname = roomState.guestNickname ?? '상대';
      const optionSummary = buildOptionSummary(roomState.gameId, roomState.roomOptions);

      const el = document.createElement('div');
      el.className = 'game-screen';
      el.innerHTML = buildHeaderHTML({ hostNickname, guestNickname, optionSummary });

      const canvas = el.querySelector<HTMLCanvasElement>('#game-canvas')!;
      const scoreHome = el.querySelector<HTMLSpanElement>('#score-home')!;
      const scoreAway = el.querySelector<HTMLSpanElement>('#score-away')!;
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;

      // 점수 변화 감지용 이전 값 (호스트 시점 로컬 state)
      let lastHostScore = 0;
      let lastGuestScore = 0;

      const myPlayerId = host.myPeerId;
      const players = roomState.players;

      // GameContext — 호스트 시점
      const ctx: GameContext = {
        canvas,
        role: 'host',
        myPlayerId,
        isSpectator: false,
        players,
        myNickname: hostNickname,
        opponentNickname: guestNickname,
        roomOptions: roomState.roomOptions,
        sendToPeer: (msg, options) => {
          // target 있으면 특정 게스트에게만, 없으면 모든 게스트에게 broadcast
          if (options?.target) {
            if (options.target !== myPlayerId) {
              host.sendTo(options.target, {
                type: 'game_msg',
                payload: msg,
                target: options.target,
                from: myPlayerId,
              });
            }
          } else {
            host.send({ type: 'game_msg', payload: msg, from: myPlayerId });
          }
        },
        endGame: (result) => {
          // 플랫폼 레벨 game_end broadcast — 관전자도 받아서 결과 화면으로 이동.
          // 기존 플레이어들은 각 게임의 내부 메시지(bt:end / ah:end)로 이미 이동 경로가 있으므로
          // game_end 를 추가로 받아도 게스트 쪽에서 isSpectator 체크 후 무시한다.
          host.send({ type: 'game_end', result });

          // GOAL! 이펙트를 잠깐 여운으로 보여준 뒤 결과 화면 전환
          // (loop는 계속 돌고 파티클이 자연스럽게 fade-out 하므로 정지 느낌 없음)
          window.setTimeout(() => {
            if (disposed) return;
            closeOnDispose = false; // host 소유권을 결과 화면에 넘김
            // 게임 중 합류한 관전자까지 포함한 방 상태를 넘김 → 결과화면에서 다음 판 시작 시
            //   관전자를 플레이어로 승격(대기→참여)할 수 있게.
            router.replace(() =>
              createResultScreenAsHostScreen({ host, roomState: snapshotRoomState(), result, isPrivate, password })
            );
          }, 900);
        },
        onStatusUpdate: (status) => {
          if (!('hostScore' in status) && !('guestScore' in status)) return;
          // 점수를 쓰는 게임 — 숨겨둔 점수판 표시
          const scoreBox = el.querySelector<HTMLDivElement>('#game-score');
          if (scoreBox) scoreBox.style.display = '';
          const h = Number(status['hostScore']) || 0;
          const g = Number(status['guestScore']) || 0;
          if (scoreHome.textContent !== String(h)) {
            scoreHome.textContent = String(h);
            if (h > lastHostScore) flashScore(scoreHome);
          }
          if (scoreAway.textContent !== String(g)) {
            scoreAway.textContent = String(g);
            if (g > lastGuestScore) flashScore(scoreAway);
          }
          lastHostScore = h;
          lastGuestScore = g;
        },
      };

      // HostSession 메시지 라우팅 — reaction/pause/resume 처리 + game_msg relay/소비
      host.onMessage = (msg, fromPeerId) => {
        // 이모지 반응: 내 화면에 표시 + 다른 게스트들에게 forward
        if (msg.type === 'reaction') {
          showReactionBubble(msg.emoji, msg.nickname);
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) host.sendTo(pid, msg);
          }
          return;
        }
        // 보스키(전원 공유 래치): 누가 켜든 전원 업데이트 화면 + 정지, 누가 끄든 전원 해제.
        //   pausedBy 회계와 별개(bossOn) — 원격 dismiss 도 전원 해제되게.
        if (msg.type === 'pause' && msg.boss) {
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) host.sendTo(pid, msg);
          }
          bossOn = true;
          bossHandle?.showRemote();
          recomputePause();
          return;
        }
        if (msg.type === 'resume' && msg.boss) {
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) host.sendTo(pid, msg);
          }
          bossOn = false;
          bossHandle?.hideRemote();
          recomputePause();
          return;
        }
        // 일시정지/재개(⚙️ 메뉴): 다른 게스트에 forward + 호스트 자기 dim 처리 + 게임 모듈에 알림
        if (msg.type === 'pause') {
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) host.sendTo(pid, msg);
          }
          pausedBy.add(fromPeerId);
          showPauseOverlay(el, msg.byNickname);
          recomputePause();
          return;
        }
        if (msg.type === 'resume') {
          pausedBy.delete(fromPeerId);
          // 아직 메뉴 연 사람이 남아있으면 계속 정지 — 전원 해제 시에만 재개 broadcast.
          if (pausedBy.size > 0) return;
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) host.sendTo(pid, msg);
          }
          hidePauseOverlay(el);
          recomputePause();
          return;
        }
        // 채팅: 내 화면 append + 다른 게스트에게 relay
        if (msg.type === 'chat') {
          appendChatMessage(el, msg, false);
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) host.sendTo(pid, msg);
          }
          return;
        }
        if (msg.type !== 'game_msg') return;
        // target이 다른 게스트를 향하면 그 쪽으로만 forward
        if (msg.target && msg.target !== myPlayerId) {
          host.sendTo(msg.target, { ...msg, from: fromPeerId });
          return;
        }
        // target이 없거나 나(호스트)를 향한 경우 → 로컬 소비 (start 전이면 버퍼링 후 flush)
        if (gameStarted && gameModule) gameModule.onPeerMessage(msg.payload);
        else pendingPayloads.push(msg.payload);
        // target 없으면 다른 게스트들에게도 broadcast (송신자 제외)
        if (!msg.target) {
          for (const pid of host.listGuestPeerIds()) {
            if (pid !== fromPeerId) {
              host.sendTo(pid, { ...msg, from: fromPeerId });
            }
          }
        }
      };

      // 이모지 반응 버튼 (게임 중에도 사용 가능)
      wireReactionBar(el, (emoji) => {
        const myNick = storage.getNickname();
        showReactionBubble(emoji, myNick);
        host.send({ type: 'reaction', emoji, nickname: myNick });
      });

      // 게임 중에 새로 들어오는 연결 = 관전자 후보.
      // 비공개방이면 비번 검증. 통과하면 spectator로 수락, RoomState(status='playing') 반환.
      host.onJoinRequest = (req: JoinRequest, fromPeerId: string): JoinDecision => {
        if (isPrivate && req.password !== password) {
          return { accept: false, reason: 'wrong_password' };
        }
        // 정원(활성+관전) 초과면 거부 → 입장 측에서 "방 꽉참" 알림
        if (currentOccupancy() >= roomMaxPlayers) {
          return { accept: false, reason: 'room_full' };
        }
        const newSpec: Player = {
          peerId: fromPeerId,
          nickname: req.nickname,
          isHost: false,
          role: 'spectator',
        };
        // preview: spectators 배열에 선반영해서 돌려준다 (아직 실제 add는 onGuestConnected 에서)
        const preview: RoomState = {
          ...snapshotRoomState(),
          players: [...activePlayers, ...spectators, newSpec],
        };
        return { accept: true, roomState: preview, asSpectator: true };
      };

      // 관전자 수락 완료 → spectators 배열에 확정 추가 + 기존 연결 전원에게 알림
      host.onGuestConnected = (nickname, peerId) => {
        const newSpec: Player = {
          peerId,
          nickname,
          isHost: false,
          role: 'spectator',
        };
        spectators.push(newSpec);
        // 기존 피어들(플레이어+기존 관전자)에게 새 관전자 알림. 게스트 gameScreen에서 이 메시지는
        // 로그/토스트 용도. ctx.players 자동 업데이트는 하지 않는다(MVP 범위 밖).
        host.send({ type: 'player_joined', player: newSpec });
        publishCount(); // 공개방 인원수(대기 포함) 갱신
      };

      // 게임 중 일시 끊김 → 유예 안에 재연결. 현재 방 상태 재전송(플레이어/관전자 목록 유지).
      // 게임 상태 자체는 게임 모듈이 계속 broadcast 하므로 재연결 후 자연히 따라잡는다.
      host.onGuestReconnected = () => snapshotRoomState();

      // 연결 끊김: 플레이어 이탈이면 게임 즉시 종료, 관전자 이탈이면 조용히 제거만.
      host.onGuestDisconnected = (peerId) => {
        const specIdx = spectators.findIndex((s) => s.peerId === peerId);
        if (specIdx >= 0) {
          const [removed] = spectators.splice(specIdx, 1);
          if (removed) {
            host.send({ type: 'player_left', peerId, nickname: removed.nickname });
          }
          publishCount(); // 관전자 이탈 → 인원수 갱신
          // 나간 사람이 일시정지를 걸어둔 사람이면 resume 이 영영 안 와서 dim 이 굳는다 →
          //   집합에서 빼고, 남은 pauser 가 없을 때만 강제 재개.
          if (pausedBy.delete(peerId) && pausedBy.size === 0) {
            hidePauseOverlay(el);
            gameModule?.setPaused?.(false);
            host.send({ type: 'resume', byPeerId: peerId });
          }
          return;
        }

        // 플레이어 이탈 — 게임이 이탈 처리를 지원(onPeerLeft)하고 남은 인원이 최소인원 이상이면
        //   그 사람만 빼고 계속. 아니면(2인 게임에서 상대가 나감 등) 기존대로 게임 종료.
        const leaver = activePlayers.find((p) => p.peerId === peerId);
        const remaining = activePlayers.filter((p) => p.peerId !== peerId);
        const minP = getGameById(roomState.gameId)?.meta.minPlayers ?? 2;
        if (gameModule?.onPeerLeft && remaining.length >= minP) {
          activePlayers.splice(0, activePlayers.length, ...remaining);
          gameModule.onPeerLeft(peerId); // 호스트 authoritative 로직이 턴/상태 갱신 후 게임 프로토콜로 sync
          host.send({ type: 'player_left', peerId, nickname: leaver?.nickname ?? '' });
          publishCount();
          if (pausedBy.delete(peerId) && pausedBy.size === 0) {
            hidePauseOverlay(el);
            gameModule?.setPaused?.(false);
            host.send({ type: 'resume', byPeerId: peerId });
          }
          return;
        }

        alert('상대가 게임을 나갔어요');
        router.reset(() => createMenuScreen());
      };

      // 나가기
      leaveBtn.addEventListener('click', () => {
        if (window.confirm('게임을 나가시겠어요? 상대와의 연결이 끊어져요.')) {
          router.reset(() => createMenuScreen());
        }
      });

      // 인게임 메뉴 모달 (⚙️ / Esc) — 열림/닫힘 시 pause/resume broadcast.
      // 호스트 본인 화면은 이미 모달이 위에 떠 있어 dim 별도 표시 불필요.
      cleanupMenu = wireGameMenuModal(el, {
        onLeaveRequest: () => leaveBtn.click(),
        onOpen: () => {
          pausedBy.add(host.myPeerId);
          host.send({ type: 'pause', byPeerId: host.myPeerId, byNickname: hostNickname });
          recomputePause();
        },
        onClose: () => {
          pausedBy.delete(host.myPeerId);
          if (pausedBy.size > 0) return; // 아직 다른 사람이 멈춰둠 — 계속 정지
          host.send({ type: 'resume', byPeerId: host.myPeerId });
          recomputePause();
        },
      });

      // 보스키(Esc) — 내가 켜면 전원에게 boss 플래그 pause broadcast(동기화). 끄면 boss resume.
      bossHandle = mountBossKey(
        () => { bossOn = true; host.send({ type: 'pause', byPeerId: host.myPeerId, byNickname: hostNickname, boss: true }); recomputePause(); },
        () => { bossOn = false; host.send({ type: 'resume', byPeerId: host.myPeerId, boss: true }); recomputePause(); },
      );

      // 채팅 패널 — 호스트: 자기 화면 append + 모든 게스트 broadcast
      cleanupChat = wireChatPanel(el, {
        onSend: (text) => {
          const msg: ChatMsg = {
            type: 'chat',
            peerId: host.myPeerId,
            nickname: hostNickname,
            text,
            timestamp: Date.now(),
          };
          appendChatMessage(el, msg, true);
          host.send(msg);
        },
      });

      // Ping 배지: 여러 게스트 중 "가장 느린" 쪽을 대표로 표시 (호스트 시점 가장 나쁜 연결)
      const pingBadgeEl = el.querySelector<HTMLSpanElement>('#ping-badge')!;
      host.onPingChanged = (pings) => {
        if (pings.size === 0) {
          updatePingBadge(pingBadgeEl, null);
          return;
        }
        const worstPing = Math.max(...pings.values());
        updatePingBadge(pingBadgeEl, worstPing);
      };

      // 게임 모듈 lazy 로드 + 시작
      (async () => {
        try {
          const loaded = await game.load();
          if (disposed) {
            loaded.destroy();
            return;
          }
          gameModule = loaded;
          // 2명 이상이면 시작 전 3초 카운트다운 (호스트와 게스트가 같이 봄)
          if (roomState.players.length >= 2) {
            await playStartCountdown(el, 3);
            if (disposed) return;
          }
          await gameModule.start(ctx);
          // start 전에 도착해 버퍼된 메시지(예: 게스트 hello) 순서대로 전달
          gameStarted = true;
          for (const p of pendingPayloads) gameModule.onPeerMessage(p);
          pendingPayloads.length = 0;
        } catch (err) {
          console.error('[gameScreen/host] failed to start game', err);
          alert('게임을 시작할 수 없어요');
          router.reset(() => createMenuScreen());
        }
      })();

      return el;
    },

    dispose() {
      disposed = true;
      gameModule?.destroy();
      gameModule = null;
      host.onMessage = null;
      host.onGuestDisconnected = null;
      host.onGuestReconnected = null;
      host.onJoinRequest = null;
      host.onGuestConnected = null;
      host.onPingChanged = null;
      cleanupMenu?.();
      cleanupMenu = null;
      cleanupChat?.();
      cleanupChat = null;
      bossHandle?.cleanup();
      bossHandle = null;
      // 결과 화면으로 넘기는 경우(closeOnDispose=false)엔 항목 유지 → 결과 화면이 목록 노출 이어감.
      // 방을 완전히 닫는 경우(메뉴 복귀 등)만 디렉토리에서 제거.
      if (closeOnDispose) {
        unpublishRoom(roomState.roomId).catch(() => {});
        host.close();
      }
    },
  };
}

// ============================================
// 게스트 게임 화면
// ============================================

export interface GameScreenAsGuestArgs {
  guest: GuestSession;
  roomState: RoomState;
}

export function createGameScreenAsGuestScreen(args: GameScreenAsGuestArgs): Screen {
  const { guest, roomState } = args;
  let gameModule: GameModule | null = null;
  let disposed = false;
  let closeOnDispose = true;
  /** 모듈 start() 완료 여부 + 그 전 도착 game_msg 버퍼 (초기 sync/turn 유실로 멈춤 방지) */
  let gameStarted = false;
  const pendingPayloads: Parameters<GameModule['onPeerMessage']>[0][] = [];
  let cleanupMenu: (() => void) | null = null;
  let cleanupChat: (() => void) | null = null;
  /** 보스키(전원 공유 업데이트 화면) 켜짐 여부 + 메뉴정지 여부 — 둘 중 하나라도 켜지면 게임 정지. */
  let bossOn = false;
  let menuPaused = false;
  let bossHandle: BossKeyHandle | null = null;
  const recomputePause = (): void => { gameModule?.setPaused?.(bossOn || menuPaused); };

  // "나"의 role 판정 — roomState.players 에서 내 peerId 찾아 role='spectator' 면 관전 모드.
  // (게임 중 입장한 관전자는 roomState가 호스트에서 build 된 시점에 이미 role='spectator' 마킹되어 있음)
  const myPlayerId = guest.myPeerId;
  const mySelf = roomState.players.find((p) => p.peerId === myPlayerId);
  const isSpectator = mySelf?.role === 'spectator';

  return {
    render() {
      const game = getGameById(roomState.gameId);
      if (!game) {
        queueMicrotask(() => router.reset(() => createMenuScreen()));
        return document.createElement('div');
      }

      const hostNickname = roomState.hostNickname;
      // 내 닉네임은 roomState.players 에서 내 peerId 로 찾은 값을 써야 정확하다.
      //   (roomState.guestNickname 은 players[1] = "첫 게스트" 만 가리키는 2인 호환 필드라,
      //    3인+ 게임에서 둘째 게스트부터 채팅/표시 이름이 첫 게스트 것으로 잘못 나오던 버그.)
      const guestNickname = mySelf?.nickname ?? (isSpectator ? '관전자' : storage.getNickname());
      const optionSummary = buildOptionSummary(roomState.gameId, roomState.roomOptions);

      const el = document.createElement('div');
      el.className = 'game-screen';
      el.innerHTML = buildHeaderHTML({ hostNickname, guestNickname, optionSummary, spectator: isSpectator });

      const canvas = el.querySelector<HTMLCanvasElement>('#game-canvas')!;
      // 관전자 뷰는 점수판 대신 "관전 중" 배지라 score-home/away 엘리먼트가 없다.
      const scoreHome = el.querySelector<HTMLSpanElement>('#score-home');
      const scoreAway = el.querySelector<HTMLSpanElement>('#score-away');
      const leaveBtn = el.querySelector<HTMLButtonElement>('#leave-btn')!;

      let lastHostScore = 0;
      let lastGuestScore = 0;

      const players = roomState.players;

      // GameContext — 게스트(또는 관전자) 시점
      const ctx: GameContext = {
        canvas,
        role: 'guest',
        myPlayerId,
        isSpectator,
        players,
        myNickname: guestNickname,
        opponentNickname: hostNickname,
        roomOptions: roomState.roomOptions,
        sendToPeer: (msg, options) => {
          // 게스트는 호스트에게만 직접 전송. target 있으면 호스트가 relay
          const netMsg: { type: 'game_msg'; payload: typeof msg; from: string; target?: string } = {
            type: 'game_msg',
            payload: msg,
            from: myPlayerId,
          };
          if (options?.target) netMsg.target = options.target;
          guest.send(netMsg);
        },
        endGame: (result) => {
          window.setTimeout(() => {
            if (disposed) return;
            closeOnDispose = false;
            router.replace(() =>
              createResultScreenAsGuestScreen({ guest, roomState, result })
            );
          }, 900);
        },
        onStatusUpdate: (status) => {
          // 관전자 뷰는 점수판 DOM이 없으므로 업데이트 스킵
          if (!scoreHome || !scoreAway) return;
          if (!('hostScore' in status) && !('guestScore' in status)) return;
          const scoreBox = el.querySelector<HTMLDivElement>('#game-score');
          if (scoreBox) scoreBox.style.display = '';
          const h = Number(status['hostScore']) || 0;
          const g = Number(status['guestScore']) || 0;
          if (scoreHome.textContent !== String(h)) {
            scoreHome.textContent = String(h);
            if (h > lastHostScore) flashScore(scoreHome);
          }
          if (scoreAway.textContent !== String(g)) {
            scoreAway.textContent = String(g);
            if (g > lastGuestScore) flashScore(scoreAway);
          }
          lastHostScore = h;
          lastGuestScore = g;
        },
      };

      guest.onMessage = (msg) => {
        // 이모지 반응 — 호스트가 broadcast/relay 한 것
        if (msg.type === 'reaction') {
          showReactionBubble(msg.emoji, msg.nickname);
          return;
        }
        // 보스키(전원 공유): 누가 켜든 내 화면도 가짜 업데이트 + 정지, 누가 끄든 해제.
        if (msg.type === 'pause' && msg.boss) {
          bossOn = true;
          bossHandle?.showRemote();
          recomputePause();
          return;
        }
        if (msg.type === 'resume' && msg.boss) {
          bossOn = false;
          bossHandle?.hideRemote();
          recomputePause();
          return;
        }
        // 일시정지/재개 — 다른 사람이 ⚙️ 메뉴를 열었음. 내 화면 dim + 게임 모듈 정지.
        if (msg.type === 'pause') {
          menuPaused = true;
          showPauseOverlay(el, msg.byNickname);
          recomputePause();
          return;
        }
        if (msg.type === 'resume') {
          menuPaused = false;
          hidePauseOverlay(el);
          recomputePause();
          return;
        }
        // 채팅 — 호스트로부터 (자신이 보낸 건 echo 안 옴)
        if (msg.type === 'chat') {
          appendChatMessage(el, msg, false);
          return;
        }
        // 관전자 전용 종료 경로 — 플레이어들은 각 게임의 내부 메시지(bt:end / ah:end) 로
        // ctx.endGame 을 통해 이미 이동하므로 game_end 는 무시해도 된다.
        if (msg.type === 'game_end') {
          if (isSpectator && !disposed) {
            closeOnDispose = false;
            router.replace(() =>
              createResultScreenAsGuestScreen({ guest, roomState, result: msg.result })
            );
          }
          return;
        }
        if (msg.type !== 'game_msg') return;
        // target이 나를 향하지 않으면 무시 (호스트가 relay 단계에서 거름)
        if (msg.target && msg.target !== myPlayerId) return;
        if (gameStarted && gameModule) gameModule.onPeerMessage(msg.payload);
        else pendingPayloads.push(msg.payload); // start 전 도착분 버퍼
      };

      // 이모지 반응 버튼 (게임 중) — 게스트는 호스트에게만 송신
      wireReactionBar(el, (emoji) => {
        const myNick = storage.getNickname();
        showReactionBubble(emoji, myNick);
        guest.send({ type: 'reaction', emoji, nickname: myNick });
      });

      // 일시적 끊김 — 재연결 오버레이. peer.ts 가 유예 안에 자동 재연결 시도.
      guest.onReconnecting = () => showReconnectOverlay();
      guest.onReconnected = () => hideReconnectOverlay();

      guest.onDisconnect = () => {
        hideReconnectOverlay();
        alert(isSpectator ? '방이 닫혔어요' : '방장이 게임을 나갔어요');
        router.reset(() => createMenuScreen());
      };

      leaveBtn.addEventListener('click', () => {
        if (window.confirm('게임을 나가면 방도 같이 나가요. 나가시겠어요?')) {
          router.reset(() => createMenuScreen());
        }
      });

      // 인게임 메뉴 모달 (⚙️ / Esc) — 열림/닫힘 시 pause/resume 송신 + 게임 모듈 정지
      cleanupMenu = wireGameMenuModal(el, {
        onLeaveRequest: () => leaveBtn.click(),
        onOpen: () => {
          // 관전자는 전체 일시정지를 걸 수 없음 — 관전자가 메뉴 열었다고 플레이어들 게임이
          //   멈추면 안 됨(그리핑 방지). 관전자 메뉴는 나가기 용도로만.
          if (isSpectator) return;
          menuPaused = true;
          guest.send({ type: 'pause', byPeerId: guest.myPeerId, byNickname: guestNickname });
          recomputePause();
        },
        onClose: () => {
          if (isSpectator) return;
          menuPaused = false;
          guest.send({ type: 'resume', byPeerId: guest.myPeerId });
          recomputePause();
        },
      });

      // 보스키(Esc) — 내가 켜면 전원에게 boss pause broadcast(호스트가 relay). 관전자는 로컬만(그리핑 방지).
      bossHandle = mountBossKey(
        () => {
          if (isSpectator) return; // 관전자는 자기 화면만 가려짐(위 show()가 이미 오버레이 띄움), broadcast 안 함
          bossOn = true;
          guest.send({ type: 'pause', byPeerId: guest.myPeerId, byNickname: guestNickname, boss: true });
          recomputePause();
        },
        () => {
          if (isSpectator) return;
          bossOn = false;
          guest.send({ type: 'resume', byPeerId: guest.myPeerId, boss: true });
          recomputePause();
        },
      );

      // 채팅 패널 — 게스트: 자기 화면 append + 호스트로 송신 (호스트가 다른 게스트로 relay)
      cleanupChat = wireChatPanel(el, {
        onSend: (text) => {
          const msg: ChatMsg = {
            type: 'chat',
            peerId: guest.myPeerId,
            nickname: guestNickname,
            text,
            timestamp: Date.now(),
          };
          appendChatMessage(el, msg, true);
          guest.send(msg);
        },
      });

      // Ping 배지 — 호스트가 보고해주는 내 편도 지연 표시
      const pingBadgeEl = el.querySelector<HTMLSpanElement>('#ping-badge')!;
      guest.onPingChanged = (ms) => updatePingBadge(pingBadgeEl, ms);

      (async () => {
        try {
          const loaded = await game.load();
          if (disposed) {
            loaded.destroy();
            return;
          }
          gameModule = loaded;
          // 2명 이상 + 관전자가 아니면 시작 전 3초 카운트다운
          // (관전자는 게임 도중 합류라 카운트다운 의미 없음)
          if (roomState.players.length >= 2 && !isSpectator) {
            await playStartCountdown(el, 3);
            if (disposed) return;
          }
          await gameModule.start(ctx);
          gameStarted = true;
          for (const p of pendingPayloads) gameModule.onPeerMessage(p);
          pendingPayloads.length = 0;
        } catch (err) {
          console.error('[gameScreen/guest] failed to start game', err);
          alert('게임을 시작할 수 없어요');
          router.reset(() => createMenuScreen());
        }
      })();

      return el;
    },

    dispose() {
      disposed = true;
      hideReconnectOverlay();
      gameModule?.destroy();
      gameModule = null;
      guest.onMessage = null;
      guest.onDisconnect = null;
      guest.onReconnecting = null;
      guest.onReconnected = null;
      guest.onPingChanged = null;
      cleanupMenu?.();
      cleanupMenu = null;
      cleanupChat?.();
      cleanupChat = null;
      bossHandle?.cleanup();
      bossHandle = null;
      if (closeOnDispose) guest.close();
    },
  };
}

