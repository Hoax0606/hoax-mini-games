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
import liarGameThumbnail from './liar-game/thumbnail.svg';
import ramenShopThumbnail from './ramen-shop/thumbnail.svg';
import bombWordChainThumbnail from './bomb-wordchain/thumbnail.svg';
import storyDrawThumbnail from './story-draw/thumbnail.svg';

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
        {
          key: 'weaponMode',
          label: '무기',
          type: 'select',
          choices: [
            { value: 'random', label: '랜덤 (특수 3종 무작위 배분)' },
            { value: 'all', label: '전체 (모든 무기 사용)' },
          ],
          defaultValue: 'random',
        },
      ],
    },
    load: async () => {
      const mod = await import('./fortress');
      return mod.createFortressGame();
    },
  },
  {
    meta: {
      id: 'liar-game',
      name: '라이어 게임',
      description: '한 명은 제시어를 모르는 라이어! 돌아가며 제시어를 설명하고, 누가 라이어인지 투표로 찾아라. 5라운드 누적 점수 승부.',
      thumbnail: liarGameThumbnail,
      minPlayers: 3,
      maxPlayers: 8,
      roomOptions: [
        {
          key: 'mode',
          label: '모드',
          type: 'select',
          choices: [
            { value: 'normal', label: '일반 (라이어는 제시어만 모름)' },
            { value: 'fool', label: '바보 (라이어도 자기가 라이어인 줄 모름)' },
          ],
          defaultValue: 'normal',
        },
      ],
    },
    load: async () => {
      const mod = await import('./liar-game');
      return mod.createLiarGame();
    },
  },
  {
    meta: {
      id: 'story-draw',
      name: '스토리텔링',
      description: '각자 제시어로 그림을 그리고, 직전 그림을 이어받아 계속 그린다! 모두가 동시에 그려서 쉬는 사람 없음. 마지막에 이야기가 어떻게 변했는지 슬라이드쇼로 감상 (승패 없음).',
      thumbnail: storyDrawThumbnail,
      minPlayers: 3,
      maxPlayers: 6,
      roomOptions: [
        {
          key: 'storyLength',
          label: '이야기 길이',
          type: 'select',
          choices: [
            { value: 'short', label: '짧게 (1바퀴)' },
            { value: 'long', label: '길게 (2바퀴)' },
          ],
          defaultValue: 'short',
        },
        {
          key: 'drawSeconds',
          label: '컷당 시간',
          type: 'select',
          choices: [
            { value: '60', label: '60초' },
            { value: '120', label: '120초' },
          ],
          defaultValue: '60',
        },
      ],
    },
    load: async () => {
      const mod = await import('./story-draw');
      return mod.createStoryDrawGame();
    },
  },
  {
    meta: {
      id: 'ramen-shop',
      name: '라면가게',
      description: '손님이 주문한 토핑 라면을 물 붓고 끓여 서빙! 인내심 다 되기 전에 빨리 정확히 내주면 팁↑. 영업 종료 시 매출 1등이 승리.',
      thumbnail: ramenShopThumbnail,
      minPlayers: 1,
      maxPlayers: 6,
      roomOptions: [
        {
          key: 'duration',
          label: '영업시간',
          type: 'select',
          choices: [
            { value: '120', label: '짧게 · 2분' },
            { value: '180', label: '보통 · 3분' },
            { value: '240', label: '길게 · 4분' },
          ],
          defaultValue: '180',
        },
      ],
    },
    load: async () => {
      const mod = await import('./ramen-shop');
      return mod.createRamenShopGame();
    },
  },
  {
    meta: {
      id: 'bomb-wordchain',
      name: '폭탄 끝말잇기',
      description: '숨겨진 폭탄이 30초~3분 사이 언제 터질지 몰라요! 랜덤으로 시작해 끝말잇기로 폭탄을 넘기고, 터질 때 들고 있는 사람이 패배.',
      thumbnail: bombWordChainThumbnail,
      minPlayers: 2,
      maxPlayers: 6,
      roomOptions: [],
    },
    load: async () => {
      const mod = await import('./bomb-wordchain');
      return mod.createBombWordChainGame();
    },
  },
];

/** 게임 ID로 레지스트리 엔트리 조회 (없으면 undefined) */
export function getGameById(id: string): GameEntry | undefined {
  return games.find((g) => g.meta.id === id);
}
