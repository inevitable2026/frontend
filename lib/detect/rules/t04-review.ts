import type {
  DetectInput,
  Detection,
  Evidence,
  FactType,
  Invalidation,
  SnapshotFact,
  TriggerRule,
} from "@/lib/board/types";
import { latestFacts } from "@/lib/detect/delta";

// T-04 감리 피드백 — 외부 검토 의견이 접수되고 회신 기한이 붙었을 때 발화한다.
//
// 여기서 드러나는 것은 내용 결함이 아니라 형식 결함이다. 법적 근거란이 비었고 개선 후
// 위험도가 없는 행은 그대로 결재에 올릴 수 없다. 그래서 판정 결과에는 지적 대상 행의
// 개수와 그 안에서 어떤 칸이 비었는지가 함께 실린다 — 숫자가 없으면 사람이 다시 센다.
//
// 규칙은 네트워크를 부르지 않는다. 회신 기한과 지적 대상은 이미 externalReviewComment
// 사실로 들어와 있다고 전제하고, 없으면 조용히 빈 배열을 돌려준다.

// 근거 칩이 화면 한 줄을 넘지 않도록 행 표본만 싣는다. 전체 개수는 summary 와
// invalidates 에 이미 들어 있다.
const 행표본상한 = 3;

type 검토의견 = {
  발신처: string | null;
  replyDueBy: string;
  대상행: string[];
  대상문서: string | null;
  선언된근거공란: number | null;
  선언된개선후미기재: number | null;
  요지: string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => (text(e) ?? (isRecord(e) ? (text(e.itemId) ?? text(e.행) ?? text(e.rowId)) : null))).filter(
    (e): e is string => e !== null,
  );
}

// lookup 이 감시 대상만 담고 있을 수 있으므로 비면 원본 facts 로 한 번 더 훑는다.
function factsOf(input: DetectInput, factType: FactType): SnapshotFact[] {
  const 목록 = input.lookup.factsOf(factType);
  if (목록.length > 0) return 목록;
  return input.facts.filter((f) => f.factType === factType);
}

// 같은 사실을 두 번 읽어 같은 카드를 두 장 만들지 않는다. 근거 키 집합까지 같고
// 직전 감지가 더 늦게 찍혔을 때에만 이미 보고한 것으로 본다.
function alreadyReported(직전: Detection | null, 감지: Detection): boolean {
  if (!직전) return false;
  const key = (d: Detection) =>
    d.evidence
      .map((e) => `${e.factType}:${e.key}`)
      .sort()
      .join("|");
  if (key(직전) !== key(감지)) return false;
  const a = Date.parse(직전.detectedAt);
  const b = Date.parse(감지.detectedAt);
  return !Number.isNaN(a) && !Number.isNaN(b) && a >= b;
}

// 받침이 있으면 "이", 없으면 "가". 발신처 이름이 데이터에서 오므로 조사를 붙여 짓는다.
function josaIGa(단어: string): string {
  const 끝 = 단어.trim().slice(-1);
  const 코드 = 끝.charCodeAt(0);
  if (Number.isNaN(코드) || 코드 < 0xac00 || 코드 > 0xd7a3) return "가";
  return (코드 - 0xac00) % 28 === 0 ? "가" : "이";
}

function readComment(value: unknown): 검토의견 | null {
  if (!isRecord(value)) return null;
  const v = isRecord(value.extracted) ? value.extracted : value;

  // 회신 기한이 없는 의견은 일정을 만들지 않는다. 판단을 유보한다.
  const replyDueBy = text(v.replyDueBy) ?? text(v.회신기한);
  if (!replyDueBy) return null;

  return {
    발신처: text(v.발신처) ?? text(v.검토주체) ?? text(v.reviewer) ?? text(v.authority) ?? text(v.기관),
    replyDueBy,
    대상행: [
      ...strings(v.targetRows),
      ...strings(v.대상행),
      ...strings(v.지적대상행),
      ...strings(v.rows),
      ...strings(v.rowIds),
    ],
    대상문서:
      text(v.targetDocId) ?? text(v.대상문서) ?? text(v.docId) ?? text(v.assessmentId) ?? text(v.회의록),
    선언된근거공란: num(v.legalRefMissing) ?? num(v.법적근거공란),
    선언된개선후미기재: num(v.residualMissing) ?? num(v.개선후미기재),
    요지: text(v.summary) ?? text(v.요지) ?? text(v.본문),
  };
}

