import type { Detection, DraftForm, Produces, WorkItem } from "@/lib/board/types";
import {
  detectionSignature,
  involvesRiskJudgement,
  toWorkItems,
  type CardBlueprint,
  type DetectionGenerator,
} from "@/lib/detect/engine";
import { rulesById } from "@/lib/detect/rules";
import { planCardsWithModel } from "./cards";
import { writeDraft } from "./drafts";
import { narrateDetection } from "./narrative";
import type { CardPlan } from "./schemas";

export { GenerationUnavailableError, isGenerationConfigured } from "./model";
export { narrateBriefing, type BriefingParagraphInput } from "./narrative";

// 감지 하나를 카드와 초안과 문장으로 옮기는 한 벌.
//
// 세 단계가 이 순서여야 하는 이유가 있다. 초안은 카드가 어느 서식인지 알아야 쓸 수 있고,
// 서사의 "만든것" 칸은 카드가 무엇인지 알아야 적을 수 있다. 그래서 계획 → 초안 → 서사다.
//
// 실패는 단계마다 무게가 다르다.
//   계획 실패 → 이 감지는 통째로 포기한다. 카드를 지어낼 수 없다
//   초안 실패 → 그 카드만 draft: null 로 두고 나머지는 그대로 간다
//   서사 실패 → 카드는 저장하고 문장만 비운다. 브리핑이 템플릿으로 되돌아간다

/** 초안 하나에 허용하는 시간. 회의록은 행이 여럿이라 오래 걸린다 */
const DRAFT_TIMEOUT_MS = 120_000;

function 이름표(detection: Detection): string {
  return rulesById.get(detection.ruleId)?.label ?? detection.ruleId;
}

/**
 * 모델이 낸 카드 계획을 엔진이 받는 모양으로 옮긴다.
 *
 * 스키마가 선택 필드를 null 로 받으므로 여기서 undefined 로 정리한다. Produces 의 선택
 * 필드에 null 이 그대로 들어가면 jsonb 에 `"count": null` 이 저장되고, 그것을 읽는 쪽은
 * "0 건" 과 "세지 않는 서식" 을 구별할 수 없게 된다.
 */
function 산출물정리(produces: CardPlan["produces"]): Produces[] {
  return produces.map((p) => ({
    form: p.form as DraftForm,
    ...(p.count !== null ? { count: p.count } : {}),
    ...(p.into !== null ? { into: p.into } : {}),
    ...(p.to !== null ? { to: p.to } : {}),
    ...(p.for !== null ? { for: p.for } : {}),
    ...(p.teams !== null && p.teams.length > 0 ? { teams: p.teams } : {}),
  }));
}

/** 초안 하나를 쓰되 시간을 넘기면 포기한다. 한 장 때문에 감지 전체가 매달리지 않게 한다 */
async function 시간제한초안(
  detection: Detection,
  card: CardPlan,
  form: DraftForm,
): Promise<CardBlueprint["draft"]> {
  const 시계 = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), DRAFT_TIMEOUT_MS).unref?.();
  });

  try {
    return await Promise.race([writeDraft({ detection, card, form }), 시계]);
  } catch (error) {
    // 초안 한 장을 못 썼다고 카드까지 없애지 않는다. 담당자가 그 일이 있었다는 사실조차
    // 모르게 되는 쪽이 훨씬 나쁘다.
    console.error("[generate] 초안 생성 실패", card.key, form, error);
    return null;
  }
}

export type CreateGeneratorOptions = {
  /** 카드를 만드는 기준 날. 감지 시각이 아니라 사람이 그 카드를 보는 날이다 */
  now: string;
};

/**
 * runDetect 에 넘길 생성기를 만든다.
 *
 * engine.ts 가 이 모듈을 import 하지 않고 함수를 주입받는 이유는 lib/detect/engine.ts 의
 * DetectionGenerator 주석에 적혀 있다.
 */
export function createDetectionGenerator(options: CreateGeneratorOptions): DetectionGenerator {
  return async function generate(detection: Detection) {
    const ruleLabel = 이름표(detection);

    // 1. 무엇을 할지 정한다. 여기서 실패하면 이 감지는 통째로 포기한다.
    const plan = await planCardsWithModel({ detection, ruleLabel, now: options.now });
    if (plan.length === 0) return null;

    const produces = plan.flatMap((card) => 산출물정리(card.produces));

    // 2. 초안을 쓴다. 서식이 정해진 카드만, 그리고 서로 기다리지 않게 한꺼번에.
    const drafts = await Promise.all(
      plan.map((card) =>
        card.draftForm === null
          ? Promise.resolve(null)
          : 시간제한초안(detection, card, card.draftForm as DraftForm),
      ),
    );

    // 3. 계획을 엔진이 받는 모양으로 옮긴다.
    //
    // 위험도 판정이 걸린 감지는 카드 전부를 잠근다. 모델이 delegable 을 true 로 냈어도
    // 여기서 false 가 된다 — 안전한 쪽으로만 덮으므로 반대 방향으로는 풀지 않는다.
    const locked = involvesRiskJudgement(detection, produces);

    const cards: CardBlueprint[] = plan.map((card, index) => ({
      key: card.key,
      title: card.title,
      status: card.status as CardBlueprint["status"],
      summary: card.summary,
      produces: 산출물정리(card.produces),
      // 무효화는 감지 한 건의 성질이라 대표 카드 한 장이 들고 간다. 카드마다 붙이면
      // 같은 문서가 브리핑의 무효화 칸에 여러 번 적힌다.
      invalidates: index === 0 ? detection.invalidates : [],
      draft: drafts[index],
      dueBy: card.dueBy,
      estimatedMinutes: card.estimatedMinutes,
      delegable: locked ? false : card.delegable,
      blockedByKeys: card.blockedByKeys,
    }));

    // 4. 문장을 쓴다. 카드를 이미 알고 있으므로 만든것 칸을 채울 수 있다.
    //
    // 여기서 만드는 WorkItem 은 서사에 보여 주기 위한 것이고, 저장하는 것은 엔진이
    // 같은 계획으로 다시 만든다. detectionSignature 가 실행 시각을 보지 않으므로 두 번
    // 만들어도 itemId 까지 같은 값이 나온다.
    const items: WorkItem[] = toWorkItems({ ...detection, produces }, {
      plan: cards,
      now: options.now,
    });

    let narrative = null;
    try {
      narrative = await narrateDetection({ detection, ruleLabel, items });
    } catch (error) {
      // 문장만 못 쓴 것이다. 카드는 그대로 살리고 브리핑은 템플릿으로 되돌아간다.
      console.error("[generate] 서사 생성 실패", detection.ruleId, detectionSignature(detection), error);
    }

    return { cards, produces, narrative };
  };
}
