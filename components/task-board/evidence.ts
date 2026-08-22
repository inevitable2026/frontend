// 증거 서랍의 순수 어댑터.
//
// fetch 도 Date.now() 도 부르지 않는다 — view-model.ts:7-10 이 이 디렉터리에 세워 둔
// 규칙이다. 서랍 컴포넌트는 fetch 를 하므로, 판단(어느 팩트가 어느 문서에 붙는가 · 값을
// 어떻게 한 줄로 적는가 · 어느 평가서를 여는가)을 여기로 빼 두지 않으면 그 규칙이 파일
// 안에서 반쯤만 지켜진다.
//
// ## 왜 문서(docId) 축으로만 되짚는가
//
// `WorkItemTrigger` 는 `{ruleId, condition, sourceDocRefs, confidence,
// requiresHumanConfirmation}` 뿐이다(lib/board/types.ts:75-81). 팩트 좌표(factType · key ·
// observedAt · excerpt)를 든 것은 `Detection.evidence` 이고, 카드로 옮겨질 때
// `sourceDocId` 만 남기고 전부 버려진다(lib/detect/engine.ts:287-289). view-model.ts:686
// 이 이미 "추출된 값은 SnapshotFact 안에 있고 카드까지 실어 오는 경로가 없다" 고 적어
// 두었다. 그래서 근거는 문서 축으로만 되짚는다 — 지어내지 않는 유일한 길이다.
//
// 규칙의 `watches` 로 factType 을 좁히는 길은 기각했다. `watches` 는 규칙 단위라 그 종류의
// 현장 팩트 **전체**가 딸려 오는데, 그것을 "이 카드의 근거" 라고 부르면 카드가 읽지도 않은
// 행을 근거로 세우게 된다. 게다가 S-02 는 규칙 파일 자체가 없다(lib/detect/rules/index.ts).

import { kstClock } from "@/lib/board/briefing";
import type { FactType, SnapshotFact, WorkItem } from "@/lib/board/types";
import { asRecord, readBoolean, readNumber, readRiskScore, readString } from "@/lib/detect/delta";
import { 위험도표시, 이행상태읽기, type 평가행 } from "@/lib/risk/rows";
import { 대상문서 } from "@/lib/risk/doc-target";

/* ------------------------------------------------------------------ *
 * 어느 종류를 읽는가
 * ------------------------------------------------------------------ */

/**
 * key 가 문서 식별자(`docId` 또는 `docId#행id`)인 팩트 종류.
 *
 * data/board/seed-facts.json 86건의 key 를 전수 확인해 고른 여섯이다. 나머지 여덟은 key 가
 * 관측소(`gimpo_gochon#누적강우량`) · 공정(`task_3f_wall`) · 자재(`MAT_PIPE_SHORE`) ·
 * 회의록군(`tbm_pour#pre_1`) · 일자(`2026-08-14`)라 **카드의 어떤 필드도 그 이름을 대지
 * 않는다.** 불러 봐야 붙일 데가 없다.
 */
export const 문서키팩트타입: FactType[] = [
  "riskAssessmentRow",
  "riskRecommendation",
  "documentApprovalState",
  "documentExtraction",
  "nearMissReport",
  "officialNotice",
];

/* ------------------------------------------------------------------ *
 * 카드가 대는 문서
 * ------------------------------------------------------------------ */

export type 문서출처 = "trigger" | "produces" | "invalidates";

export type 문서참조 = {
  docId: string;
  출처: 문서출처;
  /** 무효화의 scope·reason, 산출의 for 처럼 그 문서를 왜 대는지. 없으면 null. */
  설명: string | null;
};

/**
 * 카드가 이름을 댄 문서를 출처별로 모은다.
 *
 * 출처를 지우고 합치지 않는다. 세 칸이 각자 자기 출처만 그리기 때문이고, 같은 문서가 근거이자
 * 무효 대상인 카드에서 그 두 자격은 서로 다른 사실이다.
 */
export function 카드문서들(item: WorkItem): 문서참조[] {
  const 모음: 문서참조[] = [];
  const 본것 = new Set<string>();
  const 넣기 = (docId: string, 출처: 문서출처, 설명: string | null) => {
    const 자리 = `${출처}:${docId}`;
    if (!docId || 본것.has(자리)) return;
    본것.add(자리);
    모음.push({ docId, 출처, 설명 });
  };

  for (const ref of item.trigger?.sourceDocRefs ?? []) 넣기(ref, "trigger", null);
  for (const p of item.produces) {
    if (p.into) 넣기(p.into, "produces", p.for ?? null);
  }
  for (const inv of item.invalidates) {
    넣기(inv.docId, "invalidates", [inv.scope, inv.reason].filter(Boolean).join(" — ") || null);
  }
  return 모음;
}

