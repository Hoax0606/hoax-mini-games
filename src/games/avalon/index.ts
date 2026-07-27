/**
 * 아발론 GameModule — 조립 (호스트 authoritative).
 *
 * 호스트가 역할 배분 / 원정대 투표 집계 / 원정 결과 판정 / 암살 판정을 단독 관리.
 * 비밀(내 역할·밤 지식)은 sync 에 안 담고 각 peer 에게만 targeted 로 전송.
 *
 * 흐름: 역할배정(deal) → [원정대선발(team) → 찬반투표(vote) → 원정(quest)] ×최대5 → (암살) → 결과(result).
 *  - 투표 승인 → 원정 진행. 거부 → 리더 시계방향, 5연속 거부 시 악 승리.
 *  - 원정 3성공 → 암살 페이즈(암살자가 멀린 지목). 3실패 → 즉시 악 승리.
 */

import type { GameModule, GameContext, GameMessage, GameResult, Player } from '../types';
import { sound } from '../../core/sound';
import {
  setupFor, teamSizeFor, failsRequiredFor, dealRoles, computeKnowledge,
  tallyVote, resolveQuest, countQuests, teamOf, ROLE_META,
  MIN_PLAYERS, QUEST_COUNT, WINS_NEEDED, MAX_REJECTS,
  type Role, type Knowledge, type Vote, type QuestCard, type PublicState,
  type ChatLine, type RevealData, type Team, type EndReason,
} from './rules';
import {
  encodeHello, decodeHello, encodeSync, decodeSync,
  encodeRole, decodeRole, encodeInfo, decodeInfo,
  encodeReady, decodeReady, encodePickTeam, decodePickTeam,
  encodeVote, decodeVote, encodeQuestCard, decodeQuestCard,
  encodeAssassin, decodeAssassin, encodeChat, decodeChat,
  encodeEnd, decodeEnd,
} from './netSync';
import { AvalonRenderer, type AvRenderState } from './render';

const DUMMY_PREFIX = '__av_dummy_';
const DEAL_TIMEOUT_MS = 60_000;
const VOTE_MS = 45_000;
const VOTE_REVEAL_MS = 5_000;
const QUEST_MS = 45_000;
const ASSASSIN_MS = 60_000;
const DUMMY_DELAY_MS = 1_000;

const DUMMY_CHATS = ['난 선이야 믿어줘', '음 이 원정대 괜찮은데?', '리더 믿고 가자', '뭔가 수상한데…'];

class AvalonModule implements GameModule {
  private ctx!: GameContext;
  private renderer!: AvalonRenderer;
  private myPeerId = '';
  private isHost = false;
  private isSpectator = false;

  // 공개 상태 (전원 공유)
  private state!: PublicState;

  // 내 로컬 상태 (모든 클라)
  private myRole: Role | null = null;
  private knowledge: Knowledge | null = null;
  private confirmedDeal = false;
  /** 내가 마지막으로 투표한 제안 키(`round:leader`). 현재 제안과 같으면 "투표 완료" */
  private myVoteKey = '';
  /** 내가 마지막으로 원정 카드를 낸 라운드. 현재 라운드와 같으면 "제출 완료" */
  private myQuestRound = -1;
  private assassinDone = false;
  private lastHelloAt = 0;

  // ── 호스트 전용 비밀 상태 ──
  private roles: Record<string, Role> = {};
  private knowledgeMap: Record<string, Knowledge> = {};
  private readySet = new Set<string>();
  private hostVotes: Record<string, Vote> = {};
  private questCards: Record<string, QuestCard> = {};
  private hostAssassinTarget: string | null = null;
  private phaseDeadline = 0;
  private teamMs = 90_000;

  // 표시 타이머 (각 클라 로컬 카운트다운)
  private displayDeadline = 0;
  private lastPhaseKey = '';
  private rafId: number | null = null;
  private dummyTimer: number | null = null;
  private destroyed = false;
  private ended = false;
  private pendingResult: GameResult | null = null;
  private paused = false;
  private pauseStart = 0;

  // ============================================
  // 시작
  // ============================================
  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.myPeerId = ctx.myPlayerId;
    this.isHost = ctx.role === 'host';
    this.isSpectator = ctx.isSpectator === true;
    this.teamMs = Math.max(30, Number(ctx.roomOptions['discuss'] ?? '90')) * 1000;

