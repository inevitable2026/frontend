"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import ContextSearch from "@/components/context-search";
import { DocumentViewer } from "@/components/document-viewer";
import { MailAttachmentViewer } from "@/components/mail-attachment-viewer";
import { ParseOverlay, type ParsedRegion } from "@/components/parse-overlay";
import { formatExtractedField, hasExtractedDisplayValue } from "@/lib/context/extracted-display";
import type { MailAttachment, MailThread } from "@/lib/context/mail-threads";
import { 단계설명, 단계이름 } from "@/lib/context/stage-label";
import { consumeIngestStream, createIngestJob } from "@/lib/context/stream-terminal";
import {
  DOCUMENT_KINDS,
  INGEST_DOCUMENT_KINDS,
  STAGE_ORDER,
  type DocumentKind,
  type ExtractedFields,
  type IngestEvent,
  type IngestStage,
  type SiteRecommendation,
} from "@/lib/context/types";

type Site = { id: string; code: string; name: string; document_count: number };

type DocumentRow = {
  id: string;
  site_name: string;
  kind: DocumentKind;
  title: string;
  source_filename: string;
  page_count: number | null;
  chunk_count: number;
  extracted: ExtractedFields | null;
};

type Phase = "idle" | "running" | "done" | "failed";
type ExecutionDetails = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): ExecutionDetails | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ExecutionDetails) : null;
}