/**
 * 이 카드가 여는 평가서.
 *
 * 주석으로 "저쪽과 같은 식이어야 한다" 고 적어 두었지만 지켜지지 않았다 — 이쪽은
 * `produces.into` 를 안 봐서 **카드 19장이 대기열과 다른 문서를 열었다.** 규칙을
 * `lib/risk/doc-target.ts` 로 옮겨 같은 함수를 쓴다.
 */
export function 평가서문서(item: WorkItem): string | null {
  return 대상문서(item);
}

/* ------------------------------------------------------------------ *
 * 팩트 고르기
 * ------------------------------------------------------------------ */

/**
 * 문서 하나에 붙는 팩트를 고른다. **세 갈래로 맞춘다.**
 *
 * 서버의 docId 필터는 `key.startsWith(docId + "#")` 한 갈래뿐인데
 * (app/api/board/facts/route.ts:56), 시드 86건 가운데 35건은 key 에 `#` 이 없다. 그 필터만
 * 믿으면 `documentApprovalState` 같은 민짜 key 근거와 `sourceDocId` 로만 이어진 근거가
 * 통째로 빠지고, 화면은 "팩트가 없습니다" 라고 **거짓으로** 적는다.
 */
export function 팩트고르기(facts: SnapshotFact[], docId: string): SnapshotFact[] {
  return facts.filter(
    (f) => f.key === docId || f.key.startsWith(`${docId}#`) || f.sourceDocId === docId,
  );
}

/* ------------------------------------------------------------------ *
 * 팩트 한 줄
 * ------------------------------------------------------------------ */

export type 근거팩트 = {
  factType: FactType;
  /** 가공하지 않는다. 담당자가 원본 문서에서 그 행을 찾는 좌표다. */
  key: string;
  /** 값 조각을 ' · ' 로 이은 한 문장. */
  요약: string;
  /** 원본 값. 서랍이 <details> 안에서 통째로 편다. */
  값: unknown;
  observedAt: string;
  /** "08.19 07:05" */
  시각: string;
  /** 이행확인이 위조로 판정된 평가행. 목록 맨 위로 올린다. */
  불일치: boolean;
};

const 값없음 = "값이 비어 있습니다";

function 이어붙이기(조각: Array<string | null | undefined>): string {
  const 남은 = 조각.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  return 남은.length > 0 ? 남은.join(" · ") : 값없음;
}

function 자르기(text: string | null, 길이: number): string | null {
  if (!text) return null;
  return text.length <= 길이 ? text : `${text.slice(0, 길이)}…`;
}

function 이행문구(value: unknown): string | null {
  if (!asRecord(value)) return null;
  const 상태 = 이행상태읽기(value as 평가행);
  if (상태 === "확인") return "이행확인 확인";
  if (상태 === "불일치") return "이행확인 불일치(표시 있음 · 실제 미실행)";
  return "이행확인 비어 있음";
}

function 점수문구(머리: string, raw: unknown): string | null {
  const 점수 = readRiskScore(raw);
  return 점수 ? `${머리} ${위험도표시(점수)}` : null;
}

/**
 * 값을 사람이 읽는 한 줄로 옮긴다.
 *
 * 종류마다 갈라 쓰는 이유는 이 값들이 서로 전혀 다른 모양이기 때문이다. 공통 필드를 뽑아
 * 하나로 쓰면 어느 종류에서는 빈 줄이 나오고 어느 종류에서는 엉뚱한 필드가 나온다. 조립
 * 방식은 lib/detect/rules/t03-material.ts:302-328 의 excerpt 조립과 같다 —
 * 조각을 모아 빈 것을 걸러 ' · ' 로 잇는다.
 *
 * 조각이 하나도 안 잡히면 빈 문자열이 아니라 "값이 비어 있습니다" 를 돌려준다. 빈칸으로
 * 두면 값을 못 읽은 것인지 값이 없는 것인지 화면에서 구별할 수 없다.
 */
