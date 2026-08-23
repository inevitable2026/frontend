"use client";

import { 급함색, 기한문구, 종류라벨 } from "@/components/risk/derive";
import { useState } from "react";

import type { DraftForm, WorkItem } from "@/lib/board/types";

/**
 * 조치 대기열 — 이 탭의 첫 화면.
 *
 * 현장이 열둘인 회사에서 "현장 목록"을 먼저 보여주면 무엇부터 손대야 하는지를
 * 사람이 판단해야 한다. 그래서 목록이 아니라 **순서**를 보여준다.
 *
 * **감지는 여기서 하지 않는다.** 태스크 보드가 이미 규칙 여덟 개로 조건을 찾아
 * `WorkItem` 으로 만들어 두었다(`lib/detect/engine.ts`). 이 화면은 그중 위험성평가에
 * 해당하는 것만 골라 다시 그린다 — 출처가 하나여야 두 화면이 서로 다른 말을 하지 않는다.
 *
 * **시각 언어도 보드 것을 그대로 쓴다.** 같은 데이터를 보여주면서 생김새가 다르면
 * 사용자는 두 개를 따로 배워야 한다. `board-card*` 클래스와 `카드로()` 어댑터를 재사용하고,
 * 여기서만 필요한 것(묶음 머리)만 `risk-queue-*` 로 새로 둔다.
 */

export type 현장 = { id: string; code: string; name: string };

/** 위험성평가와 상관있는 카드만. 회의록(=위험성평가 회의록)을 만들거나 이미 가진 것. */
export function 위험성평가카드인가(item: WorkItem): boolean {
  if (item.draft?.form === "회의록") return true;
  return item.produces.some((p) => p.form === "회의록");
}

/**
 * 저장된 서식 값을 화면 이름으로 바꾼다. 값 자체는 서버와 맞물려 있어 그대로 둔다.
 * 모르는 값이면 이름을 지어내지 않고 `null` 을 준다.
 */
const 서식이름표: Record<DraftForm, string> = {
  회의록: "회의록",
  공문: "공문",
  회의자료: "회의 자료",
  TBM자료: "작업 전 안전점검 자료",
  점검표: "점검표",
  기록: "기록",
};

export function 서식이름(form: string): string | null {
  return 서식이름표[form as DraftForm] ?? null;
}

/**
 * 앞말 받침에 따라 조사를 고른다.
 *
 * `이(가)` 같은 괄호 표기가 화면에 그대로 나가면 사람이 읽다 걸린다.
 * 한글 음절이 아니면 판단할 수 없으므로 받침 있는 쪽을 쓴다.
 */
function 조사(앞말: string, 받침있음: string, 받침없음: string): string {
  const 끝 = 앞말.trim().slice(-1);
  const 코드 = 끝.charCodeAt(0);
  if (Number.isNaN(코드) || 코드 < 0xac00 || 코드 > 0xd7a3) return 받침있음;
  return (코드 - 0xac00) % 28 === 0 ? 받침없음 : 받침있음;
}

type 묶음 = "재평가" | "작성중" | "최신";

/**
 * 카드를 세 줄로 가른다.
 * - 재평가: 무효화가 걸린 것. 기존 평가가 더 이상 사실이 아니게 된 경우다.
 * - 작성중: 초안이 붙었고 아직 승인 전.
 * - 최신: 나머지.
 */
/**
 * 재평가가 필요한 건수. 사이드바 배지가 이 값을 쓴다.
 *
 * **세어서 쓴다.** 태스크 보드의 배지 11 은 상수로 박혀 있는데(`construction-console.tsx:27`),
 * 그 숫자가 실제와 어긋나면 배지가 거짓말이 된다. 여기서는 대기열이 실제로 고른 것을 센다.
 */
export function 재평가건수(항목들: WorkItem[]): number {
  return 항목들.filter((i) => 위험성평가카드인가(i) && 묶음판정(i) === "재평가").length;
}

