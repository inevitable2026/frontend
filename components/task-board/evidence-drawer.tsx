"use client";

// 칸반 카드의 증거 서랍.
//
// 카드가 주장하는 문장마다 그 근거가 되는 **팩트 한 줄**을 같은 화면에 붙인다. 사슬의 끝은
// 팩트다 — 문서함이나 메일 원문으로 나가는 링크를 만들지 않는다(명세 Constraints 1).
//
// ## 왜 item(WorkItem) 과 card(TaskCard) 를 둘 다 받는가
//
// TaskCard 만으로는 세 칸 중 두 칸이 빈다. `카드옮기기()` 는 `produces` 를 **항상 빈
// 배열로** 넣고("만든 것 줄은 브리핑의 조건이 소유한다", view-model.ts:712-713),
// `trigger.condition`(발동 조건 한 문장)은 ConditionSlug 로 뭉개져 사라지며,
// `초안옮기기()` 는 점검표·기록 서식에 null 을 돌려주고 회의록 2행 이후를 버린다. 무엇보다
// `RiskDocPanel` 의 첫 prop 이 `item: WorkItem` 이다(risk-doc-panel.tsx:32-42).
//
// 그렇다고 card 를 버리지 않는 이유는 반대쪽에 있다. 색띠·유형 배지·기한 문구는 view-model
// 이 정한 판단이고(그 판단을 한 자리에 모은 것이 그 파일의 존재 이유다), 승인·기각의 낙관적
// 갱신이 반영된 최신 status 를 들고 있는 것도 cards 상태 쪽이다. 서랍이 `item.status` 를
// 읽으면 승인 직후 한 박자 옛 값을 보여 준다.
//
// ## 끼워 넣은 평가서 (AC-11)
//
// `RiskDocPanel` 을 복제하지 않고 그대로 끼운다. 겉모습(fixed 위치 · scrim · 그림자)은
// `.board-evidence-doc` 스코프 재정의로 벗기는데(같은 수법의 선례: globals.css:6214),
// **중첩된 `aria-modal="true"` 는 CSS 로 못 벗긴다** — 스크린리더가 안쪽을 모달 경계로 잡는
// 순간 첫째·둘째 칸이 읽히지 않아 AC-2 가 깨진다. 그래서 마운트된 노드에서 직접 벗긴다.
// 정공법은 그 컴포넌트에 `끼움?: boolean` prop 을 더하는 것이지만, 그것은 기존 호출처
// (risk-assessment-panel.tsx:558-565)를 함께 봐야 하는 변경이라 이 단계에서 하지 않는다.
//
// 평가서는 **사람이 펼칠 때 마운트한다.** 그 컴포넌트는 마운트하자마자 자기에게 포커스를
// 끌어가므로(risk-doc-panel.tsx:92-99), 서랍이 열리는 순간 함께 마운트하면 초점이 세 번째
// 칸으로 튀어 AC-6 의 초점 계약이 깨진다. 지연 마운트는 그 초점 이동을 사람의 열람 의도와
// 일치시키고, 카드마다 평가서를 미리 읽는 요청도 없앤다.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { JsonViewer } from "@/components/json-viewer";
import RiskDocPanel from "@/components/risk/risk-doc-panel";
import type { Draft, SnapshotFact, WorkItem } from "@/lib/board/types";

import { CardAssessDraft } from "./card-assess-draft";
import {
  QUEUE_APPROVE_IRREVERSIBLE,
  QUEUE_DONE_TITLE,
  QUEUE_UNDO_NOTE,
  자취문구,
  type 처리자취,
} from "./card-queue";
import { useCardFacts } from "./evidence-data";
import { 문서근거, 카드문서들, 평가서문서, type 근거팩트, type 문서참조 } from "./evidence";
import {
  EVIDENCE_DOC_WITHOUT_INVALIDATION,
  EVIDENCE_DRAFT_ROWS_ELSEWHERE,
  EVIDENCE_FACTS_FAILED,
  EVIDENCE_FACTS_LOADING,
  EVIDENCE_NO_DRAFT,
  EVIDENCE_NO_FACTS,
  EVIDENCE_NO_FACTS_YET,
  EVIDENCE_NO_INVALIDATES,
  EVIDENCE_NO_PRODUCES,
  EVIDENCE_NO_SOURCE_DOCS,
  EVIDENCE_NO_TRIGGER,
  EVIDENCE_ROWS_IN_DOC_PANEL,
} from "./evidence-copy";
import { BOARD_COLUMNS, FACT_TYPE_LABEL } from "./presentation";
import { useReference } from "./reference-chip";
import type { TaskCard } from "./types";
import { ruleLabel } from "@/lib/board/briefing";
import { 문서이름, 문서키툴팁, 문서표시 } from "@/lib/risk/doc-label";

