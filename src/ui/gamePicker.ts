import { games, getGameById } from '../games/registry';
import { GAME_CATEGORIES, type GameRoomOption, type GameCategory } from '../games/types';
import { escapeHtml, escapeAttr } from './escape';
import { icon } from './icons';

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

// ============================================
// 인원수 필터 (게임 목록 / 게임 선택 공용)
// ============================================

/** 인원수 필터. null 이면 전체 보기 */
export type PlayerFilter = number | null;

/** n명이 이 게임을 할 수 있나 (min~max 범위 안인가) */
export function playableBy(meta: { minPlayers: number; maxPlayers: number }, n: PlayerFilter): boolean {
  return n === null || (n >= meta.minPlayers && n <= meta.maxPlayers);
}

/** 칩을 몇 개까지 만들지 — 레지스트리에서 뽑는다(게임 추가해도 안 틀어지게) */
const MAX_N = Math.max(...games.map((g) => g.meta.maxPlayers));

/** 필터 값 → 버튼에 보일 글자 */
function filterLabel(n: PlayerFilter): string {
  return n === null ? '전체' : `${n}명`;
}

/**
 * 인원수 필터 — 버튼을 누르면 아래로 펼쳐지는 드롭다운.
 *
 * 칩/세그먼트로 11개를 쭉 늘어놓으니 화면만 잡아먹고 산만했다.
 * 평소엔 버튼 하나로 접혀 있고, 고를 때만 펼친다.
 * nowN 을 주면 그 항목에 '지금 방 인원' 꼬리표를 붙인다.
 */
export function buildPlayerFilterHTML(selected: PlayerFilter, nowN?: number): string {
  const nums: PlayerFilter[] = [null, ...Array.from({ length: MAX_N }, (_, i) => i + 1)];
  const items = nums.map((n) => {
    const isNow = n !== null && n === nowN;
    return `<button type="button" class="pf-dd-item${n === selected ? ' is-on' : ''}" data-n="${n ?? ''}">
      <span>${filterLabel(n)}</span>
      ${isNow ? '<em class="pf-now">지금 방 인원</em>' : ''}
    </button>`;
  });
  return `
    <div class="pf-dd">
      <button type="button" class="pf-dd-btn" aria-expanded="false" aria-haspopup="listbox">
        ${icon('users', { size: 14, hue: '#2a9488' })}
        <span class="pf-dd-label">인원</span>
        <b>${filterLabel(selected)}</b>
        <span class="pf-dd-caret" aria-hidden="true"></span>
      </button>
      <div class="pf-dd-menu" role="listbox" hidden>${items.join('')}</div>
    </div>`;
}

// ============================================
// 분류 필터 (게임 목록 / 게임 선택 공용)
// ============================================

/** 분류 필터. null 이면 전체 보기 */
export type CategoryFilter = GameCategory | null;

/** 이 게임이 해당 분류에 속하나. 게임은 분류를 여러 개 가질 수 있다(복수 태그) */
export function inCategory(meta: { categories: GameCategory[] }, c: CategoryFilter): boolean {
  return c === null || meta.categories.includes(c);
}

/**
 * 분류 필터 — 인원 필터와 똑같은 드롭다운. 마크업/CSS(.pf-*)를 그대로 재사용하고
 * data 속성만 다르다(data-cat). 둘을 나란히 놔도 톤이 안 어긋나게.
 */
export function buildCategoryFilterHTML(selected: CategoryFilter): string {
  const items = [null, ...GAME_CATEGORIES].map((c) => {
    const label = c ?? '전체';
    return `<button type="button" class="pf-dd-item${c === selected ? ' is-on' : ''}" data-cat="${escapeAttr(c ?? '')}">
      <span>${escapeHtml(label)}</span>
    </button>`;
  });
  return `
    <div class="pf-dd pf-dd-cat">
      <button type="button" class="pf-dd-btn" aria-expanded="false" aria-haspopup="listbox">
        ${icon('games', { size: 14, hue: '#2a9488' })}
        <span class="pf-dd-label">분류</span>
        <b>${escapeHtml(selected ?? '전체')}</b>
        <span class="pf-dd-caret" aria-hidden="true"></span>
      </button>
      <div class="pf-dd-menu" role="listbox" hidden>${items.join('')}</div>
    </div>`;
}

