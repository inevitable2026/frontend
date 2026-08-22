# AI 사이드바·보드 — 넘기는 결함 3건

멀티에이전트 스윕(20에이전트)에서 나왔고 **각각 반증 시도를 통과**했습니다.
셋 다 같은 뿌리입니다 — **서버가 "했다"고 선언하는 시점과 실제로 반영되는 시점이 다르고,
그 사이의 실패가 어디에도 안 나타납니다.**

제 작업과 겹칠 위험이 있어 손대지 않았습니다.

---

## 1. AI 사이드바가 `applied: true` 를 먼저 선언한다 — 화면은 조용히 무시하는데 챗봇은 "기각했습니다" 라고 답한다

**위치** `lib/board/assistant-tools.ts:245` · 심각도 high

### 근거

`reject_card.execute` 는 스냅샷에서 카드를 찾고 `card.status !== "approval"` 만 본 뒤 `return record({ applied: true, action: "reject", itemId, title: card.title, reason: reason.trim() })` 한다. 그런데 이 도구가 보는 스냅샷 스키마(`cardSchema`, 28~45행)에는 **`origin` 칸이 아예 없다.**

실제 반영을 맡은 화면은 origin 을 본다 — `components/task-board/task-board.tsx:531-537`:
```
onReject: (itemId, reason) => {
  const card = cards.find((item) => item.itemId === itemId);
  if (card === undefined || card.status !== "approval" || card.origin !== "machine") return;
  handleReject({ itemId, reason });
},
```
조건이 어긋나면 **아무 표시 없이 `return`** 한다. 그런데 서버는 이미 `actions` 배열에 applied:true 를 밀어 넣었고, 답 단계 프롬프트(`app/api/board/assistant/route.ts:81`)는 모델에게 "boardActions 에 적힌 변경은 **화면에 이미 반영되었습니다.** 무엇을 어떻게 바꿨는지 한두 문장으로 짧게 알리세요" 라고 단정한다. 화면이 지시를 실행했는지 서버로 되돌아오는 확인 경로가 없다. `move_card`(193~211행)·`approve_card`(218~227행)도 같은 모양이고, 대응하는 화면 손잡이(task-board.tsx:515-530)도 똑같이 조용히 `return` 한다.

### 재현

카드 `card_ra_draft_3rows`(seed 상 approval·machine)를 한 번 기각하면 store-json.ts:424-431 이 status=todo·origin="human" 으로 바꾸고 초안은 남긴다. 담당자가 그 카드를 다시 승인 열로 끌어다 놓으면(moveItem 은 todo→approval 에 origin 을 건드리지 않는다) status=approval·origin=human 상태가 된다. 이때 사이드바에 "회의록 초안 기각해줘, 근거가 부족해" 라고 하면 서버 도구는 status 만 보고 applied:true 를 기록하고, 화면 bridge 는 `card.origin !== "machine"` 에서 조용히 빠져나간다. 결과: 카드는 그 자리에 그대로 있고 events 에도 아무 줄이 없는데, 챗봇은 "「수시 위험성평가 회의록 신규 3행」 초안을 기각했습니다" 라고 답한다. 사용자는 기각이 기록된 줄 안다.

### 검증에서 덧붙은 정정

주장은 유지된다. 다만 두 군데를 바로잡는다. (가) `approve_card`(assistant-tools.ts:218-227)는 화면 손잡이(task-board.tsx:526-530)와 조건이 `status === "approval"` 로 일치하므로 "같은 모양" 이 아니다. (나) `move_card` 는 조용히 return 하지 않지만 더 쉽게 재현되는 같은 부류의 결함을 갖는다 — 스냅샷에 `confirmedAt` 칸이 없어 도구는 확정 카드를 걸러낼 수 없고, `move_card`(193-211행)는 `card.status !== to` 만 보고 applied:true 를 기록한다. 그런데 `handleMove`(task-board.tsx:365-368)는 `card.confirmedAt !== null` 이면 "「…」 카드는 이미 확정되어 옮길 수 없습니다" 만 적고 멈춘다. seed-items.json:559·582 에 확정된 완료 카드가 이미 있으므로, 기각→재드래그 같은 사전 조작 없이 "이 카드 Todo 로 옮겨줘" 한 마디로 화면은 "옮길 수 없습니다", 챗봇은 "Todo 로 옮겼습니다" 가 동시에 뜬다. 심사 데모에서는 이쪽이 더 위험하다. 근본 원인은 하나다 — 화면이 반영 여부를 가르는 필드(origin, confirmedAt)가 도구 스냅샷에 없고, 화면이 지시를 실행했는지 서버로 되돌아오는 확인 경로가 없다.

