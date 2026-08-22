import type { Detection, Evidence, Invalidation, Produces, SnapshotFact, TriggerRule } from "@/lib/board/types";
import {
  latestFacts,
  readNumber,
  readRiskRow,
  readString,
  scoreText,
  type RiskAssessmentRowValue,
} from "@/lib/detect/delta";
import { dayKey } from "@/lib/detect/engine";
import { SLOPE_INSPECTION_MM, reachedTier, tierOf, tierText } from "@/lib/detect/rainfall";

// T-01 기상 변화
//
// 세 조건의 AND 다. (1) 기상 관측 피드의 누적 강우량이 임계치를 넘고, (2) 강우에 민감한
// 공종이 당일 예정공정에 들어 있으며, (3) 그 공종을 다루는 회의록 행이 현재 관리기간
// 회의록에 등재되어 있다. 셋 중 하나라도 없으면 발동하지 않는다.
//
// 판정 시각은 당일 작업 착수 전이다. 강우 자체는 주말에 관측되었어도 그 값이 오늘의
// 되메움·법면 작업에 걸리는 순간이 판정 시각이다.

// 임계치는 lib/detect/rainfall.ts 의 표에서 온다. 여기에 숫자를 다시 적지 않는 이유는
// 커넥터와 규칙이 각자 다른 값을 들고 있으면 화면에 뜬 근거 문구와 실제 발동 조건이
// 갈라지기 때문이다. 이 규칙이 보는 것은 사면·법면 점검 단계이고, **그 값은 공식 근거가
// 없는 현장 설정값**이라 근거 문구에 그 사실이 함께 실린다.
export const RAINFALL_THRESHOLD_MM = SLOPE_INSPECTION_MM;

// 강우 뒤 지반이 물러져 등재 대책의 전제가 흔들리는 공종.
export const RAIN_SENSITIVE_KEYWORDS = ["되메움", "법면", "사면", "절토", "성토", "굴착", "흙막이"];

type WeatherObservation = {
  누적강우량mm: number;
  관측기간: string | null;
  관측지점: string | null;
};

function readWeather(value: unknown): WeatherObservation | null {
  const 누적강우량mm = readNumber(value, "누적강우량mm", "누적강우량", "rainfallMm");
  if (누적강우량mm === null) return null;
  return {
    누적강우량mm,
    관측기간: readString(value, "관측기간", "기간"),
    관측지점: readString(value, "관측지점", "지점"),
  };
}

type ScheduledTask = {
  taskId: string | null;
  label: string;
  start: string;
  end: string;
};

// 현장 스냅샷의 schedule.activeTasks 를 필드명까지 그대로 옮긴 모양이다.
function readTask(value: unknown): ScheduledTask | null {
  const label = readString(value, "label", "단위작업", "공종");
  if (!label) return null;
  return {
    taskId: readString(value, "taskId"),
    label,
    start: dayKey(readString(value, "start", "시작") ?? ""),
    end: dayKey(readString(value, "end", "종료") ?? ""),
  };
}

function sensitiveWords(text: string): string[] {
  return RAIN_SENSITIVE_KEYWORDS.filter((word) => text.includes(word));
}

// 오늘 손을 대는 작업인지. 착수 예정일이 아직 오지 않았으면 강우와 무관하다.
function activeToday(task: ScheduledTask, today: string): boolean {
  if (task.start && task.start > today) return false;
  if (task.end && task.end < today) return false;
  return true;
}

function matchesTask(row: RiskAssessmentRowValue, task: ScheduledTask, words: string[]): boolean {
  if (row.taskId && task.taskId && row.taskId === task.taskId) return true;
  const text = `${row.단위작업 ?? ""} ${row.공종분류 ?? ""} ${row.위험요인 ?? ""}`;
  return words.some((word) => text.includes(word));
}

