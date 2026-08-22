import type { Detection, Evidence, SnapshotFact, TriggerRule } from "@/lib/board/types";
import {
  asRecord,
  latestFacts,
  readBoolean,
  readNumber,
  readRiskRow,
  readRiskScore,
  readString,
  scoreText,
  type RiskAssessmentRowValue,
  type RiskScoreValue,
} from "@/lib/detect/delta";

// T-07 추천값 이격
//
// 회의록 등재 행마다 추천값이 붙는다. reviewRequired 가 참이고 추천 위험도와 등재된
// 개선 전 위험도의 차이가 임계치를 넘으면 그 행을 판정 대상으로 올린다.
//
// 값을 자동으로 바꾸지 않는다. 시나리오의 추천은 originState "DEGRADED" · confidence
// "low" 라 표본이 흔들린 상태이고, 위험도 산정의 책임은 사람에게 있다. 카드가 하는 일은
// 행별 채택 또는 기각 판정과 그 사유를 남기는 것이다.

// 위험도(빈도 × 강도) 차이. 시나리오의 콘크리트 타설 및 다짐 행은 4×3=12 대 5×4=20 이다.
export const SCORE_GAP_THRESHOLD = 4;

// 근거가 흔들린 상태로 들어온 추천. 자동 반영을 막는다.
const DEGRADED_STATES = ["DEGRADED", "STALE", "PARTIAL"];
const WEAK_CONFIDENCE = ["low", "낮음"];

type Recommendation = {
  docId: string | null;
  행id: string | null;
  단위작업: string | null;
  추천: RiskScoreValue;
  reviewRequired: boolean;
  originState: string | null;
  confidence: string | null;
  표본수: number | null;
  사고건수: number | null;
  사망사고건수: number | null;
};

function readRecommendation(fact: SnapshotFact): Recommendation | null {
  const record = asRecord(fact.value);
  if (!record) return null;
  const 추천 = readRiskScore(record["추천"] ?? record["recommendation"] ?? record);
  if (!추천) return null;
  const 통계 = record["통계"] ?? record["stats"] ?? null;
  return {
    docId: readString(fact.value, "docId", "assessmentId"),
    행id: readString(fact.value, "행id", "itemId", "rowId"),
    단위작업: readString(fact.value, "단위작업", "task", "작업"),
    추천,
    reviewRequired: readBoolean(fact.value, "reviewRequired", "검토필요") ?? false,
    originState: readString(fact.value, "originState", "출처상태"),
    confidence: readString(fact.value, "confidence", "신뢰도"),
    표본수: readNumber(통계, "표본수", "sampleCount"),
    사고건수: readNumber(통계, "사고건수", "accidentCount"),
    사망사고건수: readNumber(통계, "사망사고건수", "fatalityCount"),
  };
}

function sameRow(row: RiskAssessmentRowValue, rec: Recommendation): boolean {
  if (rec.행id && row.행id) return rec.행id === row.행id;
  if (rec.단위작업 && row.단위작업) return rec.단위작업 === row.단위작업;
  return false;
}

function degraded(rec: Recommendation): boolean {
  if (rec.originState && DEGRADED_STATES.includes(rec.originState.toUpperCase())) return true;
  return !!rec.confidence && WEAK_CONFIDENCE.includes(rec.confidence.toLowerCase());
}

function evidenceOf(fact: SnapshotFact, excerpt: string): Evidence {
  return {
    factType: fact.factType,
    key: fact.key,
    observedAt: fact.observedAt,
    sourceDocId: fact.sourceDocId,
    excerpt,
  };
}

type Gap = {
  recFact: SnapshotFact;
  rowFact: SnapshotFact;
  rec: Recommendation;
  row: RiskAssessmentRowValue;
  개선전: RiskScoreValue;
  이격: number;
};

