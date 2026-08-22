// 화면이 보드 데이터를 얻는 유일한 진입점이다.
//
// 지금은 `./fixtures` 의 한 장면을 그대로 돌려주고 쓰기 함수는 아무 일도 하지 않는다.
// 서버가 붙으면 **이 파일만** 고친다 — 아래 네 함수의 본문을 fetch 로 바꾸면 되고,
// 컴포넌트 쪽에서는 import 한 줄도 달라지지 않는다.

import { BOARD_SNAPSHOT } from "./fixtures";
import type { ApproveIntent, BoardSnapshot, CardMoveIntent, RejectIntent } from "./types";

/**
 * 보드 한 장을 읽는다.
 *
 * 픽스처에는 2026-08-19 하루치만 들어 있으므로 두 인자는 아직 결과를 가르지 않는다.
 * 서버가 붙으면 그대로 질의 문자열이 된다.
 *
 * TODO(server): GET /api/board?siteId={siteId}&date={date}
 */
export async function loadBoard(siteId: string, date: string): Promise<BoardSnapshot> {
  void siteId;
  void date;
  // 호출한 쪽이 카드를 상태에 넣고 뒤섞어도 모듈 상수가 오염되지 않도록 배열은 새로 만든다.
  return { ...BOARD_SNAPSHOT, cards: [...BOARD_SNAPSHOT.cards] };
}

/**
 * 카드를 다른 열이나 다른 순서로 옮긴 것을 남긴다.
 * 화면은 상태를 먼저 바꾼 뒤에 이 함수를 부른다.
 *
 * TODO(server): PATCH /api/board/cards/{intent.itemId}
 */
export async function moveCard(intent: CardMoveIntent): Promise<void> {
  void intent;
}

/**
 * 초안을 승인한다. 초안 대비 수정분이 `intent.edits` 로 함께 올라간다.
 *
 * TODO(server): POST /api/board/cards/{intent.itemId}/approve
 */
export async function approveCard(intent: ApproveIntent): Promise<void> {
  void intent;
}

/**
 * 초안을 기각한다. 사유가 비어 있는 요청은 화면에서 이미 막혀 여기까지 오지 않는다.
 *
 * TODO(server): POST /api/board/cards/{intent.itemId}/reject
 */
export async function rejectCard(intent: RejectIntent): Promise<void> {
  void intent;
}
