// 카드 하나를 `POST /api/risk/assess` 의 본문으로 옮긴다 (AC-8).
//
// "근거까지 미리 채운 초안 — 카드가 프롬프트가 된다"(명세 Round 1)가 이 파일의 계약이다.
// 사람이 어휘를 다시 고르지 않아야 하므로 공종·자재는 카드에 붙은 팩트에서 직접 뽑고,
// 뽑을 수 없으면 **뽑지 못했다고 말한다** — 그럴듯한 값을 채우지 않는다.
//
// 순수 함수다. fetch 는 부르는 쪽(card-assess-draft.tsx)이 한다.

import type { SnapshotFact, WorkItem } from "@/lib/board/types";
import { asRecord, readString } from "@/lib/detect/delta";
// 타입만 가져온다. lib/risk/safegrid.ts 는 서버 전용이지만 `import type` 은 컴파일에서
// 지워지므로 번들에 실리지 않는다. 본문 모양을 두 벌로 적지 않으려고 정본을 그대로 쓴다.
import type { 생성입력 } from "@/lib/risk/safegrid";

import { 카드문서들, 팩트고르기, 팩트한줄 } from "./evidence";
import { EVIDENCE_ASSESS_NO_INPUT } from "./evidence-copy";

/** 모드는 데모로 고정한다 (AC-9). 화면에 토글을 두지 않으므로 값도 리터럴이다. */
export type 평가초안본문 = 생성입력 & { 모드: "데모" };

export type 평가초안입력결과 = {
  본문: 평가초안본문;
  /** 화면이 읽기 전용 칩으로 먼저 보여 주는 조건. 사람이 다시 고르지 않는다. */
  공종: string[];
  자재: string[];
  보낼수있음: boolean;
  못보내는사유: string | null;
};

function 중복없이(값들: Array<string | null>): string[] {
  const 본것 = new Set<string>();
  for (const v of 값들) {
    if (v && v.trim()) 본것.add(v.trim());
  }
  return [...본것];
}

/**
 * 카드가 대는 문서에 붙은 팩트만 모은다. 현장 전체를 넣으면 이 카드와 상관없는 공종이
 * 조건으로 올라간다.
 */
function 카드팩트(item: WorkItem, facts: SnapshotFact[]): SnapshotFact[] {
  const 모음: SnapshotFact[] = [];
  const 본것 = new Set<string>();
  for (const 문서 of 카드문서들(item)) {
    for (const f of 팩트고르기(facts, 문서.docId)) {
      const 자리 = `${f.factType}::${f.key}`;
      if (본것.has(자리)) continue;
      본것.add(자리);
      모음.push(f);
    }
  }
  return 모음;
}

/**
 * 공종. `riskAssessmentRow` 의 `공종분류` 만 쓴다.
 *
 * 이 저장소에서 문자 그대로 "공종" 인 유일한 필드다. 초안 행의 `process`("4층 슬래브 동바리
 * 설치")를 여기 넣지 않는 이유는 그것이 단위작업이기 때문이다 — lib/risk/types.ts 의
 * `Hazard` 도 work_type 과 unit_work 를 따로 둔다. process 는 description 으로 보낸다.
 */
function 공종뽑기(facts: SnapshotFact[]): string[] {
  return 중복없이(
    facts
      .filter((f) => f.factType === "riskAssessmentRow")
      .map((f) => readString(f.value, "공종분류")),
  );
}

/** 자재. `documentExtraction` 의 extracted.toMaterial · fromMaterial 라벨. */
function 자재뽑기(facts: SnapshotFact[]): string[] {
  const 라벨들: Array<string | null> = [];
  for (const f of facts) {
    if (f.factType !== "documentExtraction") continue;
    const 추출 = asRecord(asRecord(f.value)?.["extracted"]);
    if (!추출) continue;
    라벨들.push(readString(추출["toMaterial"], "label"));
    라벨들.push(readString(추출["fromMaterial"], "label"));
  }
  return 중복없이(라벨들);
}

function 설명만들기(item: WorkItem, facts: SnapshotFact[]): string {
  const 줄: string[] = [item.title];
  if (item.summary) 줄.push(item.summary);
  if (item.trigger) 줄.push(`발동 조건(${item.trigger.ruleId}): ${item.trigger.condition}`);

  for (const inv of item.invalidates) {
    줄.push(`무효 대상: ${inv.docId} — ${inv.scope} · ${inv.reason}`);
  }

  if (facts.length > 0) {
    줄.push("근거 팩트:");
    for (const f of facts) {
      const 한줄 = 팩트한줄(f);
      줄.push(`- [${한줄.factType}] ${한줄.key} (${한줄.시각}) ${한줄.요약}`);
    }
  }

  if (item.draft?.form === "회의록") {
    줄.push("이 카드가 제안한 신규 행:");
    for (const r of item.draft.rows) {
      줄.push(`- ${r.process} / ${r.hazard} (${r.hazardClass})`);
    }
  }

  return 줄.join("\n");
}

/**
 * 카드 → 생성 본문.
 *
 * `equipment` 는 **언제나 빈 배열**이다. 14종 factType 의 값을 전수 확인했지만 장비를 담는
 * 필드가 없다(출역 명부의 "팀" 은 TBM 팀 이름이지 장비가 아니다). 없는 것을 그럴듯하게
 * 채우면 그 표의 근거를 아무도 답할 수 없다.
 *
 * `source_documents` 도 빈 배열이다. `SourceDoc` 은 `{filename, extracted_at, engine,
 * fields}` 로 **인제스트 결과**의 모양이라(lib/risk/types.ts:63-69), 인제스트를 돌리지도
 * 않고 engine 을 채우면 SAFEGRID 에 저장되는 평가서에 가짜 출처 기록이 남는다. 문서
 * 식별자는 description 안에 문장으로 보낸다.
 *
 * `matrix`·`method` 는 risk-assessment-panel.tsx:119-120 의 기존 화면 기본값을 그대로 쓴다.
 * 새로 지어낸 값이 아니고, 두 입구가 같은 조건에서 견줄 수 있는 표를 낸다.
 */
export function 평가초안입력(
  item: WorkItem,
  facts: SnapshotFact[],
  siteName: string,
): 평가초안입력결과 {
  const 붙은팩트 = 카드팩트(item, facts);
  const 공종 = 공종뽑기(붙은팩트);
  const 자재 = 자재뽑기(붙은팩트);
  const 보낼수있음 = 공종.length > 0 || 자재.length > 0;

  return {
    본문: {
      모드: "데모",
      work_types: 공종,
      equipment: [],
      materials: 자재,
      photo_findings: [],
      matrix: "4x3",
      method: "빈도·강도법",
      site: siteName,
      source_documents: [],
      description: 설명만들기(item, 붙은팩트),
    },
    공종,
    자재,
    보낼수있음,
    못보내는사유: 보낼수있음 ? null : EVIDENCE_ASSESS_NO_INPUT,
  };
}