export const t07ScoreGap: TriggerRule = {
  id: "T-07",
  label: "추천값 이격",
  watches: ["riskRecommendation", "riskAssessmentRow"],

  detect(input): Detection[] {
    if (input.deltas.length === 0) return [];

    const rows = latestFacts(input.lookup.factsOf("riskAssessmentRow"))
      .map((fact) => ({ fact, row: readRiskRow(fact.value) }))
      .filter((entry): entry is { fact: SnapshotFact; row: RiskAssessmentRowValue } => entry.row !== null);

    const gaps: Gap[] = [];

    for (const fact of latestFacts(input.lookup.factsOf("riskRecommendation"))) {
      const rec = readRecommendation(fact);
      if (!rec || !rec.reviewRequired) continue;

      const matched = rows.find((entry) => sameRow(entry.row, rec));
      const 개선전 = matched?.row.개선전 ?? null;
      if (!matched || !개선전) continue;

      const 이격 = Math.abs(rec.추천.위험도 - 개선전.위험도);
      if (이격 < SCORE_GAP_THRESHOLD) continue;

      gaps.push({ recFact: fact, rowFact: matched.fact, rec, row: matched.row, 개선전, 이격 });
    }

    if (gaps.length === 0) return [];

    // 회의록 한 권이 판정 단위다. 21행이 걸려도 카드는 한 장이고 그 안에서 행별로 판정한다.
    const books = new Map<string, Gap[]>();
    for (const gap of gaps) {
      const docId = gap.rec.docId ?? gap.row.docId ?? gap.rowFact.sourceDocId ?? gap.rowFact.key;
      const bucket = books.get(docId);
      if (bucket) bucket.push(gap);
      else books.set(docId, [gap]);
    }

    const detections: Detection[] = [];

    for (const [docId, bucket] of books) {
      bucket.sort((a, b) => b.이격 - a.이격);
      const worst = bucket[0];
      const shaky = bucket.filter((gap) => degraded(gap.rec));
      const 표본 = worst.rec.표본수;
      const 사망 = worst.rec.사망사고건수;

      // 근거가 흔들린 추천이 섞여 있으면 감지 자체의 확신도를 낮춰 둔다.
      const confidence = shaky.length > 0 ? 0.85 : 0.95;

      const evidence: Evidence[] = bucket.slice(0, 3).flatMap((gap) => [
        evidenceOf(
          gap.recFact,
          `${gap.rec.단위작업 ?? gap.rec.행id ?? gap.recFact.key} 추천 ${scoreText(gap.rec.추천)}${
            gap.rec.표본수 !== null ? ` · 표본 ${gap.rec.표본수}건` : ""
          }${gap.rec.사망사고건수 !== null ? ` · 사망 ${gap.rec.사망사고건수}건` : ""}${
            gap.rec.originState ? ` · ${gap.rec.originState}` : ""
          }`,
        ),
        evidenceOf(
          gap.rowFact,
          `${gap.row.단위작업 ?? gap.rowFact.key} 등재 개선 전 위험도 ${scoreText(gap.개선전)} · 이격 ${gap.이격}`,
        ),
      ]);

      const headline = `${worst.row.단위작업 ?? "해당"} 행은 현재 ${scoreText(worst.개선전)} 대 추천 ${scoreText(
        worst.rec.추천,
      )} 입니다.`;
      const sample =
        표본 !== null ? ` 표본 ${표본}건${사망 !== null ? ` · 사망 ${사망}건` : ""} 기준입니다.` : "";
      const guard =
        shaky.length > 0
          ? " 추천의 근거 상태가 흔들려(originState · confidence) 자동 반영하지 않습니다."
          : "";

      detections.push({
        ruleId: "T-07",
        siteId: input.siteId,
        detectedAt: input.now,
        confidence,
        evidence,
        invalidates: [
          {
            docId,
            scope: `${bucket.length}개 행의 개선 전 위험도 산정`,
            reason: "추천값과의 이격이 커 판정 대기 상태가 되었습니다. 값 자체가 지워지는 것은 아닙니다.",
          },
        ],
        produces: [
          {
            form: "기록",
            for: `추천 위험도 이격 ${bucket.length}행 채택·기각 판정`,
            count: bucket.length,
            into: docId,
          },
        ],
        summary: `등재 행 ${bucket.length}건이 추천 위험도와 어긋납니다. ${headline}${sample}${guard}`,
      });
    }

    return detections;
  },
};
