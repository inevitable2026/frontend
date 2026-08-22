import { db } from "@/lib/context/db";
import { triggerRules } from "@/lib/detect/rules";

import { buildBriefing, kstIsoOf, kstNowIso } from "./briefing";
import { boardStore } from "./store";
import type { Briefing, WeekPage, WorkItem } from "./types";
import { addDays, buildWeekPage, mondayOf, 이번주카드 } from "./week";

// 첫 화면 한 장에 필요한 것을 한 번에 모은다.
//
// 이 파일이 생긴 이유는 왕복 횟수다. 예전에는 화면이 items · week · briefing · sites ·
// documents 다섯 라우트를 동시에 불렀는데, 그 다섯이 서버에서 다시 열댓 번의 질의로
// 갈라졌다. 특히 현장 전체 카드를 읽는 listItems 하나를 세 라우트가 각각 불렀고,
// items 라우트는 자기 안에서도 두 번 불렀다. Railway Postgres 는 왕복 한 번이 300ms 라
// 그 중복이 그대로 첫 화면의 대기 시간이 되었다.
//
// 여기서는 카드 목록을 한 번만 읽어 셋이 나눠 쓴다. 남는 질의는 감지 · 현장 이름 · 문서함
// 셋뿐이고, 넷 모두 함께 나간다.
//
// 기존 다섯 라우트는 그대로 둔다. 이 함수는 첫 화면이 쓰는 지름길이지 그 라우트들의
// 대체가 아니다 — 문서함 화면과 주간 보드는 여전히 자기 라우트를 따로 부른다.

/**
 * 브리핑이 거슬러 올라가는 창. 조건은 어제 저녁에 감지되고 화면은 오늘 아침이라
 * 하루는 있어야 어제 것이 창 안에 들어온다. app/api/board/briefing 과 같은 값이다.
 */
const WINDOW_HOURS = 24;

// 규칙 이름표는 규칙 자신이 들고 있다. 여기서 다시 적으면 두 곳이 갈라진다.
const RULE_LABELS = Object.fromEntries(triggerRules.map((rule) => [rule.id, rule.label]));

/** 화면이 못 찾았을 때 쓰는 현장 이름. components/task-board/presentation.ts 와 같은 값이다. */
const SITE_NAME_FALLBACK = "현장";

/** view-model 이 문서함에서 실제로 읽는 네 칸이다. 나머지 열은 첫 화면에 쓰이지 않는다. */
export type BoardSourceDocument = {
  id: string;
  title: string;
  kind: string;
  created_at: string;
};

/**
 * 첫 화면이 그대로 뷰모델에 넘길 수 있는 한 벌이다.
 * components/task-board/view-model.ts 의 BoardSources 와 같은 모양이어야 한다.
 */
export type BoardSources = {
  siteId: string;
  date: string;
  siteName: string;
  items: WorkItem[];
  week: WeekPage;
  briefing: Briefing;
  documents: BoardSourceDocument[];
};

/**
 * 현장 이름 한 칸만 읽는다.
 *
 * /api/context/sites 는 현장 전체를 문서 수까지 세어 돌려주는데, 첫 화면에 필요한 것은
 * 이 현장의 이름 하나다. 실패는 삼키고 대체 문구로 간다 — 이름을 못 읽었다고 카드 열한 장과
 * 브리핑까지 함께 무너질 이유가 없다.
 */
async function 현장이름(siteId: string): Promise<string> {
  try {
    const sql = db();
    const [row] = await sql<Array<{ name: string }>>`
      select name from sites where id = ${siteId} limit 1
    `;
    return row?.name ?? SITE_NAME_FALLBACK;
  } catch {
    return SITE_NAME_FALLBACK;
  }
}

/**
 * 이 현장의 문서 목록. 실패하면 `null` 이고, 그것은 "한 건도 없다" 와 다른 자리에 선다 —
 * 빈 배열로 돌리면 브리핑이 "문서가 들어오지 않았다" 고 적어 사실과 어긋난다.
 */
