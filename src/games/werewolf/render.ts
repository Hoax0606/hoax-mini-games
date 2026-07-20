/**
 * 한밤의 늑대인간 렌더러 (HTML DOM — 캔버스 미사용, 라이어게임과 동일 방식).
 *
 * 밤 분위기의 다크 테마를 self-contained <style> 로 주입한다 (앱 기본 파스텔과 분리 — 몰입용).
 *
 * 구조:
 *   .ww-root
 *     .ww-top      상단바 (페이즈 / 타이머 / 밤 진행바)
 *     .ww-grid
 *       .ww-left   플레이어 목록 + 내 역할 카드 + 밤 메모
 *       .ww-stage  페이즈별 인터랙티브 영역 (deal 카드 / 밤 행동 / 낮 채팅 / 투표)
 *     .ww-result   결과 오버레이 (result 페이즈)
 *
 * 매 프레임 호출되지만, 인터랙티브 영역(.ww-stage)은 stageKey 가 바뀔 때만 다시 그린다
 * (매 프레임 innerHTML 교체하면 버튼 클릭/채팅 입력 포커스가 날아가므로).
 */

import type { PublicState, Role } from './rules';
import { ROLE_META, teamOf, nightStepsForSetup, setupFor } from './rules';
import type { NightAction, NightInfo } from './netSync';

export interface WwRenderState {
  state: PublicState;
  myPeerId: string;
  isSpectator: boolean;
  /** 내가 처음 받은 역할 (ww:role 로 수신). 밤 행동 자격 판정에 사용 */
  myOrigRole: Role | null;
  /** 내가 밤에 본 것들 (누적) */
  memos: NightInfo[];
  /** 남은 시간(ms). 0이면 타이머 숨김 */
  remainMs: number;
  /** deal 페이즈: 내 카드 확인 완료 여부 */
  confirmedDeal: boolean;
  /** 밤: 내 이번 스텝 행동 제출 완료 여부 */
  actedNight: boolean;
  /** 투표 완료 여부 */
  voted: boolean;
}

export interface WwCallbacks {
  onReady(): void;
  onNightAct(action: NightAction): void;
  onChat(text: string): void;
  onVote(target: string): void;
}

// ── 역할 아이콘 (인라인 SVG — 목업과 동일 톤) ──
const ROLE_SVG: Record<Role, string> = {
  wolf: `<svg viewBox="0 0 32 32"><path d="M6 8 L11 15 L6 15 Z M26 8 L21 15 L26 15 Z M8 13 Q16 6 24 13 L24 20 Q16 27 8 20 Z" fill="#f0564e"/><circle cx="13" cy="17" r="1.5" fill="#12142a"/><circle cx="19" cy="17" r="1.5" fill="#12142a"/><path d="M15 21 h2 l-1 2 z" fill="#12142a"/></svg>`,
  seer: `<svg viewBox="0 0 32 32"><ellipse cx="16" cy="16" rx="13" ry="8" fill="none" stroke="#8fc2f0" stroke-width="2"/><circle cx="16" cy="16" r="4" fill="#8fc2f0"/></svg>`,
  robber: `<svg viewBox="0 0 32 32"><path d="M7 13 h14 l-4 -4 M25 19 h-14 l4 4" fill="none" stroke="#f5c96a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  troublemaker: `<svg viewBox="0 0 32 32"><circle cx="10" cy="16" r="6" fill="none" stroke="#c58fef" stroke-width="2.4"/><circle cx="22" cy="16" r="6" fill="none" stroke="#c58fef" stroke-width="2.4"/><path d="M10 10 Q16 4 22 10 M10 22 Q16 28 22 22" stroke="#c58fef" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
  drunk: `<svg viewBox="0 0 32 32"><path d="M9 10 h14 v6 a7 7 0 0 1 -14 0 z" fill="#f5c96a"/><path d="M23 12 h3 a3 3 0 0 1 0 6 h-3" fill="none" stroke="#f5c96a" stroke-width="2"/><rect x="11" y="24" width="10" height="3" rx="1.5" fill="#f5c96a"/></svg>`,
  insomniac: `<svg viewBox="0 0 32 32"><ellipse cx="18" cy="13" rx="8" ry="5" fill="none" stroke="#8fc2f0" stroke-width="1.8"/><circle cx="18" cy="13" r="2.5" fill="#8fc2f0"/><text x="6" y="27" font-size="11" font-weight="900" fill="#8fc2f0">z</text><text x="12" y="24" font-size="8" font-weight="900" fill="#8fc2f0">z</text></svg>`,
  villager: `<svg viewBox="0 0 32 32"><circle cx="16" cy="12" r="5" fill="#9fc5f5"/><path d="M7 26 a9 9 0 0 1 18 0 z" fill="#9fc5f5"/></svg>`,
};

