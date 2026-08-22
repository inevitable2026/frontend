import assert from "node:assert/strict";
import test from "node:test";

import { citationSources, parseEvent } from "../tmp/test-dist/components/chat/parse.js";

/**
 * 화면 쪽 인용 그물. 라우트가 근거를 갈라 담아도 화면이 검색 후보를 인용으로 올려 버리면
 * 규약이 무너진다. 여기서 보는 것은 두 가지다 — 무엇이 인용으로 승격되는가, 그리고
 * 승격된 것의 href 가 안전한가.
 */

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const RISK_ID = "33333333-3333-4333-8333-333333333333";

function tool(overrides) {
  return { id: "call-1", name: "read_company_document", status: "completed", input: {}, output: {}, sources: [], ...overrides };
}

function companyResult(seq = 3) {
  return {
    documentId: DOC_ID,
    title: "고촌 물류센터 하도급계약서",
    kind: "하도급계약서",
    siteName: "김포 고촌 물류센터",
    pages: [2, 3],
    seq,
    text: `제12조(${seq}) 안전관리비는 계약금액과 별도로 계상한다.`,
    source: "합성",
    url: `/api/context/documents/${DOC_ID}`,
    citable: true,
  };
}

test("검색 도구는 결과가 인용처럼 생겼어도 인용으로 승격되지 않는다", () => {
  const searches = [
    tool({ name: "search_company_context", output: { candidates: [{ ref: `${DOC_ID}#3`, title: "하도급계약서", source: "합성", citable: false }] } }),
    // 후보에 url·title 이 실려 오더라도 도구 이름만으로 걸러야 한다.
    tool({ name: "search_assessments", output: { result: { title: "슬래브 해체 위험성평가", url: `/api/risk/${RISK_ID}`, source: "합성" } } }),
    tool({ name: "search_official_law", output: { candidates: [{ title: "산업안전보건기준에 관한 규칙", canonicalUrl: "https://www.law.go.kr/x" }] }, sources: [{ label: "국가법령정보센터", url: "https://www.law.go.kr/x" }] }),
  ];

  assert.deepEqual(citationSources(searches), []);
});

test("읽기가 실패한 도구는 인용으로 승격되지 않는다", () => {
  const failed = tool({ status: "error", output: { result: companyResult() } });
  const running = tool({ status: "running", output: { result: companyResult() } });

  assert.deepEqual(citationSources([failed, running]), []);
});

test("사내 문서 읽기는 현장명·종류와 합성 등급을 달고 인용이 된다", () => {
  const [citation] = citationSources([tool({ output: { result: companyResult() } })]);

  // 계열이 빠지면 각주 UI 가 이 합성 문서에 "국가법령정보센터 원문" 을 달아 준다.
  assert.equal(citation.kind, "사내문서");
  assert.equal(citation.title, "고촌 물류센터 하도급계약서");
  assert.equal(citation.url, `/api/context/documents/${DOC_ID}`);
  assert.equal(citation.authority, "김포 고촌 물류센터 · 하도급계약서");
  // 문서 16건이 전부 합성이라 이 자리가 "이거 진짜 데이터입니까" 에 답하는 유일한 칸이다.
  assert.equal(citation.version, "합성");
  assert.match(citation.excerpt, /안전관리비는 계약금액과 별도로 계상/);
});

test("위험성평가 읽기는 고정 출처명과 평가 링크로 인용이 된다", () => {
  const result = { assessmentId: RISK_ID, title: "슬래브 해체 위험성평가", seq: 0, text: "1행 · 공종 철거·해체", source: "합성", url: `/api/risk/${RISK_ID}`, citable: true };

  const [citation] = citationSources([tool({ name: "read_assessment", output: { result } })]);

  assert.equal(citation.kind, "위험성평가");
  assert.equal(citation.url, `/api/risk/${RISK_ID}`);
  // 색인에는 남이 만든 평가도 섞여 있어 소유자를 단정하면 안 된다.
  assert.equal(citation.authority, "위험성평가 기록 · 현장 소속 미확인");
  assert.equal(citation.version, "합성");
});

test("한 문서의 서로 다른 청크는 각각 남는다", () => {
  const citations = citationSources([
    tool({ id: "call-1", output: { result: companyResult(3) } }),
    tool({ id: "call-2", output: { result: companyResult(7) } }),
    // 같은 청크를 두 번 읽은 것은 하나로 접는다.
    tool({ id: "call-3", output: { result: companyResult(3) } }),
  ]);

  assert.equal(citations.length, 2);
  assert.match(citations[0].excerpt, /제12조\(3\)/);
  assert.match(citations[1].excerpt, /제12조\(7\)/);
});

test("href 로 걸 수 없는 주소는 인용에서 빠진다", () => {
  const unsafe = [
    { ...companyResult(), url: "javascript:alert(1)" },
    { ...companyResult(), url: "//evil.example.com/steal" },
    { ...companyResult(), url: "/\\evil.example.com/steal" },
    { ...companyResult(), url: "data:text/html,<script>0</script>" },
  ];

  for (const result of unsafe) {
    assert.deepEqual(citationSources([tool({ output: { result } })]), [], result.url);
  }
});

test("법령 인용은 여전히 외부 원문 주소만 받는다", () => {
  const relative = tool({ name: "read_official_law", output: { result: { title: "산업안전보건기준에 관한 규칙", canonicalUrl: "/법령/산업안전보건기준에관한규칙", excerpt: "…" } } });
  const external = tool({ name: "read_official_law", output: { result: { title: "산업안전보건기준에 관한 규칙", canonicalUrl: "https://www.law.go.kr/x", authority: "고용노동부", version: "2026-01-01 시행", excerpt: "작업계획서를 작성하여야 한다" } } });

  assert.deepEqual(citationSources([relative]), []);
  const [citation] = citationSources([external]);
  assert.equal(citation.kind, "법령");
  assert.equal(citation.url, "https://www.law.go.kr/x");
  assert.equal(citation.authority, "고용노동부");
});

test("라우트가 주는 이벤트 모양 그대로 읽어 낸다", () => {
  const event = {
    type: "tool",
    name: "read_company_document",
    status: "completed",
    input: { ref: `${DOC_ID}#3` },
    output: { result: companyResult() },
    sources: [],
  };

  const { tool: parsed } = parseEvent(event, 0);

  assert.equal(parsed.name, "read_company_document");
  assert.equal(parsed.status, "completed");
  assert.equal(citationSources([parsed])[0].url, `/api/context/documents/${DOC_ID}`);
});

test("도구 카드의 출처 줄은 내부 경로를 남기고 스킴 주소를 버린다", () => {
  const { tool: parsed } = parseEvent({
    type: "tool",
    name: "read_assessment",
    status: "completed",
    sources: [
      { title: "위험성평가 원본", url: `/api/risk/${RISK_ID}` },
      { title: "가짜", url: "javascript:alert(1)" },
      "//evil.example.com",
      "https://www.law.go.kr/x",
    ],
  }, 0);

  assert.deepEqual(parsed.sources, [
    { label: "위험성평가 원본", url: `/api/risk/${RISK_ID}` },
    { label: "출처 4", url: "https://www.law.go.kr/x" },
  ]);
});
