/**
 * 라이어 게임 렌더러 (HTML DOM 기반 — 끝말잇기/그림퀴즈와 통일).
 *
 * 레이아웃: [좌: 플레이어 세로 리스트] [우: 상단 필 → 역할 카드 → 힌트 채팅 피드]
 *   입력 컨트롤(힌트/투표/추측)은 index.ts 의 .lg-panel 이 이 화면 아래에 붙는다.
 *   result 페이즈면 lg-screen 위에 결과 오버레이.
 *
 * 캔버스는 쓰지 않는다(텍스트/소셜 게임) — 생성자에서 숨기고 HTML 오버레이를 부모에 마운트.
 */

import type { LiarGame } from './rules';
import type { RolePayload } from './netSync';
import { icon } from '../../ui/icons';

export interface RenderState {
  game: LiarGame;
  myPeerId: string;
  isSpectator: boolean;
  myRole: RolePayload | null;
  revealVotes: Record<string, string> | null;
  remainMs: number;
  now: number;
}

export interface LiarRendererArgs {
  canvas: HTMLCanvasElement;
}

export class LiarRenderer {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;

  private playersEl: HTMLDivElement;
  private roundEl: HTMLSpanElement;
  private phaseTextEl: HTMLSpanElement;
  private timerEl: HTMLSpanElement;
  private topicEl: HTMLSpanElement;
  private roleEl: HTMLDivElement;
  private feedEl: HTMLDivElement;
  private resultEl: HTMLDivElement;

  /** 피드에 이미 그린 힌트 수 — 증분 append + 자동 스크롤용(전체 재렌더 시 스크롤 튐 방지) */
  private renderedHints = 0;

  constructor(args: LiarRendererArgs) {
    this.canvas = args.canvas;
    // 캔버스는 안 씀 — 숨기고 HTML 오버레이를 부모에 붙인다.
    this.canvas.style.display = 'none';
    const parent = this.canvas.parentElement;

    const root = document.createElement('div');
    root.className = 'lg-screen';
    root.innerHTML = `
      <div class="lg-players" id="lg-players"></div>
      <div class="lg-main">
        <div class="lg-topbar">
          <span class="lg-round" id="lg-round"></span>
          <span class="lg-phase"><span id="lg-phasetext"></span><span class="lg-timer" id="lg-timer"></span></span>
          <span class="lg-topic" id="lg-topic"></span>
        </div>
        <div class="lg-role" id="lg-role" hidden></div>
        <div class="lg-feed" id="lg-feed"></div>
      </div>
      <div class="lg-result" id="lg-result" hidden></div>
    `;
    // 컨트롤 패널(.lg-panel)보다 먼저 오도록 부모 맨 앞에 삽입
    parent?.insertBefore(root, this.canvas.nextSibling);
    this.root = root;

    this.playersEl = root.querySelector('#lg-players')!;
    this.roundEl = root.querySelector('#lg-round')!;
    this.phaseTextEl = root.querySelector('#lg-phasetext')!;
    this.timerEl = root.querySelector('#lg-timer')!;
    this.topicEl = root.querySelector('#lg-topic')!;
    this.roleEl = root.querySelector('#lg-role')!;
    this.feedEl = root.querySelector('#lg-feed')!;
    this.resultEl = root.querySelector('#lg-result')!;
  }

  destroy(): void {
    this.root.remove();
    this.canvas.style.display = '';
  }

  render(state: RenderState): void {
    const g = state.game;

    // ---- 상단 필 ----
    this.roundEl.innerHTML = `라운드 <b>${g.round}</b> / ${g.totalRounds}`;
    this.phaseTextEl.textContent = this.phaseText(state);
    const secs = state.remainMs > 0 ? Math.ceil(state.remainMs / 1000) : 0;
    if (secs > 0) {
      this.timerEl.hidden = false;
      this.timerEl.innerHTML = `${icon('clock', { size: 14 })}${secs}`;
      this.timerEl.classList.toggle('warn', secs <= 10);
    } else {
      this.timerEl.hidden = true;
    }
    this.topicEl.hidden = !g.category;
    if (g.category) this.topicEl.textContent = `주제 · ${g.category}`;

    // ---- 역할 카드 (관전자/미배정 제외) ----
    if (!state.isSpectator && state.myRole) {
      this.roleEl.hidden = false;
      const isLiar = state.myRole.role === 'liar';
      this.roleEl.className = `lg-role ${isLiar ? 'liar' : 'citizen'}`;
      if (isLiar) {
        this.roleEl.innerHTML =
          `당신은 <b>라이어</b>예요<span class="lg-role-sub">제시어를 몰라요 — 들키지 않게 자연스럽게!</span>`;
      } else {
        this.roleEl.innerHTML =
          `제시어 · <b class="lg-role-word">${escapeHtml(state.myRole.word)}</b><span class="lg-role-sub">라이어가 누군지 설명으로 찾아내세요</span>`;
      }
    } else {
      this.roleEl.hidden = true;
    }

    // ---- 플레이어 세로 리스트 ----
    this.renderPlayers(state);

    // ---- 힌트 채팅 피드 ----
    this.renderFeed(state);

    // ---- 결과 오버레이 ----
    if (g.phase === 'result') this.renderResult(state);
    else this.resultEl.hidden = true;
  }

