/** 입력줄 아래 보조 기술만 읽는 진행 상황 한 줄. 두 화면이 같은 문장을 쓴다. */
export function askBarStatus(state: {
  error: string;
  isSubmitting: boolean;
  answer: string;
  lastQuestion: string;
}): string {
  if (state.error) return `오류: ${state.error}`;
  if (state.isSubmitting) return "질문을 보내고 답변을 기다리는 중입니다.";
  if (state.answer) return "답변이 완료되었습니다.";
  if (state.lastQuestion) return `질문을 보냈습니다: ${state.lastQuestion}`;
  return "";
}
