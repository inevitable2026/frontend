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

/**
 * 문서가 어느 현장 것인지 추천한다.
 *
 * **낮은 일치도도 후보로는 돌려준다.** "가장 가까운 것이 이것인데 12% 밖에 안 맞는다"는
 * 사람에게 쓸모 있는 정보이고, 그걸 숨기면 화면이 아무 단서 없이 목록만 내밀게 된다.
 *
 * 대신 그 값을 **자동으로 골라도 되는지**를 함께 말한다(`충분함`). 예전에는 임계값이
 * `reason` 문구를 고르는 데만 쓰여서, 화면은 "직접 고르세요" 라고 적으면서 동시에
 * 그 현장을 미리 선택해 두었다. 담당자가 문구를 지나치고 저장을 누르면 12% 짜리
 * 추측으로 문서와 청크 전부가 그 현장에 확정된다.
 */
export async function recommendSite(fields: ExtractedFields): Promise<SiteRecommendation | null> {
  const [top] = await siteCandidates(fields, 1);
  if (!top || top.score <= 0) return null;

  const percent = (top.score * 100).toFixed(0);
  const 충분함 = top.score >= CONFIDENCE_THRESHOLD;

  return {
    siteId: top.siteId,
    code: top.code,
    name: top.name,
    confidence: Number(top.score.toFixed(3)),
    충분함,
    reason: 충분함
      ? `문서의 "${top.matched}" 이(가) 현장 "${top.name}"(${top.code}) 과 ${percent}% 일치합니다.`
      : `가장 가까운 현장이 "${top.name}" 이지만 일치도가 ${percent}% 로 낮습니다. 직접 고르세요.`,
  };
}