/** 분류 드롭다운 배선. root 안쪽의 .pf-dd-cat 를 잡는다 */
export function wireCategoryFilter(root: HTMLElement, onChange: (c: CategoryFilter) => void): void {
  wireDropdown(root.querySelector<HTMLElement>('.pf-dd-cat'), (it) => {
    const raw = it.dataset['cat'];
    onChange(raw ? (raw as GameCategory) : null);
  });
}

/**
 * 바깥 클릭 / ESC 로 닫기 — 문서에 **딱 한 번만** 건다.
 * wirePlayerFilter 는 재렌더될 때마다 불리는데, 거기서 document 에 걸면 리스너가 계속 쌓인다.
 */
let closerWired = false;
function wireCloser(): void {
  if (closerWired) return;
  closerWired = true;
  const closeAll = (except?: Node): void => {
    document.querySelectorAll<HTMLElement>('.pf-dd.is-open').forEach((dd) => {
      if (except && dd.contains(except)) return;
      dd.classList.remove('is-open');
      dd.querySelector('.pf-dd-menu')?.setAttribute('hidden', '');
      dd.querySelector('.pf-dd-btn')?.setAttribute('aria-expanded', 'false');
    });
  };
  document.addEventListener('click', (e) => closeAll(e.target as Node));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
}

/**
 * 열기/닫기 + 항목 클릭 배선 — 인원·분류 드롭다운이 똑같아서 여기로 묶었다.
 * dd 가 없으면(해당 필터를 안 쓰는 화면) 조용히 넘어간다.
 */
/**
 * 드롭다운 한 개 배선 (열고 닫기 + 항목 클릭).
 * 변경 로그 화면도 같은 모양의 필터를 써서 내보낸다. 쓰는 데가 아직 둘뿐이라
 * 공용 모듈로 빼지 않고 여기 둔다 (CLAUDE.md: 추상화는 세 번째부터).
 */
export function wireDropdown(dd: HTMLElement | null, onPick: (item: HTMLButtonElement) => void): void {
  wireCloser();
  if (!dd) return;
  const btn = dd.querySelector<HTMLButtonElement>('.pf-dd-btn')!;
  const menu = dd.querySelector<HTMLDivElement>('.pf-dd-menu')!;

  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // 문서 리스너가 열자마자 닫아버리지 않게
    const open = !dd.classList.contains('is-open');
    dd.classList.toggle('is-open', open);
    menu.toggleAttribute('hidden', !open);
    btn.setAttribute('aria-expanded', String(open));
  });

  menu.querySelectorAll<HTMLButtonElement>('.pf-dd-item').forEach((it) => {
    it.addEventListener('click', () => onPick(it));
  });
}

/** 인원 드롭다운 배선. 분류 드롭다운(.pf-dd-cat)이 같은 root 에 있어도 안 집히게 :not 으로 거른다 */
export function wirePlayerFilter(root: HTMLElement, onChange: (n: PlayerFilter) => void): void {
  wireDropdown(root.querySelector<HTMLElement>('.pf-dd:not(.pf-dd-cat)'), (it) => {
    const raw = it.dataset['n'];
    onChange(raw ? Number(raw) : null);
  });
}

/**
 * 게임 타일 그리드 HTML (오버레이/대기실 인라인 공용).
 * 인원 초과(overMax)면 항상 잠금. enforceMin 이면 인원 미달(underMin)도 잠금.
 *
 * filter 는 **잠그는 게 아니라 아예 숨긴다.** 잠금(회색 카드)은 "지금 방 인원으로는 못 함" 이고,
 * 필터는 "N명이 할 수 있는 것만 보여줘" 라 목적이 다르다.
 */
