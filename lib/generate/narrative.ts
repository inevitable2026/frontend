import { generateObject } from "ai";

import type { Detection, DetectionNarrative, WorkItem } from "@/lib/board/types";
import { GENERATION_PROVIDER_OPTIONS, GENERATION_RETRIES, GENERATION_MAX_TOKENS, generationModel } from "./model";
import { briefingParagraphsSchema, detectionNarrativeSchema } from "./schemas";

// 브리핑의 문장을 쓴다.
//
// 예전에는 lib/board/briefing.ts 가 문단 다섯 개를 문자열 틀에 끼웠다. 받침을 세어
// 조사를 고르는 함수 일습(을를 · 이가 · 은는 · 으로로)이 그 틀을 떠받쳤고, 숫자와 알파벳의
// 종성 표까지 손으로 적혀 있었다. 문법은 정확했지만 어떤 상황이든 같은 다섯 문장이 나왔다.
//
// 그 틀은 lib/board/briefing-fallback.ts 에 그대로 남아 있다. 여기가 실패하면 그쪽으로
// 되돌아간다 — 화면이 비는 것보다 틀에 박힌 문장이 낫기 때문이다.

const 서사SYSTEM = [
  "당신은 한국 건설현장 담당자에게 오늘 아침 브리핑을 쓰는 사람입니다.",
  "감지된 조건 하나를 여섯 칸으로 나누어 적습니다. 담당자는 이 칸들을 보고 기계의 판단을 믿을지 정합니다.",
  "",
  "- 관측: 밖에서 새로 들어온 사실. 무엇이 언제 어느 문서에서 왔는지 각 줄 끝에 적습니다.",
  "- 대조: 우리가 이미 들고 있던 상태. 관측과 무엇이 다른지가 드러나야 합니다.",
  "- 판단: 그 차이가 왜 문제인지. 무엇의 전제가 무너졌는지를 적습니다.",
  "- 만든것: 이 조건 때문에 보드에 올린 카드를 사람 말로. 몇 건이 어느 열에 올라갔는지 적습니다.",
  "- 불확실성: 확신하지 못하는 것과 사람이 직접 확인해야 하는 것.",
  "",
  "지켜야 할 것:",
  "- 주어진 근거와 카드에 있는 것만 씁니다. 없는 사실을 채워 넣으면 아래 근거 패널과 어긋나고, 그 순간 브리핑 전체가 읽히지 않는 글이 됩니다.",
  "- 각 칸은 짧은 문장 한두 개면 충분합니다. 같은 말을 칸마다 되풀이하지 마십시오.",
  "- 확신하지 못하는 것이 없으면 불확실성을 빈 배열로 두십시오. 억지로 채우지 마십시오.",
  "- 한국어 조사와 어미를 정확히 씁니다.",
].join("\n");

function 근거블록(detection: Detection): string {
  if (detection.evidence.length === 0) return "(근거 없음)";
  return detection.evidence
    .map((e) => {
      const 출처 = e.sourceDocId ? ` · 출처 ${e.sourceDocId}` : "";
      return `- [${e.factType}] ${e.excerpt} (관측 ${e.observedAt}${출처})`;
    })
    .join("\n");
}

const 상태이름 = { todo: "할 일", approval: "승인 대기", done: "완료" } as const;

function 카드블록(items: WorkItem[]): string {
  if (items.length === 0) return "(올린 카드 없음)";
  return items
    .map((item) => {
      const 꼬리 = [
        상태이름[item.status],
        item.dueBy ? `기한 ${item.dueBy}` : null,
        item.draft ? `${item.draft.form} 초안 있음` : "초안 없음",
      ]
        .filter(Boolean)
        .join(" · ");
      return `- ${item.title} (${꼬리})`;
    })
    .join("\n");
}

export type NarrateDetectionInput = {
  detection: Detection;
  /** 규칙 이름표 */
  ruleLabel: string;
  /** 이 감지가 만든 카드. 서사의 만든것 칸이 이것을 읽는다 */
  items: WorkItem[];
};

export async function narrateDetection(
  input: NarrateDetectionInput,
): Promise<DetectionNarrative> {
  const prompt = [
    `## 감지된 조건 (${input.detection.ruleId} · ${input.ruleLabel})`,
    input.detection.summary,
    `감지 시각: ${input.detection.detectedAt}`,
    `확신도: ${input.detection.confidence}`,
    "",
    "## 근거",
    근거블록(input.detection),
    "",
    "## 전제를 잃은 문서",
    input.detection.invalidates.length > 0
      ? input.detection.invalidates
          .map((v) => `- ${v.docId} / ${v.scope} — ${v.reason}`)
          .join("\n")
      : "(없음)",
    "",
    "## 이 조건 때문에 보드에 올린 카드",
    카드블록(input.items),
  ].join("\n");

  const { object } = await generateObject({
    model: generationModel(),
    schema: detectionNarrativeSchema,
    schemaName: "DetectionNarrative",
    schemaDescription: "감지된 조건 하나를 브리핑 근거 패널의 칸들로 옮긴 문장",
    system: 서사SYSTEM,
    prompt,
    maxRetries: GENERATION_RETRIES,
    maxOutputTokens: GENERATION_MAX_TOKENS,
    providerOptions: GENERATION_PROVIDER_OPTIONS,
  });

  return object;
}

