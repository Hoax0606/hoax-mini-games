/**
 * 라이어 게임 제시어 풀 — 카테고리(주제)별 단어 묶음.
 *
 * 라운드마다 주제 하나를 고르고, 그 안에서 시민 제시어 1개 +
 * (바보 모드용) 같은 주제의 다른 단어 1개(가짜)를 뽑는다.
 * 주제가 전원 공개되므로, 같은 주제 안 단어들은 서로 헷갈릴 만큼 비슷한 급으로 구성.
 */

export interface Category {
  name: string;
  words: string[];
}

export const CATEGORIES: Category[] = [
  { name: '음식', words: ['김치', '라면', '피자', '치킨', '떡볶이', '초밥', '햄버거', '김밥', '파스타', '만두', '삼겹살', '불고기'] },
  { name: '동물', words: ['호랑이', '코끼리', '기린', '펭귄', '사자', '돌고래', '코알라', '캥거루', '얼룩말', '고릴라', '너구리', '다람쥐'] },
  { name: '과일', words: ['사과', '바나나', '딸기', '수박', '포도', '망고', '복숭아', '오렌지', '키위', '파인애플', '체리', '멜론'] },
  { name: '직업', words: ['의사', '경찰', '교사', '요리사', '소방관', '가수', '화가', '변호사', '농부', '군인', '기자', '개발자'] },
  { name: '장소', words: ['학교', '병원', '공항', '도서관', '수영장', '놀이공원', '영화관', '경찰서', '박물관', '카페', '시장', '체육관'] },
  { name: '스포츠', words: ['축구', '농구', '야구', '수영', '테니스', '골프', '배구', '탁구', '스키', '복싱', '양궁', '컬링'] },
  { name: '탈것', words: ['자동차', '비행기', '기차', '자전거', '오토바이', '헬리콥터', '배', '버스', '트럭', '지하철', '요트', '경비행기'] },
  { name: '채소', words: ['당근', '양파', '감자', '오이', '토마토', '배추', '시금치', '고구마', '호박', '마늘', '버섯', '가지'] },
  { name: '악기', words: ['피아노', '기타', '바이올린', '드럼', '플루트', '첼로', '트럼펫', '하프', '색소폰', '아코디언', '실로폰', '하모니카'] },
  { name: '가전', words: ['냉장고', '세탁기', '에어컨', '전자레인지', '텔레비전', '청소기', '선풍기', '드라이어', '토스터', '전기밥솥', '가습기', '믹서기'] },
  { name: '날씨', words: ['맑음', '비', '눈', '태풍', '안개', '천둥', '무지개', '우박', '황사', '폭염', '한파', '소나기'] },
  { name: '곤충', words: ['나비', '벌', '개미', '잠자리', '무당벌레', '사슴벌레', '메뚜기', '모기', '반딧불이', '매미', '거미', '풍뎅이'] },
  { name: '음료', words: ['콜라', '커피', '우유', '주스', '녹차', '사이다', '식혜', '스무디', '탄산수', '레모네이드', '코코아', '이온음료'] },
  { name: '나라', words: ['한국', '일본', '중국', '미국', '프랑스', '독일', '이탈리아', '브라질', '호주', '인도', '이집트', '캐나다'] },
  { name: '영화장르', words: ['액션', '코미디', '공포', '로맨스', '판타지', '스릴러', '애니메이션', '다큐멘터리', 'SF', '뮤지컬', '전쟁', '느와르'] },
];

/**
 * 한 라운드용 뽑기. 호스트가 호출.
 * @returns 주제 + 시민 제시어 + (바보 모드용) 같은 주제 다른 단어(가짜)
 */
export function pickRound(exclude: Set<string> = new Set()): { category: string; keyword: string; fakeKeyword: string } {
  // 아직 안 쓴 단어가 있는 카테고리 우선 (제시어 반복 방지)
  const availCats = CATEGORIES.filter((c) => c.words.some((w) => !exclude.has(w)));
  const pool = availCats.length > 0 ? availCats : CATEGORIES;
  const cat = pool[Math.floor(Math.random() * pool.length)]!;
  // 그 카테고리에서 안 쓴 단어 우선
  const unused = cat.words.filter((w) => !exclude.has(w));
  const words = unused.length > 0 ? unused : cat.words;
  const keyword = words[Math.floor(Math.random() * words.length)]!;
  // 가짜 — 같은 카테고리 다른 단어
  const others = cat.words.filter((w) => w !== keyword);
  const fakeKeyword = others[Math.floor(Math.random() * others.length)] ?? keyword;
  return { category: cat.name, keyword, fakeKeyword };
}
