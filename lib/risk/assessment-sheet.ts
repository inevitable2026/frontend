import ExcelJS from "exceljs";

// 시험이 이 모듈을 tsc 로 뽑아 node 에서 그대로 부른다. `@/` 별칭은 emit 에 그대로
// 남아 node 가 못 찾으므로, 시험이 도는 lib 모듈들과 같이 상대 경로로 적는다
// (`lib/console-url.ts:1` · `lib/context/ingest-control.ts:1` 과 같은 꼴).
import { 사람표시, 이행상태읽기, 회사표시, type 문서서식, type 평가행 } from "./rows.ts";

/**
 * 보드 팩트로 **실제 위험성평가표 서식**의 엑셀을 만든다.
 *
 * **왜 CSV 가 아닌가:** 예전에는 열 이름을 사람 말로 고친 CSV 를 냈다. 엑셀에서 열리기는
 * 하지만 받는 사람이 보는 것은 표 하나뿐이고, 결재란도 관리기간도 주간 점검란도 없다.
 * 현직자가 결재에 올리는 문서는 「(N월) 위험성평가 및 점검 회의록」 서식이고, 그 서식이
 * 아니면 **문서를 다시 만들어야 한다.** 내려받기가 일을 끝내 주지 못하면 없는 것과 같다.
 *
 * **본보기:** `gb-hackathon/backend/app/report/excel.py` 가 같은 서식을 openpyxl 로 만든다.
 * 열 너비·병합 범위·색·글꼴을 그쪽에서 그대로 옮겼다. 저쪽이 바뀌면 여기도 바뀌어야 한다.
 *
 * **이 파일은 순수하다.** fetch 도 DB 접근도 하지 않는다. 행 목록과 머리 정보를 받아
 * 통합문서 하나를 돌려줄 뿐이다. 그래야 시험이 파일을 실제로 만들어 열어 볼 수 있다.
 */

/* ------------------------------------------------------------------ *
 * 서식 상수 — backend/app/report/excel.py 와 같은 값이어야 한다
 * ------------------------------------------------------------------ */

const 테두리색 = "FF7F7F7F";
const 글꼴 = "맑은 고딕";

const 색 = {
  남색: "FF1F3864", // 그룹 머리
  회색: "FFE8ECF3", // 항목 머리
  분홍: "FFFDE9E9", // 개선 전 위험성
  민트: "FFE7F3EC", // 개선 후 위험성
  라일락: "FFEFEAF7", // 이행확인
} as const;

/** 위험도 등급별 바탕색. */
const 등급색 = { 높음: "FFF8CBCB", 중간: "FFFDEBC8", 낮음: "FFD9EAD3" } as const;

/**
 * 매트릭스별 (높음 하한, 중간 하한). `backend/app/schema.py:26` 의 `MATRIX_SPEC` 과 같다.
 *
 * **여기 없는 매트릭스는 등급을 매기지 않는다.** 같은 위험도 12 가 4x3 에서는 높음이고
 * 5x4 에서는 보통이다. 모르는 기준으로 칠한 색은 안전 문서에서 가장 하면 안 되는 거짓말이다.
 */
const 매트릭스기준: Record<string, [number, number]> = {
  "4x3": [9, 4],
  "5x4": [15, 6],
  "3x3": [6, 3],
};

/** 열 (머리글, 너비). 15열 A~O. */
const 열정의: Array<[string, number]> = [
  ["①공종분류", 14],
  ["②단위작업", 16],
  ["③사고분류", 10],
  ["④위험요인", 52],
  ["빈도", 6],
  ["강도", 6],
  ["위험도", 7],
  ["⑥위험방지대책", 52],
  ["빈도", 6],
  ["강도", 6],
  ["위험도", 7],
  ["⑧법적 근거", 26],
  ["⑨개선조치\n담당자", 12],
  ["근로자대표", 11],
  ["공사담당자", 11],
];
const 열수 = 열정의.length;

/* ------------------------------------------------------------------ *
 * 입력
 * ------------------------------------------------------------------ */

