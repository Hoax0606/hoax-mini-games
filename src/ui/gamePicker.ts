import { games, getGameById } from '../games/registry';
import type { GameRoomOption } from '../games/types';
import { escapeHtml, escapeAttr } from './escape';

/**
 * 게임 선택 오버레이 (공용).
 *
 * 쓰이는 곳:
 *   - 대기실: 방장이 방에서 할 게임을 고름 (confirmLabel="이 게임으로")
 *   - 결과 화면: 같은 멤버로 다른 게임을 바로 시작 (confirmLabel="시작")
 *
 * 작동:
 *   1. 게임 카드 그리드 — 현재 인원(playerCount)에 안 맞는 게임은 비활성(회색).
 *      · minPlayers~maxPlayers 범위 밖이면 못 고름 → "인원 초과/미달" 시각 처리.
 *   2. 카드 클릭 → 그 게임의 옵션 폼을 아래에 렌더.
 *   3. 확정 버튼 → onConfirm(gameId, options).
 *   4. 취소/ESC → 오버레이만 제거.
 *
 * 인원 판정은 이 한 곳에 모아둠 — 대기실/결과화면이 같은 규칙을 공유한다.
 */
export interface GamePickerOptions {
  /** 현재 방 인원 — 이 수에 맞는 게임만 선택 가능 */
  playerCount: number;
  /** 지금 선택돼 있는 게임 id (강조 표시용). 없으면 '' */
  currentGameId: string;
  title?: string;
  subtitle?: string;
  /** 확정 버튼 라벨 (기본 "선택") */
  confirmLabel?: string;
  /** currentGameId 카드에 붙일 꼬리표 (예: "방금 한 게임"). 없으면 "지금 선택됨" */
  currentSuffix?: string;
  /**
   * 최소 인원 미달도 막을지. 기본 true(결과화면=바로 시작이라 인원 다 있어야 함).
   * 대기실에선 false — 시작 전이라 인원이 아직 모자라도 게임을 미리 골라둘 수 있게(min 은 시작 버튼에서 강제).
   * 어느 쪽이든 최대 인원 초과는 항상 막는다.
   */
  enforceMin?: boolean;
  onConfirm: (gameId: string, options: Record<string, string>) => void;
}

function buildOverlayHTML(o: GamePickerOptions): string {
  const currentSuffix = o.currentSuffix ?? '지금 선택됨';
  const enforceMin = o.enforceMin ?? true;
  const cards = games.map((g) => {
    const overMax = o.playerCount > g.meta.maxPlayers;
    const underMin = enforceMin && o.playerCount < g.meta.minPlayers;
    const fits = !overMax && !underMin;
    const playerLabel = g.meta.minPlayers === g.meta.maxPlayers
      ? `${g.meta.minPlayers}인 전용`
      : `${g.meta.minPlayers}~${g.meta.maxPlayers}인`;
    const reason = fits ? playerLabel : `${playerLabel} (현재 ${o.playerCount}명)`;
    const isCurrent = g.meta.id === o.currentGameId;
    return `
      <button class="change-game-card${fits ? '' : ' is-disabled'}${isCurrent ? ' is-current' : ''}"
              data-game-id="${escapeAttr(g.meta.id)}" ${fits ? '' : 'disabled'}>
        <img class="change-game-card-thumb" src="${escapeAttr(g.meta.thumbnail)}" alt="" />
        <div class="change-game-card-name">${escapeHtml(g.meta.name)}</div>
        <div class="change-game-card-meta">${escapeHtml(reason)}${isCurrent ? ` · ${escapeHtml(currentSuffix)}` : ''}</div>
      </button>
    `;
  }).join('');

  return `
    <div class="change-game-overlay" id="change-game-overlay">
      <div class="change-game-card-wrap">
        <div class="change-game-title">${escapeHtml(o.title ?? '🎲 게임 선택')}</div>
        <div class="change-game-subtitle">${escapeHtml(o.subtitle ?? `현재 방 멤버 ${o.playerCount}명`)}</div>

        <div class="change-game-grid">${cards}</div>

        <div class="change-game-options" id="change-game-options"></div>

        <div class="change-game-actions">
          <button class="btn btn-ghost" id="change-game-cancel-btn">취소</button>
          <button class="btn btn-primary" id="change-game-start-btn" disabled>${escapeHtml(o.confirmLabel ?? '선택')}</button>
        </div>
      </div>
    </div>
  `;
}

function renderOption(opt: GameRoomOption): string {
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
 * parent 위에 게임 선택 오버레이를 띄우고 동작 연결.
 * 반환값: 정리 함수(오버레이 제거 + keydown 리스너 해제). 중복 호출 안전.
 */
export function openGamePickerOverlay(parent: HTMLElement, o: GamePickerOptions): () => void {
  if (parent.querySelector('#change-game-overlay')) return () => {};

  parent.insertAdjacentHTML('beforeend', buildOverlayHTML(o));
  const overlay = parent.querySelector<HTMLDivElement>('#change-game-overlay')!;
  const optsContainer = overlay.querySelector<HTMLDivElement>('#change-game-options')!;
  const startBtn = overlay.querySelector<HTMLButtonElement>('#change-game-start-btn')!;
  const cancelBtn = overlay.querySelector<HTMLButtonElement>('#change-game-cancel-btn')!;

  let selectedGameId: string | null = null;
  let selectedOptions: Record<string, string> = {};

  overlay.querySelectorAll<HTMLButtonElement>('.change-game-card:not(.is-disabled)').forEach((card) => {
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

      overlay.querySelectorAll('.change-game-card').forEach((c) => c.classList.remove('is-selected'));
      card.classList.add('is-selected');

      if (game.meta.roomOptions.length > 0) {
        optsContainer.innerHTML = `
          <div class="change-game-options-title">⚙️ 게임 설정</div>
          ${game.meta.roomOptions.map(renderOption).join('')}
        `;
        for (const opt of game.meta.roomOptions) {
          const sel = optsContainer.querySelector<HTMLSelectElement>(`#opt-${opt.key}`);
          sel?.addEventListener('change', () => { selectedOptions[opt.key] = sel.value; });
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

  startBtn.addEventListener('click', () => {
    if (!selectedGameId) return;
    closeOverlay();
    o.onConfirm(selectedGameId, selectedOptions);
  });

  return closeOverlay;
}
