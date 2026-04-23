/**
 * 게임 레지스트리
 *
 * 새 게임 추가 방법:
 *   1. `src/games/<game-id>/` 폴더 만들고 GameModule 구현 (3단계 에어하키 참고)
 *   2. 썸네일 SVG를 같은 폴더에 넣기
 *   3. 아래 `games` 배열에 엔트리 한 개 추가
 *
 * 끝. 다른 파일 건드릴 필요 없음.
 */

import type { GameEntry } from './types';
import airHockeyThumbnail from './air-hockey/thumbnail.svg';

export const games: GameEntry[] = [
  {
    meta: {
      id: 'air-hockey',
      name: '에어하키',
      description: '퍽을 튕겨서 상대 골대에 넣어라! 먼저 정해진 점수에 도달하는 쪽이 승리.',
      thumbnail: airHockeyThumbnail,
      minPlayers: 2,
      maxPlayers: 2,
      roomOptions: [
        {
          key: 'winScore',
          label: '승리 점수',
          type: 'select',
          choices: [
            { value: '5', label: '짧게 · 5점' },
            { value: '7', label: '보통 · 7점' },
            { value: '11', label: '길게 · 11점' },
          ],
          defaultValue: '7',
        },
      ],
    },
    // 실제 게임 모듈을 lazy import로 로드 (게임 시작 버튼 눌렀을 때만)
    load: async () => {
      const mod = await import('./air-hockey');
      return mod.createAirHockeyGame();
    },
  },
];

/** 게임 ID로 레지스트리 엔트리 조회 (없으면 undefined) */
export function getGameById(id: string): GameEntry | undefined {
  return games.find((g) => g.meta.id === id);
}