/** 팩트가 이보다 많이 붙은 문서는 접는다. 감추지 않고 summary 에 총건수를 적는다. */
const 접는건수 = 20;

/** 카드가 어느 자격으로 올라왔는지. `timing` 은 서버 어휘라 화면 말로 옮긴다. */
const TIMING_LABEL: Record<WorkItem["timing"], string> = {
  daily: "매일 하는 일",
  schedule: "일정에서 도래",
  trigger: "조건 감지",
};

const 출처_LABEL: Record<문서참조["출처"], string> = {
  trigger: "근거 문서",
  produces: "만들 문서",
  invalidates: "무효 대상",
};

/**
 * 서랍이 카드를 처분하고 다음 장으로 넘어가는 손잡이 (AC-13 ~ AC-16).
 *
 * 서랍은 상태를 소유하지 않는다. 승인·기각·이동은 전부 TaskBoard 의 세 핸들러를 지나야
 * 낙관적 갱신과 되돌리기가 한 자리에 남기 때문이다(task-board.tsx 의 assistantBridge 주석과
 * 같은 규칙). 여기서는 무엇을 그릴지만 받는다.
 */
export type 서랍큐 = {
  /** 서랍을 연 순간 고정한 열의 이름. "승인" */
  열이름: string;
  /**
   * 저장이 끝날 때까지 승인·기각·다음을 잠근다.
   *
   * 낙관적으로 먼저 전진하지 않는 이유: 빠르게 누르면 실패가 돌아올 즈음 이미 두세 장
   * 앞이고, 서랍을 뒤로 끌어당기는 편이 잠깐 기다리는 것보다 사납다. 잠금은 이중 제출도
   * 막는다 — 같은 카드에 승인이 두 번 나가면 두 번째는 409 다.
   */
  저장중: boolean;
  /** 저장이 엎어졌을 때 서버가 쓴 문장. 서랍 안에 그대로 적는다. */
  오류: string | null;
  다음있음: boolean;
  /**
   * 「다시 보기」로 지나온 카드를 겹쳐 보고 있다.
   *
   * 그동안 큐는 제자리에 서 있으므로 「다음」은 전진이 아니라 그 자리로 돌아가는 길이다.
   * 글자를 바꾸지 않으면 단추가 하는 일과 적힌 말이 갈린다.
   */
  되짚는중: boolean;
  자취: 처리자취[];
  /** 큐가 끝났을 때의 요약 문장들. 끝나지 않았으면 null (AC-16). */
  종료: string[] | null;
  onApprove: () => void;
  onReject: () => void;
  onNext: () => void;
  onUndo: (자취: 처리자취) => void;
  onRevisit: (itemId: string) => void;
};

