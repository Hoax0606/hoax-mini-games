/**
 * 꼬들 렌더러 (HTML DOM — 라이어 게임/끝말잇기와 통일, 캔버스는 숨긴다)
 *
 * 레이아웃: [좌: 내 그리드 + 자모 키보드] [우: 상단 필 → 플레이어별 진행/점수]
 *   그리드 칸은 자모 하나. 12칸 모드는 가로가 길어서 칸 크기를 폭에 맞춰 줄인다.
 *
 * 다시 그리는 단위를 쪼개놨다 — 매 프레임 통째로 재생성하면
 * 입력창 포커스가 날아가고 뒤집기 애니메이션이 계속 리셋된다.
 *   · 그리드/키보드: 시도 수·phase 가 바뀔 때만
 *   · 타이머: 매 프레임 (텍스트만)
 *   · 우측 패널: 점수/진행이 바뀔 때만
 */

import type { Mark } from './rules';
import { JAMO_ROWS, MAX_TRIES, KEY_TO_JAMO, decompose, decomposeInput, mergeKeyboard } from './rules';
import type { KdPublic } from './netSync';
import { icon } from '../../ui/icons';
import { escapeHtml } from '../../ui/escape';

export interface KdRenderState {
  pub: KdPublic;
  myPeerId: string;
  isSpectator: boolean;
  /** 내가 제출한 추측들 (로컬 보관) */
  myGuesses: string[];
  /** 입력 버퍼 — 기본 자모만 담긴다. 출제·추측이 같이 쓴다 */
  jamo: string[];
  /** 내가 출제자면 내가 낸 단어 */
  myWord: string | null;
  /** 출제 입력 실시간 검증 — 치는 동안 몇 칸인지/어떤 단어로 읽히는지 알려준다 */
  wordCheck: { ok: boolean; word: string | null; message: string } | null;
  /** 라운드 시작 후 경과 ms (로컬 시계 기준) */
  elapsedMs: number;
  /** 방장만 '게임 끝내기' 를 쓸 수 있다 */
  isHost: boolean;
  /** 안내/거절 메시지 */
  notice: string;
}

export interface KdCallbacks {
  /** 자모 한 글자 입력 (화면 키보드 클릭 / 물리 키) */
  onJamo(jamo: string): void;
  onBackspace(): void;
  /** 지금 버퍼를 제출 — 출제 화면이면 출제, 추측 화면이면 추측 */
  onSubmit(): void;
  /** 무제한 모드에서 방장이 끝내기 */
  onFinish(): void;
  /** 출제가 막힐 때 단어장에서 하나 뽑아오기 */
  onPickRandom(): void;
}

