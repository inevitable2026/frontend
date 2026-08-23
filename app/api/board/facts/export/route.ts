import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import { 평가표바이트, type 서식머리 } from "@/lib/risk/assessment-sheet";
import { 문서표시 } from "@/lib/risk/doc-label";
import { 그때상태, 기준시각, type 판본 } from "@/lib/risk/diff";
import {
  위험도표시,
  이행상태읽기,
  최신만,
  행정렬,
  회사표시,
  type 결재상태,
  type 평가행,
  type 행팩트,
} from "@/lib/risk/rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

/**
 * 바뀐 위험성평가서를 파일로 내려받는다.
 *
 * **왜 필요한가:** 재평가가 필요하다는 것은 평가서가 바뀌었다는 뜻이다. 그런데 지금까지
 * 화면은 바뀐 결과를 보여 주기만 하고 밖으로 꺼낼 방법이 없었다. 결재 상신은 결국 문서를
 * 올리는 일이라, 화면 안에만 있는 표는 그 일을 끝내 주지 못한다.
 *
 * **두 가지 모양으로 낸다.**
 *
 * - `format=xlsx` — 실제 「(N월) 위험성평가 및 점검 회의록」 서식. 결재란·관리기간·주간
 *   점검란까지 그린다. 현직자가 그대로 결재에 올릴 수 있는 것은 이쪽뿐이다. 서식은
 *   `lib/risk/assessment-sheet.ts` 가 만든다.
 * - `format` 없음 또는 `format=csv` — 열 이름을 사람 말로 고친 표 하나. 값만 빠르게
 *   훑거나 다른 도구에 넣을 때 쓴다. 서식이 없어 결재 문서로는 쓸 수 없다.
 *
 * **CSV 가 기본으로 남아 있다.** 서식 쪽이 낫지만 기본값을 바꾸면 `format` 을 붙이지
 * 않은 기존 호출이 말없이 다른 파일을 받는다. 부르는 쪽이 무엇을 원하는지 적게 한다.
 *
 * CSV 에 BOM 을 붙이는 이유는 엑셀이 UTF-8 CSV 를 BOM 없이 열면 한글이 깨지기 때문이다.
 */

