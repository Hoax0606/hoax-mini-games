/**
 * Firebase 설정 — 공개방 디렉토리용.
 *
 * 사용 방법:
 *   1. https://console.firebase.google.com 에서 새 프로젝트 생성
 *   2. "Realtime Database" 활성화 (Asia-Northeast1 추천 — Seoul)
 *   3. DB 규칙(Rules)을 아래로 설정:
 *
 *      {
 *        "rules": {
 *          "publicRooms": {
 *            ".read": true,
 *            "$roomId": {
 *              ".write": true,
 *              ".validate": "newData.hasChildren(['roomId','hostNickname','gameId','status'])"
 *            }
 *          }
 *        }
 *      }
 *
 *   4. "프로젝트 설정 → 일반 → 내 앱" 에서 웹앱 추가 → SDK 설정 복붙
 *   5. 아래 값을 자기 프로젝트 값으로 교체 (apiKey, databaseURL 등)
 *
 * 비워두면 공개방 기능이 자동으로 비활성화되고 비공개방(코드 입력) 으로만 동작한다.
 */
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";

// Firebase 콘솔에서 받은 웹 앱 설정. measurementId 는 v7.20+ 에서 선택사항.
const firebaseConfig = {
  apiKey: "AIzaSyCMqm2q-LBjOxdsm-JZNAULW85Ngr-wino",
  authDomain: "hoax-mini-games.firebaseapp.com",
  databaseURL: "https://hoax-mini-games-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hoax-mini-games",
  storageBucket: "hoax-mini-games.firebasestorage.app",
  messagingSenderId: "544074914517",
  appId: "1:544074914517:web:17822454c1e9276a05e05c",
  measurementId: "G-H0MEDXJ416"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
void analytics; // 현재는 등록만 — 미사용 변수 경고 방지

// roomDirectory.ts 에서 같은 app 인스턴스 + config 를 가져다 쓰도록 export
export const FIREBASE_CONFIG = firebaseConfig;
export const firebaseApp = app;