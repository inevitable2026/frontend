"use client";

import { useMemo, useRef, useState } from "react";

/**
 * 어휘에서 고르는 다중 선택. 칩 + 자동완성.
 *
 * 왜 그냥 `<select multiple>` 이 아닌가 — 장비가 78종, 자재가 50종이다. 목록을 통째로
 * 펼치면 찾는 것보다 스크롤하는 시간이 길다. 그리고 문서에서 뽑힌 값이 이미 들어와 있을 때
 * 그 위에 **더하는** 동작이 자연스러워야 한다.
 *
 * 어휘에 없는 값도 넣을 수 있다. 현장 용어는 목록보다 빨리 늘고, 못 넣게 막으면 사용자가
 * 화면 밖에서 처리한다.
 */
export default function VocabPicker({
  라벨,
  선택된,
  후보,
  바꾸기,
  안내,
}: {
  라벨: string;
  선택된: string[];
  후보: string[];
  바꾸기: (다음: string[]) => void;
  안내?: string;
}) {
  const [질의, set질의] = useState("");
  const [열림, set열림] = useState(false);
  const 입력 = useRef<HTMLInputElement>(null);

  const 걸러진 = useMemo(() => {
    const q = 질의.trim();
    const 남은 = 후보.filter((c) => !선택된.includes(c));
    if (!q) return 남은.slice(0, 12);
    return 남은.filter((c) => c.includes(q)).slice(0, 12);
  }, [질의, 후보, 선택된]);

  function 더하기(값: string) {
    const v = 값.trim();
    if (!v || 선택된.includes(v)) return;
    바꾸기([...선택된, v]);
    set질의("");
    입력.current?.focus();
  }

  return (
    // 포커스가 이 상자 밖으로 나가면 닫는다.
    //
    // 처음에는 input 의 onBlur 에 150ms 지연을 걸었다. 목록 항목을 누르기 전에 닫히면
    // 클릭이 안 먹기 때문인데, 그러면 **두 피커의 목록이 동시에 열려 있을 수 있다.**
    // `relatedTarget` 으로 "정말 밖으로 나갔는지" 를 보면 지연이 필요 없다.
    <div
      className="risk-picker"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) set열림(false);
      }}
    >
      <div className="risk-picker-head">
        <span className="risk-picker-label">{라벨}</span>
        <span className="risk-picker-count">{선택된.length}</span>
      </div>

      <div className="risk-chipbox" onClick={() => 입력.current?.focus()}>
        {선택된.map((v) => (
          <span className="risk-chip" key={v}>
            {v}
            <button type="button" aria-label={`${v} 삭제`} onClick={() => 바꾸기(선택된.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
        <input
          ref={입력}
          type="text"
          value={질의}
          placeholder={선택된.length === 0 ? (안내 ?? "검색하거나 직접 입력") : ""}
          onChange={(e) => {
            set질의(e.target.value);
            set열림(true);
          }}
          onFocus={() => set열림(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              더하기(걸러진[0] ?? 질의);
            }
            // 빈 입력에서 백스페이스는 마지막 칩을 지운다. 칩 UI 의 관례다.
            if (e.key === "Backspace" && 질의 === "" && 선택된.length > 0) {
              바꾸기(선택된.slice(0, -1));
            }
          }}
        />
      </div>

      {열림 && (걸러진.length > 0 || 질의.trim()) ? (
        <ul className="risk-picker-list">
          {걸러진.map((c) => (
            <li key={c}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => 더하기(c)}>
                {c}
              </button>
            </li>
          ))}
          {/* 어휘에 없는 값도 넣게 한다. 현장 용어가 목록보다 빨리 는다. */}
          {질의.trim() && !후보.includes(질의.trim()) ? (
            <li>
              <button
                type="button"
                className="risk-picker-new"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => 더하기(질의)}
              >
                “{질의.trim()}” 직접 추가
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
