import { BOARD_STORE_ERROR_STATUS, boardStore, isBoardStoreError } from "@/lib/board/store";
import { 문서표시 } from "@/lib/risk/doc-label";
import { 그때상태, 기준시각, type 판본 } from "@/lib/risk/diff";
import { 위험도표시, 이행상태읽기, 최신만, 행정렬, 회사표시, type 행팩트 } from "@/lib/risk/rows";

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
 * **왜 CSV 인가:** 이 프런트엔드에는 xlsx 라이브러리가 없다(의존성 8개뿐). SAFEGRID 는
 * 엑셀을 만들지만 그건 저쪽 DB 의 평가서용이고, 여기 문서는 보드 팩트라 저쪽에 없다.
 * 라이브러리를 새로 들이는 대신 CSV 로 낸다 — 엑셀에서 그대로 열린다.
 *
 * BOM 을 붙이는 이유는 엑셀이 UTF-8 CSV 를 BOM 없이 열면 한글이 깨지기 때문이다.
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
  const 판본요청 = params.get("판본")?.trim() === "원본" ? "원본" : "최신";

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

    // 파일 이름으로 두 판본을 가른다. 같은 이름이면 내려받은 폴더에서 뒤섞인다.
    const 파일명 = `${docId}-${판본요청}-${new Date().toISOString().slice(0, 10)}.csv`;

    return new Response(`﻿${줄}`, {
      headers: {
        ...HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        // 파일명에 한글이 없으므로 filename 하나로 충분하다.
        "Content-Disposition": `attachment; filename="${파일명}"`,
      },
    });
  } catch (error) {
    if (isBoardStoreError(error)) return fail(error.message, BOARD_STORE_ERROR_STATUS[error.code]);
    throw error;
  }
}
