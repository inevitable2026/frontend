import { 이행상태읽기, type 이행상태, type 평가행 } from "@/lib/risk/rows";

/**
 * 재평가가 무엇을 바꿨는가.
 *
 * 「재평가 필요」라는 말은 **평가서가 바뀌었다**는 뜻이다. 그런데 화면은 바뀐 뒤만
 * 보여 줬다. 무엇이 어떻게 달라졌는지 없이 "바뀐 평가서"를 내려받으면, 받는 사람은
 * 그게 왜 바뀌었는지 문서를 통째로 다시 읽어야 안다.
 *
 * 팩트가 append-only 라 원본이 그대로 남아 있다(`docs/board-contract.md` 의 키규칙).
 * 여기서 그 둘을 갈라 세운다.
 */

/** 팩트 한 줄. 저장소 모양에 기대지 않도록 최소만 요구한다. */
export type 판본 = { key: string; observedAt: string; value: 평가행 };

/**
 * 문서의 **기준시각** — 가장 오래된 팩트가 찍힌 때.
 *
 * "원본"을 각 행의 가장 오래된 판본으로 잡으면, 나중에 추가된 행까지 원본에 섞인다.
 * 그러면 신규 행이 "안 바뀐 행"으로 세어져 차이가 실제보다 작아 보인다. 기준을 시각
 * 하나로 못 박고, 그때 없던 행은 신규로 가른다.
 */
export function 기준시각(판본들: 판본[]): string | null {
  let 가장이른: string | null = null;
  for (const f of 판본들) {
    if (가장이른 === null || f.observedAt < 가장이른) 가장이른 = f.observedAt;
  }
  return 가장이른;
}

/** 기준시각 시점의 상태. 그때 없던 행은 담기지 않는다. */
export function 그때상태(판본들: 판본[], 기준: string): Map<string, 평가행> {
  const 결과 = new Map<string, { at: string; value: 평가행 }>();
  for (const f of 판본들) {
    if (f.observedAt > 기준) continue;
    const 이전 = 결과.get(f.key);
    if (!이전 || 이전.at <= f.observedAt) 결과.set(f.key, { at: f.observedAt, value: f.value });
  }
  return new Map([...결과].map(([k, v]) => [k, v.value]));
}

/** 한 행이 거쳐 간 이행확인 상태들. `불일치` 를 지나왔는지 보려고 쓴다. */
function 거쳐간상태(판본들: 판본[], key: string): 이행상태[] {
  return 판본들
    .filter((f) => f.key === key)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    .map((f) => 이행상태읽기(f.value));
}

export type 행차이 = {
  행id: string;
  단위작업: string;
  종류: "신규" | "이행확인" | "실행여부" | "대책" | "위험도" | "기타";
  전: string;
  후: string;
  /** 이 행이 도중에 위조 판정을 거쳤는가. 결과만 보면 안 보이는 사실이다. */
  불일치거침: boolean;
};

export type 문서차이 = {
  기준: string | null;
  전체행: number;
  바뀐행: number;
  신규행: number;
  /** 종류별 건수. 화면이 한 줄로 요약할 때 쓴다. */
  갈래: Record<행차이["종류"], number>;
  항목: 행차이[];
};

const 상태말: Record<이행상태, string> = {
  확인: "확인됨",
  빈칸: "비어 있음",
  불일치: "표시만 되어 있음(미실행)",
};

/**
 * 원본과 지금을 견준다.
 *
 * **한 행에 한 가지만 적는다.** 여러 칸이 같이 바뀌었어도 사람이 먼저 봐야 하는 것
 * 하나를 고른다 — 이행확인이 가장 무겁고, 그다음이 대책, 그다음이 위험도다.
 */
