import { generateObject } from "ai";

import type { Detection } from "@/lib/board/types";
import { dayKey, shiftDay } from "@/lib/detect/engine";
import { GENERATION_RETRIES, generationModel } from "./model";
import { cardPlanListSchema, type CardPlan } from "./schemas";

// 감지 한 건을 받아 "그래서 누가 무엇을 해야 하는가" 를 정한다.
//
// 예전에는 이 판단이 규칙 파일 안의 produces 배열과 engine.ts 의 FORM_LANE · FORM_DUE ·
// RULE_SHAPING 표에 나뉘어 박혀 있었다. 자재가 바뀌면 언제나 카드 다섯 장이 같은 기한으로
// 떴고, 층고 8.2m 구간 1,850㎡ 짜리 혼용 시공과 창고동 마감재 교체가 같은 대접을 받았다.
//
// 서식이 무엇을 요구하는 판단인지에 대한 지식은 아래 프롬프트에 모여 있다. 표를 없앤 대신
// 이 문장들이 그 자리를 대신하므로, 서식을 늘리거나 열 배정 기준을 바꾸려면 여기를 고친다.

const SYSTEM = [
  "당신은 한국 건설현장의 안전관리 업무를 설계하는 사람입니다.",
  "감지된 조건 하나를 받아 담당자가 실제로 해야 할 일을 카드로 나눕니다.",
  "",
  "카드를 나누는 기준은 진행 단계가 아니라 **지금 이 일을 움직일 수 있는 주체** 입니다.",
  "- todo: 사람이 현장에서 몸을 움직이거나 눈으로 확인해야 하는 일. 미리 써 둘 수 있는 초안이 없습니다.",
  "- approval: 문서 초안을 미리 써 두고 담당자가 검토해 승인하면 끝나는 일.",
  "- done: 사람의 판단이 전혀 필요 없어 이미 처리된 일. 문서를 읽어 근거로 등록하는 단계가 여기 해당합니다.",
  "",
  "서식 여섯 가지가 각각 무엇을 요구하는 판단인지:",
  "- 회의록: 위험성평가 회의록입니다. 위험도 숫자를 매기는 일이라 반드시 사람이 확정해야 하고, 남에게 넘길 수 없습니다(delegable=false). 기한은 결재 일정이 정하므로 임의로 못 박지 말고 null 로 두십시오.",
  "- 공문: 반입 보류처럼 계약상 효력이 따라오는 문서입니다. 수신처를 근거에서 확인하지 못했으면 to 를 null 로 두고 사람이 채우게 하십시오.",
  "- 회의자료: 협의체나 회의에 올릴 안건 자료입니다.",
  "- TBM자료: 작업 전 팀별로 공유하는 자료입니다. 같은 조건에서 회의록이 함께 만들어진다면 회의록이 확정되어야 내용이 정해지므로 blockedByKeys 로 묶으십시오. 기한은 다음 날 이른 아침 TBM 전입니다.",
  "- 점검표: 작업 착수 전에 짚을 것을 적은 표입니다. 기한은 해당 작업 착수 전입니다.",
  "- 기록: 현장에서 직접 보고 적어야 하는 것입니다. 미리 쓸 수 없으므로 status 는 todo 이고 draftForm 은 null 입니다.",
  "",
  "지켜야 할 것:",
  "- 근거에 있는 사실만 씁니다. 근거에 없는 자재명·업체명·수치·날짜를 지어내지 마십시오.",
  "- 조건이 요구하지 않는 카드를 채워 넣지 마십시오. 두 장이면 충분한 조건에 여섯 장을 만들면 담당자가 보드를 믿지 않게 됩니다.",
  "- 기한은 주어진 오늘·내일 날짜를 재료로 계산하십시오. 다른 날짜를 스스로 만들어 내지 마십시오.",
  "- 위험도 판정이 걸린 일은 delegable 을 false 로 두십시오.",
].join("\n");

function 근거블록(detection: Detection): string {
  if (detection.evidence.length === 0) return "(근거 없음)";
  return detection.evidence
    .map((e) => {
      const 출처 = e.sourceDocId ? ` · 출처 ${e.sourceDocId}` : "";
      return `- [${e.factType}] ${e.excerpt} (관측 ${e.observedAt}${출처})`;
    })
    .join("\n");
}

function 무효화블록(detection: Detection): string {
  if (detection.invalidates.length === 0) return "(전제를 잃은 문서 없음)";
  return detection.invalidates
    .map((v) => `- ${v.docId} / ${v.scope} — ${v.reason}`)
    .join("\n");
}

export type PlanCardsInput = {
  detection: Detection;
  /** 규칙 이름표. "자재 변경" 처럼 이 조건이 무엇인지 부르는 말 */
  ruleLabel: string;
  /** 카드를 만드는 기준 날. 감지 시각이 아니라 사람이 이 카드를 보는 날이다 */
  now: string;
};

/**
 * 감지 하나를 카드 목록으로 옮긴다.
 *
 * 실패하면 예외가 그대로 올라간다. 여기서 삼켜 빈 배열을 돌려주면 호출한 쪽이 "이 조건은
 * 할 일이 없다" 와 "만들지 못했다" 를 구별할 수 없고, 그 둘은 담당자에게 전혀 다른 상황이다.
 */
export async function planCardsWithModel(input: PlanCardsInput): Promise<CardPlan[]> {
  const 당일 = dayKey(input.now);
  const 익일 = shiftDay(input.now, 1);

  const prompt = [
    `## 감지된 조건 (${input.detection.ruleId} · ${input.ruleLabel})`,
    input.detection.summary,
    "",
    `확신도: ${input.detection.confidence}`,
    "",
    "## 근거",
    근거블록(input.detection),
    "",
    "## 전제를 잃은 문서",
    무효화블록(input.detection),
    "",
    "## 날짜",
    `오늘: ${당일}`,
    `내일: ${익일}`,
    "",
    "이 조건 때문에 담당자가 해야 할 일을 카드로 나누어 주십시오.",
  ].join("\n");

  const { object } = await generateObject({
    model: generationModel(),
    schema: cardPlanListSchema,
    schemaName: "CardPlan",
    schemaDescription: "감지된 조건 하나가 만들어 내는 태스크 카드 목록",
    system: SYSTEM,
    prompt,
    maxRetries: GENERATION_RETRIES,
  });

  return 정리(object.cards);
}

/**
 * 모델이 낸 계획을 쓸 수 있는 모양으로 다듬는다.
 *
 * 스키마가 형식은 잡아 주지만 **계획 안의 앞뒤가 맞는지** 는 잡지 못한다. 없는 카드를
 * 가리키는 blockedByKeys 나 두 번 나온 key 가 그대로 통과하면 itemId 가 겹치거나
 * 영영 풀리지 않는 선행 관계가 생긴다.
 */
function 정리(cards: CardPlan[]): CardPlan[] {
  const 본키 = new Set<string>();
  const 살아남은: CardPlan[] = [];

  for (const card of cards) {
    // 같은 key 가 두 번 오면 itemId 가 겹쳐 뒤엣것이 앞엣것을 덮어쓴다. 첫 장만 남긴다.
    if (본키.has(card.key)) continue;
    본키.add(card.key);
    살아남은.push(card);
  }

  return 살아남은.map((card) => ({
    ...card,
    // 자기 자신이나 없는 카드를 가리키는 선행 관계는 버린다.
    blockedByKeys: card.blockedByKeys.filter((key) => key !== card.key && 본키.has(key)),
  }));
}
