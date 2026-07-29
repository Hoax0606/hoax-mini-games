/**
 * 아발론 렌더러 (HTML DOM — 캔버스 미사용, 늑대인간과 동일 방식).
 *
 * 아서왕 톤의 파스텔 테마를 self-contained <style> 로 주입 (선=블루/골드, 악=크림슨).
 *
 * 구조:
 *   .av-root
 *     .av-top      상단바 (페이즈 / 타이머 / 도움말)
 *     .av-track    퀘스트 트랙(5칸 성공/실패) + 연속거부 표시
 *     .av-grid
 *       .av-left   플레이어 목록(리더 왕관/원정대 표시) + 내 역할 카드 + 밤 지식
 *       .av-stage  페이즈별 인터랙티브 영역 (역할확인/원정대선발/찬반투표/원정/암살)
 *     .av-chat     원정대 토론 채팅 (team/vote/quest 페이즈)
 *     .av-result   결과 오버레이 (result 페이즈)
 *     .av-help     도움말 오버레이
 *
 * 매 프레임 호출되지만, 인터랙티브 영역(.av-stage)은 stageKey 가 바뀔 때만 다시 그린다
 * (매 프레임 innerHTML 교체하면 버튼 클릭/입력 포커스가 날아가므로). 채팅은 증분 갱신.
 */

import type { PublicState, Role, Knowledge, Vote, QuestCard } from './rules';
import {
  ROLE_META, teamOf, setupFor, teamSizeFor, failsRequiredFor,
  QUEST_COUNT, MAX_REJECTS, WINS_NEEDED, countQuests,
} from './rules';

export interface AvRenderState {
  state: PublicState;
  myPeerId: string;
  isHost: boolean;
  isSpectator: boolean;
  /** 내 역할 (av:role 수신) */
  myRole: Role | null;
  /** 내 밤 지식 (av:info 수신) */
  knowledge: Knowledge | null;
  /** 남은 시간(ms). 0이면 타이머 숨김 */
  remainMs: number;
  /** deal 페이즈: 역할 확인 완료 여부 */
  confirmedDeal: boolean;
  /** vote 페이즈: 이번 제안에 투표 완료 여부 */
  votedThisRound: boolean;
  /** quest 페이즈: 카드 제출 완료 여부 */
  submitted: boolean;
  /** assassin 페이즈: 지목 완료 여부 */
  assassinDone: boolean;
}

export interface AvCallbacks {
  onReady(): void;
  onPickTeam(team: string[]): void;
  onVote(vote: Vote): void;
  onQuestCard(card: QuestCard): void;
  onAssassin(target: string): void;
  onResultNext(): void;
}

// ── 역할 일러스트 (인라인 SVG, viewBox 48). 팀색: 선=블루계, 악=레드계, 골드 포인트 ──
const ROLE_SVG: Record<Role, string> = {
  // 멀린 — 파란 마법사 고깔 + 금별 + 수염
  merlin: `<svg viewBox="0 0 48 48"><path d="M24 4 L34 27 H14 Z" fill="#5b8dd6"/><path d="M24 4 L29 27 H19 Z" fill="#7ba7e6" opacity=".6"/><circle cx="24" cy="30" r="7" fill="#ecd7ac"/><path d="M18 32 q6 9 12 0 l0 10 h-12 z" fill="#eef4fb"/><path d="M18 32 q6 6 12 0" fill="none" stroke="#c9d8ea" stroke-width="1.4"/><path d="M31 6 l1.3 2.9 l3 1.3 l-3 1.3 l-1.3 2.9 l-1.3 -2.9 l-3 -1.3 l3 -1.3 z" fill="#ffcf5c"/><circle cx="21" cy="30" r="1.3" fill="#3a5488"/><circle cx="27" cy="30" r="1.3" fill="#3a5488"/></svg>`,
  // 퍼시발 — 은빛 기사 투구 + 슬릿(멀린을 꿰뚫어봄)
  percival: `<svg viewBox="0 0 48 48"><path d="M14 20 a10 12 0 0 1 20 0 v13 a4 4 0 0 1 -4 4 h-12 a4 4 0 0 1 -4 -4 z" fill="#b9c6d6"/><path d="M14 20 a10 12 0 0 1 20 0 v3 h-20 z" fill="#cdd9e6"/><rect x="22.5" y="10" width="3" height="9" rx="1.5" fill="#5b8dd6"/><path d="M24 6 q3 3 0 6 q-3 -3 0 -6z" fill="#5b8dd6"/><rect x="17" y="24" width="14" height="3.4" rx="1.7" fill="#3a5488"/><path d="M23 30 h2 v6 h-2 z" fill="#8b9bad"/></svg>`,
  // 충직한 신하 — 파란 방패 + 십자
  loyal: `<svg viewBox="0 0 48 48"><path d="M24 5 L39 10 V25 Q39 37 24 43 Q9 37 9 25 V10 Z" fill="#5b8dd6"/><path d="M24 5 L39 10 V25 Q39 37 24 43 Z" fill="#4d7cc4"/><rect x="21.5" y="14" width="5" height="20" rx="1.5" fill="#eef4fb"/><rect x="15" y="21" width="18" height="5" rx="1.5" fill="#eef4fb"/></svg>`,
  // 암살자 — 붉은 단검
  assassin: `<svg viewBox="0 0 48 48"><path d="M24 4 L28 26 H20 Z" fill="#d7dbe0"/><path d="M24 4 L26 26 H24 Z" fill="#f2f4f6"/><rect x="16" y="26" width="16" height="4.5" rx="2" fill="#8a3b34"/><rect x="22" y="30" width="4" height="12" rx="1.5" fill="#5a5568"/><circle cx="24" cy="43" r="2.6" fill="#c95b53"/></svg>`,
  // 모르가나 — 보라 가면(멀린 흉내), 악
  morgana: `<svg viewBox="0 0 48 48"><path d="M24 6 C14 6 10 16 11 27 L14 40 h20 l3 -13 C38 16 34 6 24 6 Z" fill="#8a5bd0"/><path d="M24 4 C16 4 12 12 12 21 L36 21 C36 12 32 4 24 4 Z" fill="#6f43b8"/><path d="M15 24 q9 -5 18 0 l-2 6 q-7 4 -14 0 z" fill="#2a1f3a"/><path d="M17 27 l4 -1.5 M31 27 l-4 -1.5" stroke="#e0554d" stroke-width="1.8" stroke-linecap="round"/><circle cx="20" cy="27" r="1.6" fill="#ffcf5c"/><circle cx="28" cy="27" r="1.6" fill="#ffcf5c"/></svg>`,
  // 모드레드 — 검은 왕관, 악(멀린에게 안 보임)
  mordred: `<svg viewBox="0 0 48 48"><path d="M8 34 L8 16 L17 24 L24 12 L31 24 L40 16 L40 34 Z" fill="#c95b53"/><path d="M8 34 L8 16 L17 24 L24 12 L31 24 L40 16 L40 34 Z" fill="none" stroke="#8a3b34" stroke-width="1.5"/><rect x="8" y="34" width="32" height="5" rx="1.5" fill="#8a3b34"/><circle cx="24" cy="12" r="2.6" fill="#ffcf5c"/><circle cx="8" cy="16" r="2.2" fill="#ffcf5c"/><circle cx="40" cy="16" r="2.2" fill="#ffcf5c"/></svg>`,
  // 오베론 — 고립된 회색 후드(다른 악을 모름)
  oberon: `<svg viewBox="0 0 48 48"><path d="M24 5 C14 5 10 16 11 29 L14 41 h20 l3 -12 C39 16 34 5 24 5 Z" fill="#7d7889"/><path d="M24 3 C15 3 11 12 11.5 22 L36.5 22 C37 12 33 3 24 3 Z" fill="#615c6e"/><path d="M16 24 q8 -5 16 0 l-2.5 8 q-5.5 4 -11 0 z" fill="#2a2732"/><circle cx="24" cy="29" r="2" fill="#9a94a6"/></svg>`,
  // 하수인 — 붉은 후드 하인
  minion: `<svg viewBox="0 0 48 48"><path d="M24 5 C13 5 9 17 10.5 30 L14 41 h20 l3.5 -11 C39 17 35 5 24 5 Z" fill="#c95b53"/><path d="M24 3 C15 3 11 12 11.5 22 L36.5 22 C37 12 33 3 24 3 Z" fill="#a8433c"/><path d="M16 23 q8 -5 16 0 l-2.5 8 q-5.5 4 -11 0 z" fill="#2e1f28"/><circle cx="20" cy="27" r="1.9" fill="#ffb0a8"/><circle cx="28" cy="27" r="1.9" fill="#ffb0a8"/></svg>`,
};

