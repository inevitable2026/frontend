import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  chatRequest,
  configured,
  createSolar,
  loadChatRoute,
  readAssessment,
  readCompanyDocument,
  readEnvelope,
  readOfficialLaw,
  readSiteFacts,
  resetHarness,
  searchAssessments,
  searchCompanyContext,
  searchOfficialLaw,
  toolTurn,
} from "./helpers/chat-harness.mjs";

/**
 * `docs/company-chatbot-plan.md` 의 인용 안전 규약이 라우트에서 실제로 지켜지는지 본다.
 * 규약은 세 문장이고 이 파일은 그 세 문장을 그대로 그물로 친다.
 *   - 검색이 만든 ref 만, 그것도 같은 요청 안에서만 읽을 수 있다.
 *   - 후보는 근거가 아니다. 읽기에 성공한 것만 근거다.
 *   - 근거 갈래마다 할 수 있는 말이 다르다. 법적 주장은 법령 원문에만 딸린다.
 */

const { POST } = await loadChatRoute();

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_DOC_ID = "22222222-2222-4222-8222-222222222222";
const ASSESSMENT_ID = "33333333-3333-4333-8333-333333333333";

const NO_EVIDENCE = /확인한 근거가 없어 답변을 드릴 수 없습니다/;

function companySearch(documentId = DOC_ID, seq = 3) {
  const ref = `${documentId}#${seq}`;
  return {
    candidates: [{
      ref,
      title: "고촌 물류센터 하도급계약서",
      kind: "하도급계약서",
      siteName: "김포 고촌 물류센터",
      page: 2,
      score: 0.7421,
      snippet: "안전관리비는 계약금액의 별도 항목으로 계상한다",
      source: "합성",
      citable: false,
    }],
    references: new Map([[ref, { documentId, seq }]]),
  };
}

function companyRead(documentId = DOC_ID, seq = 3) {
  return {
    documentId,
    title: "고촌 물류센터 하도급계약서",
    kind: "하도급계약서",
    siteName: "김포 고촌 물류센터",
    pages: [2, 3],
    seq,
    text: "제12조 안전관리비는 계약금액과 별도로 계상하며 목적 외 사용을 금한다.",
    source: "합성",
    url: `/api/context/documents/${documentId}`,
    citable: true,
  };
}

function assessmentSearch(assessmentId = ASSESSMENT_ID, seq = 0) {
  const ref = `${assessmentId}#${seq}`;
  return {
    candidates: [{
      ref,
      assessmentId,
      title: "슬래브 해체 위험성평가",
      seq,
      score: 0.6812,
      snippet: "1행 · 공종 철거·해체 · 위험요인 잔재물 낙하",
      source: "합성",
      citable: false,
    }],
    references: new Map([[ref, { assessmentId, seq }]]),
  };
}

function assessmentRead(assessmentId = ASSESSMENT_ID, seq = 0) {
  return {
    assessmentId,
    title: "슬래브 해체 위험성평가",
    seq,
    text: "1행 · 공종 철거·해체 · 위험요인 잔재물 낙하 · 대책 하부 출입통제",
    source: "합성",
    현장소속: "확인되지 않음",
    url: `/api/risk/${assessmentId}`,
    citable: true,
  };
}

function lawRead() {
  return {
    ref: "eflaw:001",
    kind: "eflaw",
    citable: true,
    title: "산업안전보건기준에 관한 규칙",
    authority: "고용노동부",
    version: "2026-01-01 시행",
    provision: "제38조",
    excerpt: "사업주는 굴착작업을 하는 경우 작업계획서를 작성하여야 한다.",
    canonicalUrl: "https://www.law.go.kr/법령/산업안전보건기준에관한규칙",
    source: {
      title: "산업안전보건기준에 관한 규칙",
      url: "https://www.law.go.kr/법령/산업안전보건기준에관한규칙",
      authority: "고용노동부",
      version: "2026-01-01 시행",
    },
  };
}

function lawSearch() {
  return {
    candidates: [{ ref: "eflaw:001", kind: "eflaw", citable: false, title: "산업안전보건기준에 관한 규칙", authority: "고용노동부", version: "2026-01-01 시행", canonicalUrl: "https://www.law.go.kr/x" }],
    references: new Map([["eflaw:001", { ref: "eflaw:001", kind: "eflaw", citable: false, title: "산업안전보건기준에 관한 규칙", authority: "고용노동부", version: "2026-01-01 시행", canonicalUrl: "https://www.law.go.kr/x", searchQuery: "굴착" }]]),
    searchMode: "body",
  };
}

