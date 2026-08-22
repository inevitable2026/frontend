"use client";

import type { JSX } from "react";

import type {
  DraftEdit,
  DraftRow,
  MeetingAgendaDraft,
  OfficialLetterDraft,
  RiskAssessmentRowDraft,
  TaskDraft,
  TbmMinutesDraft,
} from "./types";

type DraftPreviewProps = {
  draft: TaskDraft;
  edits: DraftEdit[];
  onEdit: (edit: DraftEdit) => void;
};

/** 초안 원본 대비 지금 화면에 떠 있는 값. 고친 적이 없으면 원본 그대로다. */
function currentValue(edits: DraftEdit[], path: string, original: string): string {
  const edited = edits.find((edit) => edit.path === path);
  return edited ? edited.after : original;
}

type EditableLineProps = {
  label: string;
  path: string;
  value: string;
  editable: boolean;
  edits: DraftEdit[];
  onEdit: (edit: DraftEdit) => void;
};

/** 라벨-값 한 줄. 고칠 수 있는 칸이면 입력칸으로 그리고 수정분을 위로 올린다. */
function DraftLine({ label, path, value, editable, edits, onEdit }: EditableLineProps): JSX.Element {
  if (!editable) {
    return (
      <div className="board-draft-row">
        <span className="board-draft-label">{label}</span>
        <span className="board-draft-value">{value}</span>
      </div>
    );
  }

  return (
    <div className="board-draft-row">
      <span className="board-draft-label">{label}</span>
      <input
        className="board-draft-input"
        type="text"
        aria-label={label}
        value={currentValue(edits, path, value)}
        onChange={(event) => onEdit({ path, before: value, after: event.target.value })}
      />
    </div>
  );
}

function rowsBody(
  rows: DraftRow[],
  pathPrefix: string,
  edits: DraftEdit[],
  onEdit: (edit: DraftEdit) => void,
): JSX.Element[] {
  return rows.map((row, index) => (
    <DraftLine
      key={`${pathPrefix}-${index}`}
      label={row.label}
      path={`${pathPrefix}[${index}].value`}
      value={row.value}
      editable={row.editable}
      edits={edits}
      onEdit={onEdit}
    />
  ));
}

/** 회의록 행 — ④ 위험요인 · ⑤ 개선 전 · ⑥ 대책 · ⑦ 개선 후 · ⑧ 근거 · ⑩ 이행확인 */
function RiskAssessmentRowBody({
  draft,
  edits,
  onEdit,
}: {
  draft: RiskAssessmentRowDraft;
  edits: DraftEdit[];
  onEdit: (edit: DraftEdit) => void;
}): JSX.Element {
  return <>{rowsBody(draft.rows, "rows", edits, onEdit)}</>;
}

/** 공문 — 제목과 본문 두 문단. 표현이 관계에 영향을 주므로 둘 다 고칠 수 있다. */
function OfficialLetterBody({
  draft,
  edits,
  onEdit,
}: {
  draft: OfficialLetterDraft;
  edits: DraftEdit[];
  onEdit: (edit: DraftEdit) => void;
}): JSX.Element {
  return (
    <>
      <div className="board-draft-para">
        <b className="board-draft-para-label">제목</b>
        <input
          className="board-draft-input"
          type="text"
          aria-label="공문 제목"
          value={currentValue(edits, "subject", draft.subject)}
          onChange={(event) => onEdit({ path: "subject", before: draft.subject, after: event.target.value })}
        />
      </div>
      <div className="board-draft-para">
        <b className="board-draft-para-label">본문</b>
        <textarea
          className="board-draft-input"
          rows={4}
          aria-label="공문 본문"
          value={currentValue(edits, "body", draft.body)}
          onChange={(event) => onEdit({ path: "body", before: draft.body, after: event.target.value })}
        />
      </div>
    </>
  );
}

/** 회의 안건 — 안건 줄과 "물을 것" 줄. */
function MeetingAgendaBody({
  draft,
  edits,
  onEdit,
}: {
  draft: MeetingAgendaDraft;
  edits: DraftEdit[];
  onEdit: (edit: DraftEdit) => void;
}): JSX.Element {
  return <>{rowsBody(draft.items, "items", edits, onEdit)}</>;
}

/** TBM 자료 — 팀 3줄과 구호 1줄. */
function TbmMinutesBody({ draft }: { draft: TbmMinutesDraft }): JSX.Element {
  return (
    <>
      {draft.teams.map((team) => (
        <div className="board-draft-row" key={team.team}>
          <span className="board-draft-label">{team.team}</span>
          <span className="board-draft-value">
            중점: {team.focus} · 통제: {team.control}
          </span>
        </div>
      ))}
      <div className="board-draft-row">
        <span className="board-draft-label">구호</span>
        <span className="board-draft-value">{draft.slogan}</span>
      </div>
    </>
  );
}

function DraftBody({ draft, edits, onEdit }: DraftPreviewProps): JSX.Element {
  if (!draft.ready) {
    return (
      <div className="board-draft-row">
        <span className="board-draft-label">초안</span>
        <span className="board-draft-value">아직 다 써지지 않았습니다. 근거가 채워지면 이어서 씁니다.</span>
      </div>
    );
  }

  switch (draft.form) {
    case "riskAssessmentRow":
      return <RiskAssessmentRowBody draft={draft} edits={edits} onEdit={onEdit} />;
    case "officialLetter":
      return <OfficialLetterBody draft={draft} edits={edits} onEdit={onEdit} />;
    case "meetingAgenda":
      return <MeetingAgendaBody draft={draft} edits={edits} onEdit={onEdit} />;
    case "tbmMinutes":
      return <TbmMinutesBody draft={draft} />;
    default: {
      // 서식이 늘면 여기서 컴파일이 막힌다.
      const never: never = draft;
      return never;
    }
  }
}

export function DraftPreview({ draft, edits, onEdit }: DraftPreviewProps): JSX.Element {
  return (
    <details className="board-draft">
      <summary className="board-draft-summary">
        초안 보기
        <svg
          className="board-draft-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="board-draft-body">
        <DraftBody draft={draft} edits={edits} onEdit={onEdit} />
      </div>
    </details>
  );
}