function 요약만들기(fact: SnapshotFact): string {
  const v = fact.value;
  const rec = asRecord(v);

  switch (fact.factType) {
    case "riskAssessmentRow":
      return 이어붙이기([
        readString(v, "행id"),
        readString(v, "공종분류"),
        readString(v, "단위작업"),
        readString(v, "위험요인"),
        점수문구("개선 전", rec?.["개선전"]),
        점수문구("개선 후", rec?.["개선후"]),
        이행문구(v),
      ]);

    case "riskRecommendation": {
      const 이격 = readNumber(v, "이격");
      const 재검토 = readBoolean(v, "reviewRequired");
      return 이어붙이기([
        readString(v, "단위작업"),
        점수문구("현재", rec?.["현재"]),
        점수문구("추천", rec?.["추천"]),
        이격 === null ? null : `이격 ${이격}`,
        재검토 === null ? null : 재검토 ? "재검토 필요" : "재검토 불필요",
        readString(v, "originState"),
      ]);
    }

    case "documentApprovalState": {
      const 제출 = readBoolean(v, "제출가능");
      return 이어붙이기([
        readString(v, "문서"),
        readString(v, "상태"),
        readString(v, "완료일"),
        제출 === null ? null : 제출 ? "제출 가능" : "제출 불가",
      ]);
    }

    case "documentExtraction": {
      const 인용 = readBoolean(v, "citable");
      return 이어붙이기([
        readString(v, "title"),
        readString(v, "kind"),
        readString(v, "author"),
        인용 === false ? "인용 불가" : null,
        자르기(readString(v, "excerpt"), 120),
      ]);
    }

    case "nearMissReport":
      return 이어붙이기([
        readString(v, "발생일시"),
        readString(v, "장소"),
        readString(v, "위험요인"),
        readString(v, "사고분류"),
        readString(v, "상태"),
        readString(v, "매칭행"),
      ]);

    case "officialNotice":
      return 이어붙이기([
        readString(v, "발신"),
        readString(v, "제목"),
        readString(v, "상태"),
        readString(v, "접수시각"),
      ]);

    default:
      // 위 여섯 말고는 애초에 읽어 오지 않지만, 종류가 늘었을 때 조용히 빈칸이 되지 않도록
      // 원시값은 그대로 적고 그 밖은 **센 값만** 적는다. 내용을 지어내지 않는다.
      return 값요약(v);
  }
}

/** 원시값은 그대로, 객체·배열은 크기만 적는다. 본문은 서랍이 <details> 로 편다. */
export function 값요약(value: unknown): string {
  if (value === null || value === undefined) return 값없음;
  if (typeof value === "string") return value.trim() === "" ? 값없음 : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `항목 ${value.length}개`;
  const rec = asRecord(value);
  if (rec) return `필드 ${Object.keys(rec).length}개`;
  return 값없음;
}

/** ISO 시각을 'MM.DD HH:mm' 로. view-model.ts:765 의 감지시각문구와 같은 모양이다. */
export function 시각문구(observedAt: string): string {
  const ms = Date.parse(observedAt);
  // 못 읽은 시각을 오늘로 채우지 않는다. 관측시각이 틀리면 근거 전체가 흔들린다.
  if (!Number.isFinite(ms)) return "관측시각을 읽지 못했습니다";
  const c = kstClock(ms);
  const 둘자리 = (n: number) => String(n).padStart(2, "0");
  return `${둘자리(c.월)}.${둘자리(c.일)} ${둘자리(c.시)}:${둘자리(c.분)}`;
}

export function 팩트한줄(fact: SnapshotFact): 근거팩트 {
  return {
    factType: fact.factType,
    key: fact.key,
    요약: 요약만들기(fact),
    값: fact.value,
    observedAt: fact.observedAt,
    시각: 시각문구(fact.observedAt),
    불일치:
      fact.factType === "riskAssessmentRow" &&
      asRecord(fact.value) !== null &&
      이행상태읽기(fact.value as 평가행) === "불일치",
  };
}

/**
 * 불일치 → 그 밖 순, 그 안에서 key 오름차순.
 *
 * risk-doc-panel.tsx:106-112 와 같은 순서다. 비어 있는 행은 아직 안 한 일이지만 불일치는
 * 이미 했다고 적어 놓은 거짓말이라 먼저 봐야 한다.
 */
export function 팩트정렬(facts: 근거팩트[]): 근거팩트[] {
  return [...facts].sort((a, b) => {
    if (a.불일치 !== b.불일치) return a.불일치 ? -1 : 1;
    return a.key.localeCompare(b.key, "en", { numeric: true });
  });
}

/** 문서 하나에 붙는 근거 팩트를 골라 한 줄씩으로 옮기고 세워 둔다. */
export function 문서근거(facts: SnapshotFact[], docId: string): 근거팩트[] {
  return 팩트정렬(팩트고르기(facts, docId).map(팩트한줄));
}
