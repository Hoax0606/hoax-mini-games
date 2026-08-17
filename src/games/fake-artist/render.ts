/**
 * 가짜 화가 렌더러.
 *
 * 캔버스 = 공유 그림판(전원 동일한 strokes 를 오프스크린 누적 레이어로 렌더 — draw-quiz 엔진 재사용).
 * 그 위에 HTML HUD 오버레이(pointer-events:none, 인터랙션 요소만 auto)로
 *   상단바(라운드/페이즈/타이머/도움말) · 우측(내 역할카드 + 플레이어 색/점수/차례) ·
 *   하단 액션(내 차례 안내 / 투표 버튼 / 추측 입력) · 결과 오버레이 를 얹는다.
 *
 * 하단 액션/결과는 key 가 바뀔 때만 다시 그린다(매 프레임 재생성 시 클릭/입력 포커스 소실 방지).
 */

import type { FakeArtistGame, StrokeData } from './rules';
import { currentDrawer, currentLap } from './rules';
import type { RolePayload } from './netSync';

const FA_W = 760;
const FA_H = 480;
/** 펜 굵기(논리 px) */
export const PEN_WIDTH = 5;

export interface FaRenderState {
  game: FakeArtistGame;
  myPeerId: string;
  isSpectator: boolean;
  /** 내 역할·제시어·색 (fa:role 수신). 관전자는 null */
  myRole: RolePayload | null;
  /** 그리는 중인 미완성 획 (본인 로컬 프리뷰) */
  liveStroke: StrokeData | null;
  remainMs: number;
  /** 내가 이번 라운드 투표했는지 */
  iVoted: boolean;
  /** 내가(마피아) 추측을 냈는지 */
  iGuessed: boolean;
  /** 결과 시 개별 투표 내역 */
  revealVotes: Record<string, string> | null;
}

export interface FaCallbacks {
  onVote(target: string): void;
  onGuess(word: string): void;
}