async function 문서목록(siteId: string): Promise<BoardSourceDocument[] | null> {
  try {
    const sql = db();
    const rows = await sql<Array<{ id: string; title: string; kind: string; created_at: Date }>>`
      select id, title, kind, created_at
        from documents
       where site_id = ${siteId}
       order by created_at desc
       limit 200
    `;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  } catch {
    return null;
  }
}

/**
 * 브리핑 첫 문장의 "문서 N건을 읽어" 가 쓰는 값이다.
 *
 * 문서함을 이미 읽어 왔으므로 질의를 한 번 더 보내지 않고 그 목록에서 센다. 목록은 최신순
 * 200건이라 24시간 창 안의 문서는 반드시 그 안에 들어 있다. 읽지 못했으면 `undefined` 다.
 */
function 창안문서수(
  documents: BoardSourceDocument[] | null,
   창시작: string,
  기준: string,
): number | undefined {
  if (documents === null) return undefined;
  const 시작 = Date.parse(창시작);
  const 끝 = Date.parse(기준);
  if (!Number.isFinite(시작) || !Number.isFinite(끝)) return undefined;
  return documents.filter((문서) => {
    const t = Date.parse(문서.created_at);
    return Number.isFinite(t) && t >= 시작 && t <= 끝;
  }).length;
}

export class BoardSourcesError extends Error {
  readonly code: "notFound";

  constructor(message: string) {
    super(message);
    this.name = "BoardSourcesError";
    this.code = "notFound";
  }
}

/**
 * 보드 한 장의 재료를 모은다.
 *
 * `date` 는 칸반이 그리는 날이고 `at` 은 브리핑이 거슬러 올라가는 기준 시각이다. 둘을 따로
 * 받는 이유는 브리핑의 24시간 창이 시각 단위로 움직이기 때문이다.
 *
 * 카드 목록에 날짜 조건을 걸지 않는다. 날짜 거르기는 화면의 isOnDate 가 이미 하고 있고,
 * 기한이 없는 승인 카드가 date 조건에 걸려 사라지면 칸반의 승인 열이 통째로 빈다.
 */
export async function loadBoardSources(
  siteId: string,
  date: string,
  atRaw?: string,
): Promise<BoardSources> {
  const at = atRaw ? kstIsoOf(Date.parse(atRaw)) : kstNowIso();

  // listDetections 의 since 는 문자열끼리 비교한다. UTC 표기로 넘기면 같은 순간이라도
  // 자릿수가 어긋나 어제 것이 통째로 빠지므로 KST 표기로 맞춰 넘긴다.
  const 창시작 = kstIsoOf(Date.parse(at) - WINDOW_HOURS * 3_600_000);

  const store = boardStore();
  const [page, detections, siteName, documents] = await Promise.all([
    store.listItems({ siteId }),
    store.listDetections(siteId, 창시작),
    현장이름(siteId),
    문서목록(siteId),
  ]);

  if (page.total === 0 && detections.length === 0) {
    if ((await store.latestSnapshotAt(siteId)) === null) {
      throw new BoardSourcesError("그런 현장이 없습니다.");
    }
  }

  const briefing = buildBriefing({
    siteId,
    at,
    windowHours: WINDOW_HOURS,
    detections,
    items: page.items,
    documentCount: 창안문서수(documents, 창시작, at),
    labels: RULE_LABELS,
  });

  return {
    siteId,
    date,
    siteName,
    items: page.items,
    week: buildWeekPage(siteId, date, 이번주카드(page.items, ...주범위(date))),
    briefing,
    documents: documents ?? [],
  };
}

/** buildWeekPage 가 쓰는 월요일~일요일 구간. 카드를 미리 추리는 데에도 같은 값을 쓴다. */
function 주범위(date: string): [string, string] {
  const from = mondayOf(date);
  return [from, addDays(from, 6)];
}
