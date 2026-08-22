import type { Detection, Evidence, SnapshotFact, TriggerRule } from "@/lib/board/types";
import { factTime, readBoolean, readString } from "@/lib/detect/delta";
import { dayKey } from "@/lib/detect/engine";

// T-02 환류 미완
//
// 두 회차 회의록을 팀 단위로 짝지어 같은 제기 사항의 상태 전이가 없었는지를 본다.
// 직전 회차에서 미조치였던 항목이 다음 회차 회의록이 생긴 시점에도 그대로이고, 같은
// 회의록의 작업 전 안전조치 확인란에서도 그 항목이 done: false 이면 발동한다.
//
// 초안은 만들지 않는다. 현장 육안 확인이 선행되어야 하기 때문이다.

const 조치완료 = "조치완료";

type Feedback = {
  docId: string | null;
  팀: string;
  회차: string;
  항목id: string | null;
  종류: string | null;
  내용: string;
  status: string;
  제기자: string | null;
};

// 항목 id 는 값 안에 있을 수도 있고 사실 키에만 있을 수도 있다. TBM 사실의 키는
// '회의록군#항목id' 규약을 따르므로, 값에 없으면 키 뒷부분을 항목 id 로 읽는다.
// 이것이 없으면 회차를 잇는 고리가 문장으로 떨어지고, 재제기하면서 표현이 바뀐
// 순간 같은 제기 사항이 두 스레드로 갈라진다.
function itemIdOf(fact: SnapshotFact): string | null {
  const 값 = readString(fact.value, "항목id", "itemId");
  if (값) return 값;
  const 자리 = fact.key.lastIndexOf("#");
  if (자리 < 0 || 자리 === fact.key.length - 1) return null;
  return fact.key.slice(자리 + 1);
}

function readFeedback(fact: SnapshotFact): Feedback | null {
  const 내용 = readString(fact.value, "내용", "제기사항", "text");
  if (!내용) return null;
  return {
    docId: readString(fact.value, "docId", "회의록id", "회의록"),
    팀: readString(fact.value, "팀", "team") ?? "미배정",
    회차: dayKey(readString(fact.value, "회차", "일자", "date") ?? fact.observedAt),
    항목id: itemIdOf(fact),
    종류: readString(fact.value, "종류", "구분"),
    내용,
    status: readString(fact.value, "status", "상태") ?? "미조치",
    제기자: readString(fact.value, "제기자", "personId"),
  };
}

type PreWorkCheck = {
  docId: string | null;
  팀: string;
  회차: string;
  항목id: string | null;
  // 이 점검 항목이 어느 제기 사항을 받아 생긴 것인지. 회의록이 밝혀 두었을 때만 있다.
  연계항목id: string | null;
  확인: string;
  done: boolean;
};

function readCheck(fact: SnapshotFact): PreWorkCheck | null {
  const 확인 = readString(fact.value, "확인", "항목", "text");
  const done = readBoolean(fact.value, "done", "완료");
  if (!확인 || done === null) return null;
  return {
    docId: readString(fact.value, "docId", "회의록id", "회의록"),
    팀: readString(fact.value, "팀", "team") ?? "미배정",
    회차: dayKey(readString(fact.value, "회차", "일자", "date") ?? fact.observedAt),
    항목id: itemIdOf(fact),
    연계항목id: readString(fact.value, "연계항목id", "연계제기id", "relatedItemId"),
    확인,
    done,
  };
}

// 같은 제기 사항을 회차 너머로 잇는 고리. 항목id 가 있으면 그것이 정답이고, 없으면
// 팀과 내용 문장으로 잇는다.
function threadKey(팀: string, 항목id: string | null, 내용: string): string {
  return `${팀}::${항목id ?? 내용}`;
}

// 점검 항목 문구에서 핵심어만 남긴다. 두 글자 미만과 어느 항목에나 붙는 서식어는
// 버린다 — 그것으로 이으면 안 맞는 항목까지 걸린다.
const 서식어 = new Set([
  "작업",
  "구간",
  "확인",
  "확보",
  "점검",
  "관리",
  "상태",
  "여부",
  "조치",
  "실시",
  "사용",
]);

function 핵심어(문장: string): string[] {
  return 문장
    .split(/[^0-9A-Za-z가-힣]+/)
    .filter((낱말) => 낱말.length >= 2 && !서식어.has(낱말));
}

// 점검 항목과 제기 사항을 잇는다.
//
// 제기 사항 id(fb_1)와 점검 항목 id(pre_3)는 서로 다른 이름 공간이라 그대로 견주면
// 절대 같아지지 않는다. 그래서 id 로 잇는 것은 점검 항목이 스스로 연계 항목을 밝혀
// 두었을 때뿐이고, 그렇지 않으면 팀을 맞춘 뒤 문구를 대조한다.
//
// 문구 대조는 완전 포함이 아니라 핵심어 겹침이다. 재제기 문장은 첫 제기와 표현이
// 달라지므로("조도가 부족합니다" → "후광등이 아직 추가되지 않았습니다") 스레드에
// 쌓인 앞 회차 문장까지 함께 본다.
function matchesCheck(check: PreWorkCheck, feedback: Feedback, 앞회차: string[] = []): boolean {
  if (check.연계항목id && feedback.항목id) return check.연계항목id === feedback.항목id;
  if (check.팀 !== feedback.팀) return false;

  const 문장들 = [feedback.내용, ...앞회차].filter((문장) => 문장.length > 0);
  if (문장들.some((문장) => check.확인.includes(문장) || 문장.includes(check.확인))) return true;

  const 낱말들 = 핵심어(check.확인);
  if (낱말들.length === 0) return false;
  return 문장들.some((문장) => 낱말들.some((낱말) => 문장.includes(낱말)));
}