const CSS = `
.ww-root{position:relative;width:100%;flex:1 1 auto;min-height:0;
  display:flex;flex-direction:column;gap:10px;padding:14px;
  background:linear-gradient(155deg,#fff2f8 0%,#eef4ff 52%,#e9fff6 100%);
  color:#43384f;font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif;
  border-radius:var(--radius-md,16px);overflow:hidden;box-sizing:border-box;}
.ww-root *{box-sizing:border-box;}
.ww-top{display:flex;align-items:center;gap:12px;flex:none;}
.ww-phase{font-size:17px;font-weight:800;letter-spacing:-.01em;color:#43384f;}
.ww-phase .r{color:#7b61c9;}
.ww-timer{margin-left:auto;font-size:20px;font-weight:900;color:#e0679b;font-variant-numeric:tabular-nums;letter-spacing:1px;}
.ww-timer.warn{color:#e0554d;}
.ww-steps{display:flex;gap:5px;align-items:center;flex-wrap:wrap;}
.ww-steps .st{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:#fff;border:1px solid #e6dcf4;opacity:.45;box-shadow:0 1px 3px rgba(120,90,160,.12);}
.ww-steps .st svg{width:15px;height:15px;}
.ww-steps .st.done{opacity:.8;}
.ww-steps .st.now{opacity:1;border-color:#c9a9ef;background:#f3ecff;box-shadow:0 0 0 3px rgba(155,122,235,.18);}

.ww-grid{flex:1;display:grid;grid-template-columns:210px 1fr;gap:12px;min-height:0;}
.ww-left{display:flex;flex-direction:column;gap:10px;min-height:0;}
.ww-players{display:flex;flex-direction:column;gap:6px;overflow-y:auto;}
.ww-prow{display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:12px;
  background:rgba(255,255,255,.8);border:1px solid #e6dcf4;font-size:13px;
  box-shadow:0 1px 3px rgba(120,90,160,.1);}
.ww-prow.me{border-color:#ffb3d0;background:#fff0f6;}
.ww-prow .dot{width:8px;height:8px;border-radius:50%;background:#c3b6da;flex:none;}
.ww-prow.me .dot{background:#ff6ba0;}
.ww-prow .nm{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

.ww-mycard{border-radius:16px;padding:12px;border:1.5px solid;display:flex;gap:10px;align-items:center;flex:none;
  box-shadow:0 4px 14px rgba(120,90,160,.14);}
.ww-mycard.wolf{background:linear-gradient(150deg,#ffe6e6,#fff3f3);border-color:#f2b3ae;}
.ww-mycard.village{background:linear-gradient(150deg,#e3efff,#f3f8ff);border-color:#aecbe8;}
.ww-mycard .ic{width:34px;height:34px;flex:none;}
.ww-mycard .nm{font-size:15px;font-weight:800;color:#43384f;}
.ww-mycard .tm{font-size:10.5px;font-weight:800;padding:1px 7px;border-radius:999px;margin-left:6px;}
.ww-mycard .tm.wolf{background:#ffdad6;color:#c8443b;}
.ww-mycard .tm.village{background:#d6e8fb;color:#2f6aa8;}
.ww-mycard .ab{font-size:11px;color:#8b81a0;line-height:1.4;margin-top:2px;}

.ww-memo{border-radius:14px;padding:10px 12px;background:rgba(255,255,255,.82);border:1px solid #e6dcf4;
  font-size:12px;color:#5a5070;flex:none;max-height:34%;overflow-y:auto;box-shadow:0 2px 6px rgba(120,90,160,.1);}
.ww-memo h4{margin:0 0 6px;font-size:11px;font-weight:800;color:#7b61c9;letter-spacing:.02em;}
.ww-memo .m{padding:4px 0;border-top:1px solid #efe7fa;line-height:1.45;}
.ww-memo .m:first-of-type{border-top:none;}
.ww-memo b{color:#43384f;}

.ww-stage{border-radius:18px;background:rgba(255,255,255,.72);border:1px solid #ece3f7;
  padding:18px;display:flex;flex-direction:column;min-height:0;overflow:hidden;
  box-shadow:0 8px 26px rgba(120,90,160,.14);backdrop-filter:blur(6px);}
.ww-stage-title{font-size:16px;font-weight:800;margin-bottom:4px;color:#43384f;}
.ww-stage-sub{font-size:12.5px;color:#8b81a0;line-height:1.5;margin-bottom:14px;}

.ww-center{margin:auto;text-align:center;max-width:460px;}
.ww-big-card{width:158px;margin:0 auto 14px;border-radius:20px;padding:22px 16px;border:2px solid;}
.ww-big-card.wolf{background:linear-gradient(160deg,#ffe0e0,#ffd0d0);border-color:#e0554d;box-shadow:0 10px 26px rgba(224,85,77,.25);}
.ww-big-card.village{background:linear-gradient(160deg,#e2efff,#d0e5ff);border-color:#3b82c4;box-shadow:0 10px 26px rgba(59,130,196,.22);}
.ww-big-card .ic{width:56px;height:56px;margin:0 auto 8px;}
.ww-big-card .nm{font-size:20px;font-weight:900;color:#43384f;}

.ww-choose{display:flex;flex-wrap:wrap;gap:9px;justify-content:center;margin-top:6px;}
.ww-choice{border:1px solid #e0d4f0;background:#fff;color:#43384f;
  border-radius:13px;padding:11px 15px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;
  display:flex;align-items:center;gap:8px;box-shadow:0 2px 6px rgba(120,90,160,.1);
  transition:background .12s,transform .08s,border-color .12s;}
.ww-choice:hover:not(:disabled){background:#fff0f6;border-color:#ffb3d0;}
.ww-choice:active:not(:disabled){transform:scale(.96);}
.ww-choice.sel{border-color:#ff6ba0;background:#ffe4ef;}
.ww-choice:disabled{opacity:.4;cursor:default;}
.ww-choice svg{width:20px;height:20px;}
.ww-cardface{display:flex;flex-direction:column;align-items:center;gap:6px;width:78px;padding:12px 6px;}
.ww-cardface .ic{width:30px;height:30px;}
.ww-cardface .cl{font-size:11.5px;color:#8b81a0;font-weight:700;}

.ww-tabs{display:flex;gap:8px;justify-content:center;margin-bottom:12px;}
.ww-tab{border:1px solid #e0d4f0;background:#fff;color:#6a6086;
  border-radius:999px;padding:7px 15px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;}
.ww-tab.on{background:#ff6ba0;color:#fff;border-color:#ff6ba0;}

.ww-btn{border:none;border-radius:999px;padding:12px 22px;font:inherit;font-weight:800;font-size:14px;cursor:pointer;
  background:linear-gradient(135deg,#ff8bb9,#ff6ba0);color:#fff;box-shadow:0 4px 14px rgba(255,107,160,.35);
  transition:transform .08s,filter .12s;}
.ww-btn:hover{filter:brightness(1.04);}
.ww-btn:active{transform:scale(.97);}
.ww-btn:disabled{opacity:.5;cursor:default;filter:none;box-shadow:none;}
.ww-btn.ghost{background:#fff;color:#6a6086;box-shadow:none;border:1px solid #e0d4f0;}
.ww-wait{margin:auto;text-align:center;color:#8b81a0;}
.ww-wait .big{font-size:15px;font-weight:800;color:#43384f;margin-bottom:6px;}
.ww-moon{font-size:40px;margin-bottom:12px;}

/* 낮 토론 채팅 */
.ww-chat{display:flex;flex-direction:column;min-height:0;flex:1;}
.ww-log{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:7px;padding-right:4px;}
.ww-line{font-size:13px;line-height:1.4;color:#43384f;}
.ww-line .who{font-weight:800;color:#2f6aa8;margin-right:6px;}
.ww-line.mine .who{color:#e0679b;}
.ww-log-empty{color:#a99fbe;font-size:12.5px;text-align:center;margin:auto;}
.ww-chat-form{display:flex;gap:8px;margin-top:10px;flex:none;}
.ww-chat-input{flex:1;border:1px solid #e0d4f0;background:#fff;color:#43384f;
  border-radius:12px;padding:11px 14px;font:inherit;font-size:13px;outline:none;}
.ww-chat-input:focus{border-color:#ff9ec3;}

/* 투표 */
.ww-vote{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:8px;}
.ww-vote-btn{border:1px solid #e0d4f0;background:#fff;color:#43384f;
  border-radius:14px;padding:14px 18px;font:inherit;font-size:14px;font-weight:800;cursor:pointer;min-width:100px;
  box-shadow:0 2px 8px rgba(120,90,160,.12);transition:background .12s,transform .08s,border-color .12s;}
.ww-vote-btn:hover:not(:disabled){background:#ffecec;border-color:#f0a09a;}
.ww-vote-btn:active:not(:disabled){transform:scale(.96);}
.ww-vote-btn.voted{border-color:#e0554d;background:#ffdad6;color:#c8443b;}
.ww-vote-btn:disabled{opacity:.5;cursor:default;}

/* 결과 오버레이 */
.ww-result{position:absolute;inset:0;background:rgba(255,247,251,.94);backdrop-filter:blur(8px);
  display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:14px;padding:26px 20px;overflow-y:auto;z-index:5;}
.ww-banner{font-size:26px;font-weight:900;text-align:center;padding:10px 26px;border-radius:18px;margin-top:6px;}
.ww-banner.village{background:linear-gradient(135deg,#dcebff,#eef5ff);color:#2f6aa8;border:1px solid #aecbe8;}
.ww-banner.wolf{background:linear-gradient(135deg,#ffdedb,#fff0ef);color:#c8443b;border:1px solid #f2b3ae;}
.ww-outcome{font-size:15px;font-weight:800;}
.ww-outcome.win{color:#2f9e44;}
.ww-outcome.lose{color:#8b81a0;}
.ww-reveal{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;max-width:640px;}
.ww-rc{width:104px;border-radius:14px;padding:11px 8px;text-align:center;border:1px solid #e6dcf4;background:#fff;box-shadow:0 2px 8px rgba(120,90,160,.1);}
.ww-rc.exec{border-color:#e0554d;box-shadow:0 0 0 2px rgba(224,85,77,.3);}
.ww-rc .who{font-size:12px;font-weight:800;margin-bottom:6px;color:#43384f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ww-rc .ic{width:34px;height:34px;margin:0 auto 4px;}
.ww-rc .fin{font-size:13px;font-weight:800;color:#43384f;}
.ww-rc .chg{font-size:10.5px;color:#8b81a0;margin-top:3px;}
.ww-rc .tag{display:inline-block;font-size:9.5px;font-weight:800;padding:1px 6px;border-radius:999px;margin-top:4px;background:#ffdad6;color:#c8443b;}
.ww-center-reveal{display:flex;gap:8px;justify-content:center;}
.ww-center-reveal .ww-rc{width:78px;opacity:.9;}
.ww-reveal-h{font-size:12px;font-weight:800;color:#8b81a0;width:100%;text-align:center;margin-top:4px;}

@media (prefers-reduced-motion: reduce){
  .ww-choice,.ww-btn,.ww-vote-btn{transition:none;}
}
`;

