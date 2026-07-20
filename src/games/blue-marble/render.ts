/**
 * 블루마블 HTML 렌더러. 캔버스 대신 부모(ctx.canvas.parentElement)에 DOM 보드를 마운트한다.
 *   - 보드는 constructor 에서 1회 생성, render(state) 에서 동적 부분(건물/말/센터/패널/모달)만 갱신.
 *   - 결정 모달(구매/건설/인수/카드)은 state.pending + 현재 차례가 나인지로 표시.
 *   - 아이콘/건물은 전부 인라인 SVG (프로젝트 방침: 이모지 X).
 */

import {
  BOARD, BUILD_TYPES, ISLAND_TILES, BASE_TOLL_MUL, DESERT_ESCAPE,
  buildMeta, buildCostOf, acquireCost, islandCount, seaIslandCount, hasAllHouses, canBuild, SALARY,
  colorMonopolyMul, ownsGroup, tollBreakdown,
  type BMState, type BuildKind, type GroupColor,
} from './rules';

export interface BMRenderCallbacks {
  onRoll(): void;
  onDesertPay(): void;                   // 무인도: 돈 내고 탈출
  onDecision(accept: boolean): void;   // 구매/인수 예/아니오
  onBuildConfirm(builds: BuildKind[]): void;  // 선택한 건물들 확정 건설 + 턴 종료(빈 배열 = 그냥 완료)
  onCard(keep: boolean): void;          // 황금열쇠 보관/사용
  onUseHeld(cardId: number): void;
  onPickCity(tile: number): void;       // 올림픽 개최 / 추가 건설: 내 도시 선택
  onTravelTo(tile: number): void;       // 세계여행: 목적지 칸 선택
  onEventOk(): void;                    // 세금 등 이벤트 창 확인
  onBonusStart(stake: number): void;    // 오락실: 판돈 걸고 시작(0=안 함)
  onBonusPick(choice: number): void;    // 오락실 2지선다
  onBonusStop(): void;                  // 오락실: 받고 종료
  /** 주사위·이동 시퀀스가 끝나 화면이 idle 이 됨(호스트가 더미 진행 타이밍에 사용) */
  onSettled(): void;
}

const GROUP: Record<GroupColor, string> = {
  tan: '#d9b38c', sky: '#8fc2f0', pink: '#ff9bbb', orange: '#ffb27a', red: '#ff8a8a',
  yellow: '#f2d24c', green: '#8fe0b0', rose: '#e79ad0', teal: '#7fd6d0', navy: '#8a9ef0',
};
const ISLAND_GRAD = 'linear-gradient(155deg,#5fcdf2 0%,#2b8fce 100%)';   // 섬(파랑, 개수 기반)
const BEACH_GRAD = 'linear-gradient(155deg,#ff9c86 0%,#e8503f 100%)';    // 해변(붉은, 방문 기반)
const tileColor = (i: number): string => {
  const t = BOARD[i];
  if (t.type === 'island') return t.spot === 'beach' ? BEACH_GRAD : ISLAND_GRAD;
  return t.type === 'city' ? GROUP[t.group] : '#ccc';
};

