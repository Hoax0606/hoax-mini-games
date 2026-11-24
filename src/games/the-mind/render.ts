/**
 * 더 마인드 렌더러 (HTML DOM — 라이어 게임/꼬들과 통일, 캔버스는 숨긴다)
 *
 * 화면이 말을 대신해야 하는 게임이라, 보여줄 걸 셋으로 줄였다.
 *   · 위  = 레벨 / 생명 / 수리검   — 얼마나 버틸 수 있나
 *   · 중앙 = 마지막에 나온 카드     — 지금 어디까지 왔나
 *   · 아래 = 내 카드               — 내가 할 수 있는 것
 *
 * 남의 카드는 숫자를 절대 안 그린다. 장수만 보여준다.
 */

import type { MindPlayer, NewsLine } from './rules';
import type { Phase } from './netSync';
import { escapeHtml } from '../../ui/escape';

export interface TmRenderState {
  phase: Phase;
  level: number;
  goal: number;
  lives: number;
  stars: number;
  players: MindPlayer[];
  myCards: number[];
  pile: number[];
  burned: number[];
  news: NewsLine;
  myPeerId: string;
  isSpectator: boolean;
  notice: string;
}

export interface TmCallbacks {
  onReady(): void;
  onPlay(card: number): void;
  onStar(on: boolean): void;
}

/** 생명 하나. currentColor 라서 pill 의 글자색을 그대로 따라간다 */
const HEART_SVG = '<svg class="tm-heart" viewBox="0 0 24 24" width="13" height="13" '
  + 'aria-hidden="true"><path fill="currentColor" d="M12 20.7S4 16 4 10.4A4.4 4.4 0 0 1 12 '
  + '7.8a4.4 4.4 0 0 1 8 2.6C20 16 12 20.7 12 20.7Z"/></svg>';

export class TheMindRenderer {
  private canvas: HTMLCanvasElement;
  private cb: TmCallbacks;
  private root: HTMLDivElement;
  private styleEl: HTMLStyleElement;

  private headEl: HTMLDivElement;
  private pileEl: HTMLDivElement;
  private othersEl: HTMLDivElement;
  private handEl: HTMLDivElement;
  private actionEl: HTMLDivElement;
  private newsEl: HTMLDivElement;
  private noticeEl: HTMLDivElement;

  private headKey = '';
  private pileKey = '';
  private othersKey = '';
  private handKey = '';
  private actionKey = '';
  private newsKey = '';

