"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import AgentPanel, { type 패널상태, type 필드 } from "@/components/risk/agent-panel";
import RiskQueue, { 위험성평가카드인가 } from "@/components/risk/risk-queue";
import RiskTable from "@/components/risk/risk-table";
import RiskWorkspace from "@/components/risk/risk-workspace";
import type { BoardPage, WorkItem } from "@/lib/board/types";
import { MATRICES, type Assessment, type SourceDoc, type 생성모드, type 어휘 } from "@/lib/risk/types";

/**
 * 위험성평가 — 문서·사진을 올리면 읽고, 그 결과로 평가표를 만들고, 현장에서 체크한다.
 *
 * 형제 탭(`site-context-panel.tsx`)의 구조를 따른다: header + mode-toggle → 업로드 →
 * 분석 → 결과. 같은 콘솔 안에서 탭마다 다르게 동작하면 쓰는 사람이 매번 다시 배워야 한다.
 *
 * **데모와 라이브의 차이는 생성에만 있다.** 문서 파싱은 어느 쪽이든 진짜로 돈다 —
 * 올린 PDF 가 화면에 뜨는데 분석만 가짜면 그 표가 어느 문서에서 나왔는지 답할 수 없다.
 */

/** 어휘 조회가 실패해도 화면이 멈추지 않게 하는 최소 목록. */
const 기본어휘: 어휘 = {
  industries: [{ value: "건축공사", label: "건축공사" }],
  methods: ["빈도·강도법"],
  matrices: [...MATRICES],
  equipment: [],
  materials: [],
  criteria: { occurrence_cycles: [], damage_levels: [], past_fatality: [] },
};

type 분석패널 = {
  키: string;
  이름: string;
  엔진: string;
  상태: 패널상태;
  소요: number | null;
  필드들: 필드[];
  미리보기: string | null;
  mime: string;
  메모?: string;
};

/** 사진은 원본이 3~8MB 라 그대로 올리면 요청 상한에 걸린다. 네트워크를 타기 전에 줄인다. */
async function 사진줄이기(file: File, 최대변 = 1280): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const 비율 = Math.min(1, 최대변 / Math.max(bitmap.width, bitmap.height));
  if (비율 >= 1) return file;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * 비율);
  canvas.height = Math.round(bitmap.height * 비율);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.82));
  return blob ? new File([blob], file.name, { type: "image/jpeg" }) : file;
}

function 문서필드(r: Record<string, unknown>): 필드[] {
  const 목록 = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
  return [
    { 이름: "업체", 값: String(r.company ?? "") },
    { 이름: "현장", 값: String(r.site ?? "") },
    { 이름: "공종", 값: 목록(r.work_types) },
    { 이름: "장비", 값: 목록(r.equipment) },
    { 이름: "자재", 값: 목록(r.materials) },
  ].filter((f) => f.값);
}

/**
 * 태스크 보드가 지금 쓰는 현장. 보드 컴포넌트의 `SITE_ID` 와 같은 값이다
 * (`components/task-board/task-board.tsx:26`).
 *
 * 현장 목록 API 가 Postgres 를 타는데 보드는 JSON 저장소로 돌기 때문에, DB 가 없는
 * 환경에서도 대기열이 비지 않으려면 알고 있는 현장 하나가 필요하다. 목록이 오면 이건 안 쓴다.
 */
const 보드기본현장 = [{ id: "site_gimpo_gochon_01", name: "김포 고촌 현장" }];

/** 이 탭이 지금 무엇을 보이고 있는가. 대기열이 기본이다. */
type 화면 = "대기열" | "작업장" | "새평가";