const fmtTime = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class KordleRenderer {
  private canvas: HTMLCanvasElement;
  private cb: KdCallbacks;
  private root: HTMLDivElement;
  private styleEl: HTMLStyleElement;

  private phaseEl: HTMLSpanElement;
  private roundEl: HTMLSpanElement;
  private timerEl: HTMLSpanElement;
  private gridEl: HTMLDivElement;
  private kbEl: HTMLDivElement;
  private actionEl: HTMLDivElement;
  private noticeEl: HTMLDivElement;
  private panelEl: HTMLDivElement;

  /** 키 입력을 받아도 되는 상황인지 판단하려고 마지막 상태를 들고 있는다 */
  private last: KdRenderState | null = null;
  private onKeyDown: (e: KeyboardEvent) => void;

  /** 다시 그릴지 판단하는 키들 — 바뀐 것만 갱신 */
  private gridKey = '';
  private kbKey = '';
  private actionKey = '';
  private panelKey = '';

  constructor(canvas: HTMLCanvasElement, cb: KdCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    this.canvas.style.display = 'none';

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'kd-screen';
    this.root.innerHTML = `
      <div class="kd-main">
        <div class="kd-top">
          <span class="kd-pill kd-round" id="kd-round"></span>
          <span class="kd-phase" id="kd-phase"></span>
          <span class="kd-pill kd-timer" id="kd-timer"></span>
        </div>
        <div class="kd-grid" id="kd-grid"></div>
        <div class="kd-notice" id="kd-notice"></div>
        <div class="kd-action" id="kd-action"></div>
        <div class="kd-kb" id="kd-kb"></div>
      </div>
      <aside class="kd-side" id="kd-side"></aside>
    `;
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.root);
    }

    this.roundEl = this.root.querySelector<HTMLSpanElement>('#kd-round')!;
    this.phaseEl = this.root.querySelector<HTMLSpanElement>('#kd-phase')!;
    this.timerEl = this.root.querySelector<HTMLSpanElement>('#kd-timer')!;
    this.gridEl = this.root.querySelector<HTMLDivElement>('#kd-grid')!;
    this.kbEl = this.root.querySelector<HTMLDivElement>('#kd-kb')!;
    this.actionEl = this.root.querySelector<HTMLDivElement>('#kd-action')!;
    this.noticeEl = this.root.querySelector<HTMLDivElement>('#kd-notice')!;
    this.panelEl = this.root.querySelector<HTMLDivElement>('#kd-side')!;

    // 자모 입력은 **물리 키 위치**(event.code)로 받는다.
    // 한/영 상태를 안 타고, ㅐ(KeyO)·ㅔ(KeyP)·쌍자음(Shift)은 매핑이 없어 자연히 막힌다.
    this.onKeyDown = (e: KeyboardEvent): void => {
      if (!this.canType()) return;
      const a = document.activeElement;
      // 채팅 등 다른 입력창에 타이핑 중이면 가로채지 않는다
      if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Enter') { e.preventDefault(); this.cb.onSubmit(); return; }
      if (e.key === 'Backspace') { e.preventDefault(); this.cb.onBackspace(); return; }
      const j = KEY_TO_JAMO[e.code];
      if (j) { e.preventDefault(); this.cb.onJamo(j); }
    };
    window.addEventListener('keydown', this.onKeyDown);
  }

  /**
   * 지금 자모를 받아도 되는 상태인가.
   * 출제자의 출제 입력과 참가자의 추측 입력, 두 경우 다 같은 네모칸에 직접 친다.
   */
  private canType(): boolean {
    const s = this.last;
    if (!s || s.isSpectator) return false;
    const amSetter = s.pub.setterPeerId === s.myPeerId;
    if (s.pub.phase === 'setword') return amSetter;
    if (s.pub.phase !== 'guess') return false;
    if (amSetter) return false;
    const me = s.pub.players.find((p) => p.peerId === s.myPeerId);
    return !!me && !me.solved && !me.failed;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  render(s: KdRenderState): void {
    this.last = s;
    const { pub } = s;
    const me = pub.players.find((p) => p.peerId === s.myPeerId) ?? null;
    const amSetter = pub.setterPeerId === s.myPeerId;

    // --- 상단 ---
    this.roundEl.textContent = pub.totalRounds > 0
      ? `ROUND ${pub.round} / ${pub.totalRounds}`
      : `ROUND ${pub.round}`;
    this.phaseEl.textContent = this.phaseText(pub, s, amSetter);
    const showTimer = pub.phase === 'guess' && !amSetter && !s.isSpectator && !(me && (me.solved || me.failed));
    this.timerEl.hidden = !showTimer;
    if (showTimer) this.timerEl.textContent = fmtTime(s.elapsedMs);

    // --- 그리드 ---
    const marks = me?.marks ?? [];
    // 출제자·관전자는 그리드 자리에 '남들 보드'를 보므로, 남들 진행이 바뀔 때도 다시 그려야 한다.
    // 이걸 빼먹으면 출제자 화면이 첫 상태에서 얼어붙는다.
    const watching = amSetter || s.isSpectator;
    const gridKey = [
      pub.jamoLen, pub.round, pub.phase, marks.length, s.jamo.join(''),
      amSetter ? '1' : '0', pub.answer ?? '',
      watching ? pub.players.map((p) => `${p.peerId}:${p.marks.length}:${p.solved}:${p.failed}`).join(',') : '',
    ].join('|');
    // 칸 수를 루트에 올려둔다 — 상단바/입력/키보드도 그리드와 같은 폭으로 맞추려고
    this.root.style.setProperty('--kd-cols', String(pub.jamoLen));
    if (gridKey !== this.gridKey) {
      this.gridKey = gridKey;
      this.drawGrid(s, marks, amSetter);
    }

    // --- 키보드 ---
    // 맞힐 일이 없는 사람에겐 키보드를 안 보여준다 — 눌러도 아무 일도 안 일어나는데
    // 그대로 떠 있어서 "내가 뭐가 할 수 있나" 가 헷갈리게 했다. 출제 중엔 필요하니 그때만 보인다.
    const hideKb = (pub.phase !== 'setword' && watching) || pub.phase === 'reveal' || pub.phase === 'ended';
    // hidden 속성은 .kd-kb 의 display:flex 에 짐룡다 — style 로 직접 끊는다
    this.kbEl.style.display = hideKb ? 'none' : '';
    const kbState = this.keyboardState(s.myGuesses, marks);
    const kbKey = `${pub.round}|${Object.entries(kbState).sort().join(',')}`;
    if (kbKey !== this.kbKey) {
      this.kbKey = kbKey;
      this.drawKeyboard(kbState);
    }

    // --- 입력 영역 ---
    // marks.length 를 키에 넣어 **제출할 때마다 입력창을 새로 만든다**.
    // 이걸 안 하면 ① 친 글자가 입력창에 그대로 남고 ② 'n번 남음' 안내가 안 바뀌고
    // ③ 안내 문구가 안 바뀌어 그리드 다시 그리기가 한 박자 밀린다.
    const actionKey = [
      pub.phase, amSetter ? '1' : '0', s.isSpectator ? '1' : '0', pub.round,
      me?.marks.length ?? 0, me?.solved ? '1' : '0', me?.failed ? '1' : '0',
      pub.totalRounds, s.isHost ? '1' : '0',
      // 출제 화면은 치는 동안 안내 문구와 버튼 상태가 바뀐다
      pub.phase === 'setword' ? `${s.wordCheck?.ok}|${s.wordCheck?.message ?? ''}` : '',
    ].join('|');
    if (actionKey !== this.actionKey) {
      this.actionKey = actionKey;
      this.drawAction(s, me, amSetter);
    }

    this.noticeEl.textContent = s.notice;
    this.noticeEl.hidden = !s.notice;

    // --- 우측 패널 ---
    const panelKey = pub.players
      .map((p) => `${p.peerId}:${p.total}:${p.roundScore}:${p.marks.length}:${p.solved}:${p.failed}`)
      .join('|') + `|${pub.phase}|${pub.setterPeerId ?? ''}|${pub.answer ?? ''}|${pub.jamoLen}`;
    if (panelKey !== this.panelKey) {
      this.panelKey = panelKey;
      this.drawPanel(s);
    }
  }

  // ------------------------------------------------

  private phaseText(pub: KdPublic, s: KdRenderState, amSetter: boolean): string {
    const setter = pub.players.find((p) => p.peerId === pub.setterPeerId);
    switch (pub.phase) {
      case 'setword':
        return amSetter ? '문제로 낼 단어를 정하세요' : `${setter?.nickname ?? '출제자'} 님이 단어를 고르는 중…`;
      case 'guess': {
        if (s.isSpectator) return '관전 중';
        if (amSetter) return `내가 낸 단어: ${s.myWord ?? ''}`;
        const me = pub.players.find((p) => p.peerId === s.myPeerId);
        if (me?.solved) return '맞혔어요! 다른 사람 기다리는 중…';
        if (me?.failed) return '기회 소진 — 다른 사람 기다리는 중…';
        return `${pub.jamoLen}칸 단어를 맞혀보세요`;
      }
      case 'reveal':
        return `정답은 ${pub.answer ?? ''}`;
      case 'ended':
        return '게임 종료';
    }
  }

  /**
   * 출제자·관전자용 — 맞히는 사람들 보드를 한눈에.
   * 글자는 모르고 색만 안다(marks). 그걸로도 "어, 저 사람 거의 다 맞추고 있네" 가 보인다.
   */
  private drawWatch(s: KdRenderState, amSetter: boolean): void {
    const { pub } = s;
    const watchers = pub.players.filter(
      (p) => p.peerId !== pub.setterPeerId && p.peerId !== s.myPeerId,
    );
    if (watchers.length === 0) {
      this.gridEl.innerHTML = `<div class="kd-grid-off">${
        amSetter ? '맞힐 사람을 기다리는 중이에요' : '관전 중이에요'
      }</div>`;
      return;
    }
    const cols = pub.jamoLen;
    this.gridEl.innerHTML = `
      <div class="kd-watch-title">${amSetter ? '다들 푸는 중' : '관전 중'}</div>
      <div class="kd-watch">${watchers.map((p) => {
        const rows = p.marks.map((row) => `
          <div class="kd-wrow" style="grid-template-columns:repeat(${cols},1fr)">${
            row.map((m) => `<i class="kd-wcell kd-${m}"></i>`).join('')
          }</div>`).join('');
        const state = p.solved ? `<span class="kd-ok">${p.marks.length}회 만에 맞힘</span>`
          : p.failed ? '<span class="kd-no">실패</span>'
          : `<span class="kd-wtry">${p.marks.length}/${MAX_TRIES}</span>`;
        return `
          <div class="kd-wcard${p.solved ? ' is-solved' : ''}">
            <div class="kd-wname">${escapeHtml(p.nickname)}${state}</div>
            <div class="kd-wrows">${rows || '<div class="kd-wempty">아직 안 냈어요</div>'}</div>
          </div>`;
      }).join('')}</div>`;
  }

  private drawGrid(s: KdRenderState, marks: Mark[][], amSetter: boolean): void {
    const { jamoLen } = s.pub;
    // 출제 중이면 그리드를 '내가 낼 단어' 미리보기로 쓴다.
    // 자모 몇 칸인지 세어볼 방법이 없으면 출제가 답답해진다.
    if (amSetter && s.pub.phase === 'setword') {
      const j = s.jamo;
      const cells: string[] = [];
      for (let c = 0; c < jamoLen; c++) {
        const ch = j[c] ?? '';
        const caret = c === j.length ? ' kd-caret' : '';
        cells.push(`<i class="kd-cell${ch ? ' kd-typing' : ''}${caret}">${escapeHtml(ch)}</i>`);
      }
      this.gridEl.innerHTML = `<div class="kd-row kd-setrow">${cells.join('')}</div>`;
      return;
    }
    // 관전자와 '맞히는 단계의 출제자' 는 자기 칸이 없다.
    // 빈 안내문만 띄우니 내고 나서 할 게 없어 지루했다 — 남들이 즈음음거리는 걸 보여준다.
    // 색(채점 결과)은 원래 전원에게 동기화되고 글자는 안 온다 — 그래서 색만 그린다.
    if (amSetter || s.isSpectator) {
      this.drawWatch(s, amSetter);
      return;
    }
    const draftJamo = s.jamo;
    const rows: string[] = [];
    for (let r = 0; r < MAX_TRIES; r++) {
      const m = marks[r];
      const cells: string[] = [];
      for (let c = 0; c < jamoLen; c++) {
        if (m) {
          const j = decompose(s.myGuesses[r] ?? '')?.[c] ?? '';
          cells.push(`<i class="kd-cell kd-${m[c] ?? 'miss'}">${escapeHtml(j)}</i>`);
        } else if (r === marks.length) {
          const j = draftJamo[c] ?? '';
          const caret = c === draftJamo.length ? ' kd-caret' : '';
          cells.push(`<i class="kd-cell${j ? ' kd-typing' : ''}${caret}">${escapeHtml(j)}</i>`);
        } else {
          cells.push('<i class="kd-cell"></i>');
        }
      }
      rows.push(`<div class="kd-row">${cells.join('')}</div>`);
    }
    this.gridEl.innerHTML = rows.join('');
  }

  /** 내가 쓴 자모들의 최선 결과 — 키보드 색칠용 (누적 규칙은 rules.mergeKeyboard 가 단일 출처) */
  private keyboardState(guesses: readonly string[], marks: readonly Mark[][]): Record<string, Mark> {
    let out: Record<string, Mark> = {};
    for (let i = 0; i < marks.length; i++) {
      const j = decompose(guesses[i] ?? '');
      if (j) out = mergeKeyboard(out, j, marks[i]!);
    }
    return out;
  }

  private drawKeyboard(state: Record<string, Mark>): void {
    const rows = JAMO_ROWS.map(
      (row) =>
        `<div class="kd-kbrow">${row
          .map((j) => `<button type="button" class="kd-key${state[j] ? ` kd-${state[j]}` : ''}" data-j="${j}">${j}</button>`)
          .join('')}</div>`,
    );
    // 마우스만으로도 칠 수 있게 지움/제출 키를 붙인다
    rows.push(
      `<div class="kd-kbrow">` +
        `<button type="button" class="kd-key kd-key-wide" data-act="back">⌫ 지움</button>` +
        `<button type="button" class="kd-key kd-key-wide kd-key-go" data-act="go">제출 ⏎</button>` +
        `</div>`,
    );
    this.kbEl.innerHTML = rows.join('');
    this.kbEl.onclick = (e) => {
      if (!this.canType()) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-j],[data-act]');
      if (!el) return;
      const act = el.dataset['act'];
      if (act === 'back') this.cb.onBackspace();
      else if (act === 'go') this.cb.onSubmit();
      else if (el.dataset['j']) this.cb.onJamo(el.dataset['j']!);
    };
  }

  private drawAction(
    s: KdRenderState,
    me: KdPublic['players'][number] | null,
    amSetter: boolean,
  ): void {
    const { pub } = s;
    const finishBtn =
      s.isHost && pub.totalRounds === 0 && pub.phase !== 'ended'
        ? `<button type="button" class="kd-btn kd-btn-ghost" id="kd-finish">게임 끝내기</button>`
        : '';

    if (s.isSpectator || pub.phase === 'ended') {
      this.actionEl.innerHTML = finishBtn;
    } else if (pub.phase === 'setword' && amSetter) {
      // 추측과 똑같이 네모칸에 직접 친다 — 입력창 없음
      const wc = s.wordCheck;
      const ok = wc?.ok === true;
      this.actionEl.innerHTML = `
        <p class="kd-hint">자판을 치거나 아래 키를 눌러 <b>칸에 직접</b> 입력해요 · <b>Enter</b> 출제</p>
        <div class="kd-check${ok ? ' kd-check-ok' : wc && wc.message ? ' kd-check-bad' : ''}">${
          wc && wc.message ? escapeHtml(wc.message) : `자모 ${pub.jamoLen}칸짜리 단어를 생각해보세요`
        }</div>
        <div class="kd-setbtns">
          <button type="button" class="kd-btn kd-btn-ghost kd-pick" id="kd-pick">단어장에서 뽑기</button>
          <button type="button" class="kd-btn" id="kd-go"${ok ? '' : ' disabled'}>출제</button>
        </div>`;
    } else if (pub.phase === 'setword') {
      const setter = pub.players.find((p) => p.peerId === pub.setterPeerId);
      this.actionEl.innerHTML =
        `<p class="kd-hint">${escapeHtml(setter?.nickname ?? '출제자')} 님이 낼 단어를 고르는 중이에요</p>${finishBtn}`;
    } else if (pub.phase === 'guess' && amSetter) {
      this.actionEl.innerHTML = `<p class="kd-hint">모두가 맞히거나 기회를 다 쓰면 다음 라운드로 넘어가요.</p>${finishBtn}`;
    } else if (pub.phase === 'guess' && me && !me.solved && !me.failed) {
      // 입력창이 없다. 자모 키를 직접 받아 네모칸에 꽂는다 (아래 키보드의 24자만 가능).
      this.actionEl.innerHTML =
        `<p class="kd-hint">자판을 치거나 아래 키를 눌러요 · <b>Enter</b> 제출 · ${MAX_TRIES - me.marks.length}번 남음</p>`;
    } else {
      this.actionEl.innerHTML = `<p class="kd-hint">다른 사람을 기다리는 중…</p>${finishBtn}`;
    }

    this.actionEl
      .querySelector<HTMLButtonElement>('#kd-go')
      ?.addEventListener('click', () => this.cb.onSubmit());
    this.actionEl
      .querySelector<HTMLButtonElement>('#kd-finish')
      ?.addEventListener('click', () => this.cb.onFinish());
    this.actionEl
      .querySelector<HTMLButtonElement>('#kd-pick')
      ?.addEventListener('click', () => this.cb.onPickRandom());
  }

  private drawPanel(s: KdRenderState): void {
    const { pub } = s;
    const sorted = [...pub.players].sort((a, b) => b.total - a.total);
    const rows = sorted
      .map((p) => {
        const isMe = p.peerId === s.myPeerId;
        const isSetter = p.peerId === pub.setterPeerId;
        // 진행 표시 = **자리별 진척도**. 점 하나가 단어의 한 자리이고,
        // 지금까지의 시도를 통틀어 그 자리에서 나온 가장 좋은 결과를 보여준다.
        //   초록 = 그 자리를 찾음 / 노랑 = 그 자모가 단어엔 있지만 자리를 못 앉힘 / 회색 = 쳐봤는데 없음
        // 시도 횟수는 오른쪽 'n/6' 이 따로 알려주므로 둘이 안 겹친다.
        // 남의 글자는 여전히 안 보여준다 — 색만 준다.
        const tries = p.marks.length;
        const slots = Array.from({ length: pub.jamoLen }, (_, c) => {
          let best: Mark | null = null;
          for (const row of p.marks) {
            const m = row[c];
            if (!m) continue;
            if (m === 'hit') { best = 'hit'; break; }
            if (m === 'present') best = 'present';
            else if (best === null) best = 'miss';
          }
          return best
            ? `<i class="kd-dot kd-${best}" title="${c + 1}번째 자리"></i>`
            : '<i class="kd-dot"></i>';
        }).join('');
        const dots = isSetter
          ? '<span class="kd-setter">출제</span>'
          : `${slots}<span class="kd-trycount">${tries}/${MAX_TRIES}</span>`;
        const state = p.solved
          ? `<span class="kd-ok">맞힘 ${p.marks.length}회</span>`
          : p.failed
            ? '<span class="kd-ng">실패</span>'
            : '';
        const gain = pub.phase === 'reveal' && p.roundScore > 0 ? `<span class="kd-gain">+${p.roundScore}</span>` : '';
        return `
          <div class="kd-prow${isMe ? ' kd-me' : ''}">
            <div class="kd-pname">${escapeHtml(p.nickname)}${isMe ? ' <b>(나)</b>' : ''}</div>
            <div class="kd-pdots">${dots}</div>
            <div class="kd-pfoot">${state}<span class="kd-total">${p.total}점${gain}</span></div>
          </div>`;
      })
      .join('');
    this.panelEl.innerHTML = `
      <div class="kd-side-title">${icon('medal', { size: 16, hue: '#f5c33d' })} 점수</div>
      ${rows}`;
  }
}

