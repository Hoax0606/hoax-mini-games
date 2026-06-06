/**
 * HTML 이스케이프 헬퍼 — 사용자 입력(닉네임/채팅/방 ID 등)을
 * `innerHTML` 이나 속성값에 넣기 전 항상 이걸 통과시킨다.
 *
 * 이 파일이 모든 화면에서 공유하는 단일 출처. 각 화면이 자체 escapeHtml 을
 * 만들지 말 것 — 누락 시 사일런트 XSS 위험 + `escapeAttr` 처럼 정의를 빠뜨려
 * ReferenceError 가 사일런트로 터지는 사고 (실제 발생 사례) 차단.
 */

/** 텍스트 콘텐츠 / innerHTML 안에 들어갈 값 이스케이프. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

/** 속성값(예: `data-x="..."`) 안에 들어갈 값 이스케이프. 현재는 escapeHtml 과 동일.
 *  의미 분리 위해 별도 이름 — 미래에 속성 전용 처리가 필요할 때 한 곳에서만 바꿔도 됨. */
export const escapeAttr = escapeHtml;
