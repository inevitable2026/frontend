/**
 * 카드가 가리키는 평가서를 고른다 — **한 곳에서만.**
 *
 * 같은 물음("이 카드는 어느 문서를 여는가")에 답하는 코드가 세 벌 있었고 규칙이 서로
 * 달랐다. 대기열 서랍은 `produces.into` 를 먼저 봤고, 태스크 보드는 그것을 아예 안 봤다.
 * 그래서 **카드 19장이 화면마다 다른 문서를 열었다** — 같은 카드를 대기열에서 누르면
 * 23행이 뜨고 보드에서 누르면 1행이 떴다. 둘 다 "이 카드의 평가서" 라고 적으면서.
 *
 * `evidence.ts` 주석은 이미 *"risk-doc-panel 과 글자 그대로 같은 식이어야 한다"* 고
 * 적어 두었다. 주석으로 지킬 수 없는 약속이었다. 함수 하나로 만든다.
 *
 * ---
 *
 * **그리고 문서 ID 인지 검사한다.**
 *
 * `produces.into` 는 모델이 세운 계획(`lib/generate/cards.ts`)에서 오고 감지 엔진이
 * 검증 없이 옮긴다. 그 결과 문서 ID 자리에 **모델이 지은 한국어 문장**이 들어앉았다:
 *
 *   「문서 결재 시스템」 · 「아차사고 대장」 · 「감독기관 제출 자료 패키지」
 *   「카드 c_approval_ra_minutes_20260820」 · 「4F 슬래브 … 위험성평가 회의록」
 *
 * 이게 화면에서 안 열리는 문제로만 끝나지 않았다. **행 팩트의 key 로 저장됐다** —
 * 프로덕션 `riskAssessmentRow` 34행 중 7행이 존재하지 않는 문서에 붙어 있다. 그 행들은
 * 어느 문서를 열어도 안 보이고, 문서 목록에도 없고, 되돌아올 길이 없다.
 *
 * 규칙은 지어내지 않았다. 이 시스템의 **실제 문서 식별자 전부**에서 나왔다 —
 * `ra_2026_08_regular` · `ra_draft_20260819` · `tbm_20260818_pour` · `council_20260819` ·
 * `nm_20260818_01` · `notice_20260818_molab` · `rev_gamri` · `edu_20260805_new` ·
 * `nearmiss_ledger_2026q3` · `doc_2_k3f9x1qm`. 전부 **소문자 ASCII 마디를 `_` 로 이은
 * 꼴이고 마디가 둘 이상**이다.
 *
 * 그래서 마디가 하나뿐인 `record` 도 거절한다. 그것도 모델이 지은 값이고, 실제 문서 중
 * 그런 모양은 하나도 없다.
 *
 * **모르면 열지 않는다.** 못 고르면 `null` 이고, 화면은 "연결된 평가서가 없습니다" 라고
 * 말한다. 있지도 않은 문서를 여는 것보다 낫고, 반영 경로는 이미 `null` 을
 * `target_document_missing` 으로 막는다(`lib/risk/row-application-store.ts:160-161`).
 */

/** 소문자 ASCII 마디를 `_` 로 이은 꼴. 마디가 둘 이상이어야 한다. */
const 문서키꼴 = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/;

export function 문서키인가(value: unknown): value is string {
  return typeof value === "string" && 문서키꼴.test(value.trim());
}

type 카드모양 = {
  produces?: Array<{ into?: string | null }> | null;
  invalidates?: Array<{ docId?: string | null }> | null;
  trigger?: { sourceDocRefs?: string[] | null } | null;
};

/**
 * 이 카드가 여는 문서.
 *
 * **`produces.into` 가 먼저다.** 초안을 든 카드는 새 행이 들어갈 문서가 따로 있고 그게
 * 사람이 보고 싶어 하는 문서다. `invalidates[0].docId` 를 먼저 보다가
 * `card_ra_draft_3rows` 에서 틀렸다 — 그 카드는 `ra_2026_07_regular` 를 무효화하지만 새
 * 3행은 `ra_draft_20260819` 로 들어간다. 무효화 대상을 열었더니 **0행이 떴고** 화면이
 * "행을 한 건도 읽지 못했습니다" 라고 말했다. 읽지 못한 게 아니라 엉뚱한 문서를 연 것이었다.
 *
 * 각 후보는 **문서 ID 꼴일 때만** 채택된다. 앞 후보가 모델이 지은 문장이면 그것을 쓰지 않고
 * 다음 후보로 넘어간다 — 지어낸 값 때문에 멀쩡한 다음 후보까지 버릴 이유가 없다.
 */
export function 대상문서(item: 카드모양): string | null {
  const 후보들 = [
    ...(item.produces ?? []).map((p) => p?.into),
    (item.invalidates ?? [])[0]?.docId,
    ...(item.trigger?.sourceDocRefs ?? []),
  ];
  for (const 후보 of 후보들) {
    if (문서키인가(후보)) return 후보.trim();
  }
  return null;
}

/**
 * 이 카드가 무너뜨린 문서. 대상 문서와 다르면 화면이 맥락으로 함께 적는다.
 * 여기에도 같은 검사를 건다 — 무효화 대상이라고 지어낸 값이 통과할 이유는 없다.
 */
export function 무효문서(item: 카드모양): string | null {
  const 후보 = (item.invalidates ?? [])[0]?.docId;
  return 문서키인가(후보) ? 후보.trim() : null;
}
