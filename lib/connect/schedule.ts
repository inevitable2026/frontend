// 공정 커넥터 — 시드 기반.
//
// 값의 출처는 docs/scenario-gimpo-logistics.md 4.2 의 현장 스냅샷
// (snap_gimpo_20260818) 이다. 지어내지 않는다. 스냅샷에 없고 감지 규칙 사양에만
// 있는 값(되메움작업·법면 공종)은 sourceDocId 를 달리 달아 어디서 왔는지
// 드러나게 한다.
//
// 이 커넥터가 내보내는 것 셋:
//   ① 4층 슬래브 선행 — 아직 착수 전이라 T-03 이 "착수 예정" 으로 읽는 자리
//   ② 8월 관리기간 — 회의록이 걸린 기간과 결재 상신 예정일
//   ③ 8월 24일 자재 반입 예정 — 공문이 오늘 안에 나가야 하는 이유

import type { SnapshotFact } from "@/lib/board/types";
import { type Connector, kstDay, kstDayDiff, kstStamp, makeFact } from "./types";

const SNAPSHOT_DOC_ID = "snap_gimpo_20260818";
const CHANGE_MAIL_DOC_ID = "doc_2_k3f9x1qm";
const RULE_SPEC_DOC_ID = "seed_rule_T-01";

export type TaskStatus = "완료" | "진행중" | "착수예정";

export type ScheduleTaskValue = {
  taskId: string;
  label: string;
  공종: string;
  start: string;
  end: string;
  상태: TaskStatus;
  강우민감: boolean;
  선행: boolean;
  적용자재: string[];
  담당사: string | null;
};

type TaskSeed = Omit<ScheduleTaskValue, "상태"> & { sourceDocId: string };

// 스냅샷 activeTasks 두 건 + 감지 규칙 사양이 요구하는 강우 민감 공종 한 건.
// 되메움·법면은 8월 17일 판정에만 걸려야 하므로 그 주말까지로 기간을 닫는다.
// 8월 19일에 T-01 이 다시 발화하면 시나리오의 8월 19일 카드 목록과 어긋난다.
const TASK_SEEDS: TaskSeed[] = [
  {
    taskId: "task_4f_slab",
    label: "4층 슬래브 거푸집 및 동바리",
    공종: "골조",
    start: "2026-08-24",
    end: "2026-09-06",
    강우민감: false,
    선행: true,
    적용자재: ["MAT_SYS_SHORE"],
    담당사: "sub_seojin",
    sourceDocId: SNAPSHOT_DOC_ID,
  },
  {
    taskId: "task_3f_wall",
    label: "3층 벽체 콘크리트 타설",
    공종: "골조",
    start: "2026-08-19",
    end: "2026-08-22",
    강우민감: false,
    선행: false,
    적용자재: [],
    담당사: "sub_seojin",
    sourceDocId: SNAPSHOT_DOC_ID,
  },
  {
    taskId: "task_backfill_slope",
    label: "되메움작업 및 법면 정리",
    공종: "토공",
    start: "2026-08-15",
    end: "2026-08-17",
    강우민감: true,
    선행: false,
    적용자재: [],
    담당사: "sub_daeyang",
    sourceDocId: RULE_SPEC_DOC_ID,
  },
];

export type ManagementPeriodValue = {
  기간명: string;
  시작: string;
  종료: string;
  현재: boolean;
  결재상신예정: string;
  직전정기평가: {
    assessmentId: string;
    type: string;
    completedAt: string;
    coveredTasks: string[];
    shoringAssumption: string;
  };
};

// 결재 상신 예정일 9월 2일은 8월 19일 카드("9월 2일 결재 상신 전에 비워 둘 수
// 없습니다")에서 왔다.
const MANAGEMENT_PERIOD: ManagementPeriodValue = {
  기간명: "2026-08",
  시작: "2026-08-01",
  종료: "2026-08-31",
  현재: true,
  결재상신예정: "2026-09-02",
  직전정기평가: {
    assessmentId: "ra_2026_07_regular",
    type: "정기",
    completedAt: "2026-07-03",
    coveredTasks: ["task_3f_wall", "task_4f_slab"],
    shoringAssumption: "MAT_SYS_SHORE",
  },
};