function rowId(f: SnapshotFact): string {
  const v = f.value;
  return (isRecord(v) ? (text(v.행id) ?? text(v.itemId) ?? text(v.rowId) ?? text(v.행번호)) : null) ?? f.key;
}

// 행이 어느 문서에 실려 있는지. 스냅샷을 채우는 쪽이 이 칸을 회의록 · 평가서 ·
// assessmentId 어느 이름으로 적어 두었든 같은 뜻이라 다 받는다.
function rowDocId(f: SnapshotFact): string | null {
  const v = f.value;
  if (!isRecord(v)) return null;
  return text(v.assessmentId) ?? text(v.평가서) ?? text(v.회의록) ?? text(v.docId);
}

function rowLabel(f: SnapshotFact): string {
  const v = f.value;
  const 이름 = isRecord(v) ? (text(v.단위작업) ?? text(v.process) ?? text(v.위험요인)) : null;
  return 이름 ?? rowId(f);
}

// 법적 근거란이 비었나. 문자열이면 공백, 배열이면 길이 0, 값 자체가 없어도 공란이다.
function 법적근거공란(v: Record<string, unknown>): boolean {
  const r = v.법적근거 ?? v.legalReferences ?? v.legalBasis;
  if (r === null || r === undefined) return true;
  if (typeof r === "string") return r.trim() === "";
  if (Array.isArray(r)) return r.length === 0;
  return false;
}

// 개선 후 위험도가 비었나. 점수 칸이 숫자로 채워져 있어야 기재된 것으로 본다.
function 개선후미기재(v: Record<string, unknown>): boolean {
  const r = v.개선후 ?? v.residualRisk ?? v.개선후위험도;
  if (r === null || r === undefined) return true;
  if (isRecord(r)) return num(r.위험도) === null && num(r.score) === null;
  return num(r) === null;
}

