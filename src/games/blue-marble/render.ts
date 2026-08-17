/**
 * 블루마블 HTML 렌더러. 캔버스 대신 부모(ctx.canvas.parentElement)에 DOM 보드를 마운트한다.
 *   - 보드는 constructor 에서 1회 생성, render(state) 에서 동적 부분(건물/말/센터/패널/모달)만 갱신.
 *   - 결정 모달(구매/건설/인수/카드)은 state.pending + 현재 차례가 나인지로 표시.
 *   - 아이콘/건물은 전부 인라인 SVG (프로젝트 방침: 이모지 X).
 */

import {
  BOARD, BUILD_TYPES, ISLAND_TILES, BASE_TOLL_MUL, DESERT_ESCAPE,
  buildMeta, buildCostOf, acquireCost, sellRefund, islandCount, seaIslandCount, hasAllHouses, canBuild, CARDS,
  colorMonopolyMul, ownsGroup, tollBreakdown, totalAssets, estateValue,
  type BMState, type BuildKind, type GroupColor,
} from './rules';
import { escapeHtml } from '../../ui/escape';

/** 현금 증감 뱃지가 떠 있는 시간(ms). CSS bm-mdelta 애니 길이와 맞출 것 */
const MONEY_FX_MS = 2200;
/** 순서 정하기 주사위 스핀 시간(ms) */
const ORDER_SPIN_MS = 620;

export interface BMRenderCallbacks {
  onRoll(): void;
  onOrderRoll(): void;                   // 게임 시작 전 순서 정하기 주사위
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
  onSell(tile: number): void;           // 내 땅 판매
  onPayDebt(): void;                    // 자금 마련 후 지불
  onGiveUp(): void;                     // 자금 마련 포기 → 파산
  /** 주사위·이동 시퀀스가 끝나 화면이 idle 이 됨(호스트가 더미 진행 타이밍에 사용) */
  onSettled(): void;
}

