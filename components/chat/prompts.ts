/**
 * 예시 질문 세 장. 예전에는 라우트가 법령 질문 하나만 답할 수 있어 한 장만 열어 뒀는데,
 * 이제 사내 문서·위험성평가·현장 사실 도구가 붙어 세 장 다 근거를 가지고 답한다.
 * 누를 수 없는 카드는 데모에서 "왜 안 눌러요" 질문만 부르므로 남겨 두지 않는다.
 */
export const PROMPT_CARDS = [
  {
    label: "오늘의 안전 현황",
    prompt: "이번 주 TBM 미실시 팀이랑\n정기교육 시간 미달자 알려줘",
    icon: "/assets/file-check.svg",
  },
  {
    label: "감사 대응",
    prompt: "6월 위험성평가랑 조치 이력,\n감사 제출용으로 묶어줘",
    icon: "/assets/shredder.svg",
  },
  {
    label: "작업 전 법령 체크",
    prompt: "내일 굴착작업 시작하는데\n법적으로 빠진 서류 있는지 확인해줘",
    icon: "/assets/scale.svg",
  },
] as const;

/**
 * 누를 수 있는 카드 라벨. 단수 상수였던 것을 집합으로 바꿨다 — 열 카드가 하나가 아니고,
 * 도구가 더 붙을 때마다 비교식을 고치는 대신 여기만 늘리면 되게 한다.
 */
export const ACTIVE_PROMPT_LABELS: readonly string[] = [
  "오늘의 안전 현황",
  "감사 대응",
  "작업 전 법령 체크",
];

export function isActivePrompt(label: string): boolean {
  return ACTIVE_PROMPT_LABELS.includes(label);
}

/** 이제 법령만 보지 않는다. 화면 문구("업로드된 서류, 법령, 공공데이터, 현장 기록")와 맞춘다. */
export const ASSISTANT_LABEL = "현장 안전 에이전트";
