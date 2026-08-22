import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownContent } from "../tmp/test-dist/components/markdown-content.js";

/**
 * 각주가 근거의 계열을 지키는지 본다.
 *
 * `citationSources()` 까지만 보던 그물에는 구멍이 있었다 — 사내 문서 발췌에도 "제334조
 * (콘크리트의 타설작업)" 같은 조문 문자열이 그대로 들어 있어서(시드 문서 16건이 그렇다),
 * 각주 매칭이 계열을 안 보면 합성 문서가 "국가법령정보센터 원문" 링크를 달고 공식 법령으로
 * 화면에 선언된다. 여기서 막는 것은 그 한 가지다.
 */

const 사내 = {
  kind: "사내문서",
  title: "고촌 물류센터 하도급계약서",
  url: "/api/context/documents/11111111-1111-4111-8111-111111111111",
  authority: "김포 고촌 물류센터 · 하도급계약서",
  version: "합성",
  excerpt: "제334조(콘크리트의 타설작업) 관련 점검 항목을 계약에 포함한다.",
};

const 법령 = {
  kind: "법령",
  title: "산업안전보건기준에 관한 규칙",
  url: "https://www.law.go.kr/법령/산업안전보건기준에관한규칙",
  authority: "고용노동부",
  version: "20260101",
  excerpt: "제334조(콘크리트의 타설작업) 사업주는 콘크리트를 타설하는 경우 …",
};

function render(content, sources) {
  return renderToStaticMarkup(MarkdownContent({ content, sources }));
}

test("법령을 읽지 않은 답변의 조문 각주는 국가법령정보센터 원문으로 표시되지 않는다", () => {
  const html = render("슬래브 타설은 제334조 점검 항목을 따릅니다.", [사내]);

  assert.ok(!html.includes("국가법령정보센터 원문"), html);
  assert.ok(html.includes("사내 문서 본문"), html);
  assert.ok(!html.includes("공식 원문"), html);
  // 링크가 가는 곳도 법령이 아니라 사내 문서 원본이어야 한다.
  assert.ok(html.includes("/api/context/documents/"), html);
});

test("법령 근거가 있으면 도구 순서와 무관하게 조문 각주는 법령을 가리킨다", () => {
  // sources 배열의 순서는 도구 호출 순서다. 사내 검색·읽기를 먼저 한 요청이 흔하다.
  const html = render("제334조에 따라 타설 전 점검이 필요합니다.", [사내, 법령]);

  assert.ok(html.includes("국가법령정보센터 원문"), html);
  assert.ok(!html.includes("사내 문서 본문"), html);
  assert.ok(html.includes("law.go.kr"), html);
});

test("사내 근거 하나뿐일 때 발췌에 없는 조문은 각주가 되지 않는다", () => {
  // 근거가 하나면 무조건 붙이던 폴백은 법령에만 남긴다. 사내 문서에까지 두면 답변의
  // 모든 조문 언급이 그 합성 문서로 연결된다.
  const html = render("제42조에 따른 추락 방지 조치가 필요합니다.", [사내]);

  assert.ok(!html.includes("citation-note"), html);
});

test("법령 근거가 하나뿐이면 발췌에 없는 조문도 그 원문으로 이어진다", () => {
  const html = render("제42조도 함께 확인해야 합니다.", [법령]);

  assert.ok(html.includes("국가법령정보센터 원문"), html);
  assert.ok(html.includes("답변 인용"), html);
});

test("위험성평가 근거의 각주는 평가 원본으로 이어진다", () => {
  const 평가 = {
    kind: "위험성평가",
    title: "슬래브 해체 위험성평가",
    url: "/api/risk/33333333-3333-4333-8333-333333333333",
    authority: "위험성평가 기록 · 현장 소속 미확인",
    version: "합성",
    excerpt: "1행 · 공종 철거·해체 · 법적근거 산업안전보건기준에 관한 규칙 제38조",
  };

  const html = render("제38조 관련 대책이 이미 적혀 있습니다.", [평가]);

  assert.ok(html.includes("위험성평가 원본"), html);
  assert.ok(!html.includes("국가법령정보센터 원문"), html);
});
