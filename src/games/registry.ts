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
import gomokuThumbnail from './gomoku/thumbnail.svg';
import reflexThumbnail from './reflex/thumbnail.svg';
import dartsThumbnail from './darts/thumbnail.svg';
import algagiThumbnail from './algagi/thumbnail.svg';
import wordChainThumbnail from './word-chain/thumbnail.svg';
import drawQuizThumbnail from './draw-quiz/thumbnail.svg';
import fortressThumbnail from './fortress/thumbnail.svg';

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
      maxPlayers: 6,
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
      maxPlayers: 6,
      roomOptions: [],
    },
    load: async () => {
      const mod = await import('./apple-game');
      return mod.createAppleGame();
    },
  },
  {
    meta: {
      id: 'gomoku',
      name: '오목',
      description: '교차점에 돌을 놓아 가로·세로·대각선으로 정확히 5목을 먼저 완성하면 승리. 한 턴당 30초 제한.',
      thumbnail: gomokuThumbnail,
      minPlayers: 2,
      maxPlayers: 2,
      roomOptions: [
        {
          key: 'boardSize',
          label: '보드 크기',
          type: 'select',
          choices: [
            { value: '15', label: '15 × 15 · 표준' },
            { value: '19', label: '19 × 19 · 바둑판' },
          ],
          defaultValue: '15',
        },
      ],
    },
    load: async () => {
      const mod = await import('./gomoku');
      return mod.createGomokuGame();
    },
  },
  {
    meta: {
      id: 'darts',
      name: '다트',
      description: '드래그로 조준하고 놓는 순간 날아간다! 101/201/301, Count-up, Low Count-up, Cricket.',
      thumbnail: dartsThumbnail,
      minPlayers: 1,
      maxPlayers: 6,
      roomOptions: [
        {
          key: 'mode',
          label: '모드',
          type: 'select',
          choices: [
            { value: '301', label: '301' },
            { value: '201', label: '201' },
            { value: '101', label: '101' },
            { value: 'countup', label: 'Count-up · 높은 점수 승' },
            { value: 'low-countup', label: 'Low Count-up · 낮은 점수 승' },
            { value: 'cricket', label: 'Cricket' },
          ],
          defaultValue: '301',
        },
        {
          key: 'x01Variant',
          label: 'X01 난이도',
          type: 'select',
          choices: [
            { value: 'normal', label: 'Normal · 0 맞추면 승' },
            { value: 'hard', label: 'Hard · Double 로 0 맞춰야 승' },
          ],
          defaultValue: 'normal',
        },
      ],
    },
    load: async () => {
      const mod = await import('./darts');
      return mod.createDartsGame();
    },
  },
  {
    meta: {
      id: 'reflex',
      name: '반응속도',
      description: '빨강이 초록으로 바뀌는 순간을 가장 빨리 잡아라! 5라운드 평균으로 승부.',
      thumbnail: reflexThumbnail,
      minPlayers: 1,
      maxPlayers: 6,
      roomOptions: [],
    },
    load: async () => {
      const mod = await import('./reflex');
      return mod.createReflexGame();
    },
  },
  {
    meta: {
      id: 'algagi',
      name: '알까기',
      description: '자기 알을 드래그해서 튕겨라! 상대 알을 모두 판 밖으로 떨어뜨리는 사람이 승리.',
      thumbnail: algagiThumbnail,
      minPlayers: 2,
      maxPlayers: 4,
      roomOptions: [],
    },
    load: async () => {
      const mod = await import('./algagi');
      return mod.createAlgagiGame();
    },
  },
  {
    meta: {
      id: 'word-chain',
      name: '끝말잇기',
      description: '이전 단어의 마지막 글자로 시작하는 단어를 입력! 30초 안에 못 내면 탈락. 최후 1인 승.',
      thumbnail: wordChainThumbnail,
      minPlayers: 2,
      maxPlayers: 6,
      roomOptions: [],
    },
    load: async () => {
      const mod = await import('./word-chain');
      return mod.createWordChainGame();
    },
  },
  {
    meta: {
      id: 'draw-quiz',
      name: '그림 퀴즈',
      description: '돌아가며 제시어를 그리고, 나머지는 채팅으로 맞혀라! 빨리 맞힐수록 높은 점수.',
      thumbnail: drawQuizThumbnail,
      minPlayers: 3,
      maxPlayers: 6,
      roomOptions: [],
    },
    load: async () => {
      const mod = await import('./draw-quiz');
      return mod.createDrawQuizGame();
    },
  },
  {
    meta: {
      id: 'fortress',
      name: '포트리스',
      description: '각도와 세기를 조준해 포탄 발사! 바람을 읽고 지형을 무너뜨려 상대 포대를 맞혀라. 최후 생존 승리.',
      thumbnail: fortressThumbnail,
      minPlayers: 2,
      maxPlayers: 6,
      roomOptions: [
        {
          key: 'fortsPerPlayer',
          label: '1인당 포대 수',
          type: 'select',
          choices: [
            { value: '1', label: '1개' },
            { value: '2', label: '2개' },
            { value: '3', label: '3개' },
          ],
          defaultValue: '1',
        },
      ],
    },
    load: async () => {
      const mod = await import('./fortress');
      return mod.createFortressGame();
    },
  },
];

/** 게임 ID로 레지스트리 엔트리 조회 (없으면 undefined) */
export function getGameById(id: string): GameEntry | undefined {
  return games.find((g) => g.meta.id === id);
}
