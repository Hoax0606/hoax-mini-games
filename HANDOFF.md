# Hoax Minigames — 진행 상황 & 다음 작업 인계

다른 머신(집)에서 이 프로젝트를 이어서 작업할 때 읽는 문서.
**Claude Code 첫 프롬프트로 "HANDOFF.md 정독하고 이어서 진행해줘" 라고 시작하면 됨.**

마지막 업데이트: **2026-07-17 (B)** (방 구조 개편: 게임을 방 안에서 선택 + 강퇴 + 비밀방 목록노출 + 게임 이탈시 계속(토대) + 포트리스 3버그 + 썸네일 소프트입체 + 플랫폼 화면 UI 통일 + 대기실/방찾기 리디자인)

### 🗓️ 2026-07-17 세션 (B) — 방 구조 개편 + 게임 수정 + UI 통일/리디자인
- **🏗️ 방 구조 개편(게임을 방 안에서 선택)** — 흐름 변경: (기존)게임선택→방옵션→대기실 → (신규)**방 만들기(공개/비밀+비번)→대기실에서 게임 선택**. 메뉴: 방 만들기 / 코드로 참여 / 공개방 찾기 / 게임 목록(도감). `createRoom` 게임무관(정원=`GLOBAL_MAX_PLAYERS`=10까지 받고 게임 고르면 그 max로 좁힘, `host.maxAccepted` 갱신). 대기실서 방장이 게임 선택/변경(호스트만) → gameId/옵션/정원/공개목록 동기화. 인원 초과 게임은 잠금(선택 불가), 미달은 대기실선 허용(시작 버튼서 강제, `enforceMin` 옵션). 게임선택 오버레이를 `src/ui/gamePicker.ts` 공용화(결과화면 '다른게임'과 공유, `buildGameTilesHTML`/`buildGameOptionsHTML`). `gameList`=도감(정적), `lobby.ts` 삭제. 미선택 방도 공개목록에 '게임 고르는 중'으로 뜸.
- **🚪 방장 강퇴** — 대기실 참가자 행 ❌(방장만 보임) → `host.kick(peerId)`: `kicked` 안내 후 연결 끊기. 강퇴당한 게스트는 '방장이 내보냈어요' 후 메뉴로(방장 나감과 구분, `wasKicked` 플래그).
- **🔒 비밀방 공개목록 노출** — 비밀방도 목록에 🔒로 뜨고 클릭 시 비번 입력(joinRoom `requirePassword`). `PublicRoomEntry.isPrivate` 추가. **+ 공개방 항목 생명주기 수정**: 예전엔 게임 시작 시 dispose가 무조건 unpublish→목록서 사라지던 버그. 이제 대기→게임→결과 내내 유지, `closeOnDispose`(방 닫을 때)만 제거. gameScreen/resultScreen 마운트 시 publishCount/status 갱신.
- **🎮 게임 이탈 시 계속 (#3 토대 + 원카드만)** — `GameModule.onPeerLeft?(peerId)` 선택 메서드 추가. gameScreen: 플레이어 이탈 시 **게임이 onPeerLeft 지원 && 남은 인원≥최소인원이면 그 사람만 빼고 계속**(호스트 authoritative sync), 아니면 기존대로 종료. **원카드만 구현**(기권과 동일 처리). **나머지 게임 미구현 = 여전히 종료**(다음 작업 🅒).
- **🃏 원카드 +4로 +2 방어** — +2 스택은 +2/+4 둘 다 받아침, +4 스택은 +4로만(+2 방어 불가). `canCounter()`.
- **💣 보스키(Esc 가짜 윈도우 업데이트) 전원 동기화** — 누가 Esc 누르면 전원 화면에 업데이트+정지(pause `boss` 플래그, `bossOn` 래치). 누가 껐든 전원 해제. 관전자는 로컬만(그리핑 방지). + Esc `e.repeat` 무시·캡처단계 등록(가끔 안 뜨던 것 수정).
- **💩 똥피하기** — (1)마지막 1명 남으면 끝나던 것→**전원 죽을 때까지 계속**(순위=생존시간) (2)초반 난이도↑(시작속도 230→275·스폰 0.60→0.42s, 커브를 40초서 예전값 수렴) (3)대시 방향 버그(방향키 keydown 시 facing 즉시 갱신).
- **🏰 포트리스 3버그** — (1)아래로 쏠 때 자기 포대 자폭(자탄이 발사 포대 벗어나기 전 충돌 무시=armed) (2)크레이터(깎인 땅) 이동 불가(높이차 abs→부호처리, 내려가기 자유) (3)바람이 게스트에서 안 보임(wind undefined/NaN이면 drawHUD가 아무것도 안 그리던 것 → Number.isFinite 가드 + decodeSync wind 기본값).
- **🎨 썸네일 16개 소프트 입체** — 중앙 일러스트에 부드러운 드롭섀도(`id=lift`)로 살짝 띄움(배경/데코 평면 유지, additive). 스타일 방향 3안(스티커/소프트입체/디테일) 목업 비교 후 **소프트 입체** 확정.
- **🧩 플랫폼 화면 UI 통일** — 공개방/통계/닉네임/설정: 뒤로가기 통일(닉네임 '취소'→← back-btn), 제목 규격 하나로(`.screen-title`=`.card-title` 28px·중앙·flex). 방찾기 재디자인(상단정렬 `.screen-top` + 카드 가운데 그리드 + 도감 톤 카드).
- **🏠 대기실 리디자인(apple-design)** — 타이틀 아이콘 제거, 게임 카드 상태(hover 뜸/선택 핑크링+✓/잠금🔒/press), 그리드 edge fade, 채팅을 카드 옆 아담한 패널로(카드+채팅 가운데 붙임, static), 반응 이모지 떠있는 스크롤 팝업(레이아웃 안 밀림), 게임 카드=도감 `.game-card` 스타일 통일(인원 뱃지), 빈자리 고스트 슬롯, 채팅 UI 목업 정합(흰 배경·전체라운드 버블·내메시지 핑크·알약 입력·원형 전송), 강퇴 버튼 가시성(핑크 원+굵은 ×), 게스트도 게임목록 스크롤 가능.
- **🗑️ 땅따먹기(territory) 삭제** — 플레이·리소스(8Hz 격자 스냅샷) 부담 커서 제거.
- **⚠️ 미검증**: 위 다수 런타임/멀티 테스트 필요(특히 방 구조 개편·이탈시계속·보스키 동기화·포트리스 3버그).

### 🗓️ 2026-07-17 세션 (A) — UI 리디자인 + P2P 안정성 + 포트리스 확장
- **🎨 UI 전면 리디자인(Solar 컬러 아이콘 + apple-design 톤)** — 이모지를 **Solar Bold Duotone 아이콘**으로 통일. `src/ui/icons.ts` 신규(약 28종 SVG 정적 인라인, MIT, 의존성/네트워크 X. `icon(name,{size,hue})`, 색은 `--hue` 커스텀 속성→hover 로 덮어쓰기 가능). theme.css 공용: `.ic`, 눌림 스프링(`.btn:active scale .97`), 등장 모션(`.pop-in`/`.stagger-in`, prefers-reduced-motion 대응), 메뉴 프로스티드 카드(`.menu-card`, hover 시 핑크). **적용 범위**: 메뉴·방만들기·방찾기·게임목록·통계·닉네임·설정·대기실(호스트/게스트)·결과·게임 chrome(인게임 메뉴 모달)·채팅·상태배지. **일부러 유지**: 감정/반응 이모지(😊🎉💥 리액션·결과 대표 🏆💫⚖️), 🎀 대기실 리본은 sofa 아이콘으로 교체. **게임 속 캔버스 HUD 이모지 = 나중에(게임별 개선 때 함께) / 게임 썸네일 = 그대로 유지** (Henry 결정).
- **🔌 재연결 유예(reconnect grace)** — 순간 끊김(WiFi/ICE/백그라운드)에 바로 "방장이 나갔어요"로 튕기던 것 완화. 게스트: 끊기면 GUEST_RECONNECT_WINDOW_MS(9s) 재시도 + "재연결 중" 오버레이(`src/ui/reconnectOverlay.ts`), 성공 시 복구/실패 시 기존 안내. 호스트: HOST_GRACE_MS(12s) 동안 방에 남겨두고 같은 peerId 재연결 시 conn 만 교체(플레이어 목록 유지)+room_state 재전송. 게스트 창(9s)<호스트 유예(12s)라 유예 만료 후 좀비 강등 없음. 자발적 퇴장은 `LeaveMsg`로 즉시 제거(close 시 150ms flush). `onGuestReconnected` 콜백. **적대적 리뷰 6건 반영**(leave flush, 재연결 conn 교체 순서, room_state 미처리 등). *디스커넥트 N인 방 유지(아래 🅐)를 일부 완화 — 짧은 끊김은 이제 자동 복구.*
- **✅ 준비(Ready) 시스템** — 게스트 대기실 버튼을 '준비 ↔ 준비 취소' 토글로. **전원 준비돼야 방장 시작 가능**(미준비 N명 표시). 참가자 목록에 준비 배지(준비완료=초록). 게임/설정 바뀌면 준비 리셋. `Player.ready` + `ReadyMsg`.
- **🏠 대기실 개편** — 설정 UI를 우측 타일 그리드 아래 **고정 바**(옵션 유무 무관 동일 크기, 한 줄). '공개/비공개' 배지 제거. **게스트도 방장과 동일한 2-pane UI**(참가자 | 게임 타일+설정) 읽기 전용으로 현재 선택 게임 확인.
- **🔄 결과 화면 '대기실로 이동'** — 즉석 게임선택 오버레이 제거 → 방장/게스트 모두 **방 대기실로 복귀**(연결 유지, `ReturnToLobbyMsg`, `WaitingRoomAsHostArgs.initialPlayers`로 연결된 게스트 seed·준비 리셋)해 거기서 게임 고르고 전원 준비 후 시작. '다시 하기'는 유지.
- **🏰 포트리스 카메라 + 맵 확대** — 세로 화면 채우는 스케일(포대 크기 일정) + **가로 카메라 스크롤**(자동: 현재 포대/포탄 따라감, 수동: 마우스 휠 / ← →). 맵 폭을 **포대 개수 비례**(포대당 ~190px, 최소 900, `mapWidthForForts`)로 넓혀 6인 2포대(12개)도 안 붙음. 지형 복잡도↑(사인 진폭+4번째 레이어). `MAX_VIEW_W`(820) 캡으로 넓은 화면에서도 포대 크게+스크롤 여지. rect.height=0 시 카메라 NaN 영구 멈춤 버그 수정.
- **🎯 포트리스 진짜 유도탄** — '바람 무시 포탄'에서 실제 유도 미사일로. 유도탄 선택 시 드래그 대신 **적 포대 클릭→타겟 락(레티클+조준선), 재클릭→발사**. 발사 후 타겟 향해 제한 선회 호밍(등속, 중력/바람 무시, 고정 SIM_DT라 결정론), 기존 스윕 충돌 재사용 → **중간 지형/포대에 막히면 거기서 폭발**. `fr:fire`에 targetX/Y. **결정론 리뷰 통과**(브로드캐스트 파라미터+고정스텝으로만 궤적 계산).
- **🧱 배틀 테트리스 폴리시** — 블록 각진 사각형→모서리 둥글리기(roundRect), ARR 45→30ms·DAS 160→150ms(좌우 이동 가볍게).
- **✂️ 말줄임표 제거** — 모든 UI 텍스트에서 `…`/`...` 제거(로딩/상태 문구). 닉네임 잘림 표시(`slice()+'…'`)는 기능 표시라 유지.
- **⏱ 스토리텔링 컷 시간** — 60/120 → **120/180초**(기본 120).
- **⚠️ 미검증(런타임 테스트 필요)**: 포트리스 카메라·유도탄(2인+), 재연결 유예(끊김 시나리오), 결과화면 대기실복귀 흐름. **커밋 다수 쌓임 → push 필요.**

---

### 🗓️ 2026-07-15 세션
- **🆕 똥 피하기(dodge) 게임** — 1~10인 배틀로얄. 위에서 떨어지는 💩를 ← → 이동 + Space 대시(쿨다운 1.5초)로 피함. 마지막 생존자 승, 순위=생존시간. **독립 시뮬 + 결정론적 낙하물**(위치=시드+경과시간 순수함수, mulberry32) — 방옵션 `낙하 패턴` 동일(전원 같은 패턴·공정)/랜덤(각자). capped simT 통일로 렉 시 터널링·정지중낙하 방지. 호스트가 dg:hb 집계→dg:standings broadcast, 마지막 생존자+3분 워치독. `dodge/`. **미검증(런타임 테스트 필요)**. (공격변형 ⭐먹으면 상대에 똥폭탄 = 후속 아이디어)
- **👥 다인 게임 10인 확대** — 2인 전용(에어하키·오목)·알까기(판 구조상 4인 유지) 빼고 **전부 최대 10인**. 크래시 유발 제거(fortress/liar/word-chain throw 상한↑, FortIndex/PlayerIndex→number, 포트리스 색 6→10). 레이아웃 적응화(테트리스 미니뷰 2행+관전 동적격자, 반응속도/끝말잇기/폭탄/다트/그림퀴즈/라이어 패널 축소·2열·행높이 자동). 길이/성능 상한(그림퀴즈 15라운드, 스토리텔링 짧게≤6턴, 라이어 7인+ 힌트1바퀴, 테트리스 7인+ 전송 5.5Hz). **알까기는 다른 형식으로 재설계 예정(이번 제외).**
- **🌐 서버 안정성 완료** — 콜드스타트(Render 무료 티어 슬립, 접속 한참 걸림)를 **cron-job.org 5분 핑 keep-warm**으로 제거(외부 설정, 코드 아님). **metered.ca 무료 TURN**(대칭 NAT/회사망 커버, `netConfig.ts`에 클라이언트용 자격증명 하드코딩·env 덮어쓰기 가능). peer.ts **연결 재시도**(일시적 실패 backoff, create ~40초/connect ~56초 상한). *진단: 트래픽 아니고 시그널링 서버 콜드스타트였음. C안(Firebase 시그널링 전환)은 peer.ts 재작성 리스크 커서 보류.*
- **🆕 스토리텔링(이어그리기) 게임** — 3~6인(→최대 10인 확대됨), **갈틱폰 방식**. N명=N권의 책, 각자 제시어로 시작. 매 턴 **전원 동시에** 그리고(쉬는 사람 0명) 시간 끝나면 책이 옆으로 회전 → 넘겨받은 책의 **직전 컷만 옅게(유령)** 보며 이어 그림. 방옵션: 짧게(1바퀴)/길게(2바퀴, 상한 8턴) · 컷당 60/120초. 마지막에 책별 **슬라이드쇼 감상**, 승패 없음(결과화면 전용 "감상 완료" 카드). 제시어 ~150개(`story-draw/prompts.ts`). 그림엔진은 draw-quiz 개선판을 자체 복사(전체 캔버스 1패널). 그림은 실시간 공유 X(반전 재미) — 호스트에게만 target 전송. **미검증(P2P 3인+ 테스트 필요)**.
- **🖌️ 그림 도구 대개편(draw-quiz)** — 도구를 **라디오 방식**으로(펜/형광펜/지우개/채우기/스포이드, 하나만 활성). **채우기(flood fill)** 실동작, **컬러 피커(그라데이션)**, **실행취소(Ctrl+Z)**, **스포이드**, 도형(자유/직선/사각/원) 유지. 렌더를 **오프스크린 누적 레이어**로 바꿈(채우기·지우개 투명처리 위해). story-draw 가 이 엔진 재사용.
- **🏰 포트리스 물리 재작업(Plan B)** — 궤적을 **구간별 해석식(piecewise-analytic) + 고정 스텝 누적기**로 → 프레임레이트·렉 무관, 호스트·게스트 궤적 동일. **직격 판정 스침거리(swept)+최근접점 스냅**(반경 13→16), **폭발 데미지 수직 가중 0.6**(지형 높이차로 "옆인데 0뎀" 완화), 폭격탄 **5발 결정론적 대칭**, 크레이터 -30%, 폭발 이펙트 호/게 통일. sync 가 발사 중 포탄 덮어쓰던 것 + 일시정지 후 포탄 멈춤 수정.
- **🐛 대규모 버그 스윕(전 게임+플랫폼 소스 리뷰)** — 고친 것: 이모지 XSS(reactions), 채팅 방 넘어 누수(lobby clear), 사과 destroy 후 finishGame, 다트 버스트 입력 미잠금, 알까기·끝말잇기 `getNextTurn` 턴 스킵(indexOf -1), 에어하키 물리∝주사율(고정스텝), 반응속도 무한대기(워치독), 초기 hello 유실→게스트 멈춤(gameScreen 버퍼링), 관전자 전원 일시정지, 동시 일시정지 desync(Set), 비활성 버튼이 활성처럼 보임(theme.css). **미해결(다음 작업)**: 디스커넥트 시 N인 방 유지(게임별 이탈 처리 필요, 규모 큼).
- **🆕 라이어 게임** — 3~8인, 고정 5라운드 누적점수. 매 라운드 랜덤 라이어 1명. **2모드**: 일반(라이어는 제시어만 모름) / 바보(라이어도 자기가 라이어인 줄 모름, 같은 주제 가짜 단어 받음). 흐름: 역할배정(per-peer 비밀 `lg:role`) → 힌트 2바퀴 타이핑 → 비밀투표 → (라이어 지목 시)제시어 추측 → 결과. 동점=라이어 승. 점수: 라이어 승 +2 / 시민 승이면 라이어 지목한 시민 각 +1. 힌트 검증(제시어 직접언급 금지+20자), 힌트/투표/추측 타임아웃. 비밀정보는 sync 에 안 담고 host-only. 카테고리 풀 15주제(`liar-game/words.ts`). **미검증(P2P 3인+ 테스트 필요)**.
- **🔧 연결 안정화(초기)** — PeerJS 무료 공용 서버 불안정 → 자체 PeerServer(`peerserver/`, Render 배포) + ICE 설정(`src/core/netConfig.ts`). `DEFAULT_PEER_HOST`=`hoax-mini-games.onrender.com` 설정 완료. 창 닫으면 방 나가기(peer.ts `pagehide`). *(콜드스타트·TURN·재시도는 위 "🌐 서버 안정성 완료"에서 마무리됨.)*
- **🏰 포트리스 대개편** — 탱크 비주얼(궤도+포탑+회전포신+묘비) / 무기 6종(일반∞ + 특수5: 대형/유도/폭격/분열/수류탄, 랜덤 3종×3발) / 포대 이동(◀▶ 홀드+연료) / 턴 타이머 링 / 조준 파워 원뿔 / 폭발 이펙트 / 총구 클리어런스+히트박스 정확도 / 다수 동기화 버그 수정. 설계 스펙 `docs/superpowers/specs/`.
- **🐛 기타 수정** — 끝말잇기 시작 단어 결정론적 시드(전원 일치), 알까기 흰 화면 방어(sync 검증+render 가드), 이모티콘 40개+최소화 토글, 일시정지 pauser 추적.
- **🆕 그림 퀴즈 게임** — 3~6인 라운드제. 출제자가 후보 3개 중 1개 골라 그리고(70초), 나머지는 추측 input 으로 맞힘. 빨리 맞힐수록 고득점(100→최소50), 출제자는 맞힌 사람 수×30. 전원 출제 후 누적 최고점 승. 호스트 authoritative. 그리기 도구(펜/지우개/색6/굵기3) canvas 외부 HTML. 정답은 채팅과 분리된 별도 input(단어 노출 방지). 제시어 풀 287개(`draw-quiz/words.ts`).
- **🆕 끝말잇기 게임** — 2~6인 턴제. 30초 제한. 두음법칙(ㄹ→ㄴ, ㄴ→ㅇ) + 중복 금지 + 사전 검증. 최후 1인 승. 사전 10320단어(`word-chain/dictionary.ts`). 전용 BGM(D 마이너 펜타토닉).
- **알까기** — 2~4인 턴제 물리. 전용 BGM(A 마이너 펜타토닉) + 충돌 SFX(호·게 동기화) + 통계. 알 12 / 판 380. 차례 외 자기 알 클릭 시 거절음.
- 이전 스냅샷(2026-06-06): 알까기 게임 신규, escape 헬퍼 통합, gameScreen sound import fix
- 이전 스냅샷(2026-06-05): 테트리스 관전 v2, 오목 렌주룰, 방어 fix

---

## 🚀 빠른 시작 (다른 머신에서)

```bash
git clone https://github.com/Hoax0606/hoax-mini-games.git
cd hoax-mini-games
npm install
npm run dev       # http://localhost:5173
```

에디터에서 Claude Code 열고:

> HANDOFF.md + CLAUDE.md 둘 다 정독하고 이어서 진행해줘.

---

## 📌 현재 위치

| Phase | 내용 | 상태 |
|---|---|---|
| 1 | 플랫폼 N인화 | ✅ 완료 |
| 2 | 관전 모드 v1 | ✅ 완료 (2026-04-23) |
| 2.5 | 테트리스 관전 뷰 v2 (2×2 격자) | ✅ 완료 (2026-06-05) |
| 3 | **방장 이양** | 🔜 **진행 예정** (Henry 하기로 전환 — 완전 이양) |
| 4 | 배틀 테트리스 | ✅ 완료 |
| 5 | 결과 화면 다인용 | ✅ 게임별 전용 UI |

**다음 작업** (우선순위):
- 🅒 **게임 이탈 시 계속 — 나머지 게임** (토대 완료, 원카드만 구현됨). `GameModule.onPeerLeft?(peerId)` 를 게임별로 추가:
  - **턴제(그 사람 턴이면 스킵+순서서 제거)**: 라이어·오목·끝말잇기·폭탄끝말·그림퀴즈·이야기그림·포트리스
  - **실시간(나간 사람 정지만, 종료 안 하게)**: 사과·배틀테트리스·라면·반응속도 (똥피하기는 이미 전원죽을때까지)
  - **2인 전용(계속 불가 → 남은 사람 승 처리)**: 에어하키·오목·알까기
  - 미구현 게임은 지금도 "누가 나가면 종료"로 안전하게 동작(opt-in).
- **Phase 3 방장 완전 이양** (Henry 하기로 함, 큰 작업) — P2P star 구조라 방 코드=방장 peerId. 호스트 상실 감지 → 후계자 결정(결정론적) → 후계자가 수신 가능 세션으로 승격 → 전원 재연결 + 게임/방 상태 이관. peer.ts 대공사. 갑작스런 끊김(탭닫음)까지 커버 요청.
- 🅓 **알까기 재설계** — 판 4변 배치라 5인+ 불가 + "먼저 치면 유리" 밸런스. 다른 형식으로 갈아엎기로 함(Henry).
- 🅔 **똥 피하기 공격변형(후속)** — ⭐ 아이템 먹으면 랜덤 상대에게 똥폭탄 투하.
- 🅕 **남은 저위험 UI** — 모달 스크롤락, N인 게임 헤더 2명만 표시, 다트 결과 랭크 여백.
- **신규 게임 후보: 원나잇 인랑(마피아류, 텍스트 토론)** — Henry 관심. 4인 가능(인랑+정보역할+스왑역할+중앙카드). 밤 진행 host-authoritative, 토론=구조화 발언(버튼)+자유채팅, 라이어 phase/채팅 재사용. **논의만 함, 미착수.**
- **썸네일 개별 조정** — 소프트입체 일괄 적용됨. 포트리스 등 하단 그림자 넘침 있으면 개별 dy 조정 가능. Henry가 볼 것 있으면 말하기로.
- **UI 리디자인 후속** — 대기실/방찾기/4개 화면 통일 완료. 다른 화면(결과화면 등) 손볼지 Henry 판단.
- 🅑 게임 속 캔버스 HUD 아이콘화 — 각 게임 개선 때 함께(보류). 썸네일 일러스트는 유지.
- (선택) 리팩토링 — resultScreen 결과카드 범용화 / gameScreen factory 공통화 / draw-quiz·story-draw 그림엔진 공용화.

---

## 🎮 프로젝트 개요

**한 줄**: 친구끼리 즐기는 웹 P2P 미니게임 모음집.
- **스택**: Vite + TypeScript + Canvas + PeerJS (WebRTC, 서버리스 P2P) + GitHub Pages
- **분위기**: 산리오풍 파스텔. 한국어 UI. PC 전용.
- **현재 게임 (15종)** — 2인 전용·알까기 외 전부 **최대 10인**:
  - 에어하키 (2인 전용, 호스트 authoritative 물리)
  - 배틀 테트리스 (2~10인, 로컬 시뮬레이션)
  - 사과 게임 (1~10인, 숫자 사과 합 10 터트리기, 2분)
  - 오목 (2인 전용, 15×15 또는 19×19, 30초 턴, 호스트 authoritative, 캐주얼 렌주룰)
  - 반응속도 (1~10인, 5라운드 평균 ms 경쟁)
  - 다트 (1~10인, 6모드 — 301/201/101 Normal·Hard / Count-up / Low Count-up / Cricket). `darts/netSync.ts` 분리.
  - 알까기 (2~4인, 턴제 물리. 판 4변 배치라 4인 고정 — 재설계 대기. `algagi/`)
  - 끝말잇기 (2~10인, 턴제 30초. 두음법칙 + 사전 검증. 호스트 authoritative. `word-chain/`)
  - 폭탄 끝말잇기 (2~10인, 랜덤 폭탄 타이머. word-chain 재사용. `bomb-wordchain/`)
  - 그림 퀴즈 (3~10인, 라운드제. 개선된 그림도구. 제시어 287개. `draw-quiz/`)
  - 포트리스 (2~10인, 턴제 포병. 해석식 궤적 + 호스트 착탄 확정. `fortress/`)
  - 라이어 게임 (3~10인, 5라운드. 일반/바보 2모드. 호스트 authoritative. `liar-game/`)
  - 스토리텔링 (3~10인, 갈틱폰식 이어그리기. 슬라이드쇼 감상, 승패 없음. `story-draw/`)
  - 라멘가게 (1~10인, 독립 가게 매출 경쟁. `ramen-shop/`)
  - 🆕 똥 피하기 (1~10인, 💩 낙하물 회피 배틀로얄. ←→ 이동 + Space 대시. 결정론 낙하물 동일/랜덤. `dodge/`)
- **배포 URL**: https://hoax0606.github.io/hoax-mini-games/

---

## 🧱 아키텍처

### 파일 구조
```
src/
├── main.ts                      # 엔트리 + 글로벌 버튼 사운드 훅 + ?room= URL 자동 입장
├── core/
│   ├── peer.ts                  # PeerJS 래퍼 (HostSession 다중 conn, GuestSession)
│   │                            #   JoinDecision.asSpectator, ping 측정(2s 주기 RTT), chat relay
│   ├── screen.ts                # 화면 라우터
│   ├── storage.ts               # localStorage 래퍼 (nickname/settings/GameStats)
│   ├── sound.ts                 # Web Audio SFX 합성 (에어하키 5종 + 테트리스 8종)
│   │                            #   startBgm/stopBgm 래퍼로 bgm.ts 위임
│   ├── bgm.ts                   # 게임별 BGM 시퀀서 (5종: ah/bt/ag/gomoku/darts)
│   ├── firebase.config.ts       # 🆕 Firebase SDK 초기화 + projectId/databaseURL 등
│   └── roomDirectory.ts         # 🆕 publicRooms 노드 publish/update/subscribe + onDisconnect 자동 제거
├── games/
│   ├── types.ts                 # GameContext, Player(role), NetworkMessage + ping/reaction/chat
│   ├── registry.ts              # 등록된 게임 목록 (15종)
│   ├── air-hockey/              # 2인 호스트 authoritative
│   ├── battle-tetris/           # 2-4인 로컬 시뮬레이션
│   ├── apple-game/              # 1-4인 독립 보드 + 점수 경쟁 (17×10)
│   ├── gomoku/                  # 2인 턴제, 호스트 authoritative, 15/19, 30초 턴
│   │                            #   go:request_move / go:move / go:sync / go:hello / go:end
│   ├── reflex/                  # 1-4인 5라운드 반응속도
│   │   ├── index.ts             #   루프 + phase 관리
│   │   ├── render.ts            #   상대 미니뷰 포함
│   │   └── netSync.ts           # 🆕 rx:round_done / rx:player_done / rx:phase / rx:end encode/decode
│   ├── darts/                   # 1-4인 6모드 다트 (완성)
│   │   ├── rules.ts             #   순수 상태머신 (X01 Normal/Hard, Count-up, Low, Cricket)
│   │   ├── board.ts             #   과녁 좌표 → HitResult 판정
│   │   ├── render.ts            #   다트판 + 다트 + 점수 패널
│   │   ├── index.ts             #   플릭 투척 물리 + 턴 진행
│   │   └── netSync.ts           #   dart:hello / dart:sync / dart:throw / dart:end
│   ├── algagi/                  # 🆕 2-4인 알까기 (턴제 물리, 호스트 60Hz 시뮬)
│   │   ├── rules.ts             #   보드/알 상수, 초기 배치, 턴/승패 판정
│   │   ├── physics.ts           #   마찰 + 원-원 탄성 충돌 + 드래그→속도
│   │   ├── render.ts            #   보드 + 알 + 드래그 가이드 + 패널
│   │   ├── index.ts             #   시뮬 루프 + 마우스 입력 + 충돌 SFX
│   │   └── netSync.ts           #   ag:hello / sync / flick / state(impulse) / end
│   ├── word-chain/              # 🆕 2-6인 끝말잇기 (턴제 30초, 사전 검증)
│   │   ├── rules.ts             #   한글 음절/두음법칙 + 검증 + 턴/탈락
│   │   ├── dictionary.ts        #   한국어 명사 10320 + SEED_POOL. WORDS 배열에 추가만 하면 확장
│   │   ├── render.ts            #   큰 단어 + 타이머 ring + 히스토리 + 플레이어 카드
│   │   ├── index.ts             #   호스트 검증 + HTML input UI 마운트 + 30초 타이머
│   │   └── netSync.ts           #   wc:hello/sync/submit/accepted/rejected/timeout/end
│   ├── draw-quiz/               # 3-6인 그림 퀴즈 (라운드제, 출제자 그림 broadcast)
│   │   ├── words.ts             #   제시어 287개 (easy/normal/hard) + pickCandidates
│   │   ├── rules.ts             #   라운드/점수/출제자 로테이션/정답 판정
│   │   ├── render.ts            #   오프스크린 누적레이어 + flood fill + 스포이드 + stroke + 타이머 + 점수판
│   │   ├── index.ts             #   호스트 라운드 진행 + 그리기 입력 + 도구(펜/형광펜/지우개/채우기/스포이드/도형/컬러피커/Undo) HTML UI
│   │   └── netSync.ts           #   dq:hello/sync/round_start/word_chosen/round_begin/stroke/undo/clear/guess/correct/round_end/end
│   ├── story-draw/              # 3-10인 스토리텔링(갈틱폰식 이어그리기)
│   │   ├── prompts.ts           #   제시어 풀 ~150개 (장면/상황 씨앗)
│   │   ├── rules.ts             #   책/컷 데이터모델 + 책 회전 배정(bookForSeat) + stroke 타입 + 제시어 배정
│   │   ├── render.ts            #   draw-quiz 그림엔진 복사(전체 캔버스) + 직전컷 유령 + 슬라이드쇼
│   │   ├── index.ts             #   전원 동시 그리기 + 호스트 턴 관리 + 도구 UI + 슬라이드쇼
│   │   └── netSync.ts           #   sd:hello/sync/turn/progress/done/reveal/end
│   └── dodge/                   # 🆕 1-10인 똥 피하기(낙하물 회피 배틀로얄)
│       ├── rules.ts             #   상수 + mulberry32 시드 스포너(결정론 낙하물) + 충돌(AABB)
│       ├── render.ts            #   필드(💩+캐릭터+대시잔상) + 생존현황 패널(행높이 자동)
│       ├── index.ts             #   입력(←→+Space대시 쿨다운) + capped simT 시뮬 + 호스트 순위/종료
│       └── netSync.ts           #   dg:hello/start/hb/standings/end
├── screens/
│   ├── menu.ts                  # 메인 메뉴 (방 만들기/방 찾기/게임 목록/통계/닉네임/설정 — Solar 컬러 아이콘 + 프로스티드 카드)
│   ├── nickname.ts, settings.ts, gameList.ts, lobby.ts
│   ├── createRoom.ts, joinRoom.ts    # joinRoom: initialCode/autoJoin 지원 (URL 공유 입장)
│   ├── waitingRoom.ts           # 호스트/게스트 factory + "🔗 링크" + 리액션 + 채팅 패널 + Firebase publish
│   ├── gameScreen.ts            # 관전자 수락 + ping 배지 + 리액션 + 채팅 패널
│   ├── statsScreen.ts           # 게임별 누적 전적/최고기록 (localStorage)
│   ├── publicRooms.ts           # 🆕 Firebase publicRooms 실시간 구독 → 카드 리스트 → 클릭 시 autoJoin
│   └── resultScreen.ts          # 게임별 전용 결과 분기 (테트리스/사과/오목/반응속도/다트/알까기/끝말잇기/그림퀴즈/포트리스/라이어/스토리텔링=감상완료)
├── ui/
│   ├── theme.css                # 팔레트 + 컴포넌트 스타일 (chat-panel / public-room-card / wc-input / .ic / .menu-card / 모션유틸)
│   ├── icons.ts                 # 🆕 Solar Bold Duotone 아이콘 세트(SVG 정적 인라인, MIT) + icon(name,{size,hue}) 헬퍼
│   ├── reactions.ts             # 이모지 6종 버튼 + 하단 풍선 애니 (400ms throttle) — 감정 이모지라 유지
│   ├── chat.ts                  # 채팅 사이드패널 build/wire/append + 방 내부 history 유지 (chat 아이콘)
│   ├── reconnectOverlay.ts      # 🆕 재연결 중 오버레이 show/hide (게스트 순간 끊김 시)
│   ├── gamePicker.ts            # 게임 타일 그리드/옵션 HTML (대기실 인라인). openGamePickerOverlay 는 이제 미사용
│   ├── escape.ts                # escapeHtml / escapeAttr 단일 출처
│   └── logo.png                 # 메인 로고 이미지
└── .github/workflows/deploy.yml # GitHub Pages 자동 배포
```

### 메시지 프로토콜

**NetworkMessage** (플랫폼 레벨):
- `join_request` / `join_accepted` / `join_rejected`
- `room_state` / `player_joined` / `player_left`
- `game_start` / `game_end` — game_end 는 **관전자 결과 화면 이동 경로**
- `game_msg` — 게임별 메시지 wrapper. `target?: string`, `from?: string`
- `ping_req` / `ping_ack` / `ping_report` — peer.ts 가 자동 처리 (2초 주기 RTT 측정). 게임 모듈은 신경 X.
- `reaction` — 이모지 반응 broadcast. 대기실/게임 화면에 풍선 뜸.
- `pause` / `resume` — 인게임 메뉴 모달 열림/닫힘 시 broadcast. 호스트가 다른 게스트에 relay. 모든 클라이언트가 dim overlay + `gameModule.setPaused` 호출.
- `chat` — 채팅 메시지. 게스트가 보내면 호스트가 받아 다른 게스트들에 relay. 본문 trim + maxLen 200, 250ms throttle, history 100개 cap.
- `ready` — 🆕 게스트 대기실 준비 토글(게스트→호스트). 호스트가 `Player.ready` 갱신 후 room_state broadcast. 전원 준비돼야 시작.
- `leave` — 🆕 게스트 자발적 퇴장 알림(방 나가기/탭 닫기 직전). 호스트가 재연결 유예 없이 즉시 제거(일시 끊김과 구분). GuestSession.close 가 150ms flush 후 destroy.
- `return_to_lobby` — 🆕 결과 화면 '대기실로 이동'(호스트→게스트). 게스트도 대기실로 복귀(연결 유지). roomState 동봉(준비 리셋).
- **재연결(전송계층, peer.ts 자동)** — conn 끊김 시 게스트가 재연결 시도, 호스트는 유예 후 제거. `HostSession.onGuestReconnected(peerId)→RoomState` 로 복구 시 상태 재전송. GuestSession `onReconnecting`/`onReconnected` 콜백(오버레이).

**GameMessage** (게임 내부):
- 에어하키: `ah:state` / `ah:input` / `ah:end`
- 테트리스: `bt:state` (10Hz) / `bt:garbage` / `bt:topped` / `bt:end`
- 사과 게임: `ag:hello` (게스트 → 호스트 seed 요청) / `ag:seed` / `ag:score` / `ag:end`
- 오목: `go:request_move` / `go:move` / `go:sync` / `go:hello` / `go:end`
- 반응속도: `rx:round_done` / `rx:player_done` / `rx:end`
- 다트: `dart:hello` / `dart:sync` (관전자 합류 시 현재 game state + stuckDarts 동기화) / `dart:throw` (투척자 초기 속도/위치 broadcast) / `dart:end` (호스트 per-peer 결과)
- 스토리텔링: `sd:hello` / `sd:sync`(전체 상태) / `sd:turn`(새 턴, 좌석별 책/제시어/직전컷 유령 배정) / `sd:progress`·`sd:done`(그리는 사람→호스트, target=호스트로 relay 차단) / `sd:reveal`(전체 책) / `sd:end`(승패 없음)
- 똥 피하기: `dg:hello` / `dg:start`(모드+시드) / `dg:hb`(생존시간/사망, 클라→호스트 target) / `dg:standings`(호스트→전체 생존현황) / `dg:end`(per-peer 순위)
- 포트리스: `fr:hello` / `fr:sync`(지형 seed+크레이터+게임상태) / `fr:fire`(발사 — 각도/파워/시작좌표/바람/무기, **유도탄이면 targetX/Y** → 호밍 목표) / `fr:impact`(호스트 착탄 확정: 크레이터+HP+다음턴/바람) / `fr:move`(포대 이동) / `fr:end`. 궤적은 고정 SIM_DT(1/120) 결정론 재생, 유도탄도 동일(호밍은 브로드캐스트 파라미터로만 계산). 카메라(스크롤/줌)·타겟 레티클은 로컬 시각 전용(비결정론 무관).

### 역할 (GameContext.role + isSpectator)
- `role: 'host'` — 방장. 승리 판정자.
- `role: 'guest'` + `isSpectator: false` — 일반 플레이어.
- `role: 'guest'` + `isSpectator: true` — 관전자. 입력/브로드캐스트 없음, 렌더만.

### 핵심 설계 원칙

1. **에어하키** = 호스트 authoritative 물리, 60Hz state broadcast.
2. **배틀 테트리스** = 로컬 시뮬레이션, 10Hz 스냅샷. 호스트는 승리 판정만.
3. **사과 게임** = 독립 보드(같은 seed로 동일 배치) + 게임 중 상대 점수 비공개. 타이머 만료 시점에만 점수 공유, 호스트 1초 grace period 후 랭킹 집계.
4. **오목** = 호스트 authoritative. 게스트는 `go:request_move` 로 의사 전달 → 호스트 검증 후 `go:move` broadcast. 각 턴 30초, 타임아웃은 호스트가 판정.
5. **반응속도** = 각자 독립 5라운드. 라운드 종료 시점에만 broadcast. 호스트가 전원 완료 감지 → per-peer `rx:end`.
6. **다트** = rules.ts 순수 상태머신 + 플릭 투척 물리. 각 클라이언트가 결정론적 시뮬레이션 — 투척자가 `dart:throw`(초기 속도) broadcast 하면 수신 측이 같은 파라미터로 물리 재생해 착지점·점수 수렴. 호스트가 `dart:end`로 per-peer 결과. 관전자 중간 합류는 `dart:hello`/`dart:sync` 핸드셰이크로 처리.
7. **게임 모듈 확장성**: `src/games/<id>/` + `GameModule` + registry. 플랫폼 수정 X.
8. **관전자 결과 화면 이동**: 플레이어는 게임 내부 end 메시지, 관전자는 플랫폼 `game_end` broadcast.

---

## 🎵 BGM (bgm.ts)

각 게임이 자기 BGM 재생 — chiptune 스타일 짧은 루프(8마디), 멜로디+베이스 2트랙.
- `sound.startBgm('air-hockey' | 'battle-tetris' | 'apple-game')`
- `sound.stopBgm()` — 게임 모듈 destroy 에서 호출
- `storage.bgmEnabled=false` 면 no-op
- BGM 은 SFX 보다 작게 (마스터 게인 × 0.35)
- 끊김 없는 루프 (한 루프 끝 50ms 전에 다음 루프 스케줄)

**각 BGM 특징**:
- 에어하키: C 메이저 · 140 BPM · square · 경쾌 (2026-04-24 훅 강화판)
- 배틀 테트리스: A 마이너 · 110 BPM · triangle · 긴장감
- 사과 게임: F 메이저 · 95 BPM · triangle · 밝고 느긋
- 오목: F 메이저 · 88 BPM · triangle · 따뜻·잔잔
- 다트: C 메이저 · 100 BPM · triangle · 경쾌한 아르페지오
- 반응속도: G 메이저 · 105 BPM · square (2026-04-25 추가, "반복 모티프 + 가벼운 긴장감")
- 알까기: A 마이너 펜타토닉 · 90 BPM · triangle · 한국 전통 놀이풍 + 살짝 긴장
- 끝말잇기: D 마이너 펜타토닉 · 92 BPM · triangle · 사색적 + 한국 전통풍
- 그림 퀴즈: 사과게임 BGM 재활용 (F 메이저 · 밝고 느긋). 전용 BGM 은 후속 여지
- 스토리텔링: 사과게임 BGM 재활용 (밝고 느긋). 전용 BGM 은 후속 여지

---

## 🧩 플랫폼 확장 기능 (2026-04-24 회사컴 추가)

### Ping 측정 (peer.ts)
- HostSession 이 2초마다 모든 게스트에게 `ping_req` 전송
- 게스트 자동 `ping_ack` 회신 → 호스트가 RTT/2 를 편도 ms 로 기록
- 호스트가 `ping_report` 로 해당 게스트에 ms 통지 (게스트 UI 표시용)
- `HostSession.onPingChanged(ReadonlyMap<peerId, ms>)` 콜백
- gameScreen 헤더에 배지: ⏳(측정 중) / 🟢(<60ms) / 🟡(<150ms) / 🔴(그 이상) / ⚠️(끊김)

### 이모지 리액션 (src/ui/reactions.ts)
- 버튼 6종: 👍 😂 🔥 👏 😭 🫢
- 클릭 시 `reaction` 메시지 broadcast → 모든 화면에 풍선 애니 (2.4s fade)
- 400ms throttle 스팸 방지
- 대기실 / 게임 화면 / (결과 화면) 어디서든 재사용

### URL 공유 입장 (main.ts, waitingRoom.ts, joinRoom.ts)
- 대기실에 "🔗 링크" 버튼 → 현재 URL 에 `?room=XXXXX` 붙여 복사
- 친구가 링크로 접속 시 main.ts 가 감지 → `createJoinRoomScreen('', { initialCode, autoJoin: true })` 자동 진입
- 닉네임 없으면 닉네임 입력 후 자동으로 join
- 새로고침 시 재입장 루프 방지를 위해 URL 에서 `room` 파라미터 즉시 제거

### 통계 화면 (statsScreen.ts + storage.GameStats)
- localStorage 에 게임별 plays/wins/losses/draws/lastPlayedAt + custom best record
- `storage.recordGameResult(gameId, winner, bestEntries)` — 결과 화면에서 호출
- best 는 자유 스키마: `{ key, value, higherIsBetter }` 배열. 게임마다 의미 다름 (사과 bestScore, 반응속도 bestMs 등)
- **머신별 독립** — 집/회사 PC 에서 기록 따로 쌓임

### 인게임 메뉴 모달 + 멀티 일시정지 (2026-04-25 추가)
- 게임 화면 우측 상단 ⚙️ 버튼 또는 **Esc 키** → 모달 토글
- 모달 내용: 마스터 볼륨 슬라이더 / BGM 토글 / SFX 토글 / "메뉴로 (방 나가기)"
- 모달 열림 → `pause` 메시지 broadcast (호스트가 다른 게스트에 relay) + 자기 `gameModule.setPaused(true)` 호출
- 다른 플레이어 화면: 반투명 dim overlay + `⏸️ {닉네임} 가 잠시 멈췄어요` 안내 + canvas 마우스 입력 차단
- 모달 닫힘 / "계속하기" → `resume` broadcast → 모두 정상 재개

### Firebase 공개방 디렉토리 (2026-05-15 추가)
- `src/core/firebase.config.ts` 에 Firebase 프로젝트 설정 (apiKey/databaseURL/projectId 등). 비워두면 공개방 기능이 **자동 비활성** — 비공개방(코드 입력) 흐름은 영향 X. 현재는 실제 프로젝트 값이 들어있음 (`hoax-mini-games`, Asia-Southeast1).
- `src/core/roomDirectory.ts`:
  - `publishRoom(entry)` — 호스트가 공개방 만들 때 등록 + `onDisconnect` 자동 제거 (좀비 방 방지).
  - `updatePublicRoom(roomId, partial)` — 인원 변동 / status 변화(`waiting` ↔ `playing`).
  - `unpublishRoom(roomId)` — 정상 종료 시 명시적 제거.
  - `subscribePublicRooms(cb)` — 실시간 리스트 구독. `createdAt` 내림차순 정렬.
- 메인 메뉴 "🌐 공개방 찾기" → `src/screens/publicRooms.ts` 화면 → 카드 클릭 시 `joinRoom` autoJoin 으로 즉시 입장.
- `waitingRoom.ts` 호스트 진입 시 `!isPrivate` 면 `publishRoom`, 인원 변동마다 `updatePublicRoom`, 게임 시작 시 status `playing`, 게임 끝나면 다시 `waiting` (또는 방 종료 시 `unpublishRoom`).

### 인게임 채팅 (2026-05-15 추가)
- `src/ui/chat.ts` — 우측 사이드 채팅 패널. 대기실 / 게임 화면 / (결과 화면) 어디서든 같은 패턴으로 박는다:
  1. `buildChatPanelHTML()` 결과를 screen el 끝에 박음
  2. `wireChatPanel(el, { onSend })` 로 입력 핸들러 연결 (Enter 송신, 250ms throttle, maxLen 200)
  3. 송신 시 자기 화면에 `appendChatMessage` 직접 호출 (네트워크 echo 없음)
  4. 수신 시에도 같은 `appendChatMessage`
- **네트워크 모델 (호스트 = 허브)**: 게스트가 보내면 host 에게만 송신 → 호스트가 자기 화면 append + 다른 게스트 relay. 호스트가 보내면 자기 화면 append + 전체 broadcast.
- **방 내부 history 유지**: `chat.ts` 모듈 레벨 배열에 누적, 화면 전환(대기실→게임→결과) 시 `restoreChatHistory` 로 자동 복원. 메인 메뉴 진입(=방 떠남)에서 `clearChatHistory` 로 초기화.
- 메시지 100개 cap, 시스템 메시지(입장/퇴장) 별도 스타일.

### `GameModule.setPaused(paused)` 선택 메서드 (게임별 정지)
인터페이스 (types.ts):
```ts
setPaused?(paused: boolean): void;
```
- 에어하키: stepPhysics + ah:state broadcast 정지
- 테트리스: engine.update + bt:state broadcast 정지, lastFrameTime 리셋
- 사과: 타이머 보정 (paused 동안 startedAt 더해줌)
- 오목: turnStartedAt + startedAt 보정
- 반응속도: 모든 setTimeout 정지, phase 별 재개 (waiting → 재시작 / go → waitStartedAt 보정 / result/foul → setTimeout 재시작)
- 다트: flight 진행 정지, 진행 중 windup 취소

---

## 🎨 디자인 규약

### 팔레트 (theme.css CSS 변수)
```css
--pink-50:  #fff5f8   --pink-300: #ffa8c7   --pink-500: #ff5a92
--pink-100: #ffe4ee   --pink-400: #ff82ac
--pink-200: #ffc9dd

--mint-100: #e0fff4   --mint-300: #86e8c4
--lavender-100: #f0e8ff   --lavender-300: #b89aff
--cream-100: #fff9e8   --cream-200: #ffeec2
--sky-100: #e0f2ff    --sky-300: #86c9ff
```

**하드코딩 색 금지, CSS 변수 우선.** Canvas 렌더는 hex 하드코드하되 같은 팔레트 범주.

### 캐릭터 색 (현재 확정)
- **호스트 말렛**: 민트 `#6ed9b3` / stroke `#2e8a70` / deep `#1f6a55`
- **게스트 말렛**: 노랑 `#ffd454` / stroke `#c49a1f` / deep `#8e6f10`
- **퍽**: 윗면 `#ff6b9e` / 옆면 `#c93d73`
- **사과**: fill `#ff8a9f` / stroke `#c04058` / 꼭지 `#8b5a2b` / 잎 `#86e8c4`
- **다트판**: 외곽 링 **검정(`#1c1820`)** + 스파이더 같은 톤. 내부 Single(cream/lavender 교차) · Double/Triple(pink/mint) · Bull(mint+pink) 은 파스텔 유지.
- **다트**: 팁 `#1c1820` 검정 / 배럴 `#6e5872` 짙은 라벤더 / 샤프트 `#fdf6ec` 크림 / 플라이트 `#b89aff` 라벤더 + `#ff82ac` 핑크

### SVG 썸네일 규약 (새 게임 추가 시 필수)
- `viewBox="0 0 320 200"`, 배경 `rx="22"`
- 배경 그라데이션: `#ffe4ee → #e0fff4` (대각선)
- 배경 데코: 네 모서리 점 4개 (핑크/민트/라벤더/크림)
- 별 path 데코 2개
- 중앙 주요 일러스트 + 주변 작은 보조 일러스트 비스듬히

### Canvas 렌더 규약
- devicePixelRatio 대응 (resize 시 `canvas.width = rect.width * dpr`)
- 논리 좌표 800×400 고정, ResizeObserver 리사이즈 대응
- 폰트: `'Pretendard', 'Apple SD Gothic Neo', 'Noto Sans KR', system-ui, sans-serif`
- **커서**: 기본 `.game-canvas { cursor: none }` (에어하키용). 마우스 쓰는 게임은 `canvas.style.cursor = 'crosshair'` 로 inline override.

---

## ⚠️ 과거 피드백 히스토리 (같은 실수 반복 방지)

### 디자인 — Henry가 반복 강조
1. **"젤리 느낌"** 금지. 말렛/퍽에 방사 그라데이션+반투명 광택 금지. **솔리드 단색 + 얇은 옆면 오프셋**.
2. **귀 제거** — 단순 원반 + 손잡이.
3. **"퍽 밝게"** — 와인색 X, 밝은 핫핑크.
4. **"과하게 귀여울 필요 X"** — 얼굴/표정/볼터치 안 씀.
5. **디자인 일관성** — 새 일러스트는 기존 썸네일 톤 따름.

### 게임플레이
- **에어하키 퍽 start 전 정지** + 카운트다운 없음.
- **골 직후 화면 멈춤 방지** → `gameEnded` 후에도 loop 유지, 파티클 fade-out.
- **말렛 중앙선 넘는 버그 수정** → 게스트 로컬 예측에서도 `constrainToMyHalf()`.
- **테트리스 탑아웃 버그 수정 (2026-04-23)** → `spawnPosition` y=-1. `collides`의 `row<0 허용`과 조합.
- **테트리스 소프트드롭은 좌우 이동보다 빠르게** → `SOFT_DROP_INTERVAL_MS=25` 별도 상수.
- **사과 게임 스포일러 전면 제거 (2026-04-24)** → 드래그 박스의 합 숫자 표시 X, 합 상태별 색 힌트 X (10/초과/미만 색 분기 폐기). 단일 연분홍.
- **사과 게임 실시간 점수 비공개 (2026-04-24)** → 게임 중엔 상대 점수 공유 X. 타이머 만료 시점에만 자기 최종 점수 한 번 송신, 호스트는 1초 grace period 후 랭킹.
- **사과 게임 초기 seed race condition (2026-04-24)** → 게스트가 gameScreen 진입 후 game.load() 중에 호스트의 첫 seed broadcast 를 놓침. 해결: 게스트 start 끝에 `ag:hello` 송신 → 호스트가 해당 peerId 에 target 으로 seed 재전송.
- **에어하키 stuck 자동 리셋 제거 (2026-04-25)** → 퍽이 3초 정지 시 중앙으로 자동 이동하는 규칙 폐지. "친구끼리 하는 게임이라 끼임 거의 없고, 일시정지/재개 시 누적 timer 가 트리거 돼 퍽이 튀는 버그 발생". `MIN_STUCK_SPEED` / `STUCK_FRAMES` / `state.stuckTimer` / `stuck_reset` 이벤트 / 관련 파티클 모두 삭제.
- **다트 관전자 hello 핸드셰이크 (2026-04-25)** → 게임 중 합류 관전자가 누적 게임 state(턴/점수/꽂힌 다트) 를 받도록. 게스트/관전자 start 끝에 `dart:hello` 송신 → 호스트가 `dart:sync({ game, stuckDarts })` 를 그 peerId 에 target 송신 → 수신 측이 game state 교체.

### UX
- **메인 메뉴 정렬** → `.menu-list`에 `margin: 0 auto`.
- **결과 화면 전환** → 게임 종료 후 900ms (1200ms에서 단축).
- **대기실 시작 조건** → `players.length >= minPlayers`.
- **사과 게임 보드 방향** → **17×10** (가로가 긴 배치). Cell 30px, APPLE_RADIUS 12.
- **사과 모양** → 원형 몸통 + 갈색 꼭지(줄기) + 민트 대각 잎. 그냥 원 + 숫자면 "사과 안 같다" 피드백.
- **Cursor 기본 `none`** → 에어하키용. 사과 게임은 `crosshair` inline override, destroy 에서 원복.

### 결과 화면
- **게임별 분기** (`summary.gameId` 마커):
  - 테트리스: stats 그리드 7개(라인/공격/수신/시간/콤보/테트리스/피스) + 다인 랭킹
  - 사과 게임: 내 점수 큰 카드 + 최종 랭킹 (닉+점수)
  - 오목 / 반응속도 / 다트: 각자 전용 HTML (상세는 resultScreen.ts)
  - 기본(에어하키): 2인 점수판
- **내 기준 stats 만 추적** — 다른 플레이어 stats 집계 안 함 (관전자 rankings 에 "나" 없으면 `isSpectator` 자동 인식).
- **통계 누적** — 결과 화면 진입 시 `storage.recordGameResult` 호출. 관전자는 기록 X.

### 사운드 (SFX)
- `sound.ts` Web Audio 합성. `SfxId` 타입에 게임별 SFX 추가.
- 테트리스 8종: rotate/lock/harddrop/hold/clear/tetris/garbage/topout.
- 사과 게임은 기존 SFX 재활용: 성공 `tetris_clear`, 종료 `tetris_topout`.
- **자주 울리는 액션(좌우 이동, 소프트드롭) 사운드 X** — 시끄러움 방지.

### 다트 UI 리디자인 (2026-04-25)
- **다트 모양** — 기존 "로켓 같음" 피드백 → **4단 구조(팁 + 배럴 + 샤프트 + 플라이트)**. 배럴에 grip 라인 3개 + 좌측 광택. 플라이트는 곡선(quadraticCurveTo) 라벤더/핑크.
- **다트판 외곽은 검정이 맞다** — 한 번 파스텔 라벤더로 바꿨다가 "다트판 답지 않다" 피드백으로 검정 복원. Single/Double/Triple 내부는 파스텔(크림/라벤더, pink/mint) 유지, **외곽 링 + 스파이더 구분선만 `#1c1820` 차콜 검정**. 다트 팁도 검정.
- **3다트 슬롯 kind별 배지** — Triple `T`+핑크 border, Double `D`+민트 border, Inner Bull `BULL`+핑크 채움, Outer Bull 연분홍, Miss 회색 `MISS`, 빈 슬롯 점선 라벤더+`·`. roundRect 둥근 모서리.
- **우측 점수판 카드형** — "MODE / Round" 라벨 → **헤더 카드**(라벤더, `🎯 모드명 · Round N/M` 한 줄). 현재 플레이어 핑크 카드(사과 게임 "내 점수" 카드와 통일) + "다른 플레이어" row 카드. 점선 구분선 제거, 카드 gap 12px 로 시각 분리.
- **보드 위치** — Canvas 수직 중앙 `BOARD_CY=200`, 수평 좌측 영역(0~PANEL_X) 중앙 `BOARD_CX=220`. 상하/좌우 여유 각 ~50px / 70px 대칭.
- **pickup 안내 문구** — canvas 내부 긴 텍스트 "클릭 → 아래로 당겼다가…" 제거. canvas 바깥 HTML `<div class="darts-hint">` pill 로 분리. 관전자는 숨김. `.game-canvas-wrap` 을 flex column 으로 전환(다른 게임은 canvas 하나라 영향 X).
- **썸네일** — 단순화된 단일 크림 원 → **20 세그먼트 파이 분할**(크림/라벤더 교차, 18° arc path 20개). 외곽 순검정(`#000000`) + 꽂힌 다트 in-game 과 같은 4단 구조. 숫자 라벨은 넣지 않음.

### 한글 UI 정돈 (2026-04-25)
사용자용 한글 문자열 전수 검토 → 어색·사무적·문법 이상 15곳 수정.

- **반응속도 (7건)**: `빨간 동안은 절대 누르지 마세요` → `빨간색일 때 누르면 실격이에요` (문법 정돈 + 이유 명시). `실격 처리` → `실격!`. `다음 라운드 자동 시작` → `다음 라운드 준비 중…`. `끝!` → `완료!`. `전부 실격` → `모두 실격`. `초록! 지금 빨리 클릭!` → `초록이에요! 지금 클릭!`. `잠깐… 다음 라운드 대기 중` → `다음 라운드 준비 중…`.
- **다트 (4건)**: `점수 원복` (사무 용어) → `턴 무효`. `총점 (낮을수록 ↑)` (의미 모호) → `총점 (낮을수록 유리)`. `전 타겟 close` → `모든 타겟 close`.
- **오목 (2건)**: `상대 시간초과` → `상대 시간 초과` (띄어쓰기 통일). `상대 포기` → `상대 기권` (바둑 용어).
- **사과 게임**: `우측 랭킹을 확인하세요` → `오른쪽 랭킹을 확인하세요` (한자어 → 고유어).
- **공통**: `게임을 나가시겠어요? 방에서 완전히 나가요.` → `게임을 나가면 방도 같이 나가요. 나가시겠어요?`. 줄임표 `...` → `…` (3곳: 패배/방 만드는 중/연결 중).

### 관전 모드 (Phase 2)
- **peer.ts**: `JoinDecision.asSpectator?`. `handleIncoming` 가득참 즉시 거절 방어 제거 — 방 로직이 결정.
- **수락 분기**: waitingRoom 상태면 `room_full`. gameScreen 상태면 spectator 수락.
- **Player.role='spectator'** + 헤더 "👀 관전 중" 배지.
- **ah:end 는 winner 뒤집힘** → 관전자는 ah:end 무시, 플랫폼 game_end 경로로.
- **테트리스 관전 뷰 v2 (2026-06-05)**: 캔버스 전체 2×2 격자. 4명까지 8px 셀 풀사이즈 미니 필드 + 닉네임 헤더 + 탑아웃 OUT 오버레이. 빈 슬롯 점선 placeholder. (v1 의 "관전 중" 카드 + 우측 mini → 격자로 교체)
  - `render.ts`: `SPEC_*` 상수, `drawSpectatorGrid` / `drawSpecPlayerSlot` / `drawSpecEmptySlot`
  - 플레이어 모드는 그대로 — `drawOpponents(opponents, false)` 호출
- **MVP 한계**: 게임 중 합류한 관전자만 최신 players. 기존 플레이어 ctx.players 미갱신.

### 오목 캐주얼 렌주룰 (2026-06-05)
- `gomoku/board.ts`. **흑(B)만** 3-3 (열린 3 2방향 이상) / 4-4 (4 라인 2방향 이상) 금수. 장목(6+)은 양쪽 금수. 5목 완성 수는 모든 금수보다 우선.
- 단순 판정 — "열린 3"의 재귀적 확장 가능성 안 봄. 캐주얼 수준.

### 사일런트 ReferenceError 사례 (2026-06-05)
- "다른 게임 선택" 버튼 무반응 — 클릭은 핸들러 도달했지만 `buildChangeGameOverlayHTML` 안의 `escapeAttr` 가 정의 안 됨 → `ReferenceError` → 오버레이 빌드 실패. UI 상 :active 만 보이고 그 뒤 아무 일도 안 일어남.
- **교훈**: 비슷한 "버튼 무반응" 신호 오면 콘솔 에러 우선 확인. `escapeHtml` / `escapeAttr` 같은 헬퍼가 파일마다 중복 정의되어 있어 누락하기 쉬움.

### 대규모 버그 스윕 + 물리 재작업에서 얻은 교훈 (2026-07-15)
- **`getNextTurn` 의 `indexOf(-1)` 패턴 = 턴 스킵 버그** — 현재 턴 플레이어가 죽으면 `alive.indexOf(currentTurn)` 이 -1 → `nextPos=0` 으로 최저 인덱스 점프, 뒤 사람 건너뜀. **좌석 위치 다음부터 스캔**으로 고침(알까기·끝말잇기 둘 다 있었음). 새 턴제 게임 짤 때 주의.
- **프레임레이트 의존 물리 → 고정 스텝 누적기** — RAF 프레임당 1스텝 + 고정 dt 로 시뮬하면 고주사율(144Hz) 기기에서 게임이 몇 배 빨라짐. `accum += 실경과; while(accum>=STEP){ step(STEP); accum-=STEP }` + 상한(0.25s). 포트리스는 여기에 **구간별 해석식**까지(호/게 궤적 완전 동일). 에어하키도 같은 패턴 적용.
- **`setPaused` 에서 `lastFrameTime` 이중보정 금지** — 루프가 정지 중에도 매 프레임 `lastFrameTime=now` 로 갱신하면, setPaused 에서 또 정지시간을 더하면 미래값 → 누적기 음수 → 재개 후 물리가 멈춤. "정지 중 갱신 안 되는 절대 기준시각"만 보정.
- **원격 필드는 신뢰 X** — `reaction.emoji` 가 escape 없이 innerHTML 로 들어가 XSS. 화이트리스트 + escape. 게임 메시지의 자칭 `from`/좌표도 방어 대상(Tier-2 로 남김).
- **호스트 relay 는 no-target 메시지를 다른 게스트에 뿌림** — 실시간 노출 원치 않는 데이터(스토리텔링 그림 진행)는 `sendToPeer(msg, { target: 호스트peerId })` 로 호스트에게만.
- **모듈 start() 전 도착 메시지 유실** — gameScreen 이 onMessage 를 모듈 로드/시작 전에 배선 → 초기 hello 가 조용히 버려져 게스트 멈춤. **start 전 game_msg 버퍼링 후 flush**로 해결.

### 네트워크 모듈 분리 리팩토링 (2026-04-28 ~ 05-09)
- 다트/반응속도 게임의 `encodeXxx`/`decodeXxx` 함수들을 별도 `netSync.ts` 파일로 추출.
  - `darts/netSync.ts`: hello/sync/throw/end 4종.
  - `reflex/netSync.ts`: round_done/player_done/phase/end 4종. `rx:phase` 신규 (상대 미니뷰 라이브 표시용).
- 각 게임 `index.ts` 는 이제 메시지 로직 없이 import 만. 큰 게임에 메시지 종류가 늘어날 때 깔끔.

---

## 🧑‍🤝‍🧑 협업 스타일 (Henry 선호)

1. **한국어 대화**, 존댓말 없이 친근하게.
2. **파일 단위 리뷰** — 큰 변경은 한 파일씩.
3. **의존성 추가 전 먼저 물어보기**. PeerJS 외엔 최소화.
4. **큰 리팩토링은 Plan A/B 제시 후 선택**.
5. **주석은 한국어**. 복잡한 로직(물리/SRS/네트워크 동기화)은 "왜 이렇게 짰는지" 강조.
6. **TypeScript 낯섦** — `any` 남용 금지, 친절히 설명.
7. **Stale IDE diagnostics 흔함** — Grep 으로 실제 상태 확인.

---

## 🐛 알려진 이슈 / 개선 여지

- **재연결 유예 있음(2026-07-17)** — 순간 끊김(≤ 게스트 9s/호스트 12s)은 자동 복구(오버레이 표시). 그보다 긴 끊김·탭 닫음은 여전히 방 이탈로 처리.
- **디스커넥트 시 N인 방 종료 (미해결, 다음 작업 🅒)** — 진짜 이탈 시 플레이어 1명 나가면 방 전체가 종료. N인 게임에선 남은 사람으로 계속돼야 함. 게임별 `onPlayerLeft` 처리 필요 — 규모 큼.
- **Phase 3 (방장 이양) 미구현 — 보류** — 방장 나가면 방 종료 (+ Firebase entry 도 onDisconnect 로 자동 제거). 순간 끊김은 재연결 유예로 완화됨. Henry 당분간 진행 의향 없음.
- **일시정지 키보드 입력 차단 안 됨** — pause overlay 가 canvas 위에 올라가서 마우스는 차단되지만, 게임 모듈이 `window` 레벨로 keydown 을 listen 하면 키 입력은 그대로 전달. 다만 각 게임 `setPaused(true)` 시 `performKey`/`onCanvasClick` 등에 paused 가드 추가돼서 실질 동작은 안 함.
- **에어하키 관전자 비주얼** — 점수판 대신 "관전 중" 배지만. (테트리스는 v2 격자로 해결, 다른 게임은 그대로)
- **사과 게임 솔버블 보장 X** — 단순 랜덤이라 운 나쁘면 덜 풀림.
- **사과 게임 관전자 뷰** — 보드 영역 전체 "관전 중" 오버레이. 어떤 플레이어 보드 보여주기 같은 개선 여지 있음.
- **통계 화면 머신별 독립** — localStorage 기반이라 집/회사 PC 에서 기록 따로 쌓임. 의도된 동작.
- **Firebase 키 노출** — `firebase.config.ts` 에 실제 apiKey 평문. repo public 이라 Firebase 콘솔의 Rules(publicRooms 노드만 read/write 제한) 가 유일한 방어선.
- **Windows 라인엔딩** — git LF→CRLF 경고. 무해.

---

## ✅ 빌드 / 배포

- **로컬 테스트**: `npm run dev` → http://localhost:5173.
  - 일반 창 + 시크릿 창 + (필요 시) 다른 브라우저. 4인은 창 4개.
  - **Cursor Simple Browser 는 WebRTC iframe 제약으로 P2P 불안정** → 실제 브라우저 쓰기.
- **빌드 확인**: `npm run build` → `dist/` 생성.
- **배포**: main/master push → GitHub Actions 자동 배포 → 1~2분 후 반영.
- **브라우저 캐시 주의**: 배포 직후 Ctrl+Shift+R.

---

## 📮 GitHub

- 저장소: https://github.com/Hoax0606/hoax-mini-games
- 기본 브랜치: `master`
- 배포 workflow: `.github/workflows/deploy.yml`

---

세부 디자인 원칙은 `CLAUDE.md` 도 참고 (프로젝트 열면 Claude Code 자동 로드).
