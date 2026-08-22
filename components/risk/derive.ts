import type { WorkItem } from "@/lib/board/types";

/**
 * 위험성평가 화면이 쓰는 최소 파생값.
 *
 * **`view-model.ts` 의 `toBoardSnapshot` 을 쓰지 않는 이유** — 그쪽은 브리핑·캘린더·열 정의를
 * 포함한 보드 한 장 전체를 만든다. 대기열은 카드 몇 장만 필요하고, 그 한 장을 얻으려고
 * 스냅샷 전체를 조립하면 없는 날짜와 없는 브리핑을 지어내야 한다.
 *
 * 그렇다고 색·배지 파생을 여기서 다시 만들지도 않는다. 그건 `view-model.ts` 가 하는 일이고
 * 두 벌이 되면 반드시 갈라진다. 여기서는 **`WorkItem` 이 이미 들고 있는 값만** 쓴다.
 */

/** 카드 왼쪽 색띠. 급한 순서대로 본다 — 전제가 무너진 것 · 사람 확인 대기 · 끝난 것. */
export function 급함색(item: WorkItem): string {
  if (item.invalidates.length > 0) return "is-alert";
  if (item.status === "done") return "is-ok";
  if (item.status === "approval") return "is-review";
  return "is-routine";
}

/** 무엇을 만드는 카드인지. 산출물 서식이 곧 종류다. */
export function 종류라벨(item: WorkItem): string {
  return item.produces[0]?.form ?? item.draft?.form ?? "확인";
}

/**
 * 기한 문구. **`dueBy` 가 항상 ISO 는 아니다** — `docs/board-contract.md:394-397` 대로
 * 시각이 확정되지 않은 카드는 사람이 읽는 문장으로 온다. 파싱하려 들지 않는다.
 */
const ISO시각 = /^\d{4}-\d{2}-\d{2}T/;

export function 기한문구(dueBy: string | null, 기준시각: number): { 글: string | null; 급함: boolean } {
  if (!dueBy) return { 글: null, 급함: false };
  if (!ISO시각.test(dueBy)) return { 글: dueBy, 급함: false };

  const ms = new Date(dueBy).getTime();
  if (Number.isNaN(ms)) return { 글: dueBy, 급함: false };

  const 시각 = new Date(ms).toLocaleTimeString("ko-KR", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul",
  });
  const 남은 = ms - 기준시각;
  if (남은 < 0) return { 글: `${시각} 지남`, 급함: true };
  if (남은 <= 24 * 60 * 60 * 1000) return { 글: 시각, 급함: true };
  const 날짜 = new Date(ms).toLocaleDateString("ko-KR", {
    month: "numeric", day: "numeric", timeZone: "Asia/Seoul",
  });
  return { 글: `${날짜} ${시각}`, 급함: false };
}
