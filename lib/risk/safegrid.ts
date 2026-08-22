import type { Assessment, SourceDoc, 문서분석, 사진분석, 생성모드, 어휘 } from "./types";

/**
 * SAFEGRID 클라이언트 — 위험성평가 백엔드 호출을 한 곳에 모은다.
 *
 * **서버에서만 쓴다.** 브라우저가 SAFEGRID 를 직접 부르면 주소가 번들에 박히고,
 * 그 API 는 인증이 없어 주소를 아는 사람이 `GET /assessments` 로 다른 현장 평가표까지
 * 조회할 수 있다. 그래서 `app/api/risk/*` 라우트가 이 파일을 감싼다.
 *
 * 형제 탭의 `lib/context/*` 와 같은 자리에 둔다.
 */

function 베이스(): string {
  const url = process.env.SAFEGRID_API_URL;
  if (!url) {
    // 주소를 코드에 적어 두지 않는다 — public 저장소다. 없으면 없다고 말한다.
    throw new Error("SAFEGRID_API_URL 이 설정되지 않았습니다.");
  }
  return url.replace(/\/+$/, "");
}

/**
 * 제한시간은 실측에서 나왔다. 짐작으로 정하면 안 되는 값이다 —
 * 처음에 20초로 뒀다가 생성이 44~55초라 라이브가 **100% 실패**했고,
 * 실패가 폴백으로 가려져 성공처럼 보였다.
 *
 * 생성 실측: 6행 36.9초 / 8행 low 44.4초 / 8행 medium 54.9초 / 12행 63.8초.
 * 문서 파싱 약 15초, 사진 판독 약 20초.
 */
const 생성_제한시간 = 55_000;
const 인제스트_제한시간 = 45_000;
const 조회_제한시간 = 20_000;

/** 라이브 기본값. 행이 늘수록 시간이 선형으로 는다(행당 약 4.5초 + 고정 10초). */
const 라이브_기본건수 = 8;
/**
 * 실측(철거·해체 8행): medium 54.9초 / low 44.4초. 고유 사고분류는 둘 다 7종으로 같았다.
 * 제한시간이 55초라 medium 은 여유가 0.1초뿐이다. low 를 쓴다.
 */
const 라이브_강도 = "low";

/** 저쪽이 null 을 주는 자리를 화면이 다루기 쉬운 빈 값으로 바꾼다. */
function 널정규화<T>(value: T): T {
  if (Array.isArray(value)) return value.map(널정규화) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = v === null ? v : 널정규화(v);
    return out as T;
  }
  return value;
}