export function 문서차이내기(판본들: 판본[], 지금: 평가행[]): 문서차이 {
  const 기준 = 기준시각(판본들);
  const 원본 = 기준 ? 그때상태(판본들, 기준) : new Map<string, 평가행>();

  const 항목: 행차이[] = [];
  let 신규행 = 0;

  for (const 행 of 지금) {
    const key = `${행.회의록}#${행.행id}`;
    const 옛것 = 원본.get(key);
    const 거쳐감 = 거쳐간상태(판본들, key).includes("불일치");

    if (!옛것) {
      신규행 += 1;
      항목.push({
        행id: 행.행id,
        단위작업: 행.단위작업,
        종류: "신규",
        전: "원본에 없던 행",
        후: `${상태말[이행상태읽기(행)]}`,
        불일치거침: 거쳐감,
      });
      continue;
    }

    const 옛상태 = 이행상태읽기(옛것);
    const 새상태 = 이행상태읽기(행);
    if (옛상태 !== 새상태) {
      항목.push({
        행id: 행.행id,
        단위작업: 행.단위작업,
        종류: "이행확인",
        전: 상태말[옛상태],
        후: 상태말[새상태],
        불일치거침: 거쳐감,
      });
      continue;
    }

    /*
     * 이행확인 상태는 같은데 표시·실행이 달라진 경우.
     *
     * RI-04 가 그렇다 — 원본도 `true`, 지금도 `true` 인데 그 사이에 위조로 판정됐다가
     * 실제로 조치돼서 돌아왔다. 상태만 보면 "안 바뀐 행"이고, 값만 보면 "기타 · 다름"
     * 이다. 둘 다 이 행에 대해 아무 말도 못 한다. **이 문서에서 가장 할 말이 많은
     * 행인데 요약에서 사라진다.**
     */
    if (옛것.표시값 !== 행.표시값 || 옛것.실제실행 !== 행.실제실행) {
      const 말 = (표시?: boolean, 실행?: boolean) => {
        if (실행 === true) return "실제로 실행함";
        if (실행 === false) return 표시 ? "표시만 되어 있음(미실행)" : "미실행";
        return "실행 여부 미기재";
      };
      항목.push({
        행id: 행.행id,
        단위작업: 행.단위작업,
        종류: "실행여부",
        전: 말(옛것.표시값, 옛것.실제실행),
        후: 말(행.표시값, 행.실제실행),
        불일치거침: 거쳐감,
      });
      continue;
    }

    const 옛대책 = (옛것.대책 ?? []).join(" / ");
    const 새대책 = (행.대책 ?? []).join(" / ");
    if (옛대책 !== 새대책) {
      항목.push({
        행id: 행.행id,
        단위작업: 행.단위작업,
        종류: "대책",
        전: `${(옛것.대책 ?? []).length}건`,
        후: `${(행.대책 ?? []).length}건`,
        불일치거침: 거쳐감,
      });
      continue;
    }

    const 옛위험 = 옛것.개선후?.위험도;
    const 새위험 = 행.개선후?.위험도;
    if (옛위험 !== 새위험) {
      항목.push({
        행id: 행.행id,
        단위작업: 행.단위작업,
        종류: "위험도",
        전: String(옛위험 ?? "미기재"),
        후: String(새위험 ?? "미기재"),
        불일치거침: 거쳐감,
      });
      continue;
    }

    // 값이 다른데 위 어디에도 안 걸리면 "기타" 로 센다. 안 세면 합이 안 맞는다.
    if (JSON.stringify(옛것) !== JSON.stringify(행)) {
      항목.push({
        행id: 행.행id,
        단위작업: 행.단위작업,
        종류: "기타",
        전: "다름",
        후: "다름",
        불일치거침: 거쳐감,
      });
    }
  }

  const 갈래: Record<행차이["종류"], number> = {
    신규: 0,
    이행확인: 0,
    실행여부: 0,
    대책: 0,
    위험도: 0,
    기타: 0,
  };
  for (const it of 항목) 갈래[it.종류] += 1;

  return { 기준, 전체행: 지금.length, 바뀐행: 항목.length, 신규행, 갈래, 항목 };
}