  private renderPlayers(state: RenderState): void {
    const g = state.game;
    const revealed = g.phase === 'result' ? g.revealedLiarPeerId : null;
    const html = g.players.map((p) => {
      const isMe = p.peerId === state.myPeerId;
      const isTurn = g.phase === 'hint' && g.order[g.hintIndex] === p.peerId;
      const isLiar = revealed && p.peerId === revealed;
      const cls = ['lg-prow', isTurn ? 'turn' : '', isLiar ? 'liar' : ''].filter(Boolean).join(' ');
      const score = g.scores[p.peerId] ?? 0;
      return `<div class="${cls}"><span class="lg-pdot"></span>` +
        `<span class="lg-pnm">${escapeHtml(p.nickname)}${isMe ? ' (나)' : ''}</span>` +
        `<span class="lg-psc">${score}</span></div>`;
    }).join('');
    // players 는 매 프레임 갱신해도 스크롤/포커스 이슈 없음(고정 높이 카드)
    this.playersEl.innerHTML = html;
  }

  private renderFeed(state: RenderState): void {
    const g = state.game;
    const n = g.hints.length;
    // 라운드 리셋(힌트 줄어듦) → 피드 비우고 다시
    if (n < this.renderedHints) {
      this.feedEl.innerHTML = '';
      this.renderedHints = 0;
    }
    // 빈 피드 안내
    if (n === 0) {
      if (this.renderedHints !== 0) { this.feedEl.innerHTML = ''; this.renderedHints = 0; }
      if (!this.feedEl.querySelector('.lg-feed-empty')) {
        this.feedEl.innerHTML = g.phase === 'hint'
          ? `<div class="lg-feed-empty">첫 설명을 기다리는 중</div>` : '';
      }
      return;
    }
    // 안내문 제거 후 새 힌트만 append
    const empty = this.feedEl.querySelector('.lg-feed-empty');
    if (empty) { empty.remove(); this.renderedHints = 0; this.feedEl.innerHTML = ''; }
    for (let i = this.renderedHints; i < n; i++) {
      const h = g.hints[i]!;
      const mine = h.peerId === state.myPeerId;
      const row = document.createElement('div');
      row.className = `lg-hint${mine ? ' mine' : ''}`;
      row.innerHTML = `<span class="lg-hint-who">${escapeHtml(h.nickname)}${mine ? ' (나)' : ''}</span>` +
        `<span class="lg-hint-txt">${escapeHtml(h.text)}</span>`;
      this.feedEl.appendChild(row);
    }
    if (n > this.renderedHints) {
      this.renderedHints = n;
      this.feedEl.scrollTop = this.feedEl.scrollHeight; // 최신으로 자동 스크롤
    }
  }

  private renderResult(state: RenderState): void {
    const g = state.game;
    const nick = (pid: string | null): string =>
      g.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    let outcome = '';
    if (g.liarWon === true) {
      outcome = g.liarGuess ? '라이어 역전승! (제시어 맞힘)' : '라이어 승리! (안 들킴)';
    } else if (g.liarWon === false) {
      outcome = g.liarGuess ? `시민 승리! (라이어 추측 "${g.liarGuess}" 오답)` : '시민 승리! 라이어를 잡았어요';
    }
    const next = g.round >= g.totalRounds ? '최종 결과로' : '다음 라운드 준비 중';
    this.resultEl.hidden = false;
    this.resultEl.innerHTML = `
      <div class="lg-result-card">
        <div class="lg-result-liar">라이어는 <b>${escapeHtml(nick(g.revealedLiarPeerId))}</b> 였어요!</div>
        ${g.revealedWord ? `<div class="lg-result-word">정답 제시어 · <b>${escapeHtml(g.revealedWord)}</b></div>` : ''}
        <div class="lg-result-outcome ${g.liarWon ? 'liar' : 'citizen'}">${escapeHtml(outcome)}</div>
        <div class="lg-result-next">${next}</div>
      </div>`;
  }

  private phaseText(state: RenderState): string {
    const g = state.game;
    const nick = (pid: string): string => g.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    switch (g.phase) {
      case 'hint': {
        const cur = g.order[g.hintIndex];
        const mine = cur === state.myPeerId && !state.isSpectator;
        const who = mine ? '내 차례!' : `${nick(cur ?? '')} 차례`;
        return `설명 ${g.hintPass}/${g.totalPasses}바퀴 · ${who}`;
      }
      case 'vote':
        return '라이어를 지목하세요';
      case 'guess': {
        const acc = g.accusedPeerId ? nick(g.accusedPeerId) : '?';
        return `${acc} 지목! 라이어 추측 중`;
      }
      case 'result':
        return '라운드 결과';
      default:
        return '';
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
