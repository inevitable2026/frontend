import type {
  DetectInput,
  DetectLookup,
  Detection,
  Evidence,
  FactType,
  Invalidation,
  SnapshotFact,
  TriggerRule,
} from "@/lib/board/types";

// T-03 자재 변경 — 이 제품의 주 서사다.
//
// 메일 한 통에서 뽑은 추출 결과가 현장 스냅샷의 자재에 닿고, 그 자재가 붙은 공종이
// 아직 끝나지 않았을 때에만 발화한다. 세 사실이 모두 있어야 하고 하나라도 비면
// 아무 말도 하지 않는다 — 그것이 "판단을 유보한다"의 구현이다.
//
// 이 파일은 네트워크를 부르지 않는다. 첨부 PDF 의 추출은 이미 documentExtraction
// 사실로 들어와 있다고 전제한다.

// 혼용 시공은 세 자리에서 위험을 만든다 — 조립(좌굴) · 두 방식이 만나는 경계 구간
// (하중 전달 불연속) · 타설 중 변형 감시.
//
// 예전에는 그것을 `신규평가행수 = 3` 이라는 상수로 못 박아 회의록 신규 행이 언제나 세 줄
// 이었다. 이 규칙이 다루는 것은 시스템동바리 대체만이 아니고, 자재가 무엇으로 바뀌느냐에
// 따라 새로 평가해야 할 자리는 하나일 수도 다섯일 수도 있다. 그 판단은 근거를 읽는 쪽
// (lib/generate/cards.ts)이 한다.

type 자재변경 = {
  fromCode: string;
  fromLabel: string;
  toCode: string | null;
  toLabel: string;
  spec: string | null;
  floor: string | null;
  grid: string | null;
  areaSqm: number | null;
  maxHeightM: number | null;
  targetDate: string | null;
  mixed: boolean;
  counterparty: string | null;
};

type 공정 = { taskId: string; label: string; start: string | null; end: string | null };

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
  return v.map((e) => text(e)).filter((e): e is string => e !== null);
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

function thousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// 받침이 없거나 'ㄹ' 받침이면 "로", 그 밖에는 "으로".
function josaRo(단어: string): string {
  const 끝 = 단어.trim().slice(-1);
  const 코드 = 끝.charCodeAt(0);
  if (Number.isNaN(코드) || 코드 < 0xac00 || 코드 > 0xd7a3) return "로";
  const 종성 = (코드 - 0xac00) % 28;
  return 종성 === 0 || 종성 === 8 ? "로" : "으로";
}

// 같은 사실을 두 번 읽어 같은 카드를 두 장 만들지 않는다. 근거 키 집합까지 같고
// 직전 감지가 더 늦게 찍혔을 때에만 이미 보고한 것으로 본다 — 시각만 비교하면
// 뒤늦게 도착한 다른 문서가 억울하게 묻힌다.
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

function readSubstitution(value: unknown): 자재변경 | null {
  if (!isRecord(value)) return null;
  // 문서 추출 결과는 extracted 아래에 한 겹 더 들어오기도 한다.
  const v = isRecord(value.extracted) ? value.extracted : value;
  if (text(v.changeType) !== "materialSubstitution") return null;

  const from = isRecord(v.fromMaterial) ? v.fromMaterial : null;
  const to = isRecord(v.toMaterial) ? v.toMaterial : null;
  const fromCode = from ? text(from.code) : null;
  if (!fromCode) return null;

  const scope: Record<string, unknown> = isRecord(v.scope) ? v.scope : {};
  const grid = text(scope.grid);

  return {
    fromCode,
    fromLabel: (from ? text(from.label) : null) ?? fromCode,
    toCode: to ? text(to.code) : null,
    toLabel: (to ? text(to.label) : null) ?? "대체 자재",
    spec: to ? text(to.spec) : null,
    floor: text(scope.floor),
    grid,
    areaSqm: num(scope.areaSqm),
    maxHeightM: num(scope.maxHeightM),
    targetDate: text(v.targetDate) ?? text(v.반입예정일),
    // 구간이 한정되어 들어오면 나머지 구간에는 기존 자재가 남는다 — 그것이 혼용이다.
    mixed: typeof v.mixed === "boolean" ? v.mixed : grid !== null,
    counterparty: text(v.counterparty) ?? text(v.발신처) ?? text(v.거래처),
  };
}

function materialCode(f: SnapshotFact): string | null {
  const v = f.value;
  return (isRecord(v) ? text(v.code) : null) ?? text(f.key);
}

function appliedTasks(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const raw = value.appliedTo ?? value.적용공정;
  const 목록 = strings(raw);
  if (목록.length > 0) return 목록;
  const 하나 = text(raw);
  return 하나 ? [하나] : [];
}