/**
 * 서식 머리칸에 찍을 값. **전부 선택이다.**
 *
 * 부르는 쪽이 아는 것만 넘긴다. 모르는 칸은 서식만 그리고 비워 둔다 — 서식을 채우려고
 * 없는 값을 지어내면 결재에 올라간 문서가 거짓을 말하게 된다.
 */
export type 서식머리 = 문서서식 & {
  /** 표 제목. 없으면 `작성일자` 의 월로 「(08월) 위험성평가 및 점검 회의록」을 만든다. */
  제목?: string;
  /** `YYYY-MM-DD`. 제목의 월과 `작성일자` 칸에 쓴다. */
  작성일자?: string;
  관리기간?: string;
  공종?: string[];
  /** 꼬리줄의 출력 날짜. 시험이 값을 고정할 수 있도록 받는다. 없으면 오늘. */
  출력일?: string;
};

/* ------------------------------------------------------------------ *
 * 셀 도구
 * ------------------------------------------------------------------ */

type 칸모양 = {
  바탕?: string;
  굵게?: boolean;
  크기?: number;
  글자색?: string;
  왼쪽정렬?: boolean;
};

const 상자테두리 = (() => {
  const 선 = { style: "thin" as const, color: { argb: 테두리색 } };
  return { left: 선, right: 선, top: 선, bottom: 선 };
})();

function 적기(
  ws: ExcelJS.Worksheet,
  행: number,
  열: number,
  값: string | number | null,
  모양: 칸모양 = {},
): ExcelJS.Cell {
  const cell = ws.getCell(행, 열);
  // 빈 문자열을 그대로 넣으면 엑셀에 빈 문자열 칸이 생긴다. 비어 있는 칸은 비워 둔다.
  if (값 !== null && 값 !== "") cell.value = 값;
  cell.border = 상자테두리;
  cell.alignment = {
    horizontal: 모양.왼쪽정렬 ? "left" : "center",
    vertical: "middle",
    wrapText: true,
  };
  cell.font = {
    name: 글꼴,
    size: 모양.크기 ?? 9,
    bold: 모양.굵게 ?? false,
    color: { argb: 모양.글자색 ?? "FF000000" },
  };
  if (모양.바탕) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: 모양.바탕 } };
  return cell;
}

/**
 * 칸을 합치고 테두리를 두른다.
 *
 * **왜 가장자리에만 테두리를 두는가:** openpyxl 은 저장할 때 병합 범위의 테두리를 바깥
 * 윤곽으로 정리한다(`MergedCellRange.format()`). 본보기 파일이 바로 그 결과라, 안쪽
 * 칸까지 네 변을 다 두르면 openpyxl 로 다시 열어 견줄 때 서식이 어긋난 것처럼 보인다.
 * 엑셀 화면에서는 어차피 같아 보이지만, 대조가 되는 쪽을 택했다.
 *
 * `mergeCells` 는 합칠 때 나머지 칸의 서식을 좌상단 것으로 덮어써서 쓸 수 없다.
 */
function 합치기(ws: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number): void {
  if (r1 !== r2 || c1 !== c2) ws.mergeCellsWithoutStyle(r1, c1, r2, c2);
  const 선 = { style: "thin" as const, color: { argb: 테두리색 } };
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) {
      if (r === r1 && c === c1) continue; // 좌상단은 적기() 가 네 변을 다 두른다
      ws.getCell(r, c).border = {
        left: c === c1 ? 선 : undefined,
        right: c === c2 ? 선 : undefined,
        top: r === r1 ? 선 : undefined,
        bottom: r === r2 ? 선 : undefined,
      };
    }
  }
}

/* ------------------------------------------------------------------ *
 * 값 다듬기
 * ------------------------------------------------------------------ */

