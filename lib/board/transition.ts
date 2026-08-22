import {
  WORK_ITEM_STATUS_ORDER,
  type DraftEdit,
  type ItemPatch,
  type WorkItem,
  type WorkItemOrigin,
  type WorkItemStatus,
} from "@/lib/board/types";

// 열 이동 규칙. 세 열은 진행 단계가 아니라 "지금 이 카드를 움직일 수 있는 주체"이므로
// 전이 하나하나가 권한 이동을 뜻한다. 그래서 여기서 막는 것은 실수 방지가 아니라
// 기록의 일관성이다 — 확정에는 확정자가, 기각에는 사유가 반드시 남아야 한다.

export type TransitionErrorCode =
  | "invalidStatus"
  | "invalidLaneOrder"
  | "invalidAssignee"
  | "invalidConfirmedBy"
  | "rejectReasonRequired"
  | "invalidRejectReason"
  | "confirmedByRequired"
  | "invalidEdits"
  | "notDelegable"
  | "alreadyConfirmed"
  | "confirmedLocked"
  | "blocked";

export class TransitionError extends Error {
  readonly code: TransitionErrorCode;
  readonly status: number;

  constructor(code: TransitionErrorCode, status: number, message: string) {
    super(message);
    this.name = "TransitionError";
    this.code = code;
    this.status = status;
  }
}

// 저장소가 무엇을 불러야 하는지까지 여기서 정한다. reject 는 사유와 행위자를
// 함께 남겨야 해서 moveItem 이 아니라 rejectItem 으로 간다.
export type TransitionKind = "move" | "confirm" | "reject" | "reorder";

export type TransitionPlan = {
  itemId: string;
  from: WorkItemStatus;
  to: WorkItemStatus;
  kind: TransitionKind;
  /** BoardStore.moveItem 에 그대로 넘기는 값 */
  patch: ItemPatch;
  /** kind === "reject" 일 때만 채워진다. BoardStore.rejectItem 의 인자다 */
  rejectReason: string | null;
  actor: string | null;
  /**
   * ItemPatch 에 origin 자리가 없다. 승인 → 할 일 이동은 "사람이 직접 다시 쓴다"는
   * 뜻이라 origin 이 human 으로 바뀌어야 하는데, 그 반영은 저장소 몫이다.
   * 계약을 고치지 않고 값을 넘기기 위해 계획에 실어 보낸다.
   */
  nextOrigin: WorkItemOrigin;
  nextConfirmedBy: string | null;
  nextConfirmedAt: string | null;
  /**
   * 초안 대비 수정분. 확정(kind === "confirm")일 때만 채워진다.
   * 라우트가 이 값을 'edited' 이력 한 줄로 옮긴다.
   */
  edits: DraftEdit[];
};

export type TransitionInput = {
  status?: unknown;
  confirmedBy?: unknown;
  rejectReason?: unknown;
  laneOrder?: unknown;
  assignee?: unknown;
  edits?: unknown;
};

export type TransitionContext = {
  /** 기본값은 KST 현재 시각 */
  now?: string;
  /** item.blockedBy 가 가리키는 카드들. 넘기지 않으면 선행 검사를 건너뛴다 */
  blockers?: WorkItem[];
};

function kstNowIso(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+09:00");
}

function isStatus(value: unknown): value is WorkItemStatus {
  return typeof value === "string" && (WORK_ITEM_STATUS_ORDER as string[]).includes(value);
}

/**
 * 승인 열에서 할 일 열로 되돌리는 동작은 origin 을 human 으로 바꾼다.
 * 저장소 구현이 같은 판단을 두 번 적지 않도록 여기서 한 번만 정의한다.
 */
export function nextOriginFor(
  from: WorkItemStatus,
  to: WorkItemStatus,
  origin: WorkItemOrigin,
): WorkItemOrigin {
  return from === "approval" && to === "todo" ? "human" : origin;
}

