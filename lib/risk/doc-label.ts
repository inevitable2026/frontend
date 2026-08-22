import type { 결재상태 } from "@/lib/risk/rows";

/**
 * 문서 키를 사람이 읽는 이름으로 바꾼다.
 *
 * `ra_2026_08_regular` 는 저장소 키다. 화면에 그대로 내보내면 관리자는 그것이 무슨
 * 문서인지 알 수 없고, 스크린리더는 "알에이 이공이육 공팔 레귤러"를 읽는다.
 *
 * **이름을 지어내는 게 아니다.** `documentApprovalState` 팩트가 이미 `문서` 칸에 사람
 * 이름을 들고 있다(`data/board/seed-facts.json:22 · 36 · 961`). 그것을 먼저 쓰고,
 * 없을 때만 키 규칙에서 만든다.
 *
 * **종류를 모르면 종류를 말하지 않는다.** 처음에는 규칙에 안 맞는 키를 전부
 * "위험성평가 회의록" 이라고 불렀다. 그런데 이 화면에 실제로 들어오는 docId 에는
 * `tbm_20260818_pour`(TBM 기록) · `council_20260819`(협의체 회의록) ·
 * `doc_2_k3f9x1qm`(업로드 문서)가 섞여 있다(`data/board/seed-items.json`).
 * 그것들을 회의록이라고 적으면 **모르는 것을 단정**하는 것이고, 서랍 제목과 타임라인이
 * TBM 기록을 위험성평가 회의록이라고 말하게 된다.
 */

/** `regular` · `monthly` 는 시나리오가 쓰는 평가 종류다(`docs/scenario-gimpo-logistics.md:265,485`). */
const 종류이름: Record<string, string> = {
  regular: "정기",
  monthly: "월례",
  occasional: "수시",
};

/** 접두사로 알 수 있는 문서 종류. `risk-doc-panel.tsx` 의 `근거이름` 과 같은 표다. */
const 접두사종류: Array<[string, string]> = [
  ["tbm_", "TBM 기록"],
  ["nm_", "아차사고 보고"],
  ["notice_", "공문"],
  ["rev_", "외부 검토 의견"],
  ["council_", "안전보건협의체 회의록"],
];

function 월일(yyyymmdd: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  return m ? `${Number(m[2])}월 ${Number(m[3])}일` : null;
}

/** 키 안의 첫 8자리 날짜. 없으면 null. */
function 키날짜(docId: string): string | null {
  const m = /(\d{8})/.exec(docId);
  return m ? 월일(m[1]) : null;
}

/**
 * 키에서 이름을 만든다. **종류를 알 수 없으면 null** — 지어내지 않는다.
 */
function 키에서(docId: string): string | null {
  // ra_2026_08_regular · ra_2026_08_monthly
  const 정기 = /^ra_(\d{4})_(\d{2})_([a-z]+)$/.exec(docId);
  if (정기) {
    const 종류 = 종류이름[정기[3]];
    const 앞 = `${Number(정기[1])}년 ${Number(정기[2])}월`;
    return 종류 ? `${앞} ${종류} 위험성평가 회의록` : `${앞} 위험성평가 회의록`;
  }

  const 초안 = /^ra_draft_(\d{8})$/.exec(docId);
  if (초안) {
    const 날 = 월일(초안[1]);
    return 날 ? `${날} 위험성평가 회의록 (초안)` : null;
  }

  const 날짜 = /^ra_(\d{8})$/.exec(docId);
  if (날짜) {
    const 날 = 월일(날짜[1]);
    return 날 ? `${날} 위험성평가 회의록` : null;
  }

  for (const [접두사, 종류] of 접두사종류) {
    if (!docId.startsWith(접두사)) continue;
    const 날 = 키날짜(docId);
    return 날 ? `${날} ${종류}` : 종류;
  }

  return null;
}

/**
 * **확실한 이름만** 돌려준다. 못 만들면 null.
 *
 * 저장하는 쪽은 이걸 쓴다. 화면에 잠깐 쓰는 총칭과 달리, 팩트에 적힌 이름은 남아서
 * 다음에 읽는 사람에게 사실로 보인다. 모르면 적지 않는 편이 낫다.
 */
export function 문서이름확정(docId: string | null | undefined, 결재?: 결재상태 | null): string | null {
  const 저장된 = 결재?.문서?.trim();
  // 저장된 값이 키 그대로일 수도 있다. 그건 이름이 아니라 키이므로 다음 단계로 넘긴다.
  if (저장된 && 저장된 !== docId) return 저장된;
  return docId ? 키에서(docId) : null;
}

/**
 * 화면에 적을 문서 이름. 종류를 모르면 총칭 `"문서"` 로 둔다.
 */
export function 문서이름(docId: string | null | undefined, 결재?: 결재상태 | null): string {
  return 문서이름확정(docId, 결재) ?? "문서";
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