/* 색은 theme.css 변수를 쓴다 (하드코딩 금지 규약).
   🟩 hit = 주색 청록 / 🟨 present = 포인트 노랑 / ⬜ miss = 흐린 회색 */
const CSS = `
.kd-screen{position:absolute;inset:0;display:flex;gap:14px;padding:14px;box-sizing:border-box;
  font-family:var(--font-sans);color:var(--text-main);overflow:auto;
  /* 칸 크기는 **가로와 세로를 둘 다** 봐야 한다.
     --kd-w  : 가로 기준(예전부터 쓰던 값). 6칸이면 360px, 12칸이면 648px.
     --kd-wh : 세로 기준. 그리드가 6줄이고 칸은 정사각형이라, 한 칸이 커질수록
               세로로 6배씩 먹는다. 상단바·안내·키보드가 쓰는 360px 를 빼고 6으로 나눈 값.
     예전엔 가로만 봐서 세로 700px 아래 화면(노트북, 윈도 배율 125~150%)에서
     그리드+키보드가 화면보다 길어졌고, 그게 위아래로 잘려 보였다. */
  --kd-w: max(360px, calc(var(--kd-cols,6) * 54px));
  --kd-wh: calc(var(--kd-cols,6) * max(30px, (100vh - 360px) / 6));}
/* 상단바·그리드·입력·키보드를 전부 같은 폭(= 칸 수 × 칸 크기)으로 묶어 가운데 정렬.
   안 묶으면 6칸 모드에서 타이머가 화면 오른쪽 끝까지 날아간다.
   justify-content 는 safe center — 그래도 넘치는 극단적인 화면에서 위쪽이 잘려 안 보이는 걸 막는다
   (자세한 이유는 theme.css .game-canvas-wrap 주석). */
.kd-main{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;
  justify-content:safe center;gap:10px;}
.kd-main > *{width:100%;max-width:var(--kd-w);}
/* 세로가 짧을 때 줄어드는 건 **그리드만**.
   상단바·안내문·키보드까지 같이 줄이면 글자가 두 줄로 접히고 자모 키가 줄을 넘는다.
   그리드만 작아지고 나머지는 그대로 가운데 정렬 — 보기에도 이게 낫다. */
.kd-main > .kd-grid{max-width:min(var(--kd-w), var(--kd-wh));}
.kd-top{display:flex;align-items:center;gap:10px;justify-content:center;}
.kd-pill{font-size:11.5px;font-weight:800;padding:4px 10px;border-radius:var(--radius-full);
  background:var(--bg-subtle);color:var(--text-muted);white-space:nowrap;}
.kd-timer{font-variant-numeric:tabular-nums;background:var(--highlight-soft);color:var(--highlight-ink);}
.kd-phase{font-size:14px;font-weight:800;text-align:center;flex:1 1 auto;min-width:0;}

.kd-grid{display:flex;flex-direction:column;gap:5px;align-items:center;}
.kd-row{display:grid;grid-template-columns:repeat(var(--kd-cols,6),1fr);gap:5px;width:100%;}
.kd-cell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;
  font-size:clamp(13px,2.2vw,22px);font-weight:800;font-style:normal;
  border:2px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);
  transition:background .18s,border-color .18s,color .18s;}
.kd-cell.kd-typing{border-color:var(--teal-300);}
/* 입력 위치 표시 — 투명 입력창이라 여기가 유일한 커서 단서다 */
.kd-cell.kd-caret{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);}
.kd-grid{cursor:text;}
.kd-cell.kd-hit{background:var(--accent);border-color:var(--accent);color:#fff;}
.kd-cell.kd-present{background:var(--highlight);border-color:var(--highlight);color:var(--highlight-ink);}
.kd-cell.kd-miss{background:var(--bg-subtle);border-color:var(--border-soft);color:var(--text-muted);}
.kd-grid-off{padding:40px 16px;text-align:center;color:var(--text-muted);font-size:13px;}
/* 출제자·관전자가 보는 남들 보드 */
.kd-watch-title{font-size:11.5px;font-weight:800;color:var(--text-muted);text-align:center;
  margin-bottom:7px;}
.kd-watch{display:flex;flex-wrap:wrap;gap:9px;justify-content:center;}
.kd-wcard{background:var(--bg-card);border:1.5px solid var(--border-soft);
  border-radius:var(--radius-md);padding:7px 9px;min-width:104px;}
.kd-wcard.is-solved{border-color:var(--mint-300);background:var(--mint-100);}
.kd-wname{display:flex;align-items:center;justify-content:space-between;gap:7px;
  font-size:11px;font-weight:800;color:var(--text-muted);margin-bottom:5px;}
.kd-wtry{font-weight:700;opacity:.8;}
.kd-wrows{display:flex;flex-direction:column;gap:3px;}
.kd-wrow{display:grid;gap:3px;}
.kd-wcell{width:11px;height:11px;border-radius:3px;background:var(--bg-subtle);
  border:1px solid var(--border-soft);}
.kd-wcell.kd-hit{background:var(--accent);border-color:var(--accent);}
.kd-wcell.kd-present{background:var(--highlight);border-color:var(--highlight);}
.kd-wcell.kd-miss{background:var(--bg-inset);border-color:var(--border-soft);}
.kd-wempty{font-size:10.5px;color:var(--text-muted);}

.kd-kb{display:flex;flex-direction:column;gap:5px;align-items:center;margin-top:8px;}
.kd-kbrow{display:flex;gap:4px;justify-content:center;flex-wrap:nowrap;}
/* 키 높이도 세로에 맞춰 줄인다 — 자모 키보드가 4줄이라 세로를 꽤 먹는다.
   폭(30px)은 그대로 둔다. 한 줄에 10개가 들어가야 해서 더 줄이면 줄이 넘친다. */
.kd-key{width:30px;height:max(26px, min(38px, (100vh - 420px) / 6));
  display:flex;align-items:center;justify-content:center;
  font-size:14px;font-weight:700;font-style:normal;border-radius:6px;
  background:var(--bg-subtle);color:var(--text-main);user-select:none;}
.kd-key.kd-hit{background:var(--accent);color:#fff;}
.kd-key.kd-present{background:var(--highlight);color:var(--highlight-ink);}
.kd-key.kd-miss{background:var(--border-soft);color:var(--text-muted);opacity:.55;}

.kd-action{display:flex;flex-direction:column;align-items:center;gap:6px;}
/* 키보드 키는 버튼 — 마우스로도 칠 수 있다 */
.kd-key{font:inherit;border:none;cursor:pointer;padding:0;}
.kd-key-wide{width:auto;padding:0 12px;font-size:12px;}
.kd-key-go{background:var(--accent);color:#fff;}
.kd-key-go:hover{background:var(--accent-hover);}
.kd-setbtns{display:flex;gap:8px;align-items:center;justify-content:center;}
.kd-btn{font:inherit;font-weight:800;font-size:13.5px;color:#fff;background:var(--accent);
  border:none;border-radius:var(--radius-full);padding:9px 18px;cursor:pointer;white-space:nowrap;}
.kd-btn:hover{background:var(--accent-hover);}
.kd-btn-ghost{background:transparent;color:var(--text-muted);border:1.5px solid var(--border);}
.kd-btn-ghost:hover{background:var(--bg-subtle);}
.kd-hint{font-size:12px;color:var(--text-muted);margin:0;text-align:center;}
/* 출제 실시간 안내 */
.kd-check{font-size:12.5px;font-weight:700;color:var(--text-muted);text-align:center;min-height:1.2em;}
.kd-check-ok{color:var(--mint-500);}
.kd-check-bad{color:var(--danger);}
.kd-pick{font-size:12px;padding:6px 14px;}
.kd-setrow{max-width:none;}
.kd-btn:disabled{opacity:.45;cursor:not-allowed;}
.kd-btn:disabled:hover{background:var(--accent);}
.kd-notice{font-size:12.5px;font-weight:700;color:var(--danger);min-height:0;text-align:center;}

.kd-side{width:200px;flex:0 0 200px;display:flex;flex-direction:column;gap:6px;overflow:auto;}
.kd-side-title{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;
  color:var(--text-muted);padding:0 4px 2px;}
.kd-prow{background:var(--bg-card);border:1.5px solid var(--border-soft);border-radius:var(--radius-md);
  padding:7px 10px;display:flex;flex-direction:column;gap:5px;}
.kd-prow.kd-me{border-color:var(--yellow-200);background:var(--highlight-soft);}
.kd-pname{font-size:12.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kd-pdots{display:flex;gap:3px;align-items:center;min-height:13px;flex-wrap:wrap;}
/* 점 = 단어의 자리 (6칸이면 6개, 12칸이면 12개). 오른쪽 n/6 이 시도 횟수 */
.kd-trycount{margin-left:auto;font-size:10px;font-weight:800;color:var(--text-muted);
  font-variant-numeric:tabular-nums;padding-left:6px;}
.kd-dot{width:9px;height:9px;border-radius:50%;background:var(--border-soft);font-style:normal;}
.kd-dot.kd-hit{background:var(--accent);}
.kd-dot.kd-present{background:var(--highlight);}
.kd-dot.kd-miss{background:var(--border);}
.kd-setter{font-size:10.5px;font-weight:800;color:var(--highlight-ink);background:var(--yellow-200);
  padding:1px 7px;border-radius:var(--radius-full);}
.kd-pfoot{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;}
.kd-ok{color:var(--mint-500);font-weight:800;}
.kd-ng{color:var(--danger);font-weight:800;}
.kd-total{margin-left:auto;font-weight:900;font-variant-numeric:tabular-nums;}
.kd-gain{color:var(--mint-500);margin-left:4px;}

@media (max-width:820px){
  .kd-screen{flex-direction:column;}
  .kd-side{width:100%;flex:0 0 auto;flex-direction:row;flex-wrap:wrap;}
  .kd-prow{flex:1 1 140px;}
  .kd-side-title{width:100%;}
}
`;