const CSS = `
.fa-hud{position:absolute;inset:0;pointer-events:none;z-index:3;
  font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif;color:#3a3550;}
.fa-hud *{box-sizing:border-box;}
.fa-hud [hidden]{display:none !important;}
.fa-top{position:absolute;top:10px;left:12px;right:12px;display:flex;align-items:center;gap:12px;}
.fa-phase{font-size:15px;font-weight:800;background:rgba(255,255,255,.82);padding:6px 12px;border-radius:999px;
  box-shadow:0 2px 8px rgba(90,110,160,.14);}
.fa-phase .r{color:#c95b8a;}
.fa-timer{margin-left:auto;font-size:18px;font-weight:900;color:#4d7cc4;font-variant-numeric:tabular-nums;
  background:rgba(255,255,255,.82);padding:4px 12px;border-radius:999px;box-shadow:0 2px 8px rgba(90,110,160,.14);}
.fa-timer.warn{color:#e0554d;}
.fa-help-btn{pointer-events:auto;flex:none;width:26px;height:26px;border-radius:50%;border:1px solid #cdd6e6;
  background:#fff;color:#4d7cc4;font-weight:900;font-size:14px;cursor:pointer;line-height:1;box-shadow:0 1px 3px rgba(90,110,160,.14);}
.fa-help-btn:hover{background:#eef4ff;}

.fa-side{position:absolute;top:52px;right:12px;width:186px;display:flex;flex-direction:column;gap:8px;}
.fa-role{border-radius:14px;padding:10px 12px;border:1.5px solid;background:#fff;box-shadow:0 3px 12px rgba(90,110,160,.16);}
.fa-role.fake{background:linear-gradient(150deg,#ffe6e6,#fff3f3);border-color:#f2b3ae;}
.fa-role.citizen{background:linear-gradient(150deg,#e6f5ec,#f4fbf7);border-color:#a9dbc0;}
.fa-role .rl{font-size:11px;font-weight:800;color:#8b81a0;}
.fa-role .wd{font-size:18px;font-weight:900;color:#3a3550;margin-top:2px;}
.fa-role .cat{font-size:11.5px;color:#6a6086;margin-top:3px;}
.fa-role .mychip{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin-left:6px;border:1px solid rgba(0,0,0,.2);}
.fa-players{display:flex;flex-direction:column;gap:5px;background:rgba(255,255,255,.82);border-radius:14px;padding:8px;
  box-shadow:0 2px 8px rgba(90,110,160,.12);max-height:calc(100% - 60px);overflow-y:auto;}
.fa-prow{display:flex;align-items:center;gap:7px;padding:4px 6px;border-radius:9px;font-size:12.5px;}
.fa-prow.turn{background:#fff3d6;box-shadow:inset 0 0 0 1.5px #e8c96a;}
.fa-prow.me{font-weight:800;}
.fa-prow.fake-reveal{background:#ffdad6;box-shadow:inset 0 0 0 1.5px #e0554d;}
.fa-prow .chip{width:14px;height:14px;border-radius:50%;flex:none;border:1px solid rgba(0,0,0,.2);}
.fa-prow .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fa-prow .sc{font-weight:800;color:#4d7cc4;font-variant-numeric:tabular-nums;}

.fa-action{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);pointer-events:none;
  display:flex;flex-direction:column;align-items:center;gap:8px;max-width:80%;}
.fa-hint{background:rgba(255,255,255,.9);border-radius:999px;padding:8px 18px;font-size:14px;font-weight:800;
  box-shadow:0 3px 12px rgba(90,110,160,.18);}
.fa-hint .c{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin:0 4px;border:1px solid rgba(0,0,0,.2);}
.fa-vote{pointer-events:auto;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;background:rgba(255,255,255,.9);
  border-radius:16px;padding:12px 14px;box-shadow:0 4px 16px rgba(90,110,160,.2);}
.fa-vote-title{width:100%;text-align:center;font-size:13px;font-weight:800;margin-bottom:2px;}
.fa-vbtn{border:1px solid #dbe3f0;background:#fff;color:#3a3550;border-radius:12px;padding:9px 14px;font:inherit;
  font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:7px;transition:background .12s,transform .08s;}
.fa-vbtn:hover:not(:disabled){background:#ffecec;border-color:#f0a09a;}
.fa-vbtn:active:not(:disabled){transform:scale(.96);}
.fa-vbtn.voted{border-color:#e0554d;background:#ffdad6;color:#c8443b;}
.fa-vbtn:disabled{opacity:.5;cursor:default;}
.fa-vbtn .chip{width:12px;height:12px;border-radius:50%;border:1px solid rgba(0,0,0,.2);}
.fa-guess{pointer-events:auto;display:flex;gap:8px;background:rgba(255,255,255,.92);border-radius:14px;padding:10px 12px;
  box-shadow:0 4px 16px rgba(90,110,160,.2);}
.fa-guess input{border:1px solid #dbe3f0;border-radius:10px;padding:9px 12px;font:inherit;font-size:14px;outline:none;width:180px;}
.fa-guess input:focus{border-color:#a9c4ef;}
.fa-guess button{border:none;border-radius:10px;padding:0 16px;font:inherit;font-weight:800;background:#e0554d;color:#fff;cursor:pointer;}

/* 결과 오버레이 */
.fa-result{position:absolute;inset:0;pointer-events:auto;background:rgba(244,247,255,.9);backdrop-filter:blur(6px);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;z-index:4;}
.fa-banner{font-size:24px;font-weight:900;padding:8px 24px;border-radius:16px;}
.fa-banner.citizen{background:linear-gradient(135deg,#dcebff,#eef5ff);color:#2f6aa8;border:1px solid #aecbe8;}
.fa-banner.fake{background:linear-gradient(135deg,#ffdedb,#fff0ef);color:#c8443b;border:1px solid #f2b3ae;}
.fa-result .who{font-size:16px;font-weight:800;}
.fa-result .ans{font-size:14px;color:#3a3550;background:#fff;border:1px solid #e6ebf5;border-radius:10px;padding:6px 14px;}
.fa-result .out{font-size:14px;font-weight:700;color:#5a5070;text-align:center;line-height:1.5;}
.fa-result .foot{font-size:12px;color:#8b81a0;margin-top:4px;}

/* 도움말 */
.fa-help{position:absolute;inset:0;pointer-events:auto;background:rgba(255,255,255,.98);z-index:6;overflow-y:auto;padding:22px;}
.fa-help h3{margin:0 0 8px;font-size:19px;font-weight:900;}
.fa-help ol{margin:0;padding-left:20px;font-size:13px;line-height:1.7;}
.fa-help .win{background:#eef4ff;border:1px solid #dbe3f0;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.6;color:#5a5070;margin-top:10px;}
.fa-help-close{margin:18px auto 0;display:block;border:1px solid #dbe3f0;background:#fff;border-radius:999px;padding:10px 22px;font:inherit;font-weight:800;cursor:pointer;}
`;