export function EvidenceDrawer({
  item,
  card,
  siteName,
  onClose,
  큐,
}: {
  /** 정본. RiskDocPanel 이 요구하고 view-model 이 버린 값들이 여기 있다. */
  item: WorkItem;
  /** 화면 어휘(유형 배지 · 기한 문구 · 이유 한 줄)와 낙관적 갱신이 반영된 최신 status. */
  card: TaskCard;
  /** snapshot.site.name. RiskDocPanel 의 현장이름 으로 그대로 흘러간다. */
  siteName: string;
  onClose: () => void;
  큐: 서랍큐;
}): JSX.Element {
  const 제목id = useId();
  const 서랍 = useRef<HTMLElement>(null);
  const 승인단추 = useRef<HTMLButtonElement>(null);
  const 팩트 = useCardFacts(item.siteId);

  const 문서들 = 카드문서들(item);
  const 평가서 = 평가서문서(item);
  const 열이름 = BOARD_COLUMNS.find((c) => c.id === card.status)?.label ?? card.status;

  // 닫을 때 초점이 돌아갈 자리. 큐가 카드를 넘겨 가므로 **지금** 보고 있는 카드로 갱신한다.
  const 복귀 = useRef({ itemId: card.itemId, columnId: card.status });
  useEffect(() => {
    복귀.current = { itemId: card.itemId, columnId: card.status };
  }, [card.itemId, card.status]);

  // AC-6. 열 때 초점을 붙들어 두었다가 닫을 때 그 자리로 되돌린다.
  //
  // focusedCardId 에 기대면 안 된다 — TaskCardView 의 복귀 효과는 isFocused 가 **바뀔 때만**
  // 돌고 이미 true 면 되돌아 나간다(task-card.tsx 의 효과). 서랍을 닫아 초점이 body 로
  // 떨어져도 그 값은 그대로라 효과가 다시 돌지 않는다.
  //
  // 붙들어 둔 요소가 사라져 있을 수 있다(큐가 승인한 카드는 완료 열로 가고, 날짜 필터에
  // 걸리면 아예 안 그려진다). 그때는 지금 보고 있던 카드로, 그것도 없으면 그 열의 몸통으로
  // 떨어뜨린다. 아무 데도 못 내리면 초점이 body 로 떨어져 키보드 사용자가 길을 잃는다.
  useEffect(() => {
    const 돌아갈곳 = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    서랍.current?.focus();
    return () => {
      if (돌아갈곳 !== null && document.contains(돌아갈곳)) {
        돌아갈곳.focus();
        return;
      }
      const { itemId, columnId } = 복귀.current;
      const 카드 = document.querySelector<HTMLElement>(
        `.board-kanban .board-card[data-item-id="${CSS.escape(itemId)}"]`,
      );
      if (카드 !== null) {
        카드.focus();
        return;
      }
      document
        .querySelector<HTMLElement>(`.board-column-body[data-column-id="${CSS.escape(columnId)}"]`)
        ?.focus();
    };
  }, []);

  // 큐가 다음 카드로 넘어가면 초점을 승인 단추로 옮기고 서랍을 맨 위로 되감는다.
  // "21장을 손 떼지 않고" (AC-14) 가 그 요구다. 첫 카드는 위 효과가 서랍 자체에 초점을
  // 주므로 여기서 건드리지 않는다 — 열자마자 초점이 단추에 있으면 사람이 근거를 읽기 전에
  // Enter 를 누를 자세가 된다.
  const 앞카드 = useRef(card.itemId);
  useEffect(() => {
    if (앞카드.current === card.itemId) return;
    앞카드.current = card.itemId;
    서랍.current?.scrollTo({ top: 0 });
    // 선행이 걸린 카드는 승인 단추가 잠겨 있다. 잠긴 단추에 focus() 는 아무 일도 하지 않아
    // 초점이 body 로 떨어지므로, 그때는 서랍 자체를 받는다.
    const 단추 = 승인단추.current;
    (단추 !== null && !단추.disabled ? 단추 : 서랍.current)?.focus();
  }, [card.itemId]);

  return (
    <>
      <div className="board-evidence-scrim" onClick={onClose} aria-hidden="true" />

      <aside
        className="board-evidence"
        ref={서랍}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={제목id}
      >
        <header className="board-evidence-head">
          <div>
            <p className="board-evidence-eyebrow">
              {siteName}
              <b>{card.kind.label}</b>
              <span>{열이름} 열</span>
            </p>
            <h2 id={제목id}>{item.title}</h2>
            {card.dueLabel ? (
              <p className={`board-evidence-due${card.dueIsHot ? " is-hot" : ""}`}>{card.dueLabel}</p>
            ) : null}
          </div>
          <button type="button" className="board-evidence-close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>

        {/* 팩트를 못 읽었으면 못 읽었다고 적는다. 빈 목록으로 접으면 화면이 "근거가 없다" 고
            거짓으로 단언한다. 종류마다 사유가 다르므로 종류별로 한 줄씩 적는다. */}
        {팩트.실패들.length > 0 ? (
          <ul className="board-evidence-error" role="alert">
            {팩트.실패들.map((f) => (
              <li key={f.factType}>
                {EVIDENCE_FACTS_FAILED} ({FACT_TYPE_LABEL[f.factType] ?? f.factType}) — {f.사유}
              </li>
            ))}
          </ul>
        ) : null}

        <WhySlot item={item} card={card} 문서들={문서들} 팩트들={팩트.전체} 읽는중={팩트.읽는중} 평가서={평가서} />

        <MakesSlot
          item={item}
          문서들={문서들}
          팩트들={팩트.전체}
          읽는중={팩트.읽는중}
          평가서={평가서}
          siteName={siteName}
        />

        <InvalidatesSlot
          item={item}
          문서들={문서들}
          팩트들={팩트.전체}
          읽는중={팩트.읽는중}
          평가서={평가서}
          siteName={siteName}
        />

        <QueueBar card={card} 큐={큐} onClose={onClose} 승인단추={승인단추} />
      </aside>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 큐 — 처분하고 다음 장으로 (AC-13 ~ AC-16)
 * ------------------------------------------------------------------ */

function QueueBar({
  card,
  큐,
  onClose,
  승인단추,
}: {
  card: TaskCard;
  큐: 서랍큐;
  onClose: () => void;
  승인단추: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  // 승인·기각을 그리는 조건은 카드 위의 그것과 **글자 그대로 같다**(task-card.tsx 의 같은
  // 판정). 서랍에서 넓히면 Todo 카드를 승인 열을 거치지 않고 확정할 수 있게 되어 저쪽이
  // 막아 둔 것을 되살리고, 사람이 올린 카드의 기각 사유는 서버가 이력에 남기지 않는다.
  const 처분가능 = card.status === "approval" && card.draft !== null;
  const 기각가능 = 처분가능 && card.origin === "machine";
  const 막힘 = card.blockedBy.length > 0;
  const 막힌이유 = 막힘
    ? `${card.blockedBy.map((ref) => `「${ref.title}」`).join(" · ")}이 승인되어야 확정됩니다`
    : null;

  /**
   * Enter 를 누르고 있으면 브라우저가 같은 키를 되풀이해 보낸다. 저장 잠금이 풀리는
   * 순간 그 되풀이가 다음 카드를 승인해 버리므로 여기서 막는다. 매직 밀리초 대신
   * `repeat` 을 보는 이유는 그것이 브라우저가 이미 알려 주는 사실이기 때문이다.
   */
  function 연타막기(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
  }

  return (
    <section className="board-evidence-queue">
      {큐.종료 === null ? null : (
        <div className="board-evidence-queue-done" role="status">
          <b>{QUEUE_DONE_TITLE}</b>
          {큐.종료.map((줄) => (
            <p key={줄}>{줄}</p>
          ))}
        </div>
      )}

      {큐.자취.length === 0 ? null : (
        <ul className="board-evidence-trail">
          {큐.자취.map((자취) => (
            <li key={`${자취.itemId}:${자취.종류}`}>
              <span>{자취문구(자취)}</span>
              {자취.종류 === "기각" ? (
                <button
                  type="button"
                  className="board-evidence-trail-undo"
                  title={QUEUE_UNDO_NOTE}
                  disabled={큐.저장중}
                  onClick={() => 큐.onUndo(자취)}
                >
                  되돌리기
                </button>
              ) : (
                <>
                  {/* 승인에는 단추를 그리지 않는다. 서버가 확정 카드의 모든 전이를 409 로
                      막으므로 언제나 실패하는 단추가 된다. 오조작을 알아채는 길은
                      「다시 보기」로 연다 — 열람은 언제나 가능하다. */}
                  <span className="board-evidence-trail-note">{QUEUE_APPROVE_IRREVERSIBLE}</span>
                  <button
                    type="button"
                    className="board-evidence-trail-undo"
                    onClick={() => 큐.onRevisit(자취.itemId)}
                  >
                    다시 보기
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {큐.오류 === null ? null : (
        <p className="board-evidence-queue-error" role="alert">
          {큐.오류}
        </p>
      )}

      <div className="board-evidence-queue-acts">
        {처분가능 ? (
          <button
            ref={승인단추}
            type="button"
            className="board-button-approve"
            disabled={막힘 || 큐.저장중}
            title={막힌이유 ?? undefined}
            onKeyDown={연타막기}
            onClick={큐.onApprove}
          >
            {큐.저장중 ? "저장 중…" : "승인"}
          </button>
        ) : null}

        {기각가능 ? (
          <button
            type="button"
            className="board-button-reject"
            disabled={큐.저장중}
            onKeyDown={연타막기}
            onClick={큐.onReject}
          >
            기각
          </button>
        ) : null}

        {/* 「다음」은 모든 열에서 그린다. Todo·완료 열에서 연 서랍에서 다음 카드로 못
            넘어가면 근거를 훑는 일에 서랍을 쓸 수 없다. 선행이 걸린 카드도 건너뛰지 않는다 —
            건너뛰면 그런 카드가 있다는 사실 자체가 화면에서 사라진다.

            되짚어 보는 중에는 같은 단추가 큐 자리로 돌아가는 길이 된다. 나가는 문을 따로
            그리지 않은 이유는 그 자리가 「앞으로 가는 손잡이」 하나여야 손이 헤매지 않기
            때문이고, 되짚기는 그 앞으로가 잠시 뒤를 향한 상태이기 때문이다. */}
        <button
          type="button"
          className="board-evidence-queue-next"
          disabled={(!큐.되짚는중 && !큐.다음있음) || 큐.저장중}
          onClick={큐.onNext}
        >
          {큐.되짚는중
            ? `${큐.열이름} 열의 큐로 돌아가기`
            : 큐.다음있음
              ? `${큐.열이름} 열의 다음 카드`
              : `${큐.열이름} 열에 다음 카드가 없습니다`}
        </button>

        <button type="button" className="board-evidence-queue-close" onClick={onClose}>
          닫기
        </button>
      </div>

      {막힌이유 === null ? null : <p className="board-evidence-queue-hint">{막힌이유}</p>}

      {처분가능 ? null : (
        <p className="board-evidence-queue-hint">
          승인·기각은 「승인」 열에 선 초안에만 그립니다. 이 카드는 열람만 할 수 있습니다.
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 칸 1 — 왜 생겼나
 * ------------------------------------------------------------------ */

function WhySlot({
  item,
  card,
  문서들,
  팩트들,
  읽는중,
  평가서,
}: {
  item: WorkItem;
  card: TaskCard;
  문서들: 문서참조[];
  팩트들: SnapshotFact[];
  읽는중: boolean;
  평가서: string | null;
}): JSX.Element {
  const 근거문서 = 문서들.filter((d) => d.출처 === "trigger");

  return (
    <section className="board-evidence-slot">
      <h3>왜 생겼나</h3>

      {item.trigger === null ? (
        <p className="board-evidence-empty">{EVIDENCE_NO_TRIGGER[item.timing]}</p>
      ) : (
        <>
          <p className="board-evidence-claim">
            {/*
              * 규칙 번호(`T-03` · `S-02`)는 감지 엔진의 어휘다. 현직자에게 `T-03` 은 아무
              * 뜻이 없으므로 이름을 적고 번호는 `title` 로 남긴다 — 문의·대조에는 번호가 필요하다.
              *
              * `CONDITION_BY_RULE` 이 아니라 `lib/board/briefing.ts` 의 `ruleLabel` 을 쓴다.
              * 앞의 것은 T-01~T-08 만 아는 조건 슬러그 표이고, 뒤의 것만 `S-` 규칙까지 안다.
              * S-02 는 규칙 파일이 없지만 조건문이 스스로 "관리기간 중간 점검 주기가
              * 도래했고…" 라고 적으므로 「주기 도래」가 맞다.
              */}
            <b className="board-evidence-rule" title={`감지 규칙 ${item.trigger.ruleId}`}>
              {ruleLabel(item.trigger.ruleId)}
            </b>
            <span className="board-evidence-timing">{TIMING_LABEL[item.timing]}</span>
            {item.trigger.condition}
          </p>
          <p className="board-evidence-meta">
            신뢰도 {Math.round(item.trigger.confidence * 100)}%
            {item.trigger.requiresHumanConfirmation
              ? " · 사람 확인이 필요하다고 표시된 카드입니다"
              : " · 사람 확인 표시는 없습니다"}
          </p>
          {card.rationale ? <p className="board-evidence-meta">{card.rationale.text}</p> : null}
        </>
      )}

      {근거문서.length === 0 ? (
        item.trigger === null ? null : (
          <p className="board-evidence-empty">{EVIDENCE_NO_SOURCE_DOCS}</p>
        )
      ) : (
        근거문서.map((문서) => (
          <DocFacts
            key={`trigger:${문서.docId}`}
            문서={문서}
            팩트들={팩트들}
            읽는중={읽는중}
            평가서에서편다={문서.docId === 평가서}
          />
        ))
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 칸 2 — 무엇을 만드나
 * ------------------------------------------------------------------ */

function MakesSlot({
  item,
  문서들,
  팩트들,
  읽는중,
  평가서,
  siteName,
}: {
  item: WorkItem;
  문서들: 문서참조[];
  팩트들: SnapshotFact[];
  읽는중: boolean;
  평가서: string | null;
  siteName: string;
}): JSX.Element {
  const 만들문서 = 문서들.filter((d) => d.출처 === "produces");

  return (
    <section className="board-evidence-slot">
      <h3>무엇을 만드나</h3>

      {item.produces.length === 0 && item.draft === null ? (
        <p className="board-evidence-empty">{EVIDENCE_NO_PRODUCES}</p>
      ) : null}

      {item.produces.length > 0 ? (
        <ul className="board-evidence-produces">
          {item.produces.map((p, i) => (
            <li key={`${i}-${p.form}-${p.into ?? p.to ?? ""}`}>
              <b>{p.form}</b>
              {typeof p.count === "number" ? <span>{p.count}건</span> : null}
              {p.into ? <span>들어갈 곳 {p.into}</span> : null}
              {p.to ? <span>수신 {p.to}</span> : null}
              {p.for ? <span>용도 {p.for}</span> : null}
              {p.teams && p.teams.length > 0 ? <span>대상 팀 {p.teams.join(" · ")}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {item.draft === null ? (
        item.produces.length > 0 ? <p className="board-evidence-empty">{EVIDENCE_NO_DRAFT}</p> : null
      ) : (
        <DraftBody draft={item.draft} 행숨김={평가서 !== null} />
      )}

      {만들문서.map((문서) => (
        <DocFacts
          key={`produces:${문서.docId}`}
          문서={문서}
          팩트들={팩트들}
          읽는중={읽는중}
          평가서에서편다={문서.docId === 평가서}
        />
      ))}

      <CardAssessDraft item={item} facts={팩트들} siteName={siteName} />
    </section>
  );
}

/**
 * 초안 여섯 서식.
 *
 * DraftPreview(draft-preview.tsx)를 끼우지 않는다. 그쪽은 승인 직전 편집용 카드 안
 * 미리보기라 네 서식만 알고 회의록은 첫 행만 여섯 줄로 편다(view-model.ts:574-598).
 * 잘린 미리보기를 서랍에서 한 번 더 그릴 이유가 없다.
 */
function DraftBody({ draft, 행숨김 }: { draft: Draft; 행숨김: boolean }): JSX.Element {
  switch (draft.form) {
    case "회의록":
      return (
        <div className="board-evidence-draft">
          <p className="board-evidence-draft-head">
            회의록 초안 · {draft.제목} · 신규 {draft.rows.length}행
            {draft.supersedes ? ` · ${문서표시(draft.supersedes)}를 대신합니다` : ""}
          </p>
          {행숨김 ? (
            <p className="board-evidence-meta">{EVIDENCE_DRAFT_ROWS_ELSEWHERE}</p>
          ) : (
            <ol className="board-evidence-draft-rows">
              {draft.rows.map((r) => (
                <li key={r.itemId}>
                  <p className="board-evidence-draft-work">{r.process}</p>
                  <p className="board-evidence-draft-hazard">
                    {r.hazard}
                    {r.hazardClass ? ` (${r.hazardClass})` : ""}
                  </p>
                  {/* 등급(level)은 초안이 스스로 들고 온 값이라 그대로 보인다. 지어낸 값이 아니다. */}
                  <span className="board-evidence-draft-score">
                    빈도 {r.risk.likelihood} × 강도 {r.risk.severity} = {r.risk.score} {r.risk.level}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      );

    case "공문":
      return (
        <div className="board-evidence-draft">
          <p className="board-evidence-draft-head">
            공문 초안 · 수신 {draft.수신} · {draft.제목}
          </p>
          <p className="board-evidence-draft-body">{draft.본문}</p>
          {draft.첨부.length > 0 ? (
            <p className="board-evidence-meta">첨부 {draft.첨부.join(" · ")}</p>
          ) : (
            <p className="board-evidence-meta">첨부가 없습니다.</p>
          )}
        </div>
      );

    case "회의자료":
      return (
        <div className="board-evidence-draft">
          <p className="board-evidence-draft-head">
            회의자료 초안 · {draft.제목} · 회의 {draft.회의시각}
          </p>
          <ol className="board-evidence-draft-rows">
            {draft.안건.map((a) => (
              <li key={a.번호}>
                <p className="board-evidence-draft-work">
                  안건 {a.번호} · {a.제목}
                </p>
                {a.문항.length > 0 ? (
                  <ul className="board-evidence-draft-asks">
                    {a.문항.map((q, i) => (
                      <li key={`${a.번호}-${i}`}>{q}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="board-evidence-meta">물을 것이 적혀 있지 않습니다.</p>
                )}
              </li>
            ))}
          </ol>
        </div>
      );

    case "TBM자료":
      return (
        <div className="board-evidence-draft">
          <p className="board-evidence-draft-head">
            TBM자료 초안 · {draft.팀} · {draft.사용시각} 사용
          </p>
          <ul className="board-evidence-draft-asks">
            {draft.항목.map((t, i) => (
              <li key={`${i}-${t.slice(0, 12)}`}>{t}</li>
            ))}
          </ul>
          <p className="board-evidence-meta">
            구호 「{draft.구호}」 · 통역 필요 {draft.통역필요인원}명
          </p>
        </div>
      );

    case "점검표":
      return (
        <div className="board-evidence-draft">
          <p className="board-evidence-draft-head">
            점검표 초안 · {draft.제목} · {draft.항목.length}항목
          </p>
          <ul className="board-evidence-draft-asks">
            {draft.항목.map((c, i) => (
              <li key={`${i}-${c.확인.slice(0, 12)}`}>
                {c.확인} — {c.done ? "확인함" : "비어 있음"}
              </li>
            ))}
          </ul>
        </div>
      );

    case "기록":
      return (
        <div className="board-evidence-draft">
          <p className="board-evidence-draft-head">기록 초안 · {draft.제목}</p>
          <p className="board-evidence-draft-body">{draft.본문}</p>
        </div>
      );
  }
}

/* ------------------------------------------------------------------ *
 * 칸 3 — 무엇을 무효화하나
 * ------------------------------------------------------------------ */

function InvalidatesSlot({
  item,
  문서들,
  팩트들,
  읽는중,
  평가서,
  siteName,
}: {
  item: WorkItem;
  문서들: 문서참조[];
  팩트들: SnapshotFact[];
  읽는중: boolean;
  평가서: string | null;
  siteName: string;
}): JSX.Element {
  const 무효문서 = 문서들.filter((d) => d.출처 === "invalidates");
  const [펼침, set펼침] = useState(false);
  const 평가서칸 = useRef<HTMLDivElement>(null);

  /**
   * 접기 손잡이를 매 렌더마다 새로 만들지 않는다.
   *
   * `RiskDocPanel` 의 초점·Esc 효과가 이 함수를 의존성으로 든다(risk-doc-panel.tsx:92-99).
   * 인라인 화살표로 넘기면 그 효과가 **렌더마다** 다시 돌아 `서랍.current?.focus()` 가 또
   * 불린다. 평가서를 펼쳐 둔 채 승인을 누르면 저장 잠금이 켜지고 꺼지는 것만으로 두 번
   * 다시 그려지고, 그때마다 초점이 셋째 칸 안으로 끌려 들어가 큐가 승인 단추로 옮겨 놓은
   * 초점을 빼앗는다.
   */
  // set펼침 은 언제나 같은 참조라 이 목록은 변하지 않는다. 빈 배열 대신 적어 두는 이유는
  // react-hooks/preserve-manual-memoization 이 추론한 의존성과 적힌 의존성이 같아야 해서다.
  const 접기 = useCallback(() => set펼침(false), [set펼침]);

  // 중첩된 모달 경계를 벗긴다. CSS 로는 할 수 없는 유일한 부분이다 — 스크린리더가 안쪽을
  // 모달로 잡으면 첫째·둘째 칸이 읽히지 않는다(AC-2).
  useEffect(() => {
    if (!펼침) return;
    const 안쪽 = 평가서칸.current?.querySelector<HTMLElement>(".risk-drawer");
    if (!안쪽) return;
    안쪽.removeAttribute("aria-modal");
    안쪽.setAttribute("role", "group");
  }, [펼침]);

  return (
    <section className="board-evidence-slot">
      <h3>무엇을 무효화하나</h3>

      {무효문서.length === 0 ? (
        <p className="board-evidence-empty">
          {평가서 === null ? EVIDENCE_NO_INVALIDATES : EVIDENCE_DOC_WITHOUT_INVALIDATION}
        </p>
      ) : (
        무효문서.map((문서) => (
          <DocFacts
            key={`invalidates:${문서.docId}`}
            문서={문서}
            팩트들={팩트들}
            읽는중={읽는중}
            평가서에서편다={문서.docId === 평가서}
          />
        ))
      )}

      {평가서 === null ? null : (
        <div className="board-evidence-doc" ref={평가서칸}>
          <div className="board-evidence-doc-head">
            <p>
              {/* 어느 자격으로 이 문서를 열었는지 밝힌다. 조건식이 근거 문서까지 받아들이므로
                  TBM 회의록 같은 비평가서도 걸리고, 그때 평가서 패널은 행을 0건 찾아 "행이
                  없습니다" 를 그린다. 거짓말은 아니지만 왜 비었는지를 말하지 않는다. */}
              {item.invalidates[0] ? "무효 대상으로 지목된 문서" : "이 카드가 근거로 삼은 문서"}{" "}
              <b title={문서키툴팁(평가서)}>{문서표시(평가서)}</b>를 평가서로 엽니다.
            </p>
            <button type="button" onClick={() => set펼침((p) => !p)} aria-expanded={펼침}>
              {펼침 ? "접기" : "평가서 펼치기"}
            </button>
          </div>
          {/* 닫기 를 접기로 넘긴다. 그 컴포넌트가 자기 window Esc 리스너를 걸고 있어
              (risk-doc-panel.tsx:92-99) Esc 를 누르면 이 칸이 접히고 서랍의 리스너도 함께
              돌아 서랍이 닫힌다. 결과는 "서랍이 닫힌다" 하나라 사람이 보는 동작은 갈리지
              않는다. 리스너를 하나로 모으려면 그 파일에 prop 을 더해야 한다. */}
          {펼침 ? (
            <RiskDocPanel item={item} siteId={item.siteId} 현장이름={siteName} 닫기={접기} />
          ) : null}
        </div>
      )}

    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 문서 하나와 그 근거 팩트
 * ------------------------------------------------------------------ */

function DocFacts({
  문서,
  팩트들,
  읽는중,
  평가서에서편다,
}: {
  문서: 문서참조;
  팩트들: SnapshotFact[];
  읽는중: boolean;
  평가서에서편다: boolean;
}): JSX.Element {
  // 문서 이름은 이미 있는 사전에서 찾는다. 없으면 식별자를 그대로 적는다 — 지어내지 않는다.
  // 브리핑은 내부 식별자를 화면에 안 내보내지만(reference-chip.tsx:5-7) 여기는 계약이
  // 반대다. AC-4 가 팩트 key 를 적으라고 요구하고, 그 좌표가 있어야 담당자가 원본 문서에서
  // 그 행을 찾는다.
  const 사전 = useReference(문서.docId);
  // 폴백이 `문서.docId` 였다. 사전에 없는 문서면 **제목 자리에 저장소 키가 그대로** 떴다.
  // 바로 아래 `<code>` 가 키를 따로 적으므로, 여기는 사람이 읽는 이름이어야 한다.
  const 이름 = 사전?.title ?? 문서이름(문서.docId);

  const 전부 = 문서근거(팩트들, 문서.docId);
  const 평가행수 = 전부.filter((f) => f.factType === "riskAssessmentRow").length;
  const 보일 = 평가서에서편다 ? 전부.filter((f) => f.factType !== "riskAssessmentRow") : 전부;

  return (
    <div className="board-evidence-docfacts">
      <p className="board-evidence-docname">
        <span className="board-evidence-docrole">{출처_LABEL[문서.출처]}</span>
        <b>{이름}</b>
        <code>{문서.docId}</code>
      </p>
      {문서.설명 ? <p className="board-evidence-meta">{문서.설명}</p> : null}

      {평가서에서편다 && 평가행수 > 0 ? (
        <p className="board-evidence-meta">
          {EVIDENCE_ROWS_IN_DOC_PANEL} (위험성평가 행 {평가행수}건)
        </p>
      ) : null}

      {읽는중 ? (
        <p className="board-evidence-empty">{EVIDENCE_FACTS_LOADING}</p>
      ) : 보일.length === 0 ? (
        <p className="board-evidence-empty">
          {평가서에서편다 && 평가행수 > 0
            ? "이 문서에서 평가 행 말고 따로 기록된 근거는 없습니다."
            : 문서.출처 === "produces"
              ? EVIDENCE_NO_FACTS_YET
              : EVIDENCE_NO_FACTS}
        </p>
      ) : 보일.length > 접는건수 ? (
        <details className="board-evidence-fold">
          <summary>기록된 근거 {보일.length}건 펼치기</summary>
          <FactList 팩트들={보일} />
        </details>
      ) : (
        <FactList 팩트들={보일} />
      )}
    </div>
  );
}

function FactList({ 팩트들 }: { 팩트들: 근거팩트[] }): JSX.Element {
  return (
    <ul className="board-evidence-facts">
      {팩트들.map((f) => (
        <li
          key={`${f.factType}::${f.key}`}
          className={`board-evidence-fact${f.불일치 ? " is-forged" : ""}`}
        >
          <p className="board-evidence-fact-top">
            <span className="board-evidence-facttype">{FACT_TYPE_LABEL[f.factType] ?? f.factType}</span>
            <code className="board-evidence-key">{f.key}</code>
            <time dateTime={f.observedAt}>{f.시각}</time>
          </p>
          <p className="board-evidence-fact-text">{f.요약}</p>
          <details className="board-evidence-raw">
            <summary>값 전체</summary>
            <JsonViewer label={`${f.key} 의 값`} value={f.값} />
          </details>
        </li>
      ))}
    </ul>
  );
}
