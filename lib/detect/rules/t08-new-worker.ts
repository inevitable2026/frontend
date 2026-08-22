import type { Detection, Evidence, Invalidation, Produces, SnapshotFact, TriggerRule } from "@/lib/board/types";
import { latestFacts, readBoolean, readString, readStrings } from "@/lib/detect/delta";
import { dayKey } from "@/lib/detect/engine";

// T-08 신규 인원
//
// 당일 출역 명부의 인원 가운데 직전 30일간 출역 기록이 없는 personId 가 있으면 그 인원이
// 속한 팀에 대해 발동한다. 팀마다 카드가 따로 선다 — 교육을 하는 사람이 팀별로 다르다.
//
// 한국어가 모국어가 아닌 인원은 따로 센다. 같은 자료를 나눠 준 것만으로는 전달되지
// 않기 때문이다.

// 직전 30일. 이보다 오래 비면 신규와 같게 다룬다.
export const NEW_WORKER_WINDOW_DAYS = 30;

const 모국어_기본 = "한국어";

type RosterEntry = {
  personId: string;
  이름: string | null;
  팀: string;
  소속: string | null;
  date: string;
  통역필요: boolean;
};

function readRoster(fact: SnapshotFact): RosterEntry | null {
  const personId = readString(fact.value, "personId", "인원id") ?? fact.key;
  if (!personId) return null;
  const 모국어 = readString(fact.value, "모국어", "language");
  const 통역필요 = readBoolean(fact.value, "통역필요", "needsInterpreter");
  return {
    personId,
    이름: readString(fact.value, "이름", "name"),
    팀: readString(fact.value, "팀", "team", "공종") ?? "미배정",
    소속: readString(fact.value, "소속", "업체", "company"),
    date: dayKey(readString(fact.value, "date", "일자", "출역일") ?? fact.observedAt),
    통역필요: 통역필요 ?? (모국어 !== null && 모국어 !== 모국어_기본),
  };
}

type Attendees = {
  docId: string | null;
  팀: string;
  date: string;
  참석자: string[];
};

function readAttendees(fact: SnapshotFact): Attendees | null {
  const 팀 = readString(fact.value, "팀", "team");
  if (!팀) return null;
  return {
    docId: readString(fact.value, "docId", "회의록id"),
    팀,
    date: dayKey(readString(fact.value, "date", "일자", "회차") ?? fact.observedAt),
    참석자: readStrings(fact.value, "참석자", "attendees"),
  };
}

function listed(attendees: Attendees, entry: RosterEntry): boolean {
  return attendees.참석자.some((name) => name === entry.personId || (!!entry.이름 && name === entry.이름));
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

export const t08NewWorker: TriggerRule = {
  id: "T-08",
  label: "신규 인원",
  watches: ["attendanceRoster", "tbmMinutesAttendees"],

  detect(input): Detection[] {
    if (input.deltas.filter((delta) => delta.factType === "attendanceRoster").length === 0) return [];

    const today = dayKey(input.now);
    if (!today) return [];

    // 출역은 날마다 쌓이는 기록이라 최신 한 건만 남기면 30일치가 사라진다. 그래서
    // 자리(key)가 아니라 인원·날짜로 묶어 중복만 걷어 낸다.
    const rosterSeen = new Set<string>();
    const roster = input.lookup
      .factsOf("attendanceRoster")
      .map((fact) => ({ fact, entry: readRoster(fact) }))
      .filter((item): item is { fact: SnapshotFact; entry: RosterEntry } => item.entry !== null)
      .filter((item) => {
        const slot = `${item.entry.personId}::${item.entry.date}`;
        if (rosterSeen.has(slot)) return false;
        rosterSeen.add(slot);
        return true;
      });

    // 직전 30일간 한 번이라도 나온 사람.
    const seenBefore = new Set<string>();
    for (const { entry } of roster) {
      if (entry.date >= today) continue;
      const gap = input.lookup.daysBetween(entry.date, today);
      if (gap > 0 && gap <= NEW_WORKER_WINDOW_DAYS) seenBefore.add(entry.personId);
    }

    const todayRoster = roster.filter((item) => item.entry.date === today);
    if (todayRoster.length === 0) return [];

    const newcomers = todayRoster.filter((item) => !seenBefore.has(item.entry.personId));
    if (newcomers.length === 0) return [];

    const attendees = latestFacts(input.lookup.factsOf("tbmMinutesAttendees"))
      .map((fact) => ({ fact, value: readAttendees(fact) }))
      .filter((item): item is { fact: SnapshotFact; value: Attendees } => item.value !== null)
      .filter((item) => item.value.date === today);

    const teams = new Map<string, Array<{ fact: SnapshotFact; entry: RosterEntry }>>();
    for (const item of newcomers) {
      const bucket = teams.get(item.entry.팀);
      if (bucket) bucket.push(item);
      else teams.set(item.entry.팀, [item]);
    }

    const detections: Detection[] = [];

    for (const [팀, bucket] of teams) {
      const 통역인원 = bucket.filter((item) => item.entry.통역필요);
      const names = bucket.map((item) => item.entry.이름 ?? item.entry.personId);

      const evidence: Evidence[] = bucket
        .slice(0, 5)
        .map((item) =>
          evidenceOf(
            item.fact,
            `${item.entry.이름 ?? item.entry.personId} · ${item.entry.소속 ?? 팀} · 직전 ${NEW_WORKER_WINDOW_DAYS}일 출역 기록 없음${
              item.entry.통역필요 ? " · 통역 필요" : ""
            }`,
          ),
        );

      const invalidates: Invalidation[] = [];
      const teamMinutes = attendees.find((item) => item.value.팀 === 팀);
      if (teamMinutes) {
        const missing = bucket.filter((item) => !listed(teamMinutes.value, item.entry));
        evidence.push(
          evidenceOf(
            teamMinutes.fact,
            `${today} ${팀} TBM 참석자 ${teamMinutes.value.참석자.length}명 · 신규 ${missing.length}명 누락`,
          ),
        );
        if (missing.length > 0) {
          invalidates.push({
            docId: teamMinutes.value.docId ?? teamMinutes.fact.sourceDocId ?? teamMinutes.fact.key,
            scope: `${팀} 당일 TBM 회의록 참석자란`,
            reason: `신규 인원 ${missing.length}명이 빠진 상태로는 확정할 수 없습니다.`,
          });
        }
      }

      const produces: Produces[] = [
        {
          form: "기록",
          for: `${팀} 신규 입장자 ${bucket.length}명 교육 기록`,
          count: bucket.length,
          teams: [팀],
        },
      ];
      if (통역인원.length > 0) {
        produces.push({
          form: "TBM자료",
          for: `${팀} 통역 필요 인원 ${통역인원.length}명 전달 방안`,
          teams: [팀],
        });
      }

      detections.push({
        ruleId: "T-08",
        siteId: input.siteId,
        detectedAt: input.now,
        // 출역 기록 유무만 보므로 판정 자체는 흔들리지 않는다.
        confidence: 0.97,
        evidence,
        invalidates,
        produces,
        summary: `${today} ${팀} 출역 인원 가운데 ${bucket.length}명(${names.slice(0, 3).join(" · ")}${
          names.length > 3 ? " 외" : ""
        })이 직전 ${NEW_WORKER_WINDOW_DAYS}일간 출역 기록이 없는 신규 인원입니다.${
          통역인원.length > 0 ? ` 그 가운데 ${통역인원.length}명은 통역이 필요합니다.` : ""
        }`,
      });
    }

    return detections;
  },
};
