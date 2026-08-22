"use client";

import { Fragment, useMemo, type JSX } from "react";

import { ReferenceMarker, RefNumberProvider } from "./reference-chip";
import type {
  BriefingCondition,
  BriefingSlot,
  BriefingSlots,
  ProducedItem,
  RichText,
} from "./types";

/**
 * 칸 순서는 **언제나 같다**.
 * 관측 → 대조 → 판단 → 무효화 → (법적 근거) → 만든 것 → 불확실성 → (제안)
 *
 * `optional: false` 인 여섯 칸은 값이 없어도 자리를 비우지 않고 "없습니다"를 적는다.
 * 자리가 옮겨 다니면 읽는 사람이 매번 순서를 다시 배워야 하기 때문이다.
 */
const SLOT_ORDER = [
  { key: "observation", term: "관측", optional: false },
  { key: "comparison", term: "대조", optional: false },
  { key: "judgement", term: "판단", optional: false },
  { key: "invalidation", term: "무효화", optional: false },
  { key: "legalBasis", term: "법적 근거", optional: true },
  { key: "produced", term: "만든 것", optional: false },
  { key: "uncertainty", term: "불확실성", optional: false },
  { key: "suggestion", term: "제안", optional: true },
] as const satisfies readonly {
  key: keyof BriefingSlots;
  term: string;
  optional: boolean;
}[];

const EMPTY_TEXT = "없습니다";

/**
 * 근거 번호를 매긴다. 칸 순서대로 훑어 처음 나온 자리에서 1부터 붙이므로,
 * 읽어 내려가면 번호가 언제나 오름차순이다. 같은 근거가 두 번 나오면 같은 번호를 쓴다.
 */
function numberReferences(slots: BriefingSlots): Record<string, number> {
  const numbers: Record<string, number> = {};
  let next = 1;
  for (const entry of SLOT_ORDER) {
    if (entry.key === "produced") continue;
    const slot = slots[entry.key];
    if (slot === null) continue;
    for (const paragraph of slot.paragraphs) {
      for (const run of paragraph) {
        if (run.kind !== "ref" || numbers[run.refId] !== undefined) continue;
        numbers[run.refId] = next;
        next += 1;
      }
    }
  }
  return numbers;
}

const LANE_LABEL: Record<ProducedItem["lane"], string> = {
  approval: "승인",
  todo: "Todo",
};

const LANE_CLASS: Record<ProducedItem["lane"], string> = {
  approval: "board-lane-chip is-approval",
  todo: "board-lane-chip is-todo",
};

/**
 * 서식 있는 짧은 글. HTML 문자열을 밀어 넣지 않고 조각 배열을 그대로 그린다.
 * 식별자와 도구 이름은 `code` 로 감싼다.
 */
export function RichLine({ runs }: { runs: RichText }): JSX.Element {
  return (
    <>
      {runs.map((run, index) => {
        if (run.kind === "strong") {
          return <b key={index}>{run.text}</b>;
        }
        if (run.kind === "ref") {
          // 본문에는 번호만 나가고, 마우스를 올리면 그 근거의 실제 내용이 펼쳐진다.
          return <ReferenceMarker key={index} refId={run.refId} />;
        }
        if (run.kind === "mono") {
          return (
            <code className="board-rsn-mono" key={index}>
              {run.text}
            </code>
          );
        }
        return <Fragment key={index}>{run.text}</Fragment>;
      })}
    </>
  );
}

function SlotBody({ slot }: { slot: BriefingSlot }): JSX.Element {
  if (slot.paragraphs.length === 1) {
    return <RichLine runs={slot.paragraphs[0]} />;
  }
  return (
    <>
      {slot.paragraphs.map((runs, index) => (
        <p key={index}>
          <RichLine runs={runs} />
        </p>
      ))}
    </>
  );
}

