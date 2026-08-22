// 화면이 보드 데이터를 얻는 유일한 진입점이다.
//
// 이 파일은 세 개의 GET 과 하나의 PATCH 만 안다. 응답을 화면 뷰모델로 옮겨 담는 일은
// ./view-model.ts 가 하고, 화면 컴포넌트는 여기서 나온 BoardSnapshot 만 그린다. 그래서
// 라우트가 바뀌면 고칠 자리가 이 파일 하나이고, 반대로 화면 규약이 바뀌면 view-model.ts
// 하나만 본다.
//
// 실패했을 때 픽스처로 되돌아가는 길은 두지 않았다. 그렇게 하면 존재하지 않는 현장의 카드와
// 지난 날짜의 브리핑이 오늘의 안전 상황인 것처럼 화면에 남고, 사용자는 진짜와 가짜를 구별할
// 방법이 없다. 게다가 그 화면 위에서 승인하고 기각하면 화면은 "사유가 기록되었습니다" 라고
// 말하지만 아무 데도 남지 않는다. 안전관리 콘솔에서 그것은 이행확인 기록의 위조와 같은
// 자리에 있다. 그래서 실패는 감추지 않고 무엇이 잘못되었는지를 문장으로 올려 보낸다.

import type { WorkItem } from "@/lib/board/types";

import type { ApproveIntent, BoardSnapshot, CardMoveIntent, RejectIntent } from "./types";
import { toBoardSnapshot, type BoardSources } from "./view-model";

/* ------------------------------------------------------------------ *
 * 오류
 * ------------------------------------------------------------------ */

/**
 * 화면에 그대로 적을 수 있는 실패다.
 *
 * 상태 코드마다 원인이 전혀 다르므로 문구를 갈라 둔다. 503 은 board 스키마가 아직 적용되지
 * 않은 것이고, 404 는 그 현장으로 적재된 데이터가 없다는 뜻이며, 500 과 네트워크 오류는
 * 데이터베이스에 닿지 못한 것이다. 셋을 "불러오지 못했습니다" 한 문장으로 뭉뚱그리면
 * 고칠 자리를 찾는 데 며칠이 걸린다.
 */
export class BoardRequestError extends Error {
  readonly status: number | null;
  /** 서버가 { error } 로 돌려준 원문. 화면이 자기 진단 문구로 덧붙인다. */
  readonly detail: string | null;

  constructor(message: string, status: number | null, detail: string | null) {
    super(message);
    this.name = "BoardRequestError";
    this.status = status;
    this.detail = detail;
  }
}

function 읽기실패문구(무엇: string, status: number, detail: string | null): string {
  const 꼬리 = detail ? ` 서버가 돌려준 문구는 "${detail}" 입니다.` : "";
  if (status === 503) return `보드 스키마가 아직 적용되지 않았습니다.${꼬리}`;
  if (status === 404) return `이 현장의 데이터가 아직 적재되지 않았습니다.${꼬리}`;
  if (status === 400) return `${무엇} 요청이 올바르지 않습니다.${꼬리}`;
  return `데이터베이스에 연결하지 못했습니다. ${무엇} 요청에 서버가 ${status} 로 답했습니다.${꼬리}`;
}