export const t04Review: TriggerRule = {
  id: "T-04",
  label: "감리 피드백",
  watches: ["externalReviewComment", "riskAssessmentRow"],

  detect(input: DetectInput): Detection[] {
    // 아무것도 바뀌지 않은 날 다시 돌려도 같은 카드가 또 올라오지 않도록, 감시 대상에
    // 변화가 없으면 사실 전체를 훑지 않고 그대로 돌아간다.
    if (input.deltas.length === 0) return [];

    const 의견목록 = factsOf(input, "externalReviewComment");
    // 같은 행이 여러 판본으로 들어와 있으면 최신 한 건만 센다. 옛 판본까지 세면 지적
    // 행수가 부풀고 이미 채운 칸이 공란으로 남아 있는 것처럼 보인다.
    const 행목록 = latestFacts(factsOf(input, "riskAssessmentRow"));
    // 의견이 없거나 대조할 회의록 행이 없으면 판단을 유보한다.
    if (의견목록.length === 0 || 행목록.length === 0) return [];

    // 행은 사실 키로도, 값 안의 행 번호로도 지목된다. 둘 다 받는다.
    const 행색인 = new Map<string, SnapshotFact>();
    for (const f of 행목록) {
      행색인.set(f.key, f);
      행색인.set(rowId(f), f);
    }

    const 직전 = input.lookup.lastDetection("T-04");
    const 결과: Detection[] = [];

    for (const 의견 of 의견목록) {
      const 내용 = readComment(의견.value);
      if (!내용) continue;

      // 지적 대상 행이 명시되어 있으면 그것부터 짚는다. 문서도 행도 지목되지 않았다면
      // 어느 행을 고쳐야 하는지 알 수 없으므로 판단을 유보한다.
      let 대상: SnapshotFact[] = [];
      if (내용.대상행.length > 0) {
        const 본것 = new Set<string>();
        for (const id of 내용.대상행) {
          // 행 번호는 문서 안에서만 유일하다. 대상 문서를 아는 동안에는 그것까지 붙인
          // 사실 키로 먼저 짚고, 그래도 없으면 행 번호만으로 한 번 더 본다.
          const f = (내용.대상문서 ? 행색인.get(`${내용.대상문서}#${id}`) : undefined) ?? 행색인.get(id);
          if (!f || 본것.has(f.key)) continue;
          본것.add(f.key);
          대상.push(f);
        }
      }
      // 지적 대상 행이 하나도 해석되지 않았다면(행 번호 표기가 다르거나 행이 아직 안
      // 들어왔다면) 대상 문서에서 결함이 있는 행을 직접 짚는다.
      if (대상.length === 0 && 내용.대상문서) {
        대상 = 행목록.filter((f) => {
          if (rowDocId(f) !== 내용.대상문서) return false;
          const v = f.value;
          return isRecord(v) && (법적근거공란(v) || 개선후미기재(v));
        });
      }
      if (대상.length === 0) continue;

      let 근거공란수 = 0;
      let 개선후미기재수 = 0;
      for (const f of 대상) {
        const v = f.value;
        if (!isRecord(v)) continue;
        if (법적근거공란(v)) 근거공란수 += 1;
        if (개선후미기재(v)) 개선후미기재수 += 1;
      }
      // 행이 하나도 해석되지 않았다면 문서가 스스로 밝힌 숫자를 쓴다. 그것도 없으면
      // 개수를 지어내지 않고 총계만 말한다.
      if (근거공란수 === 0 && 개선후미기재수 === 0) {
        근거공란수 = 내용.선언된근거공란 ?? 0;
        개선후미기재수 = 내용.선언된개선후미기재 ?? 0;
      }

      const 대상문서 = 내용.대상문서 ?? rowDocId(대상[0]);
      const 발신처 = 내용.발신처 ?? "외부 검토 주체";
      const 내역 =
        근거공란수 + 개선후미기재수 > 0
          ? ` — 법적 근거란 공란 ${근거공란수}행 · 개선 후 위험도 미기재 ${개선후미기재수}행`
          : "";

      const evidence: Evidence[] = [
        {
          factType: "externalReviewComment",
          key: 의견.key,
          observedAt: 의견.observedAt,
          sourceDocId: 의견.sourceDocId,
          excerpt: [발신처, `지적 ${대상.length}행`, `회신 기한 ${내용.replyDueBy}`, 내용.요지]
            .filter(Boolean)
            .join(" · "),
        },
        ...대상.slice(0, 행표본상한).map((f) => {
          const v = isRecord(f.value) ? f.value : {};
          const 결함 = [법적근거공란(v) ? "법적 근거란 공란" : null, 개선후미기재(v) ? "개선 후 위험도 미기재" : null]
            .filter(Boolean)
            .join(" · ");
          return {
            factType: "riskAssessmentRow" as const,
            key: f.key,
            observedAt: f.observedAt,
            sourceDocId: f.sourceDocId,
            excerpt: [rowLabel(f), 결함 || "지적 대상"].join(" · "),
          };
        }),
      ];

      const invalidates: Invalidation[] = 대상문서
        ? [
            {
              docId: 대상문서,
              scope: `지적 대상 ${대상.length}개 행`,
              reason: "형식 결함이 확정된 상태라 그대로는 결재 상신할 수 없습니다.",
            },
          ]
        : [];

      const 감지: Detection = {
        ruleId: "T-04",
        siteId: input.siteId,
        detectedAt: 의견.observedAt,
        confidence: Math.min(1, Math.max(0, 의견.confidence)),
        evidence,
        invalidates,
        // 무엇을 만들지는 규칙이 정하지 않는다. lib/generate/cards.ts 가 근거를 읽고
        // 정한 뒤 엔진이 여기 채워 넣는다.
        produces: [],
        summary: `${발신처}${josaIGa(발신처)} 회의록 ${대상.length}개 행을 지적했습니다${내역}. 회신 기한은 ${내용.replyDueBy}입니다.`,
      };

      if (alreadyReported(직전, 감지)) continue;
      결과.push(감지);
    }

    return 결과;
  },
};
