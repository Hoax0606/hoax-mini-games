/**
 * 게임 모듈 & 네트워크 메시지 타입 정의
 *
 * 이 파일은 "계약(contract)"이다. 각 게임(에어하키 등)은 GameModule을 구현하고,
 * 플랫폼(로비/대기실/라우터)은 NetworkMessage 프로토콜로 Peer끼리 통신한다.
 *
 * TS 문법 메모:
 * - `export interface`: 구조 정의. 런타임에 존재하지 않고 타입 체크에만 쓰임.
 * - `|` 유니언 타입: 여러 타입 중 하나. `type`에 리터럴 문자열을 쓰면 discriminated union이 되어
 *   switch문에서 자동으로 타입이 좁혀짐 (아래 NetworkMessage 참고).
 */

// ============================================
// 1. 게임 메타데이터 — 선택 화면 & 방 옵션
// ============================================

/**
 * 게임 선택 화면에 카드로 뿌려지는 정보 + 방 옵션 스키마.
 * 새 게임 추가 시 이 구조만 채우면 레지스트리에 등록 가능.
 */
export interface GameMeta {
  /** 유일 식별자 (URL 안전한 kebab-case). 예: "air-hockey" */
  id: string;
  /** 카드에 표시될 이름 */
  name: string;
  /** 카드 설명 (1~2줄) */
  description: string;
  /**
   * 썸네일 이미지 URL.
   * 사용법: `import thumb from './air-hockey/thumbnail.svg'` 해서 받은 값을 그대로 넣음.
   * Vite가 static asset으로 처리 + base URL까지 붙여준 완성 경로를 돌려줌.
   */
  thumbnail: string;
  /** 지원 인원 — 지금은 항상 2지만 확장 대비 */
  minPlayers: number;
  maxPlayers: number;
  /** 방장이 방 만들 때 고를 수 있는 옵션 (예: 에어하키 승리 점수) */
  roomOptions: GameRoomOption[];
}

/**
 * 방 만들기 화면에서 방장이 고르는 옵션 정의.
 * 지금은 select만 지원. 필요해지면 slider/toggle 등 추가.
 */
export interface GameRoomOption {
  /** 내부 키 (roomOptions 객체의 키로 쓰임) */
  key: string;
  /** 화면에 표시될 라벨 (한국어) */
  label: string;
  type: 'select';
  choices: { value: string; label: string }[];
  defaultValue: string;
}

// ============================================
// 2. 게임 모듈 — 각 게임이 구현해야 할 계약
// ============================================

/**
 * 게임 종료 결과. 결과 화면이 사용.
 * `summary`는 게임마다 자유 스키마 (예: 에어하키라면 { myScore: 7, oppScore: 3 })
 */
export interface GameResult {
  /** 내 시점에서의 승패. 무승부면 null */
  winner: 'me' | 'opponent' | null;
  summary: Record<string, unknown>;
}

/**
 * 게임 내부 메시지. 각 게임이 `type` 문자열을 자유롭게 정의.
 * 예: 에어하키 → { type: 'input', payload: { mx: 120, my: 80 } }
 * 플랫폼은 내용 모르고 그냥 상대에게 전달만 함.
 */
export interface GameMessage {
  type: string;
  payload: unknown;
}

/**
 * 플레이어 정보 — 방에 들어온 사람 한 명.
 * RoomState.players 배열에 들어간다. 배열 첫 번째(players[0])는 항상 방장.
 */
export interface Player {
  /** PeerJS 내부 식별자 (방장 이양 / target 메시지용). 호스트 자신은 host.roomId 기반 */
  peerId: string;
  nickname: string;
  isHost: boolean;
  /**
   * 게임에서의 역할.
   * - 'player': 실제 참여
   * - 'spectator': 관전 (Phase 2에서 구현)
   */
  role: 'player' | 'spectator';
}

/**
 * 플랫폼이 게임에 주입하는 컨텍스트.
 * 게임은 이걸 통해 캔버스에 그리고, 상대에게 메시지 보내고, 종료를 알린다.
 */