/** 성공/실패/찬성/반대 마크 (인라인 SVG) */
const MARK_SUCCESS = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#2f9e6b"/><path d="M6.5 12.5 l3.5 3.5 l7.5 -8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const MARK_FAIL = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#d64545"/><path d="M8 8 l8 8 M16 8 l-8 8" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>`;

const CSS = `
.av-root{position:relative;width:100%;flex:1 1 auto;min-height:0;
  display:flex;flex-direction:column;gap:10px;padding:14px;
  background:linear-gradient(155deg,#eef4ff 0%,#f3f0ff 52%,#fff5ec 100%);
  color:#3a3550;font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif;
  border-radius:var(--radius-md,16px);overflow:hidden;box-sizing:border-box;}
.av-root *{box-sizing:border-box;}
/* [hidden] 확실히 — display:flex 요소가 UA 의 [hidden]{display:none} 을 덮어쓰는 것 차단 */
.av-root [hidden]{display:none !important;}

.av-top{display:flex;align-items:center;gap:12px;flex:none;}
.av-phase{font-size:17px;font-weight:800;letter-spacing:-.01em;color:#3a3550;}
.av-phase .r{color:#4d7cc4;}
.av-phase .e{color:#c95b53;}
.av-timer{margin-left:auto;font-size:20px;font-weight:900;color:#4d7cc4;font-variant-numeric:tabular-nums;letter-spacing:1px;}
.av-timer.warn{color:#e0554d;}
.av-help-btn{flex:none;width:26px;height:26px;border-radius:50%;border:1px solid #cdd6e6;
  background:#fff;color:#4d7cc4;font-weight:900;font-size:14px;cursor:pointer;line-height:1;box-shadow:0 1px 3px rgba(90,110,160,.14);}
.av-help-btn:hover{background:#eef4ff;}

/* 퀘스트 트랙 */
.av-track{display:flex;align-items:center;gap:10px;flex:none;flex-wrap:wrap;}
.av-quests{display:flex;gap:8px;}
.av-q{width:46px;height:46px;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;
  background:#fff;border:1.5px solid #dbe3f0;box-shadow:0 1px 4px rgba(90,110,160,.12);position:relative;}
.av-q .n{font-size:15px;font-weight:900;color:#8b93a8;line-height:1;}
.av-q .sz{font-size:9px;font-weight:700;color:#a9b0c2;margin-top:2px;}
.av-q .m{width:26px;height:26px;}
.av-q.now{border-color:#5b8dd6;box-shadow:0 0 0 3px rgba(91,141,214,.2);}
.av-q.now .n{color:#4d7cc4;}
.av-q.two{border-style:dashed;}
.av-q.success{background:#e5f6ee;border-color:#2f9e6b;}
.av-q.fail{background:#fde8e8;border-color:#d64545;}
.av-track-sep{width:1px;height:30px;background:#dbe3f0;}
.av-rejects{display:flex;align-items:center;gap:6px;font-size:12px;color:#8b93a8;font-weight:700;}
.av-rejdots{display:flex;gap:4px;}
.av-rejdots .d{width:9px;height:9px;border-radius:50%;background:#e2e6ef;}
.av-rejdots .d.on{background:#e0554d;}
.av-rejdots.danger .d.on{box-shadow:0 0 0 2px rgba(224,85,77,.25);}

.av-grid{flex:1;display:grid;grid-template-columns:212px 1fr;gap:12px;min-height:0;}
.av-left{display:flex;flex-direction:column;gap:10px;min-height:0;}
.av-players{display:flex;flex-direction:column;gap:6px;overflow-y:auto;}
.av-prow{display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:12px;
  background:rgba(255,255,255,.85);border:1px solid #e0e6f0;font-size:13px;
  box-shadow:0 1px 3px rgba(90,110,160,.1);}
.av-prow.me{border-color:#a9c4ef;background:#eef4ff;}
.av-prow.leader{border-color:#e8c96a;background:#fff7e0;}
.av-prow .crown{flex:none;font-size:14px;color:#e0a92a;display:none;}
.av-prow.leader .crown{display:inline;}
.av-prow .nm{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
.av-prow .team-badge{flex:none;font-size:10px;font-weight:800;padding:1px 7px;border-radius:999px;background:#dbeafe;color:#3a6aa8;}
.av-prow.on-team .nm::after{content:'원정';margin-left:6px;font-size:9.5px;font-weight:800;padding:1px 6px;border-radius:999px;background:#e8f0ff;color:#4d7cc4;vertical-align:middle;}

.av-mycard{border-radius:16px;padding:12px;border:1.5px solid;display:flex;gap:10px;align-items:center;flex:none;
  box-shadow:0 4px 14px rgba(90,110,160,.14);}
.av-mycard.good{background:linear-gradient(150deg,#e3efff,#f3f8ff);border-color:#aecbe8;}
.av-mycard.evil{background:linear-gradient(150deg,#ffe6e6,#fff3f3);border-color:#f2b3ae;}
.av-mycard .ic{width:34px;height:34px;flex:none;}
.av-mycard .nm{font-size:15px;font-weight:800;color:#3a3550;}
.av-mycard .tm{font-size:10.5px;font-weight:800;padding:1px 7px;border-radius:999px;margin-left:6px;}
.av-mycard .tm.good{background:#d6e8fb;color:#2f6aa8;}
.av-mycard .tm.evil{background:#ffdad6;color:#c8443b;}
.av-mycard .ab{font-size:11px;color:#8b81a0;line-height:1.4;margin-top:2px;}

.av-memo{border-radius:14px;padding:10px 12px;background:rgba(255,255,255,.85);border:1px solid #e0e6f0;
  font-size:12px;color:#5a5070;flex:none;max-height:36%;overflow-y:auto;box-shadow:0 2px 6px rgba(90,110,160,.1);}
.av-memo h4{margin:0 0 6px;font-size:11px;font-weight:800;color:#4d7cc4;letter-spacing:.02em;}
.av-memo .m{line-height:1.5;}
.av-memo b{color:#3a3550;}
.av-memo .known{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;}
.av-memo .kchip{font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:999px;background:#f0e6ff;color:#7b4fc0;}
.av-memo .kchip.evil{background:#ffe0dd;color:#c8443b;}

.av-stage{border-radius:18px;background:rgba(255,255,255,.75);border:1px solid #e6ebf5;
  padding:18px;display:flex;flex-direction:column;min-height:0;overflow:hidden;
  box-shadow:0 8px 26px rgba(90,110,160,.14);backdrop-filter:blur(6px);}
.av-stage-title{font-size:16px;font-weight:800;margin-bottom:4px;color:#3a3550;}
.av-stage-sub{font-size:12.5px;color:#8b81a0;line-height:1.5;margin-bottom:14px;}
.av-center{margin:auto;text-align:center;max-width:480px;width:100%;}

.av-big-card{width:158px;margin:0 auto 14px;border-radius:20px;padding:22px 16px;border:2px solid;}
.av-big-card.good{background:linear-gradient(160deg,#e2efff,#d0e5ff);border-color:#3b82c4;box-shadow:0 10px 26px rgba(59,130,196,.22);}
.av-big-card.evil{background:linear-gradient(160deg,#ffe0e0,#ffd0d0);border-color:#e0554d;box-shadow:0 10px 26px rgba(224,85,77,.25);}
.av-big-card .ic{width:88px;height:88px;margin:2px auto 10px;}
.av-root .ic svg{width:100%;height:100%;display:block;}
.av-big-card .nm{font-size:20px;font-weight:900;color:#3a3550;}

/* 원정대 선발/투표/원정 공통 칩 */
.av-pick{display:flex;flex-wrap:wrap;gap:9px;justify-content:center;margin:6px 0 14px;}
.av-pchip{border:1px solid #dbe3f0;background:#fff;color:#3a3550;
  border-radius:13px;padding:10px 15px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;
  box-shadow:0 2px 6px rgba(90,110,160,.1);transition:background .12s,transform .08s,border-color .12s;}
.av-pchip:hover:not(:disabled){background:#eef4ff;border-color:#a9c4ef;}
.av-pchip:active:not(:disabled){transform:scale(.96);}
.av-pchip.sel{border-color:#5b8dd6;background:#dcebff;color:#2f6aa8;box-shadow:0 0 0 2px rgba(91,141,214,.18);}
.av-pchip:disabled{opacity:.4;cursor:default;}

.av-btn{border:none;border-radius:999px;padding:12px 22px;font:inherit;font-weight:800;font-size:14px;cursor:pointer;
  background:linear-gradient(135deg,#6f9fe0,#4d7cc4);color:#fff;box-shadow:0 4px 14px rgba(77,124,196,.32);
  transition:transform .08s,filter .12s;}
.av-btn:hover{filter:brightness(1.05);}
.av-btn:active{transform:scale(.97);}
.av-btn:disabled{opacity:.5;cursor:default;filter:none;box-shadow:none;}
.av-btn.ghost{background:#fff;color:#6a6086;box-shadow:none;border:1px solid #dbe3f0;}
.av-btn.approve{background:linear-gradient(135deg,#4fbf8a,#2f9e6b);box-shadow:0 4px 14px rgba(47,158,107,.3);}
.av-btn.reject{background:linear-gradient(135deg,#e87a72,#d64545);box-shadow:0 4px 14px rgba(214,69,69,.3);}
.av-btn.fail{background:linear-gradient(135deg,#e87a72,#d64545);box-shadow:0 4px 14px rgba(214,69,69,.3);}
.av-btn.success{background:linear-gradient(135deg,#4fbf8a,#2f9e6b);box-shadow:0 4px 14px rgba(47,158,107,.3);}
.av-actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}

.av-wait{margin:auto;text-align:center;color:#8b81a0;}
.av-wait .big{font-size:15px;font-weight:800;color:#3a3550;margin-bottom:6px;}
.av-wait .ic-lg{width:52px;height:52px;margin:0 auto 12px;}

/* 투표 결과 공개 */
.av-votes{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:8px 0 14px;}
.av-vcell{display:flex;flex-direction:column;align-items:center;gap:4px;width:78px;padding:8px 4px;border-radius:12px;border:1px solid #e6ebf5;background:#fff;}
.av-vcell .who{font-size:11.5px;font-weight:700;color:#3a3550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}
.av-vcell .v{font-size:11px;font-weight:800;padding:1px 8px;border-radius:999px;}
.av-vcell .v.approve{background:#dcf3e8;color:#2f9e6b;}
.av-vcell .v.reject{background:#fde0e0;color:#d64545;}
.av-voteres{font-size:18px;font-weight:900;text-align:center;margin-bottom:10px;}
.av-voteres.approve{color:#2f9e6b;} .av-voteres.reject{color:#d64545;}

/* 결과 오버레이 */
.av-result{position:absolute;inset:0;background:rgba(244,247,255,.95);backdrop-filter:blur(8px);
  display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:14px;padding:26px 20px;overflow-y:auto;z-index:5;}
.av-banner{font-size:26px;font-weight:900;text-align:center;padding:10px 26px;border-radius:18px;margin-top:6px;}
.av-banner.good{background:linear-gradient(135deg,#dcebff,#eef5ff);color:#2f6aa8;border:1px solid #aecbe8;}
.av-banner.evil{background:linear-gradient(135deg,#ffdedb,#fff0ef);color:#c8443b;border:1px solid #f2b3ae;}
.av-outcome{font-size:15px;font-weight:800;}
.av-outcome.win{color:#2f9e44;}
.av-outcome.lose{color:#8b81a0;}
.av-reason{font-size:13px;color:#6a6086;font-weight:700;text-align:center;}
.av-reveal{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;max-width:660px;}
.av-rc{width:104px;border-radius:14px;padding:11px 8px;text-align:center;border:1px solid #e6ebf5;background:#fff;box-shadow:0 2px 8px rgba(90,110,160,.1);}
.av-rc.evil{border-color:#f2b3ae;}
.av-rc.merlin-hit{box-shadow:0 0 0 2px rgba(224,85,77,.4);}
.av-rc .who{font-size:12px;font-weight:800;margin-bottom:6px;color:#3a3550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.av-rc .ic{width:34px;height:34px;margin:0 auto 4px;}
.av-rc .fin{font-size:13px;font-weight:800;color:#3a3550;}
.av-rc .tag{display:inline-block;font-size:9.5px;font-weight:800;padding:1px 6px;border-radius:999px;margin-top:4px;}
.av-rc .tag.evil{background:#ffdad6;color:#c8443b;}
.av-rc .tag.merlin{background:#fff0c4;color:#a5791a;}
.av-rc .tag.target{background:#ffe0dd;color:#c8443b;}
.av-result-track{display:flex;gap:8px;}
.av-reveal-h{font-size:12px;font-weight:800;color:#8b81a0;width:100%;text-align:center;margin-top:4px;}
.av-result-next{margin:14px auto 4px;}

/* 도움말 */
.av-help{position:absolute;inset:0;background:rgba(255,255,255,.98);z-index:6;overflow-y:auto;padding:22px 22px 30px;}
.av-help h3{margin:0 0 4px;font-size:19px;font-weight:900;color:#3a3550;}
.av-help h4{margin:16px 0 8px;font-size:13px;font-weight:800;color:#4d7cc4;letter-spacing:.02em;}
.av-help ol{margin:0;padding-left:20px;color:#3a3550;font-size:13px;line-height:1.7;}
.av-help .win{background:#eef4ff;border:1px solid #dbe3f0;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.6;color:#5a5070;}
.av-help-roles{display:flex;flex-direction:column;gap:8px;}
.av-help-role{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:12px;border:1px solid #e6ebf5;background:#fff;}
.av-help-role .ic{width:38px;height:38px;flex:none;}
.av-help-role .info{flex:1;min-width:0;}
.av-help-role .rn{font-size:14px;font-weight:800;color:#3a3550;}
.av-help-role .rn .cnt{color:#8b81a0;font-size:12px;font-weight:700;margin-left:4px;}
.av-help-role .ra{font-size:11.5px;color:#8b81a0;line-height:1.4;}
.av-help-role .team{font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;flex:none;}
.av-help-role .team.good{background:#d6e8fb;color:#2f6aa8;}
.av-help-role .team.evil{background:#ffdad6;color:#c8443b;}
.av-help-close{margin:20px auto 0;}

@media (prefers-reduced-motion: reduce){
  .av-pchip,.av-btn{transition:none;}
}
`;