const GROUP: Record<GroupColor, string> = {
  tan: '#d9b38c', sky: '#8fc2f0', pink: '#ff9bbb', orange: '#ffb27a', red: '#ff8a8a',
  yellow: '#f2d24c', green: '#8fe0b0', rose: '#e79ad0', teal: '#7fd6d0', navy: '#8a9ef0',
};
const ISLAND_GRAD = 'linear-gradient(155deg,#33a8dd 0%,#4fbbe8 42%,#ffffff 100%)';   // 섬(파랑) → 끝 흰색
const BEACH_GRAD = 'linear-gradient(155deg,#f56a5a 0%,#ff8672 42%,#ffffff 100%)';    // 해변(붉은) → 끝 흰색
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
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="#5b9be6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9 H17 l-3 -3 M18 15 H7 l3 3"/></svg>',
  quake: '<svg viewBox="0 0 24 24"><rect x="7" y="9" width="10" height="11" fill="#c99a52" stroke="#8a5f2a" stroke-width="1.2"/><path d="M9 9 L11 3 L13 8 L15 4 L16 9" fill="none" stroke="#8a5f2a" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 12 L13 16 M13 12 L11 20" stroke="#e0640f" stroke-width="1.6" stroke-linecap="round"/></svg>',
  blackout: '<svg viewBox="0 0 24 24"><path d="M13 2 L5 13 h6 l-2 9 10 -13 h-6 z" fill="#ffd454" stroke="#e0a91c" stroke-width="1" stroke-linejoin="round"/></svg>',
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
  welfare: '<svg viewBox="0 0 24 24"><path d="M12 9.2 C10.6 6.6 6.8 7.2 6.8 10.3 C6.8 12.6 9.4 14.3 12 16.2 C14.6 14.3 17.2 12.6 17.2 10.3 C17.2 7.2 13.4 6.6 12 9.2 Z" fill="#ff7aa5" stroke="#e0558a" stroke-width="0.9" stroke-linejoin="round"/><path d="M4 17.5 C6.5 20.5 17.5 20.5 20 17.5" stroke="#f2c94c" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>',
};
/** 특수/코너 칸 → 아이콘 키 */
function tileIcon(i: number): string {
  const t = BOARD[i];
  if (t.type === 'corner') return { start: 'flag', desert: 'sos', olympic: 'rings', space: 'rocket' }[t.kind];
  if (t.type === 'special') return t.kind === 'goldkey' ? 'key' : t.kind === 'tax' ? 'coin' : 'music';
  return '';
}
/** 카드 id → 아이콘 키 */
const cardIcon = (id: number): string => IC[CARDS[id]?.icon ?? 'coin'] ?? IC.coin!;

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
  if (t.type === 'corner') return ILL[{ start: 'start', desert: 'desert', olympic: 'olympic', space: 'travel' }[t.kind]] ?? null;
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
  /** 보드(정사각형) 엘리먼트 — 모달/토스트를 화면이 아니라 "판 중앙"에 띄우는 기준 */
  private boardEl!: HTMLElement;
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
  /** 마지막으로 재생한 카드 연출 seq */
  private lastCardSeq = 0;
  /** 마지막으로 재생한 현금 증감 뱃지 seq */
  private lastMoneySeq = 0;
  /** 직전에 그린 사회복지기금 적립액 (늘어날 때만 반짝) */
  private lastFund = 0;
  /** 마지막으로 스핀을 재생한 순서 정하기 굴림 seq */
  private lastOrderSeq = 0;
  private orderSpinTimer: number | null = null;
  /** 이번에 이동하는 말(굴린 사람). 착지 후 턴이 넘어가도 이 말만 애니 */
  private moverId = '';

  constructor(parent: HTMLElement, cb: BMRenderCallbacks) {
    this.cb = cb;
    injectStyle();
    this.root = document.createElement('div');
    this.root.className = 'bm-root';
    this.root.innerHTML = this.boardHTML();
    parent.appendChild(this.root);
    this.boardEl = this.root.querySelector<HTMLElement>('.bm-board')!;
    this.wireStatic();
  }

  /**
   * 모달/토스트를 게임판 안쪽(정중앙)에 붙인다.
   * document.body 에 fixed 로 띄우면 우측 플레이어 패널까지 덮어서 화면 중앙 = 판 중앙이 아니었음.
   * track=false 는 renderPending 이 관리하지 않는 로컬 모달(칸 정보창).
   */
  private mountScrim(scrim: HTMLDivElement, track = true): void {
    this.boardEl.appendChild(scrim);
    if (track) this.modalScrim = scrim;
  }

  destroy(): void {
    this.destroyed = true;
    this.clearMove();
    if (this.spinTimer !== null) window.clearInterval(this.spinTimer);
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    if (this.orderSpinTimer !== null) { window.clearInterval(this.orderSpinTimer); this.orderSpinTimer = null; }
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
      <div class="bm-log" id="bm-log"></div>
      <button class="bm-roll" id="bm-roll">${IC.dice} 주사위 굴리기</button>
      <button class="bm-escape" id="bm-escape" style="display:none"></button>
      <button class="bm-sellbtn" id="bm-sell" style="display:none">🏷️ 내 땅 팔기</button>
    </div>`;
    return `<div class="bm-board">${tiles}${center}</div>
      <div class="bm-panel">
        <div class="bm-fund" id="bm-fund">
          <span class="bm-fic">${IC.welfare}</span>
          <span class="bm-ftxt">사회복지기금</span>
          <span class="bm-famt" id="bm-fundamt">₩0</span>
        </div>
        <div class="bm-pcard">
          <h3>플레이어 <span class="bm-plegend">현금 / 총자산</span></h3>
          <div id="bm-players"></div>
          <div class="bm-mfx" id="bm-mfx"></div>
        </div>
        <div class="bm-pcard"><h3>내 황금열쇠</h3><div id="bm-held" class="bm-heldlist"></div></div>
      </div>`;
  }

  private wireStatic(): void {
    this.root.querySelector('#bm-roll')!.addEventListener('click', () => this.cb.onRoll());
    this.root.querySelector('#bm-escape')!.addEventListener('click', () => this.cb.onDesertPay());
    this.root.querySelector('#bm-sell')!.addEventListener('click', () => { if (this._lastState) this.sellModal(this._lastState, null); });
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
    // 카드 텔레포트 등 애니 없이 바뀐 위치는 즉시 스냅 (곧 시작될 주사위/비행/카드이동 애니 대상은 제외)
    const travelPending = !!state.travelFx && state.travelFx.seq !== this.lastTravelSeq;
    const cardFlyPending = !!state.cardFx && state.cardFx.kind === 'fly' && state.cardFx.seq !== this.lastCardSeq;
    if (!this.busy && !newRoll && !travelPending && !cardFlyPending) { for (const p of state.order) this.dispPos[p] = state.pos[p]!; }

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
    // 카드 연출 (말 이동/지진/교환/토스트)
    if (!this.busy && state.cardFx && state.cardFx.seq !== this.lastCardSeq) {
      this.lastCardSeq = state.cardFx.seq;
      this.playCardFx(state.cardFx);
    }

    this.renderPending(state, myPeerId, isSpectator);  // busy면 내부에서 보류
    // 파산으로 끝난 경우: 말이 착지(이동 애니 완료)한 뒤에 결과 오버레이 표시
    if (state.phase === 'ended' && !this.busy) this.showEnd(state, myPeerId);
    // 통행료 타격감 — 이동/시퀀스 끝난 뒤 1회 재생
    if (!this.busy && state.fx && state.fx.seq !== this.lastFxSeq) {
      this.lastFxSeq = state.fx.seq;
      this.playFx(state.fx);
    }
    // 플레이어 패널 현금 증감 뱃지 — 말이 다 움직인 뒤에 띄워야 누가 얼마 냈는지 눈에 들어옴
    if (!this.busy && state.moneyFx && state.moneyFx.seq !== this.lastMoneySeq) {
      this.lastMoneySeq = state.moneyFx.seq;
      this.playMoneyFx(state.moneyFx);
    }
    if (!this.busy) this.cb.onSettled();   // idle → 더미 진행 트리거
  }

  /** 타격감/획득 연출. gain=초록 +₩, toll=낸사람 −₩(흔들림)·받는사람 +₩, bankrupt=파산! */
  private playFx(fx: NonNullable<BMState['fx']>): void {
    if (this.destroyed) return;
    const { amount, mul, kind } = fx;
    // 금액 숫자는 판 위에 안 띄운다 — 우측 패널의 현금 증감 뱃지가 담당(중복 + 판 가림 방지).
    // 여기 남는 건 "느낌"뿐: 통행료 흔들림 / 동전 / 파산 문구.
    const iReceive = kind === 'toll' && fx.to === this.myId;
    if (kind === 'gain' || iReceive) {
      if (amount >= 1000000) this.coinShower(18);   // 복권 등 대박만 동전 세례
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
    this.coinShower(Math.min(14, 5 + mul * 2));
  }

  /** 화면 중앙에서 동전이 위로 튀는 이펙트 */
  private coinShower(n: number): void {
    const coins = document.createElement('div'); coins.className = 'bm-coins';
    for (let k = 0; k < n; k++) {
      const c = document.createElement('span'); c.className = 'bm-coin';
      const ang = (k / n) * Math.PI - Math.PI;
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
    const N = BOARD.length;
    const gap = (((s.pos[active]! - this.dispPos[active]!) % N) + N) % N;
    if (!Number.isFinite(gap) || gap === 0) { this.dispPos[active] = s.pos[active]!; this.renderTiles(s); this.settle(); return; }
    // 주사위 이동은 칸당 230ms. 12칸 초과(더블 3연속 무인도행 등)는 예전엔 순간이동이었는데
    // 이제 다 걸어가게 하되, 전체 시간이 길어지지 않게 칸당 시간을 줄인다.
    const stepMs = gap <= 12 ? 230 : Math.max(80, Math.round(2400 / gap));
    this.moveTimer = window.setInterval(() => {
      const st = this._lastState; if (this.destroyed || !st) { this.clearMove(); return; }
      this.dispPos[active] = (this.dispPos[active]! + 1) % BOARD.length;
      this.renderTokens(st);
      // (월급 팝업은 판에 안 띄운다 — 우측 패널 현금 증감 뱃지로만)
      // 마지막 칸에 도착 → 말이 잠시 머문 뒤에 결정창(구매/황금열쇠) 표시
      if (this.dispPos[active] === st.pos[active]) { this.clearMove(); this.settle(); }
    }, stepMs);
  }

  /**
   * 세계여행: from 칸 → to 칸으로 비행기가 날아가는 연출 후 도착 처리.
   * 최단 직선이 아니라 **정방향(index 증가) 판 경로**를 따라 한 칸씩 날아간다.
   * 출발선을 넘으면 월급이 붙는데(index.ts travelTo), 직선으로 가로지르면 왜 월급을 받는지
   * 안 보여서 판정 방향과 연출 방향을 맞춘 것.
   */
  private playTravel(by: string, from: number, to: number): void {
    const s = this._lastState; if (!s) return;
    this.busy = true; this.clearMove();
    for (const p of s.order) if (p !== by) this.dispPos[p] = s.pos[p]!;
    this.dispPos[by] = from;                 // 출발 칸에 말 유지(비행 중)
    this.renderTiles(s);
    const finish = (): void => {
      this.dispPos[by] = to; this.busy = false;
      const st = this._lastState; if (st) this.render(st, this.myId, this.spec);
    };
    const N = BOARD.length;
    const steps = ((to - from) % N + N) % N || N;   // 제자리 선택이면 한 바퀴
    const start = this.tileCenter(from);
    const path = Array.from({ length: steps }, (_, k) => this.tileCenter((from + k + 1) % N)).filter((c) => c !== null) as { x: number; y: number }[];
    if (!start || path.length !== steps) { window.setTimeout(finish, 200); return; }
    const plane = document.createElement('div'); plane.className = 'bm-plane'; plane.innerHTML = PLANE;
    plane.style.left = `${start.x}px`; plane.style.top = `${start.y}px`;
    this.root.appendChild(plane);
    // 칸 수와 무관하게 전체 비행 시간을 비슷하게 (칸당 60~150ms)
    const stepMs = Math.max(60, Math.min(150, Math.round(1300 / steps)));
    plane.style.transition = `left ${stepMs}ms linear, top ${stepMs}ms linear`;
    let prev = start, i = 0;
    const hop = (): void => {
      if (this.destroyed) { plane.remove(); return; }
      const nxt = path[i]!;
      plane.style.setProperty('--rot', `${Math.atan2(nxt.y - prev.y, nxt.x - prev.x) * 180 / Math.PI}deg`);
      plane.style.left = `${nxt.x}px`; plane.style.top = `${nxt.y}px`;
      prev = nxt; i += 1;
      if (i < path.length) window.setTimeout(hop, stepMs);
      else window.setTimeout(() => { plane.remove(); finish(); }, stepMs + 120);
    };
    requestAnimationFrame(hop);
  }

  /** 타일 중심의 root 기준 좌표 */
  private tileCenter(i: number): { x: number; y: number } | null {
    const el = this.root.querySelector<HTMLElement>(`.bm-tile[data-i="${i}"]`);
    if (!el) return null;
    const rr = this.root.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - rr.left + r.width / 2, y: r.top - rr.top + r.height / 2 };
  }

  /** 카드 연출 라우팅 */
  private playCardFx(fx: NonNullable<BMState['cardFx']>): void {
    if (this.destroyed) return;
    if (fx.kind === 'fly' && fx.by !== undefined && fx.from !== undefined && fx.to !== undefined) { this.playTokenWalk(fx.by, fx.from, fx.to, fx.back === true); return; }
    if (fx.kind === 'quake' && fx.tile !== undefined) { this.playQuake(fx.tile); return; }
    if (fx.kind === 'swap' && fx.tile !== undefined && fx.tile2 !== undefined) { this.playSwap(fx.tile, fx.tile2); return; }
    if (fx.kind === 'toast' && fx.text) { this.showToast(fx.text); return; }
  }

  /**
   * 카드 이동(출발로 이동·최고가 도시로·무인도 유배·뒤로 3칸) — 세계여행과 같은 원칙으로
   * 순간이동 대신 **판 경로를 따라 한 칸씩** 걸어간다. back=true면 역방향(뒤로 3칸).
   * 칸 수가 많아도 전체 1.3초 내외가 되도록 칸당 시간을 조절한다.
   */
  private playTokenWalk(by: string, from: number, to: number, back: boolean): void {
    const s = this._lastState; if (!s) return;
    this.busy = true; this.clearMove();
    for (const p of s.order) if (p !== by) this.dispPos[p] = s.pos[p]!;
    this.dispPos[by] = from; this.renderTokens(s);
    const finish = (): void => { this.dispPos[by] = to; this.busy = false; const st = this._lastState; if (st) this.render(st, this.myId, this.spec); };
    const N = BOARD.length;
    const steps = back ? (((from - to) % N + N) % N) : (((to - from) % N + N) % N);
    if (steps === 0) { window.setTimeout(finish, 150); return; }
    const stepMs = Math.max(70, Math.min(190, Math.round(1300 / steps)));
    let left = steps;
    this.moveTimer = window.setInterval(() => {
      const st = this._lastState; if (this.destroyed || !st) { this.clearMove(); return; }
      this.dispPos[by] = ((this.dispPos[by]! + (back ? -1 : 1)) % N + N) % N;
      this.renderTokens(st);
      if (--left <= 0) { this.clearMove(); window.setTimeout(finish, 180); }
    }, stepMs);
  }

  /** 지진 — 대상 타일 흔들림 + 파편 */
  private playQuake(tile: number): void {
    const el = this.root.querySelector<HTMLElement>(`.bm-tile[data-i="${tile}"]`);
    if (el) { el.classList.remove('bm-quakeshake'); void el.offsetWidth; el.classList.add('bm-quakeshake'); window.setTimeout(() => el.classList.remove('bm-quakeshake'), 600); }
    const c = this.tileCenter(tile); if (!c) return;
    const wrap = document.createElement('div'); wrap.className = 'bm-debris';
    for (let k = 0; k < 8; k++) {
      const d = document.createElement('span');
      d.style.setProperty('--dx', `${(k % 2 ? 1 : -1) * (20 + (k % 4) * 14)}px`);
      d.style.setProperty('--dy', `${-40 - (k % 3) * 22}px`);
      d.style.animationDelay = `${(k % 4) * 15}ms`;
      wrap.appendChild(d);
    }
    wrap.style.left = `${c.x}px`; wrap.style.top = `${c.y}px`;
    this.root.appendChild(wrap); window.setTimeout(() => wrap.remove(), 900);
  }

  /** 도시 교환 — 두 타일 반짝 강조 */
  private playSwap(a: number, b: number): void {
    for (const i of [a, b]) {
      const el = this.root.querySelector<HTMLElement>(`.bm-tile[data-i="${i}"]`);
      if (el) { el.classList.remove('bm-swapglow'); void el.offsetWidth; el.classList.add('bm-swapglow'); window.setTimeout(() => el.classList.remove('bm-swapglow'), 900); }
    }
  }

  /** 잠깐 뜨는 토스트 (카드 사용 안내) */
  private showToast(text: string): void {
    const t = document.createElement('div'); t.className = 'bm-cardtoast'; t.textContent = text;
    this.root.appendChild(t); window.setTimeout(() => t.remove(), 1400);
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
        tk.innerHTML = here.map((p) => `<span class="bm-tok${p === this.myId ? ' me' : ''}">${tokenSvg(colorOf(state, p), colorDeep(state, p))}</span>`).join('');
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
      tile.querySelector('.bm-blackout')?.remove();
      if ((state.blackout[i] ?? 0) > 0) { const bo = document.createElement('div'); bo.className = 'bm-blackout'; bo.innerHTML = IC.blackout; tile.appendChild(bo); }
      const o = state.owner[i];
      const t = BOARD[i];
      // 소유 표시 — 주인 색 두꺼운 테두리. 내 땅은 안쪽 흰 라인으로 한 번 더 강조
      if (o !== undefined && (t.type === 'city' || t.type === 'island')) {
        tile.style.outline = `6px solid ${colorOf(state, o)}`; tile.style.outlineOffset = '-6px';
        tile.style.boxShadow = o === this.myId ? 'inset 0 0 0 2px rgba(255,255,255,.85)' : '';
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
        tk.innerHTML = here.map((p) => `<span class="bm-tok${p === this.myId ? ' me' : ''}">${tokenSvg(colorOf(state, p), colorDeep(state, p))}</span>`).join('');
        tile.appendChild(tk);
      }
    }
  }

  private renderCenter(state: BMState, myPeerId: string, isSpectator: boolean): void {
    const cur = state.order[state.turnIdx]!;
    const curP = state.players[cur]!;
    const isMine = cur === myPeerId && !isSpectator;
    const turnEl = this.root.querySelector<HTMLElement>('#bm-turn')!;
    turnEl.innerHTML = state.phase === 'order'
      ? `<b style="background:#b89aff">순서 정하기</b>`
      : `<b style="background:${colorOf(state, cur)}">${isMine ? '내 차례' : curP.nickname + ' 차례'}</b>`;
    // state.log 는 여태 어디서도 안 그려졌다 → '더블! 한 번 더', '더블 3연속 → 무인도!' 같은
    // 규칙 안내가 전부 안 보여서 왜 그렇게 됐는지 알 수 없었음. 판 중앙에 한 줄로 노출.
    const logEl = this.root.querySelector<HTMLElement>('#bm-log')!;
    logEl.textContent = state.log;
    const roll = this.root.querySelector<HTMLButtonElement>('#bm-roll')!;
    const canAct = isMine && !state.pending && state.phase === 'playing';
    roll.disabled = !canAct;
    // 내 땅 팔기 — 내 차례+대기없음+소유한 땅 있을 때 (자금 마련용 자발적 판매)
    const sellBtn = this.root.querySelector<HTMLButtonElement>('#bm-sell')!;
    const ownsLand = Object.keys(state.owner).some((k) => state.owner[+k] === cur);
    sellBtn.style.display = (canAct && ownsLand) ? 'flex' : 'none';
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
      // 현금 = 손에 든 돈 / 총자산 = 현금 + 부동산(다 팔면 들어오는 돈)
      const right = p.bankrupt
        ? `<div class="bm-pmoney">파산</div>`
        : `<div class="bm-pmoney">${won(p.money)}</div>
           <div class="bm-ptotal">총 ${won(totalAssets(state, pid))}</div>`;
      return `<div class="bm-prow ${pid === cur ? 'active' : ''} ${p.bankrupt ? 'dead' : ''}" data-pid="${escapeHtml(pid)}">
        <span class="bm-pdot" style="background:${colorOf(state, pid)}"></span>
        <span class="bm-pcol"><span class="bm-pname">${p.nickname}${pid === myPeerId ? ' (나)' : ''}</span>
          <span class="bm-pprops">${props}곳 · ${p.laps}바퀴</span></span>
        <span class="bm-pright">${right}</span></div>`;
    }).join('');

    const amt = this.root.querySelector<HTMLElement>('#bm-fundamt');
    const fund = this.root.querySelector<HTMLElement>('#bm-fund');
    if (amt && fund) {
      amt.textContent = won(state.fund);
      fund.classList.toggle('empty', state.fund <= 0);
      // 기금이 늘어난 순간만 살짝 반짝 (매 렌더 재생 방지)
      if (state.fund > this.lastFund) { fund.classList.remove('bump'); void fund.offsetWidth; fund.classList.add('bump'); }
      this.lastFund = state.fund;
    }
  }

  /**
   * 플레이어 행 옆에 현금 증감 뱃지(+초록 / −빨강)를 띄운다.
   * 행 HTML 은 매 렌더 통째로 다시 그려지므로 뱃지를 그 안에 넣으면 애니가 리셋된다
   * → 리렌더 대상이 아닌 오버레이(#bm-mfx)에 얹고 행 위치(offsetTop)만 따라간다.
   */
  private playMoneyFx(fx: NonNullable<BMState['moneyFx']>): void {
    const host = this.root.querySelector<HTMLElement>('#bm-mfx');
    const rows = this.root.querySelector<HTMLElement>('#bm-players');
    if (!host || !rows) return;
    rows.querySelectorAll<HTMLElement>('.bm-prow').forEach((row) => {
      const delta = fx.deltas[row.dataset.pid ?? ''];
      if (!delta) return;
      const b = document.createElement('div');
      b.className = `bm-mdelta ${delta > 0 ? 'up' : 'down'}`;
      b.textContent = `${delta > 0 ? '+' : '−'}${won(Math.abs(delta))}`;
      b.style.top = `${row.offsetTop + row.offsetHeight / 2 - 13}px`;
      host.appendChild(b);
      window.setTimeout(() => b.remove(), MONEY_FX_MS);
    });
  }

  private renderHeld(state: BMState, myPeerId: string): void {
    const el = this.root.querySelector<HTMLElement>('#bm-held')!;
    const cards = state.held[myPeerId] ?? [];
    if (!cards.length) { el.innerHTML = '<div class="bm-empty">보관한 카드가 없어요</div>'; return; }
    const inDesert = (state.players[myPeerId]?.desertLeft ?? 0) > 0;
    el.innerHTML = cards.map((cid) => {
      const eff = CARDS[cid]?.effect;
      // 통행료 면제권은 남의 땅 통행료가 뜨는 순간 쓸지 물어보므로 여기서 누를 일이 없다.
      // 무인도 탈출권은 무인도에 있을 때만 사용 가능.
      const btn = eff === 'tollExempt'
        ? `<button class="bm-huse" disabled title="남의 땅 통행료가 뜰 때 쓸지 물어봐요">통행료용</button>`
        : eff === 'jailFree' && !inDesert
          ? `<button class="bm-huse" disabled title="무인도에 있을 때만">무인도용</button>`
          : `<button class="bm-huse" data-cid="${cid}">사용</button>`;
      return `<div class="bm-hcard"><span class="bm-hic">${cardIcon(cid)}</span>
        <span class="bm-htxt">${cardTitle(cid)}</span>${btn}</div>`;
    }).join('');
    el.querySelectorAll<HTMLButtonElement>('.bm-huse[data-cid]').forEach((b) => {
      b.onclick = () => this.cb.onUseHeld(Number(b.dataset.cid));
    });
  }

  // ── 결정 모달 / 행동중 배너 ──
  private renderPending(state: BMState, myPeerId: string, isSpectator: boolean): void {
    // 주사위/이동 시퀀스 중엔 결정창/배너 보류 (완료 후 render 재호출에서 표시)
    if (this.busy) { this.setTravelMode(false); this.setPickMode(null); this.closeModal(); return; }
    // 게임 시작 전 순서 정하기 — 다른 모달 다 제치고 이 창만
    if (state.phase === 'order') {
      this.setTravelMode(false); this.setPickMode(null);
      this.orderModal(state, myPeerId, isSpectator);
      return;
    }
    const p = state.pending;
    if (!p) {
      this.setTravelMode(false); this.setPickMode(null);
      // 자발적 판매 모달은 대기(pending) 없이 떠 있으므로 유지·갱신 (판매 시 잔액/목록 갱신)
      if (this.openKind.startsWith('sell:') && this._lastState) this.sellModal(state, null);
      else this.closeModal();
      return;
    }
    if (p.kind === 'info') { this.setTravelMode(false); this.setPickMode(null); this.showInfo(p.tile, p.text); return; }
    const cur = state.order[state.turnIdx]!;
    const mine = cur === myPeerId && !isSpectator;
    // 세금 등 이벤트 — 모두에게 창, 밟은 사람(cur)만 확인해 닫음
    if (p.kind === 'event') { this.setTravelMode(false); this.setPickMode(null); this.eventModal(p.tile, p.text, mine, state.players[cur]!.nickname); return; }
    // 자금 마련(현금 부족) — 갚을 사람은 판매 모달, 나머지는 대기.
    // 생일 축하처럼 차례가 아닌 사람이 갚을 수도 있어서 cur 이 아니라 debtor 기준.
    if (p.kind === 'raiseFunds') {
      this.setTravelMode(false); this.setPickMode(null);
      if (p.debtor === myPeerId && !isSpectator) this.sellModal(state, p.amount);
      else { this.closeModal(); this.showActing(state, p, p.debtor); }
      return;
    }
    // 보너스 게임 — 구경하는 사람도 판돈/누적/선택을 실시간으로 보게. 버튼만 차례인 사람 것.
    if (p.kind === 'bonusOffer' || p.kind === 'bonus') {
      this.setTravelMode(false); this.setPickMode(null);
      const key = p.kind === 'bonus' ? `bonus:${p.round}:${p.pot}` : 'bonusOffer:';
      if (this.openKind === key && this.modalScrim) return;
      const who = state.players[cur]!.nickname;
      if (p.kind === 'bonusOffer') this.bonusOfferModal(state.players[cur]!.money, mine, who);
      else this.bonusModal(p.round, p.pot, mine, who);
      return;
    }
    // 세계여행 = 아무 칸 클릭 / 올림픽·추가건설 = 내 땅만 클릭(나머지 어둡게)
    this.setTravelMode(p.kind === 'travel' && mine);
    const owned = (owner: string): number[] => Object.keys(state.owner).map(Number).filter((i) => state.owner[i] === owner && BOARD[i].type === 'city');
    const oppCities = (): number[] => Object.keys(state.owner).map(Number).filter((i) => state.owner[i] !== undefined && state.owner[i] !== myPeerId && BOARD[i].type === 'city');
    let pick: number[] | null = null;
    if (mine) {
      if (p.kind === 'olympic') pick = owned(myPeerId);
      else if (p.kind === 'startBuild') pick = owned(myPeerId).filter((i) => (['villa', 'house2', 'apt', 'landmark'] as BuildKind[]).some((k) => canBuild(state, i, myPeerId, k)));
      else if (p.kind === 'cardSwapMine') pick = owned(myPeerId);
      else if (p.kind === 'cardSwapTheirs' || p.kind === 'cardBlackout') pick = oppCities();
      else if (p.kind === 'cardQuake') pick = oppCities().filter((i) => (state.builds[i]?.length ?? 0) > 0);
    }
    this.setPickMode(pick);
    if (!mine) { this.showActing(state, p, cur); return; }
    if (p.kind === 'travel') { this.showBanner('어디든 클릭! 목적지는 추가 비용 없어요', false); return; }
    if (p.kind === 'olympic') { this.showBanner('올림픽 열 내 도시 클릭 · 같은 곳이면 배수 ×2씩', true); return; }
    if (p.kind === 'startBuild') { this.showBanner('건설할 내 땅을 클릭하세요', true); return; }
    if (p.kind === 'cardSwapMine') { this.showBanner('바꿀 내 도시를 클릭', false); return; }
    if (p.kind === 'cardSwapTheirs') { this.showBanner('바꿔올 상대 도시를 클릭', false); return; }
    if (p.kind === 'cardQuake') { this.showBanner('부술 상대 건물을 클릭', false); return; }
    if (p.kind === 'cardBlackout') { this.showBanner('정전시킬 상대 도시를 클릭', false); return; }
    // 내 결정 모달 (이미 같은 종류 열려있으면 유지)
    const disc = 'tile' in p ? p.tile : '';
    const kind = `${p.kind}:${disc}`;
    if (this.openKind === kind && this.modalScrim) { if (p.kind === 'build') this.refreshBuildMenu(state); return; }
    this.openKind = kind;
    if (p.kind === 'travelOffer') this.travelOfferModal(state, p.cost);
    else if (p.kind === 'buy') this.buyOrAcquireModal(state, p.tile, false);
    else if (p.kind === 'acquire') this.buyOrAcquireModal(state, p.tile, true);
    else if (p.kind === 'tollAsk') this.tollAskModal(p.tile, p.toll, p.card);
    else if (p.kind === 'build') this.buildMenuModal(state, p.tile);
    else if (p.kind === 'card') this.cardModal(state, p.card);
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
    this.mountScrim(scrim); this.openKind = key;
    scrim.querySelector<HTMLButtonElement>('.bm-yes')?.addEventListener('click', () => this.cb.onEventOk());
  }

  /** 땅 판매 모달. raiseAmount!=null 이면 자금 마련(지불/파산), null 이면 자발적 판매(닫기). */
  private sellModal(state: BMState, raiseAmount: number | null): void {
    const me = this.myId;
    const money = state.players[me]?.money ?? 0;
    const mine = Object.keys(state.owner).map(Number).filter((i) => state.owner[i] === me);
    const key = raiseAmount != null ? `raise:${raiseAmount}:${mine.length}:${money}` : `sell:${mine.length}:${money}`;
    if (this.openKind === key && this.modalScrim) return;
    this.closeModal();
    // 자금 마련 중이면 "아직 얼마 부족한지" 기준으로 각 땅이 부족액을 얼마나 메우는지 같이 보여준다
    const short = raiseAmount != null ? Math.max(0, raiseAmount - money) : 0;

    // 다 팔아도 못 갚으면(총자산 < 청구액) 땅 목록/지불 버튼은 의미가 없다 → 파산 버튼만 남긴다
    if (raiseAmount != null && totalAssets(state, me) < raiseAmount) {
      const lack = raiseAmount - totalAssets(state, me);
      const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
      scrim.innerHTML = `<div class="bm-modal" style="width:310px">
        <div class="bm-top" style="background:linear-gradient(90deg,#ff8a8a,#e03131)">파산</div>
        <div class="bm-body">
          <div class="bm-ctitle">₩${raiseAmount.toLocaleString()} 내야 해요</div>
          <div class="bm-sub">현금 ₩${money.toLocaleString()} · 부동산 ₩${estateValue(state, me).toLocaleString()}<br>
            <b style="color:#ff2d55">전부 팔아도 ₩${lack.toLocaleString()} 부족해요</b></div>
          <div class="bm-btns"><button class="bm-no" id="bm-giveup" style="flex:1">파산하기</button></div>
        </div></div>`;
      this.mountScrim(scrim); this.openKind = key;
      scrim.querySelector<HTMLButtonElement>('#bm-giveup')?.addEventListener('click', () => this.cb.onGiveUp());
      return;
    }

    const rows = mine.length
      ? mine.map((i) => {
        const rf = sellRefund(state, i);
        // 이걸 팔면 부족액이 해결되는 땅만 표시. (모자란 땅에 '얼마 부족'까지 붙이면 잔소리 같음)
        const fill = raiseAmount != null && short > 0 && rf >= short
          ? `<span class="bm-sellfill done">이거면 충분!</span>` : '';
        return `<div class="bm-sellrow"><span class="bm-sellnm" style="border-left-color:${tileColor(i)}">${(BOARD[i] as { name: string }).name}</span>${fill}<span class="bm-sellval">+₩${rf.toLocaleString()}</span><button class="bm-sellone" data-t="${i}">팔기</button></div>`;
      }).join('')
      : `<div class="bm-sub" style="padding:12px 0">팔 수 있는 땅이 없어요</div>`;
    const head = raiseAmount != null
      ? `<div class="bm-ctitle">₩${raiseAmount.toLocaleString()} 내야 해요</div>
         <div class="bm-raisebar"><span style="width:${Math.min(100, Math.round(money / Math.max(1, raiseAmount) * 100))}%"></span></div>
         <div class="bm-sub">지금 ₩${money.toLocaleString()} · ${short > 0
        ? `<b style="color:#ff2d55">₩${short.toLocaleString()} 더 필요</b>`
        : `<b style="color:#2f9e44">지불 가능!</b>`}</div>`
      : `<div class="bm-ctitle">내 땅 팔기</div><div class="bm-sub">지금 ₩${money.toLocaleString()}</div>`;
    const foot = raiseAmount != null
      ? `<div class="bm-btns"><button class="bm-yes" id="bm-pay" ${money >= raiseAmount ? '' : 'disabled'} style="flex:1">지불</button><button class="bm-no" id="bm-giveup" style="flex:1">파산</button></div>`
      : `<div class="bm-btns"><button class="bm-no" id="bm-closesell" style="flex:1">닫기</button></div>`;
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal" style="width:330px"><div class="bm-top" style="background:linear-gradient(90deg,#ff9bbb,#ff5a92)">🏷️ 땅 판매</div>` +
      `<div class="bm-body">${head}<div class="bm-selllist">${rows}</div>${foot}</div></div>`;
    this.mountScrim(scrim); this.openKind = key;
    scrim.querySelectorAll<HTMLButtonElement>('.bm-sellone').forEach((b) => b.addEventListener('click', () => this.cb.onSell(Number(b.dataset.t))));
    scrim.querySelector<HTMLButtonElement>('#bm-pay')?.addEventListener('click', () => this.cb.onPayDebt());
    scrim.querySelector<HTMLButtonElement>('#bm-giveup')?.addEventListener('click', () => this.cb.onGiveUp());
    scrim.querySelector<HTMLButtonElement>('#bm-closesell')?.addEventListener('click', () => this.closeModal());
  }

  /**
   * 오락실: ① 한다/안 한다 → ② 한다면 판돈(100·200·300) 선택.
   * mine=false 면 구경 모드 — 버튼 없이 "누가 고르는 중"만 표시.
   * (판돈 고르는 단계는 로컬 UI 상태라 state 에 없어서, 구경하는 쪽엔 진행 단계까진 안 보임)
   */
  private bonusOfferModal(money: number, mine: boolean, who: string): void {
    this.closeModal();
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal" style="width:300px"><div class="bm-top" style="background:linear-gradient(90deg,#b89aff,#8a5fd0)">보너스 게임</div>
      <div class="bm-body" id="bm-bonusbody"></div></div>`;
    this.mountScrim(scrim); this.openKind = 'bonusOffer:';
    const body = scrim.querySelector<HTMLElement>('#bm-bonusbody')!;
    if (!mine) {
      body.innerHTML = `<div class="bm-sub">판돈을 걸고 2지선다! 맞히면 ×2씩(최대 8배)</div>
        <div class="bm-bonuspot">할지 · 판돈 고민 중</div>
        <div class="bm-actft"><span class="bm-sp"></span><span><b>${who}</b>님 차례…</span></div>`;
      return;
    }
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

  /**
   * 세계여행 목적지 선택 모드.
   * 32칸 전부가 클릭 대상인데 코너·특수칸(.bm-illtile)엔 커서/호버가 아예 없어서
   * "여긴 못 고르는 칸"처럼 보였다 → bm-traveling 으로 모든 칸에 클릭 표시를 켠다.
   */
  private setTravelMode(on: boolean): void {
    this.travelMode = on;
    this.root.classList.toggle('bm-traveling', on);
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
    this.mountScrim(scrim); this.openKind = key;
    scrim.querySelector<HTMLButtonElement>('.bm-bskip')?.addEventListener('click', () => this.cb.onPickCity(-1));
  }

  /** 올림픽 개최 / 추가 건설: 내 도시 하나 선택 */
  /** 오락실(보너스 게임): 2지선다 + 받기. mine=false 면 구경 모드(버튼 비활성 + 대기 표시) */
  private bonusModal(round: number, pot: number, mine: boolean, who: string): void {
    this.closeModal();
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    const dis = mine ? '' : 'disabled';
    scrim.innerHTML = `<div class="bm-modal" style="width:300px"><div class="bm-top" style="background:linear-gradient(90deg,#b89aff,#8a5fd0)">보너스 게임</div>
      <div class="bm-body">
        <div class="bm-sub">둘 중 하나! 맞히면 ×2 (최대 8배)</div>
        <div class="bm-bonuspot">누적 <b>₩${pot.toLocaleString()}</b>${round > 0 ? ` <span style="color:#8a5fd0">(${Math.pow(2, round)}배)</span>` : ''}</div>
        <div class="bm-bchoices"><button class="bm-bchoice" data-c="0" ${dis}>왼쪽</button><button class="bm-bchoice" data-c="1" ${dis}>오른쪽</button></div>
        ${mine
          ? (round > 0 ? `<div class="bm-btns"><button class="bm-no" style="flex:1">₩${pot.toLocaleString()} 받고 종료</button></div>` : '')
          : `<div class="bm-actft"><span class="bm-sp"></span><span><b>${who}</b>님 선택 대기…</span></div>`}
      </div></div>`;
    this.mountScrim(scrim); this.openKind = `bonus:${round}:${pot}`;
    if (!mine) return;
    scrim.querySelectorAll<HTMLButtonElement>('.bm-bchoice').forEach((b) => {
      b.onclick = () => this.cb.onBonusPick(Number(b.dataset.c));
    });
    scrim.querySelector<HTMLButtonElement>('.bm-no')?.addEventListener('click', () => this.cb.onBonusStop());
  }

  /** 다른 사람 차례일 때 — 구매 카드와 같은 크기의 카드로 "OO님이 ~ 중" 표시(딤 없이 판은 계속 보이게) */
  /**
   * 세계여행 칸에 서서 턴이 시작됐을 때 — 갈지 말지.
   * 가면 비용을 내고 원하는 칸으로(그게 이번 턴의 이동), 안 가면 평소처럼 주사위.
   * 현금이 모자라면 '간다'를 잠근다.
   */
  private travelOfferModal(state: BMState, cost: number): void {
    // 이 파일 모달 규약: ① 직전 모달을 닫고 ② mountScrim 후 openKind 를 직접 세운다.
    // ①을 빼먹으면 이전 모달(예: 상대방 건설 대기창)이 위에 남아 클릭을 먹고,
    // ②를 빼먹으면 renderPending 이 매 프레임 다시 그려서 버튼이 계속 새로 만들어진다.
    this.closeModal();
    const money = state.players[this.myId]?.money ?? 0;
    const canGo = money >= cost;
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal" style="width:300px">
      <div class="bm-top" style="background:linear-gradient(90deg,#9cc6f2,#5b9be6)">${IC.rocket} 세계여행</div>
      <div class="bm-body">
        <div class="bm-ctitle">₩${cost.toLocaleString()} 내고 원하는 칸으로 갈까요?</div>
        <div class="bm-sub">가면 이번 턴은 주사위 대신 이동해요${canGo ? '' : `<br><b style="color:#ff2d55">현금이 ₩${(cost - money).toLocaleString()} 부족해요</b>`}</div>
        <div class="bm-btns">
          <button class="bm-yes" id="bm-tgo" style="flex:1" ${canGo ? '' : 'disabled'}>간다</button>
          <button class="bm-no" id="bm-tno" style="flex:1">안 간다</button>
        </div>
      </div></div>`;
    this.mountScrim(scrim); this.openKind = 'travelOffer:';
    scrim.querySelector<HTMLButtonElement>('#bm-tgo')?.addEventListener('click', () => this.cb.onDecision(true));
    scrim.querySelector<HTMLButtonElement>('#bm-tno')?.addEventListener('click', () => this.cb.onDecision(false));
  }

  /**
   * 게임 시작 전 순서 정하기 창.
   * 좌석 순으로 전원을 늘어놓고 각자 굴린 값을 보여준다. 아직 안 굴린 사람은 흐리게,
   * 재굴림(동점) 대상은 값 뒤에 추가 굴림이 붙는다. 전원 확정되면 1·2·3위 순위를 매겨 보여줌.
   */
  private orderModal(state: BMState, myPeerId: string, isSpectator: boolean): void {
    const waiting = state.orderPending;
    const done = waiting.length === 0;
    const iCanRoll = !isSpectator && waiting.includes(myPeerId);
    // 확정되면 order 가 결과 순서, 아니면 좌석 순으로 보여준다
    const list = state.order;
    const key = `order:${done ? 'done' : ''}:${list.map((p) => (state.orderRolls[p] ?? []).join('.')).join('|')}`
      + `:${waiting.join(',')}:${iCanRoll}`;
    if (this.openKind === key && this.modalScrim) return;
    this.closeModal();

    const rows = list.map((pid, idx) => {
      const rolls = state.orderRolls[pid] ?? [];
      const dice = state.orderDice[pid] ?? [];
      const isWaiting = waiting.includes(pid);
      // 지난 재굴림은 합계만 작게, 마지막 굴림만 주사위 두 개 + 합계
      const past = rolls.slice(0, -1).map((v) => `<b class="sub">${v}</b><span class="bm-ordsep">→</span>`).join('');
      const lastSum = rolls[rolls.length - 1];
      const lastDice = dice[dice.length - 1];
      const val = lastSum === undefined
        ? `<span class="bm-orddim">굴리는 중</span>`
        : `${past}<span class="bm-orddice">
             <span class="bm-orddie">${diceFace(lastDice?.[0] ?? 1)}</span>
             <span class="bm-orddie">${diceFace(lastDice?.[1] ?? 1)}</span>
           </span><b class="bm-ordsum">${lastSum}</b>`;
      const rank = done ? `<span class="bm-ordrank">${idx + 1}</span>` : '<span class="bm-ordrank ghost"></span>';
      return `<div class="bm-ordrow ${isWaiting ? 'waiting' : ''}" data-pid="${escapeHtml(pid)}">
        ${rank}
        <span class="bm-pdot" style="background:${colorOf(state, pid)}"></span>
        <span class="bm-ordnm">${escapeHtml(state.players[pid]!.nickname)}${pid === myPeerId ? ' (나)' : ''}</span>
        <span class="bm-ordval">${val}</span></div>`;
    }).join('');

    const foot = done
      ? `<div class="bm-sub" style="margin-top:10px"><b>${escapeHtml(state.players[list[0]!]!.nickname)}</b>님부터 시작해요</div>`
      : iCanRoll
        ? `<button class="bm-yes" id="bm-ordroll" style="width:100%;margin-top:12px">${IC.dice} 주사위 굴리기</button>`
        : `<div class="bm-actft" style="margin-top:12px"><span class="bm-sp"></span><span>다른 사람이 굴리는 중…</span></div>`;

    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal" style="width:330px">
      <div class="bm-top" style="background:linear-gradient(90deg,#b89aff,#8a5fd0)">${IC.dice} 순서 정하기</div>
      <div class="bm-body">
        <div class="bm-sub">높게 나온 사람부터 · 동점이면 그 사람들끼리 다시</div>
        <div class="bm-ordlist">${rows}</div>
        ${foot}
      </div></div>`;
    this.mountScrim(scrim); this.openKind = key;
    scrim.querySelector<HTMLButtonElement>('#bm-ordroll')?.addEventListener('click', () => this.cb.onOrderRoll());

    // 방금 굴린 사람 주사위만 잠깐 돌린다. 이 모달은 값이 바뀔 때 통째로 다시 그려지므로,
    // 최종 눈이 이미 DOM 에 박힌 상태 → 스핀 동안만 덮어썼다가 원래 값으로 되돌린다.
    const last = state.orderLast;
    if (last && last.seq !== this.lastOrderSeq) {
      this.lastOrderSeq = last.seq;
      this.spinOrderDice(scrim, last.peer, last.dice);
    }
  }

  /** 순서 정하기 주사위 스핀 (약 0.6초). reduced-motion 이면 스핀 없이 결과만 팝 */
  private spinOrderDice(scrim: HTMLElement, peer: string, final: [number, number]): void {
    const row = Array.from(scrim.querySelectorAll<HTMLElement>('.bm-ordrow'))
      .find((r) => r.dataset.pid === peer);
    if (!row) return;
    const dies = Array.from(row.querySelectorAll<HTMLElement>('.bm-orddie'));
    const sum = row.querySelector<HTMLElement>('.bm-ordsum');
    if (dies.length < 2) return;

    const settle = (): void => {
      dies[0]!.innerHTML = diceFace(final[0]);
      dies[1]!.innerHTML = diceFace(final[1]);
      dies.forEach((d) => d.classList.remove('spin'));
      sum?.classList.add('pop');
      if (sum) sum.textContent = String(final[0] + final[1]);
    };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { settle(); return; }

    dies.forEach((d) => d.classList.add('spin'));
    if (sum) sum.textContent = '?';
    if (this.orderSpinTimer !== null) window.clearInterval(this.orderSpinTimer);
    const t0 = performance.now();
    this.orderSpinTimer = window.setInterval(() => {
      if (this.destroyed || !row.isConnected) {
        if (this.orderSpinTimer !== null) { window.clearInterval(this.orderSpinTimer); this.orderSpinTimer = null; }
        return;
      }
      if (performance.now() - t0 >= ORDER_SPIN_MS) {
        window.clearInterval(this.orderSpinTimer!); this.orderSpinTimer = null;
        settle();
        return;
      }
      dies[0]!.innerHTML = diceFace(1 + Math.floor(Math.random() * 6));
      dies[1]!.innerHTML = diceFace(1 + Math.floor(Math.random() * 6));
    }, 70);
  }

  private showActing(state: BMState, p: NonNullable<BMState['pending']>, cur: string): void {
    // raiseFunds 는 빚 대기열이 다음 사람으로 넘어가도 kind 가 같아서, debtor 를 키에 넣어야 이름이 갱신된다
    const disc = p.kind === 'card' ? p.card
      : ('tile' in p ? p.tile : p.kind === 'bonus' ? `${p.round}:${p.pot}` : p.kind === 'raiseFunds' ? p.debtor : '');
    const key = `acting:${p.kind}:${disc}`;
    if (this.openKind === key && this.modalScrim) return;  // 같은 상태면 유지(스피너 계속 회전)
    this.closeModal();
    const who = state.players[cur]!.nickname;
    const foot = `<div class="bm-actft"><span class="bm-sp"></span><span><b>${who}</b>님이 ${pendingLabel(p)} 중…</span></div>`;
    let head: string, body: string;
    if (p.kind === 'card') {
      head = `<div class="bm-top" style="background:linear-gradient(90deg,#ffd454,#ffb02e)">${IC.key} 황금열쇠</div>`;
      body = `<div class="bm-body"><div class="bm-cardic">${cardIcon(p.card)}</div><div class="bm-ctitle">${cardTitle(p.card)}</div>${foot}</div>`;
    } else if ('tile' in p) {
      const tile = p.tile;
      const label = p.kind === 'acquire' ? '인수' : p.kind === 'build' ? '건설' : p.kind === 'tollAsk' ? '통행료'
        : (BOARD[tile].type === 'island' ? '섬 구매' : '도시 구매');
      head = `<div class="bm-top" style="background:${tileColor(tile)}">${label}</div>`;
      body = `<div class="bm-body">${deedHTML(state, tile)}${foot}</div>`;
    } else {
      // 올림픽/세계여행/추가건설/보너스 — 타일 없는 행동
      head = `<div class="bm-top" style="background:linear-gradient(90deg,#b89aff,#8a5fd0)">${pendingLabel(p)}</div>`;
      body = `<div class="bm-body">${foot}</div>`;
    }
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim bm-noscrim';
    scrim.innerHTML = `<div class="bm-modal">${head}${body}</div>`;
    this.mountScrim(scrim); this.openKind = key;
  }

  /** 잠깐 뜨는 안내 토스트(돈 부족 등) — 딤 없이 판 위에 표시, 호스트가 곧 턴을 넘김 */
  private showInfo(tile: number, text: string): void {
    const key = `info:${tile}`;
    if (this.openKind === key && this.modalScrim) return;
    this.closeModal();
    const name = (BOARD[tile] as { name: string }).name;
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim bm-noscrim';
    scrim.innerHTML = `<div class="bm-toast"><b>${name}</b> · ${text}</div>`;
    this.mountScrim(scrim); this.openKind = key;
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
    this.mountScrim(scrim); this.openKind = `${isAcquire ? 'acquire' : 'buy'}:${tile}`;
    scrim.querySelector<HTMLButtonElement>('.bm-yes')!.onclick = () => this.cb.onDecision(true);
    scrim.querySelector<HTMLButtonElement>('.bm-no')!.onclick = () => this.cb.onDecision(false);
  }

  /**
   * 통행료 면제권을 쓸지 묻는 창.
   * 통행료는 남의 땅을 밟는 즉시 정산되므로, 카드를 쓸지 고를 수 있는 순간은 여기뿐이다.
   */
  private tollAskModal(tile: number, toll: number, card: number): void {
    this.closeModal();
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    scrim.innerHTML = `<div class="bm-modal"><div class="bm-top" style="background:${tileColor(tile)}">${(BOARD[tile] as { name: string }).name} 통행료</div>
      <div class="bm-body">
        <div class="bm-cardic">${cardIcon(card)}</div>
        <div class="bm-ctitle">${cardTitle(card)}</div>
        <div class="bm-mrow big"><span>내야 할 통행료</span><b>${won(toll)}</b></div>
        <div class="bm-sub">쓰면 이번 통행료가 0원 · 안 쓰면 아껴둬요</div>
        <div class="bm-btns"><button class="bm-yes">면제권 사용</button><button class="bm-no">그냥 낸다</button></div>
      </div></div>`;
    this.mountScrim(scrim); this.openKind = `tollAsk:${tile}`;
    scrim.querySelector<HTMLButtonElement>('.bm-yes')!.onclick = () => this.cb.onDecision(true);
    scrim.querySelector<HTMLButtonElement>('.bm-no')!.onclick = () => this.cb.onDecision(false);
  }

  private buildMenuModal(state: BMState, tile: number): void {
    this.closeModal();
    this.buildSel = new Set();   // 새 건설창 → 선택 초기화
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    this.mountScrim(scrim); this.openKind = `build:${tile}`;
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
    const selTotal = [...this.buildSel].reduce((v, k) => v + buildCostOf(tile, k), 0);
    const remain = p.money - selTotal;

    const rows = BUILD_TYPES.map((bt) => {
      const owned = arr.includes(bt.kind);
      const sel = this.buildSel.has(bt.kind);
      const cost = buildCostOf(tile, bt.kind);
      let st = '', can = false;
      if (owned) st = '<span style="color:#57c777">보유</span>';
      else if (p.laps < bt.lap) st = `<span style="color:#9a8a9a">${bt.lap}바퀴 필요</span>`;
      // 랜드마크 선행조건은 "이미 지어진" 3건물(arr)만 인정 — 지금 체크한 것(buildSel)은 안 됨.
      // 안 그러면 한 창에서 3개를 함께 체크하는 순간 랜드마크까지 열려 땅 구매~랜드마크가 한 턴에 끝난다.
      else if (bt.kind === 'landmark' && !hasAllHouses(arr)) st = '<span style="color:#9a8a9a">3건물 지은 뒤 다시 방문</span>';
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
    // 뽑은 즉발 카드는 전부 즉시 사용 — 보관 옵션 없음(보관형 카드는 애초에 뽑는 즉시 자동 저장됨)
    const scrim = document.createElement('div'); scrim.className = 'bm-scrim';
    const btns = `<div class="bm-btns"><button class="bm-yes" style="background:#b89aff;color:#fff">확인</button></div>`;
    scrim.innerHTML = `<div class="bm-modal"><div class="bm-top" style="background:linear-gradient(90deg,#ffd454,#ffb02e)">${IC.key} 황금열쇠</div>
      <div class="bm-body"><div class="bm-cardic">${cardIcon(cardId)}</div>
        <div class="bm-ctitle">${cardTitle(cardId)}</div><div class="bm-cdesc">${cardDesc(cardId)}</div>${btns}</div></div>`;
    this.mountScrim(scrim); this.openKind = `card:${cardId}`;
    scrim.querySelector<HTMLButtonElement>('.bm-yes')!.onclick = () => this.cb.onCard(false);
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
    this.mountScrim(scrim, false);
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

  /** 주사위/이동/카드 애니 재생 중인지 (index 가 종료 타이밍 맞출 때 사용) */
  isBusy(): boolean { return this.busy; }

  /** index 가 매 render 마다 최신 state 를 넘겨 정보모달 등에 쓰게 */
  setLastState(state: BMState): void { this._lastState = state; }
}

// ── 렌더 밖 헬퍼 ──
function colorOf(state: BMState, peerId: string): string {
  const idx = state.order.indexOf(peerId);
  // 파스텔 도시색 위에서 확실히 튀도록 진한 채도. 앞 4개(2~4인)를 최대한 대비되게.
  return ['#0ca678', '#e64980', '#3b5bdb', '#f59f00', '#7950f2', '#e8590c', '#2f9e44', '#1098ad', '#c2255c', '#f783ac'][idx % 10]!;
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
const cardTitle = (id: number): string => CARDS[id]?.title ?? '카드';
const cardDesc = (id: number): string => CARDS[id]?.desc ?? '';
const pendingLabel = (p: NonNullable<BMState['pending']>): string =>
  p.kind === 'buy' ? '구매 고민' : p.kind === 'build' ? '건설' : p.kind === 'acquire' ? '인수 고민'
  : p.kind === 'tollAsk' ? '면제권 사용 고민'
  : p.kind === 'olympic' ? '올림픽 개최' : p.kind === 'travel' || p.kind === 'travelOffer' ? '세계여행'
  : p.kind === 'startBuild' ? '추가 건설' : p.kind === 'bonus' || p.kind === 'bonusOffer' ? '보너스 게임'
  : p.kind === 'cardSwapMine' || p.kind === 'cardSwapTheirs' ? '도시 교환' : p.kind === 'cardQuake' ? '지진' : p.kind === 'cardBlackout' ? '정전'
  : p.kind === 'raiseFunds' ? '자금 마련' : '카드 확인';

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
.bm-board{position:relative;height:100%;aspect-ratio:1;max-width:calc(100% - 275px);display:grid;
  grid-template-columns:repeat(9,1fr);grid-template-rows:repeat(9,1fr);
  gap:3px;background:linear-gradient(135deg,#e9f7ff,#ffeaf3);border-radius:16px;padding:7px;box-shadow:0 8px 26px rgba(120,80,140,.14);}
.bm-tile{position:relative;background:#fff;border:1px solid #efe3f2;border-radius:6px;overflow:hidden;min-width:0;display:flex;flex-direction:column;}
.bm-prop{cursor:pointer;transition:transform .12s ease,box-shadow .12s ease,filter .12s ease;}
.bm-prop:hover{transform:translateY(-3px) scale(1.05);z-index:6;filter:brightness(1.07) saturate(1.08);
  box-shadow:0 10px 20px rgba(60,40,80,.34);outline:2.5px solid rgba(255,255,255,.92);outline-offset:-2px;border-radius:8px;}
@media(prefers-reduced-motion:reduce){.bm-prop{transition:none;} .bm-prop:hover{transform:none;}}
/* 세계여행 목적지 선택 — 32칸 전부 클릭 가능하다는 걸 커서/호버로 알려줌 */
.bm-root.bm-traveling .bm-tile{cursor:pointer;transition:transform .12s ease,box-shadow .12s ease,filter .12s ease;}
.bm-root.bm-traveling .bm-tile:hover{transform:translateY(-3px) scale(1.05);z-index:6;filter:brightness(1.07) saturate(1.08);
  box-shadow:0 10px 20px rgba(60,40,80,.34);outline:3px solid #ffd454;outline-offset:-2px;border-radius:8px;}
@media(prefers-reduced-motion:reduce){.bm-root.bm-traveling .bm-tile{transition:none;} .bm-root.bm-traveling .bm-tile:hover{transform:none;}}
/* 칸 선택 모드(올림픽 개최/추가 건설): 내 땅만 밝게, 나머지 어둡게 */
.bm-root.bm-picking .bm-tile{filter:brightness(.42) saturate(.7);transition:filter .2s;}
.bm-root.bm-picking .bm-tile.bm-pickable{filter:none;cursor:pointer;outline:3px solid #ffd454;outline-offset:-2px;border-radius:8px;z-index:5;animation:bm-pickpulse 1.1s ease-in-out infinite;}
@keyframes bm-pickpulse{0%,100%{box-shadow:0 0 0 rgba(255,206,70,.4);}50%{box-shadow:0 0 16px 2px rgba(255,206,70,.9);}}
@media(prefers-reduced-motion:reduce){.bm-root.bm-picking .bm-tile.bm-pickable{animation:none;}}
/* 도시·관광지 이름 — 칸 중앙 정렬(아이콘 없음) */
.bm-cinfo{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:5px;text-align:center;z-index:1;}
.bm-cnm{font-size:15px;font-weight:800;color:#2c2136;text-shadow:0 1px 0 rgba(255,255,255,.4);line-height:1.12;overflow:hidden;text-overflow:ellipsis;}
.bm-isle .bm-cnm{color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6),0 0 3px rgba(0,0,0,.45);}
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
/* 정전(디버프) — 어둡게 + 번개 */
.bm-blackout{position:absolute;inset:0;z-index:3;background:rgba(20,20,40,.5);display:flex;align-items:center;justify-content:center;pointer-events:none;}
.bm-blackout svg{width:34px;height:34px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.6));}
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
.bm-fxnum.fire{color:#ff2d55;text-shadow:0 0 16px rgba(255,60,90,.7),0 3px 10px rgba(0,0,0,.3);}
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
/* 지진 — 타일 흔들림 + 파편 */
.bm-tile.bm-quakeshake{animation:bm-qshake .5s cubic-bezier(.36,.07,.19,.97);z-index:7;}
@keyframes bm-qshake{10%,90%{transform:translate(-2px,1px);}30%,70%{transform:translate(3px,-2px);}50%{transform:translate(-4px,2px);}}
.bm-debris{position:absolute;z-index:32;pointer-events:none;}
.bm-debris span{position:absolute;width:7px;height:7px;background:#b08050;border-radius:1px;box-shadow:0 1px 2px rgba(0,0,0,.35);
  animation:bm-debris .8s ease-out forwards;}
@keyframes bm-debris{0%{opacity:1;transform:translate(0,0) rotate(0);}100%{opacity:0;transform:translate(var(--dx),calc(var(--dy) * -1 + 60px)) rotate(220deg);}}
/* 도시 교환 — 두 타일 반짝 */
.bm-tile.bm-swapglow{z-index:7;animation:bm-swapg .9s ease-in-out;}
@keyframes bm-swapg{0%,100%{box-shadow:none;}30%,70%{box-shadow:0 0 0 3px #fff,0 0 18px 4px #7950f2;}}
/* 카드 사용 토스트 */
.bm-cardtoast{position:absolute;top:32%;left:50%;transform:translate(-50%,-50%);z-index:60;pointer-events:none;
  background:rgba(74,58,74,.94);color:#fff;font-size:15px;font-weight:800;padding:11px 22px;border-radius:14px;
  box-shadow:0 12px 30px rgba(0,0,0,.3);animation:bm-fxnum 1.4s cubic-bezier(.2,1.3,.4,1) forwards;}
.bm-fxnum.jackpot{color:#ffab1c;text-shadow:0 0 18px rgba(255,171,28,.7),0 3px 10px rgba(0,0,0,.3);}
/* 동작 최소화 — 흔들림·비행·파편 등 전정계 자극 애니를 정적/페이드로 대체 */
@media(prefers-reduced-motion:reduce){
  .bm-plane{transition:none;}
  .bm-tile.bm-quakeshake{animation:none;}
  .bm-debris,.bm-coins{display:none;}
  .bm-tile.bm-swapglow{animation:none;box-shadow:0 0 0 3px #fff,0 0 14px 3px #7950f2;}
  .bm-fxnum,.bm-cardtoast,.bm-toast{animation:bm-rmfade .25s ease forwards;}
  .bm-diceres{transition:opacity .18s;transform:none;}
}
@keyframes bm-rmfade{from{opacity:0;}to{opacity:1;}}
.bm-toks{position:absolute;bottom:15px;left:0;right:0;display:flex;gap:1px;justify-content:center;flex-wrap:wrap;pointer-events:none;z-index:8;}
.bm-tok{width:25px;height:31px;display:block;}
/* 흰색 후광(2겹) + 진한 그림자 → 알록달록한 칸 위에서도 말이 또렷하게 뜬다 */
.bm-tok svg{width:100%;height:100%;display:block;filter:drop-shadow(0 0 1.4px #fff) drop-shadow(0 0 1.4px #fff) drop-shadow(0 2px 3px rgba(0,0,0,.45));}
/* 내 말 — 조금 더 크게 + 살짝 통통 튀어 항상 찾기 쉽게 */
.bm-tok.me{width:29px;height:36px;z-index:9;}
.bm-tok.me svg{filter:drop-shadow(0 0 2px #fff) drop-shadow(0 0 2px #fff) drop-shadow(0 3px 4px rgba(0,0,0,.5));animation:bm-tokbob 1.3s ease-in-out infinite;}
@keyframes bm-tokbob{0%,100%{transform:translateY(0);}50%{transform:translateY(-3px);}}
@media (prefers-reduced-motion:reduce){.bm-tok.me svg{animation:none;}}
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
/* 진행 안내(state.log) — 방금 무슨 일이 일어났는지 한 줄 */
.bm-log{max-width:min(90%,340px);min-height:17px;font-size:12px;font-weight:700;line-height:1.35;color:#8a7a8a;text-align:center;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}
.bm-roll{font:inherit;font-weight:800;font-size:14px;color:#fff;background:#ff5a92;border:none;border-radius:999px;padding:9px 20px;cursor:pointer;box-shadow:0 6px 16px rgba(255,90,146,.32);display:flex;align-items:center;gap:5px;}
.bm-roll svg{width:18px;height:18px;} .bm-roll:disabled{opacity:.45;cursor:default;}
.bm-escape{font:inherit;font-weight:800;font-size:13px;color:#7a5a10;background:linear-gradient(135deg,#ffe7a0,#ffcf4a);border:none;border-radius:999px;padding:8px 18px;cursor:pointer;box-shadow:0 5px 14px rgba(200,150,30,.32);align-items:center;justify-content:center;}
.bm-escape:disabled{opacity:.45;cursor:default;}
.bm-sellbtn{font:inherit;font-weight:800;font-size:12.5px;color:#a83e6a;background:#fff;border:1.5px solid #ffb3cd;border-radius:999px;padding:7px 15px;cursor:pointer;box-shadow:0 4px 12px rgba(255,90,146,.18);align-items:center;justify-content:center;margin-top:6px;}
.bm-sellbtn:hover{background:#fff0f5;}
.bm-selllist{display:flex;flex-direction:column;gap:6px;max-height:230px;overflow-y:auto;margin:10px 0;}
.bm-sellrow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:10px;background:#faf6f9;}
.bm-sellnm{flex:1;font-weight:800;font-size:13px;color:#4a3a4a;border-left:4px solid #ccc;padding-left:8px;text-align:left;}
.bm-sellval{font-weight:800;font-size:12.5px;color:#2f9e44;}
/* 자금 마련: 부족액 진행바 + 이 땅을 팔면 얼마가 채워지는지 */
.bm-raisebar{height:9px;border-radius:999px;background:#f0e6ef;overflow:hidden;margin:9px 0 7px;}
.bm-raisebar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#ffb01c,#2f9e44);transition:width .25s ease;}
.bm-sellfill{font-size:11px;font-weight:800;color:#c2255c;white-space:nowrap;}
.bm-sellfill.done{color:#2f9e44;}
.bm-sellone{font:inherit;font-weight:800;font-size:12px;color:#fff;background:#ff5a92;border:none;border-radius:8px;padding:5px 12px;cursor:pointer;}
.bm-sellone:hover{filter:brightness(1.05);}
.bm-panel{width:262px;display:flex;flex-direction:column;gap:12px;}
/* 사회복지기금 — 패널 맨 위(화면 우측 상단). 벌금·세금이 여기 쌓이고 카드로 한 방에 나감 */
.bm-fund{display:flex;align-items:center;gap:7px;padding:9px 12px;border-radius:14px;
  background:linear-gradient(135deg,#fff6da,#ffe9f2);border:1.5px solid #ffd98a;
  box-shadow:0 4px 14px rgba(200,150,60,.14);}
.bm-fund.empty{background:rgba(255,255,255,.6);border-color:rgba(216,199,255,.7);box-shadow:none;}
.bm-fund.empty .bm-famt{color:#a99aa9;}
.bm-fic{display:flex;flex:none;} .bm-fic svg{width:21px;height:21px;}
.bm-ftxt{flex:1;font-size:11.5px;font-weight:800;color:#8a6a3a;}
.bm-fund.empty .bm-ftxt{color:#8a7a8a;}
.bm-famt{font-size:14px;font-weight:900;color:#c2255c;font-variant-numeric:tabular-nums;}
.bm-fund.bump{animation:bm-fundbump .5s cubic-bezier(.34,1.56,.64,1);}
@keyframes bm-fundbump{0%{transform:scale(1);}45%{transform:scale(1.07);}100%{transform:scale(1);}}
/* 현금 증감 뱃지 오버레이 — 행 HTML 은 매 렌더 다시 그려지므로 뱃지는 이 밖에 얹는다 */
.bm-pcard{position:relative;background:rgba(255,255,255,.72);border:1px solid rgba(216,199,255,.7);border-radius:14px;padding:12px;box-shadow:0 4px 14px rgba(120,80,140,.08);}
.bm-pcard h3{margin:0 0 8px;font-size:12px;color:#8a7a8a;font-weight:800;}
/* 카드 바깥(오른쪽)으로 빼서 현금 숫자를 가리지 않게 한다 → overflow 는 visible */
.bm-mfx{position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none;overflow:visible;}
.bm-mdelta{position:absolute;left:calc(100% + 10px);padding:4px 10px;border-radius:999px;font-size:13px;font-weight:900;
  font-variant-numeric:tabular-nums;white-space:nowrap;color:#fff;
  box-shadow:0 3px 10px rgba(60,40,60,.22);animation:bm-mdelta 2.2s ease-out forwards;}
.bm-mdelta.up{background:#2f9e44;}
.bm-mdelta.down{background:#e03131;}
/* 패널 옆에서 살짝 밀려나오며 팝 → 충분히 머무름(여기서 읽음) → 위로 흘리며 사라짐 */
@keyframes bm-mdelta{
  0%{transform:translateX(-10px) scale(.7);opacity:0;}
  9%{transform:translateX(0) scale(1.12);opacity:1;}
  16%{transform:translateX(0) scale(1);opacity:1;}
  72%{transform:translateX(0) scale(1);opacity:1;}
  100%{transform:translateX(0) translateY(-22px) scale(.94);opacity:0;}
}
@media(prefers-reduced-motion:reduce){
  .bm-mdelta{animation:bm-mdelta-rm 2.2s linear forwards;}
  @keyframes bm-mdelta-rm{0%{opacity:0;}5%{opacity:1;}80%{opacity:1;}100%{opacity:0;}}
  .bm-fund.bump{animation:none;}
}
.bm-plegend{float:right;font-size:10px;font-weight:700;color:#a99aa9;}
.bm-prow{display:flex;align-items:center;gap:8px;padding:6px 7px;border-radius:9px;}
.bm-prow.active{background:#fff0f6;box-shadow:inset 0 0 0 1px rgba(255,90,146,.3);} .bm-prow.dead{opacity:.5;}
.bm-pdot{width:13px;height:13px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.18);flex:none;}
.bm-pcol{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.bm-pright{text-align:right;display:flex;flex-direction:column;gap:1px;}
.bm-pname{font-size:12.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.bm-pmoney{font-size:12.5px;font-weight:800;font-variant-numeric:tabular-nums;}
.bm-ptotal{font-size:10.5px;font-weight:700;color:#8a7a8a;font-variant-numeric:tabular-nums;}
.bm-pprops{font-size:10.5px;color:#8a7a8a;}
/* 순서 정하기 */
.bm-ordlist{display:flex;flex-direction:column;gap:5px;margin-top:10px;}
.bm-ordrow{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:10px;background:#f7f4fb;}
.bm-ordrow.waiting{opacity:.55;}
.bm-ordrank{flex:none;width:19px;height:19px;border-radius:50%;background:#8a5fd0;color:#fff;font-size:11px;font-weight:900;
  display:flex;align-items:center;justify-content:center;}
.bm-ordrank.ghost{background:transparent;}
.bm-ordnm{flex:1;min-width:0;font-size:12.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.bm-ordval{display:flex;align-items:center;gap:5px;font-size:15px;font-weight:900;color:#6a4fa0;font-variant-numeric:tabular-nums;}
.bm-ordval .sub{font-size:12px;opacity:.55;}
.bm-ordsep{font-size:10px;color:#a99aa9;}
.bm-orddim{font-size:11.5px;font-weight:700;color:#a99aa9;}
.bm-orddice{display:flex;gap:3px;}
.bm-orddie{width:22px;height:22px;background:#fff;border-radius:6px;display:grid;place-items:center;
  box-shadow:0 1px 4px rgba(120,80,140,.25);}
.bm-orddie svg{width:84%;height:84%;}
.bm-orddie.spin{animation:bm-ordspin .16s linear infinite;}
@keyframes bm-ordspin{0%{transform:rotate(-9deg) translateY(0);}50%{transform:rotate(9deg) translateY(-2px);}100%{transform:rotate(-9deg) translateY(0);}}
.bm-ordsum{min-width:20px;text-align:right;}
.bm-ordsum.pop{animation:bm-ordpop .34s cubic-bezier(.34,1.56,.64,1);}
@keyframes bm-ordpop{0%{transform:scale(.6);opacity:.4;}100%{transform:scale(1);opacity:1;}}
@media(prefers-reduced-motion:reduce){.bm-orddie.spin{animation:none;} .bm-ordsum.pop{animation:none;}}
.bm-heldlist{display:flex;flex-direction:column;gap:7px;} .bm-empty{font-size:12px;color:#8a7a8a;}
.bm-hcard{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:11px;background:#fff;border:1.5px solid #ffe0a8;}
.bm-hic svg{width:22px;height:22px;} .bm-htxt{flex:1;font-size:12px;font-weight:800;}
.bm-huse{font:inherit;font-size:12px;font-weight:800;color:#fff;background:#b89aff;border:none;border-radius:9px;padding:6px 11px;cursor:pointer;}
/* 모달 딤은 화면 전체가 아니라 게임판 안쪽만 — 우측 플레이어 패널은 계속 보이게.
   flex+margin:auto 로 중앙 정렬(모달이 판보다 크면 grid place-items 는 위가 잘려서 스크롤이 안 됨) */
.bm-scrim{position:absolute;inset:0;z-index:200;background:rgba(54,36,56,.42);border-radius:16px;
  display:flex;align-items:center;justify-content:center;padding:10px;overflow:auto;}
.bm-modal{width:290px;max-width:100%;margin:auto;flex:0 0 auto;background:#fff;border-radius:20px;box-shadow:0 20px 50px rgba(80,50,80,.35);overflow:hidden;animation:bm-pop .26s cubic-bezier(.34,1.56,.64,1);}
@keyframes bm-pop{from{transform:scale(.85);opacity:0;}to{transform:scale(1);opacity:1;}}
.bm-top{height:60px;display:flex;align-items:center;justify-content:center;gap:5px;color:#fff;font-size:15px;font-weight:800;} .bm-top svg{width:19px;height:19px;}
.bm-body{padding:15px 17px 17px;text-align:center;} .bm-sub{font-size:12px;color:#8a7a8a;margin-bottom:8px;}
.bm-mrow{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:3px 0;} .bm-mrow span{color:#8a7a8a;font-weight:700;} .bm-mrow b{color:#4a3a4a;font-weight:900;} .bm-mrow.big b{color:#ff5a92;font-size:16px;}
.bm-btns{display:flex;gap:10px;margin-top:12px;} .bm-btns button{flex:1;font:inherit;font-size:14px;font-weight:800;padding:11px;border-radius:13px;cursor:pointer;border:none;}
.bm-yes{background:#6ed9b3;color:#1f6a55;} .bm-no{background:#f0e8ef;color:#8a7a8a;}
/* 비활성 버튼이 눌리는 것처럼 보이면 안 됨 (돈 부족한 '간다'·'지불' 등) */
.bm-btns button:disabled{background:#ece7ee;color:#b6adb6;cursor:not-allowed;box-shadow:none;}
.bm-btns button:disabled:active{transform:none;}
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
.bm-toast{max-width:100%;text-align:center;background:rgba(74,58,74,.94);color:#fff;font-size:15px;font-weight:800;padding:14px 22px;border-radius:16px;box-shadow:0 14px 36px rgba(0,0,0,.32);animation:bm-pop .26s cubic-bezier(.34,1.56,.64,1);display:flex;align-items:center;justify-content:center;gap:12px;} .bm-toast b{color:#ffd7e6;}
.bm-bskip{pointer-events:auto;font:inherit;font-size:13px;font-weight:800;color:#4a3a4a;background:#fff;border:none;border-radius:999px;padding:6px 14px;cursor:pointer;box-shadow:0 3px 8px rgba(0,0,0,.25);}
.bm-actft{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;padding-top:11px;border-top:1px solid #f0e6f4;font-size:13px;font-weight:700;color:#6a5a6a;} .bm-actft b{color:#4a3a4a;}
.bm-actft .bm-sp{border-color:rgba(120,90,130,.28);border-top-color:#8a5a78;}
.bm-sp{width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:bm-spin .7s linear infinite;}
@keyframes bm-spin{to{transform:rotate(360deg);}}
.bm-end{position:absolute;inset:0;z-index:50;background:rgba(54,36,56,.55);display:grid;place-items:center;}
.bm-endcard{background:#fff;border-radius:20px;padding:26px 40px;box-shadow:0 16px 40px rgba(0,0,0,.3);} .bm-endt{font-size:30px;font-weight:900;}
@media(max-width:820px){.bm-root{flex-direction:column;} .bm-board{max-width:100%;height:auto;width:100%;} .bm-panel{width:100%;}
  /* 세로 레이아웃에선 패널이 화면 폭을 다 쓰므로 카드 바깥(오른쪽)에 두면 화면 밖으로 나간다 → 안쪽으로 */
  .bm-mfx{overflow:hidden;} .bm-mdelta{left:auto;right:10px;}
  @keyframes bm-mdelta{
    0%{transform:translateY(6px) scale(.7);opacity:0;}
    9%{transform:translateY(0) scale(1.12);opacity:1;}
    16%,72%{transform:translateY(0) scale(1);opacity:1;}
    100%{transform:translateY(-22px) scale(.94);opacity:0;}
  }
}
`;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}
