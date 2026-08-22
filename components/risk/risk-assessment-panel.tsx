"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import AgentPanel, { type 패널상태, type 필드 } from "@/components/risk/agent-panel";
import RiskQueue, { 위험성평가카드인가 } from "@/components/risk/risk-queue";
import RiskRecords from "@/components/risk/risk-records";
import RiskComposer, { type 대화항목 } from "@/components/risk/risk-composer";
import RiskTimeline from "@/components/risk/risk-timeline";
import VocabPicker from "@/components/risk/vocab-picker";
import RiskTable from "@/components/risk/risk-table";
import RiskDocPanel from "@/components/risk/risk-doc-panel";
import { BOARD_SITE_ID, BOARD_SITE_NAME } from "@/lib/board/site";
import { 합치기 } from "@/lib/risk/vocab";
import type { BoardPage, WorkItem } from "@/lib/board/types";
import type { 평가일자 } from "@/lib/risk/safegrid";
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
  work_types: [],
  methods: ["빈도·강도법"],
  matrices: [...MATRICES],
  equipment: [],
  materials: [],
  criteria: { occurrence_cycles: [], damage_levels: [], past_fatality: [] },
};

/**
 * 화면에 적을 실패 문구. 상태 코드·영문 원문은 화면이 아니라 콘솔로 보낸다.
 *
 * 네트워크가 끊기면 `err.message` 는 "Failed to fetch" 다. 그걸 그대로 붙이면
 * 관리자는 무엇을 해야 하는지 알 수 없다. 우리가 쓴 한국어 문장만 그대로 쓴다.
 */
function 실패문구(err: unknown, 기본: string): string {
  const 원문 = err instanceof Error ? err.message.trim() : "";
  return /[가-힣]/.test(원문) ? 원문 : 기본;
}

/** 위험도 산정 기준을 사람이 읽는 말로. 저장 값(`4x3`)은 그대로 두고 표시만 바꾼다. */
function 기준이름(값: string): string {
  const m = /^(\d+)x(\d+)$/.exec(값);
  return m ? `빈도 ${m[1]}단계 × 강도 ${m[2]}단계` : 값;
}

/** 생성 방식 이름. 저장 값은 그대로 두고 화면 표시만 바꾼다. */
const 모드이름: Record<생성모드, string> = {
  라이브: "실제 생성",
  데모: "미리보기",
};