function readTask(f: SnapshotFact): 공정 | null {
  const v = f.value;
  if (!isRecord(v)) return null;
  const taskId = text(v.taskId) ?? text(f.key);
  if (!taskId) return null;
  return {
    taskId,
    label: text(v.label) ?? text(v.단위작업) ?? taskId,
    start: text(v.start),
    end: text(v.end),
  };
}

// 진행 중(start ≤ 오늘 ≤ end) 이거나 착수 예정(start > 오늘). 날짜는 KST 문자열끼리
// 사전순으로 비교한다 — Date 로 바꾸면 하루가 밀린다.
function isRunningOrUpcoming(작업: 공정, 오늘: string): boolean {
  if (작업.start && 작업.start > 오늘) return true;
  if (작업.end) return 작업.end >= 오늘;
  return 작업.start !== null && 작업.start <= 오늘;
}

// TBM 자료는 팀 단위로 나간다. 현장에 어느 팀이 있는지는 회의록 참석자 사실이 이미
// 알고 있으므로 여기서 되짚는다. watches 에 넣지 않은 것은 팀 명부가 바뀌었다고
// 자재 변경을 다시 판정할 이유가 없기 때문이다 — 발화 조건이 아니다.
//
// 이 값은 근거로 실어 보낸다. 예전에는 produces 의 teams 에만 담겼고, 그래서 규칙이
// 산출물을 정하지 않게 된 지금 그대로 두면 통째로 사라진다. 어느 팀에 전파해야 하는지는
// 이 조건을 읽는 사람이 알아야 하는 사실이므로 근거에 있는 편이 원래 맞다.
function tbmTeams(lookup: DetectLookup): string[] {
  const 본것 = new Set<string>();
  const 팀: string[] = [];
  for (const f of lookup.factsOf("tbmMinutesAttendees")) {
    const v = f.value;
    const 이름 = (isRecord(v) ? (text(v.팀) ?? text(v.team) ?? text(v.공종)) : null) ?? text(f.key);
    if (!이름 || 본것.has(이름)) continue;
    본것.add(이름);
    팀.push(이름);
  }
  return 팀;
}

// 무효화 대상을 짚기 위해 회의록 행을 되짚는다. 이것도 발화 조건이 아니라서
// watches 에 없다 — 행이 하나도 안 잡히면 무효화를 비워 두고 감지는 그대로 낸다.
function invalidatedAssessments(
  lookup: DetectLookup,
  fromCode: string,
  affectedTasks: ReadonlySet<string>,
): Map<string, number> {
  const 묶음 = new Map<string, number>();
  for (const 행 of lookup.factsOf("riskAssessmentRow")) {
    const v = 행.value;
    if (!isRecord(v)) continue;
    const 평가서 = text(v.assessmentId) ?? text(v.평가서) ?? text(v.회의록) ?? text(v.docId);
    if (!평가서) continue;

    const 전제 = text(v.shoringAssumption) ?? text(v.전제자재);
    const 다루는작업 = [
      ...strings(v.coveredTasks),
      ...strings(v.tasks),
      ...strings(v.대상공종),
      ...(text(v.taskId) ? [text(v.taskId) as string] : []),
    ];
    const 걸림 = 전제 === fromCode || 다루는작업.some((t) => affectedTasks.has(t));
    if (!걸림) continue;

    묶음.set(평가서, (묶음.get(평가서) ?? 0) + 1);
  }
  return 묶음;
}

