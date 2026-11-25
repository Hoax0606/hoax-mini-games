/**
 * 지하철 타자 렌더러 (HTML DOM — 캔버스는 숨긴다)
 *
 * 화면 구성 (위에서 아래로)
 *   상단 알약들 → **선로 트랙** → [이전 역 | 현재 역 | 다음 역] → 입력창
 *
 * 핵심은 트랙이다. 전동차를 화면 **가운데 고정**해 두고 선로 쪽을 왼쪽으로 흘려서,
 * 역을 하나 맞힐 때마다 전동차가 다음 역으로 들어가는 것처럼 보이게 한다.
 * (전동차를 움직이면 노선이 길 때 화면 밖으로 나가버린다)
 *
 * ⚠️ **입력창은 조합 중에 절대 건드리지 않는다.** 다시 만들거나, value 를 비우거나,
 *    blur/focus 를 하면 윈도우 IME 조합이 깨져서 글자가 따라붙거나 통째로 사라진다.
 *    (역 이름을 다 친 순간은 마지막 글자가 아직 조합 중이라 늘 이 상황이다)
 *
 *    그래서 역을 통과해도 입력창을 비우지 않는다. `consumed` 로 "여기까지는 지나온 역"
 *    표시만 옮기고, 지금 치는 역 이름은 `value.slice(consumed)` 로 읽는다.
 *    대신 진짜 입력창은 투명하게 깔아 IME 만 받고, 보이는 글자는 .sb-typed 에 직접 그린다.
 */

import type { Standing } from './netSync';
import { isOnTrack, kpm } from './rules';
import { icon } from '../../ui/icons';
import { escapeHtml } from '../../ui/escape';

/** 선로에서 역 하나가 차지하는 폭(px). 역 이름이 들어갈 만큼은 돼야 한다 */
const STOP_GAP = 108;

export interface SbRenderState {
  lineName: string;
  /** 행선지 — 오금행 / 内回り */
  dest: string;
  course: string[];
  /** 'jp' 면 한자 위에 후리가나를 띄운다 */
  region: 'kr' | 'jp';
  /** course 와 같은 길이. 한국 노선은 전부 빈 문자열 */
  kana: string[];
  /** 내가 통과한 역 수 */
  index: number;
  typed: string;
  mistakes: number;
  chars: number;
  /** 출발 전 카운트다운 ms. 0 이하면 달리는 중 */
  countdownMs: number;
  elapsedMs: number;
  standings: Standing[];
  myPeerId: string;
  isSpectator: boolean;
  finished: boolean;
}

export interface SbCallbacks {
  onType(value: string): void;
  /** 엔터로 입력창을 비웠다 — 게임 쪽 버퍼도 같이 비우라고 알린다 */
  onClear(): void;
}

