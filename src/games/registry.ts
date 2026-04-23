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
import battleTetrisThumbnail from './battle-tetris/thumbnail.svg';
import appleGameThumbnail from './apple-game/thumbnail.svg';

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
    load: async () => {
      const mod = await import('./air-hockey');
      return mod.createAirHockeyGame();
    },
  },
  {
    meta: {
      id: 'battle-tetris',
      name: '배틀 테트리스',
      description: '떨어지는 블록으로 라인을 지우고 공격을 보내 상대를 밀어내라! 마지막까지 살아남으면 승리.',
      thumbnail: battleTetrisThumbnail,
      minPlayers: 2,
      maxPlayers: 4,
      roomOptions: [
        {
          key: 'garbageStrength',
          label: '공격 강도',
          type: 'select',
          choices: [
            { value: 'weak', label: '약 · 슬슬' },
            { value: 'normal', label: '보통' },
            { value: 'strong', label: '강 · 치열하게' },
          ],
          defaultValue: 'normal',
        },
        {
          key: 'speed',
          label: '낙하 속도',
          type: 'select',
          choices: [
            { value: 'slow', label: '느림' },
            { value: 'normal', label: '보통' },
            { value: 'fast', label: '빠름' },
          ],
          defaultValue: 'normal',
        },
      ],
    },
    load: async () => {
      const mod = await import('./battle-tetris');
      return mod.createBattleTetrisGame();
    },
  },
  {
    meta: {
      id: 'apple-game',
      name: '사과 게임',
      description: '숫자 사과를 드래그로 묶어 합이 10이 되면 터트려! 2분 안에 최대한 많이 터트리면 승리.',
      thumbnail: appleGameThumbnail,
      minPlayers: 1,
      maxPlayers: 4,
      roomOptions: [],
    },
    load: async () => {
      const mod = await import('./apple-game');
      return mod.createAppleGame();
    },
  },
];

/** 게임 ID로 레지스트리 엔트리 조회 (없으면 undefined) */
export function getGameById(id: string): GameEntry | undefined {
  return games.find((g) => g.meta.id === id);
}
