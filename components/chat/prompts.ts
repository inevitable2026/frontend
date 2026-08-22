/**
 * 예시 질문 세 장. **지금 라우트가 답할 수 있는 것은 법령 질문 하나뿐**이라서
 * `ACTIVE_PROMPT_LABEL` 만 누를 수 있고 나머지는 막아 둔다. 사내 문서 도구가
 * 붙으면(`docs/company-chatbot-plan.md` 로드맵 2단계) 나머지도 열린다.
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

export const ACTIVE_PROMPT_LABEL = "작업 전 법령 체크";

export const ASSISTANT_LABEL = "현장 법령 체크 에이전트";