// ── 아이콘 (코너/특수/카드) ──
const IC: Record<string, string> = {
  flag: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="2.2" height="18" rx="1.1" fill="#8a7a8a"/><path d="M7.2 4 H18 L15 8 L18 12 H7.2 Z" fill="#57c777" stroke="#3f9e57" stroke-width="0.6"/></svg>',
  island: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="19" rx="9" ry="2.6" fill="#c99a52"/><path d="M11.5 18 V9" stroke="#8a6a4a" stroke-width="1.8"/><path d="M11.5 8.5 C8.5 6 6 7 4.5 9.5 C7.5 8.5 9 9.5 11.5 9.5 C14 7 17 7 19 9.5 C17 6 14 6 11.5 8.5Z" fill="#57c777"/></svg>',
  // 무인도 — 표류(SOS 깃발) 섬 (관광지 아이콘과 구분)
  sos: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="20" rx="10" ry="2.4" fill="#c99a52"/><path d="M8 19 V8" stroke="#7a5a38" stroke-width="1.6"/><path d="M8 8 h7 l-2 2.2 2 2.2 h-7 Z" fill="#ee334e" stroke="#c31f38" stroke-width="0.7" stroke-linejoin="round"/><path d="M4 19 q2 -3 4 -3 M20 19 q-2 -3 -4 -3" stroke="#57c777" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
  // 관광지(섬) — 해변 파라솔 (무인도 야자섬과 구분)
  parasol: '<svg viewBox="0 0 24 24"><path d="M12 20 V10" stroke="#8a6b4a" stroke-width="1.6" stroke-linecap="round"/><path d="M12 4.5 C6.5 4.5 3 8.5 3 11 H21 C21 8.5 17.5 4.5 12 4.5Z" fill="#ff5a92" stroke="#d63f74" stroke-width="0.8" stroke-linejoin="round"/><path d="M12 4.5 C10 4.5 9 8 9 11 M12 4.5 C14 4.5 15 8 15 11" stroke="#fff" stroke-width="1" fill="none"/><circle cx="12" cy="4.5" r="1" fill="#ffd454"/><path d="M12 20 q2 0 2.4 -1.6" stroke="#8a6b4a" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  // 올림픽 오륜기
  rings: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.7"><circle cx="6.5" cy="9.5" r="3.3" stroke="#0081c8"/><circle cx="12" cy="9.5" r="3.3" stroke="#1a1a1a"/><circle cx="17.5" cy="9.5" r="3.3" stroke="#ee334e"/><circle cx="9.25" cy="14" r="3.3" stroke="#f9a01b"/><circle cx="14.75" cy="14" r="3.3" stroke="#00a651"/></svg>',
  gift: '<svg viewBox="0 0 24 24"><rect x="4.5" y="10" width="15" height="10" rx="1.5" fill="#ff9bbb"/><rect x="4.5" y="8" width="15" height="4" rx="1" fill="#ff7aa5"/><rect x="10.5" y="8" width="3" height="12" fill="#fff" opacity=".85"/><path d="M12 8 C10 4.5 6.5 5.5 8 8 M12 8 C14 4.5 17.5 5.5 16 8" stroke="#ff7aa5" stroke-width="1.6" fill="none"/></svg>',
  torch: '<svg viewBox="0 0 24 24"><rect x="10.4" y="12" width="3.2" height="9" rx="1" fill="#b98a4a" stroke="#8a5f2a" stroke-width="0.8"/><path d="M12 2 C15.2 6 16.2 8.4 15 11.2 C14.2 13.2 9.8 13.2 9 11.2 C7.8 8.4 8.8 6 12 2 Z" fill="#ff8a1c" stroke="#e0640f" stroke-width="0.8" stroke-linejoin="round"/><path d="M12 5 C13.6 7.6 14 9.2 13.2 10.8 C12.8 11.8 11.2 11.8 10.8 10.8 C10 9.2 10.4 7.6 12 5 Z" fill="#ffd454"/></svg>',
  rocket: '<svg viewBox="0 0 24 24"><path d="M12 2.5 C16 5.5 16 11 14 15 H10 C8 11 8 5.5 12 2.5Z" fill="#9cc6f2" stroke="#5b9be6" stroke-width="1"/><circle cx="12" cy="8" r="1.9" fill="#fff"/><path d="M10 14 L7.5 18.5 L10.2 16.5Z M14 14 L16.5 18.5 L13.8 16.5Z" fill="#ff8a5b"/><path d="M11 15 h2 l-1 4.5Z" fill="#ffb845"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8.5" cy="8.5" r="4.6" fill="none" stroke="#f2c94c" stroke-width="2.6"/><path d="M11.5 11.5 L19 19 M16 16 l2 2 M18.5 13.5 l1.5 1.5" stroke="#f2c94c" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>',
  coin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="#f2c94c" stroke="#d9a93c" stroke-width="1.3"/><text x="12" y="16" font-size="11" font-weight="900" fill="#8a5a00" text-anchor="middle" font-family="sans-serif">₩</text></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M9 5.5 L18 3.5 V15" stroke="#b89aff" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="7" cy="16.5" r="2.7" fill="#b89aff"/><circle cx="16" cy="15" r="2.7" fill="#b89aff"/></svg>',
  cake: '<svg viewBox="0 0 24 24"><rect x="5" y="12" width="14" height="8" rx="1.5" fill="#ff9bbb"/><rect x="5" y="12" width="14" height="3" fill="#fff" opacity=".7"/><rect x="11.2" y="6" width="1.6" height="4" fill="#ffd454"/><circle cx="12" cy="5" r="1.4" fill="#ff8a3b"/></svg>',
  ticket: '<svg viewBox="0 0 24 24"><path d="M4 8 h16 v3 a2 2 0 0 0 0 2 v3 h-16 v-3 a2 2 0 0 0 0-2Z" fill="#8fe0c3" stroke="#4fbf9a" stroke-width="1"/><path d="M11 8 v8" stroke="#4fbf9a" stroke-width="1" stroke-dasharray="2 2"/></svg>',
  cross: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4.5" fill="#ff8a8a"/><path d="M12 8 v8 M8 12 h8" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
  siren: '<svg viewBox="0 0 24 24"><rect x="5" y="18" width="14" height="3" rx="1.2" fill="#5b9be6"/><path d="M7 18 C7 12 9 9 12 9 C15 9 17 12 17 18Z" fill="#ff5a5a"/><rect x="11" y="5" width="2" height="3.4" rx="1" fill="#ff5a5a"/></svg>',
  dice: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4.5" fill="#fff" stroke="#c9b7d6" stroke-width="1.6"/><g fill="#ff5a92"><circle cx="8.5" cy="8.5" r="1.7"/><circle cx="15.5" cy="8.5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="8.5" cy="15.5" r="1.7"/><circle cx="15.5" cy="15.5" r="1.7"/></g></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#57c777"/><path d="M8 12.5 L11 15.5 L16.5 9" stroke="#fff" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12 H17 M13 8 L17 12 L13 16" stroke="#9a8a9a" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
/** 특수/코너 칸 → 아이콘 키 */
function tileIcon(i: number): string {
  const t = BOARD[i];
  if (t.type === 'corner') return { start: 'flag', desert: 'sos', welfare: 'rings', space: 'rocket' }[t.kind];
  if (t.type === 'special') return t.kind === 'goldkey' ? 'key' : t.kind === 'tax' ? 'coin' : 'music';
  return '';
}
/** 카드 id → 아이콘 키 */
const CARD_IC = ['coin', 'cake', 'ticket', 'cross', 'siren', 'flag', 'ticket', 'island', 'rocket'];

// ── 건물 SVG (소유자 색 currentColor) ──
const BSVG: Record<string, string> = {
  villa: '<svg viewBox="0 0 24 24" stroke="#241a30" stroke-width="1.4" stroke-linejoin="round"><rect x="6" y="13" width="12" height="8" fill="currentColor"/><path d="M4.5 13 L12 6.5 L19.5 13 Z" fill="currentColor"/><path d="M4.5 13 L12 6.5 L19.5 13 Z" fill="rgba(0,0,0,.15)" stroke="none"/><rect x="10.4" y="16" width="3.2" height="5" fill="#fff" stroke="none"/></svg>',
  house2: '<svg viewBox="0 0 24 24" stroke="#241a30" stroke-width="1.3" stroke-linejoin="round"><rect x="6.5" y="9" width="11" height="12" fill="currentColor"/><path d="M5 9 L12 3.5 L19 9 Z" fill="currentColor"/><path d="M5 9 L12 3.5 L19 9 Z" fill="rgba(0,0,0,.15)" stroke="none"/><g fill="#fff" stroke="none"><rect x="8" y="10.5" width="2.3" height="2.3"/><rect x="13.7" y="10.5" width="2.3" height="2.3"/></g><rect x="10.6" y="16" width="2.8" height="5" fill="#fff" stroke="none"/></svg>',
  apt: '<svg viewBox="0 0 24 24" stroke="#241a30" stroke-width="1.2" stroke-linejoin="round"><rect x="6" y="4" width="12" height="17" fill="currentColor"/><g fill="#fff" stroke="none" opacity=".95"><rect x="8" y="6" width="2.2" height="2.2"/><rect x="13.8" y="6" width="2.2" height="2.2"/><rect x="8" y="10" width="2.2" height="2.2"/><rect x="13.8" y="10" width="2.2" height="2.2"/><rect x="8" y="14" width="2.2" height="2.2"/><rect x="13.8" y="14" width="2.2" height="2.2"/></g><rect x="10.4" y="17.5" width="3.2" height="3.5" fill="#fff" stroke="none"/></svg>',
};
// 섬 소유 표시 — 깃발(천 = 플레이어색 currentColor)
const FLAG = '<svg viewBox="0 0 24 24"><rect x="6" y="2.5" width="2" height="19" rx="1" fill="#6b5566"/><circle cx="7" cy="2.6" r="1.7" fill="#ffd454"/><path d="M8 3.5 H20 Q16.8 6.5 20 9.5 H8 Z" fill="currentColor" stroke="#fff" stroke-width="1" stroke-linejoin="round"/></svg>';
// 올림픽 개최지 표시 — 성화(횃불)
const FANFARE = '<svg viewBox="0 0 24 24"><rect x="10.4" y="12" width="3.2" height="9" rx="1" fill="#b98a4a" stroke="#8a5f2a" stroke-width="0.8"/><path d="M12 2 C15.2 6 16.2 8.4 15 11.2 C14.2 13.2 9.8 13.2 9 11.2 C7.8 8.4 8.8 6 12 2 Z" fill="#ff8a1c" stroke="#e0640f" stroke-width="0.8" stroke-linejoin="round"/><path d="M12 5 C13.6 7.6 14 9.2 13.2 10.8 C12.8 11.8 11.2 11.8 10.8 10.8 C10 9.2 10.4 7.6 12 5 Z" fill="#ffd454"/></svg>';
// 세계여행 비행기 (오른쪽을 향함 — 진행방향으로 회전)
const PLANE = '<svg viewBox="0 0 48 48"><path d="M4 26 L40 20 L44 22 L40 24 L30 30 L22 29 L26 24 L16 25 L11 30 L7 29 L10 24 L4 26 Z" fill="#5b9be6" stroke="#2e5f96" stroke-width="1.4" stroke-linejoin="round"/><circle cx="35" cy="22" r="1.6" fill="#fff"/></svg>';

// ── 모서리/특수칸 칸-전체 일러스트 (viewBox 130) ──
const ILL: Record<string, { svg: string; dark: boolean }> = {
  start: { dark: false, svg: `<svg class="bm-illsvg" viewBox="0 0 130 130" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="ilS" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c7f5e4"/><stop offset="1" stop-color="#9fe8ff"/></linearGradient></defs><rect width="130" height="130" fill="url(#ilS)"/><g opacity=".9"><circle cx="26" cy="30" r="3" fill="#fff"/><circle cx="104" cy="26" r="4" fill="#fff"/><circle cx="108" cy="92" r="3" fill="#fff"/></g><path d="M84 46 h-22 v-11 l-22 19 l22 19 v-11 h22 z" fill="#ff5a92" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/><text x="65" y="106" text-anchor="middle" font-size="30" font-weight="900" fill="#2e9370" style="letter-spacing:-1px">GO!</text></svg>` },
  olympic: { dark: true, svg: `<svg class="bm-illsvg" viewBox="0 0 130 130" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="ilO" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6df"/><stop offset="1" stop-color="#ffe6ad"/></linearGradient></defs><rect width="130" height="130" fill="url(#ilO)"/><path d="M30 96 q35 -20 70 0" stroke="#e0b850" stroke-width="3" fill="none" opacity=".6"/><g fill="none" stroke-width="4"><circle cx="42" cy="52" r="13" stroke="#0081c8"/><circle cx="65" cy="52" r="13" stroke="#222"/><circle cx="88" cy="52" r="13" stroke="#ee334e"/><circle cx="53.5" cy="65" r="13" stroke="#f9a01b"/><circle cx="76.5" cy="65" r="13" stroke="#00a651"/></g><path d="M20 28 l3 7 7 .6 -5.4 4.7 1.7 7 -6.3 -3.7 -6.3 3.7 1.7 -7 -5.4 -4.7 7 -.6z" fill="#ffcf4a"/></svg>` },
  travel: { dark: true, svg: `<svg class="bm-illsvg" viewBox="0 0 130 130" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="ilT" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bfe6ff"/><stop offset="1" stop-color="#eaf7ff"/></linearGradient></defs><rect width="130" height="130" fill="url(#ilT)"/><g fill="#fff" opacity=".85"><ellipse cx="32" cy="96" rx="16" ry="7"/><ellipse cx="99" cy="102" rx="13" ry="6"/><ellipse cx="104" cy="32" rx="12" ry="5"/></g><path d="M16 98 Q52 38 112 28" stroke="#5b9be6" stroke-width="2.2" stroke-dasharray="3 5" fill="none" opacity=".55" stroke-linecap="round"/><g transform="translate(65 63) rotate(32)"><path d="M-6.5 -14 Q-6.5 -30 0 -34 Q6.5 -30 6.5 -14 L5.5 20 Q4.5 31 0 35 Q-4.5 31 -5.5 20 Z" fill="#fff" stroke="#5b9be6" stroke-width="2.4" stroke-linejoin="round"/><path d="M-5 -4 L-35 9 L-35 16 L-5 9 Z" fill="#9cc6f2" stroke="#5b9be6" stroke-width="1.8" stroke-linejoin="round"/><path d="M5 -4 L35 9 L35 16 L5 9 Z" fill="#9cc6f2" stroke="#5b9be6" stroke-width="1.8" stroke-linejoin="round"/><path d="M-4 22 L-15 28 L-15 32 L-4 27 Z" fill="#7fb2ea" stroke="#5b9be6" stroke-width="1.5" stroke-linejoin="round"/><path d="M4 22 L15 28 L15 32 L4 27 Z" fill="#7fb2ea" stroke="#5b9be6" stroke-width="1.5" stroke-linejoin="round"/><path d="M-6.5 -14 Q-6.5 -30 0 -34 Q6.5 -30 6.5 -14 Z" fill="#ff8fb0"/></g></svg>` },
  desert: { dark: true, svg: `<svg class="bm-illsvg" viewBox="0 0 130 130" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="ilD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd6ef"/><stop offset="1" stop-color="#4fb3dd"/></linearGradient></defs><rect width="130" height="130" fill="url(#ilD)"/><path d="M0 92 q20 -6 34 0 t34 0 t34 0 t28 0 V130 H0Z" fill="#5fc0e0"/><ellipse cx="65" cy="98" rx="34" ry="12" fill="#e9c483"/><path d="M62 96 V70" stroke="#8a5a34" stroke-width="4"/><path d="M62 70 q-14 -8 -24 -2 q10 -6 24 2 q0 -12 14 -16 q-10 8 -14 16 q10 -6 22 0 q-12 -4 -22 0z" fill="#3fae79"/><rect x="82" y="60" width="2.6" height="20" fill="#b06a4a"/><path d="M84 60 h12 l-3 4 3 4 h-12z" fill="#ee334e"/></svg>` },
  tax: { dark: true, svg: `<svg class="bm-illsvg" viewBox="0 0 130 130" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="ilTx" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe0e0"/><stop offset="1" stop-color="#ffc2c2"/></linearGradient></defs><rect width="130" height="130" fill="url(#ilTx)"/><rect x="40" y="30" width="42" height="54" rx="4" fill="#fff" stroke="#e88" stroke-width="2"/><g stroke="#f2a0a0" stroke-width="2.4" stroke-linecap="round"><path d="M48 42h26M48 50h26M48 58h18"/></g><circle cx="84" cy="74" r="16" fill="#ff5a5a"/><text x="84" y="80" text-anchor="middle" font-size="15" font-weight="900" fill="#fff">%</text><g fill="#ffd454" stroke="#e0a91c" stroke-width="1.5"><ellipse cx="44" cy="96" rx="10" ry="4"/><ellipse cx="44" cy="92" rx="10" ry="4"/></g></svg>` },
  bonus: { dark: false, svg: `<svg class="bm-illsvg" viewBox="0 0 130 130" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="ilB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#efe1ff"/><stop offset="1" stop-color="#d3b8ff"/></linearGradient></defs><rect width="130" height="130" fill="url(#ilB)"/><rect x="34" y="34" width="62" height="52" rx="8" fill="#8a5fd0"/><rect x="40" y="42" width="50" height="24" rx="4" fill="#fff"/><g font-size="17" font-weight="900" fill="#ff5a92" text-anchor="middle"><text x="52" y="60">7</text><text x="65" y="60">7</text><text x="78" y="60">7</text></g><rect x="46" y="72" width="38" height="7" rx="3.5" fill="#ffd454"/><circle cx="100" cy="58" r="7" fill="#ff5a92"/><rect x="97" y="58" width="6" height="18" rx="3" fill="#c93d73"/></svg>` },
  key: { dark: true, svg: `<svg class="bm-illsvg" viewBox="0 0 130 130" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="ilK" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff4d6"/><stop offset="1" stop-color="#ffe19c"/></linearGradient></defs><rect width="130" height="130" fill="url(#ilK)"/><g transform="rotate(-38 65 62)"><circle cx="65" cy="44" r="15" fill="none" stroke="#f2b01c" stroke-width="8"/><rect x="61" y="56" width="8" height="34" rx="2" fill="#f2b01c"/><rect x="69" y="76" width="10" height="7" rx="2" fill="#f2b01c"/><rect x="69" y="86" width="8" height="7" rx="2" fill="#f2b01c"/></g><g fill="#fff"><path d="M96 34 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z"/><circle cx="34" cy="92" r="3"/></g></svg>` },
};
/** 칸 index → 전체 일러스트 (모서리/특수). 없으면 null */
function tileIll(i: number): { svg: string; dark: boolean } | null {
  const t = BOARD[i];
  if (t.type === 'corner') return ILL[{ start: 'start', desert: 'desert', welfare: 'olympic', space: 'travel' }[t.kind]] ?? null;
  if (t.type === 'special') return t.kind === 'tax' ? ILL.tax! : t.kind === 'bonus' ? ILL.bonus! : t.kind === 'goldkey' ? ILL.key! : null;
  return null;
}
const GENERIC_LM = '<svg viewBox="0 0 24 24" stroke="#241a30" stroke-width="0.9" stroke-linejoin="round"><path d="M12 1 L14 5.5 H10 Z" fill="#ffd454" stroke="#241a30" stroke-width="0.6"/><rect x="8.5" y="6" width="7" height="15" fill="currentColor"/><rect x="8.5" y="6" width="7" height="2.6" fill="#ffd454" stroke="none"/><rect x="6" y="18" width="12" height="3" fill="currentColor"/><g fill="#fff" stroke="none" opacity=".9"><rect x="10" y="10" width="4" height="2"/><rect x="10" y="13.5" width="4" height="2"/></g></svg>';
const LM_ATTR = 'viewBox="0 0 24 24" stroke="#241a30" stroke-width="0.9" stroke-linejoin="round"';
const LANDMARK: Record<string, string> = {
  '카이로': `<svg ${LM_ATTR}><path d="M12 3 L21 21 H3 Z" fill="currentColor"/><path d="M12 3 L12 21" stroke="rgba(0,0,0,.14)"/></svg>`,
  '아테네': `<svg ${LM_ATTR}><path d="M3 9 L12 4 L21 9 Z" fill="currentColor"/><g fill="currentColor" stroke="none"><rect x="5" y="10.5" width="2.2" height="8.5"/><rect x="9" y="10.5" width="2.2" height="8.5"/><rect x="12.8" y="10.5" width="2.2" height="8.5"/><rect x="16.8" y="10.5" width="2.2" height="8.5"/></g><rect x="3.5" y="19" width="17" height="2" fill="currentColor"/></svg>`,
  '로마': `<svg ${LM_ATTR}><rect x="3.5" y="8" width="17" height="12.5" rx="4" fill="currentColor"/><g fill="#fff" stroke="none" opacity=".85"><rect x="5.5" y="10" width="2.2" height="3.4" rx="1"/><rect x="9" y="10" width="2.2" height="3.4" rx="1"/><rect x="12.8" y="10" width="2.2" height="3.4" rx="1"/><rect x="16.3" y="10" width="2.2" height="3.4" rx="1"/></g></svg>`,
  '파리': `<svg ${LM_ATTR}><path d="M12 2 L14.6 21 H13 L12.5 16 H11.5 L11 21 H9.4 Z" fill="currentColor"/><path d="M9.5 15 H14.5" stroke="currentColor" stroke-width="1.4"/><path d="M8.2 20.5 Q12 16 15.8 20.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
  '런던': `<svg ${LM_ATTR}><rect x="9" y="7" width="6" height="14" fill="currentColor"/><path d="M8.5 7 L12 2.5 L15.5 7 Z" fill="currentColor"/><circle cx="12" cy="10" r="2.1" fill="#fff" stroke="none"/></svg>`,
  '시드니': `<svg ${LM_ATTR}><path d="M2.5 20 Q6 8 9 20 Z" fill="currentColor"/><path d="M7 20 Q12 5 15 20 Z" fill="currentColor"/><path d="M12.5 20 Q17.5 9 21.5 20 Z" fill="currentColor"/><rect x="2" y="20" width="20" height="1.8" fill="currentColor"/></svg>`,
  '리우': `<svg ${LM_ATTR}><path d="M6 21 Q12 17 18 21 Z" fill="currentColor"/><rect x="11.3" y="6" width="1.4" height="10" fill="currentColor" stroke="none"/><rect x="7" y="8.5" width="10" height="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="4.5" r="1.7" fill="currentColor"/></svg>`,
  '도쿄': `<svg ${LM_ATTR}><path d="M12 2 L15 21 H13 L12.5 16 H11.5 L11 21 H9 Z" fill="currentColor"/><path d="M10 14 H14" stroke="currentColor" stroke-width="1.2"/><rect x="11.2" y="2" width="1.6" height="2.5" fill="#ffd454" stroke="none"/></svg>`,
  '뉴욕': `<svg ${LM_ATTR}><rect x="9" y="18" width="6" height="3.5" fill="currentColor"/><path d="M10 18 L10.8 9 H13.2 L14 18 Z" fill="currentColor"/><circle cx="12" cy="6.5" r="2" fill="currentColor"/><g fill="currentColor" stroke="none"><rect x="11.6" y="2.5" width="0.8" height="2"/><rect x="10" y="3.5" width="0.8" height="1.6"/><rect x="13.2" y="3.5" width="0.8" height="1.6"/></g></svg>`,
  '서울': `<svg ${LM_ATTR}><rect x="11.2" y="9" width="1.6" height="12" fill="currentColor" stroke="none"/><ellipse cx="12" cy="8.5" rx="4" ry="2.4" fill="currentColor"/><rect x="11.4" y="2.5" width="1.2" height="4" fill="currentColor" stroke="none"/><path d="M8 21 H16" stroke="currentColor" stroke-width="1.4"/></svg>`,
  '이스탄불': `<svg ${LM_ATTR}><path d="M6 20 V13 Q6 8 12 8 Q18 8 18 13 V20 Z" fill="currentColor"/><path d="M12 8 V4.5" stroke="currentColor" stroke-width="1"/><circle cx="12" cy="4" r="1" fill="currentColor"/><rect x="3.5" y="10" width="1.8" height="10" fill="currentColor"/><rect x="18.7" y="10" width="1.8" height="10" fill="currentColor"/></svg>`,
  '베이징': `<svg ${LM_ATTR}><path d="M4 8 L12 4 L20 8 Z" fill="currentColor"/><path d="M5 13 L12 10 L19 13 Z" fill="currentColor"/><rect x="8" y="13" width="8" height="8" fill="currentColor"/><rect x="11" y="16" width="2" height="5" fill="#fff" stroke="none"/></svg>`,
};
const landmarkSvg = (name: string): string => LANDMARK[name] || GENERIC_LM;

function diceFace(n: number): string {
  const P: Record<number, number[][]> = {
    1: [[12, 12]], 2: [[7.5, 7.5], [16.5, 16.5]], 3: [[7.5, 7.5], [12, 12], [16.5, 16.5]],
    4: [[7.5, 7.5], [16.5, 7.5], [7.5, 16.5], [16.5, 16.5]],
    5: [[7.5, 7.5], [16.5, 7.5], [12, 12], [7.5, 16.5], [16.5, 16.5]],
    6: [[7.5, 7], [16.5, 7], [7.5, 12], [16.5, 12], [7.5, 17], [16.5, 17]],
  };
  return `<svg viewBox="0 0 24 24">${(P[n] || P[1]).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.2" fill="#4a3a4a"/>`).join('')}</svg>`;
}

/** 9×9 그리드에서 칸 index(반시계, 우하단=출발) → grid cell. 한 변 8칸(모서리 포함) */
function cell(i: number): { r: number; c: number } {
  if (i <= 8) return { r: 9, c: 9 - i };        // 하단: 우하(출발)→좌하(무인도)
  if (i <= 16) return { r: 17 - i, c: 1 };       // 좌측: 아래→위(올림픽)
  if (i <= 24) return { r: 1, c: i - 15 };        // 상단: 좌→우(세계여행)
  return { r: i - 23, c: 9 };                     // 우측: 위→아래(→출발)
}

const won = (n: number): string => `₩${n.toLocaleString()}`;

export class BlueMarbleRenderer {
  private root: HTMLDivElement;
  private cb: BMRenderCallbacks;
  private lastDice = '';
  private modalScrim: HTMLDivElement | null = null;
  /** 현재 열린 결정 모달의 종류(중복 오픈 방지) */
  private openKind = '';
  private destroyed = false;
  /** 화면에 표시 중인 말 위치 (state.pos 로 한 칸씩 애니메이션) */
  private dispPos: Record<string, number> = {};
  private moveTimer: number | null = null;
  private spinTimer: number | null = null;
  private settleTimer: number | null = null;
  /** 주사위 굴림 → 이동 시퀀스 진행 중이면 결정창 보류 */
  private busy = false;
  private myId = '';
  private spec = false;
  /** 건설 모달에서 체크한 건물들 (완료 시 일괄 확정) */
  private buildSel = new Set<BuildKind>();
  /** 세계여행: 칸 클릭으로 목적지 선택하는 모드 */
  private travelMode = false;
  /** 올림픽 개최/추가 건설: 클릭 가능한 내 땅 목록(나머지는 어둡게) */
  private pickTiles: number[] = [];
  /** 마지막으로 재생한 타격감 fx seq (중복 재생 방지) */
  private lastFxSeq = 0;
  /** 마지막으로 재생한 세계여행 비행 seq */
  private lastTravelSeq = 0;
  /** 이번에 이동하는 말(굴린 사람). 착지 후 턴이 넘어가도 이 말만 애니 */
  private moverId = '';

  constructor(parent: HTMLElement, cb: BMRenderCallbacks) {
    this.cb = cb;
    injectStyle();
    this.root = document.createElement('div');
    this.root.className = 'bm-root';
    this.root.innerHTML = this.boardHTML();
    parent.appendChild(this.root);
    this.wireStatic();
  }

  destroy(): void {
    this.destroyed = true;
    this.clearMove();
    if (this.spinTimer !== null) window.clearInterval(this.spinTimer);
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.closeModal();
    this.root.remove();
  }

  private clearMove(): void { if (this.moveTimer !== null) { window.clearInterval(this.moveTimer); this.moveTimer = null; } }

  // ── 정적 보드 HTML (1회) ──
  private boardHTML(): string {
    let tiles = '';
    for (let i = 0; i < BOARD.length; i++) {
      const t = BOARD[i];
      const { r, c } = cell(i);
      const style = `grid-row:${r};grid-column:${c}`;
      if (t.type === 'city') {
        tiles += `<div class="bm-tile bm-prop" data-i="${i}" style="${style};background:${GROUP[t.group]}">
          <div class="bm-cinfo"><div class="bm-cnm">${t.name}</div></div></div>`;
      } else if (t.type === 'island') {
        tiles += `<div class="bm-tile bm-prop bm-isle" data-i="${i}" style="${style};background:${tileColor(i)}">
          <div class="bm-cinfo"><div class="bm-cnm">${t.name}</div></div></div>`;
      } else {
        // 모서리·특수칸 → 칸 전체 일러스트
        const ill = tileIll(i);
        tiles += `<div class="bm-tile bm-illtile" data-i="${i}" style="${style}">
          ${ill ? ill.svg : ''}<div class="bm-illnm${ill && ill.dark ? ' dark' : ''}">${t.name}</div></div>`;
      }
    }
    const center = `<div class="bm-center">
      <div class="bm-logo">BLUE<br>MARBLE</div>
      <div class="bm-dice"><div class="bm-die" id="bm-d1">${diceFace(1)}</div><div class="bm-die" id="bm-d2">${diceFace(1)}</div></div>
      <div class="bm-diceres" id="bm-diceres"></div>
      <div class="bm-turn" id="bm-turn"></div>
      <button class="bm-roll" id="bm-roll">${IC.dice} 주사위 굴리기</button>
      <button class="bm-escape" id="bm-escape" style="display:none"></button>
    </div>`;
    return `<div class="bm-board">${tiles}${center}</div>
      <div class="bm-panel">
        <div class="bm-pcard"><h3>플레이어</h3><div id="bm-players"></div></div>
        <div class="bm-pcard"><h3>내 황금열쇠</h3><div id="bm-held" class="bm-heldlist"></div></div>
      </div>`;
  }

  private wireStatic(): void {
    this.root.querySelector('#bm-roll')!.addEventListener('click', () => this.cb.onRoll());
    this.root.querySelector('#bm-escape')!.addEventListener('click', () => this.cb.onDesertPay());
    // 타일 클릭 → 세계여행 모드면 이동, 아니면 정보(구매 가능 칸만)
    this.root.querySelectorAll<HTMLElement>('.bm-tile').forEach((el) => {
      el.addEventListener('click', () => {
        const i = Number(el.dataset.i);
        if (this.travelMode) { this.cb.onTravelTo(i); return; }
        if (this.pickTiles.includes(i)) { this.cb.onPickCity(i); return; }   // 올림픽/추가건설 선택
        if (el.classList.contains('bm-prop')) this.infoModal(i);
      });
    });
  }

  // ============================================
  // render(state)
  // ============================================

  render(state: BMState, myPeerId: string, isSpectator: boolean): void {
    if (this.destroyed) return;
    this._lastState = state; this.myId = myPeerId; this.spec = isSpectator;
    for (const p of state.order) if (this.dispPos[p] === undefined) this.dispPos[p] = state.pos[p]!;

    const key = state.dice ? state.dice.join(',') : '';
    const newRoll = !!state.dice && key !== this.lastDice && !this.busy;

    this.renderTiles(state);
    this.renderCenter(state, myPeerId, isSpectator);
    this.renderPanel(state, myPeerId);
    this.renderHeld(state, myPeerId);

    if (newRoll) { this.lastDice = key; this.startSequence(state); }   // ① 주사위 → ② 이동 → ③ 결정
    else if (!state.dice) { this.lastDice = ''; this.setDie('#bm-d1', 1); this.setDie('#bm-d2', 1); this.setDiceRes(null); }
    // 세계여행 비행기 애니 (주사위 이동과 별개 트리거)
    if (!this.busy && state.travelFx && state.travelFx.seq !== this.lastTravelSeq) {
      this.lastTravelSeq = state.travelFx.seq;
      this.playTravel(state.travelFx.by, state.travelFx.from, state.travelFx.to);
    }

    this.renderPending(state, myPeerId, isSpectator);  // busy면 내부에서 보류
    if (state.phase === 'ended') this.showEnd(state, myPeerId);
    // 통행료 타격감 — 이동/시퀀스 끝난 뒤 1회 재생
    if (!this.busy && state.fx && state.fx.seq !== this.lastFxSeq) {
      this.lastFxSeq = state.fx.seq;
      this.playFx(state.fx);
    }
    if (!this.busy) this.cb.onSettled();   // idle → 더미 진행 트리거
  }

  /** 타격감/획득 연출. gain=초록 +₩, toll=낸사람 −₩(흔들림)·받는사람 +₩, bankrupt=파산! */
  private playFx(fx: NonNullable<BMState['fx']>): void {
    if (this.destroyed) return;
    const { amount, mul, kind } = fx;
    // 통행료를 "내가 받는" 경우 → 초록 +₩ (흔들림/동전 없음)
    const iReceive = kind === 'toll' && fx.to === this.myId;
    if (kind === 'gain' || iReceive) {
      const g = document.createElement('div');
      g.className = 'bm-fxnum gain';
      g.innerHTML = `<span>+₩${amount.toLocaleString()}</span>`;
      this.root.appendChild(g);
      window.setTimeout(() => g.remove(), 1300);
      return;
    }
    if (kind === 'bankrupt') {
      const b = document.createElement('div'); b.className = 'bm-fxnum fire';
      b.innerHTML = `<span>${fx.nick ? fx.nick + ' ' : ''}파산!</span>`;
      this.root.classList.remove('bm-shake', 'bm-shake-strong'); void this.root.offsetWidth;
      this.root.classList.add('bm-shake-strong');
      window.setTimeout(() => this.root.classList.remove('bm-shake-strong'), 620);
      this.root.appendChild(b); window.setTimeout(() => b.remove(), 1600);
      return;
    }
    const strong = mul >= 3;
    // 화면 흔들림
    this.root.classList.remove('bm-shake', 'bm-shake-strong');
    void this.root.offsetWidth;   // 리플로우로 애니 재시작
    this.root.classList.add(strong ? 'bm-shake-strong' : 'bm-shake');
    window.setTimeout(() => this.root.classList.remove('bm-shake', 'bm-shake-strong'), 620);
    // 큰 숫자 팝업
    const num = document.createElement('div');
    num.className = 'bm-fxnum' + (strong ? ' fire' : '');
    num.innerHTML = `<span class="bm-fxmul">${mul > 1 ? `×${mul}` : ''}</span><span>−₩${amount.toLocaleString()}</span>`;
    this.root.appendChild(num);
    window.setTimeout(() => num.remove(), 1300);
    // 동전 튀기기
    const coins = document.createElement('div'); coins.className = 'bm-coins';
    const n = Math.min(14, 5 + mul * 2);
    for (let k = 0; k < n; k++) {
      const c = document.createElement('span'); c.className = 'bm-coin';
      const ang = (k / n) * Math.PI - Math.PI;            // 위쪽으로 부채꼴
      c.style.setProperty('--dx', `${Math.cos(ang) * (60 + (k % 5) * 22)}px`);
      c.style.setProperty('--dy', `${-90 - (k % 4) * 40}px`);
      c.style.animationDelay = `${(k % 5) * 20}ms`;
      coins.appendChild(c);
    }
    this.root.appendChild(coins);
    window.setTimeout(() => coins.remove(), 1200);
  }

  private setDie(sel: string, n: number): void { const el = this.root.querySelector(sel); if (el) el.innerHTML = diceFace(n); }

  /** 주사위 합계/더블 뱃지 (null이면 숨김) */
  private setDiceRes(dice: [number, number] | null): void {
    const el = this.root.querySelector<HTMLElement>('#bm-diceres'); if (!el) return;
    if (!dice) { el.className = 'bm-diceres'; el.innerHTML = ''; return; }
    const dbl = dice[0] === dice[1];
    el.className = 'bm-diceres show' + (dbl ? ' dbl' : '');
    el.innerHTML = `<span class="bm-dsum">${dice[0] + dice[1]}</span>` + (dbl ? `<span class="bm-ddbl">더블!</span>` : '');
  }

  /** ① 주사위 굴림 연출(~600ms) → 끝나면 이동 시퀀스 */
  private startSequence(state: BMState): void {
    this.busy = true; this.clearMove();
    this.moverId = state.order[state.turnIdx]!;   // 지금 차례(=굴린 사람) 캡처 — 이후 턴이 넘어가도 이 말만 이동 애니
    const fd = state.dice ? [state.dice[0], state.dice[1]] as [number, number] : null;  // 시작 시점 주사위 캡처(스핀 끝날 때 dice가 null 돼도 안전)
    if (this.spinTimer !== null) window.clearInterval(this.spinTimer);
    const d1 = this.root.querySelector<HTMLElement>('#bm-d1')!;
    const d2 = this.root.querySelector<HTMLElement>('#bm-d2')!;
    d1.classList.add('bm-rolling'); d2.classList.add('bm-rolling');
    this.setDiceRes(null);  // 굴리는 동안 이전 결과 숨김
    let t = 0;
    this.spinTimer = window.setInterval(() => {
      if (this.destroyed) { if (this.spinTimer !== null) window.clearInterval(this.spinTimer); return; }
      d1.innerHTML = diceFace(1 + Math.floor(Math.random() * 6));
      d2.innerHTML = diceFace(1 + Math.floor(Math.random() * 6));
      if (++t > 6) {
        window.clearInterval(this.spinTimer!); this.spinTimer = null;
        d1.classList.remove('bm-rolling'); d2.classList.remove('bm-rolling');
        if (fd) { d1.innerHTML = diceFace(fd[0]); d2.innerHTML = diceFace(fd[1]); this.setDiceRes(fd); }
        this.startMoveSeq();  // ② 이동
      }
    }, 65);
  }

  /** ② 현재 차례 말만 칸마다 한 칸씩 이동 → 도착하면 busy 해제 + 전체 리렌더(결정창 표시) */
  private startMoveSeq(): void {
    const s = this._lastState; if (!s) { this.busy = false; return; }
    const active = (this.moverId && s.pos[this.moverId] !== undefined) ? this.moverId : s.order[s.turnIdx]!;   // 굴린 사람(캡처) — 턴 넘어가도 그 말만
    // 나머지 말들은 즉시 제자리로 스냅 → 이전 애니 잔상이 같이 따라 움직이는 버그 방지
    for (const p of s.order) if (p !== active) this.dispPos[p] = s.pos[p]!;
    if (this.dispPos[active] === undefined) this.dispPos[active] = s.pos[active]!;   // 안전: 미초기화면 즉시 도착 처리
    // 카드 등으로 12칸 초과 순간이동은 스텝 없이 즉시
    const N = BOARD.length;
    const gap = (((s.pos[active]! - this.dispPos[active]!) % N) + N) % N;
    if (!Number.isFinite(gap) || gap === 0 || gap > 12) { this.dispPos[active] = s.pos[active]!; this.renderTiles(s); this.settle(); return; }
    this.moveTimer = window.setInterval(() => {
      const st = this._lastState; if (this.destroyed || !st) { this.clearMove(); return; }
      this.dispPos[active] = (this.dispPos[active]! + 1) % BOARD.length;
      this.renderTokens(st);
      // 출발(0)을 "통과"하는 순간 월급 팝업 (도착 칸이 아니라 지나갈 때)
      if (this.dispPos[active] === 0 && this.dispPos[active] !== st.pos[active]) this.playFx(SALARY, 1, 'gain');
      // 마지막 칸에 도착 → 말이 잠시 머문 뒤에 결정창(구매/황금열쇠) 표시
      if (this.dispPos[active] === st.pos[active]) { this.clearMove(); this.settle(); }
    }, 230);
  }

  /** 세계여행: from 칸 → to 칸으로 비행기가 날아가는 연출 후 도착 처리 */
  private playTravel(by: string, from: number, to: number): void {
    const s = this._lastState; if (!s) return;
    this.busy = true; this.clearMove();
    for (const p of s.order) if (p !== by) this.dispPos[p] = s.pos[p]!;
    this.dispPos[by] = from;                 // 출발 칸에 말 유지(비행 중)
    this.renderTiles(s);
    const fromEl = this.root.querySelector<HTMLElement>(`.bm-tile[data-i="${from}"]`);
    const toEl = this.root.querySelector<HTMLElement>(`.bm-tile[data-i="${to}"]`);
    const finish = (): void => {
      this.dispPos[by] = to; this.busy = false;
      const st = this._lastState; if (st) this.render(st, this.myId, this.spec);
    };
    if (!fromEl || !toEl) { window.setTimeout(finish, 200); return; }
    const rr = this.root.getBoundingClientRect(), fr = fromEl.getBoundingClientRect(), tr = toEl.getBoundingClientRect();
    const x0 = fr.left - rr.left + fr.width / 2, y0 = fr.top - rr.top + fr.height / 2;
    const x1 = tr.left - rr.left + tr.width / 2, y1 = tr.top - rr.top + tr.height / 2;
    const ang = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
    const plane = document.createElement('div'); plane.className = 'bm-plane'; plane.innerHTML = PLANE;
    plane.style.setProperty('--rot', `${ang}deg`);
    plane.style.left = `${x0}px`; plane.style.top = `${y0}px`;
    this.root.appendChild(plane);
    // 다음 프레임에 목적지로 트랜지션
    requestAnimationFrame(() => { plane.style.left = `${x1}px`; plane.style.top = `${y1}px`; });
    window.setTimeout(() => { plane.remove(); finish(); }, 900);
  }

  /** 도착 후 짧은 텀(360ms)을 두고 결정창/배너 표시 — 착지하자마자 모달이 뜨지 않게 */
  private settle(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      if (this.destroyed) return;
      this.busy = false;
      const st = this._lastState; if (st) this.render(st, this.myId, this.spec);
    }, 240);
  }

  /** 이동 애니 중 말(구슬)만 다시 그림 — 건물/깃발 SVG 재생성 없이 가벼워서 첫 이동도 매끄러움 */
  private renderTokens(state: BMState): void {
    for (let i = 0; i < BOARD.length; i++) {
      const tile = this.root.querySelector<HTMLElement>(`.bm-tile[data-i="${i}"]`);
      if (!tile) continue;
      tile.querySelector('.bm-toks')?.remove();
      const here = state.order.filter((p) => (this.dispPos[p] ?? state.pos[p]) === i && !state.players[p]!.bankrupt);
      if (here.length) {
        const tk = document.createElement('div'); tk.className = 'bm-toks';
        tk.innerHTML = here.map((p) => `<span class="bm-tok">${tokenSvg(colorOf(state, p), colorDeep(state, p))}</span>`).join('');
        tile.appendChild(tk);
      }
    }
  }

  private renderTiles(state: BMState): void {
    for (let i = 0; i < BOARD.length; i++) {
      const tile = this.root.querySelector<HTMLElement>(`.bm-tile[data-i="${i}"]`);
      if (!tile) continue;
      tile.querySelector('.bm-blds')?.remove();
      tile.querySelector('.bm-iflag')?.remove();
      tile.querySelector('.bm-toks')?.remove();
      tile.querySelector('.bm-mulbadge')?.remove();
      tile.querySelector('.bm-oly')?.remove();
      const o = state.owner[i];
      const t = BOARD[i];
      // 소유 표시 — 주인 색 테두리. 내 땅은 더 두껍게(확실히 구분)
      if (o !== undefined && (t.type === 'city' || t.type === 'island')) {
        const w = o === this.myId ? 6 : 3;
        tile.style.outline = `${w}px solid ${colorOf(state, o)}`; tile.style.outlineOffset = `-${w}px`;
        tile.style.boxShadow = o === this.myId ? `inset 0 0 0 1px rgba(255,255,255,.7)` : '';
      } else { tile.style.outline = ''; tile.style.boxShadow = ''; }
      // 통행료 배수 뱃지 + 컬러 독점 glow + 올림픽 팡파레
      let mul = 1;
      if (o !== undefined && t.type === 'city') { mul = colorMonopolyMul(state, i, o) * (state.olympic[i] ?? 1); tile.classList.toggle('bm-mono', ownsGroup(state, o, t.group)); }
      else if (o !== undefined && t.type === 'island') {
        mul = t.spot === 'island' ? Math.pow(2, Math.max(0, seaIslandCount(state, o) - 1)) : Math.min(3, state.beachVisits[i] ?? 1);
      }
      else tile.classList.remove('bm-mono');
      if ((state.olympic[i] ?? 1) > 1) {   // 올림픽 개최지 → 팡파레 데코
        const oly = document.createElement('div'); oly.className = 'bm-oly'; oly.innerHTML = FANFARE; tile.appendChild(oly);
      }
      if (mul > 1) {
        const bd = document.createElement('div');
        bd.className = `bm-mulbadge ${mul >= 4 ? 'fire' : mul >= 3 ? 'hot' : ''}`;
        bd.textContent = `×${mul}`;
        tile.appendChild(bd);
      }
      if (o !== undefined) {
        const col = colorOf(state, o);
        if (t.type === 'island') {
          const fl = document.createElement('div'); fl.className = 'bm-iflag'; fl.style.color = col; fl.innerHTML = FLAG; tile.appendChild(fl);
        } else if (t.type === 'city') {
          const arr = state.builds[i] ?? [];
          if (arr.length) {
            const b = document.createElement('div'); b.style.color = colorDeep(state, o);   // 건물은 진한 플레이어색
            if (arr.includes('landmark')) { b.className = 'bm-blds bm-lm'; b.innerHTML = landmarkSvg(t.name); }
            else { b.className = 'bm-blds'; b.innerHTML = arr.map((k) => BSVG[k]).join(''); }
            tile.appendChild(b);
          }
        }
      }
      // 말(구슬) — 표시 위치(dispPos)로
      const here = state.order.filter((p) => (this.dispPos[p] ?? state.pos[p]) === i && !state.players[p]!.bankrupt);
      if (here.length) {
        const tk = document.createElement('div'); tk.className = 'bm-toks';
        tk.innerHTML = here.map((p) => `<span class="bm-tok">${tokenSvg(colorOf(state, p), colorDeep(state, p))}</span>`).join('');
        tile.appendChild(tk);
      }
    }
  }

  private renderCenter(state: BMState, myPeerId: string, isSpectator: boolean): void {
    const cur = state.order[state.turnIdx]!;
    const curP = state.players[cur]!;
    const isMine = cur === myPeerId && !isSpectator;
    const turnEl = this.root.querySelector<HTMLElement>('#bm-turn')!;
    turnEl.innerHTML = `<b style="background:${colorOf(state, cur)}">${isMine ? '내 차례' : curP.nickname + ' 차례'}</b>`;
    const roll = this.root.querySelector<HTMLButtonElement>('#bm-roll')!;
    const canAct = isMine && !state.pending && state.phase === 'playing';
    roll.disabled = !canAct;
    // 무인도(감옥): 돈 내고 탈출 버튼 + 주사위(더블) 탈출 안내
    const inDesert = canAct && curP.desertLeft > 0;
    const esc = this.root.querySelector<HTMLButtonElement>('#bm-escape')!;
    esc.style.display = inDesert ? 'flex' : 'none';
    if (inDesert) {
      const canPay = curP.money >= DESERT_ESCAPE;
      esc.disabled = !canPay;
      esc.textContent = `₩${DESERT_ESCAPE.toLocaleString()} 내고 탈출`;
      roll.innerHTML = `${IC.dice} 주사위 (더블이면 탈출)`;
    } else {
      roll.innerHTML = `${IC.dice} 주사위 굴리기`;
    }
  }

  private renderPanel(state: BMState, myPeerId: string): void {
    const el = this.root.querySelector<HTMLElement>('#bm-players')!;
    const cur = state.order[state.turnIdx];
    el.innerHTML = state.order.map((pid) => {
      const p = state.players[pid]!;
      const props = Object.values(state.owner).filter((o) => o === pid).length;
      return `<div class="bm-prow ${pid === cur ? 'active' : ''} ${p.bankrupt ? 'dead' : ''}">
        <span class="bm-pdot" style="background:${colorOf(state, pid)}"></span>
        <span class="bm-pname">${p.nickname}${pid === myPeerId ? ' (나)' : ''}</span>
        <span style="text-align:right"><div class="bm-pmoney">${p.bankrupt ? '파산' : won(p.money)}</div>
          <div class="bm-pprops">${props}곳 · ${p.laps}바퀴</div></span></div>`;
    }).join('');
  }

  private renderHeld(state: BMState, myPeerId: string): void {
    const el = this.root.querySelector<HTMLElement>('#bm-held')!;
    const cards = state.held[myPeerId] ?? [];
    if (!cards.length) { el.innerHTML = '<div class="bm-empty">보관한 카드가 없어요</div>'; return; }
    el.innerHTML = cards.map((cid) => `<div class="bm-hcard"><span class="bm-hic">${IC[CARD_IC[cid]!]}</span>
      <span class="bm-htxt">${cardTitle(cid)}</span><button class="bm-huse" data-cid="${cid}">사용</button></div>`).join('');
    el.querySelectorAll<HTMLButtonElement>('.bm-huse').forEach((b) => {
      b.onclick = () => this.cb.onUseHeld(Number(b.dataset.cid));
    });
  }

  // ── 결정 모달 / 행동중 배너 ──
  private renderPending(state: BMState, myPeerId: string, isSpectator: boolean): void {
    // 주사위/이동 시퀀스 중엔 결정창/배너 보류 (완료 후 render 재호출에서 표시)
    if (this.busy) { this.travelMode = false; this.setPickMode(null); this.closeModal(); return; }
    const p = state.pending;
    if (!p) { this.travelMode = false; this.setPickMode(null); this.closeModal(); return; }
    if (p.kind === 'info') { this.travelMode = false; this.setPickMode(null); this.showInfo(p.tile, p.text); return; }
    const cur = state.order[state.turnIdx]!;
    const mine = cur === myPeerId && !isSpectator;
    // 세금 등 이벤트 — 모두에게 창, 밟은 사람(cur)만 확인해 닫음
    if (p.kind === 'event') { this.travelMode = false; this.setPickMode(null); this.eventModal(p.tile, p.text, mine, state.players[cur]!.nickname); return; }
    // 세계여행 = 아무 칸 클릭 / 올림픽·추가건설 = 내 땅만 클릭(나머지 어둡게)
    this.travelMode = p.kind === 'travel' && mine;
    let pick: number[] | null = null;
    if (mine && (p.kind === 'olympic' || p.kind === 'startBuild')) {
      pick = Object.keys(state.owner).map(Number).filter((i) =>
        state.owner[i] === myPeerId && BOARD[i].type === 'city'
        && (p.kind === 'olympic' || (['villa', 'house2', 'apt', 'landmark'] as BuildKind[]).some((k) => canBuild(state, i, myPeerId, k))));
    }
    this.setPickMode(pick);
    if (!mine) { this.showActing(state, p, cur); return; }
    if (p.kind === 'travel') { this.showBanner('이동할 칸을 클릭하세요', false); return; }
    if (p.kind === 'olympic') { this.showBanner('개최할 내 땅을 클릭하세요', true); return; }
    if (p.kind === 'startBuild') { this.showBanner('건설할 내 땅을 클릭하세요', true); return; }
    // 내 결정 모달 (이미 같은 종류 열려있으면 유지)
    const disc = p.kind === 'bonus' ? `${p.round}:${p.pot}` : ('tile' in p ? p.tile : '');
    const kind = `${p.kind}:${disc}`;
    if (this.openKind === kind && this.modalScrim) { if (p.kind === 'build') this.refreshBuildMenu(state); return; }
    this.openKind = kind;
    if (p.kind === 'buy') this.buyOrAcquireModal(state, p.tile, false);
    else if (p.kind === 'acquire') this.buyOrAcquireModal(state, p.tile, true);
    else if (p.kind === 'build') this.buildMenuModal(state, p.tile);
    else if (p.kind === 'card') this.cardModal(state, p.card);
    else if (p.kind === 'bonusOffer') this.bonusOfferModal(state.players[myPeerId]!.money);
    else if (p.kind === 'bonus') this.bonusModal(p.round, p.pot);
  }

  /** 세금 등 이벤트 창 — 모두에게 표시. 밟은 사람만 확인 버튼, 나머지는 대기 */
  private eventModal(tile: number, text: string, mine: boolean, curNick: string): void {
    const key = `event:${tile}`;
    if (this.openKind === key && this.modalScrim) return;
    this.closeModal();
    const t = BOARD[tile] as { name: string };
    const foot = mine
      ? `<div class="bm-btns"><button class="bm-yes" style="flex:1">확인</button></div>`
      : `<div class="bm-actft"><span class="bm-sp"></span><span><b>${curNick}</b>님 확인 대기…</span></div>`;
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal"><div class="bm-top" style="background:${tileColor(tile)}">${t.name}</div>
      <div class="bm-body"><div class="bm-cardic">${IC.coin}</div><div class="bm-ctitle">${text}</div>${foot}</div></div>`;
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = key;
    scrim.querySelector<HTMLButtonElement>('.bm-yes')?.addEventListener('click', () => this.cb.onEventOk());
  }

  /** 오락실: ① 한다/안 한다 → ② 한다면 판돈(100·200·300) 선택 */
  private bonusOfferModal(money: number): void {
    this.closeModal();
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal" style="width:300px"><div class="bm-top" style="background:linear-gradient(90deg,#b89aff,#8a5fd0)">보너스 게임</div>
      <div class="bm-body" id="bm-bonusbody"></div></div>`;
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = 'bonusOffer:';
    const body = scrim.querySelector<HTMLElement>('#bm-bonusbody')!;
    const askStep = (): void => {
      body.innerHTML = `<div class="bm-sub">판돈을 걸고 2지선다! 맞히면 ×2씩(최대 8배)</div>
        <div class="bm-bonuspot">할래요?</div>
        <div class="bm-bchoices"><button class="bm-bchoice" data-a="yes">한다</button><button class="bm-bchoice bm-bchoice-no" data-a="no">안 한다</button></div>`;
      body.querySelector<HTMLButtonElement>('[data-a="yes"]')!.onclick = stakeStep;
      body.querySelector<HTMLButtonElement>('[data-a="no"]')!.onclick = () => this.cb.onBonusStart(0);
    };
    const stakeStep = (): void => {
      const btns = [100000, 200000, 300000].map((v) => `<button class="bm-bchoice" data-s="${v}" ${money < v ? 'disabled' : ''}>₩${v.toLocaleString()}</button>`).join('');
      body.innerHTML = `<div class="bm-sub">판돈을 골라요</div>
        <div class="bm-bchoices">${btns}</div>
        <div class="bm-btns"><button class="bm-no" style="flex:1">안 한다</button></div>`;
      body.querySelectorAll<HTMLButtonElement>('.bm-bchoice').forEach((b) => { b.onclick = () => this.cb.onBonusStart(Number(b.dataset.s)); });
      body.querySelector<HTMLButtonElement>('.bm-no')!.onclick = () => this.cb.onBonusStart(0);
    };
    askStep();
  }

  /** 보드 칸 선택 모드 — tiles 만 밝게+클릭 가능, 나머지 어둡게 (없으면 해제) */
  private setPickMode(tiles: number[] | null): void {
    const set = new Set(tiles ?? []);
    this.root.classList.toggle('bm-picking', set.size > 0);
    this.root.querySelectorAll<HTMLElement>('.bm-tile').forEach((el) => {
      el.classList.toggle('bm-pickable', set.has(Number(el.dataset.i)));
    });
    this.pickTiles = tiles ?? [];
  }

  /** 칸 클릭 안내 배너 (딤 없이). skippable=true면 건너뛰기 버튼(막다른 길 방지) */
  private showBanner(text: string, skippable: boolean): void {
    const key = `banner:${text}:${skippable}`;
    if (this.openKind === key && this.modalScrim) return;
    this.closeModal();
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim bm-noscrim';
    scrim.innerHTML = `<div class="bm-toast">${text}${skippable ? '<button class="bm-bskip">건너뛰기</button>' : ''}</div>`;
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = key;
    scrim.querySelector<HTMLButtonElement>('.bm-bskip')?.addEventListener('click', () => this.cb.onPickCity(-1));
  }

  /** 올림픽 개최 / 추가 건설: 내 도시 하나 선택 */
  /** 오락실(보너스 게임): 2지선다 + 받기 */
  private bonusModal(round: number, pot: number): void {
    this.closeModal();
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal" style="width:300px"><div class="bm-top" style="background:linear-gradient(90deg,#b89aff,#8a5fd0)">보너스 게임</div>
      <div class="bm-body">
        <div class="bm-sub">둘 중 하나! 맞히면 ×2 (최대 8배)</div>
        <div class="bm-bonuspot">누적 <b>₩${pot.toLocaleString()}</b>${round > 0 ? ` <span style="color:#8a5fd0">(${Math.pow(2, round)}배)</span>` : ''}</div>
        <div class="bm-bchoices"><button class="bm-bchoice" data-c="0">왼쪽</button><button class="bm-bchoice" data-c="1">오른쪽</button></div>
        ${round > 0 ? `<div class="bm-btns"><button class="bm-no" style="flex:1">₩${pot.toLocaleString()} 받고 종료</button></div>` : ''}
      </div></div>`;
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = `bonus:${round}:${pot}`;
    scrim.querySelectorAll<HTMLButtonElement>('.bm-bchoice').forEach((b) => {
      b.onclick = () => this.cb.onBonusPick(Number(b.dataset.c));
    });
    scrim.querySelector<HTMLButtonElement>('.bm-no')?.addEventListener('click', () => this.cb.onBonusStop());
  }

  /** 다른 사람 차례일 때 — 구매 카드와 같은 크기의 카드로 "OO님이 ~ 중" 표시(딤 없이 판은 계속 보이게) */
  private showActing(state: BMState, p: NonNullable<BMState['pending']>, cur: string): void {
    const disc = p.kind === 'card' ? p.card : ('tile' in p ? p.tile : p.kind === 'bonus' ? `${p.round}:${p.pot}` : '');
    const key = `acting:${p.kind}:${disc}`;
    if (this.openKind === key && this.modalScrim) return;  // 같은 상태면 유지(스피너 계속 회전)
    this.closeModal();
    const who = state.players[cur]!.nickname;
    const foot = `<div class="bm-actft"><span class="bm-sp"></span><span><b>${who}</b>님이 ${pendingLabel(p)} 중…</span></div>`;
    let head: string, body: string;
    if (p.kind === 'card') {
      head = `<div class="bm-top" style="background:linear-gradient(90deg,#ffd454,#ffb02e)">${IC.key} 황금열쇠</div>`;
      body = `<div class="bm-body"><div class="bm-cardic">${IC[CARD_IC[p.card]!] ?? IC.key}</div><div class="bm-ctitle">${cardTitle(p.card)}</div>${foot}</div>`;
    } else if ('tile' in p) {
      const tile = p.tile;
      const label = p.kind === 'acquire' ? '인수' : p.kind === 'build' ? '건설' : (BOARD[tile].type === 'island' ? '섬 구매' : '도시 구매');
      head = `<div class="bm-top" style="background:${tileColor(tile)}">${label}</div>`;
      body = `<div class="bm-body">${deedHTML(state, tile)}${foot}</div>`;
    } else {
      // 올림픽/세계여행/추가건설/보너스 — 타일 없는 행동
      head = `<div class="bm-top" style="background:linear-gradient(90deg,#b89aff,#8a5fd0)">${pendingLabel(p)}</div>`;
      body = `<div class="bm-body">${foot}</div>`;
    }
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim bm-noscrim';
    scrim.innerHTML = `<div class="bm-modal">${head}${body}</div>`;
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = key;
  }

  /** 잠깐 뜨는 안내 토스트(돈 부족 등) — 딤 없이 판 위에 표시, 호스트가 곧 턴을 넘김 */
  private showInfo(tile: number, text: string): void {
    const key = `info:${tile}`;
    if (this.openKind === key && this.modalScrim) return;
    this.closeModal();
    const name = (BOARD[tile] as { name: string }).name;
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim bm-noscrim';
    scrim.innerHTML = `<div class="bm-toast"><b>${name}</b> · ${text}</div>`;
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = key;
  }

  private closeModal(): void {
    this.modalScrim?.remove(); this.modalScrim = null; this.openKind = '';
  }

  private buyOrAcquireModal(state: BMState, tile: number, isAcquire: boolean): void {
    this.closeModal();
    const cost = isAcquire ? acquireCost(state, tile) : (BOARD[tile] as { price: number }).price;
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal"><div class="bm-top" style="background:${tileColor(tile)}">${isAcquire ? '인수' : (BOARD[tile].type === 'island' ? '섬 구매' : '도시 구매')}</div>
      <div class="bm-body">${deedHTML(state, tile)}
        <div class="bm-mrow"><span>${isAcquire ? '인수 비용' : '가격'}</span><b>${won(cost)}</b></div>
        <div class="bm-btns"><button class="bm-yes">${isAcquire ? '인수' : '구매'}</button><button class="bm-no">패스</button></div>
      </div></div>`;
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = `${isAcquire ? 'acquire' : 'buy'}:${tile}`;
    scrim.querySelector<HTMLButtonElement>('.bm-yes')!.onclick = () => this.cb.onDecision(true);
    scrim.querySelector<HTMLButtonElement>('.bm-no')!.onclick = () => this.cb.onDecision(false);
  }

  private buildMenuModal(state: BMState, tile: number): void {
    this.closeModal();
    this.buildSel = new Set();   // 새 건설창 → 선택 초기화
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = `build:${tile}`;
    (scrim as HTMLElement & { _tile?: number })._tile = tile;
    this.refreshBuildMenu(state);
  }

  private refreshBuildMenu(state: BMState): void {
    const scrim = this.modalScrim as (HTMLElement & { _tile?: number }) | null;
    if (!scrim) return;
    const tile = scrim._tile!;
    const t = BOARD[tile] as { name: string; price: number };
    const p = state.players[state.order[state.turnIdx]!]!;
    const arr = state.builds[tile] ?? [];
    // 이미 지은 것 + 지금 체크한 것 (랜드마크 선행조건·자금 계산에 사용)
    const withSel = [...arr, ...this.buildSel];
    const selTotal = [...this.buildSel].reduce((v, k) => v + buildCostOf(tile, k), 0);
    const remain = p.money - selTotal;

    const rows = BUILD_TYPES.map((bt) => {
      const owned = arr.includes(bt.kind);
      const sel = this.buildSel.has(bt.kind);
      const cost = buildCostOf(tile, bt.kind);
      let st = '', can = false;
      if (owned) st = '<span style="color:#57c777">보유</span>';
      else if (p.laps < bt.lap) st = `<span style="color:#9a8a9a">${bt.lap}바퀴 필요</span>`;
      else if (bt.kind === 'landmark' && !hasAllHouses(withSel)) st = '<span style="color:#9a8a9a">3건물 먼저</span>';
      else if (!sel && cost > remain) st = '<span style="color:#e5484d">돈 부족</span>';
      else { st = `<b style="color:#ff5a92">${won(cost)}</b>`; can = true; }
      const ic = bt.kind === 'landmark' ? landmarkSvg(t.name) : BSVG[bt.kind];
      const on = owned || sel;
      return `<button class="bm-brow${sel ? ' sel' : ''}" data-k="${bt.kind}" ${can ? '' : 'disabled'}>
        <span class="bm-bck${on ? ' on' : ''}">${on ? IC.check : ''}</span>
        <span class="bm-bic" style="color:${colorOf(state, p.peerId)}">${ic}</span>
        <span class="bm-bnm">${bt.name}</span><span class="bm-bst">${st}</span></button>`;
    }).join('');

    const sumLine = this.buildSel.size
      ? `<div class="bm-bsum">건설비 <b>${won(selTotal)}</b> · 잔액 <b>${won(remain)}</b></div>`
      : `<div class="bm-bsum dim">지을 건물을 골라요</div>`;
    const doneLabel = this.buildSel.size ? `건설 완료 (${this.buildSel.size})` : '건설 안 함';
    scrim.innerHTML = `<div class="bm-modal" style="width:300px"><div class="bm-top" style="background:${tileColor(tile)}">${t.name} · 건설 (바퀴 ${p.laps})</div>
      <div class="bm-body">
      <div class="bm-bmenu">${rows}</div>
      ${sumLine}
      <div class="bm-btns"><button class="bm-yes" style="flex:1">${doneLabel}</button></div></div></div>`;

    scrim.querySelectorAll<HTMLButtonElement>('.bm-brow').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.k as BuildKind;
        if (this.buildSel.has(k)) this.buildSel.delete(k);
        else this.buildSel.add(k);
        // 집을 빼면 선행조건이 깨진 랜드마크도 자동 해제
        if (this.buildSel.has('landmark') && !hasAllHouses([...arr, ...this.buildSel])) this.buildSel.delete('landmark');
        this.refreshBuildMenu(state);   // 체크/합계/랜드마크 가용성 갱신
      };
    });
    scrim.querySelector<HTMLButtonElement>('.bm-yes')!.onclick = () => {
      const order: BuildKind[] = ['villa', 'house2', 'apt', 'landmark'];
      this.cb.onBuildConfirm(order.filter((k) => this.buildSel.has(k)));  // 확정 + 턴 종료
    };
  }

  private cardModal(state: BMState, cardId: number): void {
    this.closeModal();
    const keepable = [6, 7, 8].includes(cardId);
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    const btns = keepable
      ? `<div class="bm-btns"><button class="bm-yes">지금 쓰기</button><button class="bm-no" style="background:#fff0d0;color:#b8860b">보관</button></div>`
      : `<div class="bm-btns"><button class="bm-yes" style="background:#b89aff;color:#fff">확인</button></div>`;
    scrim.innerHTML = `<div class="bm-modal"><div class="bm-top" style="background:linear-gradient(90deg,#ffd454,#ffb02e)">${IC.key} 황금열쇠</div>
      <div class="bm-body"><div class="bm-cardic">${IC[CARD_IC[cardId]!]}</div>
        <div class="bm-ctitle">${cardTitle(cardId)}</div><div class="bm-cdesc">${cardDesc(cardId)}</div>${btns}</div></div>`;
    document.body.appendChild(scrim); this.modalScrim = scrim; this.openKind = `card:${cardId}`;
    scrim.querySelector<HTMLButtonElement>('.bm-yes')!.onclick = () => this.cb.onCard(false);
    scrim.querySelector<HTMLButtonElement>('.bm-no')?.addEventListener('click', () => this.cb.onCard(true));
  }

  private infoModal(tile: number): void {
    // 정보는 로컬 표시만 — 현재 상태는 마지막 render 의 DOM 기준이 아니라 별도로 계산 필요.
    // 간단히: 클릭 시점의 최신 state 를 렌더가 안 갖고 있으므로, index 가 넘겨준 최신 state 참조.
    if (!this._lastState) return;
    const state = this._lastState;
    const t = BOARD[tile];
    if (t.type !== 'city' && t.type !== 'island') return;
    const o = state.owner[tile];
    const ownerTxt = o !== undefined ? `${state.players[o]!.nickname} 소유` : '주인 없음';
    let cur: string, rows: string;
    // 배수 내역 (컬러 독점/올림픽/관광지 패시브) — 소유주 기준으로 계산
    const info = o !== undefined ? tollBreakdown(state, tile, '') : { base: 0, parts: [], total: 0 };
    const partsHtml = info.parts.map((pt) => `<div class="bm-mrow"><span>${pt.label}</span><b style="color:#ff5a92">×${pt.mul}</b></div>`).join('');
    if (t.type === 'island') {
      const base = Math.round(t.price * 0.5);
      const isBeach = t.spot === 'beach';
      const statLabel = isBeach ? '해변 방문' : '보유 섬';
      const statVal = isBeach ? `${Math.min(3, state.beachVisits[tile] ?? 0)}회` : `${o !== undefined ? seaIslandCount(state, o) : 0}개`;
      cur = o !== undefined
        ? `<div class="bm-curbox"><div class="bm-mrow"><span>${statLabel}</span><b>${statVal}</b></div>
             <div class="bm-mrow"><span>기본 통행료</span><b>${won(base)}</b></div>${partsHtml}
             <div class="bm-mrow big tollfinal"><span>최종 통행료</span><b>${won(info.total)}</b></div>
             <div class="bm-mrow"><span>인수</span><b>불가</b></div></div>`
        : `<div class="bm-curbox"><div class="bm-mrow big"><span>구매가</span><b>${won(t.price)}</b></div></div>`;
      rows = isBeach
        ? `<div class="bm-ihdr">해변 통행료 (방문 횟수)</div><table class="bm-itable">${[1, 2, 3].map((n) => `<tr><td>${n}회</td><td>${won(base * n)}</td></tr>`).join('')}</table>`
        : `<div class="bm-ihdr">섬 통행료 (보유 섬 수)</div><table class="bm-itable">${[1, 2, 3].map((n) => `<tr><td>${n}개</td><td>${won(base * Math.pow(2, n - 1))}</td></tr>`).join('')}</table>`;
    } else {
      const arr = state.builds[tile] ?? [];
      const builtTxt = arr.length ? arr.map((k) => buildMeta(k).name).join('·') : '땅만';
      const acq = acquireCost(state, tile);
      cur = o !== undefined
        ? `<div class="bm-curbox"><div class="bm-mrow"><span>지은 건물</span><b>${builtTxt}</b></div>
             <div class="bm-mrow"><span>기본 통행료</span><b>${won(info.base)}</b></div>${partsHtml}
             <div class="bm-mrow big tollfinal"><span>최종 통행료</span><b>${won(info.total)}</b></div>
             <div class="bm-mrow"><span>인수하려면</span><b>${acq < 0 ? '불가' : won(acq)}</b></div></div>`
        : `<div class="bm-curbox"><div class="bm-mrow big"><span>구매가</span><b>${won(t.price)}</b></div></div>`;
      rows = `<div class="bm-ihdr">건물별 건설비 · 통행료 기여</div><table class="bm-itable">
        <tr><td>땅만</td><td>통행료 ${won(Math.round(t.price * BASE_TOLL_MUL))}</td></tr>
        ${BUILD_TYPES.map((bt) => `<tr><td>${bt.name}</td><td>${won(buildCostOf(tile, bt.kind))} · +${won(Math.round(t.price * bt.tollMul))}</td></tr>`).join('')}</table>`;
    }
    const el = this.root.querySelector<HTMLElement>(`.bm-tile[data-i="${tile}"]`);
    el?.classList.add('bm-selected');
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal" style="width:284px"><div class="bm-top" style="background:${tileColor(tile)}">${t.name}</div>
      <div class="bm-body" style="text-align:left"><div style="text-align:center;margin-bottom:2px"><b>${won(t.price)}</b> · <span style="color:#9a8a9a;font-weight:700">${ownerTxt}</span></div>
      ${cur}${rows}<div class="bm-btns" style="margin-top:12px"><button class="bm-no" style="flex:1">닫기</button></div></div></div>`;
    document.body.appendChild(scrim);
    const close = (): void => { scrim.remove(); el?.classList.remove('bm-selected'); };
    scrim.querySelector<HTMLButtonElement>('.bm-no')!.onclick = close;
    scrim.onclick = (e) => { if (e.target === scrim) close(); };
  }

  private _lastState: BMState | null = null;

  private endShown = false;
  private showEnd(state: BMState, myPeerId: string): void {
    if (this.endShown) return;
    this.endShown = true;
    const won2 = state.winnerPeerId;
    const iWon = won2 === myPeerId;
    const name = won2 ? state.players[won2]!.nickname : '';
    const iBankrupt = !!state.players[myPeerId]?.bankrupt;
    // 통행료/파산 fx 먼저 보이도록 살짝 텀 → 그다음 보드 위 결과 오버레이(패배 화면은 그 뒤에)
    window.setTimeout(() => {
      if (this.destroyed) return;
      const title = iWon ? '승리!' : iBankrupt ? '파산…' : `${name} 승리`;
      const end = document.createElement('div'); end.className = 'bm-end';
      end.innerHTML = `<div class="bm-endcard"><div class="bm-endt" style="color:${iWon ? '#ff5a92' : '#4a3a4a'}">${title}</div></div>`;
      this.root.appendChild(end);
    }, 1100);
  }

  /** index 가 매 render 마다 최신 state 를 넘겨 정보모달 등에 쓰게 */
  setLastState(state: BMState): void { this._lastState = state; }
}

