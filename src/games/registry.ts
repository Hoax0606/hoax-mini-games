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
import dodgeThumbnail from './dodge/thumbnail.svg';
import oneCardThumbnail from './onecard/thumbnail.svg';
import blueMarbleThumbnail from './blue-marble/thumbnail.svg';
import werewolfThumbnail from './werewolf/thumbnail.svg';
import avalonThumbnail from './avalon/thumbnail.svg';
import fakeArtistThumbnail from './fake-artist/thumbnail.svg';
import kordleThumbnail from './kordle/thumbnail.svg';
import callMyNameThumbnail from './call-my-name/thumbnail.svg';
import rummikubThumbnail from './rummikub/thumbnail.svg';
import codenamesThumbnail from './codenames/thumbnail.svg';
import krakenThumbnail from './kraken/thumbnail.svg';
import subwayTypingThumbnail from './subway-typing/thumbnail.svg';
import theMindThumbnail from './the-mind/thumbnail.svg';
import davinciCodeThumbnail from './davinci-code/thumbnail.svg';
import spaceCrewThumbnail from './space-crew/thumbnail.svg';

export const games: GameEntry[] = [
  {
    meta: {
      id: 'air-hockey',
      categories: ['순발력'],
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
      categories: ['순발력', '두뇌'],
      name: '배틀 테트리스',
      description: '떨어지는 블록으로 라인을 지우고 공격을 보내 상대를 밀어내라! 마지막까지 살아남으면 승리.',
      thumbnail: battleTetrisThumbnail,
      minPlayers: 2,
      maxPlayers: 10,
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
      categories: ['순발력', '두뇌'],
      name: '사과 게임',
      description: '숫자 사과를 드래그로 묶어 합이 10이 되면 터트려! 2분 안에 최대한 많이 터트리면 승리.',
      thumbnail: appleGameThumbnail,
      minPlayers: 1,
      maxPlayers: 10,
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
      categories: ['보드게임', '두뇌'],
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
      categories: ['순발력'],
      name: '다트',
      description: '드래그로 조준하고 놓는 순간 날아간다! 101/201/301, Count-up, Low Count-up, Cricket.',
      thumbnail: dartsThumbnail,
      minPlayers: 1,
      maxPlayers: 10,
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
      categories: ['순발력'],
      name: '반응속도',
      description: '빨강이 초록으로 바뀌는 순간을 가장 빨리 잡아라! 5라운드 평균으로 승부.',
      thumbnail: reflexThumbnail,
      minPlayers: 1,
      maxPlayers: 10,
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
      categories: ['보드게임', '순발력'],
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
      categories: ['단어'],
      name: '끝말잇기',
      description: '이전 단어의 마지막 글자로 시작하는 단어를 입력! 30초 안에 못 내면 탈락. 최후 1인 승.',
      thumbnail: wordChainThumbnail,
      minPlayers: 2,
      maxPlayers: 10,
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
      categories: ['그림', '단어'],
      name: '그림 퀴즈',
      description: '돌아가며 제시어를 그리고, 나머지는 채팅으로 맞혀라! 빨리 맞힐수록 높은 점수.',
      thumbnail: drawQuizThumbnail,
      minPlayers: 3,
      maxPlayers: 10,
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
      categories: ['순발력', '두뇌'],
      name: '포트리스',
      description: '각도와 세기를 조준해 포탄 발사! 바람을 읽고 지형을 무너뜨려 상대 포대를 맞혀라. 최후 생존 승리.',
      thumbnail: fortressThumbnail,
      minPlayers: 2,
      maxPlayers: 10,
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
      categories: ['추리'],
      name: '라이어 게임',
      description: '한 명은 제시어를 모르는 라이어! 돌아가며 제시어를 설명하고, 누가 라이어인지 투표로 찾아라. 5라운드 누적 점수 승부.',
      thumbnail: liarGameThumbnail,
      minPlayers: 3,
      maxPlayers: 10,
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
      categories: ['그림'],
      name: '스토리텔링',
      description: '각자 제시어로 그림을 그리고, 직전 그림을 이어받아 계속 그린다! 모두가 동시에 그려서 쉬는 사람 없음. 마지막에 이야기가 어떻게 변했는지 슬라이드쇼로 감상 (승패 없음).',
      thumbnail: storyDrawThumbnail,
      minPlayers: 3,
      maxPlayers: 10,
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
            { value: '120', label: '120초' },
            { value: '180', label: '180초' },
          ],
          defaultValue: '120',
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
      categories: ['순발력', '두뇌'],
      name: '라면가게',
      description: '손님이 주문한 토핑 라면을 물 붓고 끓여 서빙! 인내심 다 되기 전에 빨리 정확히 내주면 팁↑. 영업 종료 시 매출 1등이 승리.',
      thumbnail: ramenShopThumbnail,
      minPlayers: 1,
      maxPlayers: 10,
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
      categories: ['단어', '순발력'],
      name: '폭탄 끝말잇기',
      description: '숨겨진 폭탄이 30초~3분 사이 언제 터질지 몰라요! 랜덤으로 시작해 끝말잇기로 폭탄을 넘기고, 터질 때 들고 있는 사람이 패배.',
      thumbnail: bombWordChainThumbnail,
      minPlayers: 2,
      maxPlayers: 10,
      roomOptions: [],
    },
    load: async () => {
      const mod = await import('./bomb-wordchain');
      return mod.createBombWordChainGame();
    },
  },
  {
    meta: {
      id: 'dodge',
      categories: ['순발력'],
      name: '똥 피하기',
      description: '위에서 쏟아지는 💩를 피해라! 좌우로 움직이고 Space로 짧게 대시(쿨다운). 오래 버틸수록 고순위, 마지막 생존자 승. 낙하 패턴은 전원 동일(공정) 또는 각자 랜덤 선택.',
      thumbnail: dodgeThumbnail,
      minPlayers: 1,
      maxPlayers: 10,
      roomOptions: [
        {
          key: 'pattern',
          label: '낙하 패턴',
          type: 'select',
          choices: [
            { value: 'same', label: '동일 (전원 같은 패턴·공정)' },
            { value: 'random', label: '랜덤 (각자 다른 패턴)' },
          ],
          defaultValue: 'same',
        },
      ],
    },
    load: async () => {
      const mod = await import('./dodge');
      return mod.createDodgeGame();
    },
  },
  {
    meta: {
      id: 'onecard',
      categories: ['보드게임'],
      name: '원카드',
      description: '색·숫자·기호를 맞춰 카드를 내고, 건너뛰기·방향바꾸기·+2·색바꾸기로 서로 방해! 손패를 먼저 다 비우면 순위 확정, 최후 1명이 꼴등.',
      thumbnail: oneCardThumbnail,
      minPlayers: 2,
      maxPlayers: 8,
      roomOptions: [],
    },
    load: async () => {
      const mod = await import('./onecard');
      return mod.createOneCardGame();
    },
  },
  {
    meta: {
      id: 'blue-marble',
      categories: ['보드게임', '두뇌'],
      name: '브루마블',
      description: '주사위를 굴려 세계를 돌며 도시를 사고 건물을 지어요. 별장·2층집·아파트를 골라 짓고, 3개 다 지으면 랜드마크까지! 섬은 인수 불가, 여러 개일수록 통행료가 오르죠. 통행료로 상대를 파산시키면 승리.',
      thumbnail: blueMarbleThumbnail,
      minPlayers: 2,
      maxPlayers: 4,
      roomOptions: [],
    },
    load: async () => {
      const mod = await import('./blue-marble');
      return mod.createBlueMarbleGame();
    },
  },
  {
    meta: {
      id: 'werewolf',
      categories: ['추리'],
      name: '한밤의 늑대인간',
      description: '단 한 번의 밤과 낮으로 끝나는 빠른 추리 게임! 밤에 예언자·강도·말썽쟁이가 몰래 움직여 역할 카드가 뒤바뀌어요. 낮 토론으로 늑대를 추리하고 투표로 처형 — 처형자 중 늑대가 있으면 시민 승, 없으면 늑대 승.',
      thumbnail: werewolfThumbnail,
      minPlayers: 3,
      maxPlayers: 10,
      roomOptions: [
        {
          key: 'mode',
          label: '직업 구성',
          type: 'select',
          choices: [
            { value: 'normal', label: '일반 · 인원별 공식 조합' },
            { value: 'free', label: '랜덤 · 방장이 직접 선택' },
          ],
          defaultValue: 'normal',
        },
        {
          key: 'discuss',
          label: '토론 시간',
          type: 'select',
          choices: [
            { value: '120', label: '짧게 · 2분' },
            { value: '180', label: '보통 · 3분' },
            { value: '300', label: '길게 · 5분' },
          ],
          defaultValue: '180',
        },
      ],
    },
    load: async () => {
      const mod = await import('./werewolf');
      return mod.createWerewolfGame();
    },
  },
  {
    meta: {
      id: 'avalon',
      categories: ['추리', '두뇌'],
      name: '아발론',
      description: '아서왕 전설의 선/악 사회추리! 5라운드 원정에서 리더가 원정대를 뽑고 전원이 찬반 투표해요. 원정대는 성공/실패 카드를 비밀로 내고, 선은 3원정 성공을, 악은 3원정 실패나 멀린 암살을 노려요. 멀린·퍼시발·암살자·모르가나가 얽힌 심리전.',
      thumbnail: avalonThumbnail,
      minPlayers: 5,
      maxPlayers: 10,
      roomOptions: [
        {
          key: 'discuss',
          label: '원정대 토론 시간',
          type: 'select',
          choices: [
            { value: '60', label: '짧게 · 1분' },
            { value: '90', label: '보통 · 1분 30초' },
            { value: '150', label: '길게 · 2분 30초' },
          ],
          defaultValue: '90',
        },
      ],
    },
    load: async () => {
      const mod = await import('./avalon');
      return mod.createAvalonGame();
    },
  },
  {
    meta: {
      id: 'fake-artist',
      categories: ['추리', '그림'],
      name: '가짜 화가',
      description: '한 명은 제시어를 모르는 가짜 화가! 순서대로 각자 정해진 색으로 한 획씩 이어 그려요. 다 그리면 누가 가짜인지 투표 — 잡히면 시민 승, 단 가짜가 제시어를 맞히면 역전승. 5라운드 누적 점수 승부.',
      thumbnail: fakeArtistThumbnail,
      minPlayers: 4,
      maxPlayers: 10,
      roomOptions: [
        {
          key: 'laps',
          label: '그리는 바퀴 수',
          type: 'select',
          choices: [
            { value: '1', label: '1바퀴 (빠르게)' },
            { value: '2', label: '2바퀴 (기본)' },
            { value: '3', label: '3바퀴 (그림 풍부)' },
          ],
          defaultValue: '2',
        },
      ],
    },
    load: async () => {
      const mod = await import('./fake-artist');
      return mod.createFakeArtistGame();
    },
  },
  {
    meta: {
      id: 'kordle',
      categories: ['단어', '두뇌'],
      name: '꼬들',
      description: '한국어 워들! 단어를 자모로 풀어쓴 칸을 6번 안에 맞혀요. 초록은 자리까지 정답, 노랑은 자리만 틀림. 혼자서는 랜덤 문제, 여럿이면 돌아가며 문제를 내고 시도 횟수와 시간으로 점수를 겨뤄요.',
      thumbnail: kordleThumbnail,
      minPlayers: 1,
      maxPlayers: 10,
      roomOptions: [
        {
          key: 'len',
          label: '칸 수 (자모)',
          type: 'select',
          choices: [
            { value: '6', label: '6칸 (기본)' },
            { value: '12', label: '12칸 (어려움)' },
          ],
          defaultValue: '6',
        },
        {
          key: 'rounds',
          label: '라운드 수',
          type: 'select',
          choices: [
            { value: '3', label: '3라운드' },
            { value: '5', label: '5라운드' },
            { value: '10', label: '10라운드' },
            { value: '0', label: '무제한 (방장이 끝내기)' },
          ],
          defaultValue: '5',
        },
      ],
    },
    load: async () => {
      const mod = await import('./kordle');
      return mod.createKordle();
    },
  },
  {
    meta: {
      id: 'call-my-name',
      categories: ['단어', '순발력'],
      name: '양세찬 게임',
      description: '내 이마에 붙은 단어만 나만 못 봐요! 내 차례에 질문 하나를 던지면 모두가 한 번씩 대답해줘요. 그걸 보고 정답을 말하거나 다음 사람에게 넘기면 돼요.',
      thumbnail: callMyNameThumbnail,
      minPlayers: 2,
      maxPlayers: 10,
      roomOptions: [
        {
          key: 'theme',
          label: '주제',
          type: 'select',
          choices: [
            { value: 'random', label: '랜덤' },
            { value: 'food', label: '음식' },
            { value: 'animal', label: '동물' },
            { value: 'thing', label: '사물' },
            { value: 'place', label: '장소/나라' },
            { value: 'job', label: '직업/스포츠' },
          ],
          defaultValue: 'random',
        },
        {
          key: 'answerLimit',
          label: '대답 시간',
          type: 'select',
          choices: [
            { value: '20', label: '20초' },
            { value: '30', label: '30초' },
            { value: '45', label: '45초' },
            { value: '0', label: '제한 없음' },
          ],
          defaultValue: '30',
        },
      ],
    },
    load: async () => {
      const mod = await import('./call-my-name');
      return mod.createCallMyName();
    },
  },
  {
    meta: {
      id: 'codenames',
      categories: ['단어', '추리', '두뇌'],
      name: '코드네임',
      description: '두 팀으로 나뉘어 단어 25장에서 우리 팀 카드를 찾아요. 스파이마스터만 정답을 보고 힌트는 단어 하나! 암살자를 찍으면 그 자리에서 패배예요.',
      help: {
        goal: '우리 팀 단어 카드를 상대보다 먼저 다 찾으면 이겨요.',
        steps: [
          '두 팀으로 나뉘고, 각 팀의 첫 사람이 스파이마스터가 돼요.',
          '스파이마스터만 25장의 색을 봐요. 나머지는 단어만 보여요.',
          '스파이마스터가 단어 하나와 숫자로 힌트를 줘요. 예: 과일 3',
          '팀원들이 숫자+1 장까지 카드를 찍어요. 우리 팀 색이면 계속 찍을 수 있어요.',
          '행인이나 상대 팀 카드를 찍으면 턴이 넘어가요.',
          '애매하면 넘기기로 남은 기회를 포기해도 돼요.',
        ],
        tips: [
          '판에 있는 단어는 힌트로 못 써요. 포함된 말도 안 돼요.',
          '암살자 카드를 찍으면 그 자리에서 우리 팀이 집니다.',
          '선공 팀은 9장, 후공 팀은 8장이에요. 선공은 매판 무작위예요.',
        ],
      },
      thumbnail: codenamesThumbnail,
      minPlayers: 4,
      maxPlayers: 10,
      roomOptions: [
        {
          key: 'turnLimit',
          label: '턴 제한 시간',
          type: 'select',
          choices: [
            { value: '60', label: '60초' },
            { value: '90', label: '90초' },
            { value: '0', label: '제한 없음' },
          ],
          defaultValue: '90',
        },
      ],
    },
    load: async () => {
      const mod = await import('./codenames');
      return mod.createCodenames();
    },
  },
  {
    meta: {
      id: 'kraken',
      categories: ['보드게임', '추리'],
      name: '노 터치 크라켄',
      description: '탐험대와 해적으로 갈려 서로의 카드를 뒤집어요. 보물을 다 찾으면 탐험대 승, 크라켄이 깨어나거나 4라운드를 버티면 해적 승. 내 패도 섞여 있어서 입으로 속이는 게 전부예요.',
      help: {
        goal: '탐험대는 보물을 전부 찾으면 이기고, 해적은 크라켄이 나오거나 4라운드를 버티면 이겨요.',
        steps: [
          '시작할 때 몰래 탐험대나 해적이 돼요. 해적이 몇 명인지는 아무도 몰라요.',
          '각자 카드 5장을 받고 보물이 몇 장인지 보지만, 어느 카드가 보물인지는 본인도 몰라요.',
          '채팅으로 내 패를 말해요. 거짓말해도 됩니다.',
          '차례인 사람이 남의 카드를 한 장 골라 뒤집어요. 내 카드는 못 뒤집어요.',
          '뒤집힌 카드의 주인이 다음 차례가 돼요.',
          '인원수만큼 뒤집으면 라운드 끝. 남은 카드를 모아 다시 나눠요 (5장 → 4 → 3 → 2).',
        ],
        tips: [
          '보물은 인원수만큼, 크라켄은 딱 1장 있어요.',
          '크라켄이 나오면 그 자리에서 해적 승리예요.',
          '공개된 카드는 판에서 빠져요. 되돌아오지 않아요.',
        ],
      },
      thumbnail: krakenThumbnail,
      minPlayers: 3,
      maxPlayers: 6,
      roomOptions: [
        {
          key: 'turnLimit',
          label: '턴 제한 시간',
          type: 'select',
          choices: [
            { value: '60', label: '60초' },
            { value: '120', label: '120초' },
            { value: '0', label: '제한 없음' },
          ],
          defaultValue: '60',
        },
      ],
    },
    load: async () => {
      const mod = await import('./kraken');
      return mod.createKraken();
    },
  },
  {
    meta: {
      id: 'rummikub',
      categories: ['보드게임', '두뇌'],
      name: '루미큐브',
      description: '숫자 타일로 같은 숫자 모음·같은 색 연속을 만들어 바닥에 내요. 남이 깔아둔 조합도 쪼개고 붙여 내 타일을 끼울 수 있어요!',
      help: {
        goal: '손패를 먼저 다 내려놓으면 이겨요.',
        steps: [
          '타일 14장으로 시작해요.',
          '조합은 두 가지뿐이에요. 같은 숫자 다른 색 3~4장, 또는 같은 색 연속 숫자 3장 이상.',
          '첫 등록은 내 타일만으로 30점을 넘겨야 해요. 그 전에는 바닥을 못 건드려요.',
          '첫 등록을 마치면 남이 깔아둔 조합도 쪼개고 붙여서 내 타일을 끼울 수 있어요.',
          '낼 게 없으면 한 장 가져오기로 턴을 넘겨요.',
          '턴을 끝낼 때 바닥의 모든 조합이 올바르면 확정돼요.',
        ],
        tips: [
          '조합은 하나씩 따로 놓으세요. 여러 장을 한 번에 고르면 한 조합으로 들어가요.',
          '빨간 테두리는 아직 조합이 안 된 거예요. 완성하거나 되돌려야 턴을 끝낼 수 있어요.',
          '조커는 아무 타일로나 쓸 수 있지만, 손에 남으면 벌점 30점이에요.',
          '손패를 끌어서 원하는 순서로 늘어놓을 수 있어요.',
        ],
      },
      thumbnail: rummikubThumbnail,
      minPlayers: 2,
      maxPlayers: 4,
      roomOptions: [
        {
          key: 'turnLimit',
          label: '턴 제한 시간',
          type: 'select',
          choices: [
            { value: '60', label: '60초' },
            { value: '90', label: '90초' },
            { value: '0', label: '제한 없음' },
          ],
          defaultValue: '60',
        },
      ],
    },
    load: async () => {
      const mod = await import('./rummikub');
      return mod.createRummikub();
    },
  },
  {
    meta: {
      id: 'space-crew',
      categories: ['보드게임', '두뇌'],
      noChatInGame: true, // 손패 얘기를 못 하는 게 규칙의 핵심 — 채팅이 열려 있으면 게임이 안 된다
      name: '스페이스 크루',
      description: '다 같이 이기거나 다 같이 지는 협동 카드 게임. 각자 맡은 카드를 따내야 하는데 손패 얘기는 못 해요. 판당 딱 한 번의 통신으로 뜻을 맞춥니다.',
      thumbnail: spaceCrewThumbnail,
      minPlayers: 3,
      maxPlayers: 5,
      roomOptions: [
        {
          key: 'start',
          label: '시작',
          type: 'select',
          choices: [
            { value: 'resume', label: '이어하기' },
            { value: 'new', label: '미션 1부터' },
          ],
          defaultValue: 'resume',
        },
      ],
    },
    load: async () => {
      const mod = await import('./space-crew');
      return mod.createSpaceCrew();
    },
  },
  {
    meta: {
      id: 'davinci-code',
      categories: ['보드게임', '추리', '두뇌'],
      name: '다빈치 코드',
      description: '숫자 타일을 가리고 오름차순으로 놓은 뒤, 상대 타일의 숫자를 찍어 맞혀요. 틀리면 내 타일이 공개돼요. 전부 공개되면 탈락, 마지막 한 명이 승리!',
      thumbnail: davinciCodeThumbnail,
      minPlayers: 2,
      maxPlayers: 4,
      roomOptions: [
        {
          key: 'turnLimit',
          label: '제한 시간',
          type: 'select',
          choices: [
            { value: '0', label: '없음' },
            { value: '30', label: '30초' },
            { value: '60', label: '60초' },
          ],
          defaultValue: '0',
        },
      ],
    },
    load: async () => {
      const mod = await import('./davinci-code');
      return mod.createDavinciCode();
    },
  },
  {
    meta: {
      id: 'the-mind',
      categories: ['보드게임', '두뇌'],
      noChatInGame: true, // 말 없이 하는 게 규칙의 전부 — 채팅이 열려 있으면 게임이 안 된다
      name: '더 마인드',
      description: '1~100 카드를 나눠 갖고 말 한 마디 없이 작은 숫자부터 순서대로 내요. 다 같이 이기거나 다 같이 지는 협동 게임. 눈치와 침묵이 전부예요.',
      thumbnail: theMindThumbnail,
      minPlayers: 2,
      maxPlayers: 10,
      roomOptions: [
        {
          key: 'goal',
          label: '목표 레벨',
          type: 'select',
          choices: [
            { value: '5', label: '짧게 · 5레벨' },
            { value: '8', label: '보통 · 8레벨' },
            { value: '12', label: '길게 · 12레벨' },
          ],
          defaultValue: '8',
        },
      ],
    },
    load: async () => {
      const mod = await import('./the-mind');
      return mod.createTheMind();
    },
  },
  {
    meta: {
      id: 'subway-typing',
      categories: ['단어', '순발력'],
      name: '지하철 타자',
      description: '노선과 행선지를 고르고 역 이름을 순서대로 빠르게 쳐서 종점까지 완주! 친구들과 동시에 출발해 누가 먼저 도착하는지 겨뤄요. 기록은 완주 시간과 타수, 정확도로 남아요.',
      thumbnail: subwayTypingThumbnail,
      minPlayers: 1,
      maxPlayers: 10,
      roomOptions: [
        {
          key: 'country',
          label: '국가',
          type: 'select',
          choices: [
            { value: 'kr', label: '한국 (수도권)' },
            { value: 'jp', label: '일본 (도쿄)' },
          ],
          defaultValue: 'kr',
        },
        {
          key: 'line',
          label: '운행',
          type: 'select',
          dependsOn: 'country',
          choices: [
            { value: 'kr:1호선|down', when: 'kr', label: '1호선 광명행 (101역)' },
            { value: 'kr:1호선|up', when: 'kr', label: '1호선 연천행 (101역)' },
            { value: 'kr:2호선|down', when: 'kr', label: '2호선 내선순환 (43역)' },
            { value: 'kr:2호선|up', when: 'kr', label: '2호선 외선순환 (43역)' },
            { value: 'kr:3호선|down', when: 'kr', label: '3호선 오금행 (44역)' },
            { value: 'kr:3호선|up', when: 'kr', label: '3호선 대화행 (44역)' },
            { value: 'kr:4호선|down', when: 'kr', label: '4호선 오이도행 (52역)' },
            { value: 'kr:4호선|up', when: 'kr', label: '4호선 진접행 (52역)' },
            { value: 'kr:5호선|down', when: 'kr', label: '5호선 하남검단산행 (49역)' },
            { value: 'kr:5호선|up', when: 'kr', label: '5호선 방화행 (49역)' },
            { value: 'kr:6호선|down', when: 'kr', label: '6호선 신내행 (39역)' },
            { value: 'kr:6호선|up', when: 'kr', label: '6호선 응암행 (39역)' },
            { value: 'kr:7호선|down', when: 'kr', label: '7호선 석남행 (53역)' },
            { value: 'kr:7호선|up', when: 'kr', label: '7호선 장암행 (53역)' },
            { value: 'kr:8호선|down', when: 'kr', label: '8호선 모란행 (24역)' },
            { value: 'kr:8호선|up', when: 'kr', label: '8호선 별내행 (24역)' },
            { value: 'kr:9호선|down', when: 'kr', label: '9호선 중앙보훈병원행 (38역)' },
            { value: 'kr:9호선|up', when: 'kr', label: '9호선 개화행 (38역)' },
            { value: 'kr:경의중앙선|down', when: 'kr', label: '경의중앙선 지평행 (57역)' },
            { value: 'kr:경의중앙선|up', when: 'kr', label: '경의중앙선 임진강행 (57역)' },
            { value: 'kr:경춘선|down', when: 'kr', label: '경춘선 춘천행 (24역)' },
            { value: 'kr:경춘선|up', when: 'kr', label: '경춘선 청량리행 (24역)' },
            { value: 'kr:수인분당선|down', when: 'kr', label: '수인분당선 인천행 (63역)' },
            { value: 'kr:수인분당선|up', when: 'kr', label: '수인분당선 청량리행 (63역)' },
            { value: 'kr:신분당선|down', when: 'kr', label: '신분당선 광교행 (16역)' },
            { value: 'kr:신분당선|up', when: 'kr', label: '신분당선 신사행 (16역)' },
            { value: 'kr:공항철도|down', when: 'kr', label: '공항철도 인천공항2터미널행 (14역)' },
            { value: 'kr:공항철도|up', when: 'kr', label: '공항철도 서울행 (14역)' },
            { value: 'kr:인천1호선|down', when: 'kr', label: '인천1호선 송도달빛축제공원행 (33역)' },
            { value: 'kr:인천1호선|up', when: 'kr', label: '인천1호선 검단호수공원행 (33역)' },
            { value: 'kr:인천2호선|down', when: 'kr', label: '인천2호선 운연행 (27역)' },
            { value: 'kr:인천2호선|up', when: 'kr', label: '인천2호선 검단오류행 (27역)' },
            { value: 'kr:의정부경전철|down', when: 'kr', label: '의정부경전철 탑석행 (15역)' },
            { value: 'kr:의정부경전철|up', when: 'kr', label: '의정부경전철 발곡행 (15역)' },
            { value: 'kr:용인에버라인|down', when: 'kr', label: '용인에버라인 전대·에버랜드행 (15역)' },
            { value: 'kr:용인에버라인|up', when: 'kr', label: '용인에버라인 기흥행 (15역)' },
            { value: 'kr:우이신설선|down', when: 'kr', label: '우이신설선 신설동행 (13역)' },
            { value: 'kr:우이신설선|up', when: 'kr', label: '우이신설선 북한산우이행 (13역)' },
            { value: 'kr:김포골드라인|down', when: 'kr', label: '김포골드라인 김포공항행 (10역)' },
            { value: 'kr:김포골드라인|up', when: 'kr', label: '김포골드라인 양촌행 (10역)' },
            { value: 'kr:서해선|down', when: 'kr', label: '서해선 홍성행 (25역)' },
            { value: 'kr:서해선|up', when: 'kr', label: '서해선 대곡행 (25역)' },
            { value: 'kr:신림선|down', when: 'kr', label: '신림선 관악산행 (11역)' },
            { value: 'kr:신림선|up', when: 'kr', label: '신림선 샛강행 (11역)' },
            { value: 'kr:경강선|down', when: 'kr', label: '경강선 여주행 (12역)' },
            { value: 'kr:경강선|up', when: 'kr', label: '경강선 판교행 (12역)' },
            { value: 'kr:GTX-A|down', when: 'kr', label: 'GTX-A 동탄행 (9역)' },
            { value: 'kr:GTX-A|up', when: 'kr', label: 'GTX-A 운정중앙행 (9역)' },
            { value: 'jp:銀座線|down', when: 'jp', label: '銀座線 浅草行き (19駅)' },
            { value: 'jp:銀座線|up', when: 'jp', label: '銀座線 渋谷行き (19駅)' },
            { value: 'jp:丸ノ内線|down', when: 'jp', label: '丸ノ内線 荻窪行き (25駅)' },
            { value: 'jp:丸ノ内線|up', when: 'jp', label: '丸ノ内線 池袋行き (25駅)' },
            { value: 'jp:日比谷線|down', when: 'jp', label: '日比谷線 中目黒行き (22駅)' },
            { value: 'jp:日比谷線|up', when: 'jp', label: '日比谷線 北千住行き (22駅)' },
            { value: 'jp:東西線|down', when: 'jp', label: '東西線 西船橋行き (23駅)' },
            { value: 'jp:東西線|up', when: 'jp', label: '東西線 中野行き (23駅)' },
            { value: 'jp:千代田線|down', when: 'jp', label: '千代田線 綾瀬行き (19駅)' },
            { value: 'jp:千代田線|up', when: 'jp', label: '千代田線 代々木上原行き (19駅)' },
            { value: 'jp:有楽町線|down', when: 'jp', label: '有楽町線 新木場行き (24駅)' },
            { value: 'jp:有楽町線|up', when: 'jp', label: '有楽町線 和光市行き (24駅)' },
            { value: 'jp:半蔵門線|down', when: 'jp', label: '半蔵門線 押上行き (14駅)' },
            { value: 'jp:半蔵門線|up', when: 'jp', label: '半蔵門線 渋谷行き (14駅)' },
            { value: 'jp:南北線|down', when: 'jp', label: '南北線 赤羽岩淵行き (19駅)' },
            { value: 'jp:南北線|up', when: 'jp', label: '南北線 目黒行き (19駅)' },
            { value: 'jp:副都心線|down', when: 'jp', label: '副都心線 渋谷行き (16駅)' },
            { value: 'jp:副都心線|up', when: 'jp', label: '副都心線 和光市行き (16駅)' },
            { value: 'jp:山手線|down', when: 'jp', label: '山手線 内回り (30駅)' },
            { value: 'jp:山手線|up', when: 'jp', label: '山手線 外回り (30駅)' },
            { value: 'jp:中央線快速|down', when: 'jp', label: '中央線快速 高尾行き (24駅)' },
            { value: 'jp:中央線快速|up', when: 'jp', label: '中央線快速 東京行き (24駅)' },
            { value: 'jp:中央・総武線|down', when: 'jp', label: '中央・総武線 千葉行き (39駅)' },
            { value: 'jp:中央・総武線|up', when: 'jp', label: '中央・総武線 三鷹行き (39駅)' },
            { value: 'jp:京浜東北線|down', when: 'jp', label: '京浜東北線 大船行き (47駅)' },
            { value: 'jp:京浜東北線|up', when: 'jp', label: '京浜東北線 大宮行き (47駅)' },
            { value: 'jp:埼京線|down', when: 'jp', label: '埼京線 大宮行き (19駅)' },
            { value: 'jp:埼京線|up', when: 'jp', label: '埼京線 大崎行き (19駅)' },
            { value: 'jp:京葉線|down', when: 'jp', label: '京葉線 蘇我行き (18駅)' },
            { value: 'jp:京葉線|up', when: 'jp', label: '京葉線 東京行き (18駅)' },
            { value: 'jp:横浜線|down', when: 'jp', label: '横浜線 八王子行き (20駅)' },
            { value: 'jp:横浜線|up', when: 'jp', label: '横浜線 東神奈川行き (20駅)' },
            { value: 'jp:南武線|down', when: 'jp', label: '南武線 立川行き (26駅)' },
            { value: 'jp:南武線|up', when: 'jp', label: '南武線 川崎行き (26駅)' },
            { value: 'jp:武蔵野線|down', when: 'jp', label: '武蔵野線 西船橋行き (26駅)' },
            { value: 'jp:武蔵野線|up', when: 'jp', label: '武蔵野線 府中本町行き (26駅)' },
            { value: 'jp:横須賀線|down', when: 'jp', label: '横須賀線 久里浜行き (19駅)' },
            { value: 'jp:横須賀線|up', when: 'jp', label: '横須賀線 東京行き (19駅)' },
          ],
          defaultValue: 'kr:2호선|down',
        },
      ],
    },
    load: async () => {
      const mod = await import('./subway-typing');
      return mod.createSubwayTyping();
    },
  },
];

/** 게임 ID로 레지스트리 엔트리 조회 (없으면 undefined) */
export function getGameById(id: string): GameEntry | undefined {
  return games.find((g) => g.meta.id === id);
}

/**
 * 전체 게임 중 가장 큰 최대 인원.
 * 방을 만들 때는 아직 게임이 안 정해져 있어서(방 안에서 고름), 이 상한까지 사람을 받아둔다.
 * 이후 방장이 고른 게임의 maxPlayers 로 실제 정원이 좁혀진다.
 */
/**
 * 한 방에 붙을 수 있는 관전자 수.
 * 관전자는 판에 안 앉으니 게임 정원과 별도로 친다 — 2인 게임에도 구경꾼이 붙게.
 * 다만 무한정은 안 된다: 호스트가 관전자마다 따로 판을 만들어 보내는 게임도 있어서
 * 연결이 늘어날수록 호스트 부담이 커진다.
 */
export const MAX_SPECTATORS = 8;

export const GLOBAL_MAX_PLAYERS = Math.max(...games.map((g) => g.meta.maxPlayers));
