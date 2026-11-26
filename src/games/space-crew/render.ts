/**
 * 스페이스 크루 렌더 — DOM
 *
 * 캔버스를 숨기고 그 부모에 붙인다(더 마인드·다빈치 코드와 같은 방식).
 * 카드·임무·통신 전부 눌러야 하는 것들이라 캔버스보다 DOM 이 맞다.
 *
 * 렌더러는 상태를 안 들고 있다. 받은 sync 를 그대로 그리고, 누가 뭘 할 수 있는지도
 * 전부 sync(phase, turnPeerId)가 정한다.
 */

import { commSlotsFor, legalPlays, sameCard, SUIT_LABEL, type Card, type CommSlot } from './rules';
import type { SyncPayload } from './netSync';

export interface ScCallbacks {
  onPickTask(index: number): void;
  onPlay(card: Card): void;
  onComm(card: Card, slot: CommSlot): void;
  onNext(go: boolean): void;
}

const SUIT_COLOR: Record<string, string> = {
  pink: '#e86a9a', blue: '#4d93e8', green: '#43b36b', yellow: '#e8b23a', rocket: '#2f4a46',
};

const CSS = `
.sc-screen{position:absolute;inset:0;display:flex;flex-direction:column;gap:12px;
  justify-content:safe center;align-items:center;padding:18px 16px;overflow-y:auto;
  font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif;}

.sc-top{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;width:100%;}
.sc-peer{background:rgba(255,255,255,.62);border:1.5px solid rgba(255,255,255,.8);border-radius:13px;
  padding:7px 11px;min-width:104px;box-shadow:0 4px 14px rgba(63,179,162,.14);}
.sc-peer.is-turn{border-color:#f5c33d;box-shadow:0 4px 18px rgba(245,195,61,.42);}
.sc-peer-name{font-size:12.5px;font-weight:800;color:#2f4a46;display:flex;align-items:center;gap:5px;}
.sc-peer-sub{font-size:11px;color:#6b8a85;font-weight:700;margin-top:2px;}
.sc-cmd{font-size:10px;font-weight:800;color:#8a6a10;background:#ffd96b;border-radius:999px;padding:1px 6px;}

.sc-mid{display:flex;flex-direction:column;align-items:center;gap:8px;}
.sc-trick{display:flex;gap:8px;min-height:72px;align-items:center;justify-content:center;}
.sc-trickslot{display:flex;flex-direction:column;align-items:center;gap:3px;}
.sc-trickwho{font-size:10px;color:#6b8a85;font-weight:700;}
.sc-info{font-size:12.5px;color:#6b8a85;font-weight:700;display:flex;gap:12px;}
.sc-news{font-size:14px;font-weight:800;color:#2f4a46;min-height:20px;text-align:center;}

/* 카드 */
.sc-card{width:46px;height:64px;border-radius:9px;border:2px solid transparent;background:#fffdf5;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
  font-weight:900;padding:0;flex:0 0 auto;transition:transform .12s ease,box-shadow .12s ease;}
.sc-card .n{font-size:20px;line-height:1;}
.sc-card .s{font-size:9px;font-weight:800;opacity:.75;}
.sc-card.pickable{cursor:pointer;}
/* 관전자용 — 여러 명 손패를 다 담아야 해서 작게 */
.sc-card.small{width:30px;height:42px;border-radius:7px;}
.sc-card.small .n{font-size:14px;}
.sc-card.small .s{font-size:7px;}
.sc-note{font-size:13px;font-weight:700;color:#5d7b76;text-align:center;padding:8px 0;}
.sc-spec-row{display:flex;align-items:center;gap:8px;margin-bottom:5px;}
.sc-spec-name{flex:0 0 76px;font-size:12px;font-weight:800;color:#5d7b76;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;}
.sc-spec-cards{display:flex;flex-wrap:wrap;gap:3px;}
/* 비활성 카드가 클릭을 삼키면 안 된다 — 임무 칸(.sc-task) 안에 카드가 들어있어서,
   disabled 버튼이 가운데를 덮으면 칸 자체를 못 누른다(disabled 는 이벤트를 전파하지 않는다). */
.sc-card:disabled{pointer-events:none;}
.sc-card.pickable:hover{transform:translateY(-6px);box-shadow:0 8px 16px rgba(42,148,136,.3);}
.sc-card.dim{opacity:.34;}
.sc-card.sm{width:34px;height:46px;}
.sc-card.sm .n{font-size:15px;}
.sc-card.sm .s{font-size:8px;}

/* 임무 */
.sc-tasks{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
.sc-task{display:flex;flex-direction:column;align-items:center;gap:3px;background:rgba(255,255,255,.6);
  border:1.5px solid #cfe3df;border-radius:11px;padding:6px 8px;}
.sc-task.is-done{opacity:.45;}
.sc-task.pickable{cursor:pointer;border-color:#2a9488;}
.sc-task.pickable:hover{background:#ddf2ef;}
.sc-task-who{font-size:10.5px;font-weight:800;color:#2a9488;}
.sc-task-ord{font-size:10px;font-weight:900;color:#fff;background:#2a9488;border-radius:999px;
  width:16px;height:16px;display:flex;align-items:center;justify-content:center;}

/* 통신 공개물 */
.sc-comms{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}
.sc-comm{display:flex;flex-direction:column;align-items:center;gap:2px;}
.sc-comm-dot{font-size:10px;font-weight:800;color:#2a9488;}
.sc-comm.spent{opacity:.4;}

.sc-hand{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;max-width:720px;}
.sc-label{font-size:12px;font-weight:800;color:#6b8a85;}
.sc-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
.sc-btn{border:none;border-radius:999px;padding:9px 20px;font-size:14px;font-weight:800;cursor:pointer;
  font-family:inherit;background:#2a9488;color:#fff;transition:filter .12s ease,transform .12s ease;}
.sc-btn:hover{filter:brightness(1.07);transform:translateY(-1px);}
.sc-btn.ghost{background:rgba(255,255,255,.75);color:#2f4a46;border:1.5px solid #cfe3df;}

/* 통신 패널 */
.sc-commbar{display:flex;flex-direction:column;align-items:center;gap:6px;background:rgba(255,255,255,.72);
  border:1.5px solid #cfe3df;border-radius:14px;padding:10px 14px;}
.sc-slotrow{display:flex;gap:6px;}
.sc-slot{border:1.5px solid #cfe3df;background:#fffdf5;border-radius:9px;padding:6px 12px;
  font-size:12.5px;font-weight:800;color:#2f4a46;cursor:pointer;font-family:inherit;}
.sc-slot:hover{background:#ddf2ef;border-color:#2a9488;}

/* 미션 브리핑 */
.sc-brief{background:rgba(255,255,255,.8);border:1.5px solid #cfe3df;border-radius:16px;
  padding:18px 22px;text-align:center;max-width:460px;}
.sc-brief-no{font-size:22px;font-weight:900;color:#2f4a46;}
.sc-brief-sum{font-size:13.5px;color:#6b8a85;font-weight:700;margin-top:6px;line-height:1.6;}

@media(prefers-reduced-motion:reduce){ .sc-card,.sc-btn{transition:none;} }
`;

