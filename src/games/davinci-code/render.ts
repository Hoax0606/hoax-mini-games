/**
 * 다빈치 코드 렌더 — DOM
 *
 * 캔버스를 숨기고 그 부모에 DOM 을 붙인다(더 마인드와 같은 방식).
 * 타일·숫자패드처럼 눌러야 하는 게 많아서 캔버스보다 DOM 이 맞다.
 *
 * 렌더러는 **상태를 안 들고 있다.** 받은 sync 를 그대로 그릴 뿐이고,
 * 누가 뭘 할 수 있는지(phase, turnPeerId)도 전부 sync 가 정한다.
 * 그래야 호스트와 게스트가 같은 화면을 보고, 화면이 판정에 끼어들지 않는다.
 */

import { JOKER, JOKER_LABEL, tileLabel, MAX_NUM } from './rules';
import type { SyncPayload, SyncPlayer } from './netSync';

export interface DvCallbacks {
  onDraw(): void;
  onPlace(index: number): void;
  onGuess(targetPeerId: string, tileIndex: number, num: number): void;
  onContinue(go: boolean): void;
  onReveal(index: number): void;
}

const CSS = `
/* safe center — 내용이 넘칠 때 center 는 위아래로 똑같이 밀어내는데 스크롤은 아래로만 돼서
   위쪽을 영영 못 본다 (CLAUDE.md 의 그 금기) */
.dv-screen{position:absolute;inset:0;display:flex;flex-direction:column;gap:18px;
  justify-content:safe center;align-items:center;
  padding:20px 16px;overflow-y:auto;font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif;}
.dv-others{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;width:100%;}
.dv-opp{background:rgba(255,255,255,.62);border:1.5px solid rgba(255,255,255,.8);border-radius:14px;
  padding:9px 12px;min-width:150px;box-shadow:0 4px 14px rgba(63,179,162,.14);}
.dv-opp.is-turn{border-color:#f5c33d;box-shadow:0 4px 18px rgba(245,195,61,.4);}
.dv-opp.is-out{opacity:.45;}
.dv-opp-name{font-size:12.5px;font-weight:800;color:#2f4a46;margin-bottom:6px;display:flex;gap:6px;align-items:center;}
.dv-opp-out{font-size:10.5px;font-weight:700;color:#6b8a85;}
.dv-row{display:flex;gap:4px;flex-wrap:wrap;}
/* 패드가 열리면 본문을 위로 밀어 자리를 내준다. 안 그러면 패드가 내 타일을 덮는다 */
.dv-screen.has-pad{padding-bottom:300px;}
/* 타일 밑 자리 번호 — 패드가 "3번째 타일은?" 이라고 묻는데 세어야 하면 불친절하다 */
.dv-tilecol{display:flex;flex-direction:column;align-items:center;gap:3px;}
.dv-pos{font-size:10px;font-weight:800;color:#9bb3ae;}

/* 타일 — 검정/흰색은 게임 고유 구분이라 팔레트 안에서 먹청록/크림으로 표현한다 */
.dv-tile{width:30px;height:42px;border-radius:7px;display:flex;align-items:center;justify-content:center;
  font-size:16px;font-weight:900;border:none;padding:0;flex:0 0 auto;
  transition:transform .12s ease,box-shadow .12s ease;}
.dv-tile.black{background:#2f4a46;color:#fff;}
.dv-tile.white{background:#fffdf5;color:#2f4a46;border:1.5px solid #cfe3df;}
.dv-tile.hidden{color:transparent;}
.dv-tile.hidden.black{background:linear-gradient(160deg,#3d5c57,#263c39);}
.dv-tile.hidden.white{background:linear-gradient(160deg,#fffdf5,#eef6f4);}
.dv-tile.pickable{cursor:pointer;}
.dv-tile.pickable:hover{transform:translateY(-4px);box-shadow:0 6px 14px rgba(42,148,136,.35);}
.dv-tile.just-revealed{animation:dv-flip .45s ease;}
@keyframes dv-flip{0%{transform:rotateY(90deg) scale(1.1);}100%{transform:none;}}

.dv-mid{display:flex;align-items:center;justify-content:center;gap:14px;font-size:13px;color:#6b8a85;font-weight:700;}
.dv-pool{background:rgba(255,255,255,.6);border-radius:999px;padding:5px 14px;}
.dv-timer{font-weight:900;color:#2a9488;}
.dv-timer.urgent{color:#d4692a;}
.dv-news{text-align:center;font-size:13.5px;font-weight:800;color:#2f4a46;min-height:20px;}

.dv-mine{display:flex;flex-direction:column;align-items:center;gap:10px;}
.dv-mine-label{font-size:12px;font-weight:800;color:#6b8a85;}
.dv-drawn{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:800;color:#2a9488;}
.dv-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
.dv-btn{border:none;border-radius:999px;padding:9px 20px;font-size:14px;font-weight:800;cursor:pointer;
  font-family:inherit;background:#2a9488;color:#fff;transition:filter .12s ease,transform .12s ease;}
.dv-btn:hover{filter:brightness(1.07);transform:translateY(-1px);}
.dv-btn.ghost{background:rgba(255,255,255,.75);color:#2f4a46;border:1.5px solid #cfe3df;}
.dv-btn:disabled{opacity:.5;cursor:default;transform:none;filter:none;}

/* 조커 자리 고르기 — 타일 사이에 끼우는 얇은 버튼 */
.dv-slot{width:16px;height:42px;border-radius:7px;border:2px dashed #7ec8bb;background:rgba(126,200,187,.16);
  cursor:pointer;padding:0;flex:0 0 auto;transition:background .12s ease;}
.dv-slot:hover{background:rgba(126,200,187,.42);}
/* 자리가 정해진 숫자 타일 — 어디 들어가는지 자리만 표시하고 확인만 받는다 */
.dv-slot.fixed{border-style:solid;border-color:#ffc83d;background:rgba(255,200,61,.3);cursor:default;}
/* 이미 들킨 내 타일 — 숫자는 원래 보이니까 "남도 안다" 는 걸 테두리로 알린다 */
.dv-tile.peek{opacity:.85;border-style:dashed;}
.dv-tile.is-open{border-color:#ff9838;box-shadow:0 0 0 2px rgba(255,152,56,.28);}
.dv-open-mark{position:absolute;top:-8px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:900;
  color:#8a4b00;background:#ffc83d;border-radius:999px;padding:1px 5px;pointer-events:none;white-space:nowrap;}
.dv-tile-wrap{position:relative;display:inline-flex;flex:0 0 auto;}

/* 숫자 패드 */
/* 판을 가리지 않는다 — 상대 타일을 보면서 숫자를 골라야 하는 게임이라
   어둡게 덮으면 추리를 손에서 놓게 된다. 아래쪽에 띄우고 배경은 클릭만 먹는다. */
.dv-pad-back{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;
  padding-bottom:18px;z-index:20;background:transparent;}
.dv-pad{background:rgba(255,255,255,.96);border:1.5px solid #cfe3df;border-radius:18px;padding:16px 18px;
  box-shadow:0 18px 44px rgba(42,148,136,.32);text-align:center;
  animation:dv-pad-in .18s cubic-bezier(.2,.9,.3,1);}
@keyframes dv-pad-in{from{opacity:0;transform:translateY(14px) scale(.97);}to{opacity:1;transform:none;}}
.dv-pad-title{font-size:14px;font-weight:800;color:#2f4a46;margin-bottom:12px;}
.dv-pad-grid{display:grid;grid-template-columns:repeat(5,44px);gap:7px;}
.dv-pad-grid button{height:42px;border-radius:9px;border:1.5px solid #cfe3df;background:#fffdf5;
  font-size:15px;font-weight:900;color:#2f4a46;cursor:pointer;font-family:inherit;}
.dv-pad-grid button:hover{background:#ddf2ef;border-color:#2a9488;}
.dv-pad-cancel{margin-top:12px;}

@media(prefers-reduced-motion:reduce){
  .dv-tile,.dv-btn{transition:none;}
  .dv-pad{animation:none;}
  .dv-tile.just-revealed{animation:none;}
}
`;

