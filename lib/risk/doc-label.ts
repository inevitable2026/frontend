import type { 결재상태 } from "@/lib/risk/rows";

/**
 * 문서 키를 사람이 읽는 이름으로 바꾼다.
 *
 * `ra_2026_08_regular` 는 저장소 키다. 화면에 그대로 내보내면 관리자는 그것이 무슨
 * 문서인지 알 수 없고, 스크린리더는 "알에이 이공이육 공팔 레귤러"를 읽는다.
 *
 * **이름을 지어내는 게 아니다.** `documentApprovalState` 팩트가 이미 `문서` 칸에 사람
 * 이름을 들고 있다(`data/board/seed-facts.json:22 · 36 · 961`). 그것을 먼저 쓰고,
 * 없을 때만 키 규칙에서 만든다. 키 규칙조차 못 읽으면 종류만 말하고 키는 말하지 않는다 —
 * 원본 키가 필요한 자리는 `title` 속성이다(`문서키툴팁`).
 */

/** `regular` · `monthly` 는 시나리오가 쓰는 평가 종류다(`docs/scenario-gimpo-logistics.md:265,485`). */
const 종류이름: Record<string, string> = {
  regular: "정기",
  monthly: "월례",
  occasional: "수시",
};

function 월일(yyyymmdd: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  if (!m) return null;
  return `${Number(m[2])}월 ${Number(m[3])}일`;
}

/** 키에서 이름을 만든다. 규칙에 안 맞으면 null — 지어내지 않는다. */
function 키에서(docId: string): string | null {
  // ra_2026_08_regular · ra_2026_08_monthly
  const 정기 = /^ra_(\d{4})_(\d{2})_([a-z]+)$/.exec(docId);
  if (정기) {
    const 종류 = 종류이름[정기[3]];
    const 앞 = `${Number(정기[1])}년 ${Number(정기[2])}월`;
    return 종류 ? `${앞} ${종류} 위험성평가 회의록` : `${앞} 위험성평가 회의록`;
  }

  // ra_draft_20260819
  const 초안 = /^ra_draft_(\d{8})$/.exec(docId);
  if (초안) {
    const 날 = 월일(초안[1]);
    return 날 ? `${날} 위험성평가 회의록 (초안)` : null;
  }

  // ra_20260819
  const 날짜 = /^ra_(\d{8})$/.exec(docId);
  if (날짜) {
    const 날 = 월일(날짜[1]);
    return 날 ? `${날} 위험성평가 회의록` : null;
  }

  return null;
}

/**
 * 화면에 적을 문서 이름.
 *
 * 저장된 이름 → 키 규칙 → 종류만. 어느 경우에도 키 자체는 돌려주지 않는다.
 */
export function 문서이름(docId: string | null | undefined, 결재?: 결재상태 | null): string {
  const 저장된 = 결재?.문서?.trim();
  // 저장된 값이 키 그대로일 수도 있다. 그건 이름이 아니라 키이므로 다음 단계로 넘긴다.
  if (저장된 && 저장된 !== docId) return 저장된;
  if (!docId) return "위험성평가 회의록";
  return 키에서(docId) ?? "위험성평가 회의록";
}

/** 「 」 로 감싼 이름. 태스크 보드가 문서·카드 제목에 쓰는 관습을 따른다. */
export function 문서표시(docId: string | null | undefined, 결재?: 결재상태 | null): string {
  return `「${문서이름(docId, 결재)}」`;
}

/**
 * 원본 키를 `title` 속성으로만 내보낸다.
 *
 * 문의·대조에는 키가 필요하다. 다만 그건 읽는 문장이 아니라 필요할 때 꺼내 보는 값이다.
 */
export function 문서키툴팁(docId: string | null | undefined): string | undefined {
  return docId ? `문서 키: ${docId}` : undefined;
}
