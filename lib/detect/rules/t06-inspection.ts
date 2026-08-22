import type {
  DetectInput,
  Detection,
  Evidence,
  FactType,
  Produces,
  SnapshotFact,
  TriggerRule,
} from "@/lib/board/types";

// T-06 점검 예고 — 감독기관이나 외부 기관의 공문이 접수되고, 방문일이나 자료 제출
// 기한이 붙어 있을 때 발화한다.
//
// 이 규칙은 아무 문서도 무효화하지 않는다. 점검 예고가 회의록의 내용을 틀리게 만들지는
// 않기 때문이다. 대신 최근 몇 개월치 문서가 지금 제출 가능한 상태인지 — 즉 결재가
// 끝났는지 — 가 드러난다. 밀려 있던 결재가 이 시점에 문제가 된다.
// 그래서 invalidates 는 항상 빈 배열이고, 산출물은 문서별 결재 상태를 담은 점검표다.
//
// 규칙은 네트워크를 부르지 않는다. 공문 추출과 결재 상태는 이미 사실로 들어와 있다고
// 전제하고, 없으면 조용히 빈 배열을 돌려준다.

// 근거 칩에는 밀린 문서 표본만 싣는다. 전체 개수는 summary 와 점검표에 들어 있다.
const 문서표본상한 = 3;

// 공문이 대상 기간을 밝히지 않았을 때 되짚어 볼 범위. 감독기관 자료 요구는 관행적으로
// 최근 3개월치이고, 시나리오의 요구도 그렇다.
const 기본_대상개월 = 3;

type 점검공문 = {
  기관: string | null;
  visitDate: string | null;
  방문시각: string | null;
  submitDueBy: string | null;
  요구자료: string[];
  대상개월: number | null;
  기간시작: string | null;
  기간끝: string | null;
};

type 문서상태 = { 제목: string; 완료: boolean; 상태표기: string; 일자: string | null };

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
  return v.map((e) => text(e) ?? (isRecord(e) ? text(e.제목) ?? text(e.title) : null)).filter(
    (e): e is string => e !== null,
  );
}

// lookup 이 감시 대상만 담고 있을 수 있으므로 비면 원본 facts 로 한 번 더 훑는다.
function factsOf(input: DetectInput, factType: FactType): SnapshotFact[] {
  const 목록 = input.lookup.factsOf(factType);
  if (목록.length > 0) return 목록;
  return input.facts.filter((f) => f.factType === factType);
}

