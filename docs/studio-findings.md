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

## 아직 확인 안 된 것

- `config publish` — `/publish` 404, `PATCH published_config_id` 는 200 이나 반영 안 됨
  (`HANDOFF.md:130`). 위 실험은 **`default_config`** 로 돌았다. 발행이 필요한지 아직 모른다.
- `document-classify` · `validate` · `review` 를 체인에 넣었을 때의 `data` 스키마
- 3단 이상 체인
- `include=last` 와 `include=["all"]` 의 차이

## 이 발견이 바꾸는 것

계획(`risk-console-studio-consensus.md`)의 Phase 1 「기본 가정」이 무효다.
*"단독으로 도는 스텝은 document-parse 하나뿐"* 은 체인이 안 될 때의 이야기였다.
체인이 되므로 **명세 5번(parse→classify→extract→validate)이 다시 살아난다.**