export function RiskAssessmentPanel() {
  const [화면, set화면] = useState<화면>("대기열");
  const [대기열, set대기열] = useState<WorkItem[]>([]);
  const [현장이름, set현장이름] = useState<Map<string, string>>(new Map());
  const [대기열로딩, set대기열로딩] = useState(true);
  // 기한 판정의 기준 시각. 대기열을 읽을 때 한 번 잡고 렌더 중에는 다시 재지 않는다.
  const [기준시각, set기준시각] = useState(0);
  const [고른카드, set고른카드] = useState<WorkItem | null>(null);

  const [모드, set모드] = useState<생성모드>("데모");
  const [어휘, set어휘] = useState<어휘>(기본어휘);

  const [패널들, set패널들] = useState<분석패널[]>([]);
  const [문서근거, set문서근거] = useState<SourceDoc[]>([]);
  const [현장, set현장] = useState<string>("");

  const [공종, set공종] = useState<string[]>([]);
  const [장비, set장비] = useState<string[]>([]);
  const [자재, set자재] = useState<string[]>([]);
  const [사진단서, set사진단서] = useState<string[]>([]);
  const [매트릭스, set매트릭스] = useState<string>("4x3");
  const [평가방법, set평가방법] = useState<string>("빈도·강도법");

  const [생성중, set생성중] = useState(false);
  const [저장중, set저장중] = useState(false);
  const [오류, set오류] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);

  const 문서입력 = useRef<HTMLInputElement>(null);
  const 사진입력 = useRef<HTMLInputElement>(null);
  const 카메라입력 = useRef<HTMLInputElement>(null);
  const 저장타이머 = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 미리보기 URL 은 컴포넌트가 사라질 때 반드시 회수한다. 안 하면 페이지를 오래 열어 둘수록 샌다.
  const 미리보기들 = useRef<string[]>([]);

  useEffect(() => {
    fetch("/api/risk/vocabulary")
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (v && !v.error) set어휘(v as 어휘);
      })
      .catch(() => {
        /* 어휘를 못 읽었다고 평가를 막을 이유는 없다. 기본 목록으로 버틴다. */
      });
    const urls = 미리보기들.current;
    const 타이머 = 저장타이머;
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      if (타이머.current) clearTimeout(타이머.current);
    };
  }, []);

  /**
   * 대기열을 채운다. **감지는 여기서 하지 않는다** — 태스크 보드가 이미 만들어 둔
   * 카드를 현장별로 읽어 위험성평가에 해당하는 것만 고른다. 출처가 하나여야
   * 두 화면이 서로 다른 말을 하지 않는다.
   *
   * 보드 API 는 `siteId` 를 필수로 요구한다(다른 현장 카드가 섞이면 담당자 이름과
   * 하도급사 상호가 그대로 노출되기 때문이다). 그래서 현장을 먼저 읽고 현장마다 부른다.
   */
  useEffect(() => {
    let 살아있음 = true;

    (async () => {
      try {
        // 현장 목록은 Postgres 에서 온다. 그런데 태스크 보드는 지금 JSON 저장소로 돌아서
        // DB 가 없어도 카드가 있다. 현장 조회 실패가 대기열을 통째로 비우면 안 된다 —
        // 실제로 그렇게 만들었다가 "손볼 것 없음"이 거짓으로 떴다.
        const sites = await fetch("/api/context/sites")
          .then((r) => (r.ok ? (r.json() as Promise<{ sites: Array<{ id: string; name: string }> }>) : null))
          .then((v) => v?.sites ?? [])
          .catch(() => []);
        if (!살아있음) return;

        const 목록 = sites.length > 0 ? sites : 보드기본현장;
        set현장이름(new Map(목록.map((s) => [s.id, s.name])));

        // 한 현장이 실패해도 나머지 대기열은 보여야 한다.
        const 결과 = await Promise.allSettled(
          목록.map((s) =>
            fetch(`/api/board/items?siteId=${encodeURIComponent(s.id)}`).then((r) =>
              r.ok ? (r.json() as Promise<BoardPage>) : Promise.reject(new Error(String(r.status))),
            ),
          ),
        );
        if (!살아있음) return;

        const 카드 = 결과
          .filter((r): r is PromiseFulfilledResult<BoardPage> => r.status === "fulfilled")
          .flatMap((r) => r.value.items)
          .filter(위험성평가카드인가);
        set대기열(카드);
        set기준시각(Date.now());
      } catch {
        // 대기열을 못 읽는 것과 대기열이 비어 있는 것은 다르다. 빈 목록으로 두고
        // 새 평가 경로는 계속 열어 둔다.
        if (살아있음) set대기열([]);
      } finally {
        if (살아있음) set대기열로딩(false);
      }
    })();

    return () => {
      살아있음 = false;
    };
  }, []);

  const 미리보기만들기 = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    미리보기들.current.push(url);
    return url;
  }, []);

  /** 문서를 올리면 한 장에 패널 하나. 한 장이 실패해도 나머지는 자기 결과를 보여준다. */
  async function 문서올리기(files: FileList | null) {
    if (!files?.length) return;
    set오류(null);
    const 목록 = Array.from(files);

    const 신규: 분석패널[] = 목록.map((f) => ({
      키: `doc-${f.name}-${f.size}`,
      이름: f.name,
      엔진: "upstage",
      상태: "실행중" as 패널상태,
      소요: null,
      필드들: [],
      미리보기: 미리보기만들기(f),
      mime: f.type || "application/pdf",
    }));
    set패널들((p) => [...p, ...신규]);

    await Promise.allSettled(
      목록.map(async (f, i) => {
        const 시작 = performance.now();
        const fd = new FormData();
        fd.append("종류", "문서");
        fd.append("files", f, f.name);
        try {
          const res = await fetch("/api/risk/ingest", { method: "POST", body: fd });
          const body = await res.json();
          const 소요 = performance.now() - 시작;
          if (!res.ok) throw new Error(body?.error ?? `문서 파싱 실패 (${res.status})`);

          const r = body.결과 as Record<string, unknown>;
          set패널들((p) =>
            p.map((x) =>
              x.키 === 신규[i].키
                ? { ...x, 상태: "완료", 소요, 엔진: String(r.engine ?? "upstage"), 필드들: 문서필드(r) }
                : x,
            ),
          );
          // 뽑아낸 값을 입력에 합친다. 사용자가 지운 것을 되살리지 않도록 합집합만 만든다.
          set공종((v) => Array.from(new Set([...v, ...((r.work_types as string[]) ?? [])])));
          set장비((v) => Array.from(new Set([...v, ...((r.equipment as string[]) ?? [])])));
          set자재((v) => Array.from(new Set([...v, ...((r.materials as string[]) ?? [])])));
          if (r.site) set현장((v) => v || String(r.site));
          // 근거를 버리지 않는다 — 나중에 "이 표가 어느 문서에서 나왔나" 에 답할 유일한 수단이다.
          set문서근거((v) => [
            ...v,
            { filename: f.name, extracted_at: new Date().toISOString(), engine: String(r.engine ?? ""), fields: r },
          ]);
        } catch (err) {
          const 소요 = performance.now() - 시작;
          set패널들((p) =>
            p.map((x) =>
              x.키 === 신규[i].키 ? { ...x, 상태: "실패", 소요, 메모: (err as Error).message } : x,
            ),
          );
        }
      }),
    );
  }

  async function 사진올리기(files: FileList | null) {
    if (!files?.length) return;
    set오류(null);
    const 원본 = Array.from(files);
    const 줄인것 = await Promise.all(원본.map((f) => 사진줄이기(f)));

    const 키 = `photo-${Date.now()}`;
    set패널들((p) => [
      ...p,
      {
        키,
        이름: `현장 사진 ${원본.length}장`,
        엔진: "vision",
        상태: "실행중",
        소요: null,
        필드들: [],
        미리보기: 미리보기만들기(원본[0]),
        mime: 원본[0].type || "image/jpeg",
      },
    ]);

    const 시작 = performance.now();
    const fd = new FormData();
    fd.append("종류", "사진");
    줄인것.forEach((f) => fd.append("files", f, f.name));

    try {
      const res = await fetch("/api/risk/ingest", { method: "POST", body: fd });
      const body = await res.json();
      const 소요 = performance.now() - 시작;
      if (!res.ok) throw new Error(body?.error ?? `사진 판독 실패 (${res.status})`);

      const r = body.결과 as Record<string, unknown>;
      const 단서 = (r.photo_findings as string[]) ?? [];
      set패널들((p) =>
        p.map((x) =>
          x.키 === 키
            ? {
                ...x,
                상태: "완료",
                소요,
                엔진: String(r.engine ?? "vision"),
                필드들: [
                  { 이름: "장면", 값: ((r.scenes as string[]) ?? []).join(", ") },
                  { 이름: "미착용", 값: ((r.ppe_missing as string[]) ?? []).join(", ") },
                  { 이름: "공종", 값: ((r.work_types as string[]) ?? []).join(", ") },
                ].filter((f) => f.값),
                메모: 단서[0],
              }
            : x,
        ),
      );
      set사진단서((v) => [...v, ...단서]);
      set공종((v) => Array.from(new Set([...v, ...((r.work_types as string[]) ?? [])])));
      set장비((v) => Array.from(new Set([...v, ...((r.equipment as string[]) ?? [])])));
    } catch (err) {
      const 소요 = performance.now() - 시작;
      set패널들((p) =>
        p.map((x) => (x.키 === 키 ? { ...x, 상태: "실패", 소요, 메모: (err as Error).message } : x)),
      );
    }
  }

  async function 생성하기() {
    set생성중(true);
    set오류(null);
    try {
      const res = await fetch("/api/risk/assess", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          모드,
          work_types: 공종,
          equipment: 장비,
          materials: 자재,
          photo_findings: 사진단서,
          matrix: 매트릭스,
          method: 평가방법,
          site: 현장 || null,
          source_documents: 문서근거,
        }),
      });
      const body = await res.json();
      // 실패를 표로 덮지 않는다. 라이브가 실패했으면 그렇게 말한다.
      if (!res.ok) throw new Error(body?.error ?? `생성 실패 (${res.status})`);
      setAssessment(body.assessment as Assessment);
    } catch (err) {
      set오류((err as Error).message);
    } finally {
      set생성중(false);
    }
  }

  /**
   * 이행확인 수정. 화면 상태만 바꾸면 안 된다 — 엑셀은 저쪽이 만들고 이행확인 열을
   * 저쪽 DB 에서 읽으므로, 보내지 않으면 내려받은 파일이 빈칸이다.
   *
   * **반드시 함수형 갱신을 쓴다.** 처음에 평가 전체를 받아 그대로 저장했더니,
   * 체크를 빠르게 두 번 누르면 두 번째가 렌더 시점의 낡은 값으로 계산돼 첫 번째를
   * 덮어썼다 — 눌렀는데 체크가 안 남는다. 병합은 여기서, 최신 상태 위에서 한다.
   */
  /**
   * 저장을 모아서 보낸다. 담당자 이름은 글자마다 onChange 가 나므로 그대로 두면
   * 한 글자에 한 번씩 PATCH 가 날아간다. 저쪽은 전체 payload 치환이라 순서가 뒤집히면
   * 먼저 보낸 값이 나중에 도착해 덮어쓸 수도 있다.
   */
  const 저장예약 = useCallback((next: Assessment) => {
    if (저장타이머.current) clearTimeout(저장타이머.current);
    set저장중(true);
    저장타이머.current = setTimeout(() => void 저장하기(next), 600);
  }, []);

  const 수정 = useCallback(
    (index: number, patch: Partial<Assessment["hazards"][number]>) => {
      setAssessment((prev) => {
        if (!prev) return prev;
        // 배열 순서로 찾는다. 스키마에 행 번호 필드가 없다 — 있을 거라 짐작하고
        // `h.no === no` 로 찾다가, 전부 undefined 라 한 행을 고치면 아홉 행이 다 바뀌었다.
        const next = {
          ...prev,
          hazards: prev.hazards.map((h, i) => (i === index ? { ...h, ...patch } : h)),
        };
        저장예약(next);
        return next;
      });
    },
    [저장예약],
  );

  async function 저장하기(next: Assessment) {
    if (!next.id) {
      set저장중(false);
      return;
    }
    try {
      const res = await fetch(`/api/risk/${next.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        set오류(body?.error ?? "이행확인을 저장하지 못했습니다.");
      }
    } catch (err) {
      set오류((err as Error).message);
    } finally {
      set저장중(false);
    }
  }

  const 입력있음 = 공종.length > 0 || 장비.length > 0 || 자재.length > 0;

  // 작업장 — 대기열에서 고른 카드를 연 상태.
  if (화면 === "작업장" && 고른카드) {
    return (
      <div className="risk-panel">
        <RiskWorkspace
          item={고른카드}
          현장이름={현장이름.get(고른카드.siteId) ?? 고른카드.siteId}
          닫기={() => {
            set화면("대기열");
            set고른카드(null);
          }}
          승인={() => {
            // 지금은 화면 안에서만 잠근다. 서버 반영은 보드의 승인 경로를 쓰는 것이
            // 맞는데, 그쪽 계약을 확인하기 전까지 여기서 임의로 PATCH 하지 않는다 —
            // 두 곳이 같은 카드를 다르게 바꾸면 보드와 이 화면이 어긋난다.
          }}
        />
      </div>
    );
  }

  // 대기열 — 이 탭의 첫 화면.
  if (화면 === "대기열") {
    return (
      <div className="risk-panel">
        <header className="risk-head">
          <div>
            <p className="eyebrow">위험성평가</p>
            <h1>지금 손봐야 할 것</h1>
            <p className="risk-sub">
              태스크 보드가 찾아낸 조건 가운데 위험성평가에 해당하는 것입니다. 여기서 열어
              행 단위로 승인하면 TBM 자료와 공문이 파생됩니다.
            </p>
          </div>
          <button type="button" className="risk-generate" onClick={() => set화면("새평가")}>
            새 평가 만들기
          </button>
        </header>

        <RiskQueue
          항목들={대기열}
          현장이름={현장이름}
          불러오는중={대기열로딩}
          기준시각={기준시각}
          선택={(item) => {
            set고른카드(item);
            set화면("작업장");
          }}
        />
      </div>
    );
  }

  // 새 평가 — 문서·사진을 올려 평가표를 만드는 기존 경로.
  return (
    <div className="risk-panel">
      <header className="risk-head">
        <div>
          <p className="eyebrow">
            <button type="button" className="risk-ws-back" onClick={() => set화면("대기열")}>
              ← 대기열
            </button>
          </p>
          <h1>문서와 사진을 올리면 평가표를 만듭니다</h1>
          <p className="risk-sub">
            Upstage 가 계약서·자재표에서 공종과 장비를 읽고, 위험요인마다 산업안전보건기준에 관한
            규칙 조문을 붙입니다.
          </p>
        </div>
        <div className="mode-toggle" role="group" aria-label="생성 모드">
          {(["라이브", "데모"] as const).map((v) => (
            <button key={v} type="button" className={모드 === v ? "is-active" : ""} onClick={() => set모드(v)}>
              {v}
            </button>
          ))}
        </div>
      </header>

      {모드 === "데모" ? (
        <p className="risk-demo-note">
          데모 모드입니다. <b>문서 분석은 실제로 돕니다</b> — 올린 PDF 를 Upstage 가 읽습니다.
          평가표 생성만 미리 녹화해 둔 고정 응답이라 시연 중 45초를 기다리지 않습니다.
        </p>
      ) : (
        <p className="risk-demo-note is-live">
          라이브 모드입니다. 생성에 <b>45초 안팎</b>이 걸리고, 실패하면 표 대신 실패 사유가
          나옵니다 — 실패를 그럴듯한 표로 덮지 않습니다.
        </p>
      )}

      <section className="risk-upload">
        <button type="button" className="upload-button" onClick={() => 문서입력.current?.click()}>
          문서 올리기 (PDF)
        </button>
        <button type="button" className="upload-button" onClick={() => 사진입력.current?.click()}>
          사진 올리기
        </button>
        <button type="button" className="upload-button is-camera" onClick={() => 카메라입력.current?.click()}>
          현장 촬영
        </button>
        <input
          ref={문서입력}
          className="sr-only"
          type="file"
          accept="application/pdf,image/*"
          multiple
          onChange={(e) => {
            void 문서올리기(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={사진입력}
          className="sr-only"
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => {
            void 사진올리기(e.target.files);
            e.target.value = "";
          }}
        />
        {/* 휴대폰에서 카메라가 바로 열린다. 데스크톱에서는 파일 선택으로 떨어진다. */}
        <input
          ref={카메라입력}
          className="sr-only"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => {
            void 사진올리기(e.target.files);
            e.target.value = "";
          }}
        />
      </section>

      {패널들.length > 0 ? (
        <section className="risk-agents">
          {패널들.map((p) => (
            <AgentPanel key={p.키} {...p} />
          ))}
        </section>
      ) : null}

      <section className="risk-inputs">
        <label>
          현장
          <input type="text" value={현장} placeholder="문서에서 읽어옵니다" onChange={(e) => set현장(e.target.value)} />
        </label>
        <label>
          평가 방법
          <select value={평가방법} onChange={(e) => set평가방법(e.target.value)}>
            {어휘.methods.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          매트릭스
          <select value={매트릭스} onChange={(e) => set매트릭스(e.target.value)}>
            {어휘.matrices.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="risk-chips">
        {[
          { 라벨: "공종", 값: 공종, set: set공종 },
          { 라벨: "장비", 값: 장비, set: set장비 },
          { 라벨: "자재", 값: 자재, set: set자재 },
        ].map(({ 라벨, 값, set }) => (
          <div key={라벨}>
            <span className="eyebrow">{라벨}</span>
            {값.length === 0 ? (
              <p className="risk-chip-empty">아직 없습니다. 문서를 올리면 채워집니다.</p>
            ) : (
              <ul>
                {값.map((v) => (
                  <li key={v}>
                    {v}
                    <button type="button" aria-label={`${v} 빼기`} onClick={() => set(값.filter((x) => x !== v))}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>

      <div className="risk-actions">
        <button type="button" className="risk-generate" disabled={생성중 || !입력있음} onClick={() => void 생성하기()}>
          {생성중 ? (모드 === "라이브" ? "생성 중… (45초 안팎)" : "생성 중…") : "위험성평가표 만들기"}
        </button>
        {!입력있음 ? <span className="risk-hint">공종·장비·자재 중 하나가 필요합니다.</span> : null}
        {assessment?.id ? (
          <a className="risk-export" href={`/api/risk/${assessment.id}/export`}>
            엑셀 내려받기
          </a>
        ) : null}
      </div>

      {오류 ? (
        <p className="risk-error" role="alert">
          {오류}
        </p>
      ) : null}

      {assessment ? <RiskTable assessment={assessment} 수정={수정} 저장중={저장중} /> : null}
    </div>
  );
}