async function 부르기(경로: string, init: RequestInit, 제한시간: number): Promise<Response> {
  return fetch(`${베이스()}${경로}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(제한시간),
  });
}

export type 생성입력 = {
  industry?: string;
  work_types?: string[];
  equipment?: string[];
  materials?: string[];
  description?: string;
  photo_findings?: string[];
  method?: string;
  matrix?: string;
  criteria?: Record<string, unknown>;
  건수?: number;
  site?: string | null;
  source_documents?: SourceDoc[];
};

/**
 * 평가표 생성. POST /assess
 *
 * **모드에 따라 `engine` 이 달라지고, 그 차이가 실패 처리까지 바꾼다.**
 * 저쪽은 `engine === "claude"` 일 때만 실패를 503 으로 올린다. 그 외에는 조용히 시드표로
 * 폴백하고 200 을 준다(`main.py:249-252`). 라이브를 골랐는데 조용히 폴백하면 화면에는
 * 그럴듯한 표가 뜨지만 그건 문서와 아무 상관이 없다. 그래서 라이브는 반드시 "claude" 를
 * 그대로 보낸다.
 */
export async function 평가생성(모드: 생성모드, 입력: 생성입력): Promise<Assessment> {
  const 라이브 = 모드 === "라이브";
  const res = await 부르기(
    "/assess",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        industry: 입력.industry ?? "건축공사",
        work_types: 입력.work_types ?? [],
        equipment: 입력.equipment ?? [],
        materials: 입력.materials ?? [],
        description: 입력.description ?? "",
        photo_findings: 입력.photo_findings ?? [],
        method: 입력.method,
        matrix: 입력.matrix,
        criteria: 입력.criteria,
        site: 입력.site ?? null,
        source_documents: 입력.source_documents ?? [],
        engine: 라이브 ? "claude" : "auto",
        ...(라이브 ? { count: 입력.건수 ?? 라이브_기본건수, effort: 라이브_강도 } : {}),
      }),
    },
    생성_제한시간,
  );

  if (!res.ok) {
    const 사유 = await res.text().catch(() => "");
    throw new Error(`평가 생성 실패 (${res.status})${사유 ? ` — ${사유.slice(0, 200)}` : ""}`);
  }
  return 널정규화(await res.json()) as Assessment;
}

/**
 * 문서 1건 파싱. POST /ingest/doc
 *
 * 저쪽은 파일을 한 번에 하나만 받는다. 여러 장이면 호출을 나눠야 하고, 그 나눔은
 * 화면이 `Promise.allSettled` 로 처리한다 — 한 문서가 실패해도 나머지 패널은
 * 자기 결과를 보여줘야 하기 때문이다.
 */
export async function 문서파싱(file: File): Promise<문서분석> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await 부르기("/ingest/doc", { method: "POST", body: fd }, 인제스트_제한시간);
  if (!res.ok) throw new Error(`문서 파싱 실패 (${res.status}) — ${file.name}`);
  return 널정규화(await res.json()) as 문서분석;
}

/** 사진 판독. POST /ingest/photo — 한 장이라도 실패하면 전체가 503 이라 장당 부르는 편이 안전하다. */
export async function 사진판독(files: File[]): Promise<사진분석> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f, f.name);
  const res = await 부르기("/ingest/photo", { method: "POST", body: fd }, 인제스트_제한시간);
  if (!res.ok) throw new Error(`사진 판독 실패 (${res.status})`);
  return 널정규화(await res.json()) as 사진분석;
}

export async function 어휘읽기(): Promise<어휘> {
  const res = await 부르기("/vocabulary", {}, 10_000);
  if (!res.ok) throw new Error(`어휘 조회 실패 (${res.status})`);
  return (await res.json()) as 어휘;
}

/** 지금까지 만든 평가 목록. 저쪽이 일자별로 묶어서 준다. */
export type 평가요약 = { id: string; title: string; created_at: string };
export type 평가일자 = { date: string; items: 평가요약[] };

export async function 평가목록(): Promise<{ days: 평가일자[] }> {
  const res = await 부르기("/assessments", {}, 조회_제한시간);
  if (!res.ok) throw new Error(`평가 목록 조회 실패 (${res.status})`);
  return (await res.json()) as { days: 평가일자[] };
}

/** 평가 1건 조회. 새로고침 복원과 이행확인 저장 후 재확인에 쓴다. */
export async function 평가읽기(id: string): Promise<Assessment> {
  const res = await 부르기(`/assessments/${encodeURIComponent(id)}`, {}, 조회_제한시간);
  if (!res.ok) throw new Error(`평가 조회 실패 (${res.status})`);
  return 널정규화(await res.json()) as Assessment;
}

/**
 * 이행확인 저장. PATCH /assessments/{id}
 *
 * 화면 상태만 바꾸고 끝내면 안 되는 이유 — 엑셀은 저쪽이 만들고, 이행확인 열을
 * **SAFEGRID 자기 DB 의 payload 에서** 읽는다. 여기로 보내지 않으면 화면에는 체크가
 * 보이는데 내려받은 파일은 전부 빈칸이다.
 *
 * 저쪽은 전체 payload 를 치환한다. 부분 갱신이 아니므로 평가 전체를 보낸다.
 */
export async function 이행확인저장(id: string, assessment: Assessment): Promise<Assessment> {
  const res = await 부르기(
    `/assessments/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(assessment),
    },
    조회_제한시간,
  );
  if (!res.ok) throw new Error(`이행확인 저장 실패 (${res.status})`);
  return 널정규화(await res.json()) as Assessment;
}

/** 엑셀 내려받기. 파일을 그대로 흘려보낸다. */
export async function 엑셀받기(id: string): Promise<Response> {
  return 부르기(`/assessments/${encodeURIComponent(id)}/export.xlsx`, {}, 조회_제한시간);
}