/**
 * 기각인가. 기계가 올린 것을 승인 열에서 되돌리는 경우만 기각이고, 그때만 사유를 강제한다.
 * 사람이 스스로 올려 둔 카드를 자기가 내리는 것은 자기 일의 순서를 바꾸는 것이라 묻지 않는다.
 *
 * 초안이 붙었는지로 가르지 않는 이유는, 한 번 기각된 카드가 origin: human 이 되고도 초안을
 * 그대로 들고 있기 때문이다. 그것으로 가르면 사람이 자기 카드를 옮길 때마다 사유를 다시 요구한다.
 */
export function isRejection(item: WorkItem, to: WorkItemStatus): boolean {
  return item.status === "approval" && to === "todo" && item.origin === "machine";
}

export function planTransition(
  item: WorkItem,
  input: TransitionInput,
  ctx: TransitionContext = {},
): TransitionPlan {
  const now = ctx.now ?? kstNowIso();
  const from = item.status;

  if (!isStatus(input.status)) {
    throw new TransitionError(
      "invalidStatus",
      400,
      "status 는 todo · approval · done 중 하나여야 합니다.",
    );
  }
  const to: WorkItemStatus = input.status;

  // --- 값 검증 ---------------------------------------------------------------

  const patch: ItemPatch = { status: to };

  if (input.laneOrder !== undefined) {
    if (typeof input.laneOrder !== "number" || !Number.isFinite(input.laneOrder)) {
      throw new TransitionError("invalidLaneOrder", 400, "laneOrder 는 숫자여야 합니다.");
    }
    patch.laneOrder = input.laneOrder;
  }

  if (input.assignee !== undefined) {
    if (input.assignee !== null && typeof input.assignee !== "string") {
      throw new TransitionError(
        "invalidAssignee",
        400,
        "assignee 는 문자열이거나 null 이어야 합니다.",
      );
    }
    const 새담당 = typeof input.assignee === "string" ? input.assignee.trim() || null : null;
    if (새담당 !== item.assignee && !item.delegable) {
      throw new TransitionError(
        "notDelegable",
        400,
        "이관할 수 없는 카드라 담당자를 바꿀 수 없습니다.",
      );
    }
    patch.assignee = 새담당;
  }

  let confirmedBy: string | null = null;
  if (input.confirmedBy !== undefined && input.confirmedBy !== null) {
    if (typeof input.confirmedBy !== "string" || !input.confirmedBy.trim()) {
      throw new TransitionError("invalidConfirmedBy", 400, "confirmedBy 는 문자열이어야 합니다.");
    }
    confirmedBy = input.confirmedBy.trim();
  }

  // 수정분은 확정에만 실린다. 이동이나 기각에 실려 오면 조용히 버리지 않고 되돌려 보낸다 —
  // 버리면 화면은 고친 값이 남았다고 믿고 이력에는 아무것도 없는 상태가 된다.
  const edits = 수정분읽기(input.edits);

  let rejectReason: string | null = null;
  if (input.rejectReason !== undefined && input.rejectReason !== null) {
    if (typeof input.rejectReason !== "string") {
      throw new TransitionError("rejectReasonRequired", 400, "기각 사유가 필요합니다.");
    }
    rejectReason = input.rejectReason.trim() || null;
  }

  // --- 확정된 카드는 잠긴다 ---------------------------------------------------

  if (item.confirmedAt !== null) {
    if (to === "done") {
      throw new TransitionError("alreadyConfirmed", 409, "이미 확정된 할 일입니다.");
    }
    throw new TransitionError("confirmedLocked", 409, "이미 확정된 할 일은 되돌릴 수 없습니다.");
  }

  // --- 전이별 규칙 ------------------------------------------------------------

  const 기각 = isRejection(item, to);

  if (기각 && !rejectReason) {
    throw new TransitionError("rejectReasonRequired", 400, "기각 사유가 필요합니다.");
  }

  if (from === "approval" && to === "done" && !confirmedBy) {
    throw new TransitionError(
      "confirmedByRequired",
      400,
      "승인 열의 카드를 확정하려면 confirmedBy 가 필요합니다.",
    );
  }

  if (to === "done" && ctx.blockers) {
    const 남은 = ctx.blockers.filter((b) => b.status !== "done");
    if (남은.length > 0) {
      const 제목 = 남은.map((b) => `「${b.title}」`).join(" · ");
      throw new TransitionError(
        "blocked",
        409,
        `선행 카드가 아직 끝나지 않았습니다 — ${제목}.`,
      );
    }
  }

  // --- 계획 조립 --------------------------------------------------------------

  let kind: TransitionKind;
  if (기각) kind = "reject";
  else if (from === to) kind = to === "done" && confirmedBy ? "confirm" : "reorder";
  else if (to === "done") kind = confirmedBy ? "confirm" : "move";
  else kind = "move";

  if (edits.length > 0 && kind !== "confirm") {
    throw new TransitionError(
      "invalidEdits",
      400,
      "초안 수정분은 승인 확정에만 실을 수 있습니다.",
    );
  }

  /*
   * 기각 사유를 받았는데 기각이 아니면 **거절한다.**
   *
   * 예전에는 조용히 버리고 200 을 돌려줬다. `isRejection` 이 `origin === "machine"`
   * 을 요구하므로, 한 번 기각되어 origin 이 human 으로 바뀐 카드를 다시 승인 열로
   * 옮겼다가 기각하면 `kind` 가 "move" 가 되고 사유가 사라진다. 호출한 쪽은 200 을
   * 받았으니 기록된 줄 안다.
   *
   * 바로 위 `edits` 는 같은 상황에서 400 을 던진다. 한쪽만 조용한 이유가 없다 —
   * 기각 사유는 왜 되돌렸는지를 남기는 유일한 자리라 오히려 더 시끄러워야 한다.
   */
  if (rejectReason && kind !== "reject") {
    throw new TransitionError(
      "invalidRejectReason",
      400,
      item.origin !== "machine"
        ? "사람이 만든 카드는 기각할 수 없습니다. 기각 사유는 기계가 올린 카드를 되돌릴 때만 남길 수 있습니다."
        : "기각 사유는 승인 대기 카드를 할 일로 되돌릴 때만 실을 수 있습니다.",
    );
  }

  const nextOrigin = nextOriginFor(from, to, item.origin);
  const nextConfirmedBy = kind === "confirm" ? confirmedBy : null;
  const nextConfirmedAt = kind === "confirm" ? now : null;

  if (kind === "confirm" && confirmedBy) patch.confirmedBy = confirmedBy;
  if (kind === "reject" && rejectReason) patch.rejectReason = rejectReason;

  return {
    itemId: item.itemId,
    from,
    to,
    kind,
    patch,
    rejectReason: kind === "reject" ? rejectReason : null,
    actor: confirmedBy,
    nextOrigin,
    nextConfirmedBy,
    nextConfirmedAt,
    edits,
  };
}

/**
 * 초안 수정분을 읽는다. 세 칸이 모두 문자열인 항목만 받는다.
 * 모양이 틀린 값을 통과시키면 이력에 읽을 수 없는 줄이 쌓이고, 나중에 무엇을 고쳤는지
 * 되짚을 수 없게 된다.
 */
function 수정분읽기(value: unknown): DraftEdit[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TransitionError("invalidEdits", 400, "edits 는 배열이어야 합니다.");
  }

  return value.map((entry) => {
    const 후보 = entry as Partial<DraftEdit> | null;
    if (
      !후보 ||
      typeof 후보.path !== "string" ||
      !후보.path.trim() ||
      typeof 후보.before !== "string" ||
      typeof 후보.after !== "string"
    ) {
      throw new TransitionError(
        "invalidEdits",
        400,
        "edits 의 각 항목은 path · before · after 를 문자열로 가져야 합니다.",
      );
    }
    return { path: 후보.path.trim(), before: 후보.before, after: 후보.after };
  });
}