export interface GameContext {
  /** 게임이 그릴 캔버스 (플랫폼이 미리 크기 세팅 후 전달) */
  canvas: HTMLCanvasElement;
  /** 이 클라이언트가 호스트인지 게스트인지 */
  role: 'host' | 'guest';
  /** 내 PeerJS ID (players 배열에서 자신을 찾거나, 상대 target 지정 시 사용) */
  myPlayerId: string;
  /** 내 관전자 여부 (Phase 2용) */
  isSpectator: boolean;
  /** 방 전체 플레이어 목록 (자신 포함). 최신은 플랫폼이 갱신해 참조로 전달 */
  players: Player[];

  /** (호환용) 내 닉네임 — 2인 게임 단순 접근. 다인 게임은 players에서 조회 권장 */
  myNickname: string;
  /** (호환용) 2인 게임 상대 닉네임. N인 게임은 players 사용 */
  opponentNickname: string;

  /** 방 만들 때 방장이 선택한 옵션 값 (예: { winScore: "7" }) */
  roomOptions: Record<string, string>;

  /**
   * 게임 메시지 전송.
   * @param options.target 특정 peerId에게만 전달 (생략 시 전체 broadcast).
   *                       호스트가 아닌 쪽에서 target 지정하면 호스트가 relay.
   */
  sendToPeer(message: GameMessage, options?: { target?: string }): void;

  /**
   * 게임 종료를 플랫폼에 알림 → 결과 화면으로 이동.
   * 호스트만 호출 (승패는 authoritative한 호스트가 결정).
   */
  endGame(result: GameResult): void;

  /**
   * 선택적: 게임이 UI 헤더(점수/상태 표시)에 스냅샷을 전달할 때 호출.
   * 게임마다 자유 스키마 (예: 에어하키 = { hostScore, guestScore }).
   * gameScreen이 이 값을 받아서 DOM에 반영한다.
   */
  onStatusUpdate?: (status: Record<string, unknown>) => void;
}

/**
 * 각 게임이 구현해야 할 인터페이스.
 * - start: 리소스 로드 + 루프 시작
 * - onPeerMessage: 상대가 보낸 게임 메시지 수신
 * - destroy: 이벤트 리스너 해제, RAF 취소 등 정리
 * - setPaused (선택): 일시정지 상태 전환. 게임마다 멈출 대상이 다름
 *     (에어하키 = 물리 / 테트리스 = 중력 / 사과·오목 = 타이머 등).
 *     gameScreen 이 pause/resume 메시지에 맞춰 호출. 미구현 게임은 무시 OK (1단계 한계).
 */
export interface GameModule {
  start(ctx: GameContext): void | Promise<void>;
  onPeerMessage(message: GameMessage): void;
  destroy(): void;
  setPaused?(paused: boolean): void;
}

/** 게임 레지스트리 엔트리 — 메타 + 실제 모듈 팩토리 */
export interface GameEntry {
  meta: GameMeta;
  /** lazy loading용 팩토리 (쓸 때 import) */
  load(): Promise<GameModule>;
}

// ============================================
// 3. 방 상태
// ============================================

export interface RoomState {
  /** 사람 친화 5자 코드 (예: "PK4M9") */
  roomId: string;
  gameId: string;

  /**
   * 방에 들어온 모든 사람. 첫 번째(players[0])는 항상 방장.
   * 4인 지원 이후 주 데이터 소스. N=2 게임도 이 배열에 2명이 들어있음.
   */
  players: Player[];

  /** (호환용) 방장 닉네임 — players[0].nickname과 동일 */
  hostNickname: string;
  /** (호환용) 2인 전용 게임용. players[1]?.nickname — 없으면 null */
  guestNickname: string | null;

  /** 비공개방이면 true (비번 있음) */
  isPrivate: boolean;
  /** 방장이 선택한 게임 옵션 값 */
  roomOptions: Record<string, string>;
  status: 'waiting' | 'playing';
}

// ============================================
// 4. 네트워크 메시지 프로토콜
// ============================================
// Peer끼리 주고받는 모든 메시지는 NetworkMessage 유니언 중 하나.
// `type` 필드가 discriminator라서, switch (msg.type) 안에서 msg 타입이 자동으로 좁혀짐.

