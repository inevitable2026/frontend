"use client";

// 증거 서랍이 근거 팩트를 얻는 길. **새 라우트를 만들지 않는다** — 이미 있는
// `GET /api/board/facts` 만 부른다(AC-4).
//
// ## 왜 board-data.ts 가 아니라 여기인가
//
// 저 파일이 "화면이 보드 데이터를 얻는 유일한 진입점" 이라고 스스로 적어 두었으니 원래
// 자리는 거기다. 다만 이 단계는 기존 파일을 고치지 않고, 저 파일의 `읽기<T>()` 는 비공개라
// 밖에서 쓸 수 없다. 그래서 **BoardRequestError 만 그대로 재사용하고** 상태 코드별 진단
// 문구를 같은 규칙으로 여기서 쓴다. 오류 타입이 같아야 서랍의 실패 표시가 보드의 다른
// 실패 표시와 같은 자리에 선다.
//
// ## 왜 factType 을 반드시 붙이고 docId 는 붙이지 않는가
//
// `docId` 를 붙이면 라우트가 `key.startsWith(docId + "#")` 한 갈래로만 거른다
// (app/api/board/facts/route.ts:56). 시드 86건 중 35건은 key 에 `#` 이 없어 0건이 나온다 —
// `?docId=doc_2_k3f9x1qm` 은 그 카드의 주 근거인 자재변경 메일 추출을 통째로 놓친다.
// 그래서 문서 필터는 화면(evidence.ts 의 팩트고르기)에서 세 갈래로 한다.
//
// `factType` 은 반대로 절대 빼면 안 된다. 라우트의 `최신만()` 은 **factType 을 무시하고
// key 로만 접는다**(route.ts:26-34). 시드에 교차 충돌이 실제로 셋 있다 —
// `ra_2026_08_regular#RI-01 · #RI-07 · #RI-11` 이 riskAssessmentRow 와 riskRecommendation
// 양쪽에 있고, factType 없이 부르면 한쪽이 다른 쪽을 덮는다. 이 성질은 라우트 주석에 적혀
// 있지 않으므로, 최적화한다며 factType 을 빼지 않도록 여기 적어 둔다.

import { useEffect, useState } from "react";

import type { FactType, SnapshotFact } from "@/lib/board/types";

import { BoardRequestError } from "./board-data";
import { 문서키팩트타입 } from "./evidence";

async function 본문오류(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    // 본문이 JSON 이 아닌 실패도 있다. 그때는 사유를 못 읽었다는 뜻으로 null 을 올리고,
    // 부르는 쪽이 상태 코드로 문구를 만든다. 실패 자체를 삼키는 것이 아니다.
    return null;
  }
}

function 실패문구(status: number, detail: string | null): string {
  const 꼬리 = detail ? ` 서버가 돌려준 문구는 "${detail}" 입니다.` : "";
  if (status === 503) return `보드 스키마가 아직 적용되지 않았습니다.${꼬리}`;
  if (status === 404) return `이 현장의 팩트가 아직 적재되지 않았습니다.${꼬리}`;
  if (status === 400) return `근거 팩트 요청이 올바르지 않습니다.${꼬리}`;
  return `데이터베이스에 연결하지 못했습니다. 근거 팩트 요청에 서버가 ${status} 로 답했습니다.${꼬리}`;
}