// 같은 좌표에 여러 건이 들어와 있으면 관측이 늦은 것을 남긴다.
function dedupe<T extends { fact: SnapshotFact }>(entries: T[], keyOf: (entry: T) => string): T[] {
  const held = new Map<string, T>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const previous = held.get(key);
    if (!previous || factTime(entry.fact.observedAt) >= factTime(previous.fact.observedAt)) {
      held.set(key, entry);
    }
  }
  return [...held.values()];
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

export const t02Followup: TriggerRule = {
  id: "T-02",
  label: "환류 미완",
  watches: ["tbmMinutesFeedback", "tbmMinutesPreWorkCheck"],

  detect(input): Detection[] {
    if (input.deltas.length === 0) return [];

    // 회의록은 회차마다 새로 쌓이는 기록이다. 자리(key)로 최신 한 건만 남기면 두 회차를
    // 짝지을 수 없으므로, 회차까지 포함한 좌표로 중복만 걷어 낸다.
    const feedbackFacts = dedupe(
      input.lookup
        .factsOf("tbmMinutesFeedback")
        .map((fact) => ({ fact, value: readFeedback(fact) }))
        .filter((entry): entry is { fact: SnapshotFact; value: Feedback } => entry.value !== null),
      (entry) => `${entry.value.docId ?? ""}::${entry.value.회차}::${threadKey(entry.value.팀, entry.value.항목id, entry.value.내용)}`,
    );

    const checks = dedupe(
      input.lookup
        .factsOf("tbmMinutesPreWorkCheck")
        .map((fact) => ({ fact, value: readCheck(fact) }))
        .filter((entry): entry is { fact: SnapshotFact; value: PreWorkCheck } => entry.value !== null),
      (entry) => `${entry.value.docId ?? ""}::${entry.value.회차}::${entry.value.항목id ?? entry.value.확인}`,
    );

    const threads = new Map<string, Array<{ fact: SnapshotFact; value: Feedback }>>();
    for (const entry of feedbackFacts) {
      const key = threadKey(entry.value.팀, entry.value.항목id, entry.value.내용);
      const bucket = threads.get(key);
      if (bucket) bucket.push(entry);
      else threads.set(key, [entry]);
    }

    const detections: Detection[] = [];

    for (const bucket of threads.values()) {
      if (bucket.length < 2) continue;
      // 회차가 이른 것부터. 회차가 같으면 관측 시각으로 가른다.
      bucket.sort((a, b) => {
        const gap = a.value.회차.localeCompare(b.value.회차);
        return gap !== 0 ? gap : factTime(a.fact.observedAt) - factTime(b.fact.observedAt);
      });

      const previous = bucket[bucket.length - 2];
      const current = bucket[bucket.length - 1];
      if (previous.value.회차 === current.value.회차) continue;
      if (previous.value.status === 조치완료) continue;
      if (current.value.status === 조치완료) continue;

      // 앞 회차 문장들. 재제기하면서 표현이 바뀐 경우 점검 항목과 이을 실마리가 여기 있다.
      const 앞회차문장 = bucket.slice(0, -1).map((entry) => entry.value.내용);

      // 같은 회의록의 작업 전 안전조치 확인란에서 그 항목이 아직 미확인이어야 한다.
      const check =
        checks.find(
          (entry) =>
            entry.value.docId === current.value.docId &&
            matchesCheck(entry.value, current.value, 앞회차문장),
        ) ??
        checks.find(
          (entry) =>
            entry.value.회차 === current.value.회차 &&
            matchesCheck(entry.value, current.value, 앞회차문장),
        );
      if (!check || check.value.done) continue;

      const 내용 = current.value.내용;
      const 팀 = current.value.팀;

      detections.push({
        ruleId: "T-02",
        siteId: input.siteId,
        // 다음 회차 회의록이 생긴 시점이 판정 시각이다.
        detectedAt: current.fact.observedAt,
        // 상태 문자열과 불리언 비교만으로 판정한다.
        confidence: 0.95,
        evidence: [
          evidenceOf(
            previous.fact,
            `${previous.value.회차} 회의록 ${previous.value.종류 ?? "제기"} — ${내용} · 상태 ${previous.value.status}`,
          ),
          evidenceOf(
            current.fact,
            `${current.value.회차} 회의록에서도 같은 항목이 ${current.value.status} 로 남아 있습니다.`,
          ),
          evidenceOf(check.fact, `작업 전 안전조치 확인란 "${check.value.확인}" done: false`),
        ],
        invalidates: [
          {
            docId: previous.value.docId ?? previous.fact.sourceDocId ?? previous.fact.key,
            scope: `작업 전 안전조치 확인란(${check.value.확인})`,
            reason: "제기 사항이 두 회차 연속 미조치라 확인 표시를 붙일 수 없습니다.",
          },
        ],
        // 무엇을 만들지는 규칙이 정하지 않는다. lib/generate/cards.ts 가 근거를 읽고
        // 정한 뒤 엔진이 여기 채워 넣는다.
        produces: [],
        summary: `${팀} 팀의 "${내용}" 제기 사항이 ${previous.value.회차} · ${current.value.회차} 두 회차 연속 미조치입니다.`,
      });
    }

    return detections;
  },
};