export class WerewolfRenderer {
  private canvas: HTMLCanvasElement;
  private root: HTMLDivElement;
  private cb: WwCallbacks;

  private topEl!: HTMLDivElement;
  private phaseEl!: HTMLSpanElement;
  private timerEl!: HTMLSpanElement;
  private stepsEl!: HTMLDivElement;
  private playersEl!: HTMLDivElement;
  private mycardEl!: HTMLDivElement;
  private memoEl!: HTMLDivElement;
  private stageEl!: HTMLDivElement;
  private resultEl!: HTMLDivElement;
  private styleEl!: HTMLStyleElement;

  /** 스테이지 마지막 렌더 키 — 바뀔 때만 재빌드 */
  private stageKey = '';
  /** 채팅 로그에 이미 그린 줄 수 (증분 append) */
  private renderedChat = 0;
  /** 예언자 UI 로컬 선택 상태 (재빌드 사이 유지) */
  private seerTab: 'player' | 'center' = 'player';
  private seerCenters: number[] = [];
  private tmPick: string[] = [];
  private _dbg = false;

  constructor(canvas: HTMLCanvasElement, cb: WwCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    canvas.style.display = 'none';

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.styleEl = style;

    const root = document.createElement('div');
    root.className = 'ww-root';
    root.innerHTML = `
      <div class="ww-top">
        <span class="ww-phase" id="ww-phase"></span>
        <span class="ww-timer" id="ww-timer" hidden></span>
      </div>
      <div class="ww-steps" id="ww-steps"></div>
      <div class="ww-grid">
        <div class="ww-left">
          <div class="ww-players" id="ww-players"></div>
          <div class="ww-mycard" id="ww-mycard" hidden></div>
          <div class="ww-memo" id="ww-memo" hidden></div>
        </div>
        <div class="ww-stage" id="ww-stage"></div>
      </div>
      <div class="ww-result" id="ww-result" hidden></div>
    `;
    canvas.parentElement?.appendChild(root);
    this.root = root;
    console.log('[ww] renderer mount', { hasParent: !!canvas.parentElement, connected: root.isConnected, parentCls: canvas.parentElement?.className });

    this.phaseEl = root.querySelector('#ww-phase')!;
    this.timerEl = root.querySelector('#ww-timer')!;
    this.stepsEl = root.querySelector('#ww-steps')!;
    this.playersEl = root.querySelector('#ww-players')!;
    this.mycardEl = root.querySelector('#ww-mycard')!;
    this.memoEl = root.querySelector('#ww-memo')!;
    this.stageEl = root.querySelector('#ww-stage')!;
    this.resultEl = root.querySelector('#ww-result')!;
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  // ============================================
  // 메인 렌더
  // ============================================

  render(rs: WwRenderState): void {
    const s = rs.state;
    if (!this._dbg) {
      this._dbg = true;
      console.log('[ww] first render', { phase: s.phase, players: s.players.length, myOrigRole: rs.myOrigRole, connected: this.root.isConnected, w: this.root.clientWidth, h: this.root.clientHeight, parentH: this.root.parentElement?.clientHeight });
    }
    this.renderTop(rs);
    this.renderSteps(rs);
    this.renderPlayers(rs);
    this.renderMyCard(rs);
    this.renderMemo(rs);

    if (s.phase === 'result') {
      this.resultEl.hidden = false;
      this.renderResult(rs);
      return;
    }
    this.resultEl.hidden = true;
    this.renderStage(rs);
  }

  private renderTop(rs: WwRenderState): void {
    const s = rs.state;
    let label = '';
    if (s.phase === 'deal') label = '역할 배정';
    else if (s.phase === 'night') label = `<span class="r">밤</span> · ${s.nightRole ? ROLE_META[s.nightRole].name : ''} 차례`;
    else if (s.phase === 'day') label = '낮 · 토론';
    else if (s.phase === 'vote') label = '투표 · 처형할 사람을 지목';
    this.phaseEl.innerHTML = label;

    const secs = rs.remainMs > 0 ? Math.ceil(rs.remainMs / 1000) : 0;
    if (secs > 0 && (s.phase === 'day' || s.phase === 'vote' || s.phase === 'night')) {
      this.timerEl.hidden = false;
      this.timerEl.textContent = `${secs}s`;
      this.timerEl.classList.toggle('warn', secs <= 10);
    } else {
      this.timerEl.hidden = true;
    }
  }

  private renderSteps(rs: WwRenderState): void {
    const s = rs.state;
    if (s.phase !== 'night') { this.stepsEl.innerHTML = ''; return; }
    const steps = nightStepsForSetup(setupFor(s.players.length));
    this.stepsEl.innerHTML = steps.map((r, i) => {
      const cls = i + 1 < s.nightStep ? 'done' : (i + 1 === s.nightStep ? 'now' : '');
      return `<span class="st ${cls}" title="${ROLE_META[r].name}">${ROLE_SVG[r]}</span>`;
    }).join('');
  }

  private renderPlayers(rs: WwRenderState): void {
    const s = rs.state;
    this.playersEl.innerHTML = s.players.map((p) => {
      const me = p.peerId === rs.myPeerId;
      return `<div class="ww-prow ${me ? 'me' : ''}"><span class="dot"></span>` +
        `<span class="nm">${esc(p.nickname)}${me ? ' (나)' : ''}</span></div>`;
    }).join('');
  }

  private renderMyCard(rs: WwRenderState): void {
    if (rs.isSpectator || !rs.myOrigRole) { this.mycardEl.hidden = true; return; }
    const r = rs.myOrigRole;
    const t = teamOf(r);
    this.mycardEl.hidden = false;
    this.mycardEl.className = `ww-mycard ${t}`;
    this.mycardEl.innerHTML =
      `<span class="ic">${ROLE_SVG[r]}</span>` +
      `<div><div><span class="nm">${ROLE_META[r].name}</span>` +
      `<span class="tm ${t}">${t === 'wolf' ? '늑대' : '시민'}</span></div>` +
      `<div class="ab">처음 받은 카드</div></div>`;
  }

  private renderMemo(rs: WwRenderState): void {
    if (rs.isSpectator || rs.memos.length === 0) { this.memoEl.hidden = true; return; }
    this.memoEl.hidden = false;
    const lines = rs.memos.map((m) => `<div class="m">${this.memoText(m, rs)}</div>`).join('');
    this.memoEl.innerHTML = `<h4>밤에 알게 된 것</h4>${lines}`;
  }

  private memoText(m: NightInfo, rs: WwRenderState): string {
    const nick = (pid: string): string => rs.state.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    const rn = (r: Role): string => `<b>${ROLE_META[r].name}</b>`;
    switch (m.kind) {
      case 'wolves':
        if (m.solo) return '늑대는 나 혼자였어요. 가운데 카드를 하나 엿봤죠.';
        return `동료 늑대: <b>${m.peerIds.map(nick).join(', ')}</b>`;
      case 'peeked':
        return `가운데 ${m.center + 1}번 카드는 ${rn(m.role)}`;
      case 'seerPlayer':
        return `${esc(nick(m.target))}의 카드는 ${rn(m.role)}`;
      case 'seerCenter':
        return '가운데 ' + m.cards.map((c) => `${c.center + 1}번=${ROLE_META[c.role].name}`).join(', ');
      case 'robbed':
        return `${esc(nick(m.target))}의 카드를 뺏어왔어요 → 이제 내 카드는 ${rn(m.newRole)}`;
      case 'insomniac':
        return `밤이 끝난 지금 내 카드는 ${rn(m.role)}`;
    }
  }

  // ============================================
  // 스테이지 (페이즈별 인터랙티브) — stageKey 바뀔 때만 재빌드
  // ============================================

  private renderStage(rs: WwRenderState): void {
    const key = this.computeStageKey(rs);
    // 낮(채팅)은 stageKey 고정 → 재빌드 없이 로그만 증분 갱신
    if (rs.state.phase === 'day' && key === this.stageKey) {
      this.updateChatLog(rs);
      return;
    }
    if (key === this.stageKey) return;
    this.stageKey = key;

    if (rs.isSpectator) { this.stageEl.innerHTML = `<div class="ww-wait"><div class="ww-moon">👁️</div><div class="big">관전 중</div><div>플레이어들의 밤과 낮을 지켜봐요</div></div>`; return; }

    switch (rs.state.phase) {
      case 'deal': this.buildDeal(rs); break;
      case 'night': this.buildNight(rs); break;
      case 'day': this.buildDay(rs); break;
      case 'vote': this.buildVote(rs); break;
    }
  }

  private computeStageKey(rs: WwRenderState): string {
    const s = rs.state;
    switch (s.phase) {
      case 'deal': return `deal:${rs.confirmedDeal}`;
      case 'night': {
        const mine = s.nightRole === rs.myOrigRole;
        // 늑대 혼자-엿보기 결과(peeked)가 오면 재빌드되도록 memo 개수/마지막종류 포함
        const last = rs.memos[rs.memos.length - 1];
        return `night:${s.nightStep}:${s.nightRole}:${mine}:${rs.actedNight}:${rs.memos.length}:${last?.kind ?? ''}`;
      }
      case 'day': return 'day';
      case 'vote': return `vote:${rs.voted}`;
      default: return s.phase;
    }
  }

  // ── deal: 내 역할 공개 ──
  private buildDeal(rs: WwRenderState): void {
    const s = rs.state;
    if (rs.confirmedDeal) {
      this.stageEl.innerHTML = `<div class="ww-wait"><div class="ww-moon">🌙</div>` +
        `<div class="big">다른 사람들을 기다려요</div>` +
        `<div>${s.readyCount} / ${s.players.length} 명이 카드를 확인했어요</div></div>`;
      return;
    }
    const r = rs.myOrigRole;
    if (!r) { this.stageEl.innerHTML = `<div class="ww-wait"><div class="big">카드 받는 중…</div></div>`; return; }
    const t = teamOf(r);
    this.stageEl.innerHTML = `<div class="ww-center">
      <div class="ww-stage-title">당신의 카드</div>
      <div class="ww-stage-sub">이 카드는 비밀! 밤이 지나면 바뀔 수도 있어요.</div>
      <div class="ww-big-card ${t}"><div class="ic">${ROLE_SVG[r]}</div><div class="nm">${ROLE_META[r].name}</div></div>
      <div class="ww-stage-sub" style="margin:0 0 16px">${ROLE_META[r].ability}</div>
      <button class="ww-btn" id="ww-ready">확인했어요 · 밤으로</button>
    </div>`;
    this.stageEl.querySelector<HTMLButtonElement>('#ww-ready')!
      .addEventListener('click', () => this.cb.onReady());
  }

  // ── night: 내 차례면 행동 UI, 아니면 대기 ──
  private buildNight(rs: WwRenderState): void {
    const s = rs.state;
    const mine = s.nightRole === rs.myOrigRole && !rs.isSpectator;
    if (!mine || rs.actedNight) {
      const roleName = s.nightRole ? ROLE_META[s.nightRole].name : '';
      this.stageEl.innerHTML = `<div class="ww-wait"><div class="ww-moon">🌙</div>` +
        `<div class="big">${rs.actedNight && mine ? '행동 완료! 눈을 감고 기다려요' : '눈을 감고 기다려요'}</div>` +
        `<div>${roleName}가 행동하는 중…</div></div>`;
      return;
    }
    switch (rs.myOrigRole) {
      case 'wolf': this.buildWolf(rs); break;
      case 'seer': this.buildSeer(rs); break;
      case 'robber': {
        const robbed = rs.memos.find((m) => m.kind === 'robbed') as Extract<NightInfo, { kind: 'robbed' }> | undefined;
        if (robbed) this.buildRobberResult(rs, robbed);
        else this.buildPickPlayer(rs, '강도 — 카드를 뺏을 상대를 골라요.', (t) => this.cb.onNightAct({ kind: 'robber', target: t }));
        break;
      }
      case 'troublemaker': this.buildTroublemaker(rs); break;
      case 'drunk': this.buildPickCenter(rs, '주정뱅이 — 가운데 카드 1장과 맞바꾸기 (내용은 안 보여요)', (c) => this.cb.onNightAct({ kind: 'drunk', center: c })); break;
      case 'insomniac': this.buildInsomniac(rs); break;
      default: this.stageEl.innerHTML = `<div class="ww-wait"><div class="big">기다려요</div></div>`;
    }
  }

  private stageHead(title: string, sub: string): string {
    return `<div class="ww-stage-title">${title}</div><div class="ww-stage-sub">${sub}</div>`;
  }

  private buildWolf(rs: WwRenderState): void {
    const wolvesMemo = rs.memos.find((m) => m.kind === 'wolves') as Extract<NightInfo, { kind: 'wolves' }> | undefined;
    const peeked = rs.memos.find((m) => m.kind === 'peeked') as Extract<NightInfo, { kind: 'peeked' }> | undefined;
    const nick = (pid: string): string => rs.state.players.find((p) => p.peerId === pid)?.nickname ?? '?';

    if (wolvesMemo && !wolvesMemo.solo) {
      // 동료 늑대 있음 — 확인만
      this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('늑대인간', '같은 편 늑대를 확인하세요.')}` +
        `<div class="ww-choose" style="margin-bottom:16px">` +
        wolvesMemo.peerIds.map((p) => `<div class="ww-cardface"><span class="ic">${ROLE_SVG.wolf}</span><span class="cl">${esc(nick(p))}</span></div>`).join('') +
        `</div><button class="ww-btn" id="ww-wc">확인</button></div>`;
      this.stageEl.querySelector<HTMLButtonElement>('#ww-wc')!.addEventListener('click', () => this.cb.onNightAct({ kind: 'wolfConfirm' }));
      return;
    }
    // 혼자 늑대 — 가운데 1장 엿보기 → 확인
    if (peeked) {
      this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('늑대인간 (혼자)', '엿본 가운데 카드예요.')}` +
        `<div class="ww-big-card ${teamOf(peeked.role)}" style="margin-bottom:14px"><div class="ic">${ROLE_SVG[peeked.role]}</div><div class="nm">${ROLE_META[peeked.role].name}</div></div>` +
        `<div class="ww-stage-sub">가운데 ${peeked.center + 1}번 카드</div>` +
        `<button class="ww-btn" id="ww-wc">확인</button></div>`;
      this.stageEl.querySelector<HTMLButtonElement>('#ww-wc')!.addEventListener('click', () => this.cb.onNightAct({ kind: 'wolfConfirm' }));
      return;
    }
    // 아직 안 엿봄 — 가운데 3장 중 하나 선택
    this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('늑대인간 (혼자)', '늑대는 당신 혼자예요. 가운데 카드 1장을 골라 엿보세요.')}` +
      `<div class="ww-choose">` +
      [0, 1, 2].map((i) => `<button class="ww-choice" data-c="${i}"><span>가운데 ${i + 1}번</span></button>`).join('') +
      `</div></div>`;
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((b) => {
      b.addEventListener('click', () => this.cb.onNightAct({ kind: 'wolfPeek', center: Number(b.dataset.c) }));
    });
  }

  private buildSeer(rs: WwRenderState): void {
    // 결과가 이미 왔으면 확인만
    const seen = rs.memos.find((m) => m.kind === 'seerPlayer' || m.kind === 'seerCenter');
    if (seen) {
      this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('예언자', '확인한 카드는 왼쪽 "밤에 알게 된 것"에 적어뒀어요.')}` +
        `<button class="ww-btn" id="ww-sc">확인</button></div>`;
      this.stageEl.querySelector<HTMLButtonElement>('#ww-sc')!.addEventListener('click', () => this.cb.onNightAct({ kind: 'skip' }));
      return;
    }
    const others = rs.state.players.filter((p) => p.peerId !== rs.myPeerId);
    const centerTab = this.seerTab === 'center';
    this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('예언자', '다른 사람 카드 1장, 또는 가운데 카드 2장을 봐요.')}` +
      `<div class="ww-tabs"><button class="ww-tab ${!centerTab ? 'on' : ''}" data-tab="player">플레이어 1장</button>` +
      `<button class="ww-tab ${centerTab ? 'on' : ''}" data-tab="center">가운데 2장</button></div>` +
      (centerTab
        ? `<div class="ww-choose">${[0, 1, 2].map((i) => `<button class="ww-choice ${this.seerCenters.includes(i) ? 'sel' : ''}" data-c="${i}"><span>가운데 ${i + 1}번</span></button>`).join('')}</div>` +
          `<div class="ww-stage-sub" style="margin-top:12px">${this.seerCenters.length}/2 선택</div>` +
          `<button class="ww-btn" id="ww-sok" ${this.seerCenters.length === 2 ? '' : 'disabled'}>확인</button>`
        : `<div class="ww-choose">${others.map((p) => `<button class="ww-choice" data-p="${p.peerId}"><span>${esc(p.nickname)}</span></button>`).join('')}</div>`) +
      `</div>`;
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
      b.addEventListener('click', () => { this.seerTab = b.dataset.tab as 'player' | 'center'; this.seerCenters = []; this.stageKey = ''; this.renderStage(rs); });
    });
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) => {
      b.addEventListener('click', () => this.cb.onNightAct({ kind: 'seerPlayer', target: b.dataset.p! }));
    });
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.c);
        if (this.seerCenters.includes(i)) this.seerCenters = this.seerCenters.filter((x) => x !== i);
        else if (this.seerCenters.length < 2) this.seerCenters = [...this.seerCenters, i];
        this.stageKey = ''; this.renderStage(rs);
      });
    });
    const ok = this.stageEl.querySelector<HTMLButtonElement>('#ww-sok');
    ok?.addEventListener('click', () => { if (this.seerCenters.length === 2) this.cb.onNightAct({ kind: 'seerCenter', centers: [...this.seerCenters] }); });
  }

  private buildPickPlayer(rs: WwRenderState, sub: string, act: (target: string) => void): void {
    const others = rs.state.players.filter((p) => p.peerId !== rs.myPeerId);
    this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead(ROLE_META[rs.myOrigRole!].name, sub)}` +
      `<div class="ww-choose">${others.map((p) => `<button class="ww-choice" data-p="${p.peerId}"><span>${esc(p.nickname)}</span></button>`).join('')}</div></div>`;
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) => {
      b.addEventListener('click', () => act(b.dataset.p!));
    });
  }

  private buildPickCenter(rs: WwRenderState, sub: string, act: (center: number) => void): void {
    this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead(ROLE_META[rs.myOrigRole!].name, sub)}` +
      `<div class="ww-choose">${[0, 1, 2].map((i) => `<button class="ww-choice" data-c="${i}"><span>가운데 ${i + 1}번</span></button>`).join('')}</div></div>`;
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((b) => {
      b.addEventListener('click', () => act(Number(b.dataset.c)));
    });
  }

  private buildTroublemaker(rs: WwRenderState): void {
    const others = rs.state.players.filter((p) => p.peerId !== rs.myPeerId);
    this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('말썽쟁이', '나를 뺀 두 사람을 골라 카드를 맞바꿔요 (내용은 안 보여요).')}` +
      `<div class="ww-choose">${others.map((p) => `<button class="ww-choice ${this.tmPick.includes(p.peerId) ? 'sel' : ''}" data-p="${p.peerId}"><span>${esc(p.nickname)}</span></button>`).join('')}</div>` +
      `<div class="ww-stage-sub" style="margin-top:12px">${this.tmPick.length}/2 선택</div>` +
      `<button class="ww-btn" id="ww-tmok" ${this.tmPick.length === 2 ? '' : 'disabled'}>맞바꾸기</button></div>`;
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.dataset.p!;
        if (this.tmPick.includes(id)) this.tmPick = this.tmPick.filter((x) => x !== id);
        else if (this.tmPick.length < 2) this.tmPick = [...this.tmPick, id];
        this.stageKey = ''; this.renderStage(rs);
      });
    });
    this.stageEl.querySelector<HTMLButtonElement>('#ww-tmok')?.addEventListener('click', () => {
      if (this.tmPick.length === 2) this.cb.onNightAct({ kind: 'troublemaker', a: this.tmPick[0]!, b: this.tmPick[1]! });
    });
  }

  private buildRobberResult(rs: WwRenderState, robbed: Extract<NightInfo, { kind: 'robbed' }>): void {
    const nick = rs.state.players.find((p) => p.peerId === robbed.target)?.nickname ?? '?';
    const t = teamOf(robbed.newRole);
    this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('강도', `${esc(nick)}의 카드를 뺏어왔어요. 이제 내 카드는…`)}` +
      `<div class="ww-big-card ${t}" style="margin-bottom:14px"><div class="ic">${ROLE_SVG[robbed.newRole]}</div><div class="nm">${ROLE_META[robbed.newRole].name}</div></div>` +
      `<button class="ww-btn" id="ww-rc">확인</button></div>`;
    this.stageEl.querySelector<HTMLButtonElement>('#ww-rc')!.addEventListener('click', () => this.cb.onNightAct({ kind: 'skip' }));
  }

  private buildInsomniac(rs: WwRenderState): void {
    const memo = rs.memos.find((m) => m.kind === 'insomniac') as Extract<NightInfo, { kind: 'insomniac' }> | undefined;
    if (!memo) { this.stageEl.innerHTML = `<div class="ww-wait"><div class="big">내 카드 확인 중…</div></div>`; return; }
    const t = teamOf(memo.role);
    this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('불면증환자', '밤이 끝났어요. 지금 당신의 카드는…')}` +
      `<div class="ww-big-card ${t}" style="margin-bottom:14px"><div class="ic">${ROLE_SVG[memo.role]}</div><div class="nm">${ROLE_META[memo.role].name}</div></div>` +
      `<button class="ww-btn" id="ww-ic">확인 · 아침으로</button></div>`;
    this.stageEl.querySelector<HTMLButtonElement>('#ww-ic')!.addEventListener('click', () => this.cb.onNightAct({ kind: 'insomniacConfirm' }));
  }

  // ── day: 토론 채팅 ──
  private buildDay(rs: WwRenderState): void {
    this.renderedChat = 0;
    this.stageEl.innerHTML = `${this.stageHead('낮 · 토론', '밤새 무슨 일이? 서로 추리하고, 블러핑하고, 늑대를 찾아내세요.')}` +
      `<div class="ww-chat"><div class="ww-log" id="ww-log"></div>` +
      `<form class="ww-chat-form" id="ww-cf" autocomplete="off">` +
      `<input class="ww-chat-input" id="ww-ci" maxlength="200" placeholder="여기서 대화하세요 (블러핑 환영!)" />` +
      `<button class="ww-btn" type="submit">전송</button></form></div>`;
    this.updateChatLog(rs);
    this.stageEl.querySelector<HTMLFormElement>('#ww-cf')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = this.stageEl.querySelector<HTMLInputElement>('#ww-ci')!;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this.cb.onChat(text);
    });
  }

  private updateChatLog(rs: WwRenderState): void {
    const log = this.stageEl.querySelector<HTMLDivElement>('#ww-log');
    if (!log) return;
    const lines = rs.state.chatLog;
    if (lines.length < this.renderedChat) { log.innerHTML = ''; this.renderedChat = 0; }
    if (lines.length === 0) {
      if (!log.querySelector('.ww-log-empty')) log.innerHTML = `<div class="ww-log-empty">아직 조용하네요… 먼저 말을 꺼내볼까요?</div>`;
      return;
    }
    const empty = log.querySelector('.ww-log-empty');
    if (empty) { empty.remove(); }
    for (let i = this.renderedChat; i < lines.length; i++) {
      const l = lines[i]!;
      const mine = l.peerId === rs.myPeerId;
      const row = document.createElement('div');
      row.className = `ww-line ${mine ? 'mine' : ''}`;
      row.innerHTML = `<span class="who">${esc(l.nickname)}</span><span>${esc(l.text)}</span>`;
      log.appendChild(row);
    }
    if (lines.length > this.renderedChat) { this.renderedChat = lines.length; log.scrollTop = log.scrollHeight; }
  }

  // ── vote ──
  private buildVote(rs: WwRenderState): void {
    if (rs.voted) {
      this.stageEl.innerHTML = `<div class="ww-wait"><div class="ww-moon">🗳️</div><div class="big">투표 완료!</div><div>다른 사람들을 기다려요</div></div>`;
      return;
    }
    this.stageEl.innerHTML = `${this.stageHead('투표', '처형할 사람을 지목하세요. (자기 자신도 가능 — 신중히!)')}` +
      `<div class="ww-vote">${rs.state.players.map((p) => `<button class="ww-vote-btn" data-v="${p.peerId}">${esc(p.nickname)}${p.peerId === rs.myPeerId ? ' (나)' : ''}</button>`).join('')}</div>`;
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((b) => {
      b.addEventListener('click', () => {
        this.stageEl.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((x) => { x.disabled = true; });
        b.classList.add('voted');
        this.cb.onVote(b.dataset.v!);
      });
    });
  }

  // ── result ──
  private renderResult(rs: WwRenderState): void {
    const rv = rs.state.reveal;
    if (!rv) return;
    const nick = (pid: string): string => rs.state.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    const win = rv.winningTeam;
    const myFinal = rv.finalRoles[rs.myPeerId];
    const iWon = !rs.isSpectator && myFinal ? teamOf(myFinal) === win : false;

    const cards = rs.state.players.map((p) => {
      const fin = rv.finalRoles[p.peerId]!;
      const orig = rv.origRoles[p.peerId]!;
      const changed = fin !== orig;
      const executed = rv.executed.includes(p.peerId);
      const votedFor = rv.votes[p.peerId];
      return `<div class="ww-rc ${executed ? 'exec' : ''}">` +
        `<div class="who">${esc(nick(p.peerId))}</div>` +
        `<div class="ic">${ROLE_SVG[fin]}</div>` +
        `<div class="fin">${ROLE_META[fin].name}</div>` +
        (changed ? `<div class="chg">(처음: ${ROLE_META[orig].name})</div>` : '') +
        (votedFor ? `<div class="chg">→ ${esc(nick(votedFor))} 지목</div>` : '') +
        (executed ? `<div class="tag">처형</div>` : '') +
        `</div>`;
    }).join('');

    const centerCards = rv.center.map((r, i) =>
      `<div class="ww-rc"><div class="who">가운데 ${i + 1}</div><div class="ic">${ROLE_SVG[r]}</div><div class="fin">${ROLE_META[r].name}</div></div>`
    ).join('');

    const executedTxt = rv.executed.length === 0 ? '아무도 처형되지 않았어요' : `${rv.executed.map(nick).join(', ')} 처형됨`;

    this.resultEl.innerHTML =
      `<div class="ww-banner ${win}">${win === 'village' ? '🛡️ 시민 팀 승리' : '🐺 늑대 팀 승리'}</div>` +
      (rs.isSpectator ? '' : `<div class="ww-outcome ${iWon ? 'win' : 'lose'}">${iWon ? '당신의 승리!' : '아쉽게 패배…'}</div>`) +
      `<div class="ww-outcome" style="color:#6a6086;font-size:13px">${executedTxt}</div>` +
      `<div class="ww-reveal">${cards}</div>` +
      `<div class="ww-reveal-h">가운데 카드</div><div class="ww-center-reveal">${centerCards}</div>`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