export function buildGameTilesHTML(
  playerCount: number,
  currentGameId: string,
  opts?: { enforceMin?: boolean; filter?: PlayerFilter; category?: CategoryFilter },
): string {
  const enforceMin = opts?.enforceMin ?? true;
  const filter = opts?.filter ?? null;
  const category = opts?.category ?? null;
  const shown = games.filter((g) => playableBy(g.meta, filter) && inCategory(g.meta, category));
  if (shown.length === 0) {
    // 두 필터가 겹쳐 0개가 될 수 있어서 어느 조건 때문인지 같이 알려준다
    const why = [category, filter === null ? null : `${filter}명`].filter(Boolean).join(' · ');
    return `<div class="pf-empty">${escapeHtml(why)} 조건에 맞는 게임이 없어요</div>`;
  }
  return shown.map((g) => {
    const overMax = playerCount > g.meta.maxPlayers;
    const underMin = enforceMin && playerCount < g.meta.minPlayers;
    const fits = !overMax && !underMin;
    const playerLabel = g.meta.minPlayers === g.meta.maxPlayers
      ? `${g.meta.minPlayers}인 전용`
      : `${g.meta.minPlayers}~${g.meta.maxPlayers}인`;
    const isCurrent = g.meta.id === currentGameId;
    // 썸네일 + 이름 + 인원 뱃지. 선택 표시는 ✓ 뱃지로만(텍스트 줄 추가 X → 카드 높이 균일).
    // 잠긴 게임만 '현재 N명' 사유를 한 줄 표시.
    const note = fits ? '' : `현재 ${playerCount}명`;
    return `
      <button class="change-game-card${fits ? '' : ' is-disabled'}${isCurrent ? ' is-current' : ''}"
              data-game-id="${escapeAttr(g.meta.id)}" ${fits ? '' : 'disabled'}>
        <img class="change-game-card-thumb" src="${escapeAttr(g.meta.thumbnail)}" alt="" />
        <div class="change-game-card-name">${escapeHtml(g.meta.name)}</div>
        <span class="change-game-card-players">${escapeHtml(playerLabel)}</span>
        ${note ? `<div class="change-game-card-meta">${escapeHtml(note)}</div>` : ''}
      </button>
    `;
  }).join('');
}

/**
 * 게스트 대기실용 — 방장이 고른 게임 "한 장"만 크게.
 *
 * 게스트는 어차피 못 고르는데(is-readonly) 회색 타일 24개를 스크롤해서 하이라이트 하나를
 * 찾아야 했다. 고른 것만 설명까지 붙여 보여주는 쪽이 명확하다.
 * 룩은 도감(.game-card.is-static)을 그대로 재사용 — 같은 게 두 벌 생기지 않게.
 */
export function buildPickedGameHTML(gameId: string): string {
  const g = games.find((x) => x.meta.id === gameId);
  if (!g) return `<div class="pf-empty">방장이 게임을 고르는 중이에요</div>`;
  const m = g.meta;
  const playerLabel = m.minPlayers === m.maxPlayers
    ? `${m.minPlayers}인 전용`
    : `${m.minPlayers}~${m.maxPlayers}인`;
  return `
    <div class="game-card is-static waiting-picked-card">
      <img class="game-card-thumb" src="${escapeAttr(m.thumbnail)}" alt="${escapeAttr(m.name)}" />
      <div class="game-card-name">
        ${escapeHtml(m.name)}
        <span class="game-card-players">${escapeHtml(playerLabel)}</span>
      </div>
      <div class="game-card-desc">${escapeHtml(m.description)}</div>
      <button type="button" class="help-btn" id="picked-help-btn">${icon('question', { size: 14, hue: '#2a9488' })}도움말</button>
    </div>
  `;
}

