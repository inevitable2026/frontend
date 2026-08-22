# tbm-check 데이터 모델 발췌

출처는 [`inevitable2026/tbm-check`](https://github.com/inevitable2026/tbm-check) 이며, 기준 시점은
2026년 8월 22일입니다. 그 레포의 전체 스키마 가운데 **우리가 붙을 때 실제로 읽거나 넘겨야 하는
타입만** 옮겨 적습니다. TBM 계획·회의록 내부 구조(`TBMPlan` · `TBMRecord` · `PlanHazard` 등)와
SAFEGRID 원본 응답 타입은 저쪽 앱 내부에서만 쓰이므로 여기 담지 않습니다.

원본 위치는 `src/lib/types.ts` 와 `src/lib/types-admin.ts` 두 파일입니다.

## 위험성평가 카탈로그

`scripts/extract_risk_assessment.py` 가 원본 PDF 에서 뽑아 `src/data/risk-assessment.json` 으로
떨어뜨리는 폴백 카탈로그의 구조입니다. SAFEGRID 가 응답하지 않을 때만 쓰이며, 이 경로로 만들어진
평가표에는 화면에 출처 배지가 붙습니다.

```
RiskDataset ─ 항목[] ─ RiskItem { 공종분류 · 단위작업 · 위험요인 · 대책[] · 법적근거
                                  · 개선전: RiskScore · 추천: RiskScore · 통계: RiskStats }
RiskScore { 빈도 · 강도 · 위험도 }
RiskStats { 표본수 · 관측기간 · 사고건수 · 사망사고건수 · 최신사고일시 · 사망률 · 신뢰도 · 점수출처 }
```

`통계` 는 이 카탈로그에만 붙어 옵니다. SAFEGRID 평가표에는 없으므로 양쪽을 함께 다루는 코드에서는
선택 필드로 취급해야 합니다.

## 현장 · 일자

```
Site      { id · code · name }
DayEntry  { id · siteId · date · 단계: DayStatus }
DayStatus { 평가: boolean · 계획: boolean · 회의록: boolean · 일지: boolean }
```

`date` 는 언제나 KST 기준 `'YYYY-MM-DD'` 문자열입니다. `Date` 객체로 왕복시키면 UTC 로 도는
서버리스 함수에서 하루가 밀립니다. `DayStatus` 의 네 칸은 앞 칸이 끝나야 다음 칸이 열리는
순서를 담고 있습니다.

## 관리자 콘솔 — 문서함 · 인제스트

```
문서종류      = 하도급계약서 | 위험성평가표 | TBM회의록 | 작업표준 | 순회점검일지 | 기타
인제스트단계이름 = 수신 | 레이아웃분석 | 표·서명인식 | 필드추출 | 프로젝트판정 | 청킹 | 임베딩 | 색인
단계상태      = 대기 | 실행중 | 완료 | 실패 | 건너뜀
출처등급      = 실데이터 | 합성 | 고정
의도          = tbm_missing | audit_bundle | required_docs | freeform

인제스트단계 { 이름 · 상태 · 시작 · 소요ms · 산출?: unknown · 실패사유? }
레이아웃요소 { id · page · category · content{html?·markdown?·text?} · coordinates?: {x,y}[] }
추출필드 { 업체명? · 현장명? · 공종[]? · 장비[]? · 자재[]?
          | 계약금액? · 공사기간?              ← 하도급계약서
          | 일자? · 참석자[]? · 중점위험요인?  ← TBM회의록
          | 작업명? · 보호구[]?                ← 작업표준 }
프로젝트추천 { siteId · code · name · 신뢰도(0~1) · 근거 }
인용 = { 종류:"sql"; 표 · 행수 · 설명 · 출처 }
     | { 종류:"doc"; documentId · 제목 · page · 발췌 · 점수 · 출처 }
```

세 가지만 덧붙입니다.

`인제스트단계.산출` 이 `unknown` 인 것은 단계마다 모양이 다르기 때문입니다. 단계별 실제 구조는
저쪽 `HANDOFF-site-context.md` 의 표에 정리되어 있습니다.

`레이아웃요소.coordinates` 는 0~1 로 정규화된 네 꼭짓점입니다. 올린 PDF 위에 박스를 그려
"이 값이 저 자리에서 나왔다"를 보여 줄 수 있습니다.

`출처등급` 은 화면이 배지로 드러내야 하는 값입니다. 시드 문서는 저쪽에서 만든 것이라 `합성`
으로 나갑니다. 우리 답변에 인용을 실을 때도 이 값을 그대로 노출해야 법령 도구의 인용 안전 계약과
어긋나지 않습니다.