function cleanupBlocksSave(execution: ExecutionDetails | null): boolean {
  const cleanup = text(execution?.cleanup ?? execution?.cleanupStatus)?.toLowerCase();
  const mode = text(execution?.mode);
  return cleanup !== "deleted" || mode !== "studio";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function seconds(ms: number | null): string {
  if (ms == null) return "";
  return ms < 1000 ? "1초 미만" : `${(ms / 1000).toFixed(1)}초`;
}

function mailStamp(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getMonth() + 1}월 ${at.getDate()}일 ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const THREAD_STATE_SLUG: Record<MailThread["상태"], string> = {
  "맥락 반영됨": "applied",
  "검토 대기": "pending",
  보류: "held",
};

const ATTACH_STATE_SLUG: Record<MailThread["messages"][number]["첨부"][number]["상태"], string> = {
  적재됨: "stored",
  적재대기: "queued",
  제외: "skipped",
};

function emptyStages(): IngestStage[] {
  return STAGE_ORDER.map((name) => ({ 이름: name, 상태: "대기", 시작: null, 소요ms: null }));
}

export function SiteContextPanel() {
  const [sites, setSites] = useState<Site[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [siteFilter, setSiteFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");

  const [kind, setKind] = useState<DocumentKind>("하도급계약서");
  const [mode, setMode] = useState<"live" | "demo">("live");
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [stages, setStages] = useState<IngestStage[]>(emptyStages);
  const [jobId, setJobId] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<SiteRecommendation | null>(null);
  const [chosenSiteId, setChosenSiteId] = useState("");
  const [upstageCalls, setUpstageCalls] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ranAsDemo, setRanAsDemo] = useState(false);
  const [execution, setExecution] = useState<ExecutionDetails | null>(null);
  const [activeRegion, setActiveRegion] = useState<number | null>(null);
  const [openedDocument, setOpenedDocument] = useState<string | null>(null);
  const [mailThreads, setMailThreads] = useState<MailThread[]>([]);
  const [openedThread, setOpenedThread] = useState<string | null>(null);
  const [demoRetryFile, setDemoRetryFile] = useState<File | null>(null);
  // 라이브가 거절되어 재시도 버튼을 열어 둘지. 예전에는 안내 문구를 문자열로 훑어 판별했는데
  // 서버는 `readiness.reason`(예: "Studio 라이브 적재 플래그가 꺼져 있습니다.")을 그대로 보내므로
  // 어떤 문구와도 맞지 않아 버튼이 영원히 렌더되지 않았다. 문구 대신 createIngestJob 의
  // kind === "live_disabled" 를 근거로 삼는다.
  const [liveDisabled, setLiveDisabled] = useState(false);
  // 첨부를 누르면 띄울 미리보기. 어느 현장의 메일이었는지를 창 머리에 적어야 해서
  // 첨부와 현장명을 함께 들고 있는다.
  const [openedAttachment, setOpenedAttachment] = useState<
    { attachment: MailAttachment; siteName: string } | null
  >(null);

  const fileInput = useRef<HTMLInputElement>(null);

  const loadSites = useCallback(async () => {
    const res = await fetch("/api/context/sites");
    if (!res.ok) return;
    setSites((await res.json()).sites ?? []);
  }, []);

  const loadDocuments = useCallback(async () => {
    const params = new URLSearchParams();
    if (siteFilter) params.set("siteId", siteFilter);
    if (kindFilter) params.set("kind", kindFilter);
    const res = await fetch(`/api/context/documents?${params}`);
    if (!res.ok) return;
    setDocuments((await res.json()).documents ?? []);
  }, [siteFilter, kindFilter]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/context/sites");
      if (cancelled || !res.ok) return;
      setSites((await res.json()).sites ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (siteFilter) params.set("siteId", siteFilter);
    if (kindFilter) params.set("kind", kindFilter);
    void (async () => {
      const res = await fetch(`/api/context/documents?${params}`);
      if (cancelled || !res.ok) return;
      setDocuments((await res.json()).documents ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [siteFilter, kindFilter]);

  // 메일함은 아직 목업이라 종류 필터와 무관하게 현장만 따진다. 문서함과 같은 방식으로
  // 라우트에서 받아 두면 커넥터가 붙을 때 화면을 고치지 않아도 된다.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (siteFilter) params.set("siteId", siteFilter);
    void (async () => {
      const res = await fetch(`/api/context/mail?${params}`);
      if (cancelled || !res.ok) return;
      setMailThreads((await res.json()).threads ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [siteFilter]);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  async function upload(file: File, requestedMode = mode) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setFileName(file.name);
    setPhase("running");
    setStages(emptyStages());
    setRecommendation(null);
    setChosenSiteId("");
    setUpstageCalls(0);
    setMessage(null);
    setRanAsDemo(requestedMode === "demo");
    setExecution(null);
    // 새 시도가 시작되면 직전 거절의 흔적은 지운다. 재시도 버튼이 이번 시도의 결과와
    // 무관하게 남아 있으면 다시 "왜 눌러도 되는지" 를 알 수 없게 된다.
    setLiveDisabled(false);
    setDemoRetryFile(null);

    try {
      const form = new FormData();
      if (requestedMode === "live") form.append("file", file);
      else {
        form.append("filename", file.name);
        form.append("byteLength", String(file.size));
        form.append("mime", file.type || "application/pdf");
      }

      const params = new URLSearchParams({ mode: requestedMode, kind });
      const created = await createIngestJob(fetch, `/api/context/ingest?${params}`, { method: "POST", body: form });
      if (created.kind === "live_disabled") {
        // 서버가 준 사유는 설비 상태를 적은 문장이라 화면에 그대로 두지 않는다.
        console.error("[ingest] live disabled:", created.message);
        setPhase("idle");
        setStages(emptyStages());
        setMessage(
          "지금은 실제 분석을 할 수 없습니다. 올린 파일은 저장되지도, 분석되지도 않았습니다. 데모로 고정된 예시를 볼 수 있습니다.",
        );
        // 같은 파일로 데모를 다시 돌릴 수 있을 때만 재시도 파일을 쥔다(stream-terminal 계약).
        if (created.retryWithDemo) setDemoRetryFile(file);
        setLiveDisabled(true);
        setMode("demo");
        // 여기서 데모를 자동으로 돌리지 않는다. "업로드·저장·분석되지 않았습니다" 라고 고지한
        // 직후에 동의 없이 다른 실행을 붙이면 이 패널이 지키려는 정직성이 무너진다.
        return;
      }
      if (created.kind === "failed") {
        setPhase("failed");
        setMessage(created.message);
        return;
      }
      setJobId(created.jobId);
      await consume(created.jobId, requestedMode === "demo" ? file.size : undefined, requestedMode === "demo");
    } catch {
      setPhase("failed");
      setMessage("업로드 요청에 실패했습니다. 다시 업로드해 주세요.");
    }
  }

  async function consume(id: string, demoByteLength?: number, wasDemo = false) {
    const params = demoByteLength === undefined ? "" : `?byteLength=${encodeURIComponent(String(demoByteLength))}`;
    const outcome = await consumeIngestStream(fetch, `/api/context/ingest/${id}/stream${params}`, (event) => apply(event, wasDemo));
    if (outcome.kind === "failed") {
      setPhase("failed");
      setMessage(outcome.message);
    }
  }

  function apply(event: IngestEvent, wasDemo = false) {
    if (event.종류 === "단계") {
      setStages((prev) => prev.map((s) => (s.이름 === event.단계.이름 ? event.단계 : s)));
      return;
    }
    if (event.종류 === "완료") {
      const details = record((event as IngestEvent & { execution?: unknown; provenance?: unknown }).execution) ??
        record((event as IngestEvent & { provenance?: unknown }).provenance);
      if (!details && !wasDemo) {
        setPhase("failed");
        setMessage("이 분석이 어떻게 처리됐는지 확인하지 못해 결과를 저장하지 않습니다. 다시 업로드해 주세요.");
        return;
      }
      setPhase("done");
      setUpstageCalls(event.upstageCalls);
      setRecommendation(event.추천);
      setExecution(details);
      // 확신이 임계값을 넘었을 때만 대신 고른다. 그러지 않으면 화면이 "직접 고르세요"
      // 라고 적으면서 동시에 골라 둔 채로 저장 버튼을 열어 두게 된다.
      if (event.추천?.충분함) setChosenSiteId(event.추천.siteId);
      return;
    }
    setPhase("failed");
    setMessage(event.사유);
    setStages((prev) =>
      prev.map((s) => (s.이름 === event.단계 ? { ...s, 상태: "실패", 실패사유: event.사유 } : s)),
    );
  }

  async function save() {
    if (!jobId || !chosenSiteId) return;
    setSaving(true);
    const res = await fetch("/api/context/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, siteId: chosenSiteId, kind }),
    });
    const body = await res.json();
    setSaving(false);
    if (!res.ok) {
      setMessage(body.error ?? "문서를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      return;
    }
    setMessage(`${body.siteName} 문서함에 저장했습니다. 검색 조각 ${body.chunkCount}개를 만들었습니다.`);
    setPhase("idle");
    setJobId(null);
    setStages(emptyStages());
    await Promise.all([loadSites(), loadDocuments()]);
  }

  const layout = stages.find((s) => s.이름 === "레이아웃분석")?.산출 as
    | { agent?: string; agentId?: string; 역할?: string; 요소?: ParsedRegion[]; 요소수?: number }
    | undefined;
  const extracted = stages.find((s) => s.이름 === "필드추출")?.산출 as ExtractedFields | undefined;
  const chunkPreview = stages.find((s) => s.이름 === "청킹")?.산출 as
    | { 청크수: number; 미리보기: Array<{ seq: number; page: number; text: string }> }
    | undefined;
  // 데모의 완료 이벤트는 `추천: null` 이다 — 저장 흐름을 열지 않으려는 의도라 그대로 둔다.
  // 대신 녹화 원본에 남아 있는 프로젝트판정 단계 산출을 읽어 화면에 표시만 한다.
  // 녹화본이라 `충분함` 같은 최신 필드가 없으므로 SiteRecommendation 으로 단정하지 않고
  // 필드별로 확인해서 쓴다. 아래 렌더는 출처가 `recorded` 일 때만 연다 — "녹화된 판정" 이라고
  // 적는 문구가 참이 되는 조건이 그것뿐이고, 합성 실행에 남의 판정이 실려 와도 여기서 막힌다.
  const siteVerdict = record(stages.find((s) => s.이름 === "프로젝트판정")?.산출);
  // 한 줄 요약에 쓸 "읽어낸 항목" 수. 화면에 실제로 값이 찍히는 항목만 센다.
  const 읽은항목수 = extracted
    ? Object.values(extracted).filter((value) => hasExtractedDisplayValue(value)).length
    : 0;

  return (
    <div className="context-panel">
      <header className="context-head">
        <div>
          <p className="eyebrow">현장 맥락 관리</p>
          <h1>문서를 올리면 읽고 나눠서 저장합니다</h1>
          <p className="context-sub">
            문서 구조와 항목을 읽고, 검색할 수 있게 잘라 현장별 문서함에 저장합니다.
          </p>
        </div>
        <div className="mode-toggle" role="group" aria-label="분석 모드">
          {(["live", "demo"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={mode === value ? "is-active" : ""}
              onClick={() => setMode(value)}
            >
              {value === "live" ? "라이브" : "데모"}
            </button>
          ))}
        </div>
        </header>

      {mode === "demo" ? (
        <p className="context-demo-note">
          데모 모드입니다. 올린 파일은 화면에 그대로 보이지만 <b>분석 결과는 미리 준비해 둔 고정
          예시</b>이고 올린 파일을 실제로 읽지 않습니다. 고정 결과는 문서함에 저장하지 않습니다.
        </p>
      ) : null}

      <section className="context-upload">
        <label>
          문서 종류
          <select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
            {INGEST_DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              void upload(file);
            }
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="upload-button"
          disabled={phase === "running"}
          onClick={() => fileInput.current?.click()}
        >
          {phase === "running" ? "분석 중…" : "PDF 업로드"}
        </button>
        {fileName ? <span className="context-filename">{fileName}</span> : null}
      </section>

      {mode === "demo" && liveDisabled && demoRetryFile ? (
        <button type="button" className="upload-button" onClick={() => void upload(demoRetryFile, "demo")}>
          이 파일로 데모 보기
        </button>
      ) : null}

      {phase !== "idle" ? (
        <section className="context-analysis">
          <div className="context-preview">
            {previewUrl ? (
              <iframe src={previewUrl} title="올린 문서" />
            ) : (
              <p className="context-empty">미리볼 문서가 없습니다.</p>
            )}
          </div>

          {layout?.요소?.length ? (
            <div className="context-regions">
              <h2>읽어낸 영역</h2>
              <ParseOverlay
                regions={layout.요소}
                agent={layout.agent ?? null}
                activeId={activeRegion}
                onHover={setActiveRegion}
              />
            </div>
          ) : null}

          <ol className="stage-list">
            {stages.map((stage) => (
              <li key={stage.이름} className={`stage stage--${stage.상태}`}>
                <span className="stage-name">{단계이름[stage.이름]}</span>
                <span className="stage-hint">{단계설명[stage.이름] ?? ""}</span>
                <span className="stage-meta">
                  {stage.상태 === "실행중" ? "실행 중" : seconds(stage.소요ms)}
                </span>
                {stage.실패사유 ? <p className="stage-error">{stage.실패사유}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {extracted ? (
        <section className="context-extracted">
          <h2>읽어낸 값</h2>
          <dl>
            {Object.entries(extracted)
              .filter(([, value]) => hasExtractedDisplayValue(value))
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{formatExtractedField(key, value)}</dd>
                </div>
              ))}
          </dl>

          {chunkPreview ? (
            <p className="context-note">검색 조각 {chunkPreview.청크수}개로 나눴습니다.</p>
          ) : null}
        </section>
      ) : null}

      {phase === "done" && ranAsDemo ? (
        <section className="context-save">
          <p className="context-note">
            데모(고정 예시) · 올린 파일은 분석하지 않았습니다. 이 결과는 저장되지 않습니다.
          </p>
          {text(execution?.source) === "recorded" && text(siteVerdict?.name) ? (
            <p className="context-note">
              녹화된 현장 판정: {text(siteVerdict?.name)}
              {text(siteVerdict?.code) ? ` (${text(siteVerdict?.code)})` : ""}
              {typeof siteVerdict?.confidence === "number"
                ? ` · 확신 ${Math.round(siteVerdict.confidence * 100)}%`
                : ""}
              {text(siteVerdict?.reason) ? ` · ${text(siteVerdict?.reason)}` : ""}
              <br />올린 파일이 아니라 녹화 원본의 판정이며, 읽기 전용입니다.
            </p>
          ) : null}
          <details className="context-note context-tech">
            <summary>기술 정보</summary>
            <dl>
              <div>
                <dt>예시 종류</dt>
                <dd>{text(execution?.source) === "recorded" ? "미리 녹화한 응답" : "직접 만든 예시"}</dd>
              </div>
              <div>
                <dt>선택한 문서 종류</dt>
                <dd>{text(execution?.selectedKind) ?? kind}</dd>
              </div>
              {text(execution?.recordedAt) ? (
                <div>
                  <dt>기록 시각</dt>
                  <dd>{text(execution?.recordedAt)}</dd>
                </div>
              ) : null}
              {text(execution?.agent) ? (
                <div>
                  <dt>원본 에이전트</dt>
                  <dd>{text(execution?.agent)}</dd>
                </div>
              ) : null}
              {text(execution?.requestedConfigId) ? (
                <div>
                  <dt>요청 구성</dt>
                  <dd>{text(execution?.requestedConfigId)}</dd>
                </div>
              ) : null}
              <div>
                <dt>문서 분석 호출</dt>
                <dd>{upstageCalls}회</dd>
              </div>
            </dl>
          </details>
        </section>
      ) : null}

      {phase === "done" && !ranAsDemo ? (
        <section className="context-save">
          <p className="context-note" aria-live="polite">
            실제 분석 · 항목 {읽은항목수}건을 읽었습니다.
          </p>
          {execution ? (
            <details className="context-note context-tech">
              <summary>기술 정보</summary>
              <dl>
                <div>
                  <dt>실행 방식</dt>
                  <dd>{text(execution.mode) ?? "기존 실행"}</dd>
                </div>
                {text(execution.source) ? (
                  <div>
                    <dt>출처</dt>
                    <dd>{text(execution.source)}</dd>
                  </div>
                ) : null}
                {text(execution.agent) ? (
                  <div>
                    <dt>처리 에이전트</dt>
                    <dd>{text(execution.agent)}</dd>
                  </div>
                ) : null}
                {text(execution.requestedConfigId) ? (
                  <div>
                    <dt>요청 구성</dt>
                    <dd>{text(execution.requestedConfigId)}</dd>
                  </div>
                ) : null}
                {text(record(execution.boundByReceipt)?.id) ? (
                  <div>
                    <dt>준비 확인</dt>
                    <dd>{text(record(execution.boundByReceipt)?.id)}</dd>
                  </div>
                ) : null}
                {text(execution.servedIdentity) ? (
                  <div>
                    <dt>응답 에이전트</dt>
                    <dd>{text(execution.servedIdentity)}</dd>
                  </div>
                ) : null}
                {text(execution.fingerprint) ? (
                  <div>
                    <dt>지문</dt>
                    <dd>{text(execution.fingerprint)}</dd>
                  </div>
                ) : null}
                {text(execution.response ?? execution.responseId) ? (
                  <div>
                    <dt>응답</dt>
                    <dd>{text(execution.response ?? execution.responseId)}</dd>
                  </div>
                ) : null}
                {text(execution.cleanup ?? execution.cleanupStatus) ? (
                  <div>
                    <dt>원본 파일 정리</dt>
                    <dd>{text(execution.cleanup ?? execution.cleanupStatus)}</dd>
                  </div>
                ) : null}
                {stringList(execution.steps ?? execution.studioSteps).length > 0 ? (
                  <>
                    <div>
                      <dt>처리 단계</dt>
                      <dd>{stringList(execution.steps ?? execution.studioSteps).join(" → ")}</dd>
                    </div>
                    <div>
                      <dt>검증·리뷰</dt>
                      <dd>앱에서 수행</dd>
                    </div>
                  </>
                ) : null}
                <div>
                  <dt>문서 분석 호출</dt>
                  <dd>{upstageCalls}회</dd>
                </div>
              </dl>
            </details>
          ) : null}
          {cleanupBlocksSave(execution) ? (
            <p className="context-message">
              이 분석이 끝까지 정상으로 처리됐는지 확인되지 않아 문서함에 저장할 수 없습니다. 다시
              업로드해 주세요.
            </p>
          ) : null}
          <label>
            저장할 현장
            <select value={chosenSiteId} onChange={(e) => setChosenSiteId(e.target.value)}>
              <option value="">현장을 골라 주세요</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <p className="context-note">
            {recommendation
              ? recommendation.reason
              : "문서에서 현장명을 찾지 못했습니다. 직접 골라 주세요."}
          </p>
          <button type="button" className="upload-button" disabled={!chosenSiteId || saving || cleanupBlocksSave(execution)} onClick={save}>
            {saving ? "저장 중…" : "문서함에 저장"}
          </button>
        </section>
      ) : null}

      {message ? <p className="context-message">{message}</p> : null}

      {kindFilter === "" || kindFilter === "메일" ? (
        <section className="context-mail">
          <header>
            <h2>메일함</h2>
          </header>

          {mailThreads.length === 0 ? (
            <p className="context-empty">이 현장으로 분류된 메일이 없습니다.</p>
          ) : (
            <ul className="mail-list">
              {mailThreads.map((thread) => {
                const open = openedThread === thread.id;
                const attachmentCount = thread.messages.reduce((n, m) => n + m.첨부.length, 0);
                return (
                  <li key={thread.id} className={`mail-thread${open ? " is-open" : ""}`}>
                    <button
                      type="button"
                      className="mail-thread-head"
                      aria-expanded={open}
                      onClick={() => setOpenedThread(open ? null : thread.id)}
                    >
                      <span className="mail-subject">
                        {thread.안읽음 ? <span className="mail-dot" aria-label="안 읽음" /> : null}
                        {thread.제목}
                      </span>
                      <span className="mail-meta">
                        <span className={`mail-state mail-state--${THREAD_STATE_SLUG[thread.상태]}`}>
                          {thread.상태}
                        </span>
                        <span>{thread.siteName}</span>
                        <span>메일 {thread.messages.length}통</span>
                        {attachmentCount > 0 ? <span>첨부 {attachmentCount}개</span> : null}
                        <span>{mailStamp(thread.마지막수신)}</span>
                      </span>
                    </button>

                    {open ? (
                      <div className="mail-thread-body">
                        <p className="context-note">{thread.판정메모}</p>

                        <ol className="mail-messages">
                          {thread.messages.map((m) => (
                            <li key={m.id} className="mail-message">
                              <p className="mail-message-head">
                                <span className="mail-from">{m.발신자.이름}</span>
                                <span className="mail-address">{m.발신자.주소}</span>
                                <span className="mail-time">{mailStamp(m.보낸시각)}</span>
                              </p>
                              <p className="mail-recipients">
                                받는 사람 {m.수신.join(", ")}
                                {m.참조.length > 0 ? ` · 참조 ${m.참조.join(", ")}` : ""}
                              </p>
                              <p className="mail-body">{m.본문}</p>
                              {m.첨부.length > 0 ? (
                                <ul className="mail-attachments">
                                  {m.첨부.map((a) => (
                                    <li key={a.id}>
                                      {/* 문서함에 적재된 첨부는 원본이 있으므로 문서 뷰어로,
                                          아직 없는 첨부는 목업 미리보기로 연다. */}
                                      <button
                                        type="button"
                                        className="mail-file"
                                        onClick={() => {
                                          if (a.documentId) {
                                            setOpenedDocument(a.documentId);
                                            return;
                                          }
                                          setOpenedAttachment({
                                            attachment: a,
                                            siteName: thread.siteName,
                                          });
                                        }}
                                      >
                                        {a.이름}
                                      </button>
                                      <span className="mail-file-meta">
                                        {a.쪽수}쪽 · {a.종류}
                                      </span>
                                      <span
                                        className={`mail-attach mail-attach--${ATTACH_STATE_SLUG[a.상태]}`}
                                      >
                                        {a.상태}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </li>
                          ))}
                        </ol>

                        {thread.추출 ? (
                          <div className="mail-extracted">
                            <h3>읽어낸 값</h3>
                            <dl>
                              {Object.entries(thread.추출)
                                .filter(([, value]) =>
                                  Array.isArray(value) ? value.length > 0 : Boolean(value),
                                )
                                .map(([key, value]) => (
                                  <div key={key}>
                                    <dt>{key}</dt>
                                    <dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
                                  </div>
                                ))}
                            </dl>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {/* 문서함 바로 위에 둔다. 적재한 것을 "무엇으로 쓸 수 있는지"가 목록보다 먼저 와야 한다. */}
      <ContextSearch sites={sites} />

      <section className="context-library">
        <header>
          <h2>문서함</h2>
          <div className="context-filters">
            <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
              <option value="">전체 현장</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="">전체 종류</option>
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
        </header>

        {documents.length === 0 ? (
          <p className="context-empty">저장된 문서가 없습니다.</p>
        ) : (
          <table className="context-table">
            <thead>
              <tr>
                <th>현장</th>
                <th>종류</th>
                <th>제목</th>
                <th>쪽</th>
                <th>검색 조각</th>
                <th>원본</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.site_name}</td>
                  <td>{doc.kind}</td>
                  <td>
                    <button
                      type="button"
                      className="context-doc-title"
                      onClick={() => setOpenedDocument(doc.id)}
                    >
                      {doc.title}
                    </button>
                  </td>
                  <td>{doc.page_count ?? "-"}</td>
                  <td>{doc.chunk_count}</td>
                  <td>
                    <button
                      type="button"
                      className="context-doc-open"
                      onClick={() => setOpenedDocument(doc.id)}
                    >
                      열기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {openedDocument ? (
        <DocumentViewer
          key={openedDocument}
          documentId={openedDocument}
          onClose={() => setOpenedDocument(null)}
        />
      ) : null}

      {openedAttachment ? (
        <MailAttachmentViewer
          key={openedAttachment.attachment.id}
          attachment={openedAttachment.attachment}
          siteName={openedAttachment.siteName}
          onClose={() => setOpenedAttachment(null)}
        />
      ) : null}
    </div>
  );
}
