// 출역 커넥터 — 시드 기반.
//
// T-08(신규 인원)이 발화하려면 세 가지가 사실에 드러나야 한다.
//   ① 그날 출역한 인원 규모와 협력사 구성 (시나리오 1.2: 122명 · 협력 6사)
//   ② 직전 30일간 출역 기록이 없는 personId — 여기서는 최근출역일 = null 로 둔다
//   ③ 그 가운데 한국어가 모국어가 아닌 인원 (감지 규칙 사양 T-08: 신규 11명 중 4명)
//
// 개인 이름은 시나리오에 없다. 지어내지 않고 "신규-01" 같은 표기만 쓴다.
// 국적과 언어도 시나리오에 없으므로 "비한국어" 까지만 적고 더 좁히지 않는다.

import type { SnapshotFact } from "@/lib/board/types";
import { type Connector, kstDay, kstStamp, makeFact } from "./types";

const ROSTER_SOURCE_DOC_ID = "seed_roster_gimpo";

// 감지 규칙 사양 T-08 이 말하는 "주중 4일". 월요일 8월 17일부터 목요일 8월 20일까지.
const ROSTER_FROM = "2026-08-17";
const ROSTER_TO = "2026-08-20";

// 시나리오 1.2 의 activeHeadcount.
const ACTIVE_HEADCOUNT = 122;
const PRINCIPAL_HEADCOUNT = 11;

export type RosterCompany = {
  companyId: string;
  상호: string | null;
  trade: string;
  인원: number;
  status: string;
  출역: boolean;
};

// 시나리오 1.2 subcontractors 그대로. 상호는 확인된 둘만 적는다
// (8월 19일 카드의 "서진건설 2 · 한빛가설 2").
const COMPANIES: RosterCompany[] = [
  { companyId: "sub_daeyang", 상호: null, trade: "토공", 인원: 18, status: "준공", 출역: false },
  { companyId: "sub_seojin", 상호: "서진건설", trade: "골조(철근콘크리트)", 인원: 62, status: "진행", 출역: true },
  { companyId: "sub_hanbit", 상호: "한빛가설", trade: "가설·비계", 인원: 21, status: "진행", 출역: true },
  { companyId: "sub_jungang", 상호: null, trade: "양중(타워크레인)", 인원: 6, status: "진행", 출역: true },
  { companyId: "sub_kyungin", 상호: null, trade: "전기", 인원: 14, status: "대기", 출역: false },
  { companyId: "sub_woori", 상호: null, trade: "설비", 인원: 11, status: "대기", 출역: false },
];

// TBM 을 도는 세 팀. 8월 19일 카드("오늘 TBM 3개 팀 실시", "내일 TBM 자료 3건 ·
// 골조 · 가설 · 양중")에서 왔다.
const TEAMS = ["골조", "가설", "양중"] as const;

export type NewWorker = {
  personId: string;
  표기: string;
  팀: string;
  소속: string;
  첫출역일: string;
  최근출역일: string | null;
  직전30일출역: boolean;
  모국어: "한국어" | "비한국어";
  통역필요: boolean;
  신규입장자교육: boolean;
};

// 신규 11명. 팀 배분은 하도급사 인원 비율(62 : 21 : 6)을 따라 골조 8 · 가설 2 ·
// 양중 1 로 두었고, 통역이 필요한 넷은 감지 규칙 사양이 준 숫자다.
const NEW_WORKER_SEEDS: Array<
  Pick<NewWorker, "personId" | "표기" | "팀" | "소속" | "첫출역일" | "모국어" | "통역필요">
> = [
  { personId: "w_new_01", 표기: "신규-01", 팀: "골조", 소속: "sub_seojin", 첫출역일: "2026-08-17", 모국어: "한국어", 통역필요: false },
  { personId: "w_new_02", 표기: "신규-02", 팀: "골조", 소속: "sub_seojin", 첫출역일: "2026-08-17", 모국어: "비한국어", 통역필요: true },
  { personId: "w_new_03", 표기: "신규-03", 팀: "골조", 소속: "sub_seojin", 첫출역일: "2026-08-17", 모국어: "한국어", 통역필요: false },
  { personId: "w_new_04", 표기: "신규-04", 팀: "가설", 소속: "sub_hanbit", 첫출역일: "2026-08-17", 모국어: "한국어", 통역필요: false },
  { personId: "w_new_05", 표기: "신규-05", 팀: "골조", 소속: "sub_seojin", 첫출역일: "2026-08-18", 모국어: "비한국어", 통역필요: true },
  { personId: "w_new_06", 표기: "신규-06", 팀: "골조", 소속: "sub_seojin", 첫출역일: "2026-08-18", 모국어: "한국어", 통역필요: false },
  { personId: "w_new_07", 표기: "신규-07", 팀: "양중", 소속: "sub_jungang", 첫출역일: "2026-08-18", 모국어: "한국어", 통역필요: false },
  { personId: "w_new_08", 표기: "신규-08", 팀: "골조", 소속: "sub_seojin", 첫출역일: "2026-08-19", 모국어: "비한국어", 통역필요: true },
  { personId: "w_new_09", 표기: "신규-09", 팀: "가설", 소속: "sub_hanbit", 첫출역일: "2026-08-19", 모국어: "한국어", 통역필요: false },
  { personId: "w_new_10", 표기: "신규-10", 팀: "골조", 소속: "sub_seojin", 첫출역일: "2026-08-20", 모국어: "비한국어", 통역필요: true },
  { personId: "w_new_11", 표기: "신규-11", 팀: "골조", 소속: "sub_seojin", 첫출역일: "2026-08-20", 모국어: "한국어", 통역필요: false },
];