export class DvRenderer {
  private canvas: HTMLCanvasElement;
  private cb: DvCallbacks;
  private root: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private tickTimer: number | undefined;
  private last: SyncPayload | null = null;
  private myId = '';
  /** 열려 있는 숫자패드 (상대 타일 지목 중) */
  private pad: HTMLDivElement | null = null;

  constructor(canvas: HTMLCanvasElement, cb: DvCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    canvas.style.display = 'none';

    this.styleEl = document.createElement('style');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement('div');
    this.root.className = 'dv-screen';
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.root);
    }

    // 남은 시간은 각자 계산한다 — 호스트가 매초 보내면 트래픽만 늘고 어차피 오차가 난다
    this.tickTimer = window.setInterval(() => this.paintTimer(), 250);
  }

  render(s: SyncPayload, myId: string): void {
    this.last = s;
    this.myId = myId;
    if (this.pad && s.turnPeerId !== myId) this.closePad(); // 내 차례가 끝나면 패드도 닫는다
    this.paint();
  }

  destroy(): void {
    if (this.tickTimer !== undefined) window.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.closePad();
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  // ---- 그리기 ----

  private paint(): void {
    const s = this.last;
    if (!s) return;
    const me = s.players.find((p) => p.peerId === this.myId) ?? null;
    const others = s.players.filter((p) => p.peerId !== this.myId);

    this.root.innerHTML = `
      <div class="dv-others">${others.map((p) => this.oppHTML(p, s)).join('')}</div>
      <div class="dv-mid">
        <span class="dv-pool">남은 타일 ${s.poolLeft}장</span>
        <span class="dv-timer" id="dv-timer"></span>
      </div>
      <div class="dv-news">${escapeText(this.newsFor(s))}</div>
      <div class="dv-mine">
        ${this.mineHTML(me, s)}
        ${this.actionsHTML(s)}
      </div>
    `;
    this.wire(s);

    // innerHTML 을 갈면 열려 있던 숫자패드가 떨어져 나간다(클래스만 root 에 남는다).
    // 아직 지목 중이면 그대로 다시 붙이고, 아니면 깨끗이 닫는다.
    if (this.pad && s.phase === 'guess' && s.turnPeerId === this.myId) {
      this.root.appendChild(this.pad);
      this.root.classList.add('has-pad');
    } else if (this.pad) {
      this.closePad();
    }

    this.paintTimer();
  }

  /**
   * 소식 한 줄. 호스트가 보낸 문구는 3인칭이라, 그게 "나"를 가리킬 땐 바꿔 쓴다.
   * (내가 놓는 중인데 "방장 님이 조커를 놓는 중이에요" 라고 뜨면 남 얘기처럼 읽힌다)
   */
  private newsFor(s: SyncPayload): string {
    if (s.phase === 'place' && s.turnPeerId === this.myId) {
      return s.myPlacing?.forcedIndex === null ? '조커를 어디에 둘지 정하세요' : '뽑은 타일을 열에 넣으세요';
    }
    return s.news;
  }

  private oppHTML(p: SyncPlayer, s: SyncPayload): string {
    const isTurn = p.peerId === s.turnPeerId;
    const canGuess = s.phase === 'guess' && s.turnPeerId === this.myId && !p.out;
    // 관전자는 내 자리가 없다 — 그때만 닫힌 타일을 '엿보기'로 숨김 없이 보여준다
    const watching = !s.players.some((x) => x.peerId === this.myId);
    const tiles = p.tiles.map((t, i) => {
      const cls = [
        'dv-tile', t.color,
        t.revealed ? '' : (watching ? 'peek' : 'hidden'),
        canGuess && !t.revealed ? 'pickable' : '',
      ].filter(Boolean).join(' ');
      const attrs = canGuess && !t.revealed
        ? ` data-guess-peer="${escapeAttr(p.peerId)}" data-guess-index="${i}"`
        : '';
      const btn = `<button class="${cls}"${attrs} ${canGuess && !t.revealed ? '' : 'disabled'}>${tileLabel(t.num)}</button>`;
      return `<span class="dv-tilecol">${btn}<span class="dv-pos">${i + 1}</span></span>`;
    }).join('');
    return `
      <div class="dv-opp ${isTurn ? 'is-turn' : ''} ${p.out ? 'is-out' : ''}">
        <div class="dv-opp-name">${escapeText(p.nickname)}
          ${p.out ? '<span class="dv-opp-out">탈락</span>' : ''}</div>
        <div class="dv-row">${tiles}</div>
      </div>`;
  }

  private mineHTML(me: SyncPlayer | null, s: SyncPayload): string {
    if (!me) return '<div class="dv-mine-label">관전 중</div>';
    const placing = s.phase === 'place' && s.turnPeerId === this.myId;
    const revealing = s.phase === 'reveal' && s.turnPeerId === this.myId;
    // 자리가 정해진 숫자 타일이면 그 자리만 노랑으로 표시, 조커면 모든 자리가 버튼
    const fixedAt = placing ? s.myPlacing?.forcedIndex ?? null : null;
    const freePlacing = placing && fixedAt === null;

    const slot = (i: number): string => {
      if (freePlacing) return `<button class="dv-slot" data-slot="${i}" title="여기에 넣기"></button>`;
      if (fixedAt === i) return `<span class="dv-slot fixed" title="여기에 들어가요"></span>`;
      return '';
    };

    const parts: string[] = [];
    me.tiles.forEach((t, i) => {
      parts.push(slot(i));
      // 내 타일은 숫자가 항상 보인다 — 그래서 들킨(revealed) 것을 구분할 방법이 없었다.
      // 어떤 게 이미 까였는지 알아야 남은 패를 세고 판단을 한다.
      const cls = ['dv-tile', t.color, t.revealed ? 'is-open' : '',
        revealing && !t.revealed ? 'pickable' : ''].filter(Boolean).join(' ');
      const attrs = revealing && !t.revealed ? ` data-reveal="${i}"` : '';
      parts.push(`<span class="dv-tile-wrap"><button class="${cls}"${attrs} ${revealing && !t.revealed ? '' : 'disabled'}>${tileLabel(t.num)}</button>${t.revealed ? '<span class="dv-open-mark">들킨</span>' : ''}</span>`);
    });
    parts.push(slot(me.tiles.length));

    const drawn = s.myDrawn
      ? `<div class="dv-drawn">뽑은 타일
           <span class="dv-tile ${s.myDrawn.color}">${tileLabel(s.myDrawn.num)}</span></div>`
      : '';
    return `
      <div class="dv-mine-label">내 타일</div>
      <div class="dv-row">${parts.join('')}</div>
      ${drawn}`;
  }

  private actionsHTML(s: SyncPayload): string {
    const mine = s.turnPeerId === this.myId;
    if (s.phase === 'done') return '';
    if (!mine) {
      const who = s.players.find((p) => p.peerId === s.turnPeerId)?.nickname ?? '';
      if (s.phase === 'place') {
        // 시작 직후(turnStartedAt===0)의 place 는 조커를 받은 사람에게만 생긴다.
        // 이름을 부르면 누가 조커를 들고 있는지 알려주는 꼴이라 그때만 뭔뛛게 둔다.
        return s.turnStartedAt === 0
          ? `<div class="dv-mine-label">타일을 정리하는 중이에요</div>`
          : `<div class="dv-mine-label">${escapeText(who)} 님이 타일을 놓는 중이에요</div>`;
      }
      return `<div class="dv-mine-label">${escapeText(who)} 님 차례예요</div>`;
    }
    switch (s.phase) {
      case 'draw':
        return `<div class="dv-actions"><button class="dv-btn" id="dv-draw">타일 뽑기</button></div>`;
      case 'place': {
        const pl = s.myPlacing;
        if (!pl) return '';
        if (pl.forcedIndex === null) {
          return `<div class="dv-mine-label">조커를 넣을 자리를 고르세요</div>`;
        }
        // 숫자 타일 — 자리는 규칙으로 정해져 있으니 확인만 받는다
        return `<div class="dv-actions">
          <span class="dv-drawn">놓을 타일
            <span class="dv-tile ${pl.color}">${tileLabel(pl.num)}</span></span>
          <button class="dv-btn" id="dv-place-ok">여기에 넣기</button>
        </div>`;
      }
      case 'guess':
        return `<div class="dv-mine-label">상대 타일을 눌러 숫자를 맞혀보세요</div>`;
      case 'continue':
        return `<div class="dv-actions">
          <button class="dv-btn" id="dv-go">계속 맞히기</button>
          <button class="dv-btn ghost" id="dv-stop">멈추기</button>
        </div>`;
      case 'reveal':
        return `<div class="dv-mine-label">공개할 내 타일을 고르세요</div>`;
      default:
        return '';
    }
  }

  private wire(s: SyncPayload): void {
    this.root.querySelector('#dv-draw')?.addEventListener('click', () => this.cb.onDraw());
    // 자리가 정해진 타일 — index 는 호스트가 재계산하므로 아무 값이나 보내도 된다
    this.root.querySelector('#dv-place-ok')?.addEventListener('click',
      () => this.cb.onPlace(this.last?.myPlacing?.forcedIndex ?? 0));
    this.root.querySelector('#dv-go')?.addEventListener('click', () => this.cb.onContinue(true));
    this.root.querySelector('#dv-stop')?.addEventListener('click', () => this.cb.onContinue(false));

    this.root.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((b) => {
      b.addEventListener('click', () => this.cb.onPlace(Number(b.dataset['slot'])));
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-reveal]').forEach((b) => {
      b.addEventListener('click', () => this.cb.onReveal(Number(b.dataset['reveal'])));
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-guess-peer]').forEach((b) => {
      b.addEventListener('click', () => {
        const peer = b.dataset['guessPeer']!;
        const idx = Number(b.dataset['guessIndex']);
        const who = s.players.find((p) => p.peerId === peer)?.nickname ?? '';
        this.openPad(who, idx + 1, (num) => this.cb.onGuess(peer, idx, num));
      });
    });
  }

  /** 남은 시간만 따로 칠한다 — 전체를 다시 그리면 숫자패드가 닫히고 포커스가 튄다 */
  private paintTimer(): void {
    const el = this.root.querySelector<HTMLElement>('#dv-timer');
    const s = this.last;
    if (!el || !s) return;
    if (s.turnLimit <= 0 || s.phase === 'done') { el.textContent = ''; return; }
    const left = Math.max(0, s.turnLimit - Math.floor((Date.now() - s.turnStartedAt) / 1000));
    el.textContent = `${left}초`;
    el.classList.toggle('urgent', left <= 5);
  }

  // ---- 숫자 패드 ----

  private openPad(who: string, position: number, pick: (num: number) => void): void {
    this.closePad();
    const nums = [...Array(MAX_NUM + 1).keys()];
    const back = document.createElement('div');
    back.className = 'dv-pad-back';
    back.innerHTML = `
      <div class="dv-pad">
        <div class="dv-pad-title">${escapeText(who)} 님의 ${position}번째 타일은?</div>
        <div class="dv-pad-grid">
          ${nums.map((n) => `<button data-num="${n}">${n}</button>`).join('')}
          <button data-num="${JOKER}">${JOKER_LABEL}</button>
        </div>
        <button class="dv-btn ghost dv-pad-cancel" data-cancel>취소</button>
      </div>`;
    back.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === back || t.hasAttribute('data-cancel')) { this.closePad(); return; }
      const num = t.getAttribute('data-num');
      if (num === null) return;
      this.closePad();
      pick(Number(num));
    });
    this.root.appendChild(back);
    this.root.classList.add('has-pad');
    this.pad = back;
  }

  private closePad(): void {
    this.pad?.remove();
    this.pad = null;
    this.root.classList.remove('has-pad');
  }
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
const escapeAttr = escapeText;
