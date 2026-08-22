// 모델에게 넘길 값을 사람이 읽는 모양으로 다듬는다.
//
// 근거의 observedAt 은 경로에 따라 다른 글자로 온다. 저장소가 갓 만든 값은
// "2026-08-18T14:33:40+09:00" 이고, 저장했다 jsonb 로 되읽은 값은
// "2026-08-18T05:33:40.000Z" 다. 둘을 그대로 프롬프트에 넣으면 모델이 본 글자를 그대로
// 문장에 옮겨, 담당자가 읽는 브리핑에 "관측 2026-08-18T05:33:40.000Z" 같은 줄이 선다.
//
// 표기를 여기서 통일하면 그 위험이 사라진다. 값이 무엇이든 KST 벽시계 한 줄로 바뀐다.

const KST_OFFSET_MS = 9 * 3_600_000;

/** "2026-08-18 14:33" 꼴. 파싱되지 않는 값은 손대지 않고 그대로 돌려준다 */
export function 사람시각(value: string): string {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return value;
  const d = new Date(t + KST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