export type NetworkMessage =
  | JoinRequestMsg
  | JoinAcceptedMsg
  | JoinRejectedMsg
  | RoomStateMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | GameStartMsg
  | GameEndMsg
  | GameMsg
  | PingReqMsg
  | PingAckMsg
  | PingReportMsg
  | ReactionMsg
  | PauseMsg
  | ResumeMsg;

/** 게스트 → 호스트: 방 입장 요청 (연결 직후 첫 메시지) */
export interface JoinRequestMsg {
  type: 'join_request';
  nickname: string;
  /** 비공개방이면 필수, 공개방이면 생략 */
  password?: string;
}

/** 호스트 → 게스트: 입장 수락 (현재 방 상태 같이 전달) */
export interface JoinAcceptedMsg {
  type: 'join_accepted';
  roomState: RoomState;
}

/** 호스트 → 게스트: 입장 거절 후 연결 끊김 */
export interface JoinRejectedMsg {
  type: 'join_rejected';
  reason: 'wrong_password' | 'room_full' | 'game_in_progress';
}

/** 호스트 → 게스트: 방 상태 브로드캐스트 (옵션 변경 등) */
export interface RoomStateMsg {
  type: 'room_state';
  roomState: RoomState;
}

/** 호스트 → 전체: 새 플레이어 입장 알림 (자기 포함한 RoomState도 따로 갱신 broadcast) */
export interface PlayerJoinedMsg {
  type: 'player_joined';
  player: Player;
}

/** 호스트 → 전체: 플레이어 퇴장 알림 */
export interface PlayerLeftMsg {
  type: 'player_left';
  peerId: string;
  nickname: string;
}

/** 방장 → 게스트: 게임 시작 신호 */
export interface GameStartMsg {
  type: 'game_start';
}

/** 호스트 → 게스트: 게임 종료 + 결과 */
export interface GameEndMsg {
  type: 'game_end';
  result: GameResult;
}

/** 게임 내부 메시지 래핑 — 플랫폼은 내용 모르고 그냥 전달 */
export interface GameMsg {
  type: 'game_msg';
  payload: GameMessage;
  /**
   * 특정 peer에게만 전달 (생략 시 전체 broadcast).
   * 호스트가 아닌 쪽에서 설정하면 호스트가 relay.
   */
  target?: string;
  /** 원 발신자 peerId (호스트가 relay 시 채워서 수신 측이 출처 식별 가능) */
  from?: string;
}

// --- Ping 프로토콜 (peer.ts가 자동 처리 — 게임 모듈은 신경 X) ---

/** 호스트 → 게스트: RTT 측정용 핑 요청. t = 호스트의 performance.now() */
export interface PingReqMsg {
  type: 'ping_req';
  t: number;
}

/** 게스트 → 호스트: 받은 t 그대로 반환. 호스트가 RTT 계산 */
export interface PingAckMsg {
  type: 'ping_ack';
  t: number;
}

/** 호스트 → 게스트: 계산된 ping(ms)을 해당 게스트에게 알림 (UI 표시용) */
export interface PingReportMsg {
  type: 'ping_report';
  ms: number;
}

/**
 * 이모지 반응 (대기실/게임 중 가벼운 소통).
 * 누군가 버튼 누르면 broadcast, 호스트가 타 게스트로 relay.
 * 수신 측은 화면 하단에 풍선 애니메이션으로 잠깐 띄운다.
 */
export interface ReactionMsg {
  type: 'reaction';
  emoji: string;
  /** 송신자 닉네임 (풍선에 같이 표시) */
  nickname: string;
}

/**
 * 게임 일시정지 — 누가 ⚙️ 메뉴를 열었음.
 * 다른 플레이어 화면에 dim overlay + "○○ 가 잠시 멈췄어요" 안내.
 * (1단계 MVP: 게임 모듈은 아직 정지하지 않음 — canvas 입력 차단만)
 */
export interface PauseMsg {
  type: 'pause';
  byPeerId: string;
  byNickname: string;
}

/** 일시정지 해제 — 메뉴 닫았음. 모든 화면 dim 제거. */
export interface ResumeMsg {
  type: 'resume';
  byPeerId: string;
}
