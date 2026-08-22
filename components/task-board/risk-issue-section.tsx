"use client";

import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import type {
  RiskIssue,
  RiskIssueEvidence,
  RiskIssueFormEvidence,
  RiskIssueLawEvidence,
  RiskIssueMailEvidence,
  RiskIssueRowChange,
} from "@/lib/board/risk-issue";
import { 회사표시 } from "@/lib/risk/rows";

import { CONSOLE_ACTOR } from "./presentation";

/**
 * 보드 맨 위의 "위험성평가 이슈" 섹션.
 *
 * 메일에서 감지된 변경 때문에 기존 평가서가 어떻게 바뀌는지를 한 화면에 보인다 —
 * 근거 3장(메일·법령·회사 양식)은 원본 문서 모양 그대로, 행의 변경은 GitHub 식
 * split diff(왼쪽 삭제·오른쪽 추가)로, 행마다 반영 여부를 토글로 고른다.
 *
 * 데이터는 전부 /api/board/risk-issue 가 조립해 내려준다. 이 파일은 문장을 만들지
 * 않는다 — 머리글도 카드의 문장을 그대로 옮긴 것이다(lib/board/risk-issue.ts).
 *
 * 반영은 risk-doc-panel 의 초안반영() 과 같은 순서다: 행을 전부 쓰고, 다 들어간
 * 뒤에만 카드를 확정한다. 반대로 하면 카드는 끝났는데 행은 문서에 없는 상태가 남는다.
 */

const EVIDENCE_KIND_LABEL: Record<RiskIssueEvidence["kind"], string> = {
  mail: "이메일 근거",
  law: "법령 근거",
  form: "맥락 근거",
};

const POP_WIDTH = 270;

/* ------------------------------------------------------------------ 시각 */