/** CSV 한 칸. 쉼표·따옴표·줄바꿈이 들어가면 따옴표로 감싸고 안의 따옴표는 겹친다. */
function 칸(값: unknown): string {
  const s = 값 === null || 값 === undefined ? "" : String(값);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 열 이름은 내려받은 파일을 여는 사람이 읽는다. 저장소 필드명이 아니라 사람 말로 적는다. */
const 머리 = [
  "항목 번호",
  "공종분류",
  "단위작업",
  "위험요인",
  "사고분류",
  "개선 전",
  "개선 후",
  "대책",
  "담당사",
  "이행확인",
  "평가서 표시",
  "실제 실행",
  "판정 근거",
] as const;

/**
 * 서식 머리칸을 채운다.
 *
 * **행에서 뽑을 수 있는 것은 행에서 뽑는다.** 관리기간과 공종은 이미 행마다 적혀 있어
 * 시드에 또 적으면 두 벌이 되고, 두 벌은 언젠가 어긋난다.
 *
 * **작성일자는 팩트의 시각이다.** 이 문서의 행이 처음 기록된 때가 곧 평가서를 쓴 날이다.
 * 따로 저장된 값이 없으므로 지어내지 않고 기록에서 읽는다.
 *
 * 나머지(평가기법·근거·업종·장비·자재·결재자)는 행에도 없고 계산할 수도 없어
 * `documentApprovalState` 팩트의 `서식` 칸에 저장한다. 없으면 **비운다.**
 */
function 머리만들기(
  행들: 평가행[],
  이력: Array<{ observedAt: string }>,
  결재: 결재상태 | null,
): 서식머리 {
  const 시각들 = 이력.map((f) => f.observedAt).filter(Boolean).sort();
  const 관리기간 = 행들.map((r) => r.관리기간).find((v) => v && v.trim() !== "");
  // 같은 공종이 여러 행에 나온다. 나온 순서를 지키며 겹치는 것만 뺀다.
  const 공종 = [...new Set(행들.map((r) => r.공종분류).filter((v): v is string => !!v && v.trim() !== ""))];

  return {
    ...(결재?.서식 ?? {}),
    작성일자: 시각들[0]?.slice(0, 10),
    관리기간,
    공종,
  };
}

/** 이 문서의 결재 상태. 같은 key 가 여러 번 기록되므로 **가장 나중 것**을 쓴다. */
async function 결재읽기(siteId: string, docId: string): Promise<결재상태 | null> {
  const facts = await boardStore().listFacts(siteId, "documentApprovalState");
  const 이문서 = 최신만(facts.filter((f) => f.key === docId));
  const 값 = 이문서[0]?.value;
  return 값 && typeof 값 === "object" ? (값 as 결재상태) : null;
}

function fail(message: string, status: number, code?: string) {
  return Response.json(code ? { error: message, code } : { error: message }, {
    status,
    headers: HEADERS,
  });
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  const siteId = params.get("siteId")?.trim();
  if (!siteId) {
    return fail("평가서를 내려받지 못했습니다. 현장이 지정되지 않았습니다. 화면을 새로 고쳐 주세요.", 400, "siteId_required");
  }

  const docId = params.get("docId")?.trim();
  if (!docId) {
    return fail("평가서를 내려받지 못했습니다. 문서가 지정되지 않았습니다. 화면을 새로 고쳐 주세요.", 400, "docId_required");
  }

  /**
   * 어느 판본을 낼 것인가.
   *
   * `원본` 은 재평가 전, 즉 문서의 가장 오래된 팩트 시점의 상태다. 둘을 나란히 받아야
   * 무엇이 바뀌었는지 눈으로 견줄 수 있다.
   */
  // 이름을 ASCII 로 받는다. 한글 파라미터도 브라우저는 알아서 인코딩하지만,
  // HTTP 경계를 넘는 이름은 도구·시험·로그마다 인코딩이 갈려 사람이 손으로 부를 때
  // 조용히 어긋난다. 실제로 헤더 쪽에서 한 번 500 을 냈다.
  const 판본요청 = params.get("version")?.trim() === "before" ? "원본" : "최신";

  // 모르는 값을 받으면 CSV 로 떨어진다. 오탈자 하나에 400 을 내는 것보다 낫다.
  const 서식요청 = params.get("format")?.trim().toLowerCase() === "xlsx";

  try {
    const all = await boardStore().listFacts(siteId, "riskAssessmentRow");
    const 이력 = all.filter((f) => f.key.startsWith(`${docId}#`));

    let 행들;
    if (판본요청 === "원본") {
      const 기준 = 기준시각(이력 as 판본[]);
      // 기준시각이 없다는 것은 팩트가 하나도 없다는 뜻이라 아래 0행 처리로 떨어진다.
      const 그때 = 기준 ? 그때상태(이력 as 판본[], 기준) : new Map();
      행들 = [...그때.values()].sort((a, b) =>
        a.행id.localeCompare(b.행id, "en", { numeric: true }),
      );
    } else {
      행들 = 행정렬(최신만(이력) as 행팩트[]);
    }

    if (행들.length === 0) {
      // 빈 파일을 내려보내지 않는다. 받는 사람이 "행이 없는 평가서" 로 읽는다.
      // 조회는 성공했고 건수가 0 이다. "읽지 못했습니다" 와 합치지 않는다.
      return fail(`${문서표시(docId)} 에 평가 항목이 없습니다. 내려받을 내용이 없습니다.`, 404, "no_rows");
    }

    /*
     * 파일 이름으로 두 판본을 가른다. 같은 이름이면 내려받은 폴더에서 뒤섞인다.
     *
     * **이름을 ASCII 로 짓는다.** `원본`·`최신` 을 그대로 넣었다가 500 이 났다 —
     * `Content-Disposition` 은 HTTP 헤더라 바이트 하나가 한 글자이고, 한글이 들어가면
     * `Cannot convert argument to a ByteString` 로 응답 자체가 못 나간다.
     * (바로 이 자리에 "파일명에 한글이 없으므로" 라고 적어 두고 한글을 넣었다.)
     */
    const 판본표기 = 판본요청 === "원본" ? "before" : "current";
    const 이름앞 = `${docId}-${판본표기}-${new Date().toISOString().slice(0, 10)}`;

    if (서식요청) {
      // 결재 상태를 못 읽어도 서식은 낸다. 머리칸 몇 개가 비는 것뿐이고, 표는 온전하다.
      const 결재 = await 결재읽기(siteId, docId);
      const 바이트 = await 평가표바이트(행들, 머리만들기(행들, 이력, 결재));
      return new Response(new Uint8Array(바이트), {
        headers: {
          ...HEADERS,
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${이름앞}.xlsx"`,
        },
      });
    }

    const 줄 = [
      머리.join(","),
      ...행들.map((r) =>
        [
          r.행id,
          r.공종분류,
          r.단위작업,
          r.위험요인,
          r.사고분류,
          위험도표시(r.개선전),
          위험도표시(r.개선후),
          (r.대책 ?? []).join(" / "),
          회사표시(r.담당사),
          // 세 상태를 그대로 적는다. 참/거짓 둘로 누르면 위조 판정이 "확인" 이 된다.
          이행상태읽기(r),
          r.표시값 === undefined ? "" : r.표시값 ? "이행함" : "미이행",
          r.실제실행 === undefined ? "" : r.실제실행 ? "실행함" : "미실행",
          r.근거,
        ]
          .map(칸)
          .join(","),
      ),
    ].join("\r\n");

    return new Response(`﻿${줄}`, {
      headers: {
        ...HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        // 파일명에 한글이 없으므로 filename 하나로 충분하다.
        "Content-Disposition": `attachment; filename="${이름앞}.csv"`,
      },
    });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}

/**
 * 아직 저장되지 않은 판본을 같은 서식으로 낸다.
 *
 * **왜 GET 으로 안 되는가.** 「변경 후」는 제안이 얹힌 상태이고 그 상태는 아직 팩트가
 * 아니다. 서버에는 그 행이 없으므로 부르는 쪽이 행을 실어 보내는 수밖에 없다.
 *
 * **왜 화면에서 만들지 않는가.** 예전에는 화면이 CSV 를 직접 만들었다. 그래서 「변경 전」은
 * 결재에 올릴 수 있는 서식으로 나오는데 「변경 후」는 열 이름만 붙은 표로 나왔다 — 견주라고
 * 나란히 놓은 두 파일이 서로 다른 물건이었다. 서식을 그리는 코드는 한 벌이어야 한다.
 *
 * **머리칸은 저장된 것에서 읽는다.** 평가기법·근거·결재자는 제안과 무관하므로 부르는 쪽
 * 말을 믿지 않는다. 여기서 바뀌는 것은 표의 행뿐이다.
 *
 * 쓰기가 아니다. 받은 행은 파일을 그리는 데만 쓰고 어디에도 저장하지 않는다.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("평가서를 내려받지 못했습니다. 요청을 읽지 못했습니다.", 400, "bad_body");
  }

  const { siteId, docId, rows, 판본 } = (body ?? {}) as {
    siteId?: string;
    docId?: string;
    rows?: unknown;
    판본?: string;
  };

  if (!siteId?.trim()) {
    return fail("평가서를 내려받지 못했습니다. 현장이 지정되지 않았습니다. 화면을 새로 고쳐 주세요.", 400, "siteId_required");
  }
  if (!docId?.trim()) {
    return fail("평가서를 내려받지 못했습니다. 문서가 지정되지 않았습니다. 화면을 새로 고쳐 주세요.", 400, "docId_required");
  }
  if (!Array.isArray(rows)) {
    return fail("평가서를 내려받지 못했습니다. 평가 항목을 받지 못했습니다.", 400, "rows_required");
  }

  // 행id 가 없는 것은 표에 놓을 자리가 없다. 조용히 빈 줄로 그리지 않고 걸러 낸다.
  const 행들 = (rows as 평가행[]).filter(
    (row) => row && typeof row === "object" && typeof row.행id === "string",
  );
  if (행들.length === 0) {
    return fail(`${문서표시(docId)} 에 평가 항목이 없습니다. 내려받을 내용이 없습니다.`, 400, "no_rows");
  }
  // 한 문서가 이만큼 커질 일은 없다. 여기 걸리면 부르는 쪽이 잘못 부른 것이다.
  if (행들.length > 1000) {
    return fail("평가서를 내려받지 못했습니다. 평가 항목이 너무 많습니다.", 413, "too_many_rows");
  }

  행들.sort((a, b) => a.행id.localeCompare(b.행id, "en", { numeric: true }));

  try {
    // 작성일자는 저장된 팩트의 시각에서 읽는다(`머리만들기`). 제안에는 그 값이 없다.
    const all = await boardStore().listFacts(siteId, "riskAssessmentRow");
    const 이력 = all.filter((f) => f.key.startsWith(`${docId}#`));
    const 결재 = await 결재읽기(siteId, docId);

    const 바이트 = await 평가표바이트(행들, 머리만들기(행들, 이력, 결재));
    // 이름이 판본을 가른다. 같은 이름이면 내려받은 폴더에서 어느 것이 어느 것인지 모른다.
    const 판본표기 = 판본 === "제안" ? "proposed" : "current";
    const 이름앞 = `${docId}-${판본표기}-${new Date().toISOString().slice(0, 10)}`;

    return new Response(new Uint8Array(바이트), {
      headers: {
        ...HEADERS,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${이름앞}.xlsx"`,
      },
    });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