/**
 * 카드가 어느 열로 가는가.
 *
 * **끝난 카드가 먼저다.** 예전에는 `invalidates.length > 0` 만 보고 `status` 를 무시해서,
 * 확정된 카드가 영원히 "재평가 필요"에 남았다 — `invalidates` 는 카드가 왜 올라왔는지를
 * 적어 둔 것이라 카드를 끝내도 사라지지 않기 때문이다. 실제로 production 카드 37장 중
 * 8장이 `done` 인데 그중 넷이 이 열에 앉아 있었고, 사람이 보기엔 아무리 처리해도 목록이
 * 안 줄어드는 것과 같았다.
 *
 * `confirmedAt` 도 함께 본다. 잠금의 기준이 그것이기 때문이다
 * (`lib/board/transition.ts:185`).
 */
function 묶음판정(item: WorkItem): 묶음 {
  if (item.status === "done" || item.confirmedAt !== null) return "최신";
  if (item.invalidates.length > 0) return "재평가";
  if (item.draft) return "작성중";
  return "최신";
}


/**
 * 「지금 감지」 — 규칙 여덟 개를 실제로 돌린다.
 *
 * **누르기 전에 무슨 일이 일어나는지 먼저 말한다.** `scripts/seed-board.mjs:40-43` 이
 * 명시적으로 경고한다 — *"이 현장에 POST /api/board/detect 를 부르면 안 된다. 부르는
 * 순간 카드가 31장이 된다."* 시드로 준비한 시나리오 위에 생성 카드가 얹히기 때문이다.
 * 데모 직전에 무심코 누르면 준비한 목록이 달라진다.
 *
 * 그래서 한 번 누르면 경고를 보이고, 한 번 더 눌러야 돈다.
 *
 * 이름만 영문이다 — `react-hooks/rules-of-hooks` 가 컴포넌트를 대문자로 시작하는 이름으로
 * 알아본다. 이 파일의 `RiskQueue`·`RowCard` 와 같은 관례다.
 *
 * **반복은 안전하다.** `itemId` 가 (현장·규칙·근거서명)으로 결정적이라 같은 조건을 두 번
 * 감지해도 저장소가 같은 행을 덮는다(`app/api/board/detect/route.ts:107` 주석).
 * 카드가 두 장 생기지 않는 근거가 거기 있다.
 */