function ProducedList({
  items,
  onFocusCard,
}: {
  items: ProducedItem[];
  onFocusCard?: (cardId: string) => void;
}): JSX.Element {
  return (
    <ul className="board-rsn-produced">
      {items.map((item, index) => {
        const cardId = item.cardId;
        return (
          <li className="board-rsn-produced-item" key={`${item.form}-${index}`}>
            <span className={LANE_CLASS[item.lane]}>{LANE_LABEL[item.lane]}</span>
            {cardId === null ? (
              <span>{item.text}</span>
            ) : (
              <button
                className="board-rsn-produced-jump"
                onClick={() => onFocusCard?.(cardId)}
                type="button"
              >
                {item.text}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Chevron(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className="board-rsn-chevron"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

type BriefingItemProps = {
  condition: BriefingCondition;
  isOpen: boolean;
  onToggle: (conditionId: string) => void;
  onFocusCard?: (cardId: string) => void;
};

export function BriefingItem({
  condition,
  isOpen,
  onToggle,
  onFocusCard,
}: BriefingItemProps): JSX.Element {
  const bodyId = `board-rsn-body-${condition.conditionId}`;
  const refNumbers = useMemo(() => numberReferences(condition.slots), [condition.slots]);
  const rootClass = [
    "board-rsn",
    condition.tone === "due" ? "is-due" : "is-alert",
    isOpen ? "is-open" : "",
  ]
    .filter((token) => token.length > 0)
    .join(" ");

  return (
    <div className={rootClass}>
      <button
        aria-controls={bodyId}
        aria-expanded={isOpen}
        className="board-rsn-summary"
        onClick={() => onToggle(condition.conditionId)}
        type="button"
      >
        <span className="board-rsn-code">{condition.code}</span>
        <span className="board-rsn-kind">{condition.kindLabel}</span>
        <span className="board-rsn-title">{condition.headline}</span>
        <time className="board-rsn-at" dateTime={condition.detectedAt}>
          {condition.detectedAtLabel}
        </time>
        <span className="board-rsn-made">태스크 {condition.producedCount}</span>
        <Chevron />
      </button>

      {/* 접힌 상태에서도 자리를 유지한다. 여닫는 동안 높이가 이어져야 애니메이션이 붙고,
          닫혀 있는 동안에는 inert 로 초점과 보조기술에서 함께 빠진다. */}
      <div className="board-rsn-fold" inert={!isOpen}>
        <RefNumberProvider numbers={refNumbers}>
        <div className="board-rsn-body" id={bodyId}>
          <div className="board-rsn-inner">
          <dl className="board-rsn-grid">
            {SLOT_ORDER.map((entry) => {
              if (entry.key === "produced") {
                const items = condition.slots.produced;
                return (
                  <Fragment key={entry.key}>
                    <dt className="board-rsn-term">{entry.term}</dt>
                    {items.length === 0 ? (
                      <dd className="board-rsn-desc board-rsn-empty">{EMPTY_TEXT}</dd>
                    ) : (
                      <dd className="board-rsn-desc">
                        <ProducedList items={items} onFocusCard={onFocusCard} />
                      </dd>
                    )}
                  </Fragment>
                );
              }

              const slot = condition.slots[entry.key];
              if (slot === null && entry.optional) {
                return null;
              }

              return (
                <Fragment key={entry.key}>
                  <dt className="board-rsn-term">{entry.term}</dt>
                  {slot === null ? (
                    <dd className="board-rsn-desc board-rsn-empty">{EMPTY_TEXT}</dd>
                  ) : (
                    <dd className="board-rsn-desc">
                      <SlotBody slot={slot} />
                    </dd>
                  )}
                </Fragment>
              );
            })}
          </dl>

          {condition.note === null ? null : (
            <p className="board-rsn-note">
              <b>{condition.note.label}</b> — {condition.note.text}
            </p>
          )}
          </div>
        </div>
        </RefNumberProvider>
      </div>
    </div>
  );
}
