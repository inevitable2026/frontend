# Studio 체인 — 실측 정정 (2026-08-22)

## 결론부터

**`document-parse → information-extract` 체인은 Studio 안에서 돈다.**
실제 PDF(하도급계약서)로 `status=completed`, 약 16초. 추출 결과도 정확했다 —
업체명 3사·현장명·공종 3종·장비 10종·자재 11종.

`HANDOFF.md:117-143` 의 *"체인이 안 돈다"* 는 결론은 **틀렸다.** 두 가지가 겹쳐 있었다.

## 무엇이 틀렸나

### ① `next_steps` 는 `step_name` 으로 잇는다

`HANDOFF.md:128` 이 시험한 세 형식:

```
[{id, name}] · [{name}] · [{id}]     → 전부 런타임 실패
```

실패 문구가 원인을 그대로 말하고 있었다:

```
Step 'parse' next_steps references unknown step 'None'. Defined steps: ['extract', 'parse']
```

**`'None'`** — 런타임이 읽는 필드가 비어 있다는 뜻이다. 세 형식 어디에도 그 필드가 없었다.
`lib/agent/upstage-agent.ts:36-41` 의 `StepRef` 에 **`step_name` 이 이미 모델링돼 있었는데**
아무도 그 형식을 보내지 않았다.

```jsonc
// 되는 형식
"next_steps": [{ "step_name": "extract" }]
```

계정에 남아 있던 기존 2단계 config(`risk-doc-extractor` / `cfg_VUybJr4cDXyTyCUY8rE34d`)를
열어 보면 `next_steps: [{"id": "835dc722…", "name": "extract"}]` 이고, 그 `id` 는 실제
`extract` 스텝의 id 와 **정확히 맞는다.** 즉 config 는 멀쩡한데 런타임이 다른 키를 본다.
config 생성 성공과 실행 성공이 다른 문제였고, 그 구분을 놓쳤다.

### ② `information-extract` 의 `json_schema` 는 래퍼 없이 본체를 받는다

v1(`/v1/information-extraction`)은 이 모양이다(`lib/context/upstage-doc.ts:123`):

```jsonc
json_schema: { name: "construction_doc", schema: { type: "object", properties: { … } } }
```

Studio 스텝의 `data.json_schema` 에 같은 모양을 넣으면:

```
Invalid Schema: Missing required key 'properties'   (step: extract)
```

**스키마 본체를 직접** 넣어야 한다:

```jsonc
"data": { "json_schema": { "type": "object", "properties": { … } } }
```

## 재현 절차

```
1. POST /v2/files            purpose=user_data    → file_id
2. POST /v2/agents/{id}/configs
     steps[0] parse   type=document-parse      is_first=true
                      next_steps=[{step_name:"extract"}]
     steps[1] extract type=information-extract
                      data.json_schema={type:"object", properties:{…}}
3. POST /v2/responses        model={agent_id}, input=[{input_file}]
4. GET  /v2/responses/{job}  폴링 → status=completed
```

스텝 `id` 는 **계정 전역에서 유일**해야 한다(재사용 시 409). 매 config 마다 새 UUID.

## 2차 실측 (2026-08-22 오후) — 체인만으로는 부족하다

체인을 파이프라인에 배선하려다 **체인 하나로는 안 된다**는 것을 확인했다. 두 가지 제약이 겹친다.

### ③ 체인 응답에는 마지막 스텝의 출력만 담긴다

`include:["all"]` 로 돌려도 `output` 길이가 **1**이고 `output[0].model === "extract"` 다.
중간 `parse` 출력(= `elements`·좌표)은 **오지 않는다.**

```
include=["step_outputs"]  → 400 Invalid request
include=["parse"]         → 400 Invalid request
include=["intermediate"]  → 400 Invalid request
include="steps"           → 400 Input should be a valid list
```

유효한 값을 API 가 열거해 주지는 않는다. `["all"]` 이 이미 최대다.

### ④ `information-extract` 는 단독으로 못 돈다

```
input_text 만 주면 → failed: "parse_result is required"  (step: extract)
```

parse 결과를 직접 먹여 보려고 세 가지를 시도했고 전부 거절당했다.

| 시도 | 결과 |
|---|---|
| top-level `parse_result: {…}` | `parse_result is required` |
| `content: [{type:"parse_result", …}]` | 400 `Input should be 'input_text'` |
| parse JSON 전문을 `input_text` 로 | `parse_result is required` |

`parse_result` 는 **체인 안에서만** 흐른다. 밖에서 주입할 수 없다.

### ③+④ 가 정하는 구조 — 한 번 올리고 두 번 돌린다

레이아웃과 필드를 둘 다 얻으려면 **두 번 돌리는 수밖에 없다.** 대신 `/v2/files` 의
`file_id` 는 재사용되므로 **업로드는 한 번**이면 된다.

```
upload(1회) ──┬─→ sitectx-layout      (parse 단독)     → elements·좌표
              └─→ sitectx-<종류>      (parse→extract)  → 필드
```

실측(강관동바리 사양서): 업로드 1회 · 레이아웃 11.5초(요소 21개) · 필드 11.8초 · 합 23.3초.
예전(업로드 2회 + v1 extract)보다 업로드가 절반이고 v1 의존이 사라진다.

### ⑤ 그리고 이것 때문에 파이프라인이 조용히 비어 있었다

에이전트에 체인을 붙인 뒤로 `runStudioParse` 가 **종류별 에이전트**를 부르고 있었다.
그러면 `output[0]` 이 parse 가 아니라 **extract** 라서:

```
elements 0개 → 표 0개 → 청크 0개 → 색인 0건
```

그런데도 잡은 `status=done` 으로 끝났다. 맥락 DB 에 아무것도 안 들어가는데 화면은
성공이라고 말했다. 지금은 ⑴ 레이아웃을 parse 단독 에이전트로만 돌리고, ⑵ 그 에이전트가
체인이면 거절하고, ⑶ 요소가 0개면 성공으로 치지 않는다.

## 아직 확인 안 된 것

- `config publish` — `/publish` 404, `PATCH published_config_id` 는 200 이나 반영 안 됨
  (`HANDOFF.md:130`). 위 실험은 **`default_config`** 로 돌았다. 발행이 필요한지 아직 모른다.
- `document-classify` · `validate` · `review` 를 체인에 넣었을 때의 `data` 스키마
- 3단 이상 체인
- 계정에 **`sitectx-mail` 이 없다.** `STUDIO_AGENTS.메일` 이 그 이름을 가리켜 메일 문서가
  통째로 실패했다. 지금은 `sitectx-general` 로 내려가되 역할 문구에 대체 사실을 적는다.
  전용 에이전트를 만들려면 `--apply` 가 필요한데, 스텝 id 는 계정 전역에서 한 번 쓰면
  끝이라 지금은 손대지 않았다.

## 이 발견이 바꾸는 것

계획(`risk-console-studio-consensus.md`)의 Phase 1 「기본 가정」이 무효다.
*"단독으로 도는 스텝은 document-parse 하나뿐"* 은 체인이 안 될 때의 이야기였다.
체인이 되므로 **명세 5번(parse→classify→extract→validate)이 다시 살아난다.**
