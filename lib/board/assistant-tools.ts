import { tool } from "ai";
import { z } from "zod";

/**
 * 보드 도우미가 쓰는 **보드 도구**. 화면이 문장을 규칙으로 해석하던 자리를 대신한다.
 *
 * 카드를 고르고 무엇을 할지 정하는 판단은 전부 모델이 도구를 부르며 내린다. 화면은 도구가
 * 낸 지시를 그대로 실행하는 손잡이만 쥔다.
 *
 * 도구가 보는 보드는 **요청이 실어 보낸 스냅샷** 하나뿐이다. 카드 목록은 화면이 쥐고 있어서
 * 서버가 따로 읽을 길이 없고, 스냅샷을 받아 두면 읽기 도구는 한 요청 안에서 곧바로 답할 수 있다.
 * 고치는 도구는 스냅샷을 근거로 **할 수 있는 일인지 판정만** 하고, 실제 반영은 화면이 한다.
 */

/* ------------------------------------------------------------------ *
 * 요청이 실어 보내는 보드 스냅샷
 * ------------------------------------------------------------------ */

const COLUMN_IDS = ["todo", "approval", "done"] as const;

export const COLUMN_LABELS: Record<(typeof COLUMN_IDS)[number], string> = {
  todo: "Todo",
  approval: "승인",
  done: "완료",
};

/** 카드 한 장에서 도구가 판단에 쓰는 만큼만 추린 모양. 초안 본문 같은 큰 덩어리는 뺀다. */
const cardSchema = z.object({
  itemId: z.string().min(1).max(80),
  title: z.string().max(200),
  status: z.enum(COLUMN_IDS),
  /** 제목 아래 설명. 제목만으로 갈리지 않는 카드를 고를 때 쓴다. */
  note: z.string().max(400).nullable(),
  /** 카드 색띠. `alert` 는 조건이 발생한 카드, `due` 는 기한이 걸린 카드다. */
  tone: z.enum(["alert", "due", "review", "routine", "ok"]),
  /** "16:30" · "익일 작업 전" 처럼 화면에 적힌 기한 문구. */
  dueLabel: z.string().max(60).nullable(),
  assignee: z.string().max(60).nullable(),
  /** 이 카드를 낳은 조건의 코드. "T-03" 처럼 사람이 부르는 이름이다. */
  conditionCode: z.string().max(20).nullable(),
  /** 이 카드가 끝나기를 기다리는 선행 카드의 제목. */
  blockedBy: z.array(z.string().max(200)).max(20),
  /** 승인 열에 올라온 기계 초안인지. 승인·기각은 이런 카드에만 쓴다. */
  hasDraft: z.boolean(),
});

export const boardContextSchema = z.object({
  siteName: z.string().max(120),
  phase: z.string().max(120),
  /** 보드가 서 있는 날. "2026-08-19" */
  boardDate: z.string().max(10),
  /** 걸려 있는 날짜 필터. 없으면 null 이고 이번 주 카드가 모두 보인다. */
  selectedDate: z.string().max(10).nullable(),
  cards: z.array(cardSchema).max(200),
});

export type BoardContext = z.infer<typeof boardContextSchema>;
export type BoardContextCard = z.infer<typeof cardSchema>;

export type BoardColumnId = (typeof COLUMN_IDS)[number];

/**
 * 화면이 실행해야 할 지시. 고치는 도구가 판정에 성공했을 때만 나온다.
 *
 * 열은 `to` 와 `toLabel` 두 벌로 적는다 — 화면은 식별자로 카드를 옮기고, 모델은 답을 쓸 때
 * 사람이 부르는 이름을 그대로 옮겨 적을 수 있어야 하기 때문이다.
 */
export type BoardActionOutput =
  | {
      applied: true;
      action: "move";
      itemId: string;
      title: string;
      from: BoardColumnId;
      fromLabel: string;
      to: BoardColumnId;
      toLabel: string;
    }
  | { applied: true; action: "approve"; itemId: string; title: string }
  | { applied: true; action: "reject"; itemId: string; title: string; reason: string }
  | { applied: true; action: "selectDate"; date: string | null; label: string }
  | { applied: false; reason: string };

