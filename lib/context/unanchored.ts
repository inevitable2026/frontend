import type { ExtractedFields } from "./types.ts";

/**
 * 원문에서 위치를 짚지 못한 항목을 저장 대상에서 뺀다.
 *
 * **왜 화면에는 보이는데 저장은 안 하는가.** 손글씨로 적힌 지적사항을 모델이 읽어내기는
 * 한다. 그런데 그것을 원문 좌표에 묶지 못하면, 나중에 그 값을 보는 사람은 **어디서 나온
 * 말인지 확인할 길이 없다.** 문서함에 남는 값은 오래 간다 — 다음에 읽는 사람에게는 그냥
 * 사실로 보인다.
 *
 * 그래서 갈랐다. 화면은 "이건 못 짚었습니다, 확인해 주세요" 라고 적고 사람에게 보인다.
 * 저장은 짚은 것만 남긴다. 사람이 확인해서 남기고 싶으면 화면에서 손으로 옮겨 적으면
 * 되고, 그건 사람이 쓴 값이 된다.
 *
 * **뺐다는 사실 자체는 남긴다.** `근거미확인` 요약을 지우지 않는다 — 지우면 문서를 다시
 * 여는 사람이 "원래 이것뿐이었다" 고 읽는다. 무엇이 빠졌는지가 그 자리에 적혀 있어야 한다.
 */
export function 근거있는것만(extracted: ExtractedFields | null): ExtractedFields | null {
  if (!extracted?.근거미확인) return extracted;

  const 짚은것 = <T extends { evidence: unknown[] }>(목록: T[] | undefined): T[] | undefined =>
    목록 === undefined ? undefined : 목록.filter((item) => item.evidence.length > 0);

  return {
    ...extracted,
    평가항목: 짚은것(extracted.평가항목),
    저감조치: 짚은것(extracted.저감조치),
    작업단계: 짚은것(extracted.작업단계),
    지적사항: 짚은것(extracted.지적사항),
    조치사항: 짚은것(extracted.조치사항),
  };
}
