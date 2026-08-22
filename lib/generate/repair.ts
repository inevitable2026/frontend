// 모델이 끝맺지 못한 JSON 을 닫아 준다.
//
// solar-pro4 는 구조화 출력에서 드물지 않게 이렇게 멈춘다.
//
//   {"headline":"...","관측":["..."],"불확실성":["감리 지적사항 즉시 보완"]  \t\n\t\n\t\n …
//
// 닫는 중괄호를 빼먹고 공백과 탭만 수백 자 쏟아낸 뒤 finish_reason 은 stop 이다. 토큰
// 상한에 걸린 것이 아니라(완료 토큰이 200 밖에 되지 않는다) 그냥 마무리를 하지 않는다.
//
// 여기서 닫아 주지 않으면 AI SDK 는 "could not parse the response" 로 실패하고, 그 실패는
// 재시도로도 낫지 않는다. 같은 자리에서 같은 방식으로 다시 멈추기 때문이다. 닫아 주면
// 그다음은 zod 가 맡는다 — 필드가 모자라면 그때는 스키마 위반으로 정상적인 재시도가 돈다.
//
// 값을 지어내지는 않는다. 이 파일이 하는 일은 **이미 쓰인 것을 문법적으로 닫는 것** 뿐이고,
// 빠진 키를 채우거나 잘린 낱말을 이어 붙이지 않는다. 그것은 복구가 아니라 창작이다.

/** 여는 괄호와 짝이 되는 닫는 괄호 */
const 짝: Record<string, string> = { "{": "}", "[": "]" };

/**
 * 문자열 리터럴 안인지 추적하며 열린 괄호를 쌓는다.
 *
 * 문자열 안의 `{` 는 구조가 아니라 글자이므로 세면 안 된다. 이스케이프(`\"`)도 같은
 * 이유로 건너뛴다.
 */
function 열린것(text: string): { stack: string[]; 문자열안: boolean } {
  const stack: string[] = [];
  let 문자열안 = false;
  let 이스케이프 = false;

  for (const ch of text) {
    if (문자열안) {
      if (이스케이프) 이스케이프 = false;
      else if (ch === "\\") 이스케이프 = true;
      else if (ch === '"') 문자열안 = false;
      continue;
    }
    if (ch === '"') 문자열안 = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  return { stack, 문자열안 };
}

/**
 * 값이 끝났을 법한 자리들을 뒤에서부터 훑는다.
 *
 * 한 번만 되감아서는 모자란다. `{"headline":"좋다","관측":` 에서 뒤로 가다 처음 만나는
 * 따옴표는 값의 끝이 아니라 **키의 끝** 이고, 거기서 자르면 `{"headline":"좋다","관측"}`
 * 이라는 또 다른 깨진 JSON 이 된다. 값의 끝인지 키의 끝인지는 앞뒤를 보지 않고서는
 * 알 수 없고, 그 판별을 손으로 짜면 따옴표 안의 콜론 같은 것에 또 걸린다.
 *
 * 그래서 판별하지 않고 후보를 차례로 내놓는다. 부르는 쪽이 닫아 보고 파싱되는 첫 후보를
 * 쓴다 — 파싱이 곧 판별이다.
 */
function* 끝후보(text: string): Generator<string> {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === "}" || ch === "]" || ch === '"' || /[0-9a-z]/i.test(ch)) {
      yield text.slice(0, i + 1);
    }
  }
}

/**
 * 끝맺지 못한 JSON 을 닫는다. 이미 파싱되는 문자열이면 null 을 돌려 그대로 두게 한다.
 *
 * AI SDK 의 `repairText` 규약이 그렇다 — null 은 "고칠 것이 없거나 고치지 못했다" 이고,
 * 그때는 원래의 파싱 실패가 그대로 올라간다.
 */
export async function 끝맺기({ text }: { text: string }): Promise<string | null> {
  const 다듬은 = text.trim();
  if (다듬은 === "") return null;

  try {
    JSON.parse(다듬은);
    return null;
  } catch {
    // 아래에서 고쳐 본다.
  }

  // 모델이 코드 울타리를 두르는 경우가 있다.
  const 울타리없음 = 다듬은
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let 후보 = 울타리없음;
  const { 문자열안 } = 열린것(후보);

  // 문자열 한가운데서 끊겼으면 그 문자열은 통째로 버린다. 잘린 낱말을 따옴표로 닫아
  // 살리면 "…를 확인해야 합니" 같은 값이 그대로 문서에 실린다.
  if (문자열안) {
    const 마지막따옴표 = 후보.lastIndexOf('"');
    if (마지막따옴표 <= 0) return null;
    후보 = 후보.slice(0, 마지막따옴표);
  }

  // 뒤에서부터 잘라 가며 닫아 보고, 파싱되는 첫 후보를 쓴다.
  for (const 자른것 of 끝후보(후보)) {
    const { stack, 문자열안: 아직문자열 } = 열린것(자른것);
    if (아직문자열) continue;

    const 닫힌것 = 자른것 + [...stack].reverse().map((ch) => 짝[ch]).join("");
    try {
      const 값 = JSON.parse(닫힌것);
      // 객체나 배열이 아니면 우리가 찾던 것이 아니다. `{"a":1` 을 되감다 `1` 하나만
      // 남은 것을 성공으로 치면 스키마에 맞지 않는 값을 성공인 척 돌려주게 된다.
      if (값 !== null && typeof 값 === "object") return 닫힌것;
    } catch {
      // 다음 후보로.
    }
  }

  return null;
}