function install(solar) {
  globalThis.fetch = solar.fetch;
  return solar;
}

beforeEach(() => {
  resetHarness();
  process.env.UPSTAGE_API_KEY = "test-key";
});

test("검색이 만들지 않은 ref 로는 사내 문서를 읽지 못한다", async () => {
  searchCompanyContext.returns(companySearch());
  const solar = install(createSolar({
    turns: [
      toolTurn({ name: "search_company_context", args: { query: "안전관리비" } }),
      toolTurn({ name: "read_company_document", args: { ref: `${OTHER_DOC_ID}#0` } }),
    ],
  }));

  const { tools, answer } = await readEnvelope(await POST(chatRequest("안전관리비 계상 근거를 알려줘")));

  // 지어낸 ref 는 저장소까지 내려가지 않는다. 읽기 함수가 아예 불리지 않아야 격리다.
  assert.equal(readCompanyDocument.calls.length, 0);
  assert.equal(tools[1].name, "read_company_document");
  assert.equal(tools[1].status, "failed");
  assert.match(answer, NO_EVIDENCE);
  assert.equal(solar.synthesis.length, 0);
});

test("이전 요청의 ref 는 다음 요청에서 죽는다", async () => {
  const ref = `${DOC_ID}#3`;
  searchCompanyContext.returns(companySearch());
  readCompanyDocument.returns(companyRead());

  install(createSolar({
    turns: [
      toolTurn({ name: "search_company_context", args: { query: "안전관리비" } }),
      toolTurn({ name: "read_company_document", args: { ref } }),
    ],
  }));
  const first = await readEnvelope(await POST(chatRequest("안전관리비 계상 근거를 알려줘")));
  assert.equal(first.tools[1].status, "completed");
  assert.equal(readCompanyDocument.calls.length, 1);

  // 같은 ref, 검색 없는 새 요청. 참조 사전은 요청과 함께 사라졌어야 한다.
  const second = install(createSolar({ turns: [toolTurn({ name: "read_company_document", args: { ref } })] }));
  const replay = await readEnvelope(await POST(chatRequest("아까 그 문서 다시 보여줘")));

  assert.equal(readCompanyDocument.calls.length, 1);
  assert.equal(replay.tools[0].status, "failed");
  assert.match(replay.answer, NO_EVIDENCE);
  assert.equal(second.synthesis.length, 0);
});

test("검색이 만들지 않은 ref 로는 위험성평가 행을 읽지 못한다", async () => {
  searchAssessments.returns(assessmentSearch());
  install(createSolar({
    turns: [
      toolTurn({ name: "search_assessments", args: { query: "슬래브 해체" } }),
      toolTurn({ name: "read_assessment", args: { ref: `${ASSESSMENT_ID}#41` } }),
    ],
  }));

  const { tools, answer } = await readEnvelope(await POST(chatRequest("슬래브 해체 위험은 뭘 잡아뒀지")));

  assert.equal(readAssessment.calls.length, 0);
  assert.equal(tools[1].status, "failed");
  assert.match(answer, NO_EVIDENCE);
});

test("검색만 하고 읽지 않으면 후보는 근거가 되지 않는다", async () => {
  searchCompanyContext.returns(companySearch());
  searchAssessments.returns(assessmentSearch());
  const solar = install(createSolar({
    turns: [
      toolTurn({ name: "search_company_context", args: { query: "안전관리비" } }),
      toolTurn({ name: "search_assessments", args: { query: "안전관리비" } }),
    ],
  }));

  const { tools, answer } = await readEnvelope(await POST(chatRequest("안전관리비 관련 자료 있어?")));

  assert.deepEqual(tools.map((tool) => tool.status), ["completed", "completed"]);
  assert.equal(tools[0].output.candidates[0].citable, false);
  assert.equal(tools[1].output.candidates[0].citable, false);
  // 후보가 두 갈래나 나왔어도 종합 단계는 열리지 않는다.
  assert.equal(solar.synthesis.length, 0);
  assert.match(answer, NO_EVIDENCE);
});