const fmt = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 100))}`;
};

export class SubwayRenderer {
  private canvas: HTMLCanvasElement;
  private cb: SbCallbacks;
  private root: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private input: HTMLInputElement;

  private lineEl: HTMLSpanElement;
  private progEl: HTMLSpanElement;
  private timeEl: HTMLSpanElement;
  private kpmEl: HTMLSpanElement;
  private accEl: HTMLSpanElement;
  private trackEl: HTMLDivElement;
  private stripEl: HTMLDivElement;
  private prevEl: HTMLDivElement;
  private curEl: HTMLDivElement;
  private nextEl: HTMLDivElement;
  private panelEl: HTMLDivElement;
  private overlayEl: HTMLDivElement;
  private trainEl: HTMLDivElement;
  private boxEl: HTMLDivElement;
  private typedEl: HTMLSpanElement;

  /**
   * 입력창에 이미 쌓인 "지나온 역들" 의 글자 수.
   * 역을 통과해도 입력창을 비우지 않고 이 값만 올린다 — 자세한 이유는 파일 상단 주석 참고.
   */
  private consumed = 0;

  private builtCourseKey = '';
  private lastIndex = -1;
  private lastPanelKey = '';

  constructor(canvas: HTMLCanvasElement, cb: SbCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    canvas.style.display = 'none';

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'sb-screen';
    this.root.innerHTML = `
      <div class="sb-main">
        <div class="sb-top">
          <span class="sb-pill sb-linebadge" id="sb-line"></span>
          <span class="sb-pill" id="sb-prog"></span>
          <span class="sb-pill" id="sb-time"></span>
          <span class="sb-pill" id="sb-kpm"></span>
          <span class="sb-pill sb-acc" id="sb-acc"></span>
        </div>

        <div class="sb-track" id="sb-track">
          <div class="sb-strip" id="sb-strip"></div>
          <div class="sb-train" id="sb-train">
            <div class="sb-car"><i></i><i></i><i></i></div>
          </div>
        </div>

        <div class="sb-row">
          <div class="sb-sidest" id="sb-prev"></div>
          <div class="sb-cur" id="sb-cur"></div>
          <div class="sb-sidest" id="sb-next"></div>
        </div>

        <div class="sb-inputbox" id="sb-inputbox">
          <span class="sb-typed" id="sb-typed"></span>
          <input class="sb-sink" id="sb-input" type="text" autocomplete="off"
                 autocapitalize="off" spellcheck="false" aria-label="역 이름 입력" />
        </div>
        <div class="sb-overlay" id="sb-overlay" hidden></div>
      </div>
      <aside class="sb-side" id="sb-side"></aside>
    `;
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.root);
    }

    const q = <T extends HTMLElement>(id: string): T => this.root.querySelector<T>('#' + id)!;
    this.lineEl = q('sb-line');
    this.progEl = q('sb-prog');
    this.timeEl = q('sb-time');
    this.kpmEl = q('sb-kpm');
    this.accEl = q('sb-acc');
    this.trackEl = q('sb-track');
    this.stripEl = q('sb-strip');
    this.trainEl = q('sb-train');
    this.prevEl = q('sb-prev');
    this.curEl = q('sb-cur');
    this.nextEl = q('sb-next');
    this.panelEl = q('sb-side');
    this.overlayEl = q('sb-overlay');
    this.boxEl = q('sb-inputbox');
    this.typedEl = q('sb-typed');
    this.input = q<HTMLInputElement>('sb-input');

    // 입력창 전체 값에서 '지나온 역들' 몫을 떼어낸 나머지가 지금 치고 있는 역 이름이다
    this.input.addEventListener('input', () => {
      this.cb.onType(this.input.value.slice(this.consumed));
    });

    /* 엔터 = 입력창 비우기. 꼬인 걸 한 번에 지우는 용도다.
     *
     * ⚠️ 조합 중(isComposing)에 누른 엔터는 **IME 의 변환 확정 엔터**라 건드리면 안 된다.
     *    일본어는 ひらがな→漢字 확정에 엔터를 쓰므로, 여기서 가로채면 한자를 못 친다. */
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      this.resetInput();
      this.cb.onClear();
    });
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  /**
   * 역을 하나 통과했다. **입력창은 손대지 않는다.** 여기까지가 지나온 역 몫이라고
   * 표시만 옮긴다. 다음 역 입력은 `value.slice(consumed)` 로 읽힌다.
   *
   * 역 이름을 다 치는 순간은 마지막 글자가 아직 조합 중이라(한글 '리'),
   * 이 시점에 value 를 비우거나 blur/focus 를 하면 OS IME 가 깨진다.
   * 조합 중인 글자가 다음 역으로 따라붙거나('링'), 반대로 다음 글자가 통째로
   * 사라지는('을지로3가' → '지로3가') 증상이 그거였다.
   */
  markStationPassed(): void {
    this.consumed = this.input.value.length;
  }

  /**
   * 입력창을 진짜로 비운다. **조합이 확정된 시점에만** 불러야 한다.
   * 지금은 엔터(조합 중이 아닐 때)에서만 부른다 — 꼬인 입력을 한 번에 지우는 용도.
   */
  resetInput(): void {
    this.input.value = '';
    this.consumed = 0;
  }

  /**
   * 입력창에 포커스를 돌려준다. **render 루프가 매 프레임 부른다는 걸 전제로 짜야 한다.**
   *
   * ⚠️ 이미 포커스가 있으면 **아무것도 하지 말 것.** 이미 포커스된 요소에 focus() 를 또
   *    부르면 Chrome 이 selection 을 복원하는데, 한글 조합 중에 selection 이 리셋되면
   *    **조합이 취소되면서 조합 중이던 글자가 삭제된다.** focus/blur 이벤트도 안 나가서
   *    원인이 전혀 안 보인다.
   *    초당 60번 그러고 있었던 탓에 '을지로3가' 를 치면 '을' 이 통째로 사라져 '지로3가' 가 됐다.
   */
  focus(): void {
    const a = document.activeElement;
    if (a === this.input) return; // 이미 포커스 있음 — 건드리면 조합이 깨진다
    if (a instanceof HTMLInputElement) return; // 채팅 중이면 안 뺏는다
    this.input.focus();
  }

  render(s: SbRenderState): void {
    const total = s.course.length;
    const cur = s.course[s.index] ?? '';
    const running = s.countdownMs <= 0 && !s.finished && !s.isSpectator;

    this.lineEl.textContent = `${s.lineName} ${s.dest}`;
    this.progEl.textContent = `${s.index} / ${total}`;
    this.timeEl.textContent = fmt(s.elapsedMs);
    this.kpmEl.textContent = `${kpm(s.chars, s.elapsedMs)} 타/분`;
    // 정확도 — 친 글자 대비 오타 비율. 오타 수보다 체감이 직관적이다
    const acc = s.chars > 0 ? Math.max(0, Math.round(((s.chars - s.mistakes) / s.chars) * 100)) : 100;
    this.accEl.textContent = `정확도 ${acc}%`;
    this.accEl.classList.toggle('sb-bad', acc < 90);

    // 선로는 코스가 바뀔 때만 다시 깐다
    const courseKey = `${s.lineName}|${total}|${s.course[0] ?? ''}`;
    if (courseKey !== this.builtCourseKey) {
      this.builtCourseKey = courseKey;
      this.lastIndex = -1;
      this.buildStrip(s.course);
    }
    if (s.index !== this.lastIndex) {
      this.lastIndex = s.index;
      this.moveTrain(s.index, total);
    }

    // 이전 / 현재 / 다음
    const jp = s.region === 'jp';
    const L = jp
      ? { prev: '前の駅', start: '始発', next: '次の駅', last: '終着', fin: '完走！' }
      : { prev: '이전 역', start: '출발', next: '다음 역', last: '종착', fin: '완주!' };
    const ruby = (i: number): string => {
      const name = s.course[i] ?? '';
      const yomi = jp ? (s.kana[i] ?? '') : '';
      return yomi
        ? `<ruby>${escapeHtml(name)}<rt>${escapeHtml(yomi)}</rt></ruby>`
        : escapeHtml(name);
    };
    this.prevEl.innerHTML = s.index > 0
      ? `<span class="sb-lbl">${L.prev}</span><b>${ruby(s.index - 1)}</b>`
      : `<span class="sb-lbl">${L.start}</span><b>—</b>`;
    this.nextEl.innerHTML = s.course[s.index + 1] !== undefined
      ? `<span class="sb-lbl">${L.next}</span><b>${ruby(s.index + 1)}</b>`
      : `<span class="sb-lbl">${L.next}</span><b>${L.last}</b>`;

    if (jp) {
      // 일본어는 한자를 IME 로 변환해 치는 거라 '친 만큼 앞부분을 칠하는' 게 성립하지 않는다.
      // (변환 전엔 ひらがな 라 한자와 앞글자부터 안 맞는다.)
      // 대신 한자 위에 후리가나를 띄워 무엇을 쳐야 하는지 보여준다.
      this.curEl.innerHTML = s.finished ? `<span class="sb-fin2">${L.fin}</span>` : ruby(s.index);
      this.curEl.classList.remove('sb-wrong');
    } else {
      // 현재 역 — 친 만큼 앞부분을 칠하고, 남은 글자는 밑줄로 글자 수를 보여준다
      const ok = isOnTrack(s.typed, cur);
      const hit = ok ? cur.slice(0, s.typed.length) : '';
      const rest = ok ? cur.slice(s.typed.length) : cur;
      this.curEl.innerHTML = s.finished
        ? `<span class="sb-fin2">${L.fin}</span>`
        : `<span class="sb-hit">${escapeHtml(hit)}</span>` +
          rest.split('').map((c) => `<span class="sb-restc">${escapeHtml(c)}</span>`).join('');
      this.curEl.classList.toggle('sb-wrong', !ok && s.typed.length > 0);
    }

    this.input.disabled = !running;
    this.boxEl.classList.toggle('is-off', !running);
    // 입력창 안내만 일본 모드에선 일본어로 (치는 대상이 일본어라 톤을 맞춘다)
    const P = jp
      ? { spec: '観戦中', wait: 'まもなく発車…', fin: '完走しました', go: '駅名を入力（Enterで消去）' }
      : { spec: '관전 중', wait: '잠시 후 출발…', fin: '완주했어요', go: '역 이름 입력 (Enter 로 지움)' };
    // 보이는 글자는 투명한 진짜 입력창 대신 여기에 직접 그린다 (조합 중 input 을 안 건드리려고)
    const ph = s.isSpectator ? P.spec
      : s.countdownMs > 0 ? P.wait
      : s.finished ? P.fin : P.go;
    this.typedEl.textContent = s.typed || ph;
    this.typedEl.classList.toggle('is-ph', s.typed.length === 0);

    if (s.countdownMs > 0) {
      this.overlayEl.hidden = false;
      this.overlayEl.innerHTML =
        `<div class="sb-count">${Math.ceil(s.countdownMs / 1000)}</div>`;
    } else {
      this.overlayEl.hidden = true;
    }

    const panelKey = s.standings
      .map((p) => `${p.peerId}:${p.index}:${p.timeMs ?? -1}:${p.mistakes}`)
      .join('|');
    if (panelKey !== this.lastPanelKey) {
      this.lastPanelKey = panelKey;
      this.drawPanel(s, total);
    }
  }

  /** 선로 깔기 — 역마다 동그라미 + 이름 */
  private buildStrip(course: string[]): void {
    this.stripEl.style.width = `${course.length * STOP_GAP}px`;
    this.stripEl.innerHTML =
      `<div class="sb-rail"></div>` +
      course
        .map(
          (name, i) => `
        <div class="sb-stop" style="left:${i * STOP_GAP + STOP_GAP / 2}px" data-i="${i}">
          <i class="sb-dot"></i><span class="sb-sname">${escapeHtml(name)}</span>
        </div>`,
        )
        .join('');
  }

  /** 전동차는 가운데 고정, 선로를 끌어당겨 다음 역이 전동차 아래로 오게 한다 */
  private moveTrain(index: number, total: number): void {
    const centerX = this.trackEl.clientWidth / 2;
    // 종착하면 마지막 역에 세운다
    const at = Math.min(index, Math.max(0, total - 1));
    const x = at * STOP_GAP + STOP_GAP / 2;
    this.stripEl.style.transform = `translateX(${centerX - x}px)`;
    // 지나온 역 칠하기
    const stops = this.stripEl.querySelectorAll<HTMLElement>('.sb-stop');
    stops.forEach((el, i) => {
      el.classList.toggle('sb-passed', i < index);
      el.classList.toggle('sb-here', i === index);
    });
    this.trainEl.classList.remove('sb-arrive');
    void this.trainEl.offsetWidth; // 애니메이션 재시작용 강제 리플로우
    this.trainEl.classList.add('sb-arrive');
  }

  private drawPanel(s: SbRenderState, total: number): void {
    const sorted = [...s.standings].sort((a, b) => {
      const ad = a.timeMs !== null, bd = b.timeMs !== null;
      if (ad !== bd) return ad ? -1 : 1;
      if (ad && bd) return a.timeMs! - b.timeMs!;
      return b.index - a.index;
    });
    const rows = sorted
      .map((p, i) => {
        const pct = total ? Math.round((p.index / total) * 100) : 0;
        const me = p.peerId === s.myPeerId;
        const done = p.timeMs !== null;
        return `
          <div class="sb-prow${me ? ' sb-me' : ''}">
            <div class="sb-pname"><span class="sb-rank">${i + 1}</span>${escapeHtml(p.nickname)}${me ? ' <b>(나)</b>' : ''}</div>
            <div class="sb-bar"><span style="width:${pct}%"></span><em style="left:${pct}%"></em></div>
            <div class="sb-pfoot">${done ? `<span class="sb-fin">${fmt(p.timeMs!)}</span>` : `${p.index}/${total}`}<span class="sb-pmiss">오타 ${p.mistakes}</span></div>
          </div>`;
      })
      .join('');
    this.panelEl.innerHTML = `
      <div class="sb-side-title">${icon('medal', { size: 16, hue: '#f5c33d' })} 진행</div>${rows}`;
  }
}

/* 색은 theme.css 변수 사용 (하드코딩 금지 규약) */
const CSS = `
.sb-screen{position:absolute;inset:0;display:flex;gap:14px;padding:16px;box-sizing:border-box;
  font-family:var(--font-sans);color:var(--text-main);overflow:auto;}
