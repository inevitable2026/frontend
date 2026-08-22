import { generateObject } from "ai";

import type { Detection, Draft, DraftForm } from "@/lib/board/types";
import { GENERATION_PROVIDER_OPTIONS, GENERATION_RETRIES, DRAFT_MAX_TOKENS, generationModel } from "./model";
import { 끝맺기 } from "./repair";
import { 사람시각 } from "./format";
import { DRAFT_SCHEMA_BY_FORM, type CardPlan } from "./schemas";

// 승인 열에 올라갈 문서 초안의 본문을 쓴다.
//
// 이 자리는 지금까지 비어 있었다. lib/board/types.ts 의 Draft 는 여섯 서식이 상세히
// 정의되어 있는데 engine.ts 는 draft: null 만 채웠고, 화면에 보이던 초안은 전부 시드
// 데이터였다. 그래서 새로 감지된 조건은 제목만 있는 빈 카드를 승인 열에 올렸다.
//
// 초안이 서야 승인 열이 제 뜻을 갖는다. 담당자가 하는 일이 "빈 카드를 보고 직접 쓰는 것"
// 에서 "쓰인 것을 읽고 고쳐 확정하는 것" 으로 바뀌기 때문이다.

const 공통규칙 = [
  "당신은 한국 건설현장의 안전관리 문서를 쓰는 사람입니다.",
  "",
  "지켜야 할 것:",
  "- 근거에 있는 사실만 씁니다. 자재명·업체명·수치·날짜·인명을 지어내지 마십시오.",
  "- 근거에서 확인되지 않은 값이 필요하면 '(확인 필요)' 라고 적어 사람이 채우게 하십시오. 그럴듯한 값으로 메우면 그 문서가 그대로 결재를 타고 올라갑니다.",
  "- 법령 조문은 공식 원문을 확인한 것만 인용합니다. 확인하지 못했으면 citable 을 false 로 두거나 아예 적지 마십시오.",
  "- 문장은 현장 담당자가 읽는 실무 문서의 어조로 씁니다. 과장하지 않고, 무엇을 언제까지 누가 하는지가 드러나게 씁니다.",
].join("\n");

/** 서식마다 다른 당부. 무엇을 쓰는 문서인지가 판단의 무게를 정한다. */
const 서식별지침: Record<DraftForm, string> = {
  회의록: [
    "위험성평가 회의록의 신규 행을 씁니다.",
    "각 행은 하나의 유해위험요인을 다루고, 대책 전 위험도와 대책 후 잔여 위험도를 따로 매깁니다.",
    "위험도는 가능성 × 중대성 이며 둘 다 1에서 5 사이입니다. score 가 그 곱과 어긋나면 안 됩니다.",
    "잔여 위험도는 대책을 실행한 뒤의 값이므로 대책 전보다 낮아야 합니다.",
    "이 숫자는 초안일 뿐이고 확정은 안전관리자가 합니다. 근거가 얇으면 measures 에 무엇을 더 확인해야 하는지 적으십시오.",
    "derivedFrom 에는 위에 주어진 근거의 key 와 문서 식별자를 그대로 옮겨 적습니다.",
  ].join(" "),
  공문: [
    "상대 회사에 보내는 공문입니다. 계약상 효력이 따라오므로 근거에 없는 요구를 적으면 안 됩니다.",
    "본문은 무엇이 확인되었고 그래서 무엇을 요청하는지 순서로 씁니다.",
    "수신처를 근거에서 확인하지 못했으면 '(수신처 확인 필요)' 로 두십시오.",
  ].join(" "),
  회의자료: [
    "협의체나 회의에 올릴 안건 자료입니다.",
    "각 안건의 문항은 회의에서 실제로 답이 나와야 하는 물음으로 적습니다. 설명문이 아니라 물음이어야 합니다.",
  ].join(" "),
  TBM자료: [
    "작업 전 팀에게 공유하는 자료입니다.",
    "항목은 작업자가 그 자리에서 알아들을 수 있는 짧은 말로 적습니다. 무엇이 바뀌었고 무엇을 조심해야 하는지가 먼저입니다.",
    "통역이 필요한 인원 수는 근거에서 확인되지 않으면 0 으로 두십시오.",
  ].join(" "),
  점검표: [
    "작업 착수 전에 눈으로 확인할 것을 적은 표입니다.",
    "각 항목은 현장에서 보고 예·아니오로 답할 수 있어야 합니다. '안전하게 시공되었는지 확인' 처럼 판단이 필요한 문장은 쓰지 마십시오.",
    "초안은 아무것도 확인되지 않은 상태이므로 done 은 전부 false 입니다.",
  ].join(" "),
  기록: [
    "현장에서 확인한 것을 적어 두는 기록입니다.",
    "본문에는 무엇을 어떻게 확인해야 하는지를 적습니다. 아직 확인하지 않은 것을 확인한 것처럼 쓰지 마십시오.",
  ].join(" "),
};

function 근거블록(detection: Detection): string {
  if (detection.evidence.length === 0) return "(근거 없음)";
  return detection.evidence
    .map((e) => {
      const 출처 = e.sourceDocId ? ` · 출처 ${e.sourceDocId}` : "";
      return `- [${e.factType} / key=${e.key}] ${e.excerpt} (관측 ${사람시각(e.observedAt)}${출처})`;
    })
    .join("\n");
}

export type WriteDraftInput = {
  detection: Detection;
  card: CardPlan;
  form: DraftForm;
};

/**
 * 카드 한 장의 초안 본문을 쓴다.
 *
 * 실패하면 예외를 올린다. 부르는 쪽이 카드별로 받아 삼키고 draft 를 null 로 두는 것이
 * 옳다 — 초안 한 장을 못 썼다고 카드까지 없애면 담당자가 그 일이 있었다는 사실조차
 * 모르게 된다.
 */
export async function writeDraft(input: WriteDraftInput): Promise<Draft> {
  const schema = DRAFT_SCHEMA_BY_FORM[input.form];

  const prompt = [
    `## 쓸 문서`,
    `서식: ${input.form}`,
    `카드 제목: ${input.card.title}`,
    input.card.summary ? `카드 요약: ${input.card.summary}` : "",
    input.card.dueBy ? `기한: ${input.card.dueBy}` : "",
    "",
    `## 이 문서를 쓰게 된 조건 (${input.detection.ruleId})`,
    input.detection.summary,
    "",
    "## 근거",
    근거블록(input.detection),
    "",
    input.detection.invalidates.length > 0 ? "## 전제를 잃은 문서" : "",
    input.detection.invalidates
      .map((v) => `- ${v.docId} / ${v.scope} — ${v.reason}`)
      .join("\n"),
    "",
    서식별지침[input.form],
  ]
    .filter((line) => line !== "")
    .join("\n");

  const { object } = await generateObject({
    model: generationModel(),
    schema,
    schemaName: `${input.form}Draft`,
    schemaDescription: `${input.form} 서식의 초안 본문`,
    system: 공통규칙,
    prompt,
    maxRetries: GENERATION_RETRIES,
    maxOutputTokens: DRAFT_MAX_TOKENS,
    providerOptions: GENERATION_PROVIDER_OPTIONS,
    repairText: 끝맺기,
  });

  // 스키마에는 form 이 없다. 판별 유니온의 태그는 우리가 이미 알고 있는 값이라
  // 모델에게 물을 이유가 없고, 물으면 다른 서식 이름을 흘릴 여지만 생긴다.
  return { form: input.form, ...object } as Draft;
}