type 분석패널 = {
  키: string;
  이름: string;
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
 * 현장 목록을 못 읽었을 때 기대는 현장 하나. 목록이 오면 이건 안 쓴다.
 *
 * **리터럴을 쓰지 않는다.** 예전에 `"site_gimpo_gochon_01"` 로 박아 두었는데, 그건
 * `data/board/seed-*.json` 이 쓰는 사람이 읽는 이름이고 보드·배지는 `BOARD_SITE_ID`
 * (uuid)를 쓴다. 폴백만 다른 값을 가리키면 현장 목록 조회가 실패한 순간 대기열이
 * 조용히 빈다 — 실패한 것과 손볼 것이 없는 것이 화면에서 똑같아 보인다.
 */
const 보드기본현장 = [{ id: BOARD_SITE_ID, name: BOARD_SITE_NAME }];

/** 이 탭이 지금 무엇을 보이고 있는가. 대기열이 기본이다. */
type 화면 = "대기열" | "타임라인" | "새평가";

export function RiskAssessmentPanel() {
  const [화면, set화면] = useState<화면>("대기열");
  const [대기열, set대기열] = useState<WorkItem[]>([]);
  const [현장이름, set현장이름] = useState<Map<string, string>>(new Map());
  const [대기열로딩, set대기열로딩] = useState(true);
  // 기한 판정의 기준 시각. 대기열을 읽을 때 한 번 잡고 렌더 중에는 다시 재지 않는다.
  const [기준시각, set기준시각] = useState(0);
  const [기록, set기록] = useState<평가일자[]>([]);
  const [기록로딩, set기록로딩] = useState(true);
  const [기록펼침, set기록펼침] = useState(false);
  const [고른카드, set고른카드] = useState<WorkItem | null>(null);
  const [고른현장, set고른현장] = useState<string | null>(null);

  const [모드, set모드] = useState<생성모드>("데모");
  const [어휘, set어휘] = useState<어휘>(기본어휘);

  const [패널들, set패널들] = useState<분석패널[]>([]);
  const [대화, set대화] = useState<대화항목[]>([]);
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
   * 대기열을 읽는다. 보드가 이미 만들어 둔 카드를 현장별로 읽어 위험성평가에 해당하는
   * 것만 고른다. 출처가 하나여야 두 화면이 서로 다른 말을 하지 않는다.
   *
   * 보드 API 는 `siteId` 를 필수로 요구한다(다른 현장 카드가 섞이면 담당자 이름과
   * 하도급사 상호가 그대로 노출되기 때문이다). 그래서 현장을 먼저 읽고 현장마다 부른다.
   *
   * **효과 밖으로 뺀 이유:** 예전에는 이 코드가 `useEffect(..., [])` 안에 갇혀 있어
   * 마운트할 때 딱 한 번만 돌았다. 그래서 카드를 확정하거나 감지를 돌려도 화면이
   * 그대로였다 — 서버는 바뀌었는데 사람이 보기엔 아무 일도 안 일어난 것과 같았다.
   * 낙관적으로 배열에서 빼는 대신 **서버가 말하는 사실**로 다시 그린다.
   */
  const 대기열읽기 = useCallback(async () => {
    try {
      // 현장 목록은 Postgres 에서 온다. 조회 실패가 대기열을 통째로 비우면 안 된다 —
      // 실제로 그렇게 만들었다가 "손볼 것 없음"이 거짓으로 떴다.
      const sites = await fetch("/api/context/sites")
        .then((r) => (r.ok ? (r.json() as Promise<{ sites: Array<{ id: string; name: string }> }>) : null))
        .then((v) => v?.sites ?? [])
        .catch(() => []);

      const 목록 = sites.length > 0 ? sites : 보드기본현장;
      set현장이름(new Map(목록.map((s) => [s.id, s.name])));

      // 한 현장이 실패해도 나머지 대기열은 보여야 한다.
      const 결과 = await Promise.allSettled(
        목록.map((s) =>
          fetch(`/api/board/items?siteId=${encodeURIComponent(s.id)}`, { cache: "no-store" }).then((r) =>
            r.ok ? (r.json() as Promise<BoardPage>) : Promise.reject(new Error(String(r.status))),
          ),
        ),
      );

      const 카드 = 결과
        .filter((r): r is PromiseFulfilledResult<BoardPage> => r.status === "fulfilled")
        .flatMap((r) => r.value.items)
        .filter(위험성평가카드인가);
      set대기열(카드);
      set기준시각(Date.now());
    } catch {
      // 대기열을 못 읽는 것과 대기열이 비어 있는 것은 다르다. 빈 목록으로 두고
      // 새 평가 경로는 계속 열어 둔다.
      set대기열([]);
    } finally {
      set대기열로딩(false);
    }
  }, []);

  /**
   * 지금까지 만든 평가서 목록. **보드 카드와 다른 곳에 있다** —
   * 감지 카드는 보드 저장소에, 만든 평가서는 SAFEGRID 자체 DB 에 있다.
   *
   * 이것도 효과 밖으로 뺀다. `set기록` 을 부르는 곳이 지금까지 **하나도 없어서**,
   * 「위험성평가표 만들기」로 실제로 만든 평가서조차 새로고침 전에는 목록에 안 떴다.
   */
  const 기록읽기 = useCallback(async () => {
    try {
      const v = await fetch("/api/risk/list", { cache: "no-store" }).then((r) =>
        r.ok ? (r.json() as Promise<{ days: 평가일자[] }>) : null,
      );
      if (v?.days) set기록(v.days);
    } catch {
      /* 기록을 못 읽어도 대기열과 새 평가는 계속 쓸 수 있어야 한다. */
    } finally {
      set기록로딩(false);
    }
  }, []);

  // 효과 본문에서 곧장 부르면 `react-hooks` 가 "효과에서 동기적으로 setState 한다"고 본다.
  // 실제로는 await 뒤에서만 바뀌지만 규칙이 그 구분을 못 한다. 규칙을 끄는 것보다 낫다.
  useEffect(() => {
    void (async () => {
      await 대기열읽기();
    })();
  }, [대기열읽기]);

  useEffect(() => {
    void (async () => {
      await 기록읽기();
    })();
  }, [기록읽기]);

  /**
   * 감지를 실제로 돌린다.
   *
   * 이 앱에서 `POST /api/board/detect` 를 부르는 **유일한 자리**다. 지금까지 감지 엔진은
   * 완성돼 있고 검증기도 통과하는데 부르는 사람이 없어서, 화면의 "재평가 필요"는
   * 감지 결과가 아니라 시드가 넣어 둔 카드였다.
   *
   * 실패해도 숫자를 지어내지 않는다 — 사유를 문자열로 돌려주고 화면이 그대로 적는다.
   */
  const 감지돌리기 = useCallback(async (): Promise<{ 감지: number; 생성: number } | string> => {
    const 현장들 = [...현장이름.keys()];
    const 대상 = 현장들.length > 0 ? 현장들 : [BOARD_SITE_ID];
    let 감지수 = 0;
    let 생성수 = 0;

    for (const id of 대상) {
      try {
        const res = await fetch("/api/board/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId: id }),
        });
        const body = (await res.json()) as {
          run?: { detections?: unknown[]; created?: unknown[] };
          error?: string;
        };
        if (!res.ok) {
          console.error("[risk] board detect failed", { siteId: id, status: res.status, error: body.error });
          return "현장을 점검하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
        }
        감지수 += body.run?.detections?.length ?? 0;
        생성수 += body.run?.created?.length ?? 0;
      } catch (e) {
        console.error("[risk] board detect failed", { siteId: id, error: e });
        return "현장을 점검하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
      }
    }

    // 돌린 뒤 목록을 다시 읽는다. 안 그러면 서버는 카드를 만들었는데 화면은 그대로다.
    await 대기열읽기();
    return { 감지: 감지수, 생성: 생성수 };
  }, [현장이름, 대기열읽기]);

  /**
   * 빈 종이에서 시작한다.
   *
   * 예전에는 「새 평가 만들기」가 화면만 바꿨다. 그래서 앞 평가에서 올린 문서로 쌓인
   * 공종·장비·자재가 그대로 남았고, 문서를 올릴수록 합집합이 계속 불어나
   * 장비 14·자재 16 처럼 **아무도 고르지 않은 것들이 골라진 채로** 생성이 돌았다.
   *
   * 열어 둔 미리보기 URL 도 여기서 회수한다. 안 그러면 새 평가를 시작할 때마다 샌다.
   */
  function 새평가시작() {
    미리보기들.current.forEach((u) => URL.revokeObjectURL(u));
    미리보기들.current = [];

    set공종([]);
    set장비([]);
    set자재([]);
    set사진단서([]);
    set패널들([]);
    set대화([]);
    set문서근거([]);
    set현장("");
    setAssessment(null);
    마지막저장본.current = null;
    set오류(null);
    set화면("새평가");
  }

  /** 저장된 평가서를 연다. 새로 만드는 것이 아니라 SAFEGRID 에서 읽어 온다. */
  async function 기록열기(id: string) {
    set오류(null);
    set화면("새평가");
    try {
      const res = await fetch(`/api/risk/${id}`);
      const body = await res.json();
      if (!res.ok) {
        console.error("[risk] assessment fetch failed", { id, status: res.status, error: body?.error });
        throw new Error("평가서를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      }
      const a = body.assessment as Assessment;
      setAssessment(a);
      // 방금 저쪽에서 읽어 온 것이므로 이것이 되돌아갈 자리다.
      마지막저장본.current = a;

      // 평가서가 들고 있는 조건을 입력칸에 되돌려 놓는다.
      //
      // 예전에는 `setAssessment` 만 했다. 그러면 표에는 "철근콘크리트공사 · 절단작업"이
      // 보이는데 위쪽 공종·장비·자재는 **전부 0**이었다 — 화면이 방금 연 평가서를
      // 새 평가처럼 취급하고, 다시 생성하면 그 조건이 통째로 날아갔다.
      set공종(a.work_types ?? []);
      set장비(a.equipment ?? []);
      set자재(a.materials ?? []);
      if (a.matrix) set매트릭스(a.matrix);
      if (a.method) set평가방법(a.method);
      set현장(a.site ?? "");
    } catch (err) {
      set오류(실패문구(err, "평가서를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요."));
    }
  }

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
      상태: "실행중" as 패널상태,
      소요: null,
      필드들: [],
      미리보기: 미리보기만들기(f),
      mime: f.type || "application/pdf",
    }));
    set패널들((p) => [...p, ...신규]);
    // 대화에 "올렸다"를 먼저 남긴다. 결과는 도착하는 대로 뒤에 붙는다.
    set대화((d) => [...d, ...목록.map((f) => ({ 종류: "올림" as const, 파일명: f.name, 크기: f.size }))]);

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
          if (!res.ok) {
            console.error("[risk] doc ingest failed", { file: f.name, status: res.status, error: body?.error });
            throw new Error("문서를 읽지 못했습니다. 파일을 확인하고 다시 올려 주세요.");
          }

          const r = body.결과 as Record<string, unknown>;
          set패널들((p) =>
            p.map((x) => (x.키 === 신규[i].키 ? { ...x, 상태: "완료", 소요, 필드들: 문서필드(r) } : x)),
          );
          // 뽑아낸 값을 입력에 합친다. 사용자가 지운 것을 되살리지 않도록 합집합만 만든다.
          set공종((v) => 합치기(v, (r.work_types as string[]) ?? []));
          set장비((v) => 합치기(v, (r.equipment as string[]) ?? []));
          set자재((v) => 합치기(v, (r.materials as string[]) ?? []));
          if (r.site) set현장((v) => v || String(r.site));
          // 근거를 버리지 않는다 — 나중에 "이 표가 어느 문서에서 나왔나" 에 답할 유일한 수단이다.
          set문서근거((v) => [
            ...v,
            { filename: f.name, extracted_at: new Date().toISOString(), engine: String(r.engine ?? ""), fields: r },
          ]);
          set대화((d) => [...d, { 종류: "결과", 파일명: f.name, 소요, 필드들: 문서필드(r) }]);
        } catch (err) {
          const 소요 = performance.now() - 시작;
          const 사유 = 실패문구(err, "문서를 읽지 못했습니다. 파일을 확인하고 다시 올려 주세요.");
          set패널들((p) => p.map((x) => (x.키 === 신규[i].키 ? { ...x, 상태: "실패", 소요, 메모: 사유 } : x)));
          // 실패를 조용히 지나가지 않는다. 어느 파일이 왜 실패했는지 대화에 남는다.
          set대화((d) => [...d, { 종류: "실패", 파일명: f.name, 사유 }]);
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
        상태: "실행중",
        소요: null,
        필드들: [],
        미리보기: 미리보기만들기(원본[0]),
        mime: 원본[0].type || "image/jpeg",
      },
    ]);

    set대화((d) => [...d, ...원본.map((f) => ({ 종류: "올림" as const, 파일명: f.name, 크기: f.size }))]);

    const 시작 = performance.now();
    const fd = new FormData();
    fd.append("종류", "사진");
    줄인것.forEach((f) => fd.append("files", f, f.name));

    try {
      const res = await fetch("/api/risk/ingest", { method: "POST", body: fd });
      const body = await res.json();
      const 소요 = performance.now() - 시작;
      if (!res.ok) {
        console.error("[risk] photo ingest failed", { status: res.status, error: body?.error });
        throw new Error("사진을 읽지 못했습니다. 잠시 뒤 다시 올려 주세요.");
      }

      const r = body.결과 as Record<string, unknown>;
      const 단서 = (r.photo_findings as string[]) ?? [];
      set패널들((p) =>
        p.map((x) =>
          x.키 === 키
            ? {
                ...x,
                상태: "완료",
                소요,
                필드들: [
                  { 이름: "사진 속 상황", 값: ((r.scenes as string[]) ?? []).join(", ") },
                  { 이름: "미착용 보호구", 값: ((r.ppe_missing as string[]) ?? []).join(", ") },
                  { 이름: "공종", 값: ((r.work_types as string[]) ?? []).join(", ") },
                ].filter((f) => f.값),
                메모: 단서[0],
              }
            : x,
        ),
      );
      set사진단서((v) => [...v, ...단서]);
      set대화((d) => [
        ...d,
        {
          종류: "결과",
          파일명: `현장 사진 ${원본.length}장`,
          소요,
          필드들: [
            { 이름: "사진 속 상황", 값: ((r.scenes as string[]) ?? []).join(", ") },
            { 이름: "미착용 보호구", 값: ((r.ppe_missing as string[]) ?? []).join(", ") },
            { 이름: "사진에서 확인된 사항", 값: 단서.slice(0, 2).join(" · ") },
          ].filter((f) => f.값),
        },
      ]);
      set공종((v) => 합치기(v, (r.work_types as string[]) ?? []));
      set장비((v) => 합치기(v, (r.equipment as string[]) ?? []));
    } catch (err) {
      const 소요 = performance.now() - 시작;
      const 사유 = 실패문구(err, "사진을 읽지 못했습니다. 잠시 뒤 다시 올려 주세요.");
      set패널들((p) => p.map((x) => (x.키 === 키 ? { ...x, 상태: "실패", 소요, 메모: 사유 } : x)));
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
      // 실패를 표로 덮지 않는다. 만들지 못했으면 그렇게 말한다.
      if (!res.ok) {
        console.error("[risk] assessment create failed", { status: res.status, error: body?.error });
        throw new Error("평가표를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      }
      const 만든것 = body.assessment as Assessment;
      setAssessment(만든것);
      마지막저장본.current = 만든것;
      // 방금 만든 평가서가 아래 목록에 뜨게 한다. 이걸 안 부르면 새로고침 전까지
      // 진짜로 만든 것조차 안 보인다.
      void 기록읽기();
    } catch (err) {
      set오류(실패문구(err, "평가표를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요."));
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
   * 이행확인을 저쪽에 보낸다.
   *
   * **`저장예약` 보다 위에 둔다.** 아래에 두면 함수 선언 호이스팅으로 돌기는 하지만,
   * 읽는 사람도 린트도 "선언 전 접근" 으로 읽는다.
   */
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
        console.error("[risk] assessment save failed", { id: next.id, status: res.status, error: body?.error });
        throw new Error("이행확인을 저장하지 못했습니다.");
      }
      마지막저장본.current = next;
      set오류(null);
    } catch (err) {
      set오류(
        `${실패문구(err, "이행확인을 저장하지 못했습니다.")} 화면을 저장 전 상태로 되돌렸습니다.`,
      );
      // 저쪽이 안 받았으면 화면도 그 값을 들고 있으면 안 된다.
      if (마지막저장본.current) setAssessment(마지막저장본.current);
    } finally {
      set저장중(false);
    }
  }

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

  /**
   * 저장에 실패했을 때 되돌아갈 자리. **마지막으로 저쪽이 받아 준 상태**다.
   *
   * 이게 없으면 PATCH 가 실패해도 화면은 켜진 체크와 「이행확인 9 / 9 · 100%」 를
   * 그대로 들고 있는다. 사용자는 빨간 줄 하나를 지나치고 엑셀을 내려받는데, 저쪽
   * DB 에서 만들어진 파일은 8행만 채워져 있다. 결재 상신 가능이라고 말한 화면과
   * 실제 문서가 갈라지는 자리라 낙관적 표시를 반드시 되돌려야 한다.
   */
  const 마지막저장본 = useRef<Assessment | null>(null);

  /** 대기열에 카드가 실제로 있는 현장만. 빈 현장 버튼은 누를 이유가 없다. */
  const 현장있는것: Array<[string, string]> = [...new Set(대기열.map((i) => i.siteId))].map((id) => [
    id,
    현장이름.get(id) ?? id,
  ]);

  const 입력있음 = 공종.length > 0 || 장비.length > 0 || 자재.length > 0;

  /**
   * 고른 카드의 평가서 서랍. **화면을 갈아치우지 않고 위에 얹는다.**
   *
   * 예전에는 `화면 === "작업장"` 으로 페이지를 통째로 바꿨다. 그러면 대기열이 사라져
   * "몇 건 남았는지" 를 잃고, 다음 카드로 가려면 뒤로 갔다가 다시 눌러야 했다.
   */
  const 서랍 =
    고른카드 !== null ? (
      <RiskDocPanel
        item={고른카드}
        siteId={고른카드.siteId}
        현장이름={현장이름.get(고른카드.siteId) ?? 고른카드.siteId}
        닫기={() => set고른카드(null)}
        // 낙관적으로 빼지 않는다. 서버가 확정한 뒤 다시 읽어야 새로고침해도 같은
        // 화면이 나온다 — 예전에는 배열에서만 빠져서 새로고침하면 카드가 돌아왔다.
        카드끝남={() => void 대기열읽기()}
      />
    ) : null;

  // 시간축 — 현장 하나에 무슨 일이 있었는가.
  if (화면 === "타임라인" && 고른현장) {
    return (
      <div className="risk-panel">
        <RiskTimeline
          항목들={대기열.filter((i) => i.siteId === 고른현장)}
          현장이름={현장이름.get(고른현장) ?? 고른현장}
          기준시각={기준시각}
          뒤로={() => {
            set화면("대기열");
            set고른현장(null);
          }}
          // 시간축 위에 그대로 서랍이 열린다. 시간축을 벗어나지 않는다.
          선택={(item) => set고른카드(item)}
        />
        {서랍}
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
              태스크 보드가 찾아낸 것 가운데 위험성평가에 해당하는 것입니다. 여기서 열어
              평가 항목마다 승인하면 TBM 자료와 공문이 함께 만들어집니다.
            </p>
          </div>
          <button type="button" className="risk-generate" onClick={새평가시작}>
            새 평가 만들기
          </button>
        </header>

        {/* 현장별 시간축 입구. 대기열은 "지금 무엇을" 이고 시간축은 "이 현장에 무슨 일이" 다.
            현장이 하나뿐일 때도 버튼을 숨기지 않는다 — 두 화면이 다른 질문에 답하기 때문이다. */}
        {현장있는것.length > 0 ? (
          <nav className="risk-site-bar" aria-label="현장별 이력">
            {현장있는것.map(([id, 이름]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  set고른현장(id);
                  set화면("타임라인");
                }}
              >
                {이름}
                <em>{대기열.filter((i) => i.siteId === id).length}</em>
              </button>
            ))}
          </nav>
        ) : null}

        <RiskQueue
          항목들={대기열}
          현장이름={현장이름}
          불러오는중={대기열로딩}
          기준시각={기준시각}
          // 대기열은 그대로 두고 오른쪽에 평가서가 열린다. 다음 카드로 바로 넘어갈 수 있다.
          선택={(item) => set고른카드(item)}
          감지={감지돌리기}
        />

        {/* 감지 카드와 만든 평가서는 **다른 곳에 산다.** 탭이 "기록 목록"을 표방하므로
            둘 다 보여야 한다 — 감지 카드만 보이면 실제로 만든 평가서가 통째로 사라진다. */}
        <RiskRecords
          일자별={기록}
          불러오는중={기록로딩}
          열기={(id) => void 기록열기(id)}
          펼침={기록펼침}
          펼치기={() => set기록펼침(true)}
        />
        {서랍}
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
              ← 할 일 목록
            </button>
          </p>
          <h1>문서와 사진을 올리면 평가표를 만듭니다</h1>
          <p className="risk-sub">
            계약서·자재표에서 공종과 장비를 읽고, 위험요인마다 산업안전보건기준에 관한
            규칙 조문을 붙입니다.
          </p>
        </div>
        <div className="mode-toggle" role="group" aria-label="평가표 생성 방식">
          {(["라이브", "데모"] as const).map((v) => (
            <button key={v} type="button" className={모드 === v ? "is-active" : ""} onClick={() => set모드(v)}>
              {모드이름[v]}
            </button>
          ))}
        </div>
      </header>

      {모드 === "데모" ? (
        <p className="risk-demo-note">
          미리보기입니다. 올린 문서와 사진은 <b>실제로 읽어</b> 공종·장비·자재를 채웁니다.
          평가표는 예시로 바로 나오며, <b>이 결과는 저장되지 않습니다.</b>
        </p>
      ) : (
        <p className="risk-demo-note is-live">
          실제 생성입니다. 평가표를 만드는 데 <b>45초 안팎</b>이 걸리고, 만들지 못하면 평가표 대신
          그 사유를 알려 드립니다.
        </p>
      )}

      <RiskComposer
        대화={대화}
        분석중={패널들.some((p) => p.상태 === "실행중")}
        문서올리기={(f) => void 문서올리기(f)}
        사진올리기={(f) => void 사진올리기(f)}
      />

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
          위험도 산정 기준
          <select value={매트릭스} onChange={(e) => set매트릭스(e.target.value)}>
            {어휘.matrices.map((m) => (
              <option key={m} value={m}>
                {기준이름(m)}
              </option>
            ))}
          </select>
        </label>
      </section>

      {/*
        연 평가서에 조건이 하나도 안 붙어 있을 때의 경고.

        표에는 위험요인이 여러 줄 보이는데 공종·장비·자재가 전부 0 이면, 이 화면에서
        「다시 만들기」를 누르는 순간 **아무 조건도 없이** 새로 생성된다. 지금 보이는
        행들과 아무 관계 없는 표가 나오고, 그게 원래 평가서를 밀어낸다.

        버튼이 비활성이라 실제로 그렇게 되지는 않지만, 왜 눌리지 않는지를 말해 주지
        않으면 사용자는 화면이 고장 났다고 읽는다.
      */}
      {assessment && !입력있음 ? (
        <p className="risk-warn" role="status">
          이 평가서에는 <b>공종·장비·자재가 저장되어 있지 않습니다.</b> 평가 항목은 그대로
          보이지만 어떤 조건으로 만든 것인지가 남아 있지 않아, 지금은 평가표를 다시 만들 수
          없습니다. 아래에서 조건을 채우면 그때부터 고치고 다시 만들 수 있습니다.
        </p>
      ) : null}

      <section className="risk-chips">
        {/* 문서에서 채워진 값 위에 **더할 수 있어야** 한다. 어휘는 장비 78·자재 50 종이라
            통째로 펼치는 대신 검색으로 좁힌다. 목록에 없는 현장 용어도 직접 넣게 둔다. */}
        <VocabPicker
          라벨="공종"
          선택된={공종}
          후보={어휘.work_types}
          바꾸기={set공종}
          안내="예: 철근콘크리트공사"
        />
        <VocabPicker 라벨="장비" 선택된={장비} 후보={어휘.equipment} 바꾸기={set장비} 안내="예: 이동식크레인" />
        <VocabPicker 라벨="자재" 선택된={자재} 후보={어휘.materials} 바꾸기={set자재} 안내="예: 레미콘" />
      </section>

      <div className="risk-actions">
        <button type="button" className="risk-generate" disabled={생성중 || !입력있음} onClick={() => void 생성하기()}>
          {생성중
            ? 모드 === "라이브"
              ? "평가표를 만드는 중입니다… (45초 안팎)"
              : "평가표를 만드는 중입니다…"
            : "위험성평가표 만들기"}
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
