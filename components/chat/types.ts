/**
 * `/api/chat` 응답을 화면이 쓰는 모양으로 옮긴 타입. 라우트가 돌려주는 이벤트는
 * 필드 이름이 여러 갈래라서 `parse.ts` 가 한 번 정규화한 뒤 이 모양으로 넘긴다.
 */

export type JsonRecord = Record<string, unknown>;

export type SourceLink = {
  label: string;
  url: string;
};

export type ToolCall = {
  id: string;
  name: string;
  status: "running" | "completed" | "error";
  input?: unknown;
  output?: unknown;
  sources: SourceLink[];
};

/** 도구 이름을 사람이 읽는 말로 바꾼다. 모르는 이름은 호출부가 기본값을 정한다. */
export const TOOL_LABELS: Record<string, string> = {
  search_official_law: "공식 법령 후보 검색",
  read_official_law: "공식 조문 원문 조회",
  search_company_context: "사내 문서 후보 검색",
  read_company_document: "사내 문서 원문 조회",
  search_assessments: "위험성평가 기록 검색",
  read_assessment: "위험성평가 기록 조회",
  read_site_facts: "현장 사실 조회",
};
