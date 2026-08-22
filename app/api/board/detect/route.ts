import { kstIsoOf, kstNowIso } from "@/lib/board/briefing";
import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import type { DetectionRun, SnapshotFact } from "@/lib/board/types";
import { runDetect } from "@/lib/detect/engine";
import { triggerRules } from "@/lib/detect/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: HEADERS });
}

// 같은 현장의 감지가 겹쳐 돌면 같은 조건이 두 번 기록된다. 카드는 itemId 가 결정적이라
// 겹쳐도 한 장이지만, 실행 기록까지 깨끗하려면 한 번에 하나만 돌아야 한다.
// 프로세스 안에서만 유효한 잠금이라 인스턴스가 늘면 저장소 잠금으로 옮겨야 한다.
const 진행중 = new Set<string>();

export async function POST(req: Request) {
  let body: { siteId?: unknown; at?: unknown };
  try {
    body = (await req.json()) as { siteId?: unknown; at?: unknown };
  } catch {
    return fail("JSON 본문이 필요합니다.", 400);
  }
  if (!body || typeof body !== "object") return fail("JSON 본문이 필요합니다.", 400);

  const siteId = typeof body.siteId === "string" ? body.siteId.trim() : "";
  if (!siteId) return fail("siteId 가 필요합니다.", 400);

  let at: string;
  if (body.at === undefined || body.at === null) {
    at = kstNowIso();
  } else if (typeof body.at === "string" && Number.isFinite(Date.parse(body.at))) {
    // 안으로 들어온 순간 KST 표기로 통일한다. 시각 비교가 전부 문자열 비교이기 때문이다.
    at = kstIsoOf(Date.parse(body.at));
  } else {
    return fail("at 은 ISO8601 시각이어야 합니다.", 400);
  }

  if (진행중.has(siteId)) return fail("이 현장의 감지가 아직 진행 중입니다.", 409);
  진행중.add(siteId);
  try {
    const run = await 감지실행(siteId, at);
    return Response.json({ run }, { status: 201, headers: HEADERS });
  } catch (error) {
    if (isBoardStoreError(error)) {
      return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    }
    throw error;
  } finally {
    진행중.delete(siteId);
  }
}

async function 감지실행(siteId: string, at: string): Promise<DetectionRun> {
  const store = boardStore();
  const 기준 = Date.parse(at);

  const [전체사실, previousDetections] = await Promise.all([
    store.listFacts(siteId),
    store.listDetections(siteId),
  ]);

  // at 을 과거로 넣으면 그 시점의 사실만 본다. 같은 인자로 다시 불렀을 때 같은 답이
  // 나와야 감지 기록이 나중에 방어 근거로 쓸모가 있다.
  const facts: SnapshotFact[] = 전체사실.filter((f) => {
    const t = Date.parse(f.observedAt);
    return Number.isFinite(t) && t <= 기준;
  });

  // 규칙 실행과 카드 조립은 lib/detect/engine.ts 가 한다. 라우트는 사실을 모아 주고
  // 결과를 저장소에 밀어 넣는 일만 한다 — 감지 규칙이 늘어도 이 파일은 그대로다.
  const run = runDetect({
    siteId,
    now: at,
    facts,
    rules: triggerRules,
    previousDetections,
    runId: `run_${압축시각(기준)}_${짧은해시(siteId)}`,
  });

  // itemId 가 (현장 · 규칙 · 근거)로 정해지므로 같은 조건을 두 번 감지해도 저장소가
  // 같은 행을 다시 쓴다. 카드가 두 장 생기지 않는 근거가 여기다.
  const created = run.created.length > 0 ? await store.upsertItems(run.created) : [];
  const 기록: DetectionRun = { ...run, created };

  await store.appendDetections(기록);
  return 기록;
}

function 압축시각(epochMs: number): string {
  const iso = kstIsoOf(epochMs);
  return `${iso.slice(0, 10).replace(/-/g, "")}_${iso.slice(11, 16).replace(":", "")}`;
}

/** FNV-1a. 짧고 ASCII 라 runId 에 그대로 실을 수 있다. 현장이 둘 이상이어도 겹치지 않는다 */
function 짧은해시(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}
