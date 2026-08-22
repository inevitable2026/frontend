// 큐 모드의 순수 계산과 그 문구 (AC-14 ~ AC-16).
//
// 화면도 요청도 모른다 — 이 디렉터리의 변환은 순수 함수라는 규칙(view-model.ts:7-10)을
// 그대로 따른다. 큐가 무엇을 다음 카드로 고르는지는 여기서만 정해지므로, 그 판정이
// 흔들릴 때 볼 파일이 하나다.
//
// ## 「같은 열의 다음 카드」를 무엇으로 정의했나
//
// 열은 **서랍을 연 순간의 열**을 고정한 값이다. 승인한 카드는 완료 열 맨 위로 옮겨 가는데
// (task-board.tsx 의 applyApprove), 큐가 그것을 따라가면 방금 승인한 카드의 뒤를 완료
// 열에서 이어 읽는다.
//
// 목록은 언제나 **사람이 보고 있는 것**(visibleCards)이다. 같은 파일의 laneOrder 계산도
// 보이는 목록으로 세므로, 두 자리가 서로 다른 목록으로 세면 어느 쪽도 믿을 수 없다.
//
// 순서는 laneOrder 오름차순 — kanban-board.tsx 의 cardsByColumn 과 같은 기준이다.

import type { BlockedByRef, BoardColumnId, TaskCard } from "./types";

/** 열 하나를 화면에 선 순서 그대로 세운다. */
export function 큐줄(cards: TaskCard[], columnId: BoardColumnId): TaskCard[] {
  return cards
    .filter((card) => card.status === columnId)
    .sort((left, right) => left.laneOrder - right.laneOrder);
}

/**
 * 그 줄에서 현재 카드 **바로 뒤**의 itemId. 마지막 장이면 null.
 *
 * 현재 카드가 줄에서 이미 빠졌으면(날짜 필터가 걸렸거나 다른 경로로 열이 바뀐 경우) 줄의
 * 첫 장으로 간다. 이 함수는 낙관적 갱신을 **적용하기 전의** 목록으로 불러야 한다 — 승인이
 * 카드를 완료 열로 옮긴 뒤에 부르면 현재 카드를 못 찾아 줄의 첫 장으로 되돌아가고, 이미
 * 지나온 카드부터 다시 서빙한다.
 */
export function 큐다음(
  cards: TaskCard[],
  columnId: BoardColumnId,
  현재itemId: string,
): string | null {
  const 줄 = 큐줄(cards, columnId);
  const 여기 = 줄.findIndex((card) => card.itemId === 현재itemId);
  const 다음 = 여기 < 0 ? 줄[0] : 줄[여기 + 1];
  if (다음 === undefined || 다음.itemId === 현재itemId) return null;
  return 다음.itemId;
}

/* ------------------------------------------------------------------ *
 * 처리 자취 (AC-15)
 * ------------------------------------------------------------------ */

export type 처리종류 = "승인" | "기각";

/**
 * 큐가 지나온 카드 한 장의 기록.
 *
 * 기각을 되돌리려면 두 가지를 함께 들고 있어야 한다. 기각 **직전의 laneOrder**(그 자리로
 * 돌려놓지 않으면 카드가 승인 열 맨 위로 튄다)와, applyReject 가 다른 카드에서 풀어 버린
 * 선행 링크다. 후자를 되살리지 않으면 되돌린 뒤 화면과 서버가 한 군데서 어긋난다.
 */
export type 처리자취 = {
  itemId: string;
  title: string;
  종류: 처리종류;
  /** 처리 직전의 열과 자리. 되돌리기가 그 자리로 돌려놓는다. */
  이전열: BoardColumnId;
  이전순서: number;
  /** 기각이 풀어 버린 대기. `{ 기다리던 카드, 지워진 선행 참조 }`. */
  풀린대기: { itemId: string; ref: BlockedByRef }[];
};

export function 자취문구(자취: 처리자취): string {
  const 꼬리 = 자취.종류 === "승인" ? "승인했습니다" : "기각했습니다";
  return `「${자취.title}」 를 ${꼬리}.`;
}

/**
 * 승인에는 되돌리기 단추를 그리지 않는다.
 *
 * 서버가 `confirmedAt` 이 찍힌 카드의 **모든** 전이를 409 로 막고(lib/board/transition.ts),
 * 승인 열 → 완료는 언제나 confirmedBy 를 요구하므로 확정 시각이 반드시 찍힌다. 언제나
 * 실패하는 단추를 그리는 것은 이 화면이 금지하는 조용한 거짓말의 반대편 형태다. 대신 왜
 * 없는지를 적고, 오조작을 알아채는 길은 「다시 보기」로 연다.
 */
export const QUEUE_APPROVE_IRREVERSIBLE = "확정 이력이 남아 되돌릴 수 없습니다.";

/**
 * 기각 되돌리기의 단서.
 *
 * `rejectItem` 은 카드를 todo·human 으로 두고 confirmed_at 을 비워 두므로 서버가 되돌리기를
 * 허용한다. 다만 `origin` 은 human 으로 남는다 — moveItem 의 humanTakeover 는 approval→todo
 * 에만 걸린다. 그 사실을 숨기면 사용자는 카드가 원상복구된 줄 안다.
 */
export const QUEUE_UNDO_NOTE =
  "승인 열의 원래 자리로 되돌립니다. 기각 이력과 「사람이 손본 카드」 표식은 그대로 남습니다.";

/* ------------------------------------------------------------------ *
 * 종료 (AC-16)
 * ------------------------------------------------------------------ */

export const QUEUE_DONE_TITLE = "이 열은 다 처리했습니다.";

/**
 * 끝 화면의 본문. 조용히 닫지 않고 무엇을 몇 장 지나왔는지 센다.
 *
 * 날짜 필터가 걸려 있으면 큐는 **보이는 카드만** 지났다. 그 단서를 빼면 화면이 "이 열은 다
 * 처리했습니다" 라고 말하는데 전체 열에는 카드가 남아 있는 상태가 된다.
 */
export function 종료요약(입력: {
  열이름: string;
  자취: 처리자취[];
  /** 그 열에 아직 서 있는 카드 수 (보고 있는 목록 기준). */
  남은수: number;
  /** 그 가운데 선행 카드가 안 끝나 확정할 수 없던 수. */
  막힌수: number;
  날짜필터: boolean;
}): string[] {
  const 승인 = 입력.자취.filter((자취) => 자취.종류 === "승인").length;
  const 기각 = 입력.자취.filter((자취) => 자취.종류 === "기각").length;

  const 줄: string[] = [
    `「${입력.열이름}」 열을 끝까지 지나왔습니다.`,
    `이번에 승인 ${승인}장, 기각 ${기각}장을 처리했습니다.`,
  ];

  if (입력.남은수 === 0) {
    줄.push(`${입력.열이름} 열에 남은 카드가 없습니다.`);
  } else if (입력.막힌수 > 0) {
    줄.push(
      `확정하지 못하고 지나온 ${입력.남은수}장이 ${입력.열이름} 열에 남아 있습니다. 그 가운데 ${입력.막힌수}장은 선행 카드가 아직 끝나지 않았습니다.`,
    );
  } else {
    줄.push(`확정하지 못하고 지나온 ${입력.남은수}장이 ${입력.열이름} 열에 남아 있습니다.`);
  }

  if (입력.날짜필터) {
    줄.push("보고 있는 날의 카드만 셌습니다. 날짜 필터를 풀면 이 열에 더 남아 있을 수 있습니다.");
  }

  return 줄;
}