  constructor(canvas: HTMLCanvasElement, cb: TmCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    canvas.style.display = 'none';

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'tm-screen';
    // 상태(레벨·생명·남들)는 위에 모으고, 가운데는 숫자 하나만 남긴다
    this.root.innerHTML = `
      <div class="tm-head" id="tm-head"></div>
      <div class="tm-others" id="tm-others"></div>
      <div class="tm-pile" id="tm-pile"></div>
      <div class="tm-news" id="tm-news"></div>
      <div class="tm-notice" id="tm-notice" hidden></div>
      <div class="tm-hand" id="tm-hand"></div>
      <div class="tm-action" id="tm-action"></div>
    `;
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.root);
    }
    const q = <T extends HTMLElement>(id: string): T => this.root.querySelector<T>('#' + id)!;
    this.headEl = q('tm-head');
    this.pileEl = q('tm-pile');
    this.othersEl = q('tm-others');
    this.handEl = q('tm-hand');
    this.actionEl = q('tm-action');
    this.newsEl = q('tm-news');
    this.noticeEl = q('tm-notice');
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  render(s: TmRenderState): void {
    const cleared = s.phase === 'play' && s.players.length > 0
      && s.players.every((p) => p.left === 0);

    const headKey = `${s.level}|${s.goal}|${s.lives}|${s.stars}`;
    if (headKey !== this.headKey) { this.headKey = headKey; this.drawHead(s); }

    const pileKey = `${s.pile.join(',')}|${s.burned.join(',')}|${cleared}|${s.phase}|${s.level}`;
    if (pileKey !== this.pileKey) { this.pileKey = pileKey; this.drawPile(s, cleared); }

    const othersKey = s.players
      .map((p) => `${p.peerId}:${p.left}:${p.wantsStar}:${p.ready}`).join('|')
      + `|${s.phase}|${s.myPeerId}`;
    if (othersKey !== this.othersKey) { this.othersKey = othersKey; this.drawOthers(s); }

    const handKey = `${s.myCards.join(',')}|${s.phase}|${s.isSpectator}|${cleared}`;
    if (handKey !== this.handKey) { this.handKey = handKey; this.drawHand(s, cleared); }

    const me = s.players.find((p) => p.peerId === s.myPeerId) ?? null;
    const actionKey = `${s.phase}|${s.isSpectator}|${me?.ready ?? false}`
      + `|${me?.wantsStar ?? false}|${s.stars > 0}|${(me?.left ?? 0) > 0}|${cleared}`;
    if (actionKey !== this.actionKey) { this.actionKey = actionKey; this.drawAction(s, me, cleared); }

    const newsKey = `${s.news.text}|${s.news.bad}|${s.burned.join(',')}|${cleared}`;
    if (newsKey !== this.newsKey) { this.newsKey = newsKey; this.drawNews(s, cleared); }

    this.noticeEl.textContent = s.notice;
    this.noticeEl.hidden = !s.notice;
  }

  // ------------------------------------------------

  private drawHead(s: TmRenderState): void {
    const hearts = Array.from({ length: Math.max(0, s.lives) }, () => HEART_SVG).join('');
    this.headEl.innerHTML = `
      <span class="tm-pill">레벨 ${s.level} / ${s.goal}</span>
      <span class="tm-pill tm-pill-life">${hearts || '<span class="tm-none">없음</span>'}</span>
      <span class="tm-pill tm-pill-star">${
        s.stars > 0 ? `${'★'.repeat(s.stars)} 수리검` : '<span class="tm-none">수리검 없음</span>'
      }</span>`;
  }

  /** 중앙 — 마지막에 나온 카드가 주인공. 그 앞의 카드들은 뒤로 작게 깔린다 */
  private drawPile(s: TmRenderState, cleared: boolean): void {
    if (cleared) {
      this.pileEl.innerHTML = `<div class="tm-clear">레벨 ${s.level} 클리어!</div>`;
      return;
    }
    const top = s.pile[s.pile.length - 1];
    const prev = s.pile.slice(-4, -1);
    this.pileEl.innerHTML = `
      <div class="tm-prev">${prev.map((c) => `<span>${c}</span>`).join('')}</div>
      <div class="tm-top${top === undefined ? ' is-empty' : ''}">${
        top === undefined ? '—' : top
      }</div>`;
  }

  /**
   * 소식 한 줄 + 이번 레벨에 사라진 카드.
   * 사라진 카드를 계속 띄워두는 건, 영영 안 나올 숫자를 기다리지 말라는 뜻이다.
   */
  private drawNews(s: TmRenderState, cleared: boolean): void {
    const burned = s.burned.length === 0 ? ''
      : `<div class="tm-burned">버려진 카드 ${s.burned.join(' · ')}</div>`;
    // 클리어 순간엔 가운데에 큰 글씨가 이미 떠 있다 — 같은 말을 두 번 쓰지 않는다
    const line = cleared ? ''
      : `<div class="tm-news-line${s.news.bad ? ' is-bad' : ''}">${escapeHtml(s.news.text)}</div>`;
    this.newsEl.innerHTML = line + burned;
  }

  /** 남들 — 숫자는 절대 안 보여준다. 몇 장 남았는지만 */
  private drawOthers(s: TmRenderState): void {
    const others = s.players.filter((p) => p.peerId !== s.myPeerId);
    this.othersEl.innerHTML = others.length === 0
      ? '<div class="tm-empty">혼자서는 맞춰볼 상대가 없어요</div>'
      : others.map((p) => {
        const mark = s.phase === 'ready'
          ? (p.ready ? '<span class="tm-ok">준비</span>' : '<span class="tm-wait">대기</span>')
          : (p.wantsStar ? '<span class="tm-starred">★ 쓰자</span>' : `${p.left}장`);
        return `
          <div class="tm-who${p.left === 0 ? ' is-done' : ''}${
            p.wantsStar ? ' is-starred' : ''}">
            <span class="tm-who-name">${escapeHtml(p.nickname)}</span>
            <span class="tm-who-left">${mark}</span>
          </div>`;
      }).join('');
  }

  private drawHand(s: TmRenderState, cleared: boolean): void {
    if (s.isSpectator) {
      this.handEl.innerHTML = '<div class="tm-empty">관전 중 — 카드는 안 보여요</div>';
      return;
    }
    if (s.myCards.length === 0) {
      this.handEl.innerHTML = `<div class="tm-empty">${
        cleared ? '' : '내 카드를 다 냈어요 · 남은 사람을 기다려요'
      }</div>`;
      return;
    }
    const playable = s.phase === 'play' && !cleared;
    this.handEl.innerHTML = s.myCards.map((c) => `
      <button type="button" class="tm-card" data-c="${c}"${playable ? '' : ' disabled'}>${c}</button>
    `).join('');

    if (!playable) return;
    for (const b of this.handEl.querySelectorAll<HTMLButtonElement>('.tm-card')) {
      b.addEventListener('click', () => this.cb.onPlay(Number(b.dataset['c'])));
    }
  }

  private drawAction(s: TmRenderState, me: MindPlayer | null, cleared: boolean): void {
    if (s.isSpectator) {
      this.actionEl.innerHTML = '<p class="tm-hint">관전 중이에요</p>';
      return;
    }
    if (s.phase === 'done') {
      this.actionEl.innerHTML = '<p class="tm-hint">곧 결과가 나와요…</p>';
      return;
    }
    if (cleared) {
      this.actionEl.innerHTML = '<p class="tm-hint">다음 레벨 카드를 나누는 중…</p>';
      return;
    }
    if (s.phase === 'ready') {
      this.actionEl.innerHTML = me?.ready
        ? '<p class="tm-hint">다른 사람들을 기다리는 중…</p>'
        : `<p class="tm-hint">카드를 확인하고, 다 같이 시작해요</p>
           <button type="button" class="tm-btn" id="tm-ready">준비</button>`;
      this.actionEl.querySelector<HTMLButtonElement>('#tm-ready')
        ?.addEventListener('click', () => this.cb.onReady());
      return;
    }

    // 진행 중 — 수리검만 누를 수 있다. 카드는 위에서 직접 누른다
    if (s.stars <= 0 || (me?.left ?? 0) === 0) {
      this.actionEl.innerHTML = '<p class="tm-hint">작은 숫자부터 · 말은 금지</p>';
      return;
    }
    const on = me?.wantsStar === true;
    this.actionEl.innerHTML = `
      <p class="tm-hint">작은 숫자부터 · 말은 금지</p>
      <button type="button" class="tm-btn tm-btn-star${on ? ' is-on' : ''}" id="tm-star">${
        on ? '수리검 기다리는 중 (취소)' : '★ 수리검 쓰자'
      }</button>`;
    this.actionEl.querySelector<HTMLButtonElement>('#tm-star')
      ?.addEventListener('click', () => this.cb.onStar(!on));
  }
}

