import type { RuleId, TriggerRule } from "@/lib/board/types";

import { t01Weather } from "@/lib/detect/rules/t01-weather";
import { t02Followup } from "@/lib/detect/rules/t02-followup";
import { t03Material } from "@/lib/detect/rules/t03-material";
import { t04Review } from "@/lib/detect/rules/t04-review";
import { t05Nearmiss } from "@/lib/detect/rules/t05-nearmiss";
import { t06Inspection } from "@/lib/detect/rules/t06-inspection";
import { t07ScoreGap } from "@/lib/detect/rules/t07-score-gap";
import { t08NewWorker } from "@/lib/detect/rules/t08-new-worker";

// 감지 규칙 여덟 개. 순서는 규칙 번호를 따르고, 브리핑의 나열 순서도 이것을 쓴다.
// 넷(T-01 · T-02 · T-07 · T-08)은 숫자와 플래그 비교만으로 판정하고, 나머지 넷은
// 문서 추출 결과에 기댄다.
export const triggerRules: TriggerRule[] = [
  t01Weather,
  t02Followup,
  t03Material,
  t04Review,
  t05Nearmiss,
  t06Inspection,
  t07ScoreGap,
  t08NewWorker,
];

export const rulesById: Map<RuleId, TriggerRule> = new Map(
  triggerRules.map((rule) => [rule.id, rule]),
);

export function ruleLabel(ruleId: RuleId): string {
  return rulesById.get(ruleId)?.label ?? String(ruleId);
}

export {
  t01Weather,
  t02Followup,
  t03Material,
  t04Review,
  t05Nearmiss,
  t06Inspection,
  t07ScoreGap,
  t08NewWorker,
};