export type MaterialInboundValue = {
  자재코드: string;
  라벨: string;
  규격: string;
  대체대상: string;
  대상작업: string;
  목표일: string;
  남은일수: number;
  확정여부: boolean;
  출처문서: string;
};

// 시나리오 4.1 의 extracted 값 그대로.
const MATERIAL_INBOUND: Omit<MaterialInboundValue, "남은일수"> = {
  자재코드: "MAT_PIPE_SHORE",
  라벨: "강관동바리",
  규격: "φ48.6×3.2t, 4단 조립",
  대체대상: "MAT_SYS_SHORE",
  대상작업: "task_4f_slab",
  목표일: "2026-08-24",
  // 메일이 아직 검토 단계이고 최종 승인이 나지 않았다.
  확정여부: false,
  출처문서: CHANGE_MAIL_DOC_ID,
};

export type PhaseValue = {
  snapshotId: string;
  capturedAt: string;
  currentPhase: string;
  delayDays: number;
  활성작업: string[];
  타설예정일: string;
};

function taskStatus(seed: TaskSeed, 오늘: string): TaskStatus {
  if (오늘 < seed.start) return "착수예정";
  if (오늘 > seed.end) return "완료";
  return "진행중";
}

async function fetchScheduleFacts(siteId: string, at: Date): Promise<SnapshotFact[]> {
  const observedAt = kstStamp(at);
  const 오늘 = kstDay(at);

  const facts: SnapshotFact[] = TASK_SEEDS.map((seed) =>
    makeFact({
      siteId,
      factType: "scheduleActiveTasks",
      key: seed.taskId,
      value: {
        taskId: seed.taskId,
        label: seed.label,
        공종: seed.공종,
        start: seed.start,
        end: seed.end,
        상태: taskStatus(seed, 오늘),
        강우민감: seed.강우민감,
        선행: seed.선행,
        적용자재: seed.적용자재,
        담당사: seed.담당사,
      } satisfies ScheduleTaskValue,
      observedAt,
      sourceDocId: seed.sourceDocId,
      confidence: 1,
    }),
  );

  facts.push(
    makeFact({
      siteId,
      factType: "scheduleActiveTasks",
      key: "현재공정",
      value: {
        snapshotId: SNAPSHOT_DOC_ID,
        capturedAt: "2026-08-18T18:00:00+09:00",
        currentPhase: "골조",
        delayDays: 4,
        활성작업: TASK_SEEDS.filter((seed) => taskStatus(seed, 오늘) !== "완료").map(
          (seed) => seed.taskId,
        ),
        // 음성 메모(ev_20260819_c)에서 확인된 4층 타설 예정일.
        타설예정일: "2026-09-01",
      } satisfies PhaseValue,
      observedAt,
      sourceDocId: SNAPSHOT_DOC_ID,
      confidence: 1,
    }),
  );

  facts.push(
    makeFact({
      siteId,
      factType: "scheduleActiveTasks",
      key: "관리기간_2026-08",
      value: {
        ...MANAGEMENT_PERIOD,
        현재: 오늘 >= MANAGEMENT_PERIOD.시작 && 오늘 <= MANAGEMENT_PERIOD.종료,
      } satisfies ManagementPeriodValue,
      observedAt,
      sourceDocId: SNAPSHOT_DOC_ID,
      confidence: 1,
    }),
  );

  facts.push(
    makeFact({
      siteId,
      factType: "scheduleActiveTasks",
      key: "자재반입예정_MAT_PIPE_SHORE",
      value: {
        ...MATERIAL_INBOUND,
        남은일수: kstDayDiff(오늘, MATERIAL_INBOUND.목표일),
      } satisfies MaterialInboundValue,
      observedAt,
      sourceDocId: CHANGE_MAIL_DOC_ID,
      // 메일 추출 확신도(시나리오 5절)와 같은 값을 쓴다.
      confidence: 0.91,
    }),
  );

  return facts;
}

export const scheduleConnector: Connector = {
  id: "schedule",
  label: "공정표",
  factTypes: ["scheduleActiveTasks"],
  fetch: fetchScheduleFacts,
};