export class FakeArtistRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private cb: FaCallbacks;
  private styleEl: HTMLStyleElement;
  private hud: HTMLDivElement;

  private scale = 1; private offX = 0; private offY = 0;
  // 오프스크린 누적 레이어
  private layer: HTMLCanvasElement | null = null;
  private layerCtx: CanvasRenderingContext2D | null = null;
  private committedCount = 0;
  private lastStrokesRef: StrokeData[] | null = null;

  // HUD 캐시 키
  private actionKey = '';
  private resultKey = '';

  screenToLogical(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.offX) / this.scale, y: (py - this.offY) / this.scale };
  }
  /** 논리→화면 배율. 브러시 커서를 실제 획 굵기와 맞추는 데 씀 */
  getScale(): number { return this.scale; }
  /** 논리 좌표가 그림판 안인지 */
  isInPaper(x: number, y: number): boolean {
    return x >= 0 && x <= FA_W && y >= 0 && y <= FA_H;
  }

  constructor(canvas: HTMLCanvasElement, cb: FaCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 컨텍스트를 가져올 수 없어요');
    this.ctx = ctx;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.hud = document.createElement('div');
    this.hud.className = 'fa-hud';
    this.hud.innerHTML = `
      <div class="fa-top">
        <span class="fa-phase" id="fa-phase"></span>
        <span class="fa-timer" id="fa-timer" hidden></span>
        <button class="fa-help-btn" id="fa-help" title="도움말">?</button>
      </div>
      <div class="fa-side">
        <div class="fa-role" id="fa-role" hidden></div>
        <div class="fa-players" id="fa-players"></div>
      </div>
      <div class="fa-action" id="fa-action"></div>
      <div class="fa-result" id="fa-result" hidden></div>
      <div class="fa-help" id="fa-help-panel" hidden></div>
    `;
    // 캔버스 부모를 relative 로 만들어 오버레이 위치 기준 확보
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.hud);
    }
    this.hud.querySelector<HTMLButtonElement>('#fa-help')!.addEventListener('click', () => this.showHelp());
  }

  destroy(): void {
    this.ro.disconnect();
    this.hud.remove();
    this.styleEl.remove();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
  }

  // ============================================
  // 메인 렌더
  // ============================================
  render(rs: FaRenderState): void {
    this.drawCanvas(rs);
    this.renderTop(rs);
    this.renderRole(rs);
    this.renderPlayers(rs);
    const resultEl = this.hud.querySelector<HTMLDivElement>('#fa-result')!;
    if (rs.game.phase === 'result' || rs.game.phase === 'ended') {
      resultEl.hidden = false;
      this.renderResult(rs);
      this.hud.querySelector<HTMLDivElement>('#fa-action')!.innerHTML = '';
      this.actionKey = '';
    } else {
      resultEl.hidden = true;
      this.resultKey = '';
      this.renderAction(rs);
    }
  }

  private drawCanvas(rs: FaRenderState): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const scale = Math.min(rect.width / FA_W, rect.height / FA_H);
    this.scale = scale;
    this.offX = (rect.width - FA_W * scale) / 2;
    this.offY = (rect.height - FA_H * scale) / 2;
    ctx.fillStyle = '#eef2f8';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, this.offX * dpr, this.offY * dpr);

    // 흰 도화지
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, FA_W, FA_H);

    // 확정 획 = 누적 레이어 blit + live 프리뷰 (clip 으로 넘침 방지)
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, FA_W, FA_H); ctx.clip();
    this.syncLayer(rs.game.strokes);
    if (this.layer) ctx.drawImage(this.layer, 0, 0);
    if (rs.liveStroke) this.drawStroke(ctx, rs.liveStroke);
    ctx.restore();

    // 테두리
    ctx.strokeStyle = '#d9c7ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, FA_W - 2, FA_H - 2);
  }

  // ---- 오프스크린 누적 레이어 (draw-quiz 방식, 펜 전용) ----
  private ensureLayer(): void {
    if (this.layer) return;
    const c = document.createElement('canvas');
    c.width = FA_W; c.height = FA_H;
    this.layer = c;
    this.layerCtx = c.getContext('2d');
  }
  private syncLayer(strokes: StrokeData[]): void {
    this.ensureLayer();
    const lc = this.layerCtx;
    if (!lc) return;
    if (strokes !== this.lastStrokesRef || strokes.length < this.committedCount) {
      lc.clearRect(0, 0, FA_W, FA_H);
      this.committedCount = 0;
      for (const s of strokes) this.drawStroke(lc, s);
      this.committedCount = strokes.length;
      this.lastStrokesRef = strokes;
    } else if (strokes.length > this.committedCount) {
      for (let i = this.committedCount; i < strokes.length; i++) this.drawStroke(lc, strokes[i]!);
      this.committedCount = strokes.length;
    }
  }
  private drawStroke(ctx: CanvasRenderingContext2D, s: StrokeData): void {
    if (s.points.length === 0) return;
    ctx.save();
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
    ctx.lineWidth = s.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    const p0 = s.points[0]!;
    ctx.moveTo(p0.x, p0.y);
    if (s.points.length === 1) ctx.lineTo(p0.x + 0.1, p0.y + 0.1);
    else for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i]!.x, s.points[i]!.y);
    ctx.stroke();
    ctx.restore();
  }

  // ============================================
  // HUD
  // ============================================
  private renderTop(rs: FaRenderState): void {
    const g = rs.game;
    let label = '';
    if (g.phase === 'draw') label = `<span class="r">그리기</span> · ${currentLap(g)}/${g.laps}바퀴`;
    else if (g.phase === 'vote') label = '투표 · 가짜 화가를 지목';
    else if (g.phase === 'guess') label = '가짜 화가의 제시어 추측';
    this.hud.querySelector('#fa-phase')!.innerHTML = `라운드 ${g.round}/${g.totalRounds} · ${label}`;

    const timer = this.hud.querySelector<HTMLSpanElement>('#fa-timer')!;
    const secs = rs.remainMs > 0 ? Math.ceil(rs.remainMs / 1000) : 0;
    if (secs > 0 && (g.phase === 'draw' || g.phase === 'vote' || g.phase === 'guess')) {
      timer.hidden = false;
      timer.textContent = `${secs}s`;
      timer.classList.toggle('warn', secs <= 10);
    } else timer.hidden = true;
  }

  private renderRole(rs: FaRenderState): void {
    const el = this.hud.querySelector<HTMLDivElement>('#fa-role')!;
    if (rs.isSpectator || !rs.myRole) { el.hidden = true; return; }
    el.hidden = false;
    const r = rs.myRole;
    const chip = `<span class="mychip" style="background:${r.color}"></span>`;
    if (r.role === 'fake') {
      el.className = 'fa-role fake';
      el.innerHTML = `<div class="rl">내 역할${chip}</div><div class="wd">가짜 화가</div>` +
        `<div class="cat">제시어를 몰라요! 주제 <b>${esc(r.category)}</b> 만 보고 아는 척하세요.</div>`;
    } else {
      el.className = 'fa-role citizen';
      el.innerHTML = `<div class="rl">제시어${chip}</div><div class="wd">${esc(r.word)}</div>` +
        `<div class="cat">주제 · ${esc(r.category)}</div>`;
    }
  }

  private renderPlayers(rs: FaRenderState): void {
    const g = rs.game;
    const drawer = g.phase === 'draw' ? currentDrawer(g) : undefined;
    this.hud.querySelector('#fa-players')!.innerHTML = g.players.map((p) => {
      const me = p.peerId === rs.myPeerId;
      const isTurn = p.peerId === drawer;
      const fakeReveal = (g.phase === 'result' || g.phase === 'ended') && p.peerId === g.revealedFakePeerId;
      const score = g.scores[p.peerId] ?? 0;
      return `<div class="fa-prow ${me ? 'me' : ''} ${isTurn ? 'turn' : ''} ${fakeReveal ? 'fake-reveal' : ''}">` +
        `<span class="chip" style="background:${g.colors[p.peerId] ?? '#999'}"></span>` +
        `<span class="nm">${esc(p.nickname)}${me ? ' (나)' : ''}</span>` +
        `<span class="sc">${score}</span></div>`;
    }).join('');
  }

  private renderAction(rs: FaRenderState): void {
    const g = rs.game;
    const el = this.hud.querySelector<HTMLDivElement>('#fa-action')!;
    const drawer = g.phase === 'draw' ? currentDrawer(g) : undefined;
    const amFake = rs.myRole?.role === 'fake';
    // 재빌드 키 — 바뀔 때만 (투표/입력 포커스 보존)
    const key = g.phase === 'draw' ? `draw:${drawer}:${drawer === rs.myPeerId}`
      : g.phase === 'vote' ? `vote:${rs.iVoted}`
      : g.phase === 'guess' ? `guess:${amFake}:${rs.iGuessed}`
      : g.phase;
    if (key === this.actionKey) return;
    this.actionKey = key;

    if (rs.isSpectator) {
      el.innerHTML = g.phase === 'draw' ? `<div class="fa-hint">관전 중 · 그림을 지켜봐요</div>` : '';
      return;
    }

    if (g.phase === 'draw') {
      if (drawer === rs.myPeerId) {
        const chip = rs.myRole ? `<span class="c" style="background:${rs.myRole.color}"></span>` : '';
        el.innerHTML = `<div class="fa-hint">내 차례! ${chip} 한 획 그려요</div>`;
      } else {
        const nick = g.players.find((p) => p.peerId === drawer)?.nickname ?? '?';
        const chip = `<span class="c" style="background:${g.colors[drawer ?? ''] ?? '#999'}"></span>`;
        el.innerHTML = `<div class="fa-hint">${chip} ${esc(nick)} 차례</div>`;
      }
      return;
    }

    if (g.phase === 'vote') {
      if (rs.iVoted) { el.innerHTML = `<div class="fa-hint">투표 완료! 다른 사람들을 기다려요</div>`; return; }
      const btns = g.players.filter((p) => p.peerId !== rs.myPeerId).map((p) =>
        `<button class="fa-vbtn" data-v="${p.peerId}"><span class="chip" style="background:${g.colors[p.peerId] ?? '#999'}"></span>${esc(p.nickname)}</button>`).join('');
      el.innerHTML = `<div class="fa-vote"><div class="fa-vote-title">가짜 화가는 누구?</div>${btns}</div>`;
      el.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((b) => b.addEventListener('click', () => {
        el.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((x) => { x.disabled = true; });
        b.classList.add('voted');
        this.cb.onVote(b.dataset.v!);
      }));
      return;
    }

    if (g.phase === 'guess') {
      if (!amFake) { el.innerHTML = `<div class="fa-hint">가짜 화가가 제시어를 추측하는 중…</div>`; return; }
      if (rs.iGuessed) { el.innerHTML = `<div class="fa-hint">추측 제출! 결과를 기다려요</div>`; return; }
      el.innerHTML = `<form class="fa-guess" id="fa-gf" autocomplete="off">` +
        `<input id="fa-gi" maxlength="16" placeholder="제시어를 맞혀보세요!" />` +
        `<button type="submit">제출</button></form>`;
      el.querySelector<HTMLFormElement>('#fa-gf')!.addEventListener('submit', (e) => {
        e.preventDefault();
        const inp = el.querySelector<HTMLInputElement>('#fa-gi')!;
        const t = inp.value.trim();
        if (!t) return;
        this.cb.onGuess(t);
      });
      return;
    }
    el.innerHTML = '';
  }

  private renderResult(rs: FaRenderState): void {
    const g = rs.game;
    const key = `${g.round}:${g.revealedFakePeerId}:${g.fakeWon}:${g.fakeGuess ?? ''}`;
    if (key === this.resultKey) return;
    this.resultKey = key;
    const el = this.hud.querySelector<HTMLDivElement>('#fa-result')!;
    const nick = (pid: string | null): string => g.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    const fakeWon = g.fakeWon === true;
    const banner = fakeWon ? '🎭 가짜 화가 승리!' : '🖼️ 시민 승리!';
    let out = '';
    if (fakeWon && g.fakeGuess) out = `가짜 화가가 제시어를 맞혔어요! ("${esc(g.fakeGuess)}") — 역전승`;
    else if (fakeWon) out = '가짜 화가가 들키지 않았어요';
    else if (g.fakeGuess) out = `가짜 화가를 잡았어요! (추측 "${esc(g.fakeGuess)}" 오답)`;
    else out = '가짜 화가를 정확히 지목했어요';
    const last = g.round >= g.totalRounds || g.phase === 'ended';
    el.innerHTML =
      `<div class="fa-banner ${fakeWon ? 'fake' : 'citizen'}">${banner}</div>` +
      `<div class="who">가짜 화가는 <b>${esc(nick(g.revealedFakePeerId))}</b> 였어요</div>` +
      `<div class="ans">정답 제시어 · <b>${esc(g.revealedWord ?? '')}</b></div>` +
      `<div class="out">${out}</div>` +
      `<div class="foot">${last ? '최종 결과로…' : '다음 라운드 준비 중…'}</div>`;
  }

  private showHelp(): void {
    const el = this.hud.querySelector<HTMLDivElement>('#fa-help-panel')!;
    el.innerHTML = `<h3>🎭 가짜 화가 게임 방법</h3>
      <ol>
        <li>한 명이 <b>가짜 화가</b>(제시어를 모름). 나머지는 같은 제시어를 알아요. 주제는 전원 공개.</li>
        <li>순서대로 <b>각자 정해진 색</b>으로 캔버스에 <b>한 획씩</b> 이어 그려요 (제시어에 대해). 두 바퀴.</li>
        <li>가짜 화가는 모른 채 자연스럽게 그려서 섞여야 해요.</li>
        <li>다 그리면 <b>가짜 화가가 누군지 투표</b>해요.</li>
        <li>잡히면 시민 승 — 단 가짜 화가가 <b>제시어를 맞히면 역전승!</b> 못 잡으면 가짜 화가 승.</li>
      </ol>
      <div class="win">점수: 가짜 화가 승 → 가짜 화가 +2 / 시민 승 → 가짜를 지목한 시민 각 +1. 5라운드 누적 최고점 승.</div>
      <button class="fa-help-close" id="fa-help-close">닫기</button>`;
    el.querySelector<HTMLButtonElement>('#fa-help-close')!.addEventListener('click', () => { el.hidden = true; });
    el.hidden = false;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