export type RosterDayValue = {
  날짜: string;
  총원: number;
  총원출처: string;
  원청인원: number;
  협력사수: number;
  회사별: RosterCompany[];
  회사별합계: number;
  주석: string;
  팀: string[];
  신규인원: NewWorker[];
  신규인원수: number;
  통역필요인원: number;
};

export type NewWorkerSummaryValue = {
  기간시작: string;
  기간종료: string;
  조회기준일: string;
  신규합계: number;
  통역필요: number;
  팀별: Record<string, number>;
  일자별: Record<string, number>;
  주석: string;
};

const HEADCOUNT_NOTE =
  "총원은 시나리오의 activeHeadcount 122 를 그대로 씁니다. 하도급사 인원 합계와 " +
  "맞지 않는 차이는 재하도급 물량팀 9개 몫으로 보이며 시나리오에 인원수가 없습니다.";

function toWorker(
  seed: (typeof NEW_WORKER_SEEDS)[number],
  날짜: string,
): NewWorker {
  return {
    ...seed,
    // 직전 30일간 출역 기록이 없다는 것이 신규 판정의 근거다.
    최근출역일: null,
    직전30일출역: false,
    // 교육 기록은 T-08 이 만들어 낼 산출물이므로 아직 없다.
    신규입장자교육: false,
    첫출역일: 날짜,
  };
}

/** ROSTER_FROM 부터 오늘(또는 ROSTER_TO)까지. 명부는 그날이 되어야 존재한다. */
function visibleDays(오늘: string): string[] {
  const days: string[] = [];
  for (const seed of NEW_WORKER_SEEDS) {
    if (!days.includes(seed.첫출역일)) days.push(seed.첫출역일);
  }
  return days
    .filter((day) => day >= ROSTER_FROM && day <= ROSTER_TO && day <= 오늘)
    .sort();
}

async function fetchRosterFacts(siteId: string, at: Date): Promise<SnapshotFact[]> {
  const observedAt = kstStamp(at);
  const 오늘 = kstDay(at);
  const days = visibleDays(오늘);

  const 회사별합계 =
    COMPANIES.filter((company) => company.출역).reduce((sum, company) => sum + company.인원, 0) +
    PRINCIPAL_HEADCOUNT;

  const facts: SnapshotFact[] = [];
  const 팀별: Record<string, number> = Object.fromEntries(TEAMS.map((team) => [team, 0]));
  const 일자별: Record<string, number> = {};
  let 신규합계 = 0;
  let 통역합계 = 0;

  for (const 날짜 of days) {
    const 신규인원 = NEW_WORKER_SEEDS.filter((seed) => seed.첫출역일 === 날짜).map((seed) =>
      toWorker(seed, 날짜),
    );
    const 통역필요인원 = 신규인원.filter((worker) => worker.통역필요).length;

    신규합계 += 신규인원.length;
    통역합계 += 통역필요인원;
    일자별[날짜] = 신규인원.length;
    for (const worker of 신규인원) {
      팀별[worker.팀] = (팀별[worker.팀] ?? 0) + 1;
    }

    facts.push(
      makeFact({
        siteId,
        factType: "attendanceRoster",
        key: `출역_${날짜}`,
        value: {
          날짜,
          총원: ACTIVE_HEADCOUNT,
          총원출처: "시나리오 1.2 activeHeadcount",
          원청인원: PRINCIPAL_HEADCOUNT,
          협력사수: COMPANIES.length,
          회사별: COMPANIES,
          회사별합계,
          주석: HEADCOUNT_NOTE,
          팀: [...TEAMS],
          신규인원,
          신규인원수: 신규인원.length,
          통역필요인원,
        } satisfies RosterDayValue,
        observedAt,
        sourceDocId: ROSTER_SOURCE_DOC_ID,
        confidence: 1,
      }),
    );
  }

  facts.push(
    makeFact({
      siteId,
      factType: "attendanceRoster",
      key: `신규인원_주간_${ROSTER_FROM}`,
      value: {
        기간시작: ROSTER_FROM,
        기간종료: days.length ? days[days.length - 1] : ROSTER_FROM,
        조회기준일: 오늘,
        신규합계,
        통역필요: 통역합계,
        팀별,
        일자별,
        주석:
          오늘 >= ROSTER_TO
            ? "주중 4일에 걸쳐 신규 11명, 그 가운데 4명이 통역이 필요합니다."
            : `${ROSTER_TO} 까지의 명부 가운데 ${오늘} 까지만 집계했습니다. 남은 날의 신규 인원은 그날이 되어야 드러납니다.`,
      } satisfies NewWorkerSummaryValue,
      observedAt,
      sourceDocId: ROSTER_SOURCE_DOC_ID,
      confidence: 1,
    }),
  );

  return facts;
}

export const rosterConnector: Connector = {
  id: "roster",
  label: "출역 명부",
  factTypes: ["attendanceRoster"],
  fetch: fetchRosterFacts,
};