export class ScRenderer {
  private canvas: HTMLCanvasElement;
  private cb: ScCallbacks;
  private root: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private last: SyncPayload | null = null;
  private myId = '';
  /** 통신하려고 고른 카드 — 위치를 고르는 중 */
  private commPick: Card | null = null;

  constructor(canvas: HTMLCanvasElement, cb: ScCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    canvas.style.display = 'none';
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = CSS;
    document.head.appendChild(this.styleEl);
    this.root = document.createElement('div');
    this.root.className = 'sc-screen';
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(this.root);
    }
  }

  render(s: SyncPayload, myId: string): void {
    this.last = s;
    this.myId = myId;
    if (s.phase !== 'play') this.commPick = null;
    this.paint();
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  // ---- 조각들 ----

  private cardHTML(c: Card, cls = '', attrs = ''): string {
    const color = SUIT_COLOR[c.suit] ?? '#2f4a46';
    const label = c.suit === 'rocket' ? '로켓' : SUIT_LABEL[c.suit];
    return `<button class="sc-card ${cls}" style="border-color:${color};color:${color}"${attrs}
      ${cls.includes('pickable') ? '' : 'disabled'}>
      <span class="n">${c.num}</span><span class="s">${label}</span></button>`;
  }

  private peersHTML(s: SyncPayload): string {
    return s.players.map((p) => {
      const mine = p.peerId === this.myId;
      const turn = p.peerId === s.turnPeerId && (s.phase === 'play' || s.phase === 'pick');
      return `<div class="sc-peer ${turn ? 'is-turn' : ''}">
        <div class="sc-peer-name">${esc(p.nickname)}${mine ? ' (나)' : ''}
          ${p.peerId === s.commanderId ? '<span class="sc-cmd">사령관</span>' : ''}</div>
        <div class="sc-peer-sub">${p.handCount}장 · ${commLabel(s, p.commLeft)}</div>
      </div>`;
    }).join('');
  }

  private tasksHTML(s: SyncPayload): string {
    const picking = s.phase === 'pick' && s.turnPeerId === this.myId;
    const open = s.tasks.filter((t) => t.ownerId === null);
    return s.tasks.map((t) => {
      const openIdx = open.findIndex((o) => sameCard(o.card, t.card));
      const canPick = picking && t.ownerId === null;
      const who = t.ownerId === null ? '미정'
        : (s.players.find((p) => p.peerId === t.ownerId)?.nickname ?? '');
      return `<div class="sc-task ${t.done ? 'is-done' : ''} ${canPick ? 'pickable' : ''}"
        ${canPick ? `data-task="${openIdx}"` : ''}>
        ${t.order !== null ? `<span class="sc-task-ord">${t.order}</span>` : ''}
        ${this.cardHTML(t.card, 'sm')}
        <span class="sc-task-who">${t.done ? '완료' : esc(who)}</span>
      </div>`;
    }).join('');
  }

  private handHTML(s: SyncPayload): string {
    // 관전자 — 내 손패가 없고 전원의 패가 온다. 사람별로 한 줄씩 보여준다.
    if (s.specHands) {
      return s.specHands.map((h) => `
        <div class="sc-spec-row">
          <span class="sc-spec-name">${esc(h.nickname)}</span>
          <span class="sc-spec-cards">${h.cards.map((c) => this.cardHTML(c, 'small', '')).join('')}</span>
        </div>`).join('');
    }
    const myTurn = s.phase === 'play' && s.turnPeerId === this.myId;
    const playable = myTurn ? legalPlays(s.myHand, s.led) : [];
    const commMode = this.commPick === null && this.canCommunicate(s);
    return s.myHand.map((c) => {
      const canPlay = playable.some((p) => sameCard(p, c));
      const canComm = commMode && commSlotsFor(s.myHand, c).length > 0;
      const cls = canPlay ? 'pickable' : (canComm ? 'pickable' : (myTurn ? 'dim' : ''));
      const attr = canPlay ? ` data-play="${c.suit}:${c.num}"`
        : (canComm ? ` data-comm="${c.suit}:${c.num}"` : '');
      return this.cardHTML(c, cls, attr);
    }).join('');
  }

  /** 지금 통신을 쓸 수 있는 상태인가 — 규칙은 호스트가 최종 판정하지만 화면도 같이 막는다 */
  private canCommunicate(s: SyncPayload): boolean {
    if (s.phase !== 'play' || s.commBanned) return false;
    if (s.trick.length > 0) return false;
    if (s.trickNo <= s.commBlockTricks) return false;
    return s.players.find((p) => p.peerId === this.myId)?.commLeft === true;
  }

  private commsHTML(s: SyncPayload): string {
    if (s.comms.length === 0) return '';
    const slotLabel: Record<string, string> = { top: '▲ 최고', middle: '● 하나뿐', bottom: '▼ 최저' };
    return `<div class="sc-comms">${s.comms.map((c) => {
      const who = s.players.find((p) => p.peerId === c.peerId)?.nickname ?? '';
      return `<div class="sc-comm ${c.spent ? 'spent' : ''}">
        <span class="sc-comm-dot">${esc(who)}</span>
        ${this.cardHTML(c.card, 'sm')}
        <span class="sc-comm-dot">${c.slot ? slotLabel[c.slot] : '?'}</span>
      </div>`;
    }).join('')}</div>`;
  }

  private actionsHTML(s: SyncPayload): string {
    // 관전자는 버튼을 누를 수 없다 — specHands 가 오는 것 = 내가 관전 중이라는 뜻
    if (s.specHands) {
      if (s.phase === 'brief') return `<div class="sc-note">크루가 시작하기를 기다리는 중이에요</div>`;
      if (s.phase === 'over') return `<div class="sc-note">다음 미션을 기다리는 중이에요</div>`;
      return '';
    }
    if (s.phase === 'brief') {
      return `<div class="sc-actions">
        <button class="sc-btn" data-next="1">시작</button>
        <button class="sc-btn ghost" data-next="0">그만하기</button></div>`;
    }
    if (s.phase === 'over') {
      const ok = s.result?.ok === true;
      return `<div class="sc-actions">
        <button class="sc-btn" data-next="1">${ok ? '다음 미션' : '다시 도전'}</button>
        <button class="sc-btn ghost" data-next="0">그만하기</button></div>`;
    }
    if (this.commPick) {
      const slots = commSlotsFor(s.myHand, this.commPick);
      const label: Record<string, string> = { top: '이 색 중 최고', middle: '이 색은 이것뿐', bottom: '이 색 중 최저' };
      // 데드존이면 위치를 못 고른다 — 아무거나 눌러도 카드만 공개된다
      const opts = s.deadZone ? (['middle'] as CommSlot[]) : slots;
      return `<div class="sc-commbar">
        <span class="sc-label">${s.deadZone ? '위치 표시 없이 공개돼요' : '토큰을 어디에 둘까요?'}</span>
        <div class="sc-slotrow">${opts.map((sl) =>
          `<button class="sc-slot" data-slot="${sl}">${s.deadZone ? '공개' : label[sl]}</button>`).join('')}
        </div>
        <button class="sc-btn ghost" data-commcancel>취소</button>
      </div>`;
    }
    if (s.phase === 'play' && s.turnPeerId === this.myId) {
      return `<span class="sc-label">낼 카드를 고르세요${this.canCommunicate(s) ? ' (또는 통신할 카드)' : ''}</span>`;
    }
    if (s.phase === 'pick' && s.turnPeerId === this.myId) {
      return `<span class="sc-label">맡을 임무를 고르세요</span>`;
    }
    const who = s.players.find((p) => p.peerId === s.turnPeerId)?.nickname ?? '';
    return `<span class="sc-label">${esc(who)} 님 차례예요</span>`;
  }

  private paint(): void {
    const s = this.last;
    if (!s) return;

    if (s.phase === 'brief') {
      this.root.innerHTML = `
        <div class="sc-brief">
          <div class="sc-brief-no">미션 ${s.mission}</div>
          <div class="sc-brief-sum">${esc(briefText(s))}</div>
        </div>
        ${this.actionsHTML(s)}`;
      this.wire();
      return;
    }

    const trickHTML = s.trick.map((t) => {
      const who = s.players.find((p) => p.peerId === t.peerId)?.nickname ?? '';
      return `<div class="sc-trickslot">${this.cardHTML(t.card)}<span class="sc-trickwho">${esc(who)}</span></div>`;
    }).join('');

    this.root.innerHTML = `
      <div class="sc-top">${this.peersHTML(s)}</div>
      <div class="sc-tasks">${this.tasksHTML(s)}</div>
      ${this.commsHTML(s)}
      <div class="sc-mid">
        <div class="sc-info">
          <span>트릭 ${s.trickNo} / ${s.trickTotal}</span>
          ${s.led ? `<span>선 색 ${SUIT_LABEL[s.led]}</span>` : ''}
        </div>
        <div class="sc-trick">${trickHTML || '<span class="sc-label">첫 카드를 기다리는 중</span>'}</div>
        <div class="sc-news">${esc(s.news)}</div>
      </div>
      <div class="sc-label">내 손패</div>
      <div class="sc-hand">${this.handHTML(s)}</div>
      ${this.actionsHTML(s)}
    `;
    this.wire();
  }

  private wire(): void {
    const s = this.last;
    if (!s) return;
    const q = <T extends HTMLElement>(sel: string): NodeListOf<T> => this.root.querySelectorAll<T>(sel);

    q<HTMLButtonElement>('[data-next]').forEach((b) => {
      b.addEventListener('click', () => this.cb.onNext(b.dataset['next'] === '1'));
    });
    q<HTMLElement>('[data-task]').forEach((b) => {
      b.addEventListener('click', () => this.cb.onPickTask(Number(b.dataset['task'])));
    });
    q<HTMLButtonElement>('[data-play]').forEach((b) => {
      b.addEventListener('click', () => this.cb.onPlay(parseCard(b.dataset['play']!)));
    });
    q<HTMLButtonElement>('[data-comm]').forEach((b) => {
      b.addEventListener('click', () => { this.commPick = parseCard(b.dataset['comm']!); this.paint(); });
    });
    q<HTMLButtonElement>('[data-slot]').forEach((b) => {
      b.addEventListener('click', () => {
        const card = this.commPick;
        if (!card) return;
        this.commPick = null;
        this.cb.onComm(card, b.dataset['slot'] as CommSlot);
      });
    });
    this.root.querySelector('[data-commcancel]')?.addEventListener('click', () => {
      this.commPick = null;
      this.paint();
    });
  }
}

/**
 * 통신 상태 문구.
 * 통신 금지 미션에서 "통신 가능" 이라고 떠 있으면 거짓말이 된다 —
 * 토큰을 안 썼을 뿐 쓸 수 있는 게 아니다.
 */
function commLabel(s: SyncPayload, left: boolean): string {
  if (s.commBanned) return '통신 금지';
  return left ? '통신 가능' : '통신 씀';
}

function briefText(s: SyncPayload): string {
  const bits = [`임무 ${s.taskCount}개`];
  if (s.orderMode === 'arrow') bits.push('일부는 순서대로');
  if (s.orderMode === 'strict') bits.push('번호 순서대로');
  if (s.commBanned) bits.push('통신 금지');
  else if (s.deadZone) bits.push('통신은 되지만 위치 표시 없음');
  else if (s.commBlockTricks > 0) bits.push(`${s.commBlockTricks}트릭 동안 통신 금지`);
  return bits.join(' · ');
}

function parseCard(v: string): Card {
  const [suit, num] = v.split(':');
  return { suit: suit as Card['suit'], num: Number(num) };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
