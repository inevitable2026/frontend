"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  DOCUMENT_KINDS,
  STAGE_ORDER,
  type DocumentKind,
  type ExtractedFields,
  type IngestEvent,
  type IngestStage,
  type SiteRecommendation,
  type StageName,
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

const STAGE_HINT: Record<StageName, string> = {
  수신: "파일 접수",
  레이아웃분석: "Upstage Document Parse",
  "표·서명인식": "표 구조 · 서명 영역",
  필드추출: "Upstage Information Extract",
  프로젝트판정: "현장 자동 매칭",
  청킹: "검색 단위로 분할",
  임베딩: "Upstage Embedding",
  색인: "Vector DB 적재",
};

function seconds(ms: number | null): string {
  if (ms == null) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}초`;
}

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

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  async function upload(file: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setFileName(file.name);
    setPhase("running");
    setStages(emptyStages());
    setRecommendation(null);
    setChosenSiteId("");
    setUpstageCalls(0);
    setMessage(null);
    setRanAsDemo(mode === "demo");

    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    form.append("mode", mode);

    const created = await fetch("/api/context/ingest", { method: "POST", body: form });
    const body = await created.json();
    if (!created.ok) {
      setPhase("failed");
      setMessage(body.error ?? "업로드에 실패했습니다.");
      return;
    }
    setJobId(body.jobId);
    await consume(body.jobId);
  }

  async function consume(id: string) {
    const res = await fetch(`/api/context/ingest/${id}/stream`);
    if (!res.ok || !res.body) {
      setPhase("failed");
      setMessage("진행 스트림을 열지 못했습니다.");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (!block.startsWith("data: ")) continue;
        apply(JSON.parse(block.slice(6)) as IngestEvent);
      }
    }
  }

  function apply(event: IngestEvent) {
    if (event.종류 === "단계") {
      setStages((prev) => prev.map((s) => (s.이름 === event.단계.이름 ? event.단계 : s)));
      return;
    }
    if (event.종류 === "완료") {
      setPhase("done");
      setUpstageCalls(event.upstageCalls);
      setRecommendation(event.추천);
      if (event.추천) setChosenSiteId(event.추천.siteId);
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
      setMessage(body.error ?? "저장에 실패했습니다.");
      return;
    }
    setMessage(`${body.siteName} 문서함에 청크 ${body.chunkCount}개를 저장했습니다.`);
    setPhase("idle");
    setJobId(null);
    setStages(emptyStages());
    await Promise.all([loadSites(), loadDocuments()]);
  }

  const extracted = stages.find((s) => s.이름 === "필드추출")?.산출 as ExtractedFields | undefined;
  const chunkPreview = stages.find((s) => s.이름 === "청킹")?.산출 as
    | { 청크수: number; 미리보기: Array<{ seq: number; page: number; text: string }> }
    | undefined;

  return (
    <div className="context-panel">
      <header className="context-head">
        <div>
          <p className="eyebrow">현장 맥락 관리</p>
          <h1>문서를 올리면 읽고 나눠서 저장합니다</h1>
          <p className="context-sub">
            Upstage 가 레이아웃과 필드를 읽고, 검색 단위로 잘라 현장별 Vector DB 에 넣습니다.
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
          데모 모드입니다. 올린 파일은 화면에 그대로 보이지만 <b>분석 결과는 미리 녹화해 둔 고정
          응답</b>이고 Upstage 를 호출하지 않습니다. 고정 결과는 문서함에 저장하지 않습니다.
        </p>
      ) : null}

      <section className="context-upload">
        <label>
          문서 종류
          <select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
            {DOCUMENT_KINDS.map((k) => (
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
            if (file) void upload(file);
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

      {phase !== "idle" ? (
        <section className="context-analysis">
          <div className="context-preview">
            {previewUrl ? (
              <iframe src={previewUrl} title="올린 문서" />
            ) : (
              <p className="context-empty">문서 미리보기</p>
            )}
          </div>

          <ol className="stage-list">
            {stages.map((stage) => (
              <li key={stage.이름} className={`stage stage--${stage.상태}`}>
                <span className="stage-name">{stage.이름}</span>
                <span className="stage-hint">{STAGE_HINT[stage.이름]}</span>
                <span className="stage-meta">
                  {stage.상태 === "실행중" ? "실행중" : seconds(stage.소요ms)}
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
              .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
                </div>
              ))}
          </dl>
          {chunkPreview ? <p className="context-note">청크 {chunkPreview.청크수}개로 나눴습니다.</p> : null}
        </section>
      ) : null}

      {phase === "done" && ranAsDemo ? (
        <section className="context-save">
          <p className="context-note">
            데모 모드 결과라 저장하지 않습니다. Upstage 호출 {upstageCalls}회 —
            네트워크를 타지 않았다는 뜻입니다. 실제로 문서함에 넣으려면 라이브 모드로 다시 올리세요.
          </p>
        </section>
      ) : null}

      {phase === "done" && !ranAsDemo ? (
        <section className="context-save">
          <label>
            저장할 현장
            <select value={chosenSiteId} onChange={(e) => setChosenSiteId(e.target.value)}>
              <option value="">현장을 고르세요</option>
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
              : "문서에서 현장명을 찾지 못했습니다. 직접 고르세요."}
            {upstageCalls > 0 ? ` · Upstage 호출 ${upstageCalls}회` : " · Upstage 호출 0회"}
          </p>
          <button type="button" className="upload-button" disabled={!chosenSiteId || saving} onClick={save}>
            {saving ? "저장 중…" : "문서함에 저장"}
          </button>
        </section>
      ) : null}

      {message ? <p className="context-message">{message}</p> : null}

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
                <th>청크</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.site_name}</td>
                  <td>{doc.kind}</td>
                  <td>{doc.title}</td>
                  <td>{doc.page_count ?? "-"}</td>
                  <td>{doc.chunk_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