/* ------------------------------------------------------------------ *
 * 창 요약 문단
 * ------------------------------------------------------------------ */

const 문단SYSTEM = [
  "당신은 한국 건설현장 담당자에게 오늘 아침 브리핑의 머리글을 쓰는 사람입니다.",
  "화면 맨 위에 놓이며 담당자가 가장 먼저 읽는 글입니다.",
  "",
  "**세 줄까지만 씁니다.** 한 줄은 한 가지만 말하고 한 문장으로 끝냅니다.",
  "1. 지정된 시점 이후로 무엇을 감지해 태스크를 몇 건 올렸는지. 초안까지 써 둔 것이 있으면 그 건수도 이 줄에 함께 적습니다.",
  "2. 가장 급한 일이 무엇이고 기한이 언제인지.",
  "3. 전제가 무너진 문서와 사람 확인을 기다리는 것이 각각 몇 건인지.",
  "해당 사항이 없는 줄은 통째로 건너뜁니다. 억지로 세 줄을 채우지 마십시오.",
  "",
  "지켜야 할 것:",
  "- **주어진 숫자를 그대로 씁니다.** 세거나 더하지 마십시오. 아래 숫자는 이미 정확하게 세어진 것이고, 여기서 다시 세면 아래 근거 패널과 어긋납니다.",
  "- 날짜와 시각도 주어진 표현을 그대로 씁니다. 스스로 계산하지 마십시오.",
  "- **조건을 하나씩 옮겨 적지 마십시오.** 머리글 바로 아래에 조건 목록이 펼쳐져 있어서, 여기서 되풀이하면 그 목록의 사본이 됩니다. 조건 요약은 첫 줄의 성격을 잡는 참고 자료일 뿐이고, 쓰더라도 종류 이름 한둘까지입니다.",
  "- 문서 식별자(ra_2026_07_regular 같은 값)를 적지 마십시오. 몇 건인지만 적습니다.",
  "- 감지된 조건이 없으면 없다고 적습니다. 없는 일을 만들어 내지 마십시오.",
  "- 목록이나 제목을 쓰지 말고 이어지는 글로 씁니다.",
  "- 한국어 조사와 어미를 정확히 씁니다.",
  "- '할 일' 이라는 말을 총계에 쓰지 마십시오. 그것은 칸반 열 이름이라 승인 대기와 완료까지 그 열에 있는 것으로 읽힙니다.",
].join("\n");

export type BriefingParagraphInput = {
  /** "어제 오후 6시" 처럼 코드가 계산해 둔 창 시작 표현. 모델이 날짜를 세지 않게 한다 */
  창표현: string;
  conditionCount: number;
  createdCount: number;
  draftedCount: number;
  /** 세지 못했으면 undefined. 0 과 구별해야 한다 */
  documentCount: number | undefined;
  /** 사람 확인을 기다리는 카드 수 */
  확인대기: number;
  /** 가장 급한 카드. 없으면 null */
  급한것: { title: string; 기한표현: string | null } | null;
  /** 전제가 무너진 문서 식별자 */
  무효문서: string[];
  /** 감지된 조건들의 한 줄 요약 */
  조건요약: string[];
};

export async function narrateBriefing(input: BriefingParagraphInput): Promise<string[]> {
  const 줄: string[] = [
    `창 시작 표현: ${input.창표현}`,
    `감지한 조건: ${input.conditionCount}건`,
    `올린 태스크: ${input.createdCount}건`,
    `초안까지 써 둔 것: ${input.draftedCount}건`,
    `사람 확인을 기다리는 것: ${input.확인대기}건`,
  ];

  // 세지 못한 것과 0 건은 다른 상황이다. 문서함 라우트가 넘어졌을 때 "한 건도 들어오지
  // 않았습니다" 라고 적으면 사실과 어긋난다.
  줄.push(
    input.documentCount === undefined
      ? "읽은 문서: 세지 못했습니다 (문서함에 닿지 못함 — 문서 건수를 문장에 적지 마십시오)"
      : `읽은 문서: ${input.documentCount}건`,
  );

  if (input.급한것) {
    줄.push(`가장 급한 것: ${input.급한것.title}`);
    if (input.급한것.기한표현) 줄.push(`그 기한: ${input.급한것.기한표현}`);
  } else {
    줄.push("가장 급한 것: 기한이 정해진 미완료 카드가 없습니다");
  }

  줄.push(
    input.무효문서.length > 0
      ? `전제가 무너진 문서: ${input.무효문서.join(" · ")}`
      : "전제가 무너진 문서: 없습니다",
  );

  const prompt = [
    "## 이미 세어진 값 (그대로 쓰십시오)",
    줄.join("\n"),
    "",
    "## 감지된 조건들 (참고용 — 하나씩 옮겨 적지 마십시오)",
    input.조건요약.length > 0 ? input.조건요약.map((s) => `- ${s}`).join("\n") : "(없음)",
  ].join("\n");

  const { object } = await generateObject({
    model: generationModel(),
    schema: briefingParagraphsSchema,
    schemaName: "BriefingParagraphs",
    schemaDescription: "브리핑 맨 위에 놓이는 세 줄",
    system: 문단SYSTEM,
    prompt,
    maxRetries: GENERATION_RETRIES,
    maxOutputTokens: GENERATION_MAX_TOKENS,
    providerOptions: GENERATION_PROVIDER_OPTIONS,
  });

  return object.paragraphs;
}
