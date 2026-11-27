/**
 * 작은 게임 카드 — 썸네일 + 이름 + 분류/인원 한 줄.
 *
 * 변경 로그에서 "새 게임 추가" 항목에 붙인다. 글로만 "○○ 추가" 라고 하면
 * 어떤 게임인지 감이 안 와서, 목록에서 보던 그 그림을 같이 보여준다.
 * 접속 팝업과 변경 로그 화면 둘 다 쓴다.
 */

import { getGameById } from '../games/registry';
import { escapeHtml, escapeAttr } from './escape';

/** 등록 안 된 id 면 빈 문자열 — 게임이 지워져도 로그가 깨지진 않게 */
export function buildMiniGameCardHTML(gameId: string): string {
  const entry = getGameById(gameId);
  if (!entry) return '';
  const m = entry.meta;
  const players = m.minPlayers === m.maxPlayers
    ? `${m.minPlayers}인 전용`
    : `${m.minPlayers}~${m.maxPlayers}인`;

  return `
    <div class="mini-game">
      <img class="mini-game-thumb" src="${escapeAttr(m.thumbnail)}" alt="" loading="lazy" />
      <div class="mini-game-info">
        <div class="mini-game-name">${escapeHtml(m.name)}</div>
        <div class="mini-game-meta">${escapeHtml(m.categories.join(' · '))} · ${players}</div>
      </div>
    </div>`;
}
