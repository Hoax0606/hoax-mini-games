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
import { ROLE_META, teamOf, nightStepsForSetup, setupFor, validateFreeSetup } from './rules';
import type { NightAction, NightInfo } from './netSync';

export interface WwRenderState {
  state: PublicState;
  myPeerId: string;
  isHost: boolean;
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
  /** 랜덤 모드 setup: 호스트가 카드 구성 편집 */
  onSetupAdd(role: Role): void;
  onSetupRemove(role: Role): void;
  onSetupStart(): void;
}

// ── 역할 일러스트 (인라인 SVG, viewBox 48 — 카드리빌 56px ~ 스텝 15px 까지 스케일) ──
// 굵은 면 위주로 그려 작은 크기에서도 실루엣이 살게. 팀색: 늑대=레드계, 시민=블루계 +
// 역할별 포인트색(강도·주정뱅이=골드, 말썽쟁이=라벤더).
const ROLE_SVG: Record<Role, string> = {
  // 늑대인간 — 회색 늑대 얼굴(뾰족 귀, 호박색 눈, 검은 코)
  wolf: `<svg viewBox="0 0 48 48"><path d="M9 9 L18 21 L9 22 Z" fill="#6f6a7d"/><path d="M39 9 L30 21 L39 22 Z" fill="#6f6a7d"/><path d="M11 18 Q24 11 37 18 L34 31 Q24 41 14 31 Z" fill="#9a94a6"/><path d="M17 31 Q24 35 31 31 L28 36 Q24 38 20 36 Z" fill="#dcd7e4"/><circle cx="19" cy="25" r="2.6" fill="#ffcf5c"/><circle cx="29" cy="25" r="2.6" fill="#ffcf5c"/><circle cx="19" cy="25" r="1.1" fill="#2a2732"/><circle cx="29" cy="25" r="1.1" fill="#2a2732"/><path d="M24 31 l-2.4 0 L24 34 l2.4 -3 z" fill="#2a2732"/></svg>`,
  // 예언자 — 받침대 위 수정구 + 반짝임 별
  seer: `<svg viewBox="0 0 48 48"><path d="M13 39 h22 l-3 -5 h-16 z" fill="#8b81a0"/><circle cx="24" cy="21" r="13" fill="#cbb8f6"/><circle cx="24" cy="21" r="13" fill="none" stroke="#a685f5" stroke-width="2.2"/><circle cx="19.5" cy="16.5" r="2.4" fill="#fff" opacity=".9"/><path d="M18 24 q6 4 12 0" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" opacity=".55"/><path d="M33 8 l1.3 2.7 l2.7 1.3 l-2.7 1.3 l-1.3 2.7 l-1.3 -2.7 l-2.7 -1.3 l2.7 -1.3 z" fill="#ffcf5c"/></svg>`,
  // 강도 — 눈가리개 마스크 + 모자(카드 훔치기)
  robber: `<svg viewBox="0 0 48 48"><circle cx="24" cy="27" r="13" fill="#f2dcb0"/><path d="M9 17 q15 -9 30 0 l-2.5 5 h-25 z" fill="#5a5568"/><rect x="11" y="23" width="26" height="7.5" rx="3.75" fill="#2a2732"/><circle cx="18" cy="26.7" r="1.7" fill="#fff"/><circle cx="30" cy="26.7" r="1.7" fill="#fff"/><path d="M20 34 q4 3 8 0" stroke="#c98f4a" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
  // 말썽쟁이 — 카드 두 장 + 순환 화살표(남의 카드 두 장 교환)
  troublemaker: `<svg viewBox="0 0 48 48"><rect x="7" y="17" width="14" height="19" rx="3" fill="#ecdefa" stroke="#c58fef" stroke-width="2.2"/><rect x="27" y="17" width="14" height="19" rx="3" fill="#ecdefa" stroke="#c58fef" stroke-width="2.2"/><path d="M20 12 q4 -3 9 0" stroke="#a685f5" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M29 12 l3.5 -1 l-1.5 3.4 z" fill="#a685f5"/><path d="M28 41 q-4 3 -9 0" stroke="#a685f5" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M19 41 l-3.5 1 l1.5 -3.4 z" fill="#a685f5"/></svg>`,
  // 주정뱅이 — 거품 맥주잔(안 보고 가운데 카드와 바꿈)
  drunk: `<svg viewBox="0 0 48 48"><path d="M14 17 h16 v17 a5 5 0 0 1 -5 5 h-6 a5 5 0 0 1 -5 -5 z" fill="#ffcf5c" stroke="#dca83f" stroke-width="1.6"/><path d="M30 21 h3.5 a5 5 0 0 1 0 10 h-3.5" fill="none" stroke="#dca83f" stroke-width="2.4"/><path d="M15 21 h14" stroke="#fff" stroke-width="1.4" opacity=".5"/><circle cx="17" cy="14" r="3.4" fill="#fff6e4"/><circle cx="23" cy="12" r="4" fill="#fff6e4"/><circle cx="29" cy="14.5" r="3" fill="#fff6e4"/><ellipse cx="22" cy="17" rx="9" ry="3.2" fill="#fff6e4"/></svg>`,
  // 불면증 — 잠 못 드는 눈 + zzz (마지막에 자기 카드 확인)
  insomniac: `<svg viewBox="0 0 48 48"><path d="M8 27 q16 -13 30 -1" fill="none" stroke="#7c98ee" stroke-width="2.6" stroke-linecap="round"/><path d="M8 27 q15 11 30 -1" fill="none" stroke="#7c98ee" stroke-width="2.6" stroke-linecap="round"/><circle cx="23" cy="26" r="5.2" fill="#9fc5f5"/><circle cx="23" cy="26" r="2.1" fill="#2a2732"/><text x="31" y="15" font-size="11" font-weight="900" fill="#7c98ee">Z</text><text x="39" y="9" font-size="7.5" font-weight="900" fill="#a9bff0">z</text></svg>`,
  // 마을사람 — 순박한 사람(머리+어깨)
  villager: `<svg viewBox="0 0 48 48"><circle cx="24" cy="17" r="8.5" fill="#9fc5f5"/><path d="M8 41 a16 16 0 0 1 32 0 z" fill="#9fc5f5"/><circle cx="21" cy="16" r="1.4" fill="#3a5488"/><circle cx="27" cy="16" r="1.4" fill="#3a5488"/><path d="M21 20 q3 2 6 0" stroke="#3a5488" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`,
  // 하수인 — 늑대편 후드 하인(붉은 후드, 어둠 속 호박색 눈)
  minion: `<svg viewBox="0 0 48 48"><path d="M24 5 C13 5 9 17 10.5 30 L14 41 h20 l3.5 -11 C39 17 35 5 24 5 Z" fill="#c95b53"/><path d="M24 3 C15 3 11 12 11.5 22 L36.5 22 C37 12 33 3 24 3 Z" fill="#a8433c"/><path d="M16 23 q8 -5 16 0 l-2.5 8 q-5.5 4 -11 0 z" fill="#2e1f28"/><circle cx="20" cy="27" r="1.9" fill="#ffcf5c"/><circle cx="28" cy="27" r="1.9" fill="#ffcf5c"/></svg>`,
  // 메이슨 — 형제(겹친 두 사람 + 이어진 손)
  mason: `<svg viewBox="0 0 48 48"><circle cx="15" cy="15" r="6.5" fill="#7c98ee"/><circle cx="33" cy="15" r="6.5" fill="#9fc5f5"/><path d="M3 41 a12 12 0 0 1 24 0 z" fill="#7c98ee"/><path d="M21 41 a12 12 0 0 1 24 0 z" fill="#9fc5f5"/><path d="M19 27 h10" stroke="#3a5488" stroke-width="2.6" stroke-linecap="round"/></svg>`,
  // 사냥꾼 — 활 + 화살
  hunter: `<svg viewBox="0 0 48 48"><path d="M15 7 Q35 24 15 41" fill="none" stroke="#7c98ee" stroke-width="3.6" stroke-linecap="round"/><path d="M15 7 L15 41" stroke="#c98f4a" stroke-width="1.6"/><path d="M6 24 h30" stroke="#5a5568" stroke-width="2.4" stroke-linecap="round"/><path d="M36 24 l-7 -3.5 v7 z" fill="#5a5568"/><path d="M6 24 l4 -2.5 M6 24 l4 2.5" stroke="#5a5568" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>`,
  // 탄넬러 — 제3세력. 침울한 얼굴 + 눈물 (탠 브라운)
  tanner: `<svg viewBox="0 0 48 48"><circle cx="24" cy="23" r="15" fill="#cda06a"/><circle cx="18" cy="20" r="1.9" fill="#4a3520"/><circle cx="30" cy="20" r="1.9" fill="#4a3520"/><path d="M17 31 q7 -5 14 0" fill="none" stroke="#4a3520" stroke-width="2.2" stroke-linecap="round"/><path d="M31 25 q2.5 4 0 7" fill="none" stroke="#7fb0e0" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  // 도플갱어 — 복제(겹친 두 실루엣, 라벤더)
  doppelganger: `<svg viewBox="0 0 48 48"><g opacity=".45"><circle cx="19" cy="16" r="7.5" fill="#a685f5"/><path d="M6 42 a13 13 0 0 1 26 0 z" fill="#a685f5"/></g><circle cx="29" cy="17" r="8" fill="#c3a6ff"/><path d="M14 43 a15 15 0 0 1 30 0 z" fill="#c3a6ff"/></svg>`,
};

const CSS = `
.ww-root{position:relative;width:100%;flex:1 1 auto;min-height:0;
  display:flex;flex-direction:column;gap:10px;padding:14px;
  background:linear-gradient(155deg,#fff2f8 0%,#eef4ff 52%,#e9fff6 100%);
  color:#43384f;font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif;
  border-radius:var(--radius-md,16px);overflow:hidden;box-sizing:border-box;}
.ww-root *{box-sizing:border-box;}
/* hidden 속성 확실히 적용 — .ww-result/.ww-mycard 등이 display:flex 라 UA 의 [hidden]{display:none}
   을 덮어써, hidden 을 걸어도 안 숨겨지던 버그(결과 오버레이가 플레이 중 게임을 94% 흰색으로 덮음)를 차단. */
.ww-root [hidden]{display:none !important;}
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
.ww-mycard.tanner{background:linear-gradient(150deg,#f3e6cc,#fbf3e2);border-color:#d8b57e;}
.ww-mycard .ic{width:34px;height:34px;flex:none;}
.ww-mycard .nm{font-size:15px;font-weight:800;color:#43384f;}
.ww-mycard .tm{font-size:10.5px;font-weight:800;padding:1px 7px;border-radius:999px;margin-left:6px;}
.ww-mycard .tm.wolf{background:#ffdad6;color:#c8443b;}
.ww-mycard .tm.village{background:#d6e8fb;color:#2f6aa8;}
.ww-mycard .tm.tanner{background:#efdcb8;color:#8a6522;}
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
.ww-big-card.tanner{background:linear-gradient(160deg,#f2e3c4,#f8eed6);border-color:#b98a4a;box-shadow:0 10px 26px rgba(185,138,74,.22);}
.ww-big-card .ic{width:88px;height:88px;margin:2px auto 10px;}
/* .ic 안의 SVG 가 컨테이너를 꽉 채우게 (안 그러면 viewBox svg 가 작게/기본크기로 렌더됨) */
.ww-root .ic svg{width:100%;height:100%;display:block;}
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

/* 랜덤 모드 카드 구성 피커 (호스트) */
.ww-setup{width:100%;max-width:460px;margin:0 auto;display:flex;flex-direction:column;min-height:0;}
.ww-set-count{text-align:center;font-size:15px;font-weight:900;margin:2px 0;}
.ww-set-count.ok{color:#2f9e44;} .ww-set-count.bad{color:#e0679b;}
.ww-set-sub{text-align:center;font-size:11.5px;color:#8b81a0;margin-bottom:10px;}
.ww-set-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px;}
.ww-set-row{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:12px;border:1px solid #ece3f7;background:#fff;}
.ww-set-row .ic{width:30px;height:30px;flex:none;}
.ww-set-row .nm{flex:1;font-size:13.5px;font-weight:800;color:#43384f;display:flex;align-items:center;gap:7px;}
.ww-set-row .tm2{font-size:10px;font-weight:800;padding:1px 7px;border-radius:999px;}
.ww-set-row .tm2.wolf{background:#ffdad6;color:#c8443b;} .ww-set-row .tm2.village{background:#d6e8fb;color:#2f6aa8;} .ww-set-row .tm2.tanner{background:#efdcb8;color:#8a6522;}
.ww-set-row .ctl{display:flex;align-items:center;gap:8px;}
.ww-set-btn{width:28px;height:28px;border-radius:8px;border:1px solid #d8cdec;background:#fff;color:#7b61c9;font-weight:900;font-size:16px;cursor:pointer;line-height:1;}
.ww-set-btn:hover:not(:disabled){background:#f3ecff;} .ww-set-btn:disabled{opacity:.35;cursor:default;}
.ww-set-row .cnt{min-width:16px;text-align:center;font-weight:900;font-size:14px;color:#43384f;font-variant-numeric:tabular-nums;}
.ww-set-msgs{margin:8px 0 4px;display:flex;flex-direction:column;gap:4px;}
.ww-set-err{font-size:12px;color:#c8443b;font-weight:700;}
.ww-set-warn{font-size:12px;color:#c78a1a;}
.ww-set-start{margin-top:10px;flex:none;}

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
/* 도움말 버튼(상단) + 패널 오버레이 */
.ww-help-btn{margin-left:8px;flex:none;width:26px;height:26px;border-radius:50%;border:1px solid #d8cdec;
  background:#fff;color:#7b61c9;font-weight:900;font-size:14px;cursor:pointer;line-height:1;box-shadow:0 1px 3px rgba(120,90,160,.12);}
.ww-help-btn:hover{background:#f3ecff;}
.ww-help{position:absolute;inset:0;background:rgba(255,255,255,.98);z-index:6;overflow-y:auto;padding:22px 22px 30px;}
.ww-help h3{margin:0 0 4px;font-size:19px;font-weight:900;color:#43384f;}
.ww-help h4{margin:16px 0 8px;font-size:13px;font-weight:800;color:#7b61c9;letter-spacing:.02em;}
.ww-help ol{margin:0;padding-left:20px;color:#43384f;font-size:13px;line-height:1.7;}
.ww-help .win{background:#f6f1ff;border:1px solid #e6dcf4;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.6;color:#5a5070;}
.ww-help-roles{display:flex;flex-direction:column;gap:8px;}
.ww-help-role{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:12px;border:1px solid #ece3f7;background:#fff;}
.ww-help-role .ic{width:38px;height:38px;flex:none;}
.ww-help-role .info{flex:1;min-width:0;}
.ww-help-role .rn{font-size:14px;font-weight:800;color:#43384f;}
.ww-help-role .rn .cnt{color:#8b81a0;font-size:12px;font-weight:700;margin-left:4px;}
.ww-help-role .ra{font-size:11.5px;color:#8b81a0;line-height:1.4;}
.ww-help-role .team{font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;flex:none;}
.ww-help-role .team.wolf{background:#ffdad6;color:#c8443b;}
.ww-help-role .team.village{background:#d6e8fb;color:#2f6aa8;}
.ww-help-role .team.tanner{background:#efdcb8;color:#8a6522;}
.ww-help-close{margin:20px auto 0;}
.ww-banner{font-size:26px;font-weight:900;text-align:center;padding:10px 26px;border-radius:18px;margin-top:6px;}
.ww-banner.village{background:linear-gradient(135deg,#dcebff,#eef5ff);color:#2f6aa8;border:1px solid #aecbe8;}
.ww-banner.wolf{background:linear-gradient(135deg,#ffdedb,#fff0ef);color:#c8443b;border:1px solid #f2b3ae;}
.ww-banner.tanner{background:linear-gradient(135deg,#f3e6cc,#fbf3e2);color:#8a6522;border:1px solid #d8b57e;}
.ww-banner.none{background:#f0eef2;color:#6a6086;border:1px solid #ddd6e6;}
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
.ww-log-list{width:100%;max-width:440px;margin:0 auto;display:flex;flex-direction:column;gap:4px;}
.ww-log-row{font-size:12.5px;color:#5a5070;background:#fff;border:1px solid #ece3f7;border-radius:10px;padding:6px 11px;line-height:1.45;}
.ww-winners{font-size:14px;font-weight:800;color:#43384f;text-align:center;}

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
  private helpEl!: HTMLDivElement;
  private styleEl!: HTMLStyleElement;
  /** 도움말 "이 게임의 역할" 계산용 — 매 렌더 현재 인원/세팅 저장 (랜덤 모드도 정확히 반영) */
  private lastPlayerCount = 0;
  private lastSetup: Role[] = [];

  /** 스테이지 마지막 렌더 키 — 바뀔 때만 재빌드 */
  private stageKey = '';
  /** 채팅 로그에 이미 그린 줄 수 (증분 append) */
  private renderedChat = 0;
  /** 예언자 UI 로컬 선택 상태 (재빌드 사이 유지) */
  private seerTab: 'player' | 'center' = 'player';
  private seerCenters: number[] = [];
  private tmPick: string[] = [];

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
        <button class="ww-help-btn" id="ww-help" title="도움말">?</button>
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
      <div class="ww-help" id="ww-help-panel" hidden></div>
    `;
    canvas.parentElement?.appendChild(root);
    this.root = root;

    this.phaseEl = root.querySelector('#ww-phase')!;
    this.timerEl = root.querySelector('#ww-timer')!;
    this.stepsEl = root.querySelector('#ww-steps')!;
    this.playersEl = root.querySelector('#ww-players')!;
    this.mycardEl = root.querySelector('#ww-mycard')!;
    this.memoEl = root.querySelector('#ww-memo')!;
    this.stageEl = root.querySelector('#ww-stage')!;
    this.resultEl = root.querySelector('#ww-result')!;
    this.helpEl = root.querySelector('#ww-help-panel')!;
    root.querySelector<HTMLButtonElement>('#ww-help')!.addEventListener('click', () => this.showHelp());
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  /** 도움말 패널 — 진행 순서 + 승패 규칙 + "이 게임의 역할"(인원별 고정 세팅이라 정확히 표시). */
  private showHelp(): void {
    const setup = this.lastSetup.length ? this.lastSetup : setupFor(this.lastPlayerCount || 3);
    const counts = new Map<Role, number>();
    for (const r of setup) counts.set(r, (counts.get(r) ?? 0) + 1);
    // ROLE_META 정의 순서로 나열 (늑대 먼저)
    const rolesHtml = (Object.keys(ROLE_META) as Role[])
      .filter((r) => counts.has(r))
      .map((r) => {
        const t = teamOf(r);
        const c = counts.get(r)!;
        return `<div class="ww-help-role"><div class="ic">${ROLE_SVG[r]}</div>` +
          `<div class="info"><div class="rn">${ROLE_META[r].name}${c > 1 ? `<span class="cnt">×${c}</span>` : ''}</div>` +
          `<div class="ra">${ROLE_META[r].ability}</div></div>` +
          `<span class="team ${t}">${t === 'wolf' ? '늑대' : t === 'tanner' ? '단독' : '시민'}</span></div>`;
      }).join('');
    this.helpEl.innerHTML = `<h3>🌙 게임 방법</h3>
      <h4>진행 순서</h4>
      <ol><li>역할 배정 — 각자 자기 카드를 확인해요.</li>
      <li>밤 — 역할 순서대로 비밀 능력을 써요. (누가 무슨 역할인지는 공개되지 않아요.)</li>
      <li>낮 토론 — 채팅으로 서로 추리하고 블러핑해요.</li>
      <li>투표 — 가장 의심스러운 사람을 지목해요.</li>
      <li>결과 — 처형된 사람과 모두의 카드가 공개돼요.</li></ol>
      <h4>승패</h4>
      <div class="win">처형된 사람 중 <b>늑대가 있으면 시민 팀 승</b> · <b>시민만 처형되면 늑대 팀 승</b> · 아무도 처형되지 않으면 플레이어 중 늑대가 없을 때만 시민 팀 승.</div>
      <h4>이 게임의 역할 · ${this.lastPlayerCount}인 (카드 ${setup.length}장, 가운데 3장 포함)</h4>
      <div class="ww-help-roles">${rolesHtml}</div>
      <button class="ww-btn ghost ww-help-close" id="ww-help-close">닫기</button>`;
    this.helpEl.querySelector<HTMLButtonElement>('#ww-help-close')!
      .addEventListener('click', () => { this.helpEl.hidden = true; });
    this.helpEl.hidden = false;
  }

  // ============================================
  // 메인 렌더
  // ============================================

  render(rs: WwRenderState): void {
    const s = rs.state;
    this.lastPlayerCount = s.players.length;
    if (s.setup && s.setup.length) this.lastSetup = s.setup;
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
      `<span class="tm ${t}">${t === 'wolf' ? '늑대' : t === 'tanner' ? '단독' : '시민'}</span></div>` +
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
      case 'minionWolves':
        return m.peerIds.length ? `늑대: <b>${m.peerIds.map(nick).join(', ')}</b>` : '플레이어 중엔 늑대가 없어요 (가운데에만).';
      case 'masons':
        return m.solo ? '나 혼자 메이슨이에요.' : `동료 메이슨: <b>${m.peerIds.map(nick).join(', ')}</b>`;
      case 'doppelCopied':
        return `${esc(nick(m.target))}의 직업을 복사 → 이제 나는 ${rn(m.role)}`;
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
      case 'setup': this.buildSetup(rs); break;
      case 'deal': this.buildDeal(rs); break;
      case 'night': this.buildNight(rs); break;
      case 'day': this.buildDay(rs); break;
      case 'vote': this.buildVote(rs); break;
    }
  }

  private computeStageKey(rs: WwRenderState): string {
    const s = rs.state;
    switch (s.phase) {
      case 'setup': return `setup:${rs.isHost}:${s.setup.join(',')}`;
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

  // ── setup: 랜덤 모드 카드 구성 (호스트만) ──
  private static readonly PICK_ROLES: Role[] =
    ['wolf', 'minion', 'mason', 'seer', 'robber', 'troublemaker', 'drunk', 'insomniac', 'hunter', 'tanner', 'doppelganger', 'villager'];

  private buildSetup(rs: WwRenderState): void {
    const s = rs.state;
    if (!rs.isHost) {
      this.stageEl.innerHTML = `<div class="ww-wait"><div class="ww-moon">🎴</div><div class="big">방장이 직업을 고르는 중…</div><div>잠시만 기다려요</div></div>`;
      return;
    }
    const need = s.players.length + 3;
    const total = s.setup.length;
    const counts = new Map<Role, number>();
    for (const r of s.setup) counts.set(r, (counts.get(r) ?? 0) + 1);
    const check = validateFreeSetup(s.setup, s.players.length);
    const rows = WerewolfRenderer.PICK_ROLES.map((r) => {
      const c = counts.get(r) ?? 0;
      const t = teamOf(r);
      const teamTxt = t === 'wolf' ? '늑대' : t === 'tanner' ? '단독' : '시민';
      const addDisabled = total >= need || (r !== 'wolf' && c >= 1);
      return `<div class="ww-set-row"><span class="ic">${ROLE_SVG[r]}</span>` +
        `<span class="nm">${ROLE_META[r].name}<span class="tm2 ${t}">${teamTxt}</span></span>` +
        `<span class="ctl"><button class="ww-set-btn" data-rem="${r}" ${c <= 0 ? 'disabled' : ''}>−</button>` +
        `<span class="cnt">${c}</span>` +
        `<button class="ww-set-btn" data-add="${r}" ${addDisabled ? 'disabled' : ''}>＋</button></span></div>`;
    }).join('');
    const msgs = [
      ...check.errors.map((e) => `<div class="ww-set-err">⚠ ${esc(e)}</div>`),
      ...check.warnings.map((w) => `<div class="ww-set-warn">⚠ ${esc(w)}</div>`),
    ].join('');
    this.stageEl.innerHTML = `<div class="ww-setup">` +
      `<div class="ww-stage-title">직업 구성 · 랜덤 모드</div>` +
      `<div class="ww-set-count ${total === need ? 'ok' : 'bad'}">${total} / ${need}장 · 플레이어 ${s.players.length} + 가운데 3</div>` +
      `<div class="ww-set-sub">늑대만 여러 장, 나머지는 각 1장</div>` +
      `<div class="ww-set-list">${rows}</div>` +
      (msgs ? `<div class="ww-set-msgs">${msgs}</div>` : '') +
      `<button class="ww-btn ww-set-start" id="ww-set-start" ${check.ok ? '' : 'disabled'}>이 구성으로 시작</button></div>`;
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((b) =>
      b.addEventListener('click', () => this.cb.onSetupAdd(b.dataset.add as Role)));
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-rem]').forEach((b) =>
      b.addEventListener('click', () => this.cb.onSetupRemove(b.dataset.rem as Role)));
    this.stageEl.querySelector<HTMLButtonElement>('#ww-set-start')!
      .addEventListener('click', () => this.cb.onSetupStart());
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
      case 'doppelganger': {
        const copied = rs.memos.find((m) => m.kind === 'doppelCopied') as Extract<NightInfo, { kind: 'doppelCopied' }> | undefined;
        if (!copied) this.buildPickPlayer(rs, '도플갱어 — 복사할 상대를 골라요. (그 직업이 되고, 능력이 있으면 지금 써요)', (t) => this.cb.onNightAct({ kind: 'doppelCopy', target: t }));
        else this.buildDoppelActing(rs, copied.role);
        break;
      }
      case 'wolf': this.buildWolf(rs); break;
      case 'minion': this.buildMinion(rs); break;
      case 'mason': this.buildMason(rs); break;
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

  private buildMinion(rs: WwRenderState): void {
    const memo = rs.memos.find((m) => m.kind === 'minionWolves') as Extract<NightInfo, { kind: 'minionWolves' }> | undefined;
    const nick = (pid: string): string => rs.state.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    const wolves = memo?.peerIds ?? [];
    const body = wolves.length
      ? `<div class="ww-choose" style="margin-bottom:16px">` +
        wolves.map((p) => `<div class="ww-cardface"><span class="ic">${ROLE_SVG.wolf}</span><span class="cl">${esc(nick(p))}</span></div>`).join('') + `</div>`
      : `<div class="ww-stage-sub" style="margin-bottom:16px">플레이어 중엔 늑대가 없어요 (가운데 카드에만 있음).</div>`;
    this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('하수인', '늑대가 누구인지 확인하세요. 늑대는 당신을 몰라요!')}${body}` +
      `<button class="ww-btn" id="ww-mc">확인</button></div>`;
    this.stageEl.querySelector<HTMLButtonElement>('#ww-mc')!.addEventListener('click', () => this.cb.onNightAct({ kind: 'skip' }));
  }

  private buildMason(rs: WwRenderState): void {
    const memo = rs.memos.find((m) => m.kind === 'masons') as Extract<NightInfo, { kind: 'masons' }> | undefined;
    const nick = (pid: string): string => rs.state.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    const others = memo?.peerIds ?? [];
    const solo = memo?.solo ?? false;
    const body = (!solo && others.length)
      ? `<div class="ww-choose" style="margin-bottom:16px">` +
        others.map((p) => `<div class="ww-cardface"><span class="ic">${ROLE_SVG.mason}</span><span class="cl">${esc(nick(p))}</span></div>`).join('') + `</div>`
      : `<div class="ww-stage-sub" style="margin-bottom:16px">당신 혼자 메이슨이에요. 다른 메이슨은 없어요.</div>`;
    this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('메이슨', '같은 편 메이슨을 확인하세요.')}${body}` +
      `<button class="ww-btn" id="ww-mc">확인</button></div>`;
    this.stageEl.querySelector<HTMLButtonElement>('#ww-mc')!.addEventListener('click', () => this.cb.onNightAct({ kind: 'skip' }));
  }

  /** 도플갱어가 복사한 직업의 밤 행동 UI (해당 역할 UI 재사용). */
  private buildDoppelActing(rs: WwRenderState, copied: Role): void {
    switch (copied) {
      case 'seer': this.buildSeer(rs); return;
      case 'robber': {
        const robbed = rs.memos.find((m) => m.kind === 'robbed') as Extract<NightInfo, { kind: 'robbed' }> | undefined;
        if (robbed) this.buildRobberResult(rs, robbed);
        else this.buildPickPlayer(rs, '도플-강도 — 카드를 뺏을 상대를 골라요.', (t) => this.cb.onNightAct({ kind: 'robber', target: t }));
        return;
      }
      case 'troublemaker': this.buildTroublemaker(rs); return;
      case 'drunk': this.buildPickCenter(rs, '도플-주정뱅이 — 가운데 1장과 맞바꾸기 (내용은 안 보여요)', (c) => this.cb.onNightAct({ kind: 'drunk', center: c })); return;
      default: {
        // 정보/무행동 역할 복사 — 카드 보여주고 확인만 (본 정보는 왼쪽 "밤에 알게 된 것"에)
        this.stageEl.innerHTML = `<div class="ww-center">${this.stageHead('도플갱어 → ' + ROLE_META[copied].name, ROLE_META[copied].ability)}` +
          `<div class="ww-big-card ${teamOf(copied)}" style="margin-bottom:14px"><div class="ic">${ROLE_SVG[copied]}</div><div class="nm">${ROLE_META[copied].name}</div></div>` +
          `<button class="ww-btn" id="ww-dg">확인</button></div>`;
        this.stageEl.querySelector<HTMLButtonElement>('#ww-dg')!.addEventListener('click', () => this.cb.onNightAct({ kind: 'skip' }));
      }
    }
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
    // 승패는 winners 목록이 최종 권위 (탄넬러 단독승/하수인 포함 등 팀 비교로 안 잡히는 경우 커버)
    const iWon = !rs.isSpectator && rv.winners.includes(rs.myPeerId);

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
    const bannerTxt =
      win === 'village' ? '🛡️ 시민 팀 승리' :
      win === 'wolf' ? '🐺 늑대 팀 승리' :
      win === 'tanner' ? '🙃 탄넬러 단독 승리' :
      '🤝 무승부 — 아무도 이기지 못했어요';
    const winnersTxt = rv.winners.length ? rv.winners.map(nick).join(', ') : '없음';
    const logBlock = (title: string, arr: string[]): string =>
      arr.length === 0 ? '' :
      `<div class="ww-reveal-h">${title}</div><div class="ww-log-list">` +
      arr.map((l) => `<div class="ww-log-row">${esc(l)}</div>`).join('') + `</div>`;

    this.resultEl.innerHTML =
      `<div class="ww-banner ${win}">${bannerTxt}</div>` +
      (rs.isSpectator ? '' : `<div class="ww-outcome ${iWon ? 'win' : 'lose'}">${iWon ? '당신의 승리!' : '아쉽게 패배…'}</div>`) +
      `<div class="ww-outcome" style="color:#6a6086;font-size:13px">${executedTxt}</div>` +
      `<div class="ww-reveal">${cards}</div>` +
      `<div class="ww-reveal-h">가운데 카드</div><div class="ww-center-reveal">${centerCards}</div>` +
      logBlock('밤에 일어난 일', rv.nightLog) +
      logBlock('카드 교환', rv.swapLog) +
      `<div class="ww-reveal-h">승리한 사람</div><div class="ww-winners">${esc(winnersTxt)}</div>`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