    this.renderer = new AvalonRenderer(ctx.canvas, {
      onReady: () => this.doReady(),
      onPickTeam: (t) => this.doPickTeam(t),
      onVote: (v) => this.doVote(v),
      onQuestCard: (c) => this.doQuestCard(c),
      onAssassin: (t) => this.doAssassin(t),
      onChat: (t) => this.doChat(t),
      onResultNext: () => this.doResultNext(),
    });
    sound.startBgm('apple-game');

    if (this.isHost) {
      const realPlayers = orderPlayersHostFirst(ctx.players.filter((p) => p.role === 'player'))
        .map((p) => ({ peerId: p.peerId, nickname: p.nickname }));
      const players = [...realPlayers];
      // 솔로 프리뷰 — 최소 인원까지 봇으로 채움 (자동 진행)
      let d = 1;
      while (players.length < MIN_PLAYERS) {
        players.push({ peerId: `${DUMMY_PREFIX}${d}__`, nickname: `봇 ${String.fromCharCode(64 + d)}` });
        d += 1;
      }
      this.startDealAsHost(players);
    } else {
      this.state = emptyState();
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
      this.lastHelloAt = performance.now();
    }
    this.rafId = requestAnimationFrame(this.loop);
  }

  // ============================================
  // 메시지 수신
  // ============================================
  onPeerMessage(msg: GameMessage): void {
    if (this.destroyed) return;

    const hello = decodeHello(msg);
    if (hello) { if (this.isHost) this.sendStateTo(hello.peerId); return; }

    const sync = decodeSync(msg);
    if (sync) { if (!this.isHost) { this.state = sync; this.render(); } return; }

    const role = decodeRole(msg);
    if (role) { if (!this.isHost) { this.myRole = role.role; this.render(); } return; }

    const info = decodeInfo(msg);
    if (info) { if (!this.isHost) { this.knowledge = info.info; this.render(); } return; }

    const end = decodeEnd(msg);
    if (end) { if (!this.isHost) { this.pendingResult = end; this.render(); } return; }

    // 호스트만 처리하는 클라 요청
    if (this.isHost) {
      const ready = decodeReady(msg);
      if (ready) { this.handleReady(ready.from); return; }
      const pick = decodePickTeam(msg);
      if (pick) { this.handlePickTeam(pick.from, pick.team); return; }
      const vote = decodeVote(msg);
      if (vote) { this.handleVote(vote.from, vote.vote); return; }
      const quest = decodeQuestCard(msg);
      if (quest) { this.handleQuestCard(quest.from, quest.card); return; }
      const assassin = decodeAssassin(msg);
      if (assassin) { this.handleAssassin(assassin.from, assassin.target); return; }
      const chat = decodeChat(msg);
      if (chat) { this.relayChat(chat.from, chat.nickname, chat.text); return; }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.ended = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.dummyTimer !== null) window.clearTimeout(this.dummyTimer);
    this.renderer?.destroy();
    sound.stopBgm();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.pauseStart = performance.now();
    else if (this.pauseStart > 0) {
      const delta = performance.now() - this.pauseStart;
      this.phaseDeadline += delta;
      if (this.displayDeadline > 0) this.displayDeadline += delta;
      this.pauseStart = 0;
    }
  }

  onPeerLeft(peerId: string): void {
    if (!this.isHost || this.destroyed || this.ended) return;
    // 이탈자는 좌석에 남겨두되, 진행이 그 사람을 기다리면 스킵/backstop.
    switch (this.state.phase) {
      case 'deal':
        this.readySet.add(peerId); this.maybeStartRound(); break;
      case 'team':
        // 리더가 나갔으면 다음 리더로 넘기고 다시 선발
        if (this.state.players[this.state.leaderIdx]?.peerId === peerId) {
          this.advanceLeader(); this.beginTeamPhase();
        }
        break;
      case 'vote':
        if (!this.state.votes) { this.hostVotes[peerId] = 'reject'; this.maybeResolveVote(); }
        break;
      case 'quest':
        if (this.state.proposedTeam.includes(peerId) && !(peerId in this.questCards)) {
          this.questCards[peerId] = 'success'; // backstop (선 기본)
          this.state.submitCount = Object.keys(this.questCards).length;
          this.sync(); this.maybeResolveQuest();
        }
        break;
      case 'assassin':
        if (this.roles[peerId] === 'assassin') this.resolveAssassin(); break;
    }
  }

  // ============================================
  // 루프 (표시 타이머 + 호스트 데드라인)
  // ============================================
  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.destroyed) return;
    const now = performance.now();

    if (this.isHost && !this.paused && !this.ended && this.phaseDeadline > 0 && now > this.phaseDeadline) {
      this.phaseDeadline = 0;
      this.onPhaseTimeout();
    }

    // 게스트: 역할 못 받았으면 hello 재전송 (합류/전환 유실 복구)
    if (!this.isHost && !this.isSpectator && this.myRole === null && now - this.lastHelloAt > 2000) {
      this.lastHelloAt = now;
      this.ctx.sendToPeer(encodeHello(this.myPeerId));
    }

    // 표시 타이머 — 페이즈 전환 시 로컬 카운트다운 재설정 (deal / 투표 집계공개 중엔 숨김)
    if (this.state) {
      const s = this.state;
      const revealed = s.phase === 'vote' && s.votes != null;
      const phaseKey = `${s.phase}:${s.roundIdx}:${s.leaderIdx}:${revealed}`;
      if (phaseKey !== this.lastPhaseKey) {
        this.lastPhaseKey = phaseKey;
        const dur = revealed ? 0
          : s.phase === 'team' ? this.teamMs
          : s.phase === 'vote' ? VOTE_MS
          : s.phase === 'quest' ? QUEST_MS
          : s.phase === 'assassin' ? ASSASSIN_MS : 0;
        this.displayDeadline = dur > 0 ? now + dur : 0;
      }
      const renderNow = this.paused && this.pauseStart > 0 ? this.pauseStart : now;
      const remainMs = this.displayDeadline > 0 ? Math.max(0, this.displayDeadline - renderNow) : 0;
      this.render(remainMs);
    }
  };

  private onPhaseTimeout(): void {
    switch (this.state.phase) {
      case 'deal': this.startRound(0); break;
      case 'team': this.autoPickTeam(); break;
      case 'vote': if (this.state.votes) this.applyVoteResult(); else this.resolveVote(); break;
      case 'quest': this.resolveQuest(); break;
      case 'assassin': this.resolveAssassin(); break;
    }
  }

  // ============================================
  // 렌더
  // ============================================
  private render(remainMs = 0): void {
    if (!this.state) return;
    const attemptKey = `${this.state.roundIdx}:${this.state.leaderIdx}`;
    const rs: AvRenderState = {
      state: this.state,
      myPeerId: this.myPeerId,
      isHost: this.isHost,
      isSpectator: this.isSpectator,
      myRole: this.myRole,
      knowledge: this.knowledge,
      remainMs,
      confirmedDeal: this.confirmedDeal,
      votedThisRound: this.myVoteKey === attemptKey,
      submitted: this.myQuestRound === this.state.roundIdx,
      assassinDone: this.assassinDone,
    };
    try { this.renderer.render(rs); } catch (err) { console.error('[avalon] render 실패', err); }
  }

  private sync(): void {
    if (this.isHost) this.ctx.sendToPeer(encodeSync(this.state));
  }

  // ============================================
  // 클라 → (호스트) 입력
  // ============================================
  private doReady(): void {
    if (this.confirmedDeal) return;
    this.confirmedDeal = true;
    if (this.isHost) this.handleReady(this.myPeerId);
    else this.ctx.sendToPeer(encodeReady(this.myPeerId));
    this.render();
  }

  private doPickTeam(team: string[]): void {
    if (this.isHost) this.handlePickTeam(this.myPeerId, team);
    else this.ctx.sendToPeer(encodePickTeam(this.myPeerId, team));
  }

  private doVote(vote: Vote): void {
    const attemptKey = `${this.state.roundIdx}:${this.state.leaderIdx}`;
    if (this.myVoteKey === attemptKey) return;
    this.myVoteKey = attemptKey;
    if (this.isHost) this.handleVote(this.myPeerId, vote);
    else this.ctx.sendToPeer(encodeVote(this.myPeerId, vote));
    this.render();
  }

  private doQuestCard(card: QuestCard): void {
    if (this.myQuestRound === this.state.roundIdx) return;
    this.myQuestRound = this.state.roundIdx;
    if (this.isHost) this.handleQuestCard(this.myPeerId, card);
    else this.ctx.sendToPeer(encodeQuestCard(this.myPeerId, card));
    this.render();
  }

  private doAssassin(target: string): void {
    if (this.assassinDone) return;
    this.assassinDone = true;
    if (this.isHost) this.handleAssassin(this.myPeerId, target);
    else this.ctx.sendToPeer(encodeAssassin(this.myPeerId, target));
    this.render();
  }

  private doChat(text: string): void {
    const nick = this.myNick();
    if (this.isHost) this.relayChat(this.myPeerId, nick, text);
    else this.ctx.sendToPeer(encodeChat(this.myPeerId, nick, text));
  }

  private doResultNext(): void {
    if (this.pendingResult && !this.destroyed) this.ctx.endGame(this.pendingResult);
  }

  // ============================================
  // 호스트: deal 페이즈
  // ============================================
  private startDealAsHost(players: { peerId: string; nickname: string }[]): void {
    const seats = players.map((p) => p.peerId);
    const deck = setupFor(players.length);
    this.roles = dealRoles(seats, deck, () => Math.random());
    this.knowledgeMap = computeKnowledge(this.roles, () => Math.random());
    const n = players.length;
    const firstLeader = Math.floor(Math.random() * n);

    this.state = {
      phase: 'deal', players,
      leaderIdx: firstLeader,
      roundIdx: 0,
      teamSize: teamSizeFor(n, 0),
      failsRequired: failsRequiredFor(n, 0),
      rejectCount: 0,
      proposedTeam: [],
      votes: null,
      lastVoteResult: null,
      questResults: Array(QUEST_COUNT).fill(null),
      questFailCounts: Array(QUEST_COUNT).fill(null),
      readyCount: 0,
      submitCount: 0,
      chatLog: [],
      reveal: null,
    };

    // 각자에게 역할 + 밤 지식 전송 (호스트 자신 포함, 더미는 스킵)
    for (const p of players) {
      if (p.peerId === this.myPeerId) {
        this.myRole = this.roles[p.peerId]!;
        this.knowledge = this.knowledgeMap[p.peerId]!;
      } else if (!isDummy(p.peerId)) {
        this.ctx.sendToPeer(encodeRole(this.roles[p.peerId]!), { target: p.peerId });
        this.ctx.sendToPeer(encodeInfo(this.knowledgeMap[p.peerId]!), { target: p.peerId });
      }
      if (isDummy(p.peerId)) this.readySet.add(p.peerId);
    }
    this.state.readyCount = this.readySet.size;
    this.phaseDeadline = performance.now() + DEAL_TIMEOUT_MS;
    this.sync();
    this.render();
    sound.play('pop');
    this.maybeStartRound();
  }

  private handleReady(from: string): void {
    if (this.state.phase !== 'deal') return;
    this.readySet.add(from);
    this.state.readyCount = this.readySet.size;
    this.sync();
    this.maybeStartRound();
  }

  private maybeStartRound(): void {
    if (this.state.phase !== 'deal') return;
    if (this.state.players.every((p) => this.readySet.has(p.peerId))) this.startRound(0);
  }

  // ============================================
  // 호스트: 라운드 (team → vote → quest)
  // ============================================
  private startRound(roundIdx: number): void {
    const n = this.state.players.length;
    this.state.roundIdx = roundIdx;
    this.state.teamSize = teamSizeFor(n, roundIdx);
    this.state.failsRequired = failsRequiredFor(n, roundIdx);
    this.state.rejectCount = 0;
    this.beginTeamPhase();
  }

  private beginTeamPhase(): void {
    this.state.phase = 'team';
    this.state.proposedTeam = [];
    this.state.votes = null;
    this.state.lastVoteResult = null;
    this.phaseDeadline = performance.now() + this.teamMs;
    this.sync();
    this.render();
    this.scheduleDummies();
  }

  private handlePickTeam(from: string, team: string[]): void {
    if (this.state.phase !== 'team') return;
    if (this.state.players[this.state.leaderIdx]?.peerId !== from) return; // 리더만
    // 유효성: 인원 수 일치 · 중복 없음 · 전부 실제 플레이어
    const uniq = [...new Set(team)];
    if (uniq.length !== this.state.teamSize) return;
    if (!uniq.every((pid) => this.state.players.some((p) => p.peerId === pid))) return;
    this.state.proposedTeam = uniq;
    this.startVotePhase();
  }

  /** 리더가 시간 안에 안 뽑으면 앞에서부터 teamSize 명 자동 선발 */
  private autoPickTeam(): void {
    if (this.state.phase !== 'team') return;
    this.state.proposedTeam = this.state.players.slice(0, this.state.teamSize).map((p) => p.peerId);
    this.startVotePhase();
  }

  private startVotePhase(): void {
    this.state.phase = 'vote';
    this.state.votes = null;
    this.hostVotes = {};
    this.phaseDeadline = performance.now() + VOTE_MS;
    this.sync();
    this.render();
    this.scheduleDummies();
  }

  private handleVote(from: string, vote: Vote): void {
    if (this.state.phase !== 'vote' || this.state.votes) return; // 집계 공개 후엔 무시
    if (!this.state.players.some((p) => p.peerId === from)) return;
    if (from in this.hostVotes) return;
    this.hostVotes[from] = vote;
    this.maybeResolveVote();
  }

  private maybeResolveVote(): void {
    if (this.state.phase !== 'vote' || this.state.votes) return;
    if (this.state.players.every((p) => p.peerId in this.hostVotes)) this.resolveVote();
  }

  /** 투표 집계 → 결과를 공개하고 잠깐(VOTE_REVEAL_MS) 보여준 뒤 applyVoteResult */
  private resolveVote(): void {
    if (this.state.phase !== 'vote' || this.ended) return;
    // 미투표자는 반대로 처리 (backstop)
    for (const p of this.state.players) if (!(p.peerId in this.hostVotes)) this.hostVotes[p.peerId] = 'reject';
    const result = tallyVote(this.hostVotes);
    this.state.votes = { ...this.hostVotes };
    this.state.lastVoteResult = result;
    this.phaseDeadline = performance.now() + VOTE_REVEAL_MS;
    this.sync();
    this.render();
    sound.play(result === 'approve' ? 'pop' : 'button_click');
  }

  /** 집계 공개가 끝난 뒤 실제 진행 */
  private applyVoteResult(): void {
    if (this.state.phase !== 'vote') return;
    const approved = this.state.lastVoteResult === 'approve';
    this.state.votes = null;
    if (approved) {
      this.state.rejectCount = 0;
      this.startQuestPhase();
    } else {
      this.state.rejectCount += 1;
      if (this.state.rejectCount >= MAX_REJECTS) {
        this.finishEvil('reject5');
        return;
      }
      this.advanceLeader();
      this.beginTeamPhase();
    }
  }

  private advanceLeader(): void {
    this.state.leaderIdx = (this.state.leaderIdx + 1) % this.state.players.length;
  }

  // ============================================
  // 호스트: 원정 (quest)
  // ============================================
  private startQuestPhase(): void {
    this.state.phase = 'quest';
    this.questCards = {};
    this.state.submitCount = 0;
    this.phaseDeadline = performance.now() + QUEST_MS;
    this.sync();
    this.render();
    this.scheduleDummies();
  }

  private handleQuestCard(from: string, card: QuestCard): void {
    if (this.state.phase !== 'quest') return;
    if (!this.state.proposedTeam.includes(from)) return;
    if (from in this.questCards) return;
    // 선은 실패 불가 — 무조건 성공으로 교정
    const safe: QuestCard = teamOf(this.roles[from]!) === 'good' ? 'success' : card;
    this.questCards[from] = safe;
    this.state.submitCount = Object.keys(this.questCards).length;
    this.sync();
    this.render();
    this.maybeResolveQuest();
  }

  private maybeResolveQuest(): void {
    if (this.state.phase !== 'quest') return;
    if (this.state.proposedTeam.every((pid) => pid in this.questCards)) this.resolveQuest();
  }

  private resolveQuest(): void {
    if (this.state.phase !== 'quest' || this.ended) return;
    // 미제출자는 성공으로 처리 (backstop)
    for (const pid of this.state.proposedTeam) if (!(pid in this.questCards)) this.questCards[pid] = 'success';
    const cards = this.state.proposedTeam.map((pid) => this.questCards[pid]!);
    const { result, fails } = resolveQuest(cards, this.state.failsRequired);
    const ri = this.state.roundIdx;
    this.state.questResults[ri] = result;
    this.state.questFailCounts[ri] = fails;
    this.sync();
    this.render();
    sound.play(result === 'success' ? 'goal' : 'button_click');

    const { success, fail } = countQuests(this.state.questResults);
    if (fail >= WINS_NEEDED) { this.finishEvil('quests'); return; }
    if (success >= WINS_NEEDED) { this.startAssassinPhase(); return; }
    // 다음 라운드
    this.advanceLeader();
    this.startRound(ri + 1);
  }

  // ============================================
  // 호스트: 암살 · 종료
  // ============================================
  private startAssassinPhase(): void {
    this.state.phase = 'assassin';
    this.hostAssassinTarget = null;
    this.phaseDeadline = performance.now() + ASSASSIN_MS;
    this.sync();
    this.render();
    this.scheduleDummies();
  }

  private handleAssassin(from: string, target: string): void {
    if (this.state.phase !== 'assassin' || this.ended) return;
    if (this.roles[from] !== 'assassin') return;
    if (!this.state.players.some((p) => p.peerId === target)) return;
    this.hostAssassinTarget = target;
    this.resolveAssassin();
  }

  private resolveAssassin(): void {
    if (this.state.phase !== 'assassin' || this.ended) return;
    const merlinPeer = this.findRole('merlin');
    const target = this.hostAssassinTarget;
    const hit = target != null && this.roles[target] === 'merlin';
    const side: Team = hit ? 'evil' : 'good';
    this.finish(this.buildReveal(side, 'assassin', target, merlinPeer));
  }

  /** 악 승리로 종료 (3원정 실패 / 5연속 거부) */
  private finishEvil(reason: EndReason): void {
    this.finish(this.buildReveal('evil', reason, null, this.findRole('merlin')));
  }

  private buildReveal(side: Team, reason: EndReason, assassinTarget: string | null, merlinPeer: string | null): RevealData {
    return {
      roles: { ...this.roles },
      questResults: [...this.state.questResults],
      winningSide: side,
      reason,
      assassinTarget,
      merlinPeer,
    };
  }

  private finish(reveal: RevealData): void {
    if (this.ended) return;
    this.ended = true;
    this.state.phase = 'result';
    this.state.reveal = reveal;
    this.phaseDeadline = 0;
    this.sync();
    this.render();
    sound.play(reveal.winningSide === 'good' ? 'goal' : 'button_click');
    // 각 peer 에게 자기 결과 전송 (자동 이동 대신 각자 "다음" 버튼)
    for (const p of this.ctx.players) {
      if (p.peerId === this.myPeerId || isDummy(p.peerId)) continue;
      this.ctx.sendToPeer(encodeEnd(this.resultFor(reveal, p.peerId, p.role === 'spectator')), { target: p.peerId });
    }
    this.pendingResult = this.resultFor(reveal, this.myPeerId, this.isSpectator);
    this.render();
  }

  private resultFor(reveal: RevealData, peerId: string, spectator: boolean): GameResult {
    const role = reveal.roles[peerId] ?? null;
    const side = role ? teamOf(role) : null;
    const iWon = !spectator && side === reveal.winningSide;
    return {
      winner: spectator ? null : (iWon ? 'me' : 'opponent'),
      summary: {
        gameId: 'avalon',
        myPeerId: peerId,
        winningSide: reveal.winningSide,
        iWon,
        myRole: role,
        myRoleName: role ? ROLE_META[role].name : null,
        reason: reveal.reason,
        questResults: reveal.questResults,
        players: this.state.players.map((p) => {
          const r = reveal.roles[p.peerId] ?? null;
          return {
            peerId: p.peerId,
            nickname: p.nickname,
            role: r,
            roleName: r ? ROLE_META[r].name : null,
            side: r ? teamOf(r) : null,
          };
        }),
      },
    };
  }

  // ============================================
  // 채팅
  // ============================================
  private relayChat(from: string, nickname: string, text: string): void {
    const clean = text.trim().slice(0, 500);
    if (!clean) return;
    const line: ChatLine = { peerId: from, nickname, text: clean };
    this.state.chatLog.push(line);
    if (this.state.chatLog.length > 60) this.state.chatLog.shift();
    this.sync();
    this.render();
  }

  // ============================================
  // 더미 AI (솔로 프리뷰)
  // ============================================
  private scheduleDummies(): void {
    if (!this.isHost || this.ended) return;
    if (!this.state.players.some((p) => isDummy(p.peerId))) return;
    if (this.dummyTimer !== null) return;
    this.dummyTimer = window.setTimeout(() => {
      this.dummyTimer = null;
      if (this.destroyed || this.ended) return;
      this.driveDummies();
    }, DUMMY_DELAY_MS);
  }

  private driveDummies(): void {
    const dummies = this.state.players.filter((p) => isDummy(p.peerId)).map((p) => p.peerId);
    const s = this.state;
    if (s.phase === 'team') {
      // 리더가 봇이면 자동 선발 (봇 자신 + 무작위)
      const leader = s.players[s.leaderIdx]?.peerId;
      if (leader && isDummy(leader)) {
        const pool = s.players.map((p) => p.peerId).filter((x) => x !== leader);
        const team = [leader, ...shufflePick(pool, s.teamSize - 1)];
        this.handlePickTeam(leader, team);
      }
    } else if (s.phase === 'vote' && !s.votes) {
      for (const d of dummies) if (!(d in this.hostVotes)) this.handleVote(d, 'approve'); // 봇은 찬성 (진행 위주)
    } else if (s.phase === 'quest') {
      for (const d of dummies) {
        if (!s.proposedTeam.includes(d) || d in this.questCards) continue;
        this.handleQuestCard(d, 'success');
      }
    } else if (s.phase === 'assassin') {
      const assassin = this.findRole('assassin');
      if (assassin && isDummy(assassin)) {
        const others = s.players.map((p) => p.peerId).filter((x) => x !== assassin);
        this.handleAssassin(assassin, pick(others));
      }
    }
    // 가끔 한 마디 (분위기)
    if ((s.phase === 'team' || s.phase === 'vote') && dummies[0] && s.chatLog.length < 3) {
      const nm = s.players.find((p) => p.peerId === dummies[0])!.nickname;
      this.relayChat(dummies[0]!, nm, pick(DUMMY_CHATS));
    }
  }

  // ============================================
  // 헬퍼
  // ============================================
  private sendStateTo(peerId: string): void {
    this.ctx.sendToPeer(encodeSync(this.state), { target: peerId });
    if (this.roles[peerId]) this.ctx.sendToPeer(encodeRole(this.roles[peerId]!), { target: peerId });
    if (this.knowledgeMap[peerId]) this.ctx.sendToPeer(encodeInfo(this.knowledgeMap[peerId]!), { target: peerId });
  }

  private findRole(role: Role): string | null {
    return Object.keys(this.roles).find((pid) => this.roles[pid] === role) ?? null;
  }

  private myNick(): string {
    return this.ctx.players.find((p) => p.peerId === this.myPeerId)?.nickname ?? this.ctx.myNickname ?? '나';
  }
}

// ============================================
// 모듈 밖 헬퍼
// ============================================
function orderPlayersHostFirst(players: Player[]): Player[] {
  const host = players.find((p) => p.isHost);
  const guests = players.filter((p) => !p.isHost).sort((a, b) => a.peerId.localeCompare(b.peerId));
  return host ? [host, ...guests] : players.slice();
}

function emptyState(): PublicState {
  return {
    phase: 'deal', players: [], leaderIdx: 0, roundIdx: 0, teamSize: 0, failsRequired: 1,
    rejectCount: 0, proposedTeam: [], votes: null, lastVoteResult: null,
    questResults: Array(QUEST_COUNT).fill(null), questFailCounts: Array(QUEST_COUNT).fill(null),
    readyCount: 0, submitCount: 0, chatLog: [], reveal: null,
  };
}

function isDummy(peerId: string): boolean {
  return peerId.startsWith(DUMMY_PREFIX);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function shufflePick<T>(arr: T[], n: number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, Math.max(0, n));
}

export function createAvalonGame(): GameModule {
  return new AvalonModule();
}