/* justify-content 는 safe center — 세로가 짧은 화면에서 위쪽이 스크롤로도 못 닿는 자리로
   밀려나는 걸 막는다 (자세한 이유는 theme.css .game-canvas-wrap 주석) */
.sb-main{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;
  justify-content:safe center;gap:16px;position:relative;}
.sb-top{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
.sb-pill{font-size:11.5px;font-weight:800;padding:4px 10px;border-radius:var(--radius-full);
  background:var(--bg-subtle);color:var(--text-muted);white-space:nowrap;font-variant-numeric:tabular-nums;}
.sb-linebadge{background:var(--accent);color:#fff;}
.sb-acc.sb-bad{background:var(--warn-soft);color:var(--warn);}

/* ── 선로 트랙 ── */
.sb-track{position:relative;width:100%;height:92px;overflow:hidden;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent);}
.sb-strip{position:absolute;top:0;left:0;height:100%;transition:transform .34s cubic-bezier(.3,.9,.3,1);}
.sb-rail{position:absolute;left:0;right:0;top:34px;height:6px;border-radius:3px;background:var(--border-soft);}
.sb-stop{position:absolute;top:0;transform:translateX(-50%);display:flex;flex-direction:column;
  align-items:center;gap:6px;width:${STOP_GAP}px;}
.sb-dot{margin-top:28px;width:18px;height:18px;border-radius:50%;background:var(--bg-card);
  border:3px solid var(--border);box-sizing:border-box;font-style:normal;transition:all .25s;}
.sb-sname{font-size:11px;font-weight:700;color:var(--text-muted);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:${STOP_GAP - 6}px;}
.sb-stop.sb-passed .sb-dot{background:var(--accent);border-color:var(--accent);}
.sb-stop.sb-passed .sb-sname{color:var(--accent);}
.sb-stop.sb-here .sb-dot{border-color:var(--highlight);background:var(--highlight);
  transform:scale(1.25);}
.sb-stop.sb-here .sb-sname{color:var(--text-main);font-weight:900;}

/* 전동차 — 가운데 고정, 선로가 흘러간다 */
.sb-train{position:absolute;left:50%;top:0;transform:translateX(-50%);pointer-events:none;}
.sb-car{width:52px;height:24px;border-radius:9px 9px 7px 7px;background:var(--accent);
  border:2.5px solid var(--teal-500);box-sizing:border-box;display:flex;gap:3px;
  align-items:center;justify-content:center;box-shadow:0 4px 10px rgba(42,148,136,.35);}
.sb-car i{width:9px;height:9px;border-radius:2px;background:var(--teal-100);font-style:normal;}
.sb-train.sb-arrive .sb-car{animation:sb-bob .34s ease-out;}
@keyframes sb-bob{0%{transform:translateY(-3px) scaleX(1.06);}60%{transform:translateY(1px);}100%{transform:none;}}

/* ── 이전 / 현재 / 다음 ── */
.sb-row{display:flex;align-items:center;gap:18px;width:100%;justify-content:center;}
.sb-sidest{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:92px;}
.sb-lbl{font-size:10px;font-weight:800;color:var(--text-muted);}
.sb-sidest b{font-size:15px;font-weight:800;color:var(--text-muted);white-space:nowrap;}
.sb-cur{font-size:clamp(28px,4.6vw,50px);font-weight:900;letter-spacing:-1px;min-height:1.2em;
  text-align:center;word-break:keep-all;display:flex;gap:2px;}
.sb-hit{color:var(--accent);}
/* 일본 노선 — 한자 위 후리가나. 뭘 쳐야 하는지 알려주는 유일한 단서라 또렷하게 */
.sb-cur ruby{ruby-position:over;}
.sb-cur rt{font-size:.34em;font-weight:800;color:var(--accent);letter-spacing:0;}
.sb-sidest rt{font-size:.4em;font-weight:700;color:var(--text-muted);}
/* 남은 글자는 밑줄로 글자 수를 알려준다 (한국 노선 전용) */
.sb-restc{color:var(--text-main);opacity:.28;border-bottom:3px solid var(--border);padding-bottom:2px;}
.sb-cur.sb-wrong .sb-restc{color:var(--danger);opacity:.75;border-bottom-color:var(--danger);}
.sb-fin2{color:var(--mint-500);}

/* ── 입력창 ──
   진짜 <input> 은 투명하게 깔아두고 IME 만 받는다. 보이는 글자는 .sb-typed 에 직접 그린다.
   역을 통과할 때 input 의 value·포커스를 건드리면 윈도우 IME 조합이 깨지기 때문이다
   (자세한 건 markStationPassed 주석). 그래서 알약 모양은 바깥 상자가 담당한다. */
.sb-inputbox{position:relative;width:100%;max-width:420px;min-height:52px;padding:12px 20px;
  border:2px solid var(--border);border-radius:var(--radius-full);box-sizing:border-box;
  background:var(--bg-inset);display:flex;align-items:center;justify-content:center;
  font-size:20px;font-weight:700;}
.sb-inputbox:focus-within{border-color:var(--accent);box-shadow:0 0 0 4px rgba(63,179,162,.20);}
.sb-inputbox.is-off{opacity:.5;}
.sb-typed{color:var(--text-main);white-space:nowrap;overflow:hidden;}
.sb-typed.is-ph{color:var(--text-muted);font-weight:600;font-size:15px;}
/* 글자·커서 모두 투명 — 상자 전체를 덮어 어디를 눌러도 포커스가 잡힌다 */
.sb-sink{position:absolute;inset:0;width:100%;height:100%;padding:0 20px;box-sizing:border-box;
  border:0;outline:none;background:transparent;font:inherit;text-align:center;
  color:transparent;caret-color:transparent;}

.sb-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:rgba(242,251,249,.82);border-radius:var(--radius-lg);}
/* hidden 속성은 UA 의 display:none 으로 동작하는데 위 display:flex 가 그걸 이긴다.
   그래서 카운트다운 숫자가 끝나도 화면에 남아 있었다. 명시적으로 꺼준다. */