/* 색은 theme.css 변수를 쓴다 (하드코딩 금지 규약) */
const CSS = `
.tm-screen{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:safe center;gap:10px;padding:12px 14px;box-sizing:border-box;overflow:auto;
  font-family:var(--font-sans);color:var(--text-main);}

.tm-head{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;flex:0 0 auto;}
.tm-pill{font-size:11.5px;font-weight:800;padding:5px 13px;border-radius:var(--radius-full);
  background:var(--bg-subtle);color:var(--text-muted);display:inline-flex;align-items:center;gap:4px;}
.tm-pill-life{background:var(--danger-soft);color:var(--danger);}
.tm-pill-star{background:var(--highlight-soft);color:var(--highlight-ink);letter-spacing:1px;}
.tm-none{opacity:.7;letter-spacing:0;}
.tm-heart{display:block;margin-right:1px;}

/* 중앙 — 마지막 카드 */
.tm-pile{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:4px;
  min-height:84px;justify-content:center;}
.tm-prev{display:flex;gap:6px;height:15px;align-items:center;}
.tm-prev span{font-size:12px;font-weight:800;color:var(--text-muted);opacity:.55;}
.tm-top{font-size:clamp(40px, 9vh, 60px);font-weight:900;line-height:1;color:var(--accent);
  min-width:92px;text-align:center;}
.tm-top.is-empty{color:var(--border);}
.tm-clear{font-size:clamp(22px, 5vh, 30px);font-weight:900;color:var(--mint-500);}

.tm-others{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;max-width:620px;flex:0 0 auto;}
.tm-who{display:flex;align-items:center;gap:7px;background:var(--bg-card);
  border:1.5px solid var(--border-soft);border-radius:var(--radius-full);padding:4px 12px;}
.tm-who.is-done{border-color:var(--mint-300);background:var(--mint-100);}
.tm-who.is-starred{border-color:var(--highlight);background:var(--highlight-soft);}
.tm-who-name{font-size:12px;font-weight:800;max-width:110px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.tm-who-left{font-size:11px;font-weight:800;color:var(--text-muted);}
.tm-ok{color:var(--mint-500);}
.tm-wait{opacity:.75;}
.tm-starred{color:var(--highlight-ink);}
.tm-empty{font-size:12.5px;color:var(--text-muted);text-align:center;}

.tm-news{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:3px;
  max-width:460px;min-height:32px;justify-content:center;}
.tm-news-line{font-size:12.5px;font-weight:700;color:var(--text-muted);text-align:center;}
.tm-news-line.is-bad{color:var(--danger);}
.tm-burned{font-size:11px;font-weight:700;color:var(--text-muted);opacity:.8;text-align:center;}

/* 내 카드 — 누르면 낸다 */
.tm-hand{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;max-width:620px;
  min-height:54px;align-items:center;flex:0 0 auto;}
.tm-card{font:inherit;font-size:clamp(17px, 3.4vh, 22px);font-weight:900;color:var(--accent);
  background:var(--bg-card);border:2.5px solid var(--accent);border-radius:var(--radius-md);
  min-width:52px;padding:8px 10px;cursor:pointer;box-shadow:var(--shadow-sm);
  transition:transform .12s ease, box-shadow .12s ease;}
.tm-card:hover:not(:disabled){transform:translateY(-4px);box-shadow:var(--shadow-md);}
.tm-card:disabled{color:var(--text-muted);border-color:var(--border);cursor:default;opacity:.65;}

.tm-action{display:flex;flex-direction:column;align-items:center;gap:6px;flex:0 0 auto;}
.tm-hint{font-size:12.5px;color:var(--text-muted);margin:0;text-align:center;}
.tm-btn{font:inherit;font-weight:800;font-size:14px;color:#fff;background:var(--accent);
  border:none;border-radius:var(--radius-full);padding:9px 26px;cursor:pointer;}
.tm-btn:hover{background:var(--accent-hover);}
.tm-btn-star{background:var(--bg-card);color:var(--highlight-ink);
  border:1.5px solid var(--highlight);padding:7px 18px;font-size:13px;}
.tm-btn-star:hover{background:var(--highlight-soft);}
.tm-btn-star.is-on{background:var(--highlight);color:var(--highlight-ink);}

.tm-notice{font-size:12.5px;font-weight:700;color:var(--danger);text-align:center;flex:0 0 auto;}
.tm-notice[hidden]{display:none;}
`;