/** 선택된 게임의 옵션 폼 HTML. current 로 현재 선택값을 반영(없으면 기본값). 옵션 없으면 안내. */
export function buildGameOptionsHTML(gameId: string, current?: Record<string, string>): string {
  const g = getGameById(gameId);
  // 게임 미선택 — 통일성 위해 박스는 항상 노출하고 안내만
  if (!g) {
    return `<div class="change-game-no-options">게임을 먼저 골라주세요</div>`;
  }
  if (g.meta.roomOptions.length === 0) {
    return `<div class="change-game-no-options">설정 없이 바로 시작할 수 있어요</div>`;
  }
  return `<div class="change-game-options-title">${icon('settings', { size: 15, hue: '#9a86c0' })} 게임 설정</div>${
    g.meta.roomOptions.map((opt) =>
      renderOption(opt, current?.[opt.key], g.meta.roomOptions, current ?? {})).join('')
  }`;
}

function buildOverlayHTML(o: GamePickerOptions, filter: PlayerFilter): string {
  const cards = buildGameTilesHTML(o.playerCount, o.currentGameId, {
    enforceMin: o.enforceMin,
    filter,
  });

  return `
    <div class="change-game-overlay" id="change-game-overlay">
      <div class="change-game-card-wrap">
        <div class="change-game-title">${escapeHtml(o.title ?? '게임 선택')}</div>
        <div class="change-game-subtitle">${escapeHtml(o.subtitle ?? `현재 방 멤버 ${o.playerCount}명`)}</div>

        <div class="pf-wrap" id="change-game-filter">${buildPlayerFilterHTML(filter, o.playerCount)}</div>

        <div class="change-game-grid" id="change-game-grid">${cards}</div>

        <div class="change-game-options" id="change-game-options"></div>

        <div class="change-game-actions">
          <button class="btn btn-ghost" id="change-game-cancel-btn">취소</button>
          <button class="btn btn-primary" id="change-game-start-btn" disabled>${escapeHtml(o.confirmLabel ?? '선택')}</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * 지금 보여줄 선택지만. 상위 옵션(dependsOn) 값에 맞는 것만 남긴다.
 * (지하철 타자: 국가를 한국으로 두면 한국 노선만)
 */
export function visibleChoices(
  opt: GameRoomOption,
  all: readonly GameRoomOption[],
  current: Record<string, string>,
): GameRoomOption['choices'] {
  if (!opt.dependsOn) return opt.choices;
  const parent = all.find((o) => o.key === opt.dependsOn);
  const pv = current[opt.dependsOn] ?? parent?.defaultValue ?? '';
  const shown = opt.choices.filter((c) => c.when === undefined || c.when === pv);
  return shown.length > 0 ? shown : opt.choices;
}

/**
 * 상위 옵션이 바뀌어 하위 값이 목록에서 사라졌으면 첫 유효값으로 되돌린다.
 * 안 하면 국가를 한국으로 바꿔도 roomOptions 엔 일본 노선이 남아 그대로 시작된다.
 */
export function reconcileOptions(gameId: string, opts: Record<string, string>): Record<string, string> {
  const g = getGameById(gameId);
  if (!g) return opts;
  const out = { ...opts };
  for (const opt of g.meta.roomOptions) {
    const shown = visibleChoices(opt, g.meta.roomOptions, out);
    const cur = out[opt.key];
    if (cur !== undefined && shown.some((c) => c.value === cur)) continue;
    // 기본값이 지금 목록에 있으면 그쪽을 쓴다 (한국으로 되돌렸을 때 1호선 말고 2호선)
    const fallback = shown.find((c) => c.value === opt.defaultValue) ?? shown[0];
    if (fallback) out[opt.key] = fallback.value;
  }
  return out;
}

function renderOption(
  opt: GameRoomOption,
  currentValue?: string,
  all?: readonly GameRoomOption[],
  current?: Record<string, string>,
): string {
  const choices = all && current ? visibleChoices(opt, all, current) : opt.choices;
  // 현재값 > 기본값 > 첫 선택지 순. 기본값을 건너뛰면 기본이 첫 항목이 아닌 게임
  // (꼬들 라운드 수 등)이 엉뚱한 값으로 보인다.
  const chosen = currentValue !== undefined && choices.some((c) => c.value === currentValue)
    ? currentValue
    : choices.some((c) => c.value === opt.defaultValue)
      ? opt.defaultValue
      : (choices[0]?.value ?? opt.defaultValue);
  return `
    <div class="form-group">
      <label class="input-label">${escapeHtml(opt.label)}</label>
      <select class="select" id="opt-${escapeAttr(opt.key)}">
        ${choices.map((c) => `
          <option value="${escapeAttr(c.value)}"${c.value === chosen ? ' selected' : ''}>
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

  // 처음엔 전체 보기. 방 인원에 맞춰 자동으로 걸면 "내 게임 어디 갔지" 가 되니 사용자가 직접 고르게 한다
  let filter: PlayerFilter = null;

  parent.insertAdjacentHTML('beforeend', buildOverlayHTML(o, filter));
  const overlay = parent.querySelector<HTMLDivElement>('#change-game-overlay')!;
  const filterEl = overlay.querySelector<HTMLDivElement>('#change-game-filter')!;
  const gridEl = overlay.querySelector<HTMLDivElement>('#change-game-grid')!;
  const optsContainer = overlay.querySelector<HTMLDivElement>('#change-game-options')!;
  const startBtn = overlay.querySelector<HTMLButtonElement>('#change-game-start-btn')!;
  const cancelBtn = overlay.querySelector<HTMLButtonElement>('#change-game-cancel-btn')!;

  let selectedGameId: string | null = null;
  let selectedOptions: Record<string, string> = {};

  const wireCards = (): void => {
    gridEl.querySelectorAll<HTMLButtonElement>('.change-game-card:not(.is-disabled)').forEach((card) => {
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

        gridEl.querySelectorAll('.change-game-card').forEach((c) => c.classList.remove('is-selected'));
        card.classList.add('is-selected');

        if (game.meta.roomOptions.length > 0) {
          optsContainer.innerHTML = `
            <div class="change-game-options-title">${icon('settings', { size: 15, hue: '#9a86c0' })} 게임 설정</div>
            ${game.meta.roomOptions.map((o) =>
              renderOption(o, selectedOptions[o.key], game.meta.roomOptions, selectedOptions)).join('')}
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
  };
  wireCards();

  // 필터를 바꾸면 그리드를 다시 그린다. 고른 게임이 필터에서 빠지면 선택도 같이 푼다
  // (안 풀면 화면엔 안 보이는 게임이 시작돼버린다)
  const applyFilter = (n: PlayerFilter): void => {
    filter = n;
    filterEl.innerHTML = buildPlayerFilterHTML(filter, o.playerCount);
    wirePlayerFilter(filterEl, applyFilter);
    gridEl.innerHTML = buildGameTilesHTML(o.playerCount, o.currentGameId, {
      enforceMin: o.enforceMin,
      filter,
    });
    wireCards();
    const stillShown = selectedGameId !== null
      && !!gridEl.querySelector(`.change-game-card[data-game-id="${selectedGameId}"]`);
    if (stillShown) {
      gridEl.querySelector(`.change-game-card[data-game-id="${selectedGameId}"]`)?.classList.add('is-selected');
    } else {
      selectedGameId = null;
      selectedOptions = {};
      optsContainer.innerHTML = `<div class="change-game-no-options">게임을 먼저 골라주세요</div>`;
      startBtn.disabled = true;
    }
  };
  wirePlayerFilter(filterEl, applyFilter);

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