.sb-overlay[hidden]{display:none;}
.sb-count{font-size:84px;font-weight:900;color:var(--accent);}

.sb-side{width:210px;flex:0 0 210px;display:flex;flex-direction:column;gap:6px;overflow:auto;}
.sb-side-title{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;
  color:var(--text-muted);padding:0 4px 2px;}
.sb-prow{background:var(--bg-card);border:1.5px solid var(--border-soft);border-radius:var(--radius-md);
  padding:7px 10px;display:flex;flex-direction:column;gap:5px;}
.sb-prow.sb-me{border-color:var(--yellow-200);background:var(--highlight-soft);}
.sb-pname{font-size:12.5px;font-weight:800;display:flex;align-items:center;gap:5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sb-rank{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;
  border-radius:50%;background:var(--bg-subtle);font-size:10.5px;flex:0 0 auto;}
/* 진행 바에도 작은 전동차를 얹어 누가 어디쯤인지 한눈에 */
.sb-bar{position:relative;height:9px;border-radius:5px;background:var(--border-soft);}
.sb-bar>span{display:block;height:100%;border-radius:5px;background:var(--accent);transition:width .3s;}
.sb-bar>em{position:absolute;top:-3px;width:14px;height:15px;border-radius:4px;
  background:var(--teal-500);transform:translateX(-50%);transition:left .3s;}
.sb-pfoot{display:flex;justify-content:space-between;font-size:10.5px;color:var(--text-muted);
  font-variant-numeric:tabular-nums;}
.sb-fin{color:var(--mint-500);font-weight:800;}
.sb-pmiss{opacity:.8;}

@media (max-width:820px){
  .sb-screen{flex-direction:column;}
  .sb-side{width:100%;flex:0 0 auto;flex-direction:row;flex-wrap:wrap;}
  .sb-prow{flex:1 1 150px;}
  .sb-side-title{width:100%;}
  .sb-sidest{display:none;}
}
`;
