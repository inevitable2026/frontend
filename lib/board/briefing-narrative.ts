import { isGenerationConfigured, narrateBriefing } from "@/lib/generate";

import { 문단재료만들기, 문단캐시열쇠, type BriefingInput } from "./briefing";
import type { BoardStore } from "./types";

/**
 * 브리핑 맨 위 문단.
 *
 * 캐시를 먼저 본다. 열쇠에 시각이 들어가지 않으므로, 창 안의 감지와 카드가 그대로면 화면을
 * 몇 번을 새로 열어도 같은 문단이 나오고 모델은 한 번만 불린다. 담당자가 브리핑이 어제와
 * 무엇이 달라졌는지를 문장의 변화로 읽기 때문에, 같은 상황에 다른 문장이 나오는 것 자체가
 * 거짓 신호가 된다.
 *
 * 모델이 실패하면 넘겨받은 폴백 문단을 그대로 돌려준다. 그 문단은 어떤 상황에서도 똑같이
 * 나오는 틀이지만 사실과 어긋나지는 않는다 — 화면이 비어 "오늘 아무 일도 없다" 로 읽히는
 * 쪽이 훨씬 나쁘다. 실패한 문단은 캐시에 넣지 않는다. 넣으면 다음 요청이 되살릴 기회를 잃는다.
 *
 * 이 함수가 라우트에서 떨어져 나온 이유는 부르는 곳이 둘이기 때문이다. GET /api/board/briefing
 * 이 하나이고, 첫 화면이 한 번에 받아 가는 스냅샷(lib/board/sources.ts)이 다른 하나다.
 * 한쪽만 캐시와 모델을 거치면 같은 상황에서 두 화면의 첫 문단이 서로 다른 글이 된다.
 */
export async function 브리핑문단(
  store: BoardStore,
  재료: BriefingInput,
  폴백: string[],
): Promise<string[]> {
  const 열쇠 = 문단캐시열쇠(재료);

  try {
    const 캐시 = await store.readBriefingNarrative(열쇠);
    if (캐시) return 캐시;
  } catch (error) {
    // 캐시를 못 읽은 것으로 브리핑을 실패시키지 않는다. 모델을 한 번 더 부르면 될 일이다.
    console.error("[board/briefing] 문단 캐시 읽기 실패", error);
  }

  if (!isGenerationConfigured()) return 폴백;

  try {
    const paragraphs = await narrateBriefing(문단재료만들기(재료));
    if (paragraphs.length === 0) return 폴백;
    await store.writeBriefingNarrative(열쇠, 재료.siteId, paragraphs).catch((error: unknown) => {
      console.error("[board/briefing] 문단 캐시 쓰기 실패", error);
    });
    return paragraphs;
  } catch (error) {
    console.error("[board/briefing] 문단 생성 실패", error);
    return 폴백;
  }
}