// ── 렌더 밖 헬퍼 ──
function colorOf(state: BMState, peerId: string): string {
  const idx = state.order.indexOf(peerId);
  return ['#6ed9b3', '#ff5a92', '#5b9be6', '#f2c94c', '#b89aff', '#ff8a5b', '#7ed957', '#e07aff', '#4fd0d9', '#ffb12e'][idx % 10]!;
}
/** hex 를 f배 어둡게 (0~1). 건물 색을 진하게 해서 가독성↑ */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
/** 플레이어 색의 진한 버전 (건물/랜드마크용) */
function colorDeep(state: BMState, peerId: string): string { return shade(colorOf(state, peerId), 0.82); }
/** 게임 말(폰 모양) SVG — 머리 구슬 + 몸통, 플레이어색 + 진한 외곽선 */
function tokenSvg(color: string, dark: string): string {
  return `<svg viewBox="0 0 24 30" aria-hidden="true">
    <ellipse cx="12" cy="28" rx="6.6" ry="1.9" fill="rgba(0,0,0,.22)"/>
    <path d="M6 25.6 C6 20.6 8.7 18.7 9.7 17.2 C8.2 16.2 7.3 14.5 7.3 12.6 C7.3 9.7 9.4 7.5 12 7.5 C14.6 7.5 16.7 9.7 16.7 12.6 C16.7 14.5 15.8 16.2 14.3 17.2 C15.3 18.7 18 20.6 18 25.6 Z"
      fill="${color}" stroke="${dark}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="12" cy="6" r="4.4" fill="${color}" stroke="${dark}" stroke-width="1.6"/>
    <ellipse cx="10.1" cy="4.5" rx="1.5" ry="1" fill="rgba(255,255,255,.6)"/>
  </svg>`;
}
function deedHTML(state: BMState, tile: number): string {
  const t = BOARD[tile] as { name: string; price: number };
  const info = BOARD[tile].type === 'island'
    ? `섬 · 보유 개수만큼 통행료 ↑ · 인수 불가`
    : `기본 통행료 ${won(Math.round(t.price * BASE_TOLL_MUL))}`;
  return `<div class="bm-deed" style="--bd:${tileColor(tile)}"><div class="bm-deedb"></div>
    <div class="bm-deedn">${t.name}</div><div class="bm-deedi">가격 ${won(t.price)}<br>${info}</div></div>`;
}
const CARD_TITLES = ['은행 이자', '생일 축하', '복권 당첨', '병원비', '속도위반 벌금', '출발로 이동', '통행료 면제권', '무인도 탈출권', '우주여행권'];
const CARD_DESCS = ['₩150 받기', '₩120 받기', '₩300 받기', '₩100 납부', '₩80 납부', '월급 ₩200 받기', '통행료 1회 면제 · 보관 가능', '무인도 탈출 · 보관 가능', '원하는 곳으로 · 보관 가능'];
const cardTitle = (id: number): string => CARD_TITLES[id] ?? '카드';
const cardDesc = (id: number): string => CARD_DESCS[id] ?? '';
const pendingLabel = (p: NonNullable<BMState['pending']>): string =>
  p.kind === 'buy' ? '구매 고민' : p.kind === 'build' ? '건설' : p.kind === 'acquire' ? '인수 고민'
  : p.kind === 'olympic' ? '올림픽 개최' : p.kind === 'travel' ? '세계여행'
  : p.kind === 'startBuild' ? '추가 건설' : p.kind === 'bonus' || p.kind === 'bonusOffer' ? '보너스 게임' : '카드 확인';

