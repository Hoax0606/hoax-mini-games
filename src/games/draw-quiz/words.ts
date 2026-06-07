/**
 * 그림 퀴즈 제시어 풀 — 그림으로 표현 가능한 명사만.
 * 난이도(easy/normal/hard) 별로 분류. 출제자에게 무작위 3개 제시 → 1개 선택.
 *
 * 확장: WORDS 에 { word, difficulty } 추가만 하면 됨.
 */

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface QuizWord {
  word: string;
  difficulty: Difficulty;
}

export const WORDS: readonly QuizWord[] = [
  // 동물
  { word: '고양이', difficulty: 'easy' },
  { word: '강아지', difficulty: 'easy' },
  { word: '토끼', difficulty: 'easy' },
  { word: '병아리', difficulty: 'easy' },
  { word: '돼지', difficulty: 'easy' },
  { word: '오리', difficulty: 'easy' },
  { word: '수탉', difficulty: 'easy' },
  { word: '젖소', difficulty: 'easy' },
  { word: '망아지', difficulty: 'easy' },
  { word: '염소', difficulty: 'easy' },
  { word: '햄스터', difficulty: 'easy' },
  { word: '구렁이', difficulty: 'easy' },
  { word: '물고기', difficulty: 'easy' },
  { word: '거북이', difficulty: 'easy' },
  { word: '나비', difficulty: 'easy' },
  { word: '꿀벌', difficulty: 'easy' },
  { word: '달팽이', difficulty: 'easy' },
  { word: '코끼리', difficulty: 'normal' },
  { word: '기린', difficulty: 'normal' },
  { word: '사자', difficulty: 'easy' },
  { word: '호랑이', difficulty: 'easy' },
  { word: '원숭이', difficulty: 'normal' },
  { word: '판다', difficulty: 'normal' },
  { word: '펭귄', difficulty: 'normal' },
  { word: '고래', difficulty: 'easy' },
  { word: '상어', difficulty: 'normal' },
  { word: '문어', difficulty: 'normal' },
  { word: '꽃게', difficulty: 'normal' },
  { word: '낙타', difficulty: 'normal' },
  { word: '여우', difficulty: 'normal' },
  { word: '다람쥐', difficulty: 'normal' },
  { word: '부엉이', difficulty: 'normal' },
  { word: '독수리', difficulty: 'normal' },
  { word: '공작', difficulty: 'normal' },
  { word: '얼룩말', difficulty: 'normal' },
  { word: '하마', difficulty: 'normal' },
  { word: '코뿔소', difficulty: 'normal' },
  { word: '캥거루', difficulty: 'normal' },
  { word: '악어', difficulty: 'normal' },
  { word: '개구리', difficulty: 'normal' },
  { word: '해마', difficulty: 'normal' },
  { word: '불가사리', difficulty: 'normal' },
  { word: '잠자리', difficulty: 'normal' },
  { word: '사슴', difficulty: 'normal' },
  { word: '두더지', difficulty: 'hard' },
  { word: '카멜레온', difficulty: 'hard' },
  { word: '고슴도치', difficulty: 'hard' },
  { word: '나무늘보', difficulty: 'hard' },
  { word: '박쥐', difficulty: 'hard' },

  // 음식
  { word: '사과', difficulty: 'easy' },
  { word: '바나나', difficulty: 'easy' },
  { word: '포도', difficulty: 'easy' },
  { word: '수박', difficulty: 'easy' },
  { word: '딸기', difficulty: 'easy' },
  { word: '레몬', difficulty: 'easy' },
  { word: '키위', difficulty: 'easy' },
  { word: '복숭아', difficulty: 'easy' },
  { word: '당근', difficulty: 'easy' },
  { word: '토마토', difficulty: 'easy' },
  { word: '계란', difficulty: 'easy' },
  { word: '식빵', difficulty: 'easy' },
  { word: '케이크', difficulty: 'easy' },
  { word: '사탕', difficulty: 'easy' },
  { word: '아이스크림', difficulty: 'easy' },
  { word: '도넛', difficulty: 'easy' },
  { word: '피자', difficulty: 'easy' },
  { word: '치즈', difficulty: 'easy' },
  { word: '버섯', difficulty: 'easy' },
  { word: '옥수수', difficulty: 'easy' },
  { word: '햄버거', difficulty: 'normal' },
  { word: '핫도그', difficulty: 'normal' },
  { word: '김밥', difficulty: 'normal' },
  { word: '라면', difficulty: 'easy' },
  { word: '초밥', difficulty: 'easy' },
  { word: '도시락', difficulty: 'normal' },
  { word: '컵라면', difficulty: 'normal' },
  { word: '팝콘', difficulty: 'easy' },
  { word: '프라이팬', difficulty: 'normal' },
  { word: '주전자', difficulty: 'normal' },
  { word: '국수', difficulty: 'normal' },
  { word: '쿠키', difficulty: 'easy' },
  { word: '꼬치', difficulty: 'normal' },
  { word: '파인애플', difficulty: 'normal' },
  { word: '체리', difficulty: 'normal' },
  { word: '브로콜리', difficulty: 'normal' },
  { word: '고추', difficulty: 'easy' },
  { word: '감자', difficulty: 'easy' },
  { word: '가지', difficulty: 'normal' },
  { word: '비빔밥', difficulty: 'hard' },
  { word: '떡볶이', difficulty: 'hard' },
  { word: '솜사탕', difficulty: 'hard' },

  // 식물·자연
  { word: '나무', difficulty: 'easy' },
  { word: '꽃다발', difficulty: 'easy' },
  { word: '태양', difficulty: 'easy' },
  { word: '달님', difficulty: 'easy' },
  { word: '별똥별', difficulty: 'easy' },
  { word: '구름', difficulty: 'easy' },
  { word: '빗방울', difficulty: 'easy' },
  { word: '눈꽃', difficulty: 'easy' },
  { word: '화산섬', difficulty: 'easy' },
  { word: '바다', difficulty: 'easy' },
  { word: '시냇물', difficulty: 'easy' },
  { word: '무인도', difficulty: 'easy' },
  { word: '조약돌', difficulty: 'easy' },
  { word: '나뭇잎', difficulty: 'easy' },
  { word: '잔디', difficulty: 'easy' },
  { word: '무지개', difficulty: 'easy' },
  { word: '번개', difficulty: 'easy' },
  { word: '폭포', difficulty: 'easy' },
  { word: '화산', difficulty: 'normal' },
  { word: '선인장', difficulty: 'normal' },
  { word: '해바라기', difficulty: 'normal' },
  { word: '튤립', difficulty: 'normal' },
  { word: '장미', difficulty: 'easy' },
  { word: '단풍잎', difficulty: 'normal' },
  { word: '버섯구름', difficulty: 'normal' },
  { word: '눈송이', difficulty: 'normal' },
  { word: '고드름', difficulty: 'normal' },
  { word: '야자수', difficulty: 'normal' },
  { word: '솔방울', difficulty: 'normal' },
  { word: '도토리', difficulty: 'normal' },
  { word: '연꽃', difficulty: 'hard' },
  { word: '오로라', difficulty: 'hard' },

  // 탈것
  { word: '자동차', difficulty: 'easy' },
  { word: '버스', difficulty: 'easy' },
  { word: '돛단배', difficulty: 'easy' },
  { word: '비행기', difficulty: 'easy' },
  { word: '자전거', difficulty: 'easy' },
  { word: '풍선', difficulty: 'easy' },
  { word: '기차', difficulty: 'easy' },
  { word: '트럭', difficulty: 'easy' },
  { word: '오토바이', difficulty: 'normal' },
  { word: '택시', difficulty: 'easy' },
  { word: '소방차', difficulty: 'normal' },
  { word: '구급차', difficulty: 'normal' },
  { word: '경찰차', difficulty: 'normal' },
  { word: '헬리콥터', difficulty: 'normal' },
  { word: '잠수함', difficulty: 'normal' },
  { word: '요트', difficulty: 'easy' },
  { word: '열기구', difficulty: 'normal' },
  { word: '로켓', difficulty: 'easy' },
  { word: '지하철', difficulty: 'normal' },
  { word: '포클레인', difficulty: 'hard' },
  { word: '크레인', difficulty: 'hard' },
  { word: '우주선', difficulty: 'hard' },
  { word: '레미콘', difficulty: 'hard' },

  // 일상사물
  { word: '시계', difficulty: 'easy' },
  { word: '우산', difficulty: 'easy' },
  { word: '안경', difficulty: 'easy' },
  { word: '모자', difficulty: 'easy' },
  { word: '신발', difficulty: 'easy' },
  { word: '가방', difficulty: 'easy' },
  { word: '연필', difficulty: 'easy' },
  { word: '가위', difficulty: 'easy' },
  { word: '머그컵', difficulty: 'easy' },
  { word: '숟가락', difficulty: 'easy' },
  { word: '포크', difficulty: 'easy' },
  { word: '식칼', difficulty: 'easy' },
  { word: '열쇠', difficulty: 'easy' },
  { word: '전화기', difficulty: 'easy' },
  { word: '텔레비전', difficulty: 'easy' },
  { word: '의자', difficulty: 'easy' },
  { word: '책상', difficulty: 'easy' },
  { word: '침대', difficulty: 'easy' },
  { word: '공책', difficulty: 'easy' },
  { word: '풍선껌', difficulty: 'easy' },
  { word: '양초', difficulty: 'easy' },
  { word: '비누', difficulty: 'easy' },
  { word: '칫솔', difficulty: 'easy' },
  { word: '거울', difficulty: 'easy' },
  { word: '머리빗', difficulty: 'easy' },
  { word: '망치', difficulty: 'easy' },
  { word: '나사못', difficulty: 'easy' },
  { word: '자물쇠', difficulty: 'normal' },
  { word: '선글라스', difficulty: 'normal' },
  { word: '카메라', difficulty: 'normal' },
  { word: '우체통', difficulty: 'normal' },
  { word: '전구', difficulty: 'easy' },
  { word: '손전등', difficulty: 'normal' },
  { word: '돋보기', difficulty: 'normal' },
  { word: '나침반', difficulty: 'normal' },
  { word: '저금통', difficulty: 'normal' },
  { word: '선물상자', difficulty: 'normal' },
  { word: '우편물', difficulty: 'normal' },
  { word: '냉장고', difficulty: 'normal' },
  { word: '세탁기', difficulty: 'normal' },
  { word: '청소기', difficulty: 'normal' },
  { word: '선풍기', difficulty: 'normal' },
  { word: '다리미', difficulty: 'normal' },
  { word: '톱니바퀴', difficulty: 'normal' },
  { word: '주사기', difficulty: 'normal' },
  { word: '반창고', difficulty: 'normal' },
  { word: '체온계', difficulty: 'normal' },
  { word: '드라이버', difficulty: 'normal' },
  { word: '확성기', difficulty: 'normal' },
  { word: '재봉틀', difficulty: 'hard' },
  { word: '타자기', difficulty: 'hard' },
  { word: '계산기', difficulty: 'hard' },
  { word: '오르골', difficulty: 'hard' },

  // 신체
  { word: '손가락', difficulty: 'easy' },
  { word: '맨발', difficulty: 'easy' },
  { word: '눈썹', difficulty: 'easy' },
  { word: '콧수염', difficulty: 'easy' },
  { word: '입술', difficulty: 'easy' },
  { word: '귓불', difficulty: 'easy' },
  { word: '이빨', difficulty: 'easy' },
  { word: '머리카락', difficulty: 'normal' },
  { word: '주먹', difficulty: 'normal' },
  { word: '엄지손가락', difficulty: 'normal' },
  { word: '발자국', difficulty: 'normal' },
  { word: '손바닥', difficulty: 'normal' },

  // 건물·장소
  { word: '주택', difficulty: 'easy' },
  { word: '대문', difficulty: 'easy' },
  { word: '창문', difficulty: 'easy' },
  { word: '다리', difficulty: 'easy' },
  { word: '교회', difficulty: 'easy' },
  { word: '학교', difficulty: 'easy' },
  { word: '병원', difficulty: 'easy' },
  { word: '등대', difficulty: 'normal' },
  { word: '텐트', difficulty: 'normal' },
  { word: '풍차', difficulty: 'normal' },
  { word: '신호등', difficulty: 'normal' },
  { word: '계단', difficulty: 'easy' },
  { word: '굴뚝', difficulty: 'normal' },
  { word: '울타리', difficulty: 'normal' },
  { word: '우물', difficulty: 'normal' },
  { word: '에펠탑', difficulty: 'hard' },
  { word: '관람차', difficulty: 'hard' },
  { word: '미끄럼틀', difficulty: 'hard' },
  { word: '롤러코스터', difficulty: 'hard' },
  { word: '피라미드', difficulty: 'hard' },
  { word: '분수대', difficulty: 'hard' },

  // 스포츠·취미
  { word: '축구공', difficulty: 'easy' },
  { word: '농구공', difficulty: 'easy' },
  { word: '야구공', difficulty: 'easy' },
  { word: '배구공', difficulty: 'easy' },
  { word: '연날리기', difficulty: 'easy' },
  { word: '낚싯대', difficulty: 'normal' },
  { word: '골대', difficulty: 'normal' },
  { word: '탁구채', difficulty: 'normal' },
  { word: '배드민턴', difficulty: 'normal' },
  { word: '볼링핀', difficulty: 'normal' },
  { word: '다트판', difficulty: 'normal' },
  { word: '훌라후프', difficulty: 'normal' },
  { word: '줄넘기', difficulty: 'normal' },
  { word: '스케이트', difficulty: 'normal' },
  { word: '스키', difficulty: 'normal' },
  { word: '기타', difficulty: 'easy' },
  { word: '피아노', difficulty: 'normal' },
  { word: '드럼', difficulty: 'easy' },
  { word: '바이올린', difficulty: 'normal' },
  { word: '트럼펫', difficulty: 'normal' },
  { word: '하모니카', difficulty: 'normal' },
  { word: '실로폰', difficulty: 'normal' },
  { word: '팔레트', difficulty: 'normal' },
  { word: '주사위', difficulty: 'normal' },
  { word: '체스말', difficulty: 'normal' },
  { word: '아령', difficulty: 'normal' },
  { word: '낚시', difficulty: 'hard' },
  { word: '등산', difficulty: 'hard' },
  { word: '서핑보드', difficulty: 'hard' },
  { word: '아코디언', difficulty: 'hard' },

  // 캐릭터성·기타
  { word: '눈사람', difficulty: 'normal' },
  { word: '허수아비', difficulty: 'normal' },
  { word: '유령', difficulty: 'normal' },
  { word: '왕관', difficulty: 'normal' },
  { word: '램프', difficulty: 'normal' },
  { word: '보물상자', difficulty: 'normal' },
  { word: '깃발', difficulty: 'normal' },
  { word: '보물지도', difficulty: 'normal' },
  { word: '풍선인형', difficulty: 'normal' },
  { word: '로봇', difficulty: 'hard' },
  { word: '공룡', difficulty: 'hard' },
  { word: '성곽', difficulty: 'hard' },
  { word: '마법사', difficulty: 'hard' },
  { word: '인어', difficulty: 'hard' },
  { word: '천사', difficulty: 'hard' },
  { word: '해골', difficulty: 'hard' },
  { word: '외계인', difficulty: 'hard' },
  { word: '뱀파이어', difficulty: 'hard' },
  { word: '미라', difficulty: 'hard' },
  { word: '광대', difficulty: 'hard' },
  { word: '기사', difficulty: 'hard' },
  { word: '닌자', difficulty: 'hard' },
  { word: '잠수부', difficulty: 'hard' },
  { word: '소방관', difficulty: 'hard' },
  { word: '우주인', difficulty: 'hard' },
];