async function 본문오류(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

async function 읽기<T>(url: string, 무엇: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  } catch {
    throw new BoardRequestError(
      `서버에 닿지 못했습니다. ${무엇} 요청이 네트워크에서 끊겼습니다.`,
      null,
      null,
    );
  }
  if (!res.ok) {
    const detail = await 본문오류(res);
    throw new BoardRequestError(읽기실패문구(무엇, res.status, detail), res.status, detail);
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ *
 * 읽기
 * ------------------------------------------------------------------ */

/**
 * 보드 한 장의 재료. 서버가 GET /api/board/snapshot 으로 돌려주는 모양 그대로이고,
 * 서버 컴포넌트가 미리 읽어 내려보낼 때에도 같은 모양이다.
 */
export type { BoardSources };

/**
 * 재료를 화면 뷰모델로 옮긴다.
 *
 * 읽는 길이 둘이라 이 자리가 필요하다. 하나는 아래 loadBoard 가 브라우저에서 부르는 길이고,
 * 다른 하나는 서버 컴포넌트가 첫 그림 전에 이미 읽어 둔 재료를 그대로 넘기는 길이다.
 * 뒤쪽은 요청을 한 번도 보내지 않으므로 여기서 변환만 한다.
 */
export function boardSnapshotOf(sources: BoardSources): BoardSnapshot {
  return toBoardSnapshot(sources);
}

/**
 * 보드 한 장을 읽는다.
 *
 * `date` 는 칸반이 그리는 날이고 `at` 은 브리핑이 거슬러 올라가는 기준 시각이다. 둘을 따로
 * 보내는 이유는 브리핑의 24시간 창이 시각 단위로 움직이기 때문이다.
 *
 * 요청은 하나다. 예전에는 items · week · briefing · sites · documents 다섯을 함께 보냈는데,
 * 그 다섯이 서버에서 같은 카드 목록을 세 번 읽는 열댓 번의 질의로 갈라졌다. 왕복 한 번이
 * 300ms 인 원격 데이터베이스에서 그 중복은 그대로 첫 화면의 대기 시간이었다. 지금은 서버가
 * 카드 목록을 한 번만 읽어 셋이 나눠 쓴다.
 *
 * 반쪽 보드는 만들지 않는다. 무엇이 없는지 사용자가 알 수 없어 더 나쁘기 때문에, 재료 중
 * 하나라도 못 읽으면 보드 전체를 실패로 그린다. 다만 현장 이름과 문서함은 뼈대가 아니라
 * 곁들이라 서버 쪽에서 실패를 삼키고 대체 값으로 간다.
 */
export async function loadBoard(siteId: string, date: string, at: string): Promise<BoardSnapshot> {
  const query = new URLSearchParams({ siteId, date, at });
  const sources = await 읽기<BoardSources>(`/api/board/snapshot?${query}`, "보드");
  return toBoardSnapshot(sources);
}

/* ------------------------------------------------------------------ *
 * 쓰기
 *
 * 세 동작이 모두 같은 라우트로 간다. 서버가 무엇을 하는지는 본문이 정한다 —
 * lib/board/transition.ts 가 status 와 confirmedBy 와 rejectReason 을 보고 이동인지
 * 확정인지 기각인지를 가른다.
 * ------------------------------------------------------------------ */

type ItemBody = {
  status: string;
  laneOrder?: number;
  confirmedBy?: string;
  rejectReason?: string;
  edits?: { path: string; before: string; after: string }[];
};

async function 고치기(itemId: string, body: ItemBody): Promise<WorkItem> {
  let res: Response;
  try {
    res = await fetch(`/api/board/items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new BoardRequestError("서버에 닿지 못해 저장하지 못했습니다.", null, null);
  }

  if (!res.ok) {
    // 여기의 문구는 그대로 aria-live 영역에 실린다. 409 blocked(선행 카드가 남았다)와
    // 400 rejectReasonRequired(사유가 필요하다)는 사용자가 할 일이 서로 다르므로,
    // "저장하지 못했습니다" 로 덮지 않고 서버가 쓴 문장을 그대로 보여 준다.
    const detail = await 본문오류(res);
    throw new BoardRequestError(detail ?? `저장하지 못했습니다. 서버가 ${res.status} 로 답했습니다.`, res.status, detail);
  }

  const body2 = (await res.json()) as { item: WorkItem };
  return body2.item;
}

/**
 * 카드를 다른 열이나 다른 자리로 옮긴다.
 *
 * laneOrder 는 화면이 열 전체를 다시 매긴 값이 아니라 **놓일 자리의 앞뒤 카드 사이의
 * 중간값**이다. PATCH 는 카드 한 장만 고치므로 열 전체를 다시 매겨 보내면 서버의 나머지
 * 행이 옛 값을 그대로 들고 있어 다시 읽는 순간 순서가 어긋난다.
 * board.work_items.lane_order 가 double precision 인 이유가 정확히 이것이다.
 */
export async function moveCard(intent: CardMoveIntent, laneOrder: number | null): Promise<WorkItem> {
  const body: ItemBody = { status: intent.to };
  // 같은 열 안의 순서 변경도 status 를 실어 보낸다. planTransition 이 status 를 늘 요구하고,
  // from 과 to 가 같고 확정자가 없으면 그쪽에서 reorder 로 읽는다.
  if (laneOrder !== null) body.laneOrder = laneOrder;
  return 고치기(intent.itemId, body);
}

/**
 * 초안을 승인한다.
 *
 * confirmedBy 는 화면이 낙관적으로 적어 둔 확정자와 같은 값이어야 한다. 다른 값을 보내면
 * 새로 고침한 뒤에 확정자 이름이 바뀐다. 초안 대비 수정분은 edits 로 함께 올라가고
 * 서버가 board.work_item_events 에 'edited' 한 줄로 남긴다.
 */
export async function approveCard(
  intent: ApproveIntent,
  confirmedBy: string,
  laneOrder: number | null,
): Promise<WorkItem> {
  const body: ItemBody = { status: "done", confirmedBy };
  if (laneOrder !== null) body.laneOrder = laneOrder;
  if (intent.edits.length > 0) body.edits = intent.edits;
  return 고치기(intent.itemId, body);
}

/**
 * 초안을 기각한다.
 *
 * 서버는 기각을 카드 삭제로 처리하지 않는다. status 를 todo 로, origin 을 human 으로 바꾸고
 * 초안을 남긴 뒤 사유를 이력에 적는다. 무엇을 기각했는지가 나중에 방어 근거가 되기 때문이다.
 * 화면도 같은 자리로 카드를 옮겨야 새로 고침 전후의 그림이 같다.
 *
 * 사유가 빈 문자열이면 서버가 400 을 돌려주지만 RejectDialog 가 앞에서 막고 있다.
 */
export async function rejectCard(intent: RejectIntent, laneOrder: number | null): Promise<WorkItem> {
  const body: ItemBody = { status: "todo", rejectReason: intent.reason };
  if (laneOrder !== null) body.laneOrder = laneOrder;
  return 고치기(intent.itemId, body);
}
