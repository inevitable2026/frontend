import type { BoardColumnId, TaskCard } from "./types";

/**
 * 보드 명령 해석기. **모델을 부르지 않고 화면이 이미 쥔 카드 목록을 규칙으로 읽고 고친다.**
 *
 * `/api/chat` 은 `{ question }` 한 필드만 받고 `parseQuestion` 이 키 개수까지 검사하므로
 * (`docs/board-contract.md` 424줄) 보드 맥락을 서버로 보낼 자리가 아직 없다. 그래서 보드에
 * 관한 문장은 여기서 처리하고, 여기서 해석되지 않은 문장만 법령 에이전트로 넘긴다.
 *
 * 규칙이라 실패도 정직하다 — 못 알아들으면 `null` 을 돌려주고 지어내지 않는다.
 */

export type CardRef = {
  itemId: string;
  title: string;
  status: BoardColumnId;
};

/** 해석기가 보는 화면. 컨테이너가 쥔 상태를 읽기 전용으로 넘겨받는다. */
export type BoardView = {
  siteName: string;
  phase: string;
  cards: TaskCard[];
  selectedDate: string | null;
  boardDate: string;
  /** 조건 코드(T-03) 를 카드의 `conditionId` 로 바꾸는 표. */
  conditionCodes: { code: string; conditionId: string }[];
  /** 직전 답에서 번호를 매겨 보여 준 카드. "2번 승인해줘" 를 풀 때 쓴다. */
  lastListed: CardRef[];
};

export type BoardCommand =
  | { kind: "read"; lines: string[]; cards: CardRef[] }
  | { kind: "move"; card: CardRef; to: BoardColumnId }
  | { kind: "approve"; card: CardRef }
  | { kind: "reject"; card: CardRef; reason: string }
  | { kind: "selectDate"; date: string | null; label: string }
  /** 되물음. 카드를 못 찾았거나 기각 사유가 빠진 경우처럼 값이 더 필요할 때. */
  | { kind: "ask"; lines: string[]; cards: CardRef[] };

export const COLUMN_LABELS: Record<BoardColumnId, string> = {
  todo: "Todo",
  approval: "승인",
  done: "완료",
};

const READ_WORDS = ["보여", "알려", "뭐", "무엇", "어떤", "목록", "몇", "얼마", "있어", "있나", "궁금"];

function toRef(card: TaskCard): CardRef {
  return { itemId: card.itemId, title: card.title, status: card.status };
}

function shorten(title: string): string {
  return title.length <= 26 ? title : `${title.slice(0, 25)}…`;
}

/** 목록 한 줄. 번호를 붙여야 "2번 승인해줘" 가 성립한다. */
function listLines(cards: TaskCard[]): string[] {
  return cards.map((card, index) => {
    const due = card.dueLabel === null ? "" : ` · ${card.dueLabel}`;
    const who = card.assignee === null ? "" : ` · ${card.assignee.name}`;
    return `${index + 1}. [${COLUMN_LABELS[card.status]}] ${shorten(card.title)}${due}${who}`;
  });
}

function countBy(cards: TaskCard[], status: BoardColumnId): number {
  return cards.filter((card) => card.status === status).length;
}

/* ------------------------------------------------------------------ *
 * 카드 지칭 풀기 — 번호 · 조건 코드 · 제목 조각
 * ------------------------------------------------------------------ */

function resolveByIndex(input: string, view: BoardView): CardRef | undefined {
  const match = /(\d{1,2})\s*번/.exec(input);
  if (match === null) return undefined;
  return view.lastListed[Number(match[1]) - 1];
}

function resolveByConditionCode(input: string, view: BoardView): TaskCard[] {
  const match = /([A-Z])\s*-\s*(\d{1,2})/i.exec(input);
  if (match === null) return [];
  const code = `${match[1].toUpperCase()}-${match[2].padStart(2, "0")}`;
  const conditionId = view.conditionCodes.find((item) => item.code === code)?.conditionId;
  if (conditionId === undefined) return [];
  return view.cards.filter((card) => card.conditionId === conditionId);
}

