/**
 * 팩트 값 안의 영어 코드를 사람이 읽는 말로.
 *
 * 이 값들은 저장된 팩트에 그대로 들어 있고, 화면과 감지 문장 양쪽이 **문장 안에** 붙여
 * 쓴다. 그래서 지금까지 이런 것이 보드에 떠 있었다:
 *
 *   「4층 슬래브 동바리 설치 추천 4×4=16 · 표본 212건 · 사망 19건 · DEGRADED」
 *   「… 첨부 · attachment · 반장 김성태」
 *
 * `DEGRADED` 가 무슨 뜻인지 아는 사람은 이 코드를 쓴 사람뿐이다.
 *
 * **lib 에 두는 이유.** 쓰는 곳이 화면(`components/task-board/evidence.ts`)과
 * 감지(`lib/detect/rules/t07-score-gap.ts`) 둘이다. 화면 쪽에 두면 lib 이 components 를
 * 가져다 쓰게 되고, 양쪽에 각각 두면 언젠가 두 표가 갈라진다.
 *
 * **모르는 값은 지어내지 않는다.** 표에 없으면 원래 값을 그대로 돌려준다 — 뜻을 모르는
 * 채로 그럴듯한 한국어를 붙이면 그게 더 나쁘다.
 */

/**
 * 추천값의 근거 상태(`riskRecommendation.originState`).
 *
 * 뜻은 이 레포가 스스로 적어 두었다 — `lib/detect/rules/t07-score-gap.ts:167` 이
 * *"추천의 근거 상태가 흔들려 … 자동 반영하지 않습니다"* 라고 쓴다. 같은 팩트 안의
 * `통계.신뢰도: "low"` · `점수출처: "DEGRADED"` 와 짝을 이룬다.
 */
const 근거상태표: Record<string, string> = {
  OK: "근거 정상",
  DEGRADED: "근거 흔들림",
};

export function 근거상태이름(value: string | null | undefined): string | null {
  if (!value) return null;
  return 근거상태표[value.toUpperCase()] ?? value;
}

/** 읽어들인 문서가 어디서 왔는지(`documentExtraction.kind`). */
const 문서갈래표: Record<string, string> = {
  email: "메일",
  attachment: "첨부",
  reviewComment: "검토 의견",
  officialNotice: "공문",
};

export function 문서갈래이름(value: string | null | undefined): string | null {
  if (!value) return null;
  return 문서갈래표[value] ?? value;
}
