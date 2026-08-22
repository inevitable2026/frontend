"use client";

import { useRef } from "react";

import type { 필드 } from "@/components/risk/agent-panel";

/**
 * 새 평가 입력 — 대화 형태.
 *
 * 예전에는 버튼 세 개(문서·사진·촬영)와 "아직 없습니다" 세 줄이 나란히 있었다. 그건 폼이지
 * 대화가 아니고, 무엇을 해야 하는지 화면이 말해 주지 않았다.
 *
 * 대화로 바꾸는 이유는 **순서가 있기 때문**이다. 문서를 올리면 공종이 채워지고, 그다음에
 * 생성할 수 있다. 그 순서를 사람이 추측하는 대신 화면이 한 걸음씩 말한다.
 *
 * **연출이 아니다.** 말풍선에 들어가는 것은 실제로 일어난 일뿐이다 — 올린 파일 이름,
 * 문서에서 읽어낸 값, 실측 소요시간. 아직 안 한 일을 미리 말하지 않는다.
 */

export type 대화항목 =
  | { 종류: "안내"; 글: string }
  | { 종류: "올림"; 파일명: string; 크기: number }
  | { 종류: "결과"; 파일명: string; 소요: number; 필드들: 필드[] }
  | { 종류: "실패"; 파일명: string; 사유: string };

function 크기표시(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function 초표시(ms: number): string {
  return ms < 1000 ? "1초 미만" : `${(ms / 1000).toFixed(1)}초`;
}

export default function RiskComposer({
  대화,
  문서올리기,
  사진올리기,
  분석중,
}: {
  대화: 대화항목[];
  문서올리기: (files: FileList | null) => void;
  사진올리기: (files: FileList | null) => void;
  분석중: boolean;
}) {
  const 문서입력 = useRef<HTMLInputElement>(null);
  const 사진입력 = useRef<HTMLInputElement>(null);
  const 카메라입력 = useRef<HTMLInputElement>(null);

  return (
    <section className="risk-composer">
      <div className="risk-thread">
        {/* 첫 말은 항상 같다. 무엇을 올리면 되는지부터 말한다. */}
        <div className="risk-bubble is-system">
          <p>
            계약서·자재표·점검표 같은 현장 문서를 올려 주세요. 문서에서 <b>공종·장비·자재</b>
            를 읽어 채웁니다. 사진을 올리면 현장 상태도 함께 확인합니다.
          </p>
        </div>

        {대화.map((it, i) => {
          if (it.종류 === "안내") {
            return (
              <div className="risk-bubble is-system" key={i}>
                <p>{it.글}</p>
              </div>
            );
          }
          if (it.종류 === "올림") {
            return (
              <div className="risk-bubble is-me" key={i}>
                <p>
                  <b>{it.파일명}</b>
                  <em>{크기표시(it.크기)}</em>
                </p>
              </div>
            );
          }
          if (it.종류 === "실패") {
            return (
              <div className="risk-bubble is-system is-error" key={i}>
                <p>
                  <b>{it.파일명}</b> — {it.사유}
                </p>
              </div>
            );
          }
          return (
            <div className="risk-bubble is-system" key={i}>
              <p className="risk-bubble-head">
                {it.파일명} 에서 읽어냈습니다
                <em>{초표시(it.소요)}</em>
              </p>
              <dl className="risk-readout">
                {it.필드들.map((f) => (
                  <div key={f.이름}>
                    <dt>{f.이름}</dt>
                    <dd>{f.값}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}

        {분석중 ? (
          <div className="risk-bubble is-system is-working">
            <p>
              올린 파일을 읽는 중입니다<span className="risk-dots" aria-hidden="true" />
            </p>
          </div>
        ) : null}
      </div>

      {/* 입력 줄. 챗봇 입력창 자리에 파일 버튼이 있다. */}
      <div className="risk-composer-bar">
        <button type="button" onClick={() => 문서입력.current?.click()} disabled={분석중}>
          문서
        </button>
        <button type="button" onClick={() => 사진입력.current?.click()} disabled={분석중}>
          사진
        </button>
        <button type="button" onClick={() => 카메라입력.current?.click()} disabled={분석중}>
          촬영
        </button>
        <span className="risk-composer-note">PDF 와 사진을 여러 장 한꺼번에 올릴 수 있습니다.</span>
      </div>

      <input
        ref={문서입력}
        className="sr-only"
        type="file"
        accept="application/pdf,image/*"
        multiple
        onChange={(e) => {
          문서올리기(e.target.files);
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
          사진올리기(e.target.files);
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
          사진올리기(e.target.files);
          e.target.value = "";
        }}
      />
    </section>
  );
}