export class AvalonRenderer {
  private canvas: HTMLCanvasElement;
  private root: HTMLDivElement;
  private cb: AvCallbacks;

  private phaseEl!: HTMLSpanElement;
  private timerEl!: HTMLSpanElement;
  private trackEl!: HTMLDivElement;
  private playersEl!: HTMLDivElement;
  private mycardEl!: HTMLDivElement;
  private memoEl!: HTMLDivElement;
  private stageEl!: HTMLDivElement;
  private resultEl!: HTMLDivElement;
  private helpEl!: HTMLDivElement;
  private styleEl!: HTMLStyleElement;

  private lastPlayerCount = 0;
  /** 스테이지 마지막 렌더 키 — 바뀔 때만 재빌드 */
  private stageKey = '';
  /** 결과 1회만 그리기 (다음 버튼 안정화) */
  private resultKey = '';
  /** 리더 원정대 선발 로컬 선택 */
  private teamPick: string[] = [];

  constructor(canvas: HTMLCanvasElement, cb: AvCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    canvas.style.display = 'none';

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.styleEl = style;

    const root = document.createElement('div');
    root.className = 'av-root';
    root.innerHTML = `
      <div class="av-top">
        <span class="av-phase" id="av-phase"></span>
        <span class="av-timer" id="av-timer" hidden></span>
        <button class="av-help-btn" id="av-help" title="도움말">?</button>
      </div>
      <div class="av-track" id="av-track"></div>
      <div class="av-grid">
        <div class="av-left">
          <div class="av-players" id="av-players"></div>
          <div class="av-mycard" id="av-mycard" hidden></div>
          <div class="av-memo" id="av-memo" hidden></div>
        </div>
        <div class="av-stage" id="av-stage"></div>
      </div>
      <div class="av-result" id="av-result" hidden></div>
      <div class="av-help" id="av-help-panel" hidden></div>
    `;
    canvas.parentElement?.appendChild(root);
    this.root = root;

    this.phaseEl = root.querySelector('#av-phase')!;
    this.timerEl = root.querySelector('#av-timer')!;
    this.trackEl = root.querySelector('#av-track')!;
    this.playersEl = root.querySelector('#av-players')!;
    this.mycardEl = root.querySelector('#av-mycard')!;
    this.memoEl = root.querySelector('#av-memo')!;
    this.stageEl = root.querySelector('#av-stage')!;
    this.resultEl = root.querySelector('#av-result')!;
    this.helpEl = root.querySelector('#av-help-panel')!;
    root.querySelector<HTMLButtonElement>('#av-help')!.addEventListener('click', () => this.showHelp());
  }

