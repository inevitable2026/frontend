import type {
  DetectInput,
  Detection,
  Evidence,
  FactType,
  Invalidation,
  Produces,
  SnapshotFact,
  TriggerRule,
} from "@/lib/board/types";
import { latestFacts } from "@/lib/detect/delta";

// T-05 아차사고 — 보고가 접수되고, 그 위험요인이 이미 회의록에 등재되어 있을 때 발화한다.
//
// 등재되어 있지 않은 위험은 새로 발견된 위험이라 다른 이야기가 된다. 여기서 중요한 것은
// "이미 알고 있었고 대책도 적어 두었는데 실제로는 실행되지 않았다"는 어긋남이다.
// 등재 여부는 lookup 으로 되짚는다.
//
// 보고서의 위험요인과 회의록의 위험요인은 사람이 다른 날 다른 말로 적은 자유 문장이라
// 글자가 똑같기를 기대할 수 없다. 그래서 단위작업을 축으로 잡고 위험요인·사고분류를
// 문자 이음(bigram) 겹침으로 견준다. 셋이 다 맞으면 확신도를 그대로 두고, 둘만 맞으면
// 낮춰서 낸다 — 어림짐작이었다는 사실이 카드에 남아야 한다.

const 단위작업_문턱 = 0.5;
const 위험요인_문턱 = 0.35;
const 부분일치_감쇠 = 0.85;

type 아차사고 = {
  위험요인: string;
  사고분류: string | null;
  단위작업: string;
  발생시각: string | null;
  장소: string | null;
  요지: string | null;
};