---

## 2. AI 도우미가 PATCH를 보내기도 전에 "바꿨습니다"라고 답한다 — 저장 실패는 대화창에 영영 나타나지 않는다

**위치** `app/api/board/assistant/route.ts:81` · 심각도 high

### 근거

ANSWER_PROMPT 에 `"boardActions 에 적힌 변경은 화면에 이미 반영되었습니다. 무엇을 어떻게 바꿨는지 한두 문장으로 짧게 알리세요."` 라고 못박혀 있다. 그런데 boardActions 를 채우는 lib/board/assistant-tools.ts:122 의 주석이 스스로 말한다 — `"고치는 도구에는 execute 가 있지만 하는 일은 판정뿐이다. 카드를 실제로 옮기는 것은 ... 화면이고, 서버에는 그 상태가 없다."` (assistant-tools.ts:135 `if (output.applied) actions.push(output)` 는 스냅샷만 보고 applied:true 를 찍는다).
실제 저장은 답이 다 흐른 **뒤에** 클라이언트에서 일어난다: components/task-board/assistant-panel.tsx:105-135 의 효과가 `tool.state === "output-available"` 을 보고 나서야 `bridge.onMove/onApprove/onReject` 를 부르고, 그것이 board-data.ts:137 고치기() → PATCH /api/board/items/{id} 로 간다.
그 PATCH 가 실패하면 task-board.tsx:351-353 이 카드를 되돌리고 실패문구를 board.tsx:580 의 aria-live `.board-status` 에만 적는다. 대화창(assistant-panel.tsx:179-211)에는 한 글자도 가지 않고, assistant-stream.tsx:83-90 의 `outputHint` 는 `applied === true` 만 보고 "카드 이동 · 「…」 → 완료" 를 계속 완료 표시로 그린다.

### 재현

승인 열의 카드가 blockedBy 를 하나 들고 있는 상태(또는 이미 confirmedAt 이 찍힌 카드)에서 도우미에게 "「가설계단 안전난간 보강」 승인해 줘" 라고 말한다. 서버 도구는 스냅샷만 보고 applied:true 를 돌려주고, 모델은 "「가설계단 안전난간 보강」 초안을 승인했습니다. 결재와 서명 절차가 시작됩니다." 를 대화창에 쓴다. 그 뒤 클라이언트가 보낸 PATCH 는 transition 의 blocked/confirmedAt 검사에 걸려 409 로 튕기고, 카드는 승인 열로 되돌아간다. 화면 아래 aria-live 한 줄만 "저장하지 못해 화면을 원래대로 되돌렸습니다" 로 바뀌는데 그 자리는 스크롤 밖이고, 대화창은 승인했다는 문장과 초록색 완료 표시를 그대로 들고 있다. 심사위원이 보는 것은 대화창이다 — 아무것도 저장되지 않았는데 도우미는 승인했다고 말한 채로 남는다.

### 검증에서 덧붙은 정정

주장은 성립하되 세 군데를 바로잡아야 한다.

(a) 시점이 반대다. 클라이언트 PATCH 는 "답이 다 흐른 뒤" 가 아니라 도구 파트가 `output-available` 이 되는 즉시, 곧 조사 단계 중에 나간다(assistant-panel.tsx:111 이 state 만 보고 부른다; route.ts:334-341 이 도구 결과를 먼저 흘려보낸다). 결함의 근거는 순서가 아니라 **되돌아오는 선이 없다**는 것이다 — 답 단계(route.ts:351-357)는 boardActions 만 보고 PATCH 결과를 볼 방법이 애초에 없으므로, PATCH 가 먼저 실패해도 대화창 문장은 그대로 "승인했습니다" 가 된다.

(b) 도구 줄 문구가 다르다. 승인의 경우 assistant-stream.tsx:88-89 가 title 만 돌려주므로 "초안 승인 · 「내일 TBM 자료 3건 · 골조 · 가설 · 양중」" 로 그려진다. "카드 이동 · 「…」 → 완료" 는 move 쪽(:85-87) 문구다. 완료 표시로 남는다는 결론은 같다.

