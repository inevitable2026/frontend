"use client";

import { useEffect, useState } from "react";

/**
 * 에이전트 분석 패널 — 왼쪽에 올린 자료, 오른쪽에 뽑아낸 값.
 *
 * 왜 이렇게 만드는가 — 이 화면에서 가장 자주 나올 질문이 "이 표가 저 문서에서 나온 게
 * 맞습니까" 다. 결과만 보여주면 그 질문에 답할 근거가 화면에 없다. 올린 문서를 옆에
 * 띄워 두고 그 문서에서 나온 값이 채워지는 것을 보여주면 질문 자체가 줄어든다.
 *
 * **연출과 사실을 섞지 않는다.** 표시하는 소요시간은 실제 측정값이고, 스캔 애니메이션은
 * 요청이 실제로 날아가 있는 동안에만 돈다. 값이 채워지는 순서만 연출이다 —
 * 이미 도착한 값을 0.18초 간격으로 드러낸다. 없는 분석을 하는 척하지는 않는다.
 */

export type 필드 = { 이름: string; 값: string };
export type 패널상태 = "대기" | "실행중" | "완료" | "실패" | "건너뜀";

function 초표시(ms: number | null): string {
  if (ms == null) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}초`;
}

/** 값이 도착한 순서대로 하나씩 드러낸다. 한꺼번에 나타나면 무엇을 읽어낸 건지 눈이 못 따라간다. */
function RevealFields({ 필드들 }: { 필드들: 필드[] }) {
  const [보인개수, set보인개수] = useState(0);

  // 리셋은 여기서 하지 않는다. 부모가 key 로 다시 마운트시키므로 상태가 새로 시작한다 —
  // effect 안에서 동기적으로 state 를 되돌리면 렌더가 한 번 더 돈다.
  useEffect(() => {
    if (필드들.length === 0) return;
    const t = setInterval(() => {
      set보인개수((n) => {
        if (n >= 필드들.length) {
          clearInterval(t);
          return n;
        }
        return n + 1;
      });
    }, 180);
    return () => clearInterval(t);
  }, [필드들]);

  return (
    <div className="risk-fields">
      {필드들.slice(0, 보인개수).map((f) => (
        <div className="risk-field-row" key={f.이름}>
          <span className="risk-field-name">{f.이름}</span>
          <span className="risk-field-value">{f.값 || "-"}</span>
        </div>
      ))}
      {보인개수 < 필드들.length ? (
        // 아직 안 드러난 자리를 비워 두면 칸이 튄다. 자리를 잡아 두고 깜빡이게 한다.
        <div className="risk-field-row">
          <span className="risk-field-name risk-skeleton">읽는중</span>
          <span className="risk-field-value risk-skeleton" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 자료 미리보기. PDF 는 브라우저 기본 뷰어로 첫 장을 띄운다 —
 * pdf.js 를 얹으면 번들이 커지고, 우리가 필요한 건 "이 문서다" 를 보여주는 것뿐이다.
 */
function SourcePreview({ url, mime, 스캔중 }: { url: string | null; mime: string; 스캔중: boolean }) {
  if (!url) return <div className="risk-preview is-empty">미리보기 없음</div>;

  return (
    <div className="risk-preview">
      {mime.startsWith("image/") ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="올린 자료" />
      ) : (
        <object data={`${url}#toolbar=0&navpanes=0&view=FitH`} type="application/pdf">
          <div className="risk-preview-fallback">PDF</div>
        </object>
      )}
      {/* 요청이 실제로 날아가 있는 동안에만 돈다. 끝나면 사라진다. */}
      {스캔중 ? <div className="risk-scanline" aria-hidden="true" /> : null}
    </div>
  );
}

export default function AgentPanel({
  이름,
  엔진,
  상태,
  소요,
  필드들,
  미리보기,
  mime,
  메모,
}: {
  이름: string;
  엔진: string;
  상태: 패널상태;
  소요: number | null;
  필드들: 필드[];
  미리보기: string | null;
  mime: string;
  메모?: string;
}) {
  return (
    <article className="risk-agent">
      <header className="risk-agent-head">
        <span className={`risk-badge is-${상태}`}>{상태}</span>
        <span className="risk-agent-name">{이름}</span>
        <span className="risk-agent-engine">
          {엔진}
          {소요 != null ? ` · ${초표시(소요)}` : ""}
        </span>
      </header>

      <div className="risk-agent-body">
        <SourcePreview url={미리보기} mime={mime} 스캔중={상태 === "실행중"} />
        <div className="risk-agent-fields">
          {상태 === "실행중" ? (
            <p className="risk-agent-note">문서를 읽는 중…</p>
          ) : 상태 === "실패" ? (
            <p className="risk-agent-note is-error">{메모 || "분석하지 못했습니다."}</p>
          ) : (
            <RevealFields key={`${상태}-${필드들.length}`} 필드들={필드들} />
          )}
        </div>
      </div>

      {메모 && 상태 === "완료" ? <p className="risk-agent-memo">{메모}</p> : null}
    </article>
  );
}