// KST 'YYYY-MM-DD'. Date 객체로 왕복시키면 UTC 로 도는 서버리스 함수에서 하루가 밀린다.
function kstDate(시각: string): string {
  const s = 시각.trim();
  if (/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+\+09:00)?$/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s.slice(0, 10);
  return new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' 문자열 산술. Date 를 거치지 않으므로 시간대가 끼어들 자리가 없다.
function monthsBefore(날짜: string, 개월: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(날짜);
  if (!m) return 날짜;
  const 연 = Number(m[1]);
  const 월 = Number(m[2]);
  const 일 = Number(m[3]);
  const 총월 = 연 * 12 + (월 - 1) - 개월;
  const 새연 = Math.floor(총월 / 12);
  const 새월 = (((총월 % 12) + 12) % 12) + 1;
  const 말일 = new Date(Date.UTC(새연, 새월, 0)).getUTCDate();
  const 새일 = Math.min(일, 말일);
  return `${String(새연).padStart(4, "0")}-${String(새월).padStart(2, "0")}-${String(새일).padStart(2, "0")}`;
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

function readNotice(value: unknown): 점검공문 | null {
  if (!isRecord(value)) return null;
  const v = isRecord(value.extracted) ? value.extracted : value;

  const visitDate = text(v.visitDate) ?? text(v.방문일);
  const submitDueBy = text(v.submitDueBy) ?? text(v.제출기한);
  // 방문일도 제출 기한도 없으면 일정이 서지 않는다. 판단을 유보한다.
  if (!visitDate && !submitDueBy) return null;

  const 기간: Record<string, unknown> = isRecord(v.대상기간) ? v.대상기간 : isRecord(v.period) ? v.period : {};

  return {
    기관: text(v.기관) ?? text(v.발신기관) ?? text(v.authority) ?? text(v.from),
    visitDate,
    방문시각: text(v.방문시각) ?? text(v.visitTime),
    submitDueBy,
    요구자료: [...strings(v.요구자료), ...strings(v.requestedDocuments), ...strings(v.documents)],
    대상개월: num(v.대상개월수) ?? num(v.months) ?? num(v.요구개월수),
    기간시작: text(기간.from) ?? text(기간.시작),
    기간끝: text(기간.to) ?? text(기간.끝),
  };
}

// 결재가 끝났나. 문서함마다 표기가 다르므로 완료로 읽히는 말만 참으로 본다.
const 완료표기 = new Set(["결재완료", "완료", "승인", "승인완료", "approved", "completed"]);

function readApproval(f: SnapshotFact): 문서상태 | null {
  const v = f.value;
  if (!isRecord(v)) return null;
  const 표기 = text(v.상태) ?? text(v.결재상태) ?? text(v.approvalState) ?? text(v.status);
  const 불린 = typeof v.approved === "boolean" ? v.approved : typeof v.결재완료 === "boolean" ? v.결재완료 : null;
  if (표기 === null && 불린 === null) return null;

  return {
    제목: text(v.제목) ?? text(v.title) ?? text(v.종류) ?? text(v.kind) ?? f.key,
    완료: 불린 ?? (표기 !== null && (완료표기.has(표기) || 완료표기.has(표기.toLowerCase()))),
    상태표기: 표기 ?? (불린 ? "결재완료" : "결재 미완"),
    일자: text(v.일자) ?? text(v.date) ?? text(v.occurredAt) ?? text(v.기준일),
  };
}

export const t06Inspection: TriggerRule = {
  id: "T-06",
  label: "점검 예고",
  watches: ["officialNotice", "documentApprovalState"],

  detect(input: DetectInput): Detection[] {
    // 아무것도 바뀌지 않은 날 다시 돌려도 같은 카드가 또 올라오지 않도록, 감시 대상에
    // 변화가 없으면 사실 전체를 훑지 않고 그대로 돌아간다.
    if (input.deltas.length === 0) return [];

    const 공문목록 = factsOf(input, "officialNotice");
    if (공문목록.length === 0) return [];

    const 결재목록 = factsOf(input, "documentApprovalState");
    const 오늘 = kstDate(input.now);
    const 직전 = input.lookup.lastDetection("T-06");
    const 결과: Detection[] = [];

    for (const 공문 of 공문목록) {
      const 내용 = readNotice(공문.value);
      if (!내용) continue;

      // 되짚을 범위. 공문이 기간을 밝혔으면 그것을 쓰고, 개월 수만 밝혔으면 방문일에서
      // 거슬러 센다. 아무것도 없으면 관행대로 최근 석 달을 본다.
      const 끝 = 내용.기간끝 ?? (내용.visitDate ? kstDate(내용.visitDate) : 오늘);
      const 시작 = 내용.기간시작 ?? monthsBefore(끝, 내용.대상개월 ?? 기본_대상개월);

      const 대상문서: Array<{ fact: SnapshotFact; 상태: 문서상태 }> = [];
      for (const f of 결재목록) {
        const 상태 = readApproval(f);
        if (!상태) continue;
        // 일자를 모르는 문서는 범위 밖이라고 단정하지 않고 남겨 둔다.
        if (상태.일자 !== null) {
          const d = kstDate(상태.일자);
          if (d < 시작 || d > 끝) continue;
        }
        대상문서.push({ fact: f, 상태 });
      }

      const 미완 = 대상문서.filter((d) => !d.상태.완료);
      const 기관 = 내용.기관 ?? "감독기관";
      const 일정 = [
        내용.visitDate ? `방문 ${내용.visitDate}${내용.방문시각 ? ` ${내용.방문시각}` : ""}` : null,
        내용.submitDueBy ? `자료 제출 기한 ${내용.submitDueBy}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      const evidence: Evidence[] = [
        {
          factType: "officialNotice",
          key: 공문.key,
          observedAt: 공문.observedAt,
          sourceDocId: 공문.sourceDocId,
          excerpt: [기관, 일정, `대상 기간 ${시작} ~ ${끝}`, 내용.요구자료.join(", ") || null]
            .filter(Boolean)
            .join(" · "),
        },
        ...미완.slice(0, 문서표본상한).map(({ fact, 상태 }) => ({
          factType: "documentApprovalState" as const,
          key: fact.key,
          observedAt: fact.observedAt,
          sourceDocId: fact.sourceDocId,
          excerpt: [상태.제목, 상태.일자, 상태.상태표기].filter(Boolean).join(" · "),
        })),
      ];

      const produces: Produces[] = [
        {
          form: "점검표",
          ...(대상문서.length > 0 ? { count: 대상문서.length } : {}),
          for: "제출 자료 목록과 문서별 결재 완료 상태",
        },
      ];

      const 상태문장 =
        대상문서.length === 0
          ? "제출 대상 문서의 결재 상태가 아직 확인되지 않았습니다."
          : 미완.length === 0
            ? `대상 기간 문서 ${대상문서.length}건은 모두 결재가 끝나 그대로 제출할 수 있습니다.`
            : `대상 기간 문서 ${대상문서.length}건 가운데 ${미완.length}건이 결재 미완이라 지금 상태로는 제출할 수 없습니다.`;

      const 감지: Detection = {
        ruleId: "T-06",
        siteId: input.siteId,
        detectedAt: 공문.observedAt,
        confidence: Math.min(1, Math.max(0, 공문.confidence)),
        evidence,
        // 점검 예고는 어떤 문서도 틀리게 만들지 않는다. 드러나는 것은 제출 가능 여부뿐이다.
        invalidates: [],
        produces,
        summary: `${기관} 점검 예고 — ${일정 || `대상 기간 ${시작} ~ ${끝}`}. ${상태문장}`,
      };

      if (alreadyReported(직전, 감지)) continue;
      결과.push(감지);
    }

    return 결과;
  },
};
