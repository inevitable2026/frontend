// 화면이 보드 데이터를 얻는 유일한 진입점이다.
//
// 예전에는 `./fixtures` 를 그대로 돌려주고 쓰기 함수가 아무 일도 하지 않았다. 이제
// 읽기와 쓰기가 `/api/board/*` 로 간다 — 그 라우트는 `lib/board/store` 를 거쳐
// 감지 엔진이 만든 카드를 준다. 컴포넌트 쪽 import 는 한 줄도 달라지지 않았다.
//
// **머리(브리핑·캘린더·열 정의)는 아직 픽스처다.** 카드만 서버에서 온다.
// 한 번에 다 바꾸면 무엇이 깨졌는지 못 가리므로 카드부터 잇는다.

import { 카드로 } from "./adapt";
import { BOARD_SNAPSHOT } from "./fixtures";
import type { ApproveIntent, BoardSnapshot, CardMoveIntent, RejectIntent } from "./types";

import type { BoardPage } from "@/lib/board/types";

class BoardError extends Error {}

async function 본문오류(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new BoardError(body?.error ?? `보드 요청이 실패했습니다. (${res.status})`);
}

/**
 * 보드 한 장을 읽는다.
 *
 * `date` 를 그대로 넘긴다 — 라우트가 그날 기한인 카드만 남긴다. 넘기지 않으면 전체다.
 * 카드가 없는 것과 현장이 없는 것은 다르다(라우트가 404 로 갈라 준다).
 */
export async function loadBoard(siteId: string, date: string): Promise<BoardSnapshot> {
  const params = new URLSearchParams({ siteId });
  if (date) params.set("date", date);

  const res = await fetch(`/api/board/items?${params}`, { cache: "no-store" });
  if (!res.ok) await 본문오류(res);

  const page = (await res.json()) as BoardPage;

  // 선행 카드 제목은 같은 응답 안에서 찾는다. 화면이 "무엇을 기다리는지" 를
  // id 가 아니라 이름으로 보여야 하기 때문이다.
  const 제목찾기 = new Map(page.items.map((i) => [i.itemId, i.title]));
  const 기준시각 = Date.now();

  return {
    ...BOARD_SNAPSHOT,
    cards: page.items.map((item) => 카드로(item, 제목찾기, 기준시각)),
  };
}

/**
 * 카드를 다른 열이나 다른 순서로 옮긴 것을 남긴다.
 * 화면은 상태를 먼저 바꾼 뒤에 이 함수를 부른다 — 실패하면 되돌리는 것은 호출자 몫이다.
 */
export async function moveCard(intent: CardMoveIntent): Promise<void> {
  const res = await fetch(`/api/board/items/${encodeURIComponent(intent.itemId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    // `toIndex` 는 열 안의 0-based 순번이고 저장소는 `laneOrder` 를 쓴다.
    // 사이에 끼울 자리를 남기려고 100 배로 벌린다.
    body: JSON.stringify({ status: intent.to, laneOrder: intent.toIndex * 100 }),
  });
  if (!res.ok) await 본문오류(res);
}

/**
 * 초안을 승인한다.
 *
 * **`intent.edits` 는 아직 서버로 가지 않는다.** 라우트가 받는 `TransitionInput` 은
 * `status`·`confirmedBy`·`rejectReason`·`laneOrder`·`assignee` 뿐이고 초안 수정분을
 * 담을 자리가 없다(`lib/board/transition.ts:61-67`). 수정분을 조용히 버리지 않으려면
 * 저장할 자리가 먼저 생겨야 한다 — 그때까지 승인만 보낸다.
 */
export async function approveCard(intent: ApproveIntent): Promise<void> {
  const res = await fetch(`/api/board/items/${encodeURIComponent(intent.itemId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "done", confirmedBy: "user" }),
  });
  if (!res.ok) await 본문오류(res);
}

/** 초안을 기각한다. 사유가 비어 있는 요청은 화면에서 이미 막혀 여기까지 오지 않는다. */
export async function rejectCard(intent: RejectIntent): Promise<void> {
  const res = await fetch(`/api/board/items/${encodeURIComponent(intent.itemId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "todo", rejectReason: intent.reason }),
  });
  if (!res.ok) await 본문오류(res);
}