/** ISO(+09:00) → "8월 19일 18:22". 시각이 못 읽히면 원문을 그대로 둔다. */
function 시각표기(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t + 9 * 3_600_000);
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${d.getUTCHours()}:${mm}`;
}

/* ------------------------------------------------------------------ diff */

type Run = { text: string; changed: boolean };

/**
 * 낱말 강조. 앞뒤 공통 부분을 벗겨 내고 가운데만 칠한다.
 * 완전한 diff 알고리즘이 아니라, "25톤 → 50톤" 이나 꼬리에 덧붙은 구절처럼
 * 이 화면이 다루는 한 군데 변경을 읽기 좋게 만드는 용도다.
 */
function wordRuns(value: string, other: string): Run[] {
  if (value === other) return [{ text: value, changed: false }];
  let 앞 = 0;
  while (앞 < value.length && 앞 < other.length && value[앞] === other[앞]) 앞 += 1;
  let 뒤 = 0;
  while (
    뒤 < value.length - 앞 &&
    뒤 < other.length - 앞 &&
    value[value.length - 1 - 뒤] === other[other.length - 1 - 뒤]
  )
    뒤 += 1;

  const runs: Run[] = [];
  if (앞 > 0) runs.push({ text: value.slice(0, 앞), changed: false });
  const 가운데 = value.slice(앞, value.length - 뒤);
  if (가운데) runs.push({ text: 가운데, changed: true });
  if (뒤 > 0) runs.push({ text: value.slice(value.length - 뒤), changed: false });
  return runs;
}

function RunLine({ runs, tone }: { runs: Run[]; tone: "add" | "del" }): JSX.Element {
  return (
    <>
      {runs.map((run, index) =>
        run.changed ? (
          <span className={tone === "add" ? "board-issue-wadd" : "board-issue-wdel"} key={index}>
            {run.text}
          </span>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  );
}

type 위험도 = { 빈도: number; 강도: number; 위험도: number };

function ScoreLine({
  score,
  other,
  tone,
}: {
  score: 위험도;
  other: 위험도 | null;
  tone: "add" | "del";
}): JSX.Element {
  const mark = (mine: number, theirs: number | undefined): ReactNode =>
    theirs !== undefined && mine !== theirs ? (
      <span className={tone === "add" ? "board-issue-wadd" : "board-issue-wdel"}>{mine}</span>
    ) : (
      mine
    );
  return (
    <>
      빈도 {mark(score.빈도, other?.빈도)} × 강도 {mark(score.강도, other?.강도)} ={" "}
      {mark(score.위험도, other?.위험도)}
    </>
  );
}

/* ------------------------------------------------------------------ 근거 종이 */

/** 법령 본문에서 강조구절만 형광으로 칠한다. 구절이 본문에 없으면 아무것도 칠하지 않는다. */
function highlight(text: string, phrases: string[]): ReactNode[] {
  let parts: ReactNode[] = [text];
  phrases.forEach((phrase, phraseIndex) => {
    parts = parts.flatMap((part) => {
      if (typeof part !== "string" || !phrase) return [part];
      const pieces = part.split(phrase);
      if (pieces.length === 1) return [part];
      const out: ReactNode[] = [];
      pieces.forEach((piece, index) => {
        if (index > 0) out.push(<mark key={`${phraseIndex}-${index}`}>{phrase}</mark>);
        if (piece) out.push(piece);
      });
      return out;
    });
  });
  return parts;
}

function MailPaper({ evidence }: { evidence: RiskIssueMailEvidence }): JSX.Element {
  return (
    <div className="board-issue-paper board-issue-mail">
      <p className="board-issue-mail-subject">{evidence.제목}</p>
      <div className="board-issue-mail-sender">
        <span aria-hidden="true" className="board-issue-mail-avatar">
          {evidence.발신자.이름.slice(0, 1)}
        </span>
        <span className="board-issue-mail-who">
          <b>{evidence.발신자.이름}</b> <i>&lt;{evidence.발신자.주소}&gt;</i>
          <span>
            받는 사람 {evidence.수신.join(", ")}
            {evidence.참조.length > 0 ? ` · 참조 ${evidence.참조.join(", ")}` : ""}
          </span>
        </span>
        <time dateTime={evidence.보낸시각}>{시각표기(evidence.보낸시각)}</time>
      </div>
      <div className="board-issue-mail-body">
        {evidence.본문문단.map((문단, index) => (
          <p key={index}>{문단}</p>
        ))}
      </div>
      {evidence.첨부 ? (
        <div className="board-issue-mail-attach">
          <span aria-hidden="true" className="board-issue-mail-pdf">
            PDF
          </span>
          <span className="board-issue-mail-attach-name">
            {evidence.첨부.이름}
            <span>{evidence.첨부.쪽수}쪽</span>
          </span>
        </div>
      ) : null}
      {evidence.첨부 && evidence.첨부.표.length > 0 ? (
        <dl className="board-issue-mail-spec">
          {evidence.첨부.표.map((행) => (
            <div key={행.항목}>
              <dt>{행.항목}</dt>
              <dd>{행.값}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function LawPaper({ evidence }: { evidence: RiskIssueLawEvidence }): JSX.Element {
  return (
    <div className="board-issue-paper board-issue-law">
      <p className="board-issue-law-title">{evidence.법령명}</p>
      <p className="board-issue-law-meta">{evidence.시행표기}</p>
      <hr className="board-issue-law-rule" />
      <p className="board-issue-law-article">{evidence.조문제목}</p>
      {evidence.조문.map((항, index) => (
        <p className="board-issue-law-clause" key={index}>
          {항.번호 ? <b>{항.번호} </b> : null}
          {highlight(항.본문, evidence.강조구절)}
        </p>
      ))}
      <p className="board-issue-law-foot">— 매칭: {evidence.매칭} —</p>
    </div>
  );
}

function FormPaper({ evidence }: { evidence: RiskIssueFormEvidence }): JSX.Element {
  return (
    <div className="board-issue-paper board-issue-form">
      <table className="board-issue-form-approval" aria-hidden="true">
        <tbody>
          <tr>
            <td className="board-issue-form-rank" rowSpan={2}>
              결<br />재
            </td>
            {evidence.결재란.map((칸) => (
              <th key={칸}>{칸}</th>
            ))}
          </tr>
          <tr>
            {evidence.결재란.map((칸) => (
              <td key={칸} />
            ))}
          </tr>
        </tbody>
      </table>
      <p className="board-issue-form-title">{evidence.서식명}</p>
      <table className="board-issue-form-table">
        <tbody>
          {evidence.표.map((행) => (
            <tr key={행.항목}>
              <th>{행.항목}</th>
              <td>{행.값}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="board-issue-form-note">{evidence.주기}</p>
      <p className="board-issue-form-docno">
        <span>{evidence.발행처}</span>
        <span>{evidence.서식번호}</span>
      </p>
    </div>
  );
}

const FILE_META: Record<RiskIssueEvidence["kind"], { ext: string; extClass: string }> = {
  mail: { ext: "EML", extClass: "is-eml" },
  law: { ext: "법령", extClass: "is-law" },
  form: { ext: "HWP", extClass: "is-hwp" },
};

function evidenceFileName(evidence: RiskIssueEvidence): string {
  if (evidence.kind === "mail") return `${evidence.제목}.eml`;
  if (evidence.kind === "law") return `${evidence.법령명} · 국가법령정보센터`;
  return `${evidence.서식번호}_${evidence.서식명}.hwp`;
}

function EvidenceCard({
  evidence,
  number,
}: {
  evidence: RiskIssueEvidence;
  number: number;
}): JSX.Element {
  return (
    <article className="board-issue-evidence" id={`board-issue-ev-${evidence.refId}`}>
      <div className="board-issue-evidence-kind">
        <em>{EVIDENCE_KIND_LABEL[evidence.kind]}</em>
        <span className="board-issue-evidence-no">[{number}]</span>
      </div>
      <div className="board-issue-file">
        <span aria-hidden="true" className={`board-issue-ext ${FILE_META[evidence.kind].extClass}`}>
          {FILE_META[evidence.kind].ext}
        </span>
        <span className="board-issue-filename">{evidenceFileName(evidence)}</span>
      </div>
      <div className="board-issue-canvas">
        {evidence.kind === "mail" ? (
          <MailPaper evidence={evidence} />
        ) : evidence.kind === "law" ? (
          <LawPaper evidence={evidence} />
        ) : (
          <FormPaper evidence={evidence} />
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ 근거 칩 */

type PopContent = { kind: string; title: string; meta: string; sum: string };

function popContentOf(evidence: RiskIssueEvidence): PopContent {
  if (evidence.kind === "mail") {
    return {
      kind: "메일",
      title: evidence.제목,
      meta: `${evidence.발신자.이름} · ${시각표기(evidence.보낸시각)}`,
      sum: evidence.본문문단.join(" ").slice(0, 140),
    };
  }
  if (evidence.kind === "law") {
    return {
      kind: "법령",
      title: `${evidence.법령명} ${evidence.조문제목}`,
      meta: evidence.매칭,
      sum: evidence.강조구절.join(" · "),
    };
  }
  return {
    kind: "회사 양식",
    title: `${evidence.서식명} ${evidence.서식번호}`,
    meta: evidence.발행처,
    sum: evidence.주기,
  };
}

type PopState = { refId: string; top: number; left: number };

/**
 * 근거 칩 `[n]`. 올리면 요약 팝오버, 누르면 위의 원본 카드로 스크롤한다.
 * 팝오버 규칙(fixed 위치 · 닫기 유예 · 스크롤 시 닫기)은 reference-chip.tsx 를 따른다.
 */
function useRefPopover() {
  const [pop, setPop] = useState<PopState | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = useCallback((refId: string, anchor: HTMLElement) => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(
      12,
      Math.min(rect.left + rect.width / 2 - POP_WIDTH / 2, window.innerWidth - POP_WIDTH - 12),
    );
    setPop({ refId, top: rect.bottom + 8, left });
  }, []);

  const close = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setPop(null);
  }, []);

  const closeSoon = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setPop(null);
    }, 140);
  }, []);

  const hold = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (pop === null) return;
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pop, close]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  return { pop, open, close, closeSoon, hold };
}

function jumpToEvidence(refId: string): void {
  const card = document.getElementById(`board-issue-ev-${refId}`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("is-flash");
  // 연달아 눌러도 다시 빛나도록 리플로우로 애니메이션을 리셋한다.
  void card.getBoundingClientRect();
  card.classList.add("is-flash");
}

/* ------------------------------------------------------------------ diff 표 */

type ChipRenderer = (refId: string) => JSX.Element | null;

function DiffLine({
  label,
  refChips,
  left,
  right,
}: {
  label: string;
  refChips: ReactNode;
  /** null 이면 왼쪽에 대응 줄이 없다 — 빗금 빈 칸. */
  left: ReactNode | null;
  right: ReactNode | null;
}): JSX.Element {
  return (
    <div className="board-issue-dline">
      {left === null ? (
        <div className="board-issue-dcell is-empty" />
      ) : (
        <div className="board-issue-dcell is-del">
          <i aria-hidden="true" className="board-issue-gut">
            −
          </i>
          <em className="board-issue-fld">{label}</em>
          <span className="board-issue-dtext">{left}</span>
        </div>
      )}
      <div className="board-issue-dmid">{refChips}</div>
      {right === null ? (
        <div className="board-issue-dcell is-empty" />
      ) : (
        <div className="board-issue-dcell is-add">
          <i aria-hidden="true" className="board-issue-gut">
            +
          </i>
          <em className="board-issue-fld">{label}</em>
          <span className="board-issue-dtext">{right}</span>
        </div>
      )}
    </div>
  );
}

function PlainLine({ label, text }: { label: string; text: string }): JSX.Element {
  return (
    <div className="board-issue-dline">
      <div className="board-issue-dcell">
        <i aria-hidden="true" className="board-issue-gut" />
        <em className="board-issue-fld">{label}</em>
        <span className="board-issue-dtext">{text}</span>
      </div>
      <div className="board-issue-dmid" />
      <div className="board-issue-dcell">
        <i aria-hidden="true" className="board-issue-gut" />
        <em className="board-issue-fld">{label}</em>
        <span className="board-issue-dtext">{text}</span>
      </div>
    </div>
  );
}

function RowDiff({
  row,
  chip,
  applied,
  onToggle,
}: {
  row: RiskIssueRowChange;
  chip: ChipRenderer;
  applied: boolean;
  onToggle: (행id: string, on: boolean) => void;
}): JSX.Element {
  const { before, after } = row;
  const chips = <>{row.refs.map((refId) => chip(refId))}</>;

  const 이전대책 = before?.대책 ?? [];
  const 이후대책 = after.대책 ?? [];
  const 유지 = 이후대책.filter((대책) => 이전대책.includes(대책));
  const 삭제 = 이전대책.filter((대책) => !이후대책.includes(대책));
  const 추가 = 이후대책.filter((대책) => !이전대책.includes(대책));

  return (
    <li className="board-issue-row">
      <div className="board-issue-row-top">
        <span className="board-issue-rowid">{row.행id}</span>
        <span className="board-issue-rowclass">{after.공종분류 ?? "분류 없음"}</span>
        <span className={row.mode === "신규" ? "board-issue-mode is-new" : "board-issue-mode"}>
          {row.mode}
        </span>
        <span className="board-issue-rowowner">{회사표시(after.담당사)}</span>
      </div>

      <div className="board-issue-diffwrap">
        <div className="board-issue-dscroll">
          <div className="board-issue-dtable">
            <div className="board-issue-dline board-issue-dhead">
              <div className="board-issue-dcell">
                <span className="board-issue-dhead-del">−</span>&nbsp;
                {before ? `변경 전 · ${after.회의록}` : "변경 전 · 기존 평가서에 없음"}
              </div>
              <div className="board-issue-dmid">근거</div>
              <div className="board-issue-dcell">
                <span className="board-issue-dhead-add">+</span>&nbsp;변경 후 · 이번 제안
              </div>
            </div>

            {before && before.단위작업 === after.단위작업 ? (
              <PlainLine label="작업" text={after.단위작업} />
            ) : (
              <DiffLine
                label="작업"
                refChips={chips}
                left={
                  before ? <RunLine runs={wordRuns(before.단위작업, after.단위작업)} tone="del" /> : null
                }
                right={<RunLine runs={wordRuns(after.단위작업, before?.단위작업 ?? "")} tone="add" />}
              />
            )}

            {before && (before.위험요인 ?? "") === (after.위험요인 ?? "") ? (
              <PlainLine label="위험요인" text={after.위험요인 ?? ""} />
            ) : (
              <DiffLine
                label="위험요인"
                refChips={chips}
                left={
                  before ? (
                    <RunLine
                      runs={wordRuns(before.위험요인 ?? "", after.위험요인 ?? "")}
                      tone="del"
                    />
                  ) : null
                }
                right={
                  <RunLine runs={wordRuns(after.위험요인 ?? "", before?.위험요인 ?? "")} tone="add" />
                }
              />
            )}

            {after.개선전 ? (
              <DiffLine
                label="개선 전"
                refChips={chips}
                left={
                  before?.개선전 ? (
                    <ScoreLine score={before.개선전} other={after.개선전} tone="del" />
                  ) : null
                }
                right={<ScoreLine score={after.개선전} other={before?.개선전 ?? null} tone="add" />}
              />
            ) : null}

            {after.개선후 ? (
              <DiffLine
                label="개선 후"
                refChips={null}
                left={
                  before?.개선후 ? (
                    <ScoreLine score={before.개선후} other={after.개선후} tone="del" />
                  ) : null
                }
                right={<ScoreLine score={after.개선후} other={before?.개선후 ?? null} tone="add" />}
              />
            ) : null}

            {유지.map((대책) => (
              <PlainLine key={대책} label="대책" text={대책} />
            ))}
            {삭제.map((대책) => (
              <DiffLine key={대책} label="대책" refChips={chips} left={대책} right={null} />
            ))}
            {추가.map((대책) => (
              <DiffLine key={대책} label="대책" refChips={chips} left={null} right={대책} />
            ))}
          </div>
        </div>

        <div className="board-issue-decide">
          <button
            aria-checked={applied}
            aria-label={`${row.행id} 평가서에 반영`}
            className={applied ? "board-issue-switch is-on" : "board-issue-switch"}
            onClick={() => onToggle(row.행id, !applied)}
            role="switch"
            type="button"
          >
            <span aria-hidden="true" className="board-issue-switch-track">
              <span className="board-issue-switch-knob" />
            </span>
            <span className="board-issue-switch-label">{applied ? "반영" : "제외"}</span>
          </button>
        </div>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ 섹션 */

type Phase =
  | { name: "loading" }
  | { name: "hidden" }
  | { name: "ready"; issue: RiskIssue }
  | { name: "applying"; issue: RiskIssue }
  | { name: "done"; issue: RiskIssue; 적용수: number };

export function RiskIssueSection({ siteId }: { siteId: string }): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const [켜짐, set켜짐] = useState<Set<string>>(new Set());
  const [오류, set오류] = useState<string | null>(null);
  const popover = useRefPopover();

  useEffect(() => {
    let 살아있음 = true;
    fetch(`/api/board/risk-issue?siteId=${encodeURIComponent(siteId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<{ issue: RiskIssue | null }>;
      })
      .then((body) => {
        if (!살아있음) return;
        if (body.issue === null) {
          setPhase({ name: "hidden" });
          return;
        }
        setPhase({ name: "ready", issue: body.issue });
        set켜짐(new Set(body.issue.rows.map((row) => row.행id)));
      })
      .catch((error) => {
        // 이슈를 못 읽으면 섹션을 그리지 않는다. 보드의 나머지가 무너질 이유는 없지만
        // 조용히 삼키지는 않는다 — 원래 없는 건지 못 읽은 건지 구분할 자리를 남긴다.
        console.error("[board] 위험성평가 이슈를 읽지 못했습니다:", error);
        if (살아있음) setPhase({ name: "hidden" });
      });
    return () => {
      살아있음 = false;
    };
  }, [siteId]);

  const toggle = useCallback((행id: string, on: boolean) => {
    set켜짐((previous) => {
      const next = new Set(previous);
      if (on) next.add(행id);
      else next.delete(행id);
      return next;
    });
  }, []);

  if (phase.name === "loading" || phase.name === "hidden") return null;

  const issue = phase.issue;
  const refNumbers = new Map(issue.evidence.map((evidence, index) => [evidence.refId, index + 1]));

  const chip: ChipRenderer = (refId) => {
    const number = refNumbers.get(refId);
    if (number === undefined) return null;
    return (
      <button
        className="board-issue-refchip"
        key={refId}
        onBlur={popover.closeSoon}
        onClick={() => {
          popover.close();
          jumpToEvidence(refId);
        }}
        onFocus={(event) => popover.open(refId, event.currentTarget)}
        onMouseEnter={(event) => popover.open(refId, event.currentTarget)}
        onMouseLeave={popover.closeSoon}
        type="button"
      >
        [{number}]
      </button>
    );
  };

  async function 반영하기(): Promise<void> {
    if (phase.name !== "ready") return;
    const 고른행 = issue.rows.filter((row) => 켜짐.has(row.행id));
    if (고른행.length === 0) return;

    setPhase({ name: "applying", issue });
    set오류(null);

    try {
      // 행을 먼저 전부 쓴다. 하나라도 실패하면 카드를 확정하지 않는다.
      for (const row of 고른행) {
        const res = await fetch("/api/board/facts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            siteId: issue.siteId,
            factType: "riskAssessmentRow",
            key: `${issue.targetDocId}#${row.행id}`,
            value: row.after,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(`${row.행id} 를 문서에 넣지 못했습니다: ${body.error ?? res.status}`);
        }
      }

      const res = await fetch(`/api/board/items/${encodeURIComponent(issue.cardId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done", confirmedBy: CONSOLE_ACTOR }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(`행은 들어갔지만 카드를 확정하지 못했습니다: ${body.error ?? res.status}`);
      }

      setPhase({ name: "done", issue, 적용수: 고른행.length });
    } catch (error) {
      set오류(error instanceof Error ? error.message : "반영하지 못했습니다.");
      setPhase({ name: "ready", issue });
    }
  }

  if (phase.name === "done") {
    return (
      <section aria-label="위험성평가 이슈" className="board-issue">
        <div className="board-brief-card">
          <div className="board-issue-done" role="status">
            <b>
              {phase.적용수}행을 {issue.targetDocId} 에 반영했습니다.
            </b>{" "}
            카드가 완료 열로 이동했습니다. 새 행의 이행확인은 비어 있습니다 — 현장에서 실행을
            확인한 뒤 위험성평가 기록에서 체크합니다.
          </div>
        </div>
      </section>
    );
  }

  const 선택수 = issue.rows.filter((row) => 켜짐.has(row.행id)).length;
  const popEvidence =
    popover.pop === null
      ? null
      : (issue.evidence.find((evidence) => evidence.refId === popover.pop?.refId) ?? null);

  return (
    <section aria-label="위험성평가 이슈" className="board-issue">
      <div className="board-brief-card">
        <div className="board-brief-top">
          <span aria-hidden="true" className="board-brief-avatar">
            <svg
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M12 11v4" />
              <path d="M12 18h.01" />
            </svg>
          </span>
          <div className="board-brief-heading">
            <b>위험성평가 이슈 — {issue.headline}</b>
            <span>{시각표기(issue.detectedAt)} 감지 · 메일 1건에서</span>
          </div>
          <span className="board-issue-pill">
            <i aria-hidden="true" />
            재생성 필요
          </span>
        </div>

        <div className="board-issue-lede">
          {issue.lede.map((문단, index) => (
            <p key={index}>{문단}</p>
          ))}
        </div>

        <div className="board-issue-evidence-grid">
          {issue.evidence.map((evidence) => (
            <EvidenceCard
              evidence={evidence}
              key={evidence.refId}
              number={refNumbers.get(evidence.refId) ?? 0}
            />
          ))}
        </div>

        <p className="board-issue-ask">
          이 변경을 반영하면 <b>{issue.targetDocId}</b> 가 아래처럼 바뀝니다. 행마다 반영 여부를
          고를 수 있습니다.
          <span className="board-issue-ask-count">
            수정 {issue.rows.filter((row) => row.mode === "수정").length} · 신규{" "}
            {issue.rows.filter((row) => row.mode === "신규").length}
          </span>
        </p>

        <ol className="board-issue-rows">
          {issue.rows.map((row) => (
            <RowDiff
              applied={켜짐.has(row.행id)}
              chip={chip}
              key={row.행id}
              onToggle={toggle}
              row={row}
            />
          ))}
        </ol>

        {오류 ? (
          <p className="board-issue-error" role="alert">
            {오류}
          </p>
        ) : null}

        <div className="board-issue-actions">
          <button
            className="board-issue-apply"
            disabled={phase.name === "applying" || 선택수 === 0}
            onClick={() => void 반영하기()}
            type="button"
          >
            {phase.name === "applying"
              ? "반영 중…"
              : `반영 선택 ${선택수}건을 ${issue.targetDocId} 에 쓰기`}
          </button>
          <span className="board-issue-note">
            반영 후 새 행의 이행확인은 비워 둡니다 — 현장 확인은 위험성평가 기록에서 합니다.
          </span>
        </div>
      </div>

      {popover.pop !== null && popEvidence !== null ? (
        <div
          className="board-issue-pop"
          onMouseEnter={popover.hold}
          onMouseLeave={popover.closeSoon}
          role="tooltip"
          style={{ top: popover.pop.top, left: popover.pop.left }}
        >
          {(() => {
            const content = popContentOf(popEvidence);
            return (
              <>
                <span className="board-issue-pop-head">
                  <span className="board-issue-pop-kind">{content.kind}</span>
                  <span className="board-issue-pop-no">
                    [{refNumbers.get(popEvidence.refId) ?? 0}]
                  </span>
                </span>
                <b className="board-issue-pop-title">{content.title}</b>
                <span className="board-issue-pop-meta">{content.meta}</span>
                <span className="board-issue-pop-sum">{content.sum}</span>
                <span className="board-issue-pop-hint">클릭하면 위의 원본으로 이동합니다</span>
              </>
            );
          })()}
        </div>
      ) : null}
    </section>
  );
}
