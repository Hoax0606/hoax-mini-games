# 포트리스 무기 시스템 설계 (슬라이스 3)

작성일: 2026-07-13
대상: `src/games/fortress/`

## 목표

단일 포탄뿐이던 포트리스에 **무기 종류**를 추가한다. 각 플레이어는
**일반탄(무제한)** 을 기본으로 갖고, 게임 시작 시 **특수 무기 6종 중 랜덤 2종**을
제한 탄약으로 배분받는다. 무기마다 폭발/궤적 특성이 달라 전략성을 준다.

## 무기 정의

`normal` 은 공용 기본(무제한). 나머지 6종이 랜덤 배분 대상(특수 풀).

| id | 이름 | 궤적/폭발 특성 | 폭발반경 | 최대뎀 | 크레이터 |
|---|---|---|---|---|---|
| `normal` | 일반탄 | 지금과 동일 (기본 포물선) | 62 | 52 | 34 |
| `big` | 대형탄 | 크고 강한 폭발 | 90 | 75 | 50 |
| `split` | 분열탄 | **정점에서 3갈래 분열**, 각 파편 작은 폭발 | 42 | 32 | 24 |
| `guided` | 유도탄 | **바람 영향 무시** (예측 쉬움), 폭발은 일반급 | 62 | 52 | 34 |
| `bombard` | 폭격탄 | **지형 크게 파임**, 데미지는 보통 | 55 | 40 | 60 |
| `grenade` | 수류탄 | **지형에 튕기며 굴러가다** 멈추면 폭발 | 55 | 45 | 30 |
| `timed` | 시한폭탄 | 발사 후 **2.5초 뒤 폭발** (공중/지면 무관) | 70 | 55 | 38 |

특성별 구현 분류:
- **단순형(단일 포탄, 파라미터만 다름)**: `normal` `big` `guided` `bombard`
  - `guided` 는 발사 시 바람=0 으로 시뮬. 나머지는 blast 파라미터만 교체.
- **복합형(궤적/폭발 로직 추가)**: `split` `grenade` `timed`
  - `split`: 정점(vy 가 위→아래로 바뀌는 순간) 도달 시 현재 속도에서 ±15° 벌린
    3개 파편 생성. 각 파편은 일반 궤적으로 날아가 착탄 시 작은 폭발.
  - `grenade`: 지형/포대에 닿으면 즉시 폭발하지 않고 **반사(감쇠 0.55)**. 최대 3회
    튕기거나 속도가 임계 이하로 떨어지면 그 자리에서 폭발.
  - `timed`: 발사 순간부터 2.5초 fuse. 시간 되면 현재 위치에서 폭발
    (공중이면 공중 폭발). 그 전에 지형 밖으로 크게 이탈하면 소멸(빗나감).

## 탄약 / 로드아웃

- 각 플레이어: `normal` 무제한 + 특수 6종 중 **랜덤 2종**, 각 **2발**.
- **플레이어 단위** 탄약 (한 명이 포대 여러 개여도 탄약 공유).
- 배분은 **호스트가 결정** 후 게임 상태(`FortressGame`)에 담아 `fr:sync` 로 전파.
  게스트는 sync 받은 로드아웃을 그대로 사용(별도 난수 동기화 불필요).

## 상태 모델 변경 (`rules.ts`)

```ts
export type WeaponId = 'normal' | 'big' | 'split' | 'guided' | 'bombard' | 'grenade' | 'timed';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  icon: string;          // 이모지
  blastRadius: number;
  maxDamage: number;
  craterRadius: number;
  ignoreWind?: boolean;  // guided
  kind: 'normal' | 'big' | 'split' | 'guided' | 'bombard' | 'grenade' | 'timed';
}

// FortressGame 에 추가:
//   ammo: Record<string, Partial<Record<WeaponId, number>>>  // peerId → 특수무기 → 남은 발수
//   (normal 은 키 없음 = 무제한)
```

- `WEAPONS: Record<WeaponId, WeaponSpec>` 상수 테이블.
- `assignLoadouts(players, seed)`: 각 플레이어에 특수 2종 랜덤 배분 → `ammo` 초기화.
  (seed 기반이면 좋지만, 호스트가 만들어 sync 하므로 `Math.random` 이어도 동기화됨)

## 네트워크 변경 (`netSync.ts`)

- `fr:fire` 페이로드에 `weapon: WeaponId` 추가.
- `fr:impact` 는 **여러 폭발**을 담을 수 있게 확장 (분열탄 대응):
  `blasts: { cx: number; cy: number; craterR: number }[]` + 최종 `hp` 맵 + `nextTurn`/`nextWind`.
  단일 폭발 무기는 `blasts` 길이 1.
- 탄약 동기화: 각 클라가 `fr:fire` 수신(재생) 시 해당 플레이어 탄약 로컬 차감
  (결정론적). 호스트는 발사 검증 시 탄약도 확인.

## 발사/시뮬 흐름 (`index.ts`)

- **선택 상태**: `selectedWeapon: WeaponId` (기본 `normal`). 내 차례에 무기 바에서 선택.
- **발사(onUp)**: 현재 `selectedWeapon` 으로 `beginProjectile` + `fr:fire(weapon)`.
  탄약 0 인 무기는 UI 에서 선택 불가라 방어적으로만 체크.
- **projectile 확장**: 단일 → 배열 `projectiles: Projectile[]` (분열 대응). 각 항목에
  `weapon`, `bounces`(수류탄), `fuseStart`(시한) 필드.
- **착탄 판정(호스트)**: 무기별 분기.
  - 단순형/유도: 기존 로직 + blast 파라미터 교체 (+ guided 는 wind 0).
  - split: 정점에서 파편 3개로 치환, 각 착탄 모아 `blasts[]` 로 한 번에 확정.
  - grenade: 반사 누적, 폭발 조건 충족 시 확정.
  - timed: fuse 경과 시 확정.
- 게임 종료/턴 넘김은 기존과 동일 (모든 폭발 처리 후 `advanceTurn`).

## UI (`index.ts` + `render.ts` + `theme.css`)

- canvas 아래 HTML **무기 바**: 내 로드아웃(일반탄 + 특수 2종) 버튼.
  아이콘 + 이름 + 남은 탄약(∞/×N). 선택된 것 핑크 테두리, 탄약 0 흐리게+비활성.
  내 차례 아닐 땐 전체 비활성. `word-chain` 입력 UI 처럼 canvas 부모에 마운트.
- 포탄 렌더는 무기별 색/모양 약간 다르게(선택) — 최소 구현은 색만 구분.

## 구현 단계 (2단계로 나눔)

- **3a — 프레임워크 + 단순 무기**: WeaponSpec/ammo/로드아웃, 무기 바 UI,
  `fr:fire` weapon 필드, `fr:impact` blasts[] 확장, `normal/big/guided/bombard` 4종.
  (단일 포탄이라 위험 낮음. 여기까지 플레이 가능.)
- **3b — 복합 무기**: `split` `grenade` `timed`. projectiles[] 배열화 + 무기별 궤적 로직.
  랜덤 풀을 6종 전체로 확장.

## 비목표 (이번 슬라이스 제외)

- 포대 이동(슬라이스 4).
- 무기별 정교한 SFX/파티클 (기존 사운드 재활용).
- 탄약 획득/보급 (고정 배분).