  destroy(): void {
    this.root.remove();
    this.styleEl.remove();
    this.canvas.style.display = '';
  }

  // ============================================
  // 메인 렌더
  // ============================================

  render(rs: AvRenderState): void {
    const s = rs.state;
    this.lastPlayerCount = s.players.length;
    this.renderTop(rs);
    this.renderTrack(rs);
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

  private renderTop(rs: AvRenderState): void {
    const s = rs.state;
    const leaderNick = s.players[s.leaderIdx]?.nickname ?? '?';
    let label = '';
    if (s.phase === 'deal') label = '역할 배정';
    else if (s.phase === 'team') label = `<span class="r">원정대 선발</span> · 리더 ${esc(leaderNick)}`;
    else if (s.phase === 'vote') label = '원정대 찬반 투표';
    else if (s.phase === 'quest') label = `${s.roundIdx + 1}번째 원정 진행 중`;
    else if (s.phase === 'assassin') label = `<span class="e">암살</span> · 멀린을 찾아라`;
    this.phaseEl.innerHTML = label;

    const secs = rs.remainMs > 0 ? Math.ceil(rs.remainMs / 1000) : 0;
    if (secs > 0 && s.phase !== 'deal') {
      this.timerEl.hidden = false;
      this.timerEl.textContent = `${secs}s`;
      this.timerEl.classList.toggle('warn', secs <= 10);
    } else {
      this.timerEl.hidden = true;
    }
  }

  private renderTrack(rs: AvRenderState): void {
    const s = rs.state;
    if (s.phase === 'deal') { this.trackEl.innerHTML = ''; return; }
    const n = s.players.length;
    const quests = Array.from({ length: QUEST_COUNT }, (_, i) => {
      const res = s.questResults[i];
      const size = teamSizeFor(n, i);
      const two = failsRequiredFor(n, i) === 2;
      const now = i === s.roundIdx && (s.phase === 'team' || s.phase === 'vote' || s.phase === 'quest') && res == null;
      const cls = res === 'success' ? 'success' : res === 'fail' ? 'fail' : now ? 'now' : '';
      const inner = res === 'success' ? `<div class="m">${MARK_SUCCESS}</div>`
        : res === 'fail' ? `<div class="m">${MARK_FAIL}</div>`
        : `<div class="n">${size}</div><div class="sz">${two ? '2실패' : ''}</div>`;
      return `<div class="av-q ${cls} ${two ? 'two' : ''}" title="${i + 1}번째 원정 · ${size}명${two ? ' · 2실패 필요' : ''}">${inner}</div>`;
    }).join('');
    // 연속 거부 표시
    const dots = Array.from({ length: MAX_REJECTS }, (_, i) =>
      `<span class="d ${i < s.rejectCount ? 'on' : ''}"></span>`).join('');
    const rejects = (s.phase === 'team' || s.phase === 'vote')
      ? `<div class="av-track-sep"></div><div class="av-rejects">연속 거부 <div class="av-rejdots ${s.rejectCount >= 3 ? 'danger' : ''}">${dots}</div></div>`
      : '';
    this.trackEl.innerHTML = `<div class="av-quests">${quests}</div>${rejects}`;
  }

  private renderPlayers(rs: AvRenderState): void {
    const s = rs.state;
    const onTeam = new Set(s.proposedTeam);
    const showTeam = s.phase === 'vote' || s.phase === 'quest';
    this.playersEl.innerHTML = s.players.map((p, i) => {
      const me = p.peerId === rs.myPeerId;
      const leader = i === s.leaderIdx;
      const team = showTeam && onTeam.has(p.peerId);
      return `<div class="av-prow ${me ? 'me' : ''} ${leader ? 'leader' : ''} ${team ? 'on-team' : ''}">` +
        `<span class="crown">♛</span><span class="dot" hidden></span>` +
        `<span class="nm">${esc(p.nickname)}${me ? ' (나)' : ''}</span></div>`;
    }).join('');
  }

  private renderMyCard(rs: AvRenderState): void {
    if (rs.isSpectator || !rs.myRole) { this.mycardEl.hidden = true; return; }
    const r = rs.myRole;
    const t = teamOf(r);
    this.mycardEl.hidden = false;
    this.mycardEl.className = `av-mycard ${t}`;
    this.mycardEl.innerHTML =
      `<span class="ic">${ROLE_SVG[r]}</span>` +
      `<div><div><span class="nm">${ROLE_META[r].name}</span>` +
      `<span class="tm ${t}">${t === 'evil' ? '악' : '선'}</span></div>` +
      `<div class="ab">${ROLE_META[r].ability}</div></div>`;
  }

  private renderMemo(rs: AvRenderState): void {
    if (rs.isSpectator || !rs.knowledge) { this.memoEl.hidden = true; return; }
    const k = rs.knowledge;
    const nick = (pid: string): string => rs.state.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    const chips = (ids: string[], evil: boolean): string =>
      ids.length ? `<div class="known">${ids.map((p) => `<span class="kchip ${evil ? 'evil' : ''}">${esc(nick(p))}</span>`).join('')}</div>` : '';
    let title = '내가 아는 것';
    let body = '';
    switch (k.kind) {
      case 'none':
        this.memoEl.hidden = true; return; // 신하는 정보 없음 → 메모 숨김
      case 'alone':
        body = '당신은 <b>오베론</b> — 다른 악을 몰라요. 다른 악도 당신을 몰라요.'; break;
      case 'evilTeam':
        body = k.peerIds.length ? '같은 편 <b>악</b>이에요:' + chips(k.peerIds, true)
          : '보이는 다른 악이 없어요 (오베론만 있을 수 있어요).'; break;
      case 'merlinView':
        title = '멀린의 시야';
        body = '악한 자들이에요 (단 <b>모드레드</b>는 숨어 있을 수 있어요):' + chips(k.peerIds, true); break;
      case 'merlinCandidates':
        title = '퍼시발의 시야';
        body = '이 둘 중 하나가 진짜 <b>멀린</b>, 하나는 <b>모르가나</b>:' + chips(k.peerIds, false); break;
    }
    this.memoEl.hidden = false;
    this.memoEl.innerHTML = `<h4>${title}</h4><div class="m">${body}</div>`;
  }

  // ============================================
  // 스테이지 (페이즈별 인터랙티브) — stageKey 바뀔 때만 재빌드
  // ============================================
  private renderStage(rs: AvRenderState): void {
    const key = this.computeStageKey(rs);
    if (key === this.stageKey) return;
    this.stageKey = key;

    if (rs.isSpectator) {
      this.stageEl.innerHTML = `<div class="av-wait"><div class="big">관전 중</div><div>원정대와 투표를 지켜봐요</div></div>`;
      return;
    }
    switch (rs.state.phase) {
      case 'deal': this.buildDeal(rs); break;
      case 'team': this.buildTeam(rs); break;
      case 'vote': this.buildVote(rs); break;
      case 'quest': this.buildQuest(rs); break;
      case 'assassin': this.buildAssassin(rs); break;
    }
  }

  private computeStageKey(rs: AvRenderState): string {
    const s = rs.state;
    const amLeader = s.players[s.leaderIdx]?.peerId === rs.myPeerId;
    switch (s.phase) {
      case 'deal': return `deal:${rs.myRole ?? 'none'}:${rs.confirmedDeal}:${s.readyCount}/${s.players.length}`;
      case 'team': return `team:${s.roundIdx}:${s.leaderIdx}:${amLeader}`;
      case 'vote': return `vote:${s.roundIdx}:${s.leaderIdx}:${rs.votedThisRound}:${s.votes ? 'revealed' : 'voting'}`;
      case 'quest': {
        const onTeam = s.proposedTeam.includes(rs.myPeerId);
        return `quest:${s.roundIdx}:${onTeam}:${rs.submitted}:${s.submitCount}/${s.proposedTeam.length}`;
      }
      case 'assassin': return `assassin:${rs.myRole === 'assassin'}:${rs.assassinDone}`;
      default: return s.phase;
    }
  }

  private stageHead(title: string, sub: string): string {
    return `<div class="av-stage-title">${title}</div><div class="av-stage-sub">${sub}</div>`;
  }

  private waitScreen(role: Role | null, big: string, sub: string): string {
    const icon = role ? `<div class="ic ic-lg">${ROLE_SVG[role]}</div>` : '';
    return `<div class="av-wait">${icon}<div class="big">${big}</div><div>${sub}</div></div>`;
  }

  // ── deal: 내 역할 + 지식 확인 ──
  private buildDeal(rs: AvRenderState): void {
    const s = rs.state;
    if (rs.confirmedDeal) {
      this.stageEl.innerHTML = this.waitScreen(null, '다른 사람들을 기다려요', `${s.readyCount} / ${s.players.length} 명이 역할을 확인했어요`);
      return;
    }
    const r = rs.myRole;
    if (!r) { this.stageEl.innerHTML = this.waitScreen(null, '역할 받는 중…', ''); return; }
    const t = teamOf(r);
    this.stageEl.innerHTML = `<div class="av-center">
      ${this.stageHead('당신의 역할', '이 역할은 비밀! 왼쪽에서 당신이 아는 정보도 확인하세요.')}
      <div class="av-big-card ${t}"><div class="ic">${ROLE_SVG[r]}</div><div class="nm">${ROLE_META[r].name}</div></div>
      <div class="av-stage-sub" style="margin:0 0 16px">${ROLE_META[r].ability}</div>
      <button class="av-btn" id="av-ready">확인했어요 · 시작</button>
    </div>`;
    this.stageEl.querySelector<HTMLButtonElement>('#av-ready')!.addEventListener('click', () => this.cb.onReady());
  }

  // ── team: 리더는 원정대 선발, 나머지는 대기 ──
  private buildTeam(rs: AvRenderState): void {
    const s = rs.state;
    const amLeader = s.players[s.leaderIdx]?.peerId === rs.myPeerId;
    const leaderNick = s.players[s.leaderIdx]?.nickname ?? '?';
    if (!amLeader) {
      this.stageEl.innerHTML = this.waitScreen(null, `리더 ${esc(leaderNick)}가 원정대를 고르는 중…`,
        `${s.teamSize}명을 뽑아요. 골라지면 다 함께 찬반 투표해요.`);
      return;
    }
    this.teamPick = [];
    const chips = s.players.map((p) =>
      `<button class="av-pchip" data-p="${p.peerId}">${esc(p.nickname)}${p.peerId === rs.myPeerId ? ' (나)' : ''}</button>`).join('');
    this.stageEl.innerHTML = `<div class="av-center">
      ${this.stageHead('원정대 선발', `${s.roundIdx + 1}번째 원정 · <b>${s.teamSize}명</b>을 뽑아요${s.failsRequired === 2 ? ' · 이 원정은 실패 2장이어야 실패' : ''}. (자신도 포함 가능)`)}
      <div class="av-pick" id="av-pick">${chips}</div>
      <button class="av-btn" id="av-confirm" disabled>원정대 확정 (0/${s.teamSize})</button>
    </div>`;
    const confirmBtn = this.stageEl.querySelector<HTMLButtonElement>('#av-confirm')!;
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) => {
      b.addEventListener('click', () => {
        const pid = b.dataset.p!;
        const idx = this.teamPick.indexOf(pid);
        if (idx >= 0) { this.teamPick.splice(idx, 1); b.classList.remove('sel'); }
        else {
          if (this.teamPick.length >= s.teamSize) return; // 정원 초과 방지
          this.teamPick.push(pid); b.classList.add('sel');
        }
        const full = this.teamPick.length === s.teamSize;
        confirmBtn.disabled = !full;
        confirmBtn.textContent = `원정대 확정 (${this.teamPick.length}/${s.teamSize})`;
      });
    });
    confirmBtn.addEventListener('click', () => {
      if (this.teamPick.length !== s.teamSize) return;
      confirmBtn.disabled = true;
      this.cb.onPickTeam([...this.teamPick]);
    });
  }

  // ── vote: 찬반 투표 → 집계 공개 ──
  private buildVote(rs: AvRenderState): void {
    const s = rs.state;
    const nick = (pid: string): string => s.players.find((p) => p.peerId === pid)?.nickname ?? '?';
    const teamNames = s.proposedTeam.map(nick).map(esc).join(', ');

    // 집계 공개 상태
    if (s.votes) {
      const res = s.lastVoteResult;
      const cells = s.players.map((p) => {
        const v = s.votes![p.peerId];
        const vt = v === 'approve' ? '찬성' : v === 'reject' ? '반대' : '-';
        return `<div class="av-vcell"><span class="who">${esc(p.nickname)}</span>` +
          `<span class="v ${v ?? ''}">${vt}</span></div>`;
      }).join('');
      this.stageEl.innerHTML = `<div class="av-center">
        ${this.stageHead('투표 결과', `원정대: <b>${teamNames}</b>`)}
        <div class="av-voteres ${res}">${res === 'approve' ? '✔ 원정 승인!' : '✘ 거부됨 — 리더가 넘어가요'}</div>
        <div class="av-votes">${cells}</div>
      </div>`;
      return;
    }

    // 투표 중
    if (rs.votedThisRound) {
      this.stageEl.innerHTML = this.waitScreen(null, '투표 완료!', '다른 사람들을 기다려요');
      return;
    }
    this.stageEl.innerHTML = `<div class="av-center">
      ${this.stageHead('원정대 찬반', `이 원정대를 보낼까요?<br><b>${teamNames}</b>`)}
      <div class="av-actions">
        <button class="av-btn approve" id="av-approve">찬성</button>
        <button class="av-btn reject" id="av-reject">반대</button>
      </div>
    </div>`;
    this.stageEl.querySelector<HTMLButtonElement>('#av-approve')!.addEventListener('click', () => {
      this.lockActions();
      this.cb.onVote('approve');
    });
    this.stageEl.querySelector<HTMLButtonElement>('#av-reject')!.addEventListener('click', () => {
      this.lockActions();
      this.cb.onVote('reject');
    });
  }

  // ── quest: 원정대원 성공/실패 제출, 나머지 대기 ──
  private buildQuest(rs: AvRenderState): void {
    const s = rs.state;
    const onTeam = s.proposedTeam.includes(rs.myPeerId);
    if (!onTeam) {
      this.stageEl.innerHTML = this.waitScreen(null, '원정 진행 중…',
        `원정대가 카드를 내는 중이에요 (${s.submitCount} / ${s.proposedTeam.length})`);
      return;
    }
    if (rs.submitted) {
      this.stageEl.innerHTML = this.waitScreen(null, '카드 제출 완료!',
        `다른 원정대원을 기다려요 (${s.submitCount} / ${s.proposedTeam.length})`);
      return;
    }
    const isGood = rs.myRole ? teamOf(rs.myRole) === 'good' : true;
    const failBtn = isGood
      ? `<button class="av-btn fail" disabled title="선은 실패할 수 없어요">실패 (선 불가)</button>`
      : `<button class="av-btn fail" id="av-qfail">실패</button>`;
    this.stageEl.innerHTML = `<div class="av-center">
      ${this.stageHead('원정 카드 제출', isGood
        ? '당신은 <b>선</b> — 성공만 낼 수 있어요.'
        : '당신은 <b>악</b> — 성공/실패를 골라요. (성공인 척 숨는 것도 전략!)')}
      <div class="av-actions">
        <button class="av-btn success" id="av-qsuccess">성공</button>
        ${failBtn}
      </div>
    </div>`;
    this.stageEl.querySelector<HTMLButtonElement>('#av-qsuccess')!.addEventListener('click', () => {
      this.lockActions();
      this.cb.onQuestCard('success');
    });
    this.stageEl.querySelector<HTMLButtonElement>('#av-qfail')?.addEventListener('click', () => {
      this.lockActions();
      this.cb.onQuestCard('fail');
    });
  }

  // ── assassin: 암살자만 지목, 나머지 대기 ──
  private buildAssassin(rs: AvRenderState): void {
    const s = rs.state;
    const amAssassin = rs.myRole === 'assassin';
    if (!amAssassin) {
      this.stageEl.innerHTML = this.waitScreen('assassin', '선이 원정을 3번 성공했어요!',
        '암살자가 멀린을 찾고 있어요… 맞히면 악의 역전승.');
      return;
    }
    if (rs.assassinDone) {
      this.stageEl.innerHTML = this.waitScreen('assassin', '지목 완료!', '결과를 확인하는 중…');
      return;
    }
    // 자신 제외한 전원 후보 (누가 멀린인지 추리)
    const chips = s.players.filter((p) => p.peerId !== rs.myPeerId).map((p) =>
      `<button class="av-pchip" data-a="${p.peerId}">${esc(p.nickname)}</button>`).join('');
    this.stageEl.innerHTML = `<div class="av-center">
      ${this.stageHead('멀린을 암살하라', '선이 3원정을 성공했어요. 멀린이라 생각하는 사람을 지목하세요. 맞히면 <b>악의 역전승!</b>')}
      <div class="av-pick">${chips}</div>
    </div>`;
    this.stageEl.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) => {
      b.addEventListener('click', () => {
        this.lockActions();
        this.cb.onAssassin(b.dataset.a!);
      });
    });
  }

  /** 스테이지 내 모든 버튼 잠금 (제출 직후 중복 클릭 방지) */
  private lockActions(): void {
    this.stageEl.querySelectorAll<HTMLButtonElement>('button').forEach((x) => { x.disabled = true; });
  }

  // ── 결과 오버레이 ──
  private renderResult(rs: AvRenderState): void {
    const rv = rs.state.reveal;
    if (!rv) return;
    const rkey = `${rv.winningSide}:${rv.reason}:${rv.assassinTarget ?? ''}`;
    if (this.resultKey === rkey && this.resultEl.querySelector('#av-next')) return;
    this.resultKey = rkey;
    const nick = (pid: string): string => rs.state.players.find((p) => p.peerId === pid)?.nickname ?? '?';

    const iWon = !rs.isSpectator && rs.myRole != null && teamOf(rs.myRole) === rv.winningSide;

    const cards = rs.state.players.map((p) => {
      const role = rv.roles[p.peerId]!;
      const t = teamOf(role);
      const isMerlin = role === 'merlin';
      const isTarget = rv.assassinTarget === p.peerId;
      const tags: string[] = [];
      if (isMerlin) tags.push('<span class="tag merlin">멀린</span>');
      if (t === 'evil') tags.push('<span class="tag evil">악</span>');
      if (isTarget) tags.push('<span class="tag target">암살 지목</span>');
      return `<div class="av-rc ${t} ${isMerlin && isTarget ? 'merlin-hit' : ''}">` +
        `<div class="who">${esc(nick(p.peerId))}</div>` +
        `<div class="ic">${ROLE_SVG[role]}</div>` +
        `<div class="fin">${ROLE_META[role].name}</div>` +
        (tags.length ? `<div>${tags.join(' ')}</div>` : '') +
        `</div>`;
    }).join('');

    const track = Array.from({ length: QUEST_COUNT }, (_, i) => {
      const res = rv.questResults[i];
      const cls = res === 'success' ? 'success' : res === 'fail' ? 'fail' : '';
      const inner = res === 'success' ? `<div class="m">${MARK_SUCCESS}</div>`
        : res === 'fail' ? `<div class="m">${MARK_FAIL}</div>`
        : `<div class="n">${i + 1}</div>`;
      return `<div class="av-q ${cls}">${inner}</div>`;
    }).join('');

    const { success, fail } = countQuests(rv.questResults);
    const banner = rv.winningSide === 'good' ? '🛡️ 선(아서 진영) 승리' : '⚔️ 악(모드레드 진영) 승리';
    const reasonTxt =
      rv.reason === 'reject5' ? '원정대 구성이 5번 연속 거부되어 악이 승리했어요.'
      : rv.reason === 'assassin'
        ? (rv.winningSide === 'evil'
            ? `암살자가 멀린(${esc(nick(rv.merlinPeer ?? ''))})을 정확히 지목 — 악의 역전승!`
            : `암살자가 멀린을 못 맞혔어요 (지목: ${esc(nick(rv.assassinTarget ?? ''))}) — 선의 승리!`)
      : rv.winningSide === 'good'
        ? `원정 ${success}번 성공 — 선이 승리했어요.`
        : `원정 ${fail}번 실패 — 악이 승리했어요.`;

    this.resultEl.innerHTML =
      `<div class="av-banner ${rv.winningSide}">${banner}</div>` +
      (rs.isSpectator ? '' : `<div class="av-outcome ${iWon ? 'win' : 'lose'}">${iWon ? '당신의 승리!' : '아쉽게 패배…'}</div>`) +
      `<div class="av-reason">${reasonTxt}</div>` +
      `<div class="av-reveal-h">원정 결과</div><div class="av-result-track av-quests">${track}</div>` +
      `<div class="av-reveal-h">모두의 정체</div><div class="av-reveal">${cards}</div>` +
      `<button class="av-btn av-result-next" id="av-next">다음 →</button>`;
    this.resultEl.querySelector<HTMLButtonElement>('#av-next')?.addEventListener('click', () => this.cb.onResultNext());
  }

  // ── 도움말 ──
  private showHelp(): void {
    const n = this.lastPlayerCount || 5;
    const setup = setupFor(n);
    const counts = new Map<Role, number>();
    for (const r of setup) counts.set(r, (counts.get(r) ?? 0) + 1);
    const rolesHtml = (Object.keys(ROLE_META) as Role[])
      .filter((r) => counts.has(r))
      .map((r) => {
        const t = teamOf(r);
        const c = counts.get(r)!;
        return `<div class="av-help-role"><div class="ic">${ROLE_SVG[r]}</div>` +
          `<div class="info"><div class="rn">${ROLE_META[r].name}${c > 1 ? `<span class="cnt">×${c}</span>` : ''}</div>` +
          `<div class="ra">${ROLE_META[r].ability}</div></div>` +
          `<span class="team ${t}">${t === 'evil' ? '악' : '선'}</span></div>`;
      }).join('');
    const sizes = Array.from({ length: QUEST_COUNT }, (_, i) =>
      `${teamSizeFor(n, i)}${failsRequiredFor(n, i) === 2 ? '*' : ''}`).join(' · ');
    this.helpEl.innerHTML = `<h3>⚔️ 아발론 게임 방법</h3>
      <h4>목표</h4>
      <div class="win"><b>선</b>: 원정 <b>${WINS_NEEDED}번 성공</b> + 마지막에 멀린이 암살당하지 않으면 승리.<br>
      <b>악</b>: 원정 <b>${WINS_NEEDED}번 실패</b>, 또는 원정대 구성 <b>${MAX_REJECTS}연속 거부</b>, 또는 <b>멀린 암살 성공</b> 시 승리.</div>
      <h4>진행 순서</h4>
      <ol><li>역할 배정 — 각자 자기 역할과 아는 정보를 확인해요.</li>
      <li>원정대 선발 — 리더가 원정 인원을 뽑아요.</li>
      <li>찬반 투표 — 전원이 공개로 찬성/반대. 과반 찬성이면 원정 진행, 아니면 리더가 시계방향으로 넘어가요.</li>
      <li>원정 — 원정대원이 성공/실패 카드를 비밀로 내요. 선은 성공만, 악은 선택. 실패 1장(일부 4번째 원정은 2장)이면 원정 실패.</li>
      <li>선이 3원정 성공하면 암살자가 멀린을 지목해요.</li></ol>
      <h4>이 게임의 역할 · ${n}인</h4>
      <div class="av-help-roles">${rolesHtml}</div>
      <h4>원정 인원 (라운드 1~5)</h4>
      <div class="win">${sizes}　(* = 실패 2장이어야 실패)</div>
      <button class="av-btn ghost av-help-close" id="av-help-close">닫기</button>`;
    this.helpEl.querySelector<HTMLButtonElement>('#av-help-close')!
      .addEventListener('click', () => { this.helpEl.hidden = true; });
    this.helpEl.hidden = false;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
