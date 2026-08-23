import { db } from "@/lib/context/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 행 검토·반영 저장소의 스키마(tbm-check 마이그레이션 0007·0008)를 적용한다.
 *
 * 왜 이 라우트가 있는가: 그 마이그레이션의 정본은 tbm-check 레포의 drizzle 이지만,
 * 프로덕션 Postgres 는 내부 호스트뿐이라 어느 레포의 마이그레이션 러너도 밖에서 닿을
 * 수 없다. DB 에 붙어 있는 것은 배포된 앱뿐이므로, seed-item 과 같은 인증 아래에서
 * 같은 DDL 을 그대로 실행한다. 아래 SQL 은 tbm-check/drizzle/
 * 0007_persist_risk_row_reviews.sql · 0008_persist-risk-row-applications.sql 의
 * 사본이다 — 여기서 문장을 고치면 두 레포의 스키마가 갈라지므로 고치지 않는다.
 *
 * 멱등성: 각 마이그레이션은 자신이 만드는 첫 테이블이 이미 있으면 통째로 건너뛴다.
 * 문장 단위 IF NOT EXISTS 로 바꾸지 않는 이유는 위와 같다 — 정본과 글자가 달라진다.
 */

const MIGRATION_0007 = `
CREATE TABLE "risk_row_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"work_item_id" text NOT NULL,
	"row_id" text NOT NULL,
	"row_fingerprint" text NOT NULL,
	"decision" text NOT NULL,
	"version" bigint NOT NULL,
	"expected_version" bigint NOT NULL,
	"actor" text NOT NULL,
	"review_created_at" timestamp with time zone NOT NULL,
	"review_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_row_reviews" (
	"site_id" uuid NOT NULL,
	"work_item_id" text NOT NULL,
	"row_id" text NOT NULL,
	"row_fingerprint" text NOT NULL,
	"decision" text NOT NULL,
	"version" bigint NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "risk_row_review_events" ADD CONSTRAINT "risk_row_review_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_row_reviews" ADD CONSTRAINT "risk_row_reviews_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_row_review_events_command_idx" ON "risk_row_review_events" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_row_review_events_identity_version_idx" ON "risk_row_review_events" USING btree ("site_id","work_item_id","row_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_row_reviews_identity_idx" ON "risk_row_reviews" USING btree ("site_id","work_item_id","row_id");--> statement-breakpoint
CREATE INDEX "risk_row_reviews_site_updated_idx" ON "risk_row_reviews" USING btree ("site_id","updated_at");
--> statement-breakpoint
ALTER TABLE "risk_row_reviews" ADD CONSTRAINT "risk_row_reviews_decision_check" CHECK ("decision" IN ('held', 'approved'));
--> statement-breakpoint
ALTER TABLE "risk_row_reviews" ADD CONSTRAINT "risk_row_reviews_version_check" CHECK ("version" > 0);
--> statement-breakpoint
ALTER TABLE "risk_row_review_events" ADD CONSTRAINT "risk_row_review_events_decision_check" CHECK ("decision" IN ('held', 'approved'));
--> statement-breakpoint
ALTER TABLE "risk_row_review_events" ADD CONSTRAINT "risk_row_review_events_version_check" CHECK ("version" = "expected_version" + 1);
--> statement-breakpoint
CREATE FUNCTION public.reject_risk_row_review_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'risk_row_review_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "risk_row_review_events_immutable"
BEFORE UPDATE OR DELETE ON "risk_row_review_events"
FOR EACH ROW EXECUTE FUNCTION public.reject_risk_row_review_event_mutation();
`;

const MIGRATION_0008 = `
CREATE TABLE "risk_row_application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"work_item_id" text NOT NULL,
	"work_item_event_id" bigint NOT NULL,
	"target_document_id" text NOT NULL,
	"row_ids" text[] NOT NULL,
	"fact_ids" bigint[] NOT NULL,
	"request_fingerprint" text NOT NULL,
	"actor" text NOT NULL,
	"result" jsonb NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "risk_row_application_events" ADD CONSTRAINT "risk_row_application_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_row_application_events_command_idx" ON "risk_row_application_events" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_row_application_events_work_item_idx" ON "risk_row_application_events" USING btree ("site_id","work_item_id");--> statement-breakpoint
ALTER TABLE "risk_row_application_events" ADD CONSTRAINT "risk_row_application_events_target_document_id_nonblank_check" CHECK (btrim("target_document_id") <> '');--> statement-breakpoint
ALTER TABLE "risk_row_application_events" ADD CONSTRAINT "risk_row_application_events_request_fingerprint_nonblank_check" CHECK (btrim("request_fingerprint") <> '');--> statement-breakpoint
ALTER TABLE "risk_row_application_events" ADD CONSTRAINT "risk_row_application_events_actor_nonblank_check" CHECK (btrim("actor") <> '');--> statement-breakpoint
ALTER TABLE "risk_row_application_events" ADD CONSTRAINT "risk_row_application_events_result_object_check" CHECK (jsonb_typeof("result") = 'object');--> statement-breakpoint
ALTER TABLE "risk_row_application_events" ADD CONSTRAINT "risk_row_application_events_row_ids_nonempty_check" CHECK (cardinality("row_ids") > 0);--> statement-breakpoint
ALTER TABLE "risk_row_application_events" ADD CONSTRAINT "risk_row_application_events_input_cardinality_check" CHECK (cardinality("row_ids") = cardinality("fact_ids"));--> statement-breakpoint
CREATE FUNCTION public.reject_risk_row_application_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'risk_row_application_events is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "risk_row_application_events_immutable"
BEFORE UPDATE OR DELETE ON "risk_row_application_events"
FOR EACH ROW EXECUTE FUNCTION public.reject_risk_row_application_event_mutation();
`;

function statements(migration: string): string[] {
  return migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function fail(message: string, status: number, code?: string) {
  return Response.json(code ? { error: message, code } : { error: message }, {
    status,
    headers: HEADERS,
  });
}

/** sweep · seed-item 라우트의 허가됨() 과 같은 규칙. */
function 허가됨(request: Request): boolean {
  const token = process.env.SWEEPER_TOKEN?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const header = request.headers.get("x-sweeper-token")?.trim();

  if (token && header && header === token) return true;
  if (cronSecret && bearer && bearer === cronSecret) return true;
  return false;
}

export async function POST(request: Request) {
  if (!허가됨(request)) {
    return fail("이 요청은 허용되지 않았습니다.", 401, "schema_unauthorized");
  }

  const sql = db();
  const result: Record<string, "applied" | "skipped"> = {};

  try {
    const [state] = await sql<{ reviews: string | null; applications: string | null }[]>`
      select to_regclass('public.risk_row_reviews') as reviews,
             to_regclass('public.risk_row_application_events') as applications
    `;

    if (state?.reviews) {
      result["0007"] = "skipped";
    } else {
      await sql.begin(async (tx) => {
        for (const statement of statements(MIGRATION_0007)) await tx.unsafe(statement);
      });
      result["0007"] = "applied";
    }

    if (state?.applications) {
      result["0008"] = "skipped";
    } else {
      await sql.begin(async (tx) => {
        for (const statement of statements(MIGRATION_0008)) await tx.unsafe(statement);
      });
      result["0008"] = "applied";
    }

    return Response.json({ ok: true, migrations: result }, { headers: HEADERS });
  } catch (error) {
    console.error("[board/risk-row-schema] 적용 실패:", error);
    return fail("스키마를 적용하지 못했습니다. 서버 로그를 확인해 주세요.", 503, "schema_failed");
  }
}