test("읽기가 실패하면 그 문서는 근거로 승격되지 않는다", async () => {
  searchCompanyContext.returns(companySearch());
  readCompanyDocument.rejects("COMPANY_CHUNK_NOT_FOUND");
  const solar = install(createSolar({
    turns: [
      toolTurn({ name: "search_company_context", args: { query: "안전관리비" } }),
      toolTurn({ name: "read_company_document", args: { ref: `${DOC_ID}#3` } }),
    ],
  }));

  const { tools, answer } = await readEnvelope(await POST(chatRequest("안전관리비 계상 근거를 알려줘")));

  assert.equal(readCompanyDocument.calls.length, 1);
  assert.equal(tools[1].status, "failed");
  assert.equal(solar.synthesis.length, 0);
  assert.match(answer, NO_EVIDENCE);
});

test("사내 근거만 있으면 법적 근거 자리를 비운 채 답한다", async () => {
  searchCompanyContext.returns(companySearch());
  readCompanyDocument.returns(companyRead());
  const solar = install(createSolar({
    turns: [
      toolTurn({ name: "search_company_context", args: { query: "안전관리비" } }),
      toolTurn({ name: "read_company_document", args: { ref: `${DOC_ID}#3` } }),
    ],
  }));

  const { answer } = await readEnvelope(await POST(chatRequest("안전관리비 계상 근거를 알려줘")));

  assert.equal(answer, "정리한 답변입니다.");
  assert.equal(solar.synthesis.length, 1);
  const { payload, system } = solar.synthesis[0];
  assert.deepEqual(payload.officialEvidence, []);
  assert.deepEqual(payload.factEvidence, []);
  assert.equal(payload.companyEvidence.length, 1);
  assert.equal(payload.companyEvidence[0].근거종류, "사내문서");
  // 합성 등급이 종합 단계까지 살아 가야 답변에 "시연용 합성 문서" 가 붙는다.
  assert.equal(payload.companyEvidence[0].근거.source, "합성");
  assert.match(system, /officialEvidence 가 비어 있으면[^]*법적 판단은 하지 않았다/);
  assert.match(system, /'합성'[^]*합성 문서라는 점을/);
});

test("법령 원문을 읽었을 때만 법적 근거 바구니가 찬다", async () => {
  searchOfficialLaw.returns(lawSearch());
  readOfficialLaw.returns(lawRead());
  const solar = install(createSolar({
    turns: [
      toolTurn({ name: "search_official_law", args: { query: "굴착 작업계획서", search: "body" } }),
      toolTurn({ name: "read_official_law", args: { ref: "eflaw:001" } }),
    ],
  }));

  const { tools } = await readEnvelope(await POST(chatRequest("굴착공사에 필요한 서류가 뭐야")));

  const { payload } = solar.synthesis[0];
  assert.equal(payload.officialEvidence.length, 1);
  assert.match(payload.officialEvidence[0].excerpt, /작업계획서를 작성/);
  assert.deepEqual(payload.companyEvidence, []);
  // 외부 공개 URL 이 있는 것은 법령뿐이라 sources 도 이 갈래에서만 찬다.
  assert.equal(tools[1].sources[0].url, "https://www.law.go.kr/법령/산업안전보건기준에관한규칙");
});

test("현장 사실만으로도 답하고, 사실은 별도 바구니에 담긴다", async () => {
  const facts = [{ factType: "weatherObservation", key: "강수량", value: 41, observedAt: "2026-08-17T06:00:00+09:00", source: "실데이터 — kma_vilagefcst_20260817" }];
  readSiteFacts.returns(facts);
  const solar = install(createSolar({ turns: [toolTurn({ name: "read_site_facts", args: { factType: "weatherObservation", limit: 5 } })] }));

  const { tools } = await readEnvelope(await POST(chatRequest("오늘 현장 비 왔어?")));

  assert.equal(tools[0].status, "completed");
  const { payload, system } = solar.synthesis[0];
  assert.deepEqual(payload.officialEvidence, []);
  assert.deepEqual(payload.companyEvidence, []);
  assert.deepEqual(payload.factEvidence, facts);
  assert.match(system, /observedAt 의 관측 시각과 source 를 함께 적으세요/);
});

