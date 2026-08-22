"use client";

import { useRef, useState } from "react";

import { 회사표시, type 평가행 } from "@/lib/risk/rows";

/**
 * 챗봇으로 평가행 고치기.
 *
 * **제안과 반영을 갈라 둔다.** 모델이 말한 것은 제안 카드로만 쌓이고, 팩트에 반영되는 것은
 * 사람이 「적용」을 눌렀을 때뿐이다. 이 화면이 다루는 값에 이행확인이 섞여 있기 때문이다 —
 * 이행확인은 "현장에서 실제로 실행됐다"는 사람의 진술이고, 모델이 대신 채우면 그건 위조다.
 * 그래서 서버도 이행확인 제안 자체를 막고(`app/api/risk/rows/propose`), 화면도 대책과
 * 담당사만 적용한다.
 */

type 제안 = {
  행id: string;
  이유: string;
  대책추가: string[];
  대책삭제: string[];
  담당사: string;
};

type 말 =
  | { 종류: "나"; 글: string }
  | { 종류: "봇"; 글: string; 제안: 제안[]; 버려진: number }
  | { 종류: "실패"; 글: string };

export default function RiskRowChat({
  행들,
  docId,
  현장이름,
  저장,
}: {
  행들: 평가행[];
  docId: string | null;
  현장이름: string;
  /** 저장이 실제로 성공했는지 돌려준다. 실패했는데 "적용됨"으로 굳으면 안 된다. */
  저장: (행: 평가행) => Promise<boolean>;
}) {
  const [대화, set대화] = useState<말[]>([]);
  const [입력, set입력] = useState("");
  const [보내는중, set보내는중] = useState(false);
  const [적용됨, set적용됨] = useState<Set<string>>(new Set());
  const 끝 = useRef<HTMLDivElement>(null);

  async function 보내기() {
    const 글 = 입력.trim();
    if (!글 || 보내는중) return;
    set입력("");
    set대화((p) => [...p, { 종류: "나", 글 }]);
    set보내는중(true);

    try {
      const res = await fetch("/api/risk/rows/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 지시: 글, 행들 }),
      });
      const body = (await res.json()) as {
        답?: string;
        제안?: 제안[];
        버려진제안?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `${res.status}`);
      set대화((p) => [
        ...p,
        { 종류: "봇", 글: body.답 ?? "", 제안: body.제안 ?? [], 버려진: body.버려진제안 ?? 0 },
      ]);
    } catch (e) {
      set대화((p) => [...p, { 종류: "실패", 글: e instanceof Error ? e.message : "실패했습니다." }]);
    } finally {
      set보내는중(false);
      requestAnimationFrame(() => 끝.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }

  async function 적용(p: 제안, 표시: string) {
    const 행 = 행들.find((r) => r.행id === p.행id);
    if (!행) return;

    const 남길 = (행.대책 ?? []).filter((c) => !p.대책삭제.includes(c));
    const 더할 = p.대책추가.filter((c) => !남길.includes(c));

    const 됐다 = await 저장({
      ...행,
      대책: [...남길, ...더할],
      ...(p.담당사 ? { 담당사: p.담당사 } : {}),
      // 이행확인은 손대지 않는다. 여기서 켜면 사람이 확인하지 않은 것이 확인된 것이 된다.
    });
    // 저쪽이 받았을 때만 굳힌다. 실패했는데 "적용됨"이 되면 사용자는 반영된 줄 알고
    // 넘어가고, 버튼이 비활성이라 다시 누를 수도 없다.
    if (됐다) set적용됨((s) => new Set(s).add(표시));
  }

  return (
    <div className="risk-rowchat">
      <div className="risk-rowchat-thread">
        <div className="risk-bubble is-system">
          <p>
            {현장이름}
            {docId ? ` · ${docId}` : ""} 의 <b>{행들.length}행</b>을 보고 있습니다. 대책을 보강하거나
            담당사를 바꾸는 일을 도울 수 있습니다.
          </p>
          <p className="risk-rowchat-note">
            이행확인은 채워 드릴 수 없습니다 — 현장에서 실제로 실행됐는지는 사람만 확인할 수
            있습니다. 직접 편집 탭에서 눌러 주세요.
          </p>
        </div>

        {대화.map((m, i) => {
          if (m.종류 === "나") {
            return (
              <div className="risk-bubble is-me" key={i}>
                <p>{m.글}</p>
              </div>
            );
          }
          if (m.종류 === "실패") {
            return (
              <div className="risk-bubble is-system is-error" key={i}>
                <p>{m.글}</p>
              </div>
            );
          }
          return (
            <div className="risk-bubble is-system" key={i}>
              <p>{m.글}</p>
              {m.버려진 > 0 ? (
                <p className="risk-rowchat-note">
                  목록에 없는 행을 가리킨 제안 {m.버려진}건은 버렸습니다.
                </p>
              ) : null}

              {m.제안.map((p, j) => {
                const 표시 = `${i}-${j}`;
                const 행 = 행들.find((r) => r.행id === p.행id);
                const 끝남 = 적용됨.has(표시);
                return (
                  <div className={`risk-proposal${끝남 ? " is-applied" : ""}`} key={표시}>
                    <p className="risk-proposal-head">
                      <b>{p.행id}</b>
                      <span>{행?.단위작업 ?? "(목록에 없음)"}</span>
                    </p>
                    <p className="risk-proposal-why">{p.이유}</p>

                    {p.대책추가.map((c) => (
                      <p className="risk-proposal-line is-add" key={`a${c}`}>
                        + {c}
                      </p>
                    ))}
                    {p.대책삭제.map((c) => (
                      <p className="risk-proposal-line is-del" key={`d${c}`}>
                        − {c}
                      </p>
                    ))}
                    {p.담당사 ? (
                      <p className="risk-proposal-line is-add">담당사 → {회사표시(p.담당사)}</p>
                    ) : null}

                    <button type="button" disabled={끝남 || !행} onClick={() => void 적용(p, 표시)}>
                      {끝남 ? "적용됨" : "적용"}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}

        {보내는중 ? (
          <div className="risk-bubble is-system is-working">
            <p>
              보는 중<span className="risk-dots" aria-hidden="true" />
            </p>
          </div>
        ) : null}
        <div ref={끝} />
      </div>

      <div className="risk-rowchat-bar">
        <input
          type="text"
          value={입력}
          placeholder="예: 개구부 관련 행의 대책을 구체적으로 보강해 줘"
          disabled={보내는중}
          onChange={(e) => set입력(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void 보내기();
          }}
        />
        <button type="button" onClick={() => void 보내기()} disabled={보내는중 || !입력.trim()}>
          보내기
        </button>
      </div>
    </div>
  );
}