/* ------------------------------------------------------------------ *
 * 스냅샷 읽기
 * ------------------------------------------------------------------ */

function findCard(board: BoardContext, itemId: string): BoardContextCard | undefined {
  return board.cards.find((card) => card.itemId === itemId);
}

/** 못 한 이유를 그대로 돌려준다. 실패도 답의 일부라서 모델이 읽고 되물을 수 있어야 한다. */
function refuse(reason: string): BoardActionOutput {
  return { applied: false, reason };
}

function toDigest(card: BoardContextCard): Record<string, unknown> {
  return {
    itemId: card.itemId,
    title: card.title,
    column: COLUMN_LABELS[card.status],
    status: card.status,
    note: card.note,
    due: card.dueLabel,
    assignee: card.assignee,
    conditionCode: card.conditionCode,
    blockedBy: card.blockedBy,
    hasDraft: card.hasDraft,
    flags: [
      ...(card.tone === "alert" ? ["조건 발생"] : []),
      ...(card.tone === "due" ? ["기한 임박"] : []),
      ...(card.blockedBy.length > 0 ? ["선행 카드 대기"] : []),
    ],
  };
}

/**
 * 보드 도구 묶음. 요청마다 스냅샷과 기록장을 새로 물려서 만든다.
 *
 * - `reads` 에는 읽기 결과가, `actions` 에는 화면에 내린 지시가 쌓인다. 답을 쓰는 단계는
 *   대화 이력이 아니라 **이 두 배열만** 근거로 삼는다.
 * - 고치는 도구에는 `execute` 가 있지만 하는 일은 판정뿐이다. 카드를 실제로 옮기는 것은
 *   낙관적 갱신과 되돌리기를 쥔 화면이고, 서버에는 그 상태가 없다.
 */