// ============================================
// CSS (1회 주입)
// ============================================
let styleInjected = false;
function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
.bm-root{position:absolute;inset:0;display:flex;gap:13px;padding:11px;box-sizing:border-box;align-items:center;justify-content:center;
  font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif;color:#4a3a4a;}
.bm-board{height:100%;aspect-ratio:1;max-width:calc(100% - 275px);display:grid;
  grid-template-columns:repeat(9,1fr);grid-template-rows:repeat(9,1fr);
  gap:3px;background:linear-gradient(135deg,#e9f7ff,#ffeaf3);border-radius:16px;padding:7px;box-shadow:0 8px 26px rgba(120,80,140,.14);}
.bm-tile{position:relative;background:#fff;border:1px solid #efe3f2;border-radius:6px;overflow:hidden;min-width:0;display:flex;flex-direction:column;}
.bm-prop{cursor:pointer;transition:transform .12s ease,box-shadow .12s ease,filter .12s ease;}
.bm-prop:hover{transform:translateY(-3px) scale(1.05);z-index:6;filter:brightness(1.07) saturate(1.08);
  box-shadow:0 10px 20px rgba(60,40,80,.34);outline:2.5px solid rgba(255,255,255,.92);outline-offset:-2px;border-radius:8px;}
@media(prefers-reduced-motion:reduce){.bm-prop{transition:none;} .bm-prop:hover{transform:none;}}
/* 칸 선택 모드(올림픽 개최/추가 건설): 내 땅만 밝게, 나머지 어둡게 */
.bm-root.bm-picking .bm-tile{filter:brightness(.42) saturate(.7);transition:filter .2s;}
.bm-root.bm-picking .bm-tile.bm-pickable{filter:none;cursor:pointer;outline:3px solid #ffd454;outline-offset:-2px;border-radius:8px;z-index:5;animation:bm-pickpulse 1.1s ease-in-out infinite;}
@keyframes bm-pickpulse{0%,100%{box-shadow:0 0 0 rgba(255,206,70,.4);}50%{box-shadow:0 0 16px 2px rgba(255,206,70,.9);}}
@media(prefers-reduced-motion:reduce){.bm-root.bm-picking .bm-tile.bm-pickable{animation:none;}}
/* 도시·관광지 이름 — 칸 중앙 정렬(아이콘 없음) */
.bm-cinfo{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:5px;text-align:center;z-index:1;}
.bm-cnm{font-size:15px;font-weight:800;color:#2c2136;text-shadow:0 1px 0 rgba(255,255,255,.4);line-height:1.12;overflow:hidden;text-overflow:ellipsis;}
.bm-isle .bm-cnm{color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.4);}
/* 모서리·특수칸 — 칸 전체 일러스트 */
.bm-illtile{background:#fffdf7;}
.bm-illsvg{position:absolute;inset:0;width:100%;height:100%;display:block;}
.bm-illnm{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:4px 3px 6px;text-align:center;font-size:11px;font-weight:800;
  color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.4));}
.bm-illnm.dark{color:#3a2e42;text-shadow:0 1px 0 rgba(255,255,255,.4);background:linear-gradient(transparent,rgba(255,255,255,.45));}
.bm-iflag{position:absolute;left:0;right:0;top:2px;display:flex;justify-content:center;z-index:2;}
.bm-iflag svg{width:24px;height:24px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.3));}
.bm-blds{position:absolute;left:0;right:0;top:3px;display:flex;justify-content:center;align-items:flex-end;gap:1px;z-index:2;}
.bm-blds svg{width:21px;height:21px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.3));}
.bm-blds.bm-lm svg{width:44px;height:44px;filter:drop-shadow(0 0 5px rgba(255,200,60,.9)) drop-shadow(0 1px 2px rgba(0,0,0,.35));}
/* 통행료 배수 뱃지 (둥둥) */
.bm-mulbadge{position:absolute;top:3px;right:3px;z-index:8;font-size:13px;font-weight:900;color:#fff;
  background:linear-gradient(135deg,#ffb01c,#ff7a1c);border-radius:999px;padding:2px 8px;line-height:1.25;
  border:1.5px solid rgba(255,255,255,.9);box-shadow:0 2px 7px rgba(160,90,10,.55);animation:bm-bob 1.5s ease-in-out infinite;pointer-events:none;}
.bm-mulbadge.hot{background:linear-gradient(135deg,#ff9f1c,#ff5a3c);box-shadow:0 3px 10px rgba(255,90,60,.6);}
.bm-mulbadge.fire{background:linear-gradient(135deg,#ff6a3c,#ff2d55);box-shadow:0 0 12px rgba(255,60,90,.85);animation:bm-bob 1.1s ease-in-out infinite, bm-flame .5s ease-in-out infinite alternate;}
/* 올림픽 개최 팡파레 */
.bm-oly{position:absolute;top:2px;left:2px;z-index:8;width:20px;height:20px;pointer-events:none;animation:bm-twinkle 1.4s ease-in-out infinite;}
.bm-oly svg{width:100%;height:100%;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3));}
@keyframes bm-twinkle{0%,100%{transform:scale(1) rotate(-4deg);}50%{transform:scale(1.18) rotate(4deg);}}
@media(prefers-reduced-motion:reduce){.bm-oly{animation:none;}}
@keyframes bm-bob{0%,100%{transform:translateY(0);}50%{transform:translateY(-4px);}}
@keyframes bm-flame{from{filter:brightness(1);}to{filter:brightness(1.35) saturate(1.3);}}
/* 컬러 독점 타일 바닥 빛남 */
.bm-tile.bm-mono{animation:bm-mono 2s ease-in-out infinite;}
@keyframes bm-mono{0%,100%{box-shadow:inset 0 0 0 1px rgba(0,0,0,.05);}50%{box-shadow:inset 0 0 0 2px rgba(255,220,120,.9),0 0 14px rgba(255,210,90,.7);}}
/* 타격감: 화면 흔들림 */
.bm-shake{animation:bm-shk .5s cubic-bezier(.36,.07,.19,.97);}
.bm-shake-strong{animation:bm-shk-strong .6s cubic-bezier(.36,.07,.19,.97);}
@keyframes bm-shk{10%,90%{transform:translate(-2px,0);}30%,70%{transform:translate(4px,-1px);}50%{transform:translate(-5px,1px);}}
@keyframes bm-shk-strong{10%,90%{transform:translate(-4px,1px) rotate(-.4deg);}30%,70%{transform:translate(8px,-2px) rotate(.5deg);}50%{transform:translate(-10px,2px) rotate(-.6deg);}}
@media(prefers-reduced-motion:reduce){.bm-shake,.bm-shake-strong{animation:none;} .bm-mulbadge,.bm-tile.bm-mono{animation:none;}}
/* 타격감: 큰 숫자 팝업 */
.bm-fxnum{position:absolute;top:38%;left:50%;transform:translate(-50%,-50%);z-index:60;pointer-events:none;
  display:flex;flex-direction:column;align-items:center;gap:2px;font-weight:900;color:#4a3a4a;
  text-shadow:0 3px 10px rgba(0,0,0,.28);animation:bm-fxnum 1.25s cubic-bezier(.2,1.3,.4,1) forwards;}
.bm-fxnum span:last-child{font-size:clamp(30px,6vw,58px);}
.bm-fxmul{font-size:clamp(16px,3vw,26px);color:#ff5a92;}
.bm-fxnum.fire{color:#ff2d55;text-shadow:0 0 16px rgba(255,60,90,.7),0 3px 10px rgba(0,0,0,.3);}
.bm-fxnum.fire .bm-fxmul{color:#ffab1c;}
.bm-fxnum.gain{color:#2fa968;text-shadow:0 2px 8px rgba(47,169,104,.35);}
.bm-fxnum.gain span:last-child{font-size:clamp(24px,4.5vw,42px);}
@keyframes bm-fxnum{0%{opacity:0;transform:translate(-50%,-30%) scale(.4);}25%{opacity:1;transform:translate(-50%,-50%) scale(1.12);}70%{opacity:1;transform:translate(-50%,-52%) scale(1);}100%{opacity:0;transform:translate(-50%,-80%) scale(.95);}}
/* 타격감: 동전 */
.bm-coins{position:absolute;top:44%;left:50%;z-index:59;pointer-events:none;}
.bm-coin{position:absolute;width:16px;height:16px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff2b0,#ffcf4a 60%,#e0a91c);
  box-shadow:0 1px 3px rgba(0,0,0,.3),inset 0 -2px 2px rgba(180,130,10,.5);animation:bm-coin .9s ease-out forwards;}
@keyframes bm-coin{0%{opacity:1;transform:translate(0,0) scale(.5);}30%{opacity:1;transform:translate(calc(var(--dx) * .6),var(--dy)) scale(1);}100%{opacity:0;transform:translate(var(--dx),120px) scale(.9);}}
/* 상세창 최종 통행료 강조 */
.bm-mrow.tollfinal b{color:#ff2d55;font-size:16px;text-shadow:0 1px 6px rgba(255,60,90,.35);}
/* 세계여행 비행기 */
.bm-plane{position:absolute;width:44px;height:44px;z-index:30;pointer-events:none;
  transition:left .9s cubic-bezier(.45,.05,.3,1),top .9s cubic-bezier(.45,.05,.3,1);
  transform:translate(-50%,-50%) rotate(var(--rot,0deg));filter:drop-shadow(0 4px 6px rgba(0,0,0,.3));}
.bm-plane svg{width:100%;height:100%;display:block;}
.bm-toks{position:absolute;bottom:17px;left:0;right:0;display:flex;gap:2px;justify-content:center;flex-wrap:wrap;pointer-events:none;z-index:4;}
.bm-tok{width:19px;height:24px;display:block;}
.bm-tok svg{width:100%;height:100%;display:block;filter:drop-shadow(0 2px 2px rgba(0,0,0,.3));}
.bm-selected{z-index:6;filter:brightness(1.12) saturate(1.1);box-shadow:0 0 0 3px #fff,0 0 0 5px #ff5a92;}
.bm-center{grid-column:2/9;grid-row:2/9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:11px;
  background:linear-gradient(135deg,rgba(255,255,255,.5),rgba(255,240,247,.5));border-radius:12px;padding:12px;}
.bm-logo{font-size:clamp(20px,3vw,38px);font-weight:900;letter-spacing:-1px;transform:rotate(-8deg);line-height:.95;text-align:center;
  background:linear-gradient(90deg,#5b9be6,#ff5a92);-webkit-background-clip:text;background-clip:text;color:transparent;}
.bm-dice{display:flex;gap:12px;}
.bm-die{width:clamp(36px,4.6vw,52px);aspect-ratio:1;background:#fff;border-radius:12px;box-shadow:0 5px 14px rgba(120,80,140,.22);display:grid;place-items:center;}
.bm-die svg{width:80%;height:80%;} .bm-die.bm-rolling{animation:bm-shake .12s infinite;}
@keyframes bm-shake{0%{transform:translateY(0) rotate(-8deg);}50%{transform:translateY(-4px) rotate(8deg);}100%{transform:translateY(0) rotate(-8deg);}}
.bm-diceres{display:flex;align-items:center;justify-content:center;gap:8px;height:38px;flex:none;opacity:0;transform:scale(.7);transition:opacity .18s,transform .28s cubic-bezier(.34,1.56,.64,1);}
.bm-diceres.show{opacity:1;transform:scale(1);}
.bm-dsum{font-size:20px;font-weight:900;color:#5b3f6e;background:#fff;border-radius:999px;min-width:34px;height:34px;padding:0 8px;display:grid;place-items:center;box-shadow:0 4px 12px rgba(120,80,140,.2);}
.bm-diceres.dbl .bm-dsum{color:#fff;background:linear-gradient(135deg,#ffb347,#ff5a92);}
.bm-ddbl{font-size:14px;font-weight:900;color:#fff;background:linear-gradient(135deg,#ff8ab0,#ff5a92);border-radius:999px;padding:4px 12px;box-shadow:0 4px 12px rgba(255,90,146,.38);animation:bm-dblpop .5s ease;}
@keyframes bm-dblpop{0%{transform:scale(.5) rotate(-8deg);}60%{transform:scale(1.18) rotate(4deg);}100%{transform:scale(1) rotate(0);}}
.bm-turn{font-size:14px;font-weight:800;} .bm-turn b{padding:1px 10px;border-radius:999px;color:#fff;}
.bm-roll{font:inherit;font-weight:800;font-size:14px;color:#fff;background:#ff5a92;border:none;border-radius:999px;padding:9px 20px;cursor:pointer;box-shadow:0 6px 16px rgba(255,90,146,.32);display:flex;align-items:center;gap:5px;}
.bm-roll svg{width:18px;height:18px;} .bm-roll:disabled{opacity:.45;cursor:default;}
.bm-escape{font:inherit;font-weight:800;font-size:13px;color:#7a5a10;background:linear-gradient(135deg,#ffe7a0,#ffcf4a);border:none;border-radius:999px;padding:8px 18px;cursor:pointer;box-shadow:0 5px 14px rgba(200,150,30,.32);align-items:center;justify-content:center;}
.bm-escape:disabled{opacity:.45;cursor:default;}
.bm-panel{width:262px;display:flex;flex-direction:column;gap:12px;}
.bm-pcard{background:rgba(255,255,255,.72);border:1px solid rgba(216,199,255,.7);border-radius:14px;padding:12px;box-shadow:0 4px 14px rgba(120,80,140,.08);}
.bm-pcard h3{margin:0 0 8px;font-size:12px;color:#8a7a8a;font-weight:800;}
.bm-prow{display:flex;align-items:center;gap:8px;padding:6px 7px;border-radius:9px;}
.bm-prow.active{background:#fff0f6;box-shadow:inset 0 0 0 1px rgba(255,90,146,.3);} .bm-prow.dead{opacity:.5;}
.bm-pdot{width:13px;height:13px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.18);flex:none;}
.bm-pname{font-size:12.5px;font-weight:800;flex:1;} .bm-pmoney{font-size:12.5px;font-weight:800;} .bm-pprops{font-size:10.5px;color:#8a7a8a;}
.bm-heldlist{display:flex;flex-direction:column;gap:7px;} .bm-empty{font-size:12px;color:#8a7a8a;}
.bm-hcard{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:11px;background:#fff;border:1.5px solid #ffe0a8;}
.bm-hic svg{width:22px;height:22px;} .bm-htxt{flex:1;font-size:12px;font-weight:800;}
.bm-huse{font:inherit;font-size:12px;font-weight:800;color:#fff;background:#b89aff;border:none;border-radius:9px;padding:6px 11px;cursor:pointer;}
.bm-scrim{position:fixed;inset:0;z-index:200;background:rgba(54,36,56,.42);display:grid;place-items:center;padding:20px;}
.bm-modal{width:290px;max-width:92vw;background:#fff;border-radius:20px;box-shadow:0 20px 50px rgba(80,50,80,.35);overflow:hidden;animation:bm-pop .26s cubic-bezier(.34,1.56,.64,1);}
@keyframes bm-pop{from{transform:scale(.85);opacity:0;}to{transform:scale(1);opacity:1;}}
.bm-top{height:60px;display:flex;align-items:center;justify-content:center;gap:5px;color:#fff;font-size:15px;font-weight:800;} .bm-top svg{width:19px;height:19px;}
.bm-body{padding:15px 17px 17px;text-align:center;} .bm-sub{font-size:12px;color:#8a7a8a;margin-bottom:8px;}
.bm-mrow{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:3px 0;} .bm-mrow span{color:#8a7a8a;font-weight:700;} .bm-mrow b{color:#4a3a4a;font-weight:900;} .bm-mrow.big b{color:#ff5a92;font-size:16px;}
.bm-btns{display:flex;gap:10px;margin-top:12px;} .bm-btns button{flex:1;font:inherit;font-size:14px;font-weight:800;padding:11px;border-radius:13px;cursor:pointer;border:none;}
.bm-yes{background:#6ed9b3;color:#1f6a55;} .bm-no{background:#f0e8ef;color:#8a7a8a;}
.bm-deed{width:132px;margin:0 auto 10px;border:1.5px solid #eadcf2;border-radius:12px;overflow:hidden;box-shadow:0 3px 10px rgba(120,80,140,.12);}
.bm-deedb{height:26px;background:var(--bd);} .bm-deedn{font-size:16px;font-weight:900;padding:6px 4px 0;} .bm-deedi{font-size:10.5px;color:#8a7a8a;padding:2px 4px 8px;line-height:1.3;}
.bm-cardic svg{width:46px;height:46px;} .bm-ctitle{font-size:18px;font-weight:900;margin-top:6px;} .bm-cdesc{font-size:12px;color:#8a7a8a;margin-bottom:6px;}
.bm-bmenu{display:flex;flex-direction:column;gap:7px;}
.bm-brow{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:12px;border:1.5px solid #eadcf2;background:#fff;font:inherit;cursor:pointer;text-align:left;transition:border-color .12s,background .12s;}
.bm-brow:not(:disabled):hover{border-color:#ff5a92;} .bm-brow:disabled{opacity:.55;cursor:default;}
.bm-brow.sel{border-color:#57c777;background:#f2fdf6;}
.bm-bck{width:20px;height:20px;flex:none;border-radius:50%;border:2px solid #dcdce4;background:#fff;box-sizing:border-box;}
.bm-bck.on{border:none;} .bm-bck svg{width:20px;height:20px;display:block;}
.bm-bic{width:26px;height:26px;flex:none;display:grid;place-items:center;} .bm-bic svg{width:26px;height:26px;}
.bm-bnm{flex:1;font-size:13px;font-weight:800;} .bm-bst{font-size:12px;font-weight:700;}
.bm-bsum{margin-top:10px;font-size:12px;color:#7a6a7a;} .bm-bsum b{color:#5b3f6e;} .bm-bsum.dim{color:#a89aab;}
.bm-bonuspot{font-size:15px;font-weight:800;margin:10px 0;color:#5b3f6e;} .bm-bonuspot b{font-size:19px;color:#8a5fd0;}
.bm-bchoices{display:flex;gap:10px;margin-bottom:6px;}
.bm-bchoice{flex:1;font:inherit;font-weight:800;font-size:15px;color:#fff;background:linear-gradient(135deg,#b89aff,#8a5fd0);border:none;border-radius:14px;padding:16px 0;cursor:pointer;box-shadow:0 6px 16px rgba(138,95,208,.34);transition:transform .1s;}
.bm-bchoice:active{transform:scale(.96);}
.bm-bchoice.bm-bchoice-no{background:#efe9f2;color:#7a6a7a;box-shadow:none;}
.bm-itable{width:100%;font-size:11.5px;border-collapse:collapse;margin-top:2px;} .bm-itable td{padding:3.5px 6px;border-bottom:1px solid #f2eaf4;} .bm-itable td:last-child{text-align:right;font-weight:800;} .bm-itable td:first-child{color:#6a5a6a;}
.bm-ihdr{font-size:11.5px;font-weight:800;color:#8a7a8a;margin-top:10px;}
.bm-curbox{background:#fff6fa;border:1px solid #ffd6e6;border-radius:12px;padding:8px 11px;margin:8px 0;}
.bm-scrim.bm-noscrim{background:transparent;pointer-events:none;}
.bm-toast{background:rgba(74,58,74,.94);color:#fff;font-size:15px;font-weight:800;padding:14px 26px;border-radius:16px;box-shadow:0 14px 36px rgba(0,0,0,.32);animation:bm-pop .26s cubic-bezier(.34,1.56,.64,1);display:flex;align-items:center;gap:14px;} .bm-toast b{color:#ffd7e6;}
.bm-bskip{pointer-events:auto;font:inherit;font-size:13px;font-weight:800;color:#4a3a4a;background:#fff;border:none;border-radius:999px;padding:6px 14px;cursor:pointer;box-shadow:0 3px 8px rgba(0,0,0,.25);}
.bm-actft{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;padding-top:11px;border-top:1px solid #f0e6f4;font-size:13px;font-weight:700;color:#6a5a6a;} .bm-actft b{color:#4a3a4a;}
.bm-actft .bm-sp{border-color:rgba(120,90,130,.28);border-top-color:#8a5a78;}
.bm-sp{width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:bm-spin .7s linear infinite;}
@keyframes bm-spin{to{transform:rotate(360deg);}}
.bm-end{position:absolute;inset:0;z-index:50;background:rgba(54,36,56,.55);display:grid;place-items:center;}
.bm-endcard{background:#fff;border-radius:20px;padding:26px 40px;box-shadow:0 16px 40px rgba(0,0,0,.3);} .bm-endt{font-size:30px;font-weight:900;}
@media(max-width:820px){.bm-root{flex-direction:column;} .bm-board{max-width:100%;height:auto;width:100%;} .bm-panel{width:100%;}}
`;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}