function DetectBar({
  위험카드수,
  감지,
}: {
  위험카드수: number;
  감지: () => Promise<{ 감지: number; 생성: number } | string>;
}) {
  const [단계, set단계] = useState<"쉼" | "확인" | "도는중">("쉼");
  const [결과, set결과] = useState<string | null>(null);

  async function 돌리기() {
    set단계("도는중");
    set결과(null);
    const r = await 감지();
    if (typeof r === "string") {
      // 문자열이면 실패 사유다. 숫자를 지어내지 않는다.
      // 원인은 화면 문장이 아니라 여기로 내린다.
      console.error("[risk-queue] detect failed:", r);
      set결과("점검을 끝내지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    } else {
      set결과(`해당하는 상황 ${r.감지}건을 찾아 할 일 ${r.생성}건을 만들었습니다.`);
    }
    set단계("쉼");
  }

  return (
    <div className="risk-detect">
      <div className="risk-detect-bar">
        <span>지금 보이는 위험성평가 할 일 {위험카드수}건은 이미 점검해서 찾아 둔 것입니다.</span>
        {단계 === "확인" ? (
          <>
            <button type="button" className="is-danger" onClick={() => void 돌리기()}>
              점검 실행
            </button>
            <button type="button" onClick={() => set단계("쉼")}>
              취소
            </button>
          </>
        ) : (
          <button type="button" disabled={단계 === "도는중"} onClick={() => set단계("확인")}>
            {단계 === "도는중" ? "점검하는 중입니다…" : "지금 다시 점검"}
          </button>
        )}
      </div>

      {단계 === "확인" ? (
        <p className="risk-detect-warn">
          지금 시점을 기준으로 현장 전체를 다시 점검합니다. 해당하는 할 일이 <b>새로
          올라와 지금 목록이 달라집니다.</b> 같은 상황을 다시 점검해도 할 일이 늘지는
          않습니다.
        </p>
      ) : null}

      {결과 ? <p className="risk-detect-result">{결과}</p> : null}
    </div>
  );
}

const 묶음표시: Record<묶음, { 기호: string; 라벨: string }> = {
  재평가: { 기호: "▲", 라벨: "재평가 필요" },
  작성중: { 기호: "●", 라벨: "평가서 작성 중" },
  최신: { 기호: "■", 라벨: "최신 평가" },
};

const 순서: 묶음[] = ["재평가", "작성중", "최신"];

export default function RiskQueue({
  항목들,
  현장이름,
  선택,
  불러오는중,
  감지,
  기준시각,
  주목카드 = null,
}: {
  항목들: WorkItem[];
  /** siteId → 현장 이름. 이름이 없으면 저장소 키 대신 「현장 이름 없음」 을 보인다. */
  현장이름: Map<string, string>;
  선택: (item: WorkItem) => void;
  불러오는중: boolean;
  /** 감지를 돌린다. 안 넘기면 버튼이 안 뜬다. */
  감지?: () => Promise<{ 감지: number; 생성: number } | string>;
  /**
   * 기한 판정("16:30 지남")의 기준. **부모가 넘긴다.**
   * 렌더 중에 `Date.now()` 를 부르면 리렌더마다 판정이 달라져 화면이 스스로 흔들린다
   * (`react-hooks/purity` 가 잡아 준다). 시각은 렌더의 입력이지 렌더가 만드는 것이 아니다.
   */
  기준시각: number;
  /**
   * 다른 화면에서 넘어오며 가리킨 카드.
   *
   * 보드에서 「위험성평가 기록으로 이동」을 누르면 그 건이 주소에 실려 온다. 목록이 길면
   * 넘어온 사람이 방금 처리한 건을 다시 찾아야 하므로, 그 묶음 안에서 맨 앞으로 올리고
   * 테두리로 표시한다. 서랍이 함께 열리므로 **닫았을 때** 이 표시가 보인다.
   */
  주목카드?: string | null;
}) {
  const 위험카드 = 항목들.filter(위험성평가카드인가);

  const 묶인것 = new Map<묶음, WorkItem[]>(순서.map((g) => [g, []]));
  for (const item of 위험카드) 묶인것.get(묶음판정(item))!.push(item);

  // 주목 카드를 **자기 묶음 안에서만** 맨 앞으로 올린다. 묶음을 바꾸지는 않는다 —
  // 처리된 카드를 「재평가 필요」로 끌어올리면 화면이 상태를 잘못 말하게 된다.
  if (주목카드) {
    for (const 목록 of 묶인것.values()) {
      const 자리 = 목록.findIndex((item) => item.itemId === 주목카드);
      if (자리 > 0) 목록.unshift(...목록.splice(자리, 1));
    }
  }

  if (불러오는중) return <p className="risk-queue-empty">할 일 목록을 불러오는 중입니다…</p>;

  if (위험카드.length === 0) {
    return (
      <p className="risk-queue-empty">
        지금 손봐야 할 위험성평가가 없습니다. 문서를 올리면 바뀐 것이 여기에 뜹니다.
      </p>
    );
  }

  const 제목찾기 = new Map(항목들.map((i) => [i.itemId, i.title]));

  return (
    <div className="risk-queue">
      {감지 ? <DetectBar 위험카드수={위험카드.length} 감지={감지} /> : null}
      {순서.map((묶음이름) => {
        const 목록 = 묶인것.get(묶음이름)!;
        if (목록.length === 0) return null;
        const { 기호, 라벨 } = 묶음표시[묶음이름];

        return (
          <section className={`risk-queue-group is-${묶음이름}`} key={묶음이름}>
            <h3>
              <span aria-hidden="true">{기호}</span>
              {라벨}
              <em>{목록.length}</em>
            </h3>

            <ul>
              {목록.map((item) => {
                const 기한 = 기한문구(item.dueBy, 기준시각);

                // 앞선 할 일의 제목만 쓴다. 제목을 못 찾은 것은 건수로만 센다 —
                // 저장소 식별자를 화면에 내보내지 않기 위해서다.
                const 앞선제목 = item.blockedBy
                  .map((id) => 제목찾기.get(id))
                  .filter((t): t is string => Boolean(t));
                const 제목못찾음 = item.blockedBy.length - 앞선제목.length;

                return (
                  <li key={item.itemId}>
                    {/* 보드 카드와 같은 뼈대. 다른 점은 이것이 통째로 누를 수 있는 버튼이라는 것뿐이다. */}
                    <button
                      type="button"
                      className={`board-card risk-queue-card ${급함색(item)}${item.itemId === 주목카드 ? " is-주목" : ""}`}
                      onClick={() => 선택(item)}
                    >
                      <span className="board-card-top">
                        <span className="board-card-kind is-doc">
                          {서식이름(종류라벨(item)) ?? "할 일"}
                        </span>
                        {item.origin === "machine" ? (
                          <span className="board-card-ai-mark">
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 3v3" />
                              <path d="M12 18v3" />
                              <path d="M3 12h3" />
                              <path d="M18 12h3" />
                            </svg>
                            자동 생성
                          </span>
                        ) : null}
                        <span
                          className="risk-queue-site"
                          title={현장이름.has(item.siteId) ? undefined : `현장 키: ${item.siteId}`}
                        >
                          {현장이름.get(item.siteId) ?? "현장 이름 없음"}
                        </span>
                      </span>

                      <span className="board-card-title">{item.title}</span>
                      {item.summary === null ? null : (
                        <span className="board-card-note">{item.summary}</span>
                      )}

                      <span className="board-card-meta">
                        {item.invalidates.length > 0 ? (
                          <span className="board-tag is-alert">
                            전제 바뀜 {item.invalidates.length}건
                          </span>
                        ) : null}
                        {item.produces.slice(1).map((p) => {
                          const 이름 = 서식이름(p.form);
                          if (이름 === null) return null;
                          return (
                            <span key={p.form} className="board-tag is-doc">
                              {이름}
                            </span>
                          );
                        })}
                      </span>

                      {/* 왜 이 카드가 여기 있는지. 규칙이 만든 문구를 그대로 쓴다.
                          규칙 코드는 문장이 아니라 마우스를 올렸을 때만 보인다. */}
                      {item.trigger === null ? null : (
                        <span className="board-card-why" title={`규칙 코드: ${item.trigger.ruleId}`}>
                          {item.trigger.condition}
                        </span>
                      )}

                      {앞선제목.length > 0 ? (
                        <span className="board-card-blocked">
                          {앞선제목.map((t) => `「${t}」`).join(" · ")}
                          {제목못찾음 > 0 ? ` 외 ${제목못찾음}건` : ""}
                          {제목못찾음 > 0 ? "이" : 조사(앞선제목[앞선제목.length - 1], "이", "가")} 먼저
                          확정돼야 합니다
                        </span>
                      ) : item.blockedBy.length > 0 ? (
                        <span className="board-card-blocked">
                          먼저 확정돼야 할 할 일이 {item.blockedBy.length}건 있습니다
                        </span>
                      ) : null}

                      {기한.글 === null ? null : (
                        <span className="board-card-foot">
                          <span className={`board-card-when${기한.급함 ? " is-hot" : ""}`}>{기한.글}</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