// 현재 관리기간의 회의록인지. 관리기간이 적혀 있지 않으면 확인할 길이 없으므로 통과시킨다.
function currentPeriod(row: RiskAssessmentRowValue, today: string): boolean {
  if (!row.관리기간) return true;
  return today.startsWith(row.관리기간.slice(0, 7));
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

export const t01Weather: TriggerRule = {
  id: "T-01",
  label: "기상 변화",
  watches: ["weatherObservation", "scheduleActiveTasks", "riskAssessmentRow"],

  detect(input): Detection[] {
    const rainDeltas = input.deltas.filter((delta) => delta.factType === "weatherObservation");
    if (rainDeltas.length === 0) return [];

    const today = dayKey(input.now);
    const detections: Detection[] = [];

    for (const delta of rainDeltas) {
      const after = readWeather(delta.after);
      if (!after || after.누적강우량mm < RAINFALL_THRESHOLD_MM) continue;

      // 직전 관측이 이미 임계치를 넘고 있었다면 새로 생긴 조건이 아니다.
      const before = readWeather(delta.before);
      if (before && before.누적강우량mm >= RAINFALL_THRESHOLD_MM) continue;

      const rainFact = input.lookup.fact("weatherObservation", delta.key);
      if (!rainFact) continue;

      const tasks = latestFacts(input.lookup.factsOf("scheduleActiveTasks"))
        .map((fact) => ({ fact, task: readTask(fact.value) }))
        .filter((entry): entry is { fact: SnapshotFact; task: ScheduledTask } => entry.task !== null)
        .map((entry) => ({ ...entry, words: sensitiveWords(entry.task.label) }))
        .filter((entry) => entry.words.length > 0 && activeToday(entry.task, today));
      if (tasks.length === 0) continue;

      const rows = latestFacts(input.lookup.factsOf("riskAssessmentRow"))
        .map((fact) => ({ fact, row: readRiskRow(fact.value) }))
        .filter((entry): entry is { fact: SnapshotFact; row: RiskAssessmentRowValue } => entry.row !== null)
        .filter((entry) => currentPeriod(entry.row, today))
        .map((entry) => ({
          ...entry,
          task: tasks.find((candidate) => matchesTask(entry.row, candidate.task, candidate.words)) ?? null,
        }))
        .filter((entry) => entry.task !== null);
      if (rows.length === 0) continue;

      // 회의록 행까지 이어진 공종만 근거로 남긴다. 예정공정에 있어도 등재된 행이 없으면
      // 세 조건의 AND 를 채우지 못한 것이라 판정에 쓰이지 않았다.
      const usedTasks = tasks.filter((candidate) => rows.some((entry) => entry.task === candidate));
      const labels = [...new Set(usedTasks.map((entry) => entry.task.label))];
      const rainText = `누적 강우 ${after.누적강우량mm}mm${after.관측기간 ? ` · ${after.관측기간}` : ""}`;

      // 도달한 가장 무거운 단계를 함께 적는다. 사면 점검에 그치는 41mm 와 호우주의보가
      // 걸린 값이 화면에서 같은 문구로 보이면 담당자가 급함을 가늠할 수 없다.
      const 단계 = reachedTier(after.누적강우량mm, null) ?? tierOf("slopeInspection");

      const evidence: Evidence[] = [
        evidenceOf(rainFact, `${rainText} · ${tierText(단계)}`),
        ...usedTasks.map((entry) =>
          evidenceOf(entry.fact, `${entry.task.label} · ${entry.task.start}~${entry.task.end} 예정공정`),
        ),
        ...rows.map((entry) =>
          evidenceOf(
            entry.fact,
            `${entry.row.단위작업 ?? entry.row.행id ?? entry.fact.key} 행 · 개선 전 위험도 ${
              entry.row.개선전 ? scoreText(entry.row.개선전) : "미기재"
            }`,
          ),
        ),
      ];

      const invalidates: Invalidation[] = rows.map((entry) => ({
        docId: entry.row.docId ?? entry.fact.sourceDocId ?? entry.fact.key,
        scope: `${entry.row.단위작업 ?? "해당"} 행${
          entry.row.개선전 ? ` (현재 개선 전 위험도 ${scoreText(entry.row.개선전)})` : ""
        }`,
        reason: `${rainText} 뒤에도 등재된 대책이 그대로 유효한지가 확인되지 않았습니다.`,
      }));

      const produces: Produces[] = [
        { form: "기록", for: `강우 뒤 대책 유효성 확인 — ${labels.join(" · ")}`, count: rows.length },
      ];
      // 법면이 걸려 있으면 추락방지 조치를 따로 확인한다.
      if (labels.some((label) => label.includes("법면") || label.includes("사면"))) {
        produces.push({ form: "기록", for: "법면 구간 추락방지 휀스 설치 여부 확인" });
      }

      detections.push({
        ruleId: "T-01",
        siteId: input.siteId,
        // 강우는 어제 관측되었어도 판정은 오늘 작업 착수 전에 선다.
        detectedAt: input.now,
        // 숫자 비교로 판정하지만 공종 매칭이 문자열 대조라 1.0 은 아니다.
        confidence: 0.9,
        evidence,
        invalidates,
        produces,
        summary: `${rainText} 뒤에 ${labels.join(" · ")} 작업이 오늘 예정되어 있어, 등재된 대책이 그대로 유효한지 확인해야 합니다.`,
      });
    }

    return detections;
  },
};