/** 두 글자 이상 조각이 제목·설명에 몇 개나 걸리는지로 고른다. 동점이면 고르지 않는다. */
function resolveByTitle(input: string, cards: TaskCard[]): TaskCard[] {
  const quoted = /[「"'『](.+?)[」"'』]/.exec(input);
  const haystack = quoted === null ? input : quoted[1];
  const chunks = haystack
    .split(/[\s,·.]+/)
    .map((chunk) => chunk.replace(/[을를이가은는의로에서와과도만해줘주세요]+$/u, ""))
    .filter((chunk) => chunk.length >= 2);
  if (chunks.length === 0) return [];

  const scored = cards
    .map((card) => {
      const text = `${card.title} ${card.note ?? ""}`;
      return { card, score: chunks.filter((chunk) => text.includes(chunk)).length };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) return [];
  const best = scored[0].score;
  return scored.filter((item) => item.score === best).map((item) => item.card);
}

/** 한 장으로 좁혀지면 그 카드를, 여러 장이면 후보를, 못 찾으면 빈 배열을 돌려준다. */
function resolveCards(input: string, view: BoardView, pool: TaskCard[]): TaskCard[] {
  const byIndex = resolveByIndex(input, view);
  if (byIndex !== undefined) {
    const card = view.cards.find((item) => item.itemId === byIndex.itemId);
    if (card !== undefined) return [card];
  }
  const byCode = resolveByConditionCode(input, view);
  if (byCode.length === 1) return byCode;

  const byTitle = resolveByTitle(input, byCode.length > 1 ? byCode : pool);
  if (byTitle.length > 0) return byTitle;
  return byCode;
}

function askToPick(cards: TaskCard[], purpose: string): BoardCommand {
  return {
    kind: "ask",
    lines: [`${purpose} 카드가 여럿입니다. 번호로 골라 주세요.`, ...listLines(cards)],
    cards: cards.map(toRef),
  };
}

function notFound(purpose: string): BoardCommand {
  return {
    kind: "ask",
    lines: [
      `${purpose} 카드를 찾지 못했습니다.`,
      "제목의 일부나 조건 코드(T-03), 또는 직전 목록의 번호로 다시 말씀해 주세요.",
    ],
    cards: [],
  };
}

/* ------------------------------------------------------------------ *
 * 읽기
 * ------------------------------------------------------------------ */

function summary(view: BoardView): BoardCommand {
  const { cards } = view;
  const conditionCount = cards.filter((card) => card.status === "todo" && card.tone === "alert").length;
  const dueCount = cards.filter((card) => card.status !== "done" && card.tone === "due").length;
  const waiting = cards.filter((card) => card.status === "approval");

  return {
    kind: "read",
    lines: [
      `${view.siteName} · ${view.phase}`,
      `Todo ${countBy(cards, "todo")}장 · 승인 ${countBy(cards, "approval")}장 · 완료 ${countBy(cards, "done")}장 (모두 ${cards.length}장)`,
      `조건 발생 ${conditionCount}건 · 오늘 기한 ${dueCount}건 · 승인 대기 ${waiting.length}건`,
      view.selectedDate === null
        ? "날짜 필터는 걸려 있지 않습니다."
        : `${view.selectedDate} 만 보고 있습니다.`,
      ...(waiting.length === 0 ? [] : ["", "승인 대기:", ...listLines(waiting)]),
    ],
    cards: waiting.map(toRef),
  };
}

function readList(title: string, cards: TaskCard[], emptyLine: string): BoardCommand {
  if (cards.length === 0) return { kind: "read", lines: [emptyLine], cards: [] };
  return {
    kind: "read",
    lines: [`${title} ${cards.length}장입니다.`, ...listLines(cards)],
    cards: cards.map(toRef),
  };
}

/* ------------------------------------------------------------------ *
 * 해석기
 * ------------------------------------------------------------------ */

export function interpretBoardCommand(input: string, view: BoardView): BoardCommand | null {
  const text = input.trim();
  if (text.length === 0) return null;
  const asks = READ_WORDS.some((word) => text.includes(word));

  /* ---- 날짜 필터 ---- */
  if (/전체 ?보기|필터 ?(해제|풀|끄)|모두 ?보기|날짜 ?해제/.test(text)) {
    return { kind: "selectDate", date: null, label: "전체 기간" };
  }
  const dateMatch = /(?:(\d{1,2})월\s*)?(\d{1,2})일/.exec(text);
  if (dateMatch !== null && /만|보기|필터|로 ?맞춰|선택/.test(text)) {
    const [year, boardMonth] = view.boardDate.split("-");
    const month = (dateMatch[1] ?? boardMonth).padStart(2, "0");
    const day = dateMatch[2].padStart(2, "0");
    return {
      kind: "selectDate",
      date: `${year}-${month}-${day}`,
      label: `${Number(month)}월 ${Number(day)}일`,
    };
  }

  /* ---- 기각 ---- */
  if (/기각|반려/.test(text)) {
    const found = resolveCards(text, view, view.cards.filter((card) => card.status === "approval"));
    if (found.length === 0) return notFound("기각할");
    if (found.length > 1) return askToPick(found, "기각할");
    // 기각은 카드를 보드에서 지운다. 승인 열의 초안이 아니면 손대지 않는다.
    if (found[0].status !== "approval") {
      return {
        kind: "ask",
        lines: [
          `「${shorten(found[0].title)}」 은 ${COLUMN_LABELS[found[0].status]} 열에 있어 기각할 초안이 아닙니다.`,
          "기각은 승인 열에 올라온 초안에만 씁니다.",
        ],
        cards: [toRef(found[0])],
      };
    }

    const reasonMatch = /(?:사유|이유)\s*[:：]?\s*(.+)$/.exec(text);
    const reason = reasonMatch === null ? "" : reasonMatch[1].replace(/(로|으로)?\s*(기각|반려)(해줘|해|하자|해라|합니다)?[.\s]*$/u, "").trim();
    if (reason.length === 0) {
      return {
        kind: "ask",
        lines: [
          `「${shorten(found[0].title)}」 을 기각하려면 사유가 필요합니다.`,
          "「사유: 자재 사양 재확인 필요」 처럼 적어 주세요.",
        ],
        cards: [toRef(found[0])],
      };
    }
    return { kind: "reject", card: toRef(found[0]), reason };
  }

  /* ---- 승인 ---- */
  if (/승인/.test(text) && /해줘|해라|처리|확정|승인하|올려|해$|해\.|하자/.test(text) && !asks) {
    const found = resolveCards(text, view, view.cards.filter((card) => card.status === "approval"));
    if (found.length === 0) return notFound("승인할");
    if (found.length > 1) return askToPick(found, "승인할");
    if (found[0].status !== "approval") {
      return {
        kind: "ask",
        lines: [`「${shorten(found[0].title)}」 은 ${COLUMN_LABELS[found[0].status]} 열에 있어 승인할 초안이 아닙니다.`],
        cards: [toRef(found[0])],
      };
    }
    return { kind: "approve", card: toRef(found[0]) };
  }

  /* ---- 열 이동 ---- */
  const moveTarget: BoardColumnId | null = /완료로|끝냈|done으로/.test(text)
    ? "done"
    : /할 ?일로|todo로|투두로|되돌려/i.test(text)
      ? "todo"
      : /승인 ?열로|승인으로/.test(text)
        ? "approval"
        : null;
  if (moveTarget !== null && !asks) {
    const found = resolveCards(text, view, view.cards);
    if (found.length === 0) return notFound("옮길");
    if (found.length > 1) return askToPick(found, "옮길");
    if (found[0].status === moveTarget) {
      return {
        kind: "ask",
        lines: [`「${shorten(found[0].title)}」 은 이미 ${COLUMN_LABELS[moveTarget]} 열에 있습니다.`],
        cards: [toRef(found[0])],
      };
    }
    return { kind: "move", card: toRef(found[0]), to: moveTarget };
  }

  /* ---- 읽기 ---- */
  if (/요약|현황|상황|브리핑|정리해/.test(text)) return summary(view);

  if (/승인 ?대기|승인 ?기다|초안/.test(text)) {
    return readList("승인 대기", view.cards.filter((card) => card.status === "approval"), "승인 대기 카드가 없습니다.");
  }
  if (/기한|마감|오늘 ?까지/.test(text)) {
    return readList("기한이 걸린 카드", view.cards.filter((card) => card.status !== "done" && card.tone === "due"), "기한이 걸린 카드가 없습니다.");
  }
  if (/조건 ?발생|경고|위험한 ?카드|빨간/.test(text)) {
    return readList("조건 발생", view.cards.filter((card) => card.status === "todo" && card.tone === "alert"), "조건 발생 카드가 없습니다.");
  }
  if (/막힌|블록|blocked|선행/.test(text)) {
    return readList("선행 카드에 막힌 것", view.cards.filter((card) => card.blockedBy.length > 0), "막혀 있는 카드가 없습니다.");
  }
  if (/할 ?일|todo|투두/i.test(text) && asks) {
    return readList("Todo 열", view.cards.filter((card) => card.status === "todo"), "Todo 열이 비어 있습니다.");
  }
  if (/완료/.test(text) && asks) {
    return readList("완료 열", view.cards.filter((card) => card.status === "done"), "완료 열이 비어 있습니다.");
  }
  if (/카드/.test(text) && asks) {
    const found = resolveByTitle(text, view.cards);
    if (found.length > 0) return readList("찾은 카드", found, "");
    return readList("보드의 카드", view.cards, "카드가 없습니다.");
  }

  return null;
}