/** `빈도·강도법 4x3` → `4x3`. 못 읽으면 null — 그러면 등급을 매기지 않는다. */
export function 매트릭스읽기(평가기법: string | undefined): string | null {
  if (!평가기법) return null;
  const m = /(\d+)\s*[x×X]\s*(\d+)/.exec(평가기법);
  if (!m) return null;
  const 이름 = `${m[1]}x${m[2]}`;
  return 이름 in 매트릭스기준 ? 이름 : null;
}

/** 위험도 등급. 매트릭스를 모르면 null 이고, 그러면 색을 칠하지 않는다. */
export function 등급읽기(위험도: number | undefined, 매트릭스: string | null): keyof typeof 등급색 | null {
  if (위험도 === undefined || 매트릭스 === null) return null;
  const 기준 = 매트릭스기준[매트릭스];
  if (!기준) return null;
  if (위험도 >= 기준[0]) return "높음";
  if (위험도 >= 기준[1]) return "중간";
  return "낮음";
}

/**
 * ⑩이행확인 칸에 찍을 글자.
 *
 * **상태가 셋이다.** `이행상태읽기()` 를 그대로 쓴다 — 참/거짓 둘로 누르면
 * `!"불일치"` 가 false 라 **위조로 판정된 행이 「확인」으로 넘어간다.** 그 행을 찾아내는
 * 것이 이 제품이 존재하는 이유인데, 내려받은 문서가 그걸 완료로 적으면 화면에서 잡은
 * 것을 문서가 다시 놓치는 셈이다.
 *
 * 빈칸은 **글자 없이** 비운다. 「빈칸」이라고 적으면 그것도 기재가 된다.
 */
export function 이행확인표기(행: 평가행): string {
  const 상태 = 이행상태읽기(행);
  if (상태 === "확인") return "확인";
  if (상태 === "불일치") return "불일치";
  return "";
}

/** `● ` 로 시작하는 줄바꿈 목록. 비면 빈 문자열. */
function 목록(값: string[] | undefined): string {
  return (값 ?? []).filter((v) => v.trim() !== "").map((v) => `● ${v}`).join("\n");
}

/** 줄바꿈 목록(글머리 없음). ⑧법적 근거는 본보기가 글머리를 붙이지 않는다. */
function 줄목록(값: string[] | undefined): string {
  return (값 ?? []).filter((v) => v.trim() !== "").join("\n");
}

/** `2026-08-14T…` · `2026-08-14` → `2026.08.14`. 못 읽으면 빈 문자열. */
function 날짜점(값: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(값 ?? "");
  return m ? `${m[1]}.${m[2]}.${m[3]}` : "";
}

/** `2026-08-14` → `08`. 못 읽으면 null. */
function 월(값: string | undefined): string | null {
  const m = /^\d{4}-(\d{2})-\d{2}/.exec(값 ?? "");
  return m ? m[1] : null;
}