export const t03Material: TriggerRule = {
  id: "T-03",
  label: "자재 변경",
  watches: ["documentExtraction", "snapshotMaterials", "scheduleActiveTasks"],

  detect(input: DetectInput): Detection[] {
    // 아무것도 바뀌지 않은 날 다시 돌려도 같은 카드가 또 올라오지 않도록, 감시 대상에
    // 변화가 없으면 사실 전체를 훑지 않고 그대로 돌아간다.
    if (input.deltas.length === 0) return [];

    const 추출목록 = factsOf(input, "documentExtraction");
    const 자재목록 = factsOf(input, "snapshotMaterials");
    const 공정목록 = factsOf(input, "scheduleActiveTasks");
    // 셋 중 하나라도 비면 판단을 유보한다. 없는 사실을 추측으로 메우면 카드가 거짓말을 한다.
    if (추출목록.length === 0 || 자재목록.length === 0 || 공정목록.length === 0) return [];

    const 오늘 = kstDate(input.now);
    const 팀 = tbmTeams(input.lookup);
    const 직전 = input.lookup.lastDetection("T-03");
    const 결과: Detection[] = [];

    for (const 추출 of 추출목록) {
      const 변경 = readSubstitution(추출.value);
      if (!변경) continue;

      // 이 현장 스냅샷에 없는 자재면 남의 이야기다.
      const 자재 = 자재목록.find((f) => materialCode(f) === 변경.fromCode);
      if (!자재) continue;

      const 적용공정 = new Set(appliedTasks(자재.value));
      if (적용공정.size === 0) continue;

      const 걸린공정: Array<{ fact: SnapshotFact; 작업: 공정 }> = [];
      for (const f of 공정목록) {
        const 작업 = readTask(f);
        if (!작업 || !적용공정.has(작업.taskId)) continue;
        if (!isRunningOrUpcoming(작업, 오늘)) continue;
        걸린공정.push({ fact: f, 작업 });
      }
      // 이미 끝난 공종의 자재가 바뀌는 것은 안전 문제가 아니다.
      if (걸린공정.length === 0) continue;

      const 혼용 = 변경.mixed ? " 혼용" : "";
      const 대체표현 = `${변경.toLabel}${혼용}`;
      const 작업라벨 = 걸린공정.map((c) => c.작업.label).join(" · ");
      const 구간 = [변경.floor, 변경.grid ? `${변경.grid}열` : null].filter(Boolean).join(" ");

      const 조각: string[] = [대체표현];
      if (변경.spec) 조각.push(변경.spec);
      const 면적 = 변경.areaSqm !== null ? `${thousands(변경.areaSqm)}㎡` : null;
      if (구간 || 면적) 조각.push([구간, 면적].filter(Boolean).join(" "));
      if (변경.maxHeightM !== null) 조각.push(`층고 ${변경.maxHeightM}m`);
      if (변경.targetDate) 조각.push(`반입 목표 ${변경.targetDate}`);

      const evidence: Evidence[] = [
        ...(팀.length > 0
          ? [
              {
                factType: "tbmMinutesAttendees" as const,
                key: "teams",
                observedAt: 추출.observedAt,
                sourceDocId: null,
                excerpt: `현장 팀 ${팀.length}개 — ${팀.join(" · ")}`,
              },
            ]
          : []),
        {
          factType: "documentExtraction",
          key: 추출.key,
          observedAt: 추출.observedAt,
          sourceDocId: 추출.sourceDocId,
          excerpt: 조각.join(" · "),
        },
        {
          factType: "snapshotMaterials",
          key: 자재.key,
          observedAt: 자재.observedAt,
          sourceDocId: 자재.sourceDocId,
          excerpt: [
            변경.fromLabel,
            isRecord(자재.value) ? text(자재.value.supplier) : null,
            `적용 공정 ${[...적용공정].join(", ")}`,
          ]
            .filter(Boolean)
            .join(" · "),
        },
        ...걸린공정.map(({ fact, 작업 }) => ({
          factType: "scheduleActiveTasks" as const,
          key: fact.key,
          observedAt: fact.observedAt,
          sourceDocId: fact.sourceDocId,
          excerpt: [
            작업.label,
            작업.start && 작업.end ? `${작업.start} ~ ${작업.end}` : (작업.start ?? 작업.end),
            작업.start && 작업.start > 오늘 ? "착수 예정" : "진행 중",
          ]
            .filter(Boolean)
            .join(" · "),
        })),
      ];

      const 걸린작업ID = new Set(걸린공정.map((c) => c.작업.taskId));
      const invalidates: Invalidation[] = [...invalidatedAssessments(input.lookup, 변경.fromCode, 걸린작업ID)].map(
        ([docId, 행수]) => ({
          docId,
          scope: `${작업라벨} 관련 행 전체 (${행수}건)`,
          reason: `평가 전제가 ${변경.fromLabel}${josaRo(변경.fromLabel)} 적혀 있어 이 작업을 더는 설명하지 못합니다.`,
        }),
      );

      const 감지: Detection = {
        ruleId: "T-03",
        siteId: input.siteId,
        // 조건이 성립한 시각은 문서를 읽은 시각이다. 보드가 그것을 보는 날짜와 다르다.
        detectedAt: 추출.observedAt,
        confidence: Math.min(1, Math.max(0, 추출.confidence)),
        evidence,
        invalidates,
        // 무엇을 만들지는 규칙이 정하지 않는다. lib/generate/cards.ts 가 근거를 읽고
        // 정한 뒤 엔진이 여기 채워 넣는다.
        produces: [],
        summary: `${작업라벨} 자재가 ${변경.fromLabel}에서 ${대체표현}${josaRo(대체표현)} 변경될 예정입니다.`,
      };

      if (alreadyReported(직전, 감지)) continue;
      결과.push(감지);
    }

    return 결과;
  },
};
