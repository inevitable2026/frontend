import { db } from "@/lib/context/db";
import type { ExtractedFields, SiteRecommendation } from "@/lib/context/types";

export const CONFIDENCE_THRESHOLD = 0.3;

type Candidate = { siteId: string; code: string; name: string; score: number; matched: string };

export async function siteCandidates(fields: ExtractedFields, limit = 3): Promise<Candidate[]> {
  const probes = [fields.현장명, fields.업체명].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 1,
  );
  if (probes.length === 0) return [];

  const sql = db();
  const rows = await sql<Array<{ id: string; code: string; name: string; score: number; matched: string }>>`
    select s.id, s.code, s.name,
           max(greatest(similarity(s.name, q.v), similarity(s.code, q.v)))::float8 as score,
           (array_agg(q.v order by greatest(similarity(s.name, q.v), similarity(s.code, q.v)) desc))[1] as matched
      from sites s
      cross join unnest(${probes}::text[]) as q(v)
     group by s.id, s.code, s.name
     order by score desc
     limit ${limit}
  `;

  return rows.map((r) => ({
    siteId: r.id,
    code: r.code,
    name: r.name,
    score: Number(r.score) || 0,
    matched: r.matched,
  }));
}

export async function recommendSite(fields: ExtractedFields): Promise<SiteRecommendation | null> {
  const [top] = await siteCandidates(fields, 1);
  if (!top || top.score <= 0) return null;

  const percent = (top.score * 100).toFixed(0);
  return {
    siteId: top.siteId,
    code: top.code,
    name: top.name,
    confidence: Number(top.score.toFixed(3)),
    reason:
      top.score >= CONFIDENCE_THRESHOLD
        ? `문서의 "${top.matched}" 이(가) 현장 "${top.name}"(${top.code}) 과 ${percent}% 일치합니다.`
        : `가장 가까운 현장이 "${top.name}" 이지만 일치도가 ${percent}% 로 낮습니다. 직접 고르세요.`,
  };
}
