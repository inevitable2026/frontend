/**
 * `/api/chat` 라우트를 네트워크·DB 없이 돌리기 위한 대역.
 *
 * 라우트는 근거 모듈 넷을 `@/lib/agent/*` 로, 대화 기록 저장소를 `@/lib/chat/*` 로 가져온다.
 * 그 모듈들은 postgres 커넥션과 Upstage 임베딩을 실제로 열기 때문에 테스트에서 그대로 부를
 * 수 없다. tsc 는 경로 별칭을 산출물에 그대로 남기므로(`import ... from
 * "@/lib/agent/site-context"`), 별칭을 대역 파일로 돌려 끼운다. 별칭 해석기는 Node 기본
 * 제공인 `node:module` 의 `registerHooks` 뿐이고 새 러너나 프레임워크를 들이지 않는다.
 *
 * 대역이 노리는 것은 라우트의 인용 격리 규약이다 — 어떤 ref 가 읽히는지, 후보가 근거로
 * 승격되지 않는지는 근거 모듈이 아니라 라우트가 정한다. 그래서 근거 모듈은 각본으로 바꾸고
 * 라우트만 진짜를 돌린다.
 */
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";

import { resetChatHistory, TEST_SITE_ID } from "./chat-history-double.mjs";

const HERE = import.meta.url;
const dist = (path) => new URL(`../../tmp/test-dist/${path}`, import.meta.url).href;
const here = (path) => new URL(path, import.meta.url).href;

// FACT_TYPES·DOCUMENT_KINDS 는 도구 인자 스키마의 어휘라서 대역을 쓰면 검증이 헐거워진다.
// 이 둘만 빌드 산출물의 진짜 모듈로 보낸다.
const ALIASES = new Map([
  ["@/lib/agent/official-law", HERE],
  ["@/lib/agent/site-context", HERE],
  ["@/lib/agent/assessment-index", HERE],
  ["@/lib/agent/site-facts", HERE],
  ["@/lib/board/types", dist("lib/board/types.js")],
  ["@/lib/context/types", dist("lib/context/types.js")],
  ["@/lib/chat/chat-history-access", here("./chat-history-double.mjs")],
  ["@/lib/chat/chat-history-store", here("./chat-history-double.mjs")],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mapped = ALIASES.get(specifier);
    if (!mapped) return nextResolve(specifier, context);
    return { url: mapped, format: "module", shortCircuit: true };
  },
});

/**
 * 각본이 없으면 던진다. 부르지 않아야 할 도구가 불렸을 때 조용히 빈 값을 돌려주면
 * "지어낸 ref 는 읽히지 않는다" 같은 시험이 통과한 것처럼 보인다.
 */
function stub(name) {
  let handler = null;
  const fn = async (...args) => {
    fn.calls.push(args);
    if (!handler) throw new Error(`${name}: 각본에 없는 호출`);
    return handler(...args);
  };
  fn.calls = [];
  fn.stubName = name;
  fn.returns = (value) => {
    handler = () => value;
    return fn;
  };
  fn.rejects = (message) => {
    handler = () => { throw new Error(message); };
    return fn;
  };
  return fn;
}

export const searchOfficialLaw = stub("searchOfficialLaw");
export const readOfficialLaw = stub("readOfficialLaw");
export const searchCompanyContext = stub("searchCompanyContext");
export const readCompanyDocument = stub("readCompanyDocument");
export const searchAssessments = stub("searchAssessments");
export const readAssessment = stub("readAssessment");
export const readSiteFacts = stub("readSiteFacts");

/** 갈래별 설정 스위치. 라우트는 꺼진 갈래의 도구를 목록에서 뺀다. */
export const configured = { law: true, company: true, assessment: true, facts: true };

export function isOfficialLawConfigured() { return configured.law; }
export function isCompanyContextConfigured() { return configured.company; }
export function isAssessmentIndexConfigured() { return configured.assessment; }
export function isSiteFactsConfigured() { return configured.facts; }

/**
 * 모델 대역. 라우트는 조사 왕복과 종합 왕복 모두 같은 URL 로 나가므로 `tools` 유무로 가른다
 * (조사 왕복만 도구 목록을 싣는다).
 */
export function createSolar({ turns = [], answer = "정리한 답변입니다." } = {}) {
  const queue = [...turns];
  const research = [];
  const synthesis = [];

  const fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (Array.isArray(body.tools)) {
      research.push(body);
      const message = queue.shift() ?? { role: "assistant", content: null };
      return Response.json({ choices: [{ message }] });
    }
    synthesis.push({ system: body.messages[0].content, payload: JSON.parse(body.messages[1].content) });
    return Response.json({ choices: [{ message: { role: "assistant", content: answer } }] });
  };

  return { fetch, research, synthesis, unusedTurns: () => queue.length };
}

/** 모델이 도구를 부르는 한 턴. `raw` 를 주면 인자 문자열을 그대로 실어 보낸다. */
export function toolTurn(...calls) {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((call, index) => ({
      id: `call-${index + 1}`,
      type: "function",
      function: {
        name: call.name,
        arguments: call.raw !== undefined ? call.raw : JSON.stringify(call.args ?? {}),
      },
    })),
  };
}

export function resetHarness() {
  for (const fn of [searchOfficialLaw, readOfficialLaw, searchCompanyContext, readCompanyDocument, searchAssessments, readAssessment, readSiteFacts]) {
    fn.calls.length = 0;
    fn.rejects(`${fn.stubName}: 각본에 없는 호출`);
  }
  Object.assign(configured, { law: true, company: true, assessment: true, facts: true });
  resetChatHistory();
}

export async function loadChatRoute() {
  return import(dist("app/api/chat/route.js"));
}

/**
 * 왕복 한 번. `conversationId` 를 싣지 않아 요청마다 새 대화가 열린다 — 참조 사전이 요청과
 * 함께 사라지는지 보는 시험들이 서로의 기록을 물려받지 않아야 한다. 이어지는 대화를 보려면
 * `overrides` 로 `conversationId` 를 준다.
 */
export function chatRequest(question, overrides = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ siteId: TEST_SITE_ID, commandId: randomUUID(), question, ...overrides }),
  });
}

/** 응답 봉투에서 도구 이벤트와 마지막 답변만 꺼낸다. */
export async function readEnvelope(response) {
  const body = await response.json();
  const events = Array.isArray(body.events) ? body.events : [];
  const assistant = events.find((event) => event.type === "assistant");
  return { events, tools: events.filter((event) => event.type === "tool"), answer: assistant?.content ?? null, body };
}