(c) 실패 표면이 409 보다 넓다. 더 짧은 경로가 하나 더 있다 — task-board.tsx:517 · 528 · 535 의 다리 가드와 handleMove:365-368 의 confirmedAt 가드는 **PATCH 를 보내지도 않고 조용히 return** 한다. 예컨대 이미 확정된 완료 카드를 두고 "옮겨 줘" 라고 하면 move_card 는 applied:true 를 찍고 모델은 "옮겼습니다" 를 쓰는데, 브라우저에서는 요청이 한 건도 나가지 않고 aria-live 에 "이미 확정되어 옮길 수 없습니다" 한 줄만 남는다. 즉 "저장 실패가 대화창에 안 나타난다" 보다 "화면이 거절한 사실조차 대화창에 안 나타난다" 가 더 정확하다.

---

## 3. 낙관적 갱신 되돌리기가 목록 전체를 되감아, 먼저 실패한 요청이 나중에 성공한 저장을 화면에서 지운다

**위치** `components/task-board/task-board.tsx:345` · 심각도 high

### 근거

commit() 이 되돌림 기준으로 **카드 목록 통째로** 를 붙든다 — `const previous = cards;`(task-board.tsx:345) 이고 실패하면 `setCards(previous)`(351). previous 는 그 렌더 시점의 배열 전체라 그 사이에 성공한 다른 카드의 변경까지 함께 되감긴다. handleMove(358-385)·handleApprove(387-425)·handleReject(427-450) 가 전부 이 한 자리를 지난다.
같은 렌더 클로저를 여러 번 쓰는 길이 실제로 열려 있다: assistant-panel.tsx:105-135 의 효과는 한 답에 실린 도구 출력을 **한 틱 안에서 for 루프로** 돌며 `bridge.onMove(...)` 를 연달아 부르고, 그때 잡는 `boardRef.current`(72-75)는 직전 렌더의 손잡이 하나뿐이다. route.ts:327 `stopWhen: [... isStepCount(MAX_RESEARCH_STEPS)]` 로 한 요청에 도구를 최대 5걸음 부를 수 있으므로 move_card 가 두 번 이상 실리는 것은 정상 경로다. 두 번째 handleMove 의 `applyMove(cards, ...)`(382)도, commit 의 previous 도 모두 첫 번째 이동 **이전** 배열이다. 반면 persist 콜백은 각각 PATCH 를 보내므로 서버에는 둘 다 들어간다.

### 재현

도우미에게 "T-03 카드와 T-07 카드를 둘 다 승인 대기로 옮겨 줘" 라고 말한다. 서버가 move_card 를 두 번 부르고, 클라이언트 효과가 한 틱 안에서 onMove 를 두 번 호출한다. PATCH 는 두 건 다 나가 서버에는 T-03·T-07 이 모두 승인 열로 저장되지만, 화면은 stale 클로저 때문에 두 번째(T-07)만 옮겨진 상태로 그려진다 — T-03 은 Todo 열에 그대로 서 있다. 사용자는 하나만 됐다고 보고 T-03 을 다시 끌어 옮기려 한다. 반대 방향도 성립한다: 느린 첫 요청이 409/네트워크 오류로 실패하면 setCards(previous) 가 그 사이 이미 저장에 성공한 두 번째 카드까지 원위치로 되돌리고, 화면은 "저장하지 못해 화면을 원래대로 되돌렸습니다" 라고 말한다. 새로고침하면 되돌렸다던 그 카드가 옮겨진 채로 나타난다.

### 검증에서 덧붙은 정정

주장의 핵심(목록 전체 되감기로 나중 성공 저장이 화면에서 지워짐)은 그대로 맞다. 한 곳만 좁힌다: "도우미가 한 틱 안에서 onMove 를 두 번 부른다"는 부분은 두 tool 출력이 하나의 React 커밋으로 배칭될 때만 성립하고, 청크가 나뉘어 도착하면 boardRef 가 갱신돼 stale 클로저는 생기지 않는다. 반면 결함의 본체 — 겹친 요청 중 먼저 실패한 쪽의 setCards(previous)(351) 가 그 사이 성공한 변경까지 화면에서 지우고 재조회도 하지 않는 것 — 은 AI 도우미 없이 사용자가 카드 두 장을 연달아 드래그하는 것만으로도 재현된다.

---