/** 종류 하나를 현장 단위로 읽는다. 응답 `{ facts, 총건수 }` 에서 facts 만 꺼낸다. */
export async function 팩트읽기(siteId: string, factType: FactType): Promise<SnapshotFact[]> {
  const query = new URLSearchParams({ siteId, factType });
  let res: Response;
  try {
    res = await fetch(`/api/board/facts?${query}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new BoardRequestError(
      "서버에 닿지 못했습니다. 근거 팩트 요청이 네트워크에서 끊겼습니다.",
      null,
      null,
    );
  }
  if (!res.ok) {
    const detail = await 본문오류(res);
    throw new BoardRequestError(실패문구(res.status, detail), res.status, detail);
  }
  const body = (await res.json()) as { facts?: SnapshotFact[] };
  return body.facts ?? [];
}

export type 팩트실패 = { factType: FactType; 사유: string };

export type 팩트상자 = {
  /** 읽는 데 성공한 종류의 팩트를 모은 것. 실패한 종류는 여기 없고 아래 실패들에 있다. */
  전체: SnapshotFact[];
  /**
   * 못 읽은 종류. **빈 배열로 접지 않는다** — 못 읽은 것과 한 건도 없는 것은 다른 사실이다
   * (risk-doc-panel.tsx:80-83 · lib/board/sources.ts 의 documents: null 과 같은 갈래).
   */
  실패들: 팩트실패[];
  읽는중: boolean;
};

/** 읽어 온 결과와 그것이 **어느 현장의 것인지**. 현장이 바뀌면 옛 결과를 쓰지 않는다. */
type 읽은결과 = { siteId: string; 전체: SnapshotFact[]; 실패들: 팩트실패[] };

/**
 * 서랍이 열릴 때 문서키 여섯 종을 한 번에 읽는다.
 *
 * 카드 하나가 대는 문서가 최대 셋이라(sourceDocRefs 둘 + invalidates 하나) 문서별로 나눠
 * 부르면 왕복이 늘기만 하고, 위에 적은 대로 docId 필터는 절반을 못 본다. 종류별 여섯 번을
 * 병렬로 보내고 화면에서 문서에 맞춘다.
 *
 * 이름만 영어인 것은 react-hooks 규칙이 훅을 `use` + 대문자로만 알아보기 때문이다.
 * 같은 이유로 이 저장소의 다른 훅(useReference · useLawChat)도 영어 이름을 쓴다.
 *
 * **세션 캐시를 두지 않는다.** 서랍에 끼운 평가서가 이행확인을 `POST /api/board/facts` 로
 * 저장하므로(AC-12), 한 번 읽어 두고 계속 쓰면 사람이 방금 고친 값을 옛 값으로 그린다.
 * 안전 화면에서 그 종류의 거짓말은 왕복 여섯 번보다 비싸다.
 *
 * "읽는중" 을 상태로 따로 두지 않고 **결과의 현장과 지금 현장을 견주어** 판정한다. 효과
 * 본문에서 동기적으로 setState 하면 렌더가 연쇄로 도는데, 그 한 줄이 하던 일은 여기서
 * 계산으로 대신할 수 있다.
 */
export function useCardFacts(siteId: string): 팩트상자 {
  const [결과, set결과] = useState<읽은결과 | null>(null);

  useEffect(() => {
    let 살아있음 = true;

    (async () => {
      const 응답들 = await Promise.allSettled(문서키팩트타입.map((t) => 팩트읽기(siteId, t)));
      if (!살아있음) return;

      const 전체: SnapshotFact[] = [];
      const 실패들: 팩트실패[] = [];
      응답들.forEach((r, i) => {
        const factType = 문서키팩트타입[i];
        if (r.status === "fulfilled") 전체.push(...r.value);
        else {
          const 사유 =
            r.reason instanceof Error ? r.reason.message : "알 수 없는 이유로 실패했습니다.";
          실패들.push({ factType, 사유 });
        }
      });
      set결과({ siteId, 전체, 실패들 });
    })();

    return () => {
      // 서랍은 카드를 바꿔 가며 다시 열린다. 앞 요청이 늦게 도착해 지금 화면을 덮지 않도록
      // 표식을 내린다 (risk-doc-panel.tsx:66-71 과 같은 수법).
      살아있음 = false;
    };
  }, [siteId]);

  if (결과 === null || 결과.siteId !== siteId) {
    return { 전체: [], 실패들: [], 읽는중: true };
  }
  return { 전체: 결과.전체, 실패들: 결과.실패들, 읽는중: false };
}