/**
 * 출제자에게 제시할 후보 3개를 무작위로 뽑는다.
 * 난이도 다양하게 섞이도록 — easy 1, normal 1, hard 1 가급적 균형.
 *
 * 후보는 출제자만 보므로 결정론(seed) 불필요 → Math.random 사용.
 *
 * @param exclude 이미 사용된 단어 set (중복 출제 방지)
 * @param count   뽑을 후보 개수 (기본 3)
 */
export function pickCandidates(exclude: Set<string>, count = 3): QuizWord[] {
  // 1) 아직 안 쓴 단어만 후보로
  const available = WORDS.filter((w) => !exclude.has(w.word));

  // 남은 게 count 이하면 그냥 섞어서 전부 반환
  if (available.length <= count) {
    return shuffle(available);
  }

  // 2) 난이도별 버킷으로 나눠서 골고루 뽑기
  const buckets: Record<Difficulty, QuizWord[]> = {
    easy: shuffle(available.filter((w) => w.difficulty === 'easy')),
    normal: shuffle(available.filter((w) => w.difficulty === 'normal')),
    hard: shuffle(available.filter((w) => w.difficulty === 'hard')),
  };

  // 라운드로빈으로 easy→normal→hard 순서 돌며 한 개씩 꺼내 균형 맞춤
  const order: Difficulty[] = ['easy', 'normal', 'hard'];
  const result: QuizWord[] = [];
  let oi = 0;
  while (result.length < count) {
    const diff = order[oi % order.length];
    const bucket = buckets[diff];
    if (bucket.length > 0) {
      result.push(bucket.pop()!);
    }
    oi++;
    // 세 버킷이 다 비었으면 (= 더 못 뽑음) 중단 — 무한루프 방지
    if (oi >= order.length && order.every((d) => buckets[d].length === 0)) {
      break;
    }
  }

  return shuffle(result);
}

/** 피셔-예이츠 셔플 (원본 보존을 위해 복사본 반환) */
function shuffle<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