type 매칭 = { fact: SnapshotFact; 일치수: number; 점수: number; 이행확인: boolean | null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// lookup 이 감시 대상만 담고 있을 수 있으므로 비면 원본 facts 로 한 번 더 훑는다.
function factsOf(input: DetectInput, factType: FactType): SnapshotFact[] {
  const 목록 = input.lookup.factsOf(factType);
  if (목록.length > 0) return 목록;
  return input.facts.filter((f) => f.factType === factType);
}

// 같은 사실을 두 번 읽어 같은 카드를 두 장 만들지 않는다.
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

// 공백과 구두점을 걷어 낸다. "압송관 인근 통행 중" 과 "압송관인근통행중" 은 같은 말이다.
function squash(s: string): string {
  return s.replace(/[\s·,、.()[\]{}「」"'\-–—/]/g, "");
}

function bigrams(s: string): string[] {
  if (s.length < 2) return s.length === 1 ? [s] : [];
  const 목록: string[] = [];
  for (let i = 0; i < s.length - 1; i += 1) 목록.push(s.slice(i, i + 2));
  return 목록;
}

// Dice 계수. 짧은 자유 문장끼리 견주는 자리라 트라이그램보다 이음 두 자가 잘 맞는다.
function similar(a: string, b: string): number {
  const x = squash(a);
  const y = squash(b);
  if (x === "" || y === "") return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 1;
  const 왼쪽 = bigrams(x);
  const 오른쪽 = new Map<string, number>();
  for (const g of bigrams(y)) 오른쪽.set(g, (오른쪽.get(g) ?? 0) + 1);
  let 겹침 = 0;
  for (const g of 왼쪽) {
    const 남은 = 오른쪽.get(g) ?? 0;
    if (남은 > 0) {
      오른쪽.set(g, 남은 - 1);
      겹침 += 1;
    }
  }
  const 합 = 왼쪽.length + bigrams(y).length;
  return 합 === 0 ? 0 : (2 * 겹침) / 합;
}

function readReport(value: unknown): 아차사고 | null {
  if (!isRecord(value)) return null;
  const v = isRecord(value.extracted) ? value.extracted : value;

  const 위험요인 = text(v.위험요인) ?? text(v.hazard);
  const 단위작업 = text(v.단위작업) ?? text(v.task) ?? text(v.process);
  // 어느 작업의 무슨 위험인지 모르면 회의록과 짝지을 수 없다. 판단을 유보한다.
  if (!위험요인 || !단위작업) return null;

  return {
    위험요인,
    단위작업,
    사고분류: text(v.사고분류) ?? text(v.hazardClass) ?? text(v.분류),
    발생시각: text(v.발생시각) ?? text(v.occurredAt),
    장소: text(v.장소) ?? text(v.location) ?? text(v.locationLabel),
    요지: text(v.요지) ?? text(v.summary) ?? text(v.본문) ?? text(v.description),
  };
}

function rowId(f: SnapshotFact): string {
  const v = f.value;
  return (isRecord(v) ? (text(v.행id) ?? text(v.itemId) ?? text(v.rowId) ?? text(v.행번호)) : null) ?? f.key;
}

// 행이 실린 문서. 스냅샷을 채우는 쪽이 이 칸을 회의록 · 평가서 · assessmentId 어느
// 이름으로 적어 두었든 같은 뜻이라 다 받는다.
function rowDocId(f: SnapshotFact): string | null {
  const v = f.value;
  if (!isRecord(v)) return null;
  return text(v.assessmentId) ?? text(v.평가서) ?? text(v.회의록) ?? text(v.docId);
}

// 이행확인란. 표시가 없으면 null 이고, 그것은 "확인하지 않았다" 와 다르다.
function 이행확인(v: Record<string, unknown>): boolean | null {
  const r = v.이행확인 ?? v.verified ?? v.이행확인여부;
  return typeof r === "boolean" ? r : null;
}

function matchRow(보고: 아차사고, f: SnapshotFact): 매칭 | null {
  const v = f.value;
  if (!isRecord(v)) return null;

  const 행단위작업 = text(v.단위작업) ?? text(v.process);
  const 행위험요인 = text(v.위험요인) ?? text(v.hazard);
  if (!행단위작업 || !행위험요인) return null;

  const 작업점수 = similar(보고.단위작업, 행단위작업);
  if (작업점수 < 단위작업_문턱) return null;

  const 위험점수 = similar(보고.위험요인, 행위험요인);
  const 행사고분류 = text(v.사고분류) ?? text(v.hazardClass);
  const 분류일치 =
    보고.사고분류 !== null && 행사고분류 !== null && similar(보고.사고분류, 행사고분류) >= 위험요인_문턱;

  const 위험일치 = 위험점수 >= 위험요인_문턱;
  // 축이 되는 단위작업 외에 최소 하나는 더 맞아야 같은 행으로 본다.
  if (!위험일치 && !분류일치) return null;

  return {
    fact: f,
    일치수: 1 + (위험일치 ? 1 : 0) + (분류일치 ? 1 : 0),
    점수: 작업점수 + 위험점수,
    이행확인: 이행확인(v),
  };
}

export const t05Nearmiss: TriggerRule = {
  id: "T-05",
  label: "아차사고",
  watches: ["nearMissReport", "riskAssessmentRow"],

  detect(input: DetectInput): Detection[] {
    // 아무것도 바뀌지 않은 날 다시 돌려도 같은 카드가 또 올라오지 않도록, 감시 대상에
    // 변화가 없으면 사실 전체를 훑지 않고 그대로 돌아간다.
    if (input.deltas.length === 0) return [];

    // 한 아차사고에 접수 · 대조 완료 같은 여러 판본이 쌓인다. 자리마다 최신 한 건만
    // 판정해야 같은 사건으로 카드가 두 벌 생기지 않는다. 근거의 observedAt 이 달라
    // 엔진의 서명 중복 제거로는 걸러지지 않는다.
    const 보고목록 = latestFacts(factsOf(input, "nearMissReport"));
    const 행목록 = latestFacts(factsOf(input, "riskAssessmentRow"));
    // 보고가 없거나 대조할 회의록이 없으면 판단을 유보한다.
    if (보고목록.length === 0 || 행목록.length === 0) return [];

    const 직전 = input.lookup.lastDetection("T-05");
    const 결과: Detection[] = [];

    for (const 보고 of 보고목록) {
      const 내용 = readReport(보고.value);
      if (!내용) continue;

      const 후보 = 행목록
        .map((f) => matchRow(내용, f))
        .filter((m): m is 매칭 => m !== null)
        .sort((a, b) => b.일치수 - a.일치수 || b.점수 - a.점수);

      // 등재되어 있지 않은 위험이면 이 규칙의 이야기가 아니다.
      if (후보.length === 0) continue;

      const 최적 = 후보[0];
      const 행 = 최적.fact;
      const 행값 = isRecord(행.value) ? 행.value : {};
      const 행이름 = text(행값.단위작업) ?? text(행값.process) ?? rowId(행);
      const 표시어긋남 = 최적.이행확인 === true;
      const 대상문서 = rowDocId(행);

      const evidence: Evidence[] = [
        {
          factType: "nearMissReport",
          key: 보고.key,
          observedAt: 보고.observedAt,
          sourceDocId: 보고.sourceDocId,
          excerpt: [내용.단위작업, 내용.위험요인, 내용.사고분류, 내용.장소, 내용.요지]
            .filter(Boolean)
            .join(" · "),
        },
        {
          factType: "riskAssessmentRow",
          key: 행.key,
          observedAt: 행.observedAt,
          sourceDocId: 행.sourceDocId,
          excerpt: [
            `${rowId(행)} ${행이름}`,
            text(행값.위험요인) ?? text(행값.hazard),
            최적.이행확인 === null
              ? "이행확인 표시 없음"
              : 최적.이행확인
                ? "이행확인 표시 있음"
                : "이행확인 미표시",
          ]
            .filter(Boolean)
            .join(" · "),
        },
      ];

      const invalidates: Invalidation[] = 대상문서
        ? [
            {
              docId: 대상문서,
              scope: `${rowId(행)} ${행이름} 행의 이행확인란`,
              reason: 표시어긋남
                ? "표시되어 있었으나 실제로는 미실행이었음이 아차사고로 드러났습니다."
                : "등재된 대책이 현장에서 작동하지 않았음이 아차사고로 드러났습니다.",
            },
          ]
        : [];

      const produces: Produces[] = [
        { form: "기록", for: "아차사고 보고서" },
        // 재발방지 대책은 새 문서가 아니라 이미 있는 행의 보완이다.
        { form: "회의록", count: 1, ...(대상문서 ? { into: 대상문서 } : {}) },
        { form: "TBM자료", for: "전 공종 전파" },
      ];

      const 감지: Detection = {
        ruleId: "T-05",
        siteId: input.siteId,
        detectedAt: 보고.observedAt,
        confidence: Math.min(
          1,
          Math.max(0, 보고.confidence * (최적.일치수 === 3 ? 1 : 부분일치_감쇠)),
        ),
        evidence,
        invalidates,
        produces,
        summary: 표시어긋남
          ? `${내용.단위작업} 아차사고가 접수됐고 같은 위험요인이 회의록 ${rowId(행)} 행에 이미 등재되어 있습니다. 그 행의 이행확인란에는 표시가 있었으나 실제로는 실행되지 않았습니다.`
          : `${내용.단위작업} 아차사고가 접수됐고 같은 위험요인이 회의록 ${rowId(행)} 행에 이미 등재되어 있습니다. 등재된 대책이 현장에서 작동하지 않았습니다.`,
      };

      if (alreadyReported(직전, 감지)) continue;
      결과.push(감지);
    }

    return 결과;
  },
};