test("읽기 도구는 같은 갈래의 검색이 ref 를 만들기 전에는 모델에게 보이지 않는다", async () => {
  searchCompanyContext.returns(companySearch());
  const solar = install(createSolar({ turns: [toolTurn({ name: "search_company_context", args: { query: "안전관리비" } })] }));

  await POST(chatRequest("안전관리비 자료 있어?"));

  const names = (index) => solar.research[index].tools.map((tool) => tool.function.name);
  assert.deepEqual(names(0).filter((name) => name.startsWith("read_")), ["read_site_facts"]);
  assert.equal(solar.research[0].tool_choice, "required");
  // 사내 검색이 ref 를 만든 뒤에야 사내 읽기가 열린다. 평가표 읽기는 여전히 닫혀 있다.
  assert.ok(names(1).includes("read_company_document"));
  assert.ok(!names(1).includes("read_assessment"));
  assert.ok(!names(1).includes("read_official_law"));
  assert.equal(solar.research[1].tool_choice, "auto");
});

test("도구 인자에 남의 계열 필드가 섞이면 저장소까지 내려가지 않는다", async () => {
  install(createSolar({ turns: [toolTurn({ name: "search_assessments", args: { query: "붕괴", search: "body" } })] }));

  const { tools, answer } = await readEnvelope(await POST(chatRequest("붕괴 위험 뭐 있어")));

  assert.equal(searchAssessments.calls.length, 0);
  assert.equal(tools[0].status, "failed");
  assert.match(answer, NO_EVIDENCE);
});

test("어휘 밖 factType 은 라우트가 잘라 내고, 인자 없는 호출은 통과시킨다", async () => {
  readSiteFacts.returns([]);
  install(createSolar({
    turns: [
      toolTurn({ name: "read_site_facts", args: { factType: "없는사실종류" } }),
      toolTurn({ name: "read_site_facts", raw: "" }),
    ],
  }));

  const { tools } = await readEnvelope(await POST(chatRequest("현장 상태 알려줘")));

  assert.equal(tools[0].status, "failed");
  assert.equal(readSiteFacts.calls.length, 1);
  assert.deepEqual(readSiteFacts.calls[0], [{}]);
  assert.equal(tools[1].status, "completed");
});

test("설정이 전부 꺼졌을 때만 503 이고, 한 갈래라도 살아 있으면 그 갈래로 답한다", async () => {
  Object.assign(configured, { law: false, company: false, assessment: false, facts: false });
  install(createSolar({}));
  assert.equal((await POST(chatRequest("굴착 서류"))).status, 503);

  configured.company = true;
  searchCompanyContext.returns(companySearch());
  readCompanyDocument.returns(companyRead());
  install(createSolar({
    turns: [
      toolTurn({ name: "search_company_context", args: { query: "안전관리비" } }),
      toolTurn({ name: "read_company_document", args: { ref: `${DOC_ID}#3` } }),
    ],
  }));
  const { answer } = await readEnvelope(await POST(chatRequest("안전관리비 계상 근거를 알려줘")));
  assert.equal(answer, "정리한 답변입니다.");
});

test("도구 이름을 지어내면 근거를 만들지 못하고 요청이 되돌아간다", async () => {
  install(createSolar({ turns: [toolTurn({ name: "read_company_documents", args: { ref: `${DOC_ID}#3` } })] }));

  const response = await POST(chatRequest("문서 좀 보여줘"));

  assert.equal(response.status, 502);
  assert.equal(readCompanyDocument.calls.length, 0);
});

test("평가표 읽기가 성공하면 위험성평가 근거로 갈라 담긴다", async () => {
  searchAssessments.returns(assessmentSearch());
  readAssessment.returns(assessmentRead());
  const solar = install(createSolar({
    turns: [
      toolTurn({ name: "search_assessments", args: { query: "슬래브 해체" } }),
      toolTurn({ name: "read_assessment", args: { ref: `${ASSESSMENT_ID}#0` } }),
    ],
  }));

  await POST(chatRequest("슬래브 해체 대책 뭐 잡아뒀지"));

  const { payload } = solar.synthesis[0];
  assert.deepEqual(payload.officialEvidence, []);
  assert.equal(payload.companyEvidence[0].근거종류, "위험성평가");
  assert.equal(payload.companyEvidence[0].근거.url, `/api/risk/${ASSESSMENT_ID}`);
  assert.equal(payload.companyEvidence[0].근거.source, "합성");
  // 색인에는 남이 만든 평가도 섞인다. 소유자를 말하지 않으면 종합 단계가 그것을
  // "우리 현장에서는 이미 식별했습니다" 로 쓴다.
  assert.equal(payload.companyEvidence[0].근거.현장소속, "확인되지 않음");
});
