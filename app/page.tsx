import { ConstructionConsole } from "@/components/construction-console";
import type { BoardSources } from "@/components/task-board/board-data";
import { BOARD_AT } from "@/lib/board/scene";
import { loadBoardSources } from "@/lib/board/sources";
import { parseConsoleUrlState } from "@/lib/console-url";

// 데이터베이스를 요청마다 읽으므로 미리 만들어 두지 않는다.
export const dynamic = "force-dynamic";

/**
 * 보드 재료를 첫 HTML 과 함께 내려보낸다.
 *
 * 예전에는 화면 전체가 클라이언트 컴포넌트라 카드 한 장을 그리기까지 네 단계를 기다렸다 —
 * HTML 이 도착하고, 번들을 내려받고, hydration 이 끝나고, 그제서야 첫 요청이 나갔다.
 * 데이터베이스 왕복은 그 뒤에 시작했다. 여기서 미리 읽으면 앞의 세 단계와 데이터베이스
 * 읽기가 겹쳐서 돌고, 브라우저가 받은 첫 HTML 에 이미 카드가 서 있다.
 *
 * 실패는 여기서 화면을 무너뜨리지 않는다. null 로 내려보내면 보드가 예전 길로 직접 읽고,
 * 그쪽에는 상태 코드마다 갈라 둔 진단 문구와 다시 시도 단추가 이미 있다. 대신 조용히
 * 넘어가지는 않고 서버 로그에는 남긴다.
 */
async function 미리읽기(siteId: string, date: string): Promise<BoardSources | null> {
  try {
    return await loadBoardSources(siteId, date, `${date}${BOARD_AT.slice(10)}`);
  } catch (error) {
    console.error("[board] 첫 화면 재료를 서버에서 읽지 못했습니다:", error);
    return null;
  }
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = parseConsoleUrlState(await searchParams);
  const initialBoard = state.nav === "board" ? await 미리읽기(state.siteId, state.boardDate) : null;
  return <ConstructionConsole initialBoard={initialBoard} initialUrlState={state} />;
}