/** `2026. 08. 23` — 꼬리줄의 출력 날짜 표기. */
function 출력날짜(값: string | undefined): string {
  const d = 값 ? new Date(값) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}. ${p(d.getMonth() + 1)}. ${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ *
 * 서식 그리기
 * ------------------------------------------------------------------ */

/** 1~5행: 업체·제목·결재란, 작성일자 줄, 공종 줄. 다음 시작 행을 돌려준다. */
function 머리블록(ws: ExcelJS.Worksheet, 머리: 서식머리, 행: number): number {
  const 월표기 = 월(머리.작성일자);
  const 제목 = 머리.제목 ?? `${월표기 ? `(${월표기}월) ` : ""}위험성평가 및 점검 회의록`;

  합치기(ws, 행, 1, 행 + 2, 3);
  적기(ws, 행, 1, 머리.업종 ?? "", { 굵게: true, 크기: 12 });

  합치기(ws, 행, 4, 행 + 2, 9);
  적기(ws, 행, 4, 제목, { 굵게: true, 크기: 15 });

  합치기(ws, 행, 10, 행, 열수);
  적기(ws, 행, 10, "①위험성 결정, 감소대책 수립 및 실행계획 확인", { 바탕: 색.회색, 굵게: true });

  const 결재 = 머리.결재자 ?? {};
  const 결재칸: Array<[string, string | undefined]> = [
    ["검토자\n(위험성평가담당자)", 결재.검토자],
    ["근로자대표\n(작업반장 등)", 결재.근로자대표],
    ["승인자\n(현장소장)", 결재.승인자],
  ];
  결재칸.forEach(([이름표, 사람], i) => {
    const c = 10 + i * 2;
    합치기(ws, 행 + 1, c, 행 + 1, c + 1);
    적기(ws, 행 + 1, c, 이름표, { 바탕: 색.회색, 굵게: true, 크기: 8 });
    합치기(ws, 행 + 2, c, 행 + 2, c + 1);
    // 이름을 모르는 식별자는 빈칸이다. 서명란에 총칭을 적으면 없는 서명을 지어낸다.
    적기(ws, 행 + 2, c, 사람표시(사람));
  });

  행 += 3;

  const 정보: Array<[string, string]> = [
    ["작성일자", 날짜점(머리.작성일자)],
    ["관리기간", 머리.관리기간 ?? ""],
    ["평가기법", 머리.평가기법 ?? ""],
    ["근거", 머리.근거 ?? ""],
  ];
  let 열번호 = 1;
  for (const [이름표, 값] of 정보) {
    적기(ws, 행, 열번호, 이름표, { 바탕: 색.회색, 굵게: true });
    const 폭 = 열번호 <= 5 ? 2 : 3;
    합치기(ws, 행, 열번호 + 1, 행, 열번호 + 폭);
    적기(ws, 행, 열번호 + 1, 값);
    열번호 += 폭 + 1;
  }
  행 += 1;

  적기(ws, 행, 1, "공종", { 바탕: 색.회색, 굵게: true });
  합치기(ws, 행, 2, 행, 7);
  적기(ws, 행, 2, (머리.공종 ?? []).join(", "), { 왼쪽정렬: true });
  적기(ws, 행, 8, "장비·자재", { 바탕: 색.회색, 굵게: true });
  합치기(ws, 행, 9, 행, 열수);
  적기(ws, 행, 9, [...(머리.장비 ?? []), ...(머리.자재 ?? [])].join(", "), { 왼쪽정렬: true });
  ws.getRow(행).height = 28;

  // 한 줄 띄우고 표가 시작한다.
  return 행 + 2;
}

/** 7~8행: 2단 머리. */
function 표머리(ws: ExcelJS.Worksheet, 행: number, 매트릭스: string | null): number {
  // 매트릭스를 모르면 괄호를 붙이지 않는다. `(null)` 같은 글자를 서식에 남기지 않는다.
  const 괄호 = 매트릭스 ? ` (${매트릭스})` : "";
  const 그룹: Array<[string, number, number, string, string]> = [
    ["분석 기반 정보", 1, 4, 색.남색, "FFFFFFFF"],
    [`⑤개선 전 위험성 산정${괄호}`, 5, 7, 색.분홍, "FF000000"],
    ["", 8, 8, 색.남색, "FFFFFFFF"],
    [`⑦개선 후 위험성${괄호}`, 9, 11, 색.민트, "FF000000"],
    ["", 12, 13, 색.남색, "FFFFFFFF"],
    ["⑩이행확인 (조치한 경우)", 14, 15, 색.라일락, "FF000000"],
  ];
  for (const [이름표, c1, c2, 바탕, 글자색] of 그룹) {
    합치기(ws, 행, c1, 행, c2);
    적기(ws, 행, c1, 이름표, { 바탕, 굵게: true, 글자색 });
  }

  열정의.forEach(([이름표], i) => {
    const c = i + 1;
    let 바탕: string = 색.회색;
    if (c >= 5 && c <= 7) 바탕 = 색.분홍;
    else if (c >= 9 && c <= 11) 바탕 = 색.민트;
    else if (c >= 14) 바탕 = 색.라일락;
    적기(ws, 행 + 1, c, 이름표, { 바탕, 굵게: true, 크기: 8 });
  });

  ws.getRow(행).height = 20;
  ws.getRow(행 + 1).height = 30;
  return 행 + 2;
}

/** 9행부터: 평가 항목. */
function 항목행(ws: ExcelJS.Worksheet, 행들: 평가행[], 행: number, 매트릭스: string | null): number {
  for (const r of 행들) {
    적기(ws, 행, 1, r.공종분류 ?? "");
    적기(ws, 행, 2, r.단위작업 ?? "");
    적기(ws, 행, 3, r.사고분류 ?? "");
    적기(ws, 행, 4, r.위험요인 ? `● ${r.위험요인}` : "", { 왼쪽정렬: true });

    적기(ws, 행, 5, r.개선전?.빈도 ?? "");
    적기(ws, 행, 6, r.개선전?.강도 ?? "");
    const 전등급 = 등급읽기(r.개선전?.위험도, 매트릭스);
    적기(ws, 행, 7, r.개선전?.위험도 ?? "", {
      굵게: true,
      바탕: 전등급 ? 등급색[전등급] : undefined,
    });

    적기(ws, 행, 8, 목록(r.대책), { 왼쪽정렬: true });

    적기(ws, 행, 9, r.개선후?.빈도 ?? "");
    적기(ws, 행, 10, r.개선후?.강도 ?? "");
    const 후등급 = 등급읽기(r.개선후?.위험도, 매트릭스);
    적기(ws, 행, 11, r.개선후?.위험도 ?? "", {
      굵게: true,
      바탕: 후등급 ? 등급색[후등급] : undefined,
    });

    적기(ws, 행, 12, 줄목록(r.법적근거), { 왼쪽정렬: true, 크기: 8 });
    적기(ws, 행, 13, 회사표시(r.담당사));
    // 세 상태를 그대로 적는다. 여기서 참/거짓으로 누르면 위조 판정이 「확인」이 된다.
    적기(ws, 행, 14, 이행확인표기(r));
    // ⑮공사담당자 — 우리 팩트에 대응하는 값이 없다. 서식만 그리고 비워 둔다.
    적기(ws, 행, 15, "");

    // 대책 줄 수에 맞춰 행 높이 (한 줄 약 14pt).
    const 줄수 = Math.max(
      (r.대책 ?? []).length,
      (r.법적근거 ?? []).length,
      Math.floor((r.위험요인 ?? "").length / 30) + 1,
      2,
    );
    ws.getRow(행).height = Math.min(14 * 줄수 + 8, 120);
    행 += 1;
  }
  return 행;
}

/** 주간 위험성평가 결과 논의·공유 및 이행현황 점검. */
function 주간블록(ws: ExcelJS.Worksheet, 행: number): number {
  행 += 1;
  합치기(ws, 행, 1, 행, 열수);
  적기(ws, 행, 1, "주간 위험성평가 결과 논의·공유 및 이행현황 점검", {
    바탕: 색.남색,
    굵게: true,
    크기: 11,
    글자색: "FFFFFFFF",
  });
  ws.getRow(행).height = 22;
  행 += 1;

  const 머리들: Array<[string, number, number]> = [
    ["주차", 1, 1],
    ["주간 위험성평가 결과 논의 및 공유 / 이행현황 점검", 2, 7],
    ["예정일자", 8, 8],
    ["실시일자", 9, 9],
    ["현장소장", 10, 10],
    ["교육자", 11, 11],
    ["공사부장", 12, 12],
    ["위험성평가팀", 13, 13],
    ["《 TBM 순서 》", 14, 15],
  ];
  for (const [이름표, c1, c2] of 머리들) {
    합치기(ws, 행, c1, 행, c2);
    적기(ws, 행, c1, 이름표, { 바탕: 색.회색, 굵게: true, 크기: 8 });
  }
  행 += 1;

  const tbm = ["01. 상호 인사", "02. 보호구 확인", "03. 당일 작업 전달", "04. 가설자재 점검", "05. 지적확인"];
  for (let i = 0; i < 5; i += 1) {
    적기(ws, 행, 1, `${i + 1}주차`, { 바탕: 색.회색, 굵게: true, 크기: 8 });
    합치기(ws, 행, 2, 행, 7);
    적기(ws, 행, 2, "", { 왼쪽정렬: true });
    for (let c = 8; c <= 13; c += 1) 적기(ws, 행, c, "");
    합치기(ws, 행, 14, 행, 15);
    적기(ws, 행, 14, tbm[i], { 왼쪽정렬: true, 크기: 8 });
    ws.getRow(행).height = 22;
    행 += 1;
  }
  return 행;
}

/**
 * 꼬리줄.
 *
 * 본보기는 모르는 값에 `-` 를 적지만 여기서는 **그 토막을 통째로 뺀다.** 우리 문서에는
 * 장비·자재가 아예 없는 경우가 흔한데, `장비·설비: -` 는 "확인한 결과 없다" 로 읽힌다.
 * 적지 않은 것과 없다고 적은 것은 다르다.
 */
function 꼬리줄(ws: ExcelJS.Worksheet, 머리: 서식머리, 행: number): number {
  행 += 1;
  합치기(ws, 행, 1, 행, 열수);
  const 토막 = [
    머리.평가기법 ? `위험성평가 기법 ${머리.평가기법}` : null,
    (머리.장비 ?? []).length > 0 ? `장비·설비: ${(머리.장비 ?? []).join(", ")}` : null,
    (머리.자재 ?? []).length > 0 ? `물질·자재: ${(머리.자재 ?? []).join(", ")}` : null,
    `출력 ${출력날짜(머리.출력일)}`,
  ].filter((s): s is string => s !== null);
  const cell = ws.getCell(행, 1);
  cell.value = 토막.join("   |   ");
  cell.border = 상자테두리;
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.font = { name: 글꼴, size: 7, color: { argb: "FF666666" } };
  ws.getRow(행).height = 24;
  return 행;
}

/* ------------------------------------------------------------------ *
 * 바깥에서 부르는 것
 * ------------------------------------------------------------------ */

/**
 * 행 목록과 머리 정보로 통합문서를 만든다.
 *
 * 행이 없어도 서식은 그린다. 0행 처리는 부르는 쪽의 몫이다 — 라우트는 빈 문서를
 * 내려보내지 않고 「평가 항목이 없습니다」로 답한다.
 */
export function 평가표만들기(행들: 평가행[], 머리: 서식머리 = {}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("위험성평가표");

  열정의.forEach(([, 너비], i) => {
    ws.getColumn(i + 1).width = 너비;
  });

  const 매트릭스 = 매트릭스읽기(머리.평가기법);

  let 행 = 머리블록(ws, 머리, 1);
  const 표머리행 = 행;
  행 = 표머리(ws, 행, 매트릭스);
  const 첫자료행 = 행;
  행 = 항목행(ws, 행들, 행, 매트릭스);
  행 = 주간블록(ws, 행);
  const 꼬리행 = 꼬리줄(ws, 머리, 행);

  // 인쇄 설정 — A4 가로 한 장 폭에 맞춘다. 표 머리 두 줄은 쪽마다 되풀이한다.
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 첫자료행 - 1 }];
  ws.pageSetup = {
    orientation: "landscape",
    paperSize: 9, // A4
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printArea: `A1:${열이름(열수)}${꼬리행 + 1}`,
    printTitlesRow: `${표머리행}:${표머리행 + 1}`,
  };
  return wb;
}

/** 1 → `A`, 15 → `O`. */
function 열이름(n: number): string {
  let s = "";
  let v = n;
  while (v > 0) {
    const 나머지 = (v - 1) % 26;
    s = String.fromCharCode(65 + 나머지) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

/** 통합문서를 파일 바이트로. 라우트가 그대로 응답 본문에 싣는다. */
export async function 평가표바이트(행들: 평가행[], 머리: 서식머리 = {}): Promise<Buffer> {
  const buf = await 평가표만들기(행들, 머리).xlsx.writeBuffer();
  return Buffer.from(buf);
}