export function createBoardTools({
  board,
  reads,
  actions,
}: {
  board: BoardContext;
  reads: unknown[];
  actions: BoardActionOutput[];
}) {
  function record(output: BoardActionOutput): BoardActionOutput {
    if (output.applied) actions.push(output);
    return output;
  }

  return {
    read_board: tool({
      description:
        "지금 화면에 있는 보드를 읽습니다. 카드에 관한 질문은 물론이고 카드를 고치기 전에도 먼저 불러 itemId 를 확인하세요. 조건 없이 부르면 보드 전체를 돌려줍니다.",
      inputSchema: z.object({
        status: z
          .enum(COLUMN_IDS)
          .optional()
          .describe("특정 열만 볼 때. todo=Todo, approval=승인 대기, done=완료"),
        flag: z
          .enum(["alert", "due", "blocked", "draft"])
          .optional()
          .describe("alert=조건 발생, due=기한 임박, blocked=선행 카드 대기, draft=기계가 쓴 초안"),
        query: z.string().max(60).optional().describe("제목·설명에 든 말이나 조건 코드(T-03)"),
      }),
      execute: ({ status, flag, query }) => {
        const needle = query?.trim().toLowerCase() ?? "";
        const matched = board.cards.filter((card) => {
          if (status !== undefined && card.status !== status) return false;
          if (flag === "alert" && card.tone !== "alert") return false;
          if (flag === "due" && card.tone !== "due") return false;
          if (flag === "blocked" && card.blockedBy.length === 0) return false;
          if (flag === "draft" && !card.hasDraft) return false;
          if (needle.length === 0) return true;
          const haystack = `${card.title} ${card.note ?? ""} ${card.conditionCode ?? ""}`.toLowerCase();
          return haystack.includes(needle);
        });

        const result = {
          site: board.siteName,
          phase: board.phase,
          boardDate: board.boardDate,
          dateFilter: board.selectedDate,
          counts: {
            todo: board.cards.filter((card) => card.status === "todo").length,
            approval: board.cards.filter((card) => card.status === "approval").length,
            done: board.cards.filter((card) => card.status === "done").length,
            total: board.cards.length,
          },
          matchedCount: matched.length,
          cards: matched.map(toDigest),
        };
        reads.push(result);
        return result;
      },
    }),

    move_card: tool({
      description:
        "카드를 다른 열로 옮깁니다. itemId 는 read_board 가 돌려준 값만 쓰세요. 승인 열의 초안을 확정하는 것은 이 도구가 아니라 approve_card 입니다.",
      inputSchema: z.object({
        itemId: z.string().min(1).max(80),
        to: z.enum(COLUMN_IDS),
      }),
      execute: ({ itemId, to }) => {
        const card = findCard(board, itemId);
        if (card === undefined) return record(refuse("보드에 없는 itemId 입니다. read_board 로 다시 확인하세요."));
        if (card.status === to) {
          return record(refuse(`「${card.title}」 은 이미 ${COLUMN_LABELS[to]} 열에 있습니다.`));
        }
        // 열은 식별자와 사람이 부르는 이름 두 벌로 적는다. 화면은 앞의 것으로 카드를 옮기고
        // 모델은 뒤의 것을 답에 그대로 옮겨 적는다.
        return record({
          applied: true,
          action: "move",
          itemId,
          title: card.title,
          from: card.status,
          fromLabel: COLUMN_LABELS[card.status],
          to,
          toLabel: COLUMN_LABELS[to],
        });
      },
    }),

    approve_card: tool({
      description:
        "승인 열에 올라온 초안을 승인합니다. 카드는 완료 열로 올라가고 결재 절차가 시작됩니다. 승인 열에 있는 카드에만 씁니다.",
      inputSchema: z.object({ itemId: z.string().min(1).max(80) }),
      execute: ({ itemId }) => {
        const card = findCard(board, itemId);
        if (card === undefined) return record(refuse("보드에 없는 itemId 입니다. read_board 로 다시 확인하세요."));
        if (card.status !== "approval") {
          return record(
            refuse(`「${card.title}」 은 ${COLUMN_LABELS[card.status]} 열에 있어 승인할 초안이 아닙니다.`),
          );
        }
        return record({ applied: true, action: "approve", itemId, title: card.title });
      },
    }),

    reject_card: tool({
      description:
        "승인 열의 초안을 기각합니다. 카드가 보드에서 내려가므로 사용자가 말한 기각 사유가 있을 때만 부르고, 사유가 없으면 부르지 말고 되물으세요.",
      inputSchema: z.object({
        itemId: z.string().min(1).max(80),
        reason: z.string().min(2).max(300).describe("사용자가 말한 기각 사유. 지어내지 마세요."),
      }),
      execute: ({ itemId, reason }) => {
        const card = findCard(board, itemId);
        if (card === undefined) return record(refuse("보드에 없는 itemId 입니다. read_board 로 다시 확인하세요."));
        if (card.status !== "approval") {
          return record(
            refuse(`「${card.title}」 은 ${COLUMN_LABELS[card.status]} 열에 있어 기각할 초안이 아닙니다.`),
          );
        }
        return record({ applied: true, action: "reject", itemId, title: card.title, reason: reason.trim() });
      },
    }),

    select_date: tool({
      description:
        "보드의 날짜 필터를 바꿉니다. date 를 비우면 필터가 풀려 이번 주 카드가 모두 보입니다.",
      inputSchema: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .describe("YYYY-MM-DD 또는 null(필터 해제)"),
      }),
      execute: ({ date }) => {
        if (date === null) {
          return record({ applied: true, action: "selectDate", date: null, label: "전체 기간" });
        }
        const [, month, day] = date.split("-");
        return record({
          applied: true,
          action: "selectDate",
          date,
          label: `${Number(month)}월 ${Number(day)}일`,
        });
      },
    }),
  };
}
