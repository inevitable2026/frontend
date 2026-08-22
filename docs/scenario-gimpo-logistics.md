# 가상 시나리오: 김포 고촌 물류센터 신축공사

이 문서는 제품 기획과 데이터 모델 검증을 위해 작성한 **가상 시나리오**입니다. 등장하는
회사, 인물, 문서, 금액은 모두 허구입니다. 인용된 법령의 이름과 취지는 실제 제도를
참고했지만, 조문 번호와 시행일은 시나리오 안에서만 유효한 예시이므로 실제 판단에
그대로 사용하면 안 됩니다. 제품이 실제로 조문을 인용할 때에는 `read_official_law`가
반환한 공식 원문만 사용한다는 기존 계약을 그대로 따릅니다.

---

## 0. 이 시나리오가 증명하려는 것

| 문제 인식 | 시나리오에서 대응되는 장면 |
| --- | --- |
| 위험성평가는 사실상 상시로 다시 해야 한다 | 3절에서 자재 변경 한 건이 수시평가 사유가 되는 과정 |
| 원청 안전관리자 한 명이 감당할 수 없다 | 1절의 인력 구조와 2절의 업무 부하 계산 |
| 그래서 컨설팅 업체를 쓴다 | 2절 하단의 외주 계약 조건과 그 한계 |
| 회사 맥락이 없으면 평가표를 쓸 수 없다 | 4절의 회사 문서 검색 및 원문 조회 과정 |
| 우리는 맥락 베이스를 구성해 먼저 밀어준다 | 5절의 변경 감지와 6절의 푸시 알림 |
| 현장 사진과 텍스트를 올리면 문서가 나온다 | 7절의 증거 수집과 8절의 평가표 초안 |
| 데이터가 쌓이면 다른 사업이 열린다 | 10절의 확장 시나리오 |

---

## 1. 현장 배경

### 1.1 프로젝트 개요

원청은 시공능력평가 40위권의 중견 건설사인 (주)한신종합건설입니다. 발주처는 물류
리츠 운용사이고, 공사 기간은 2026년 3월부터 2027년 9월까지 19개월입니다. 연면적은
약 8만 7천 제곱미터이고, 지하 1층과 지상 4층으로 구성된 상온 물류창고입니다.
도급 금액은 1,240억 원이며, 층고가 높은 창고 구조여서 골조 공사의 동바리 높이가
최대 8.2미터에 이르는 구간이 존재합니다.

### 1.2 이해관계자 구조

```jsonc
{
  "siteId": "site_gimpo_gochon_01",
  "name": "김포 고촌 물류센터 신축공사",
  "principalContractor": {
    "companyId": "co_hanshin",
    "name": "(주)한신종합건설",
    "role": "원청"
  },
  "safetyStaff": [
    {
      "personId": "user_park",
      "name": "박정우",
      "title": "안전관리자(차장)",
      "employer": "co_hanshin",
      "assignedSites": ["site_gimpo_gochon_01", "site_pyeongtaek_02"],
      "note": "두 현장을 겸임하며 김포 현장에는 주 3일 상주"
    },
    {
      "personId": "user_choi",
      "name": "최민서",
      "title": "안전보건관리담당자",
      "employer": "co_hanshin",
      "assignedSites": ["site_gimpo_gochon_01"],
      "note": "입사 8개월 차, 서류 작성 위주 업무"
    }
  ],
  "subcontractors": [
    { "companyId": "sub_daeyang", "trade": "토공", "workers": 18, "status": "준공" },
    { "companyId": "sub_seojin", "trade": "골조(철근콘크리트)", "workers": 62, "status": "진행" },
    { "companyId": "sub_hanbit", "trade": "가설·비계", "workers": 21, "status": "진행" },
    { "companyId": "sub_jungang", "trade": "양중(타워크레인)", "workers": 6, "status": "진행" },
    { "companyId": "sub_kyungin", "trade": "전기", "workers": 14, "status": "대기" },
    { "companyId": "sub_woori", "trade": "설비", "workers": 11, "status": "대기" }
  ],
  "activeHeadcount": 122,
  "tier2Contractors": 9
}
```

주목할 점은 실제로 위험 작업을 수행하는 인력 122명 가운데 원청 소속은 현장소장과
공무, 안전 담당을 포함해 11명뿐이라는 사실입니다. 나머지는 모두 하도급사 소속이며,
그 아래에 재하도급 성격의 물량 팀이 9개 더 붙어 있습니다. 안전관리자 박정우 차장은
자신이 직접 지휘하지 않는 111명의 작업에 대해 법적 책임을 지는 구조에 놓여 있습니다.

---

## 2. 평시의 업무 부하

### 2.1 박정우 차장의 한 주

박 차장이 김포 현장에 나오는 요일은 월요일, 수요일, 금요일입니다. 나머지 이틀은
평택 현장에 있습니다. 김포에 있는 날에도 하루 일과는 다음과 같이 채워집니다.

| 시간 | 업무 | 성격 |
| --- | --- | --- |
| 06:40 ~ 07:20 | 공종별 TBM 순회 및 서명 확인 | 현장 |
| 07:20 ~ 09:00 | 고소작업·화기작업 허가서 검토와 발급 | 서류 |
| 09:00 ~ 11:30 | 순회점검 및 지적 사항 사진 기록 | 현장 |
| 11:30 ~ 13:30 | 신규 입장자 안전교육, 협력사 서류 접수 | 혼합 |
| 13:30 ~ 15:00 | 발주처 및 감리 요청 자료 회신 | 서류 |
| 15:00 ~ 17:00 | 순회점검 2회차, 익일 작업 협의 | 현장 |
| 17:00 ~ 19:30 | 점검일지, 교육일지, 위험성평가 관련 문서 정리 | 서류 |

위험성평가에 실제로 쓸 수 있는 시간은 사실상 저녁 시간대에 남은 두 시간 정도입니다.
그런데 그 시간에는 이미 당일 발생한 서류가 쌓여 있기 때문에, 평가표를 새로 쓰는
작업은 계속 뒤로 밀립니다.

### 2.2 인터뷰에서 확인된 문제

현장 안전관리자 일곱 명을 인터뷰한 결과, 반복해서 언급된 어려움은 세 가지였습니다.

첫째, 위험성평가를 다시 해야 하는 사유가 발생했다는 사실 자체를 늦게 알게 됩니다.
자재가 바뀌거나 공법이 바뀌는 결정은 공무팀과 구매팀, 하도급사 사이에서 이루어지고,
안전 담당자는 그 결정이 현장에 반영된 뒤에야 상황을 파악하는 경우가 많았습니다.

둘째, 평가표를 새로 쓰려면 회사와 현장의 구체적인 맥락이 필요한데, 그 맥락이 메일과
카카오톡, 공무팀의 엑셀 파일에 흩어져 있습니다. 어떤 자재가 어떤 사양으로 반입되는지
확인하려면 결국 사람을 붙잡고 물어봐야 합니다.

셋째, 결국 기존 평가표를 복사해서 날짜만 바꾸는 관행이 생깁니다. 이렇게 만든 문서는
감사에서 지적을 받고, 무엇보다 실제 현장의 위험을 반영하지 못합니다.

### 2.3 현재의 대안인 컨설팅

한신종합건설은 이 문제를 안전 컨설팅 업체와의 계약으로 완화하고 있습니다. 계약
조건은 다음과 같습니다.

```jsonc
{
  "vendorId": "vendor_safeone",
  "name": "세이프원안전기술원",
  "contract": {
    "scope": ["정기 위험성평가 문서화", "분기 현장 진단", "감사 대응 자료 정리"],
    "monthlyFeeKrw": 3_200_000,
    "visitsPerMonth": 2,
    "responseSlaHours": 72
  },
  "limitation": [
    "방문 시점에 존재하는 상황만 반영되므로 그 사이의 변경은 누락됩니다.",
    "회사 내부 메일과 발주 이력에 접근할 수 없어 맥락을 담당자에게 다시 물어봅니다.",
    "수시평가 사유가 발생해도 다음 방문 전까지 문서가 만들어지지 않습니다."
  ]
}
```

컨설팅은 분명히 효과가 있습니다. 문서의 형식 완성도가 올라가고 감사 대응 부담이
줄어듭니다. 다만 월 2회 방문이라는 주기는 자재와 공정이 수시로 바뀌는 현장의 변화
속도를 따라가지 못합니다. 우리 제품이 노리는 지점이 바로 이 간격입니다.

---

## 3. 사건의 발단

### 3.1 2026년 8월 18일 화요일, 한 통의 메일

골조 하도급사인 (주)서진건설의 공무 담당자가 원청 공무팀에 메일을 보냅니다. 박 차장은
수신 참조에 포함되어 있었지만, 그날 평택 현장에 있었고 메일은 그날 받은 47통 가운데
하나였습니다.

```jsonc
{
  "docId": "doc_email_20260818_01",
  "kind": "email",
  "receivedAt": "2026-08-18T14:22:00+09:00",
  "from": "kwon@seojin-const.co.kr",
  "to": ["gongmu@hanshin.co.kr"],
  "cc": ["park.jw@hanshin.co.kr"],
  "subject": "[서진건설] 4층 슬래브 동바리 자재 변경 협의의 건",
  "attachments": [
    { "fileId": "file_quote_0818", "name": "동바리_대체자재_견적서.pdf", "pages": 3 },
    { "fileId": "file_spec_0818", "name": "강관동바리_사양서.pdf", "pages": 8 }
  ],
  "bodyExcerpt": "당초 4층 슬래브 전 구간에 시스템동바리를 적용하기로 하였으나, 임대사 물량 부족과 8월 단가 인상(전월 대비 12%)으로 인해 층고 8.2m 구간(A~C열, 약 1,850㎡)에 한해 강관동바리 혼용 시공을 검토하고 있습니다. 공기 지연 방지를 위해 8월 24일 반입을 목표로 하며, 회신 부탁드립니다."
}
```

### 3.2 이 메일이 안전 문제인 이유

시스템동바리에서 강관동바리로 바꾸는 결정은 구매 결정처럼 보이지만 실제로는 붕괴
위험과 직결되는 구조 변경입니다. 층고가 8미터를 넘는 구간에서 동바리를 혼용하면
수직도 관리, 수평 연결재 설치 간격, 이음부 처리, 콘크리트 타설 순서 등 통제해야 하는
항목이 완전히 달라집니다. 두 방식이 만나는 경계 구간에서는 하중 전달 경로가
불연속적으로 바뀌기 때문에 별도의 검토가 필요합니다.

즉 이 메일은 위험성평가를 다시 실시해야 하는 사유에 해당합니다. 그러나 메일 자체는
안전 담당자에게 그렇게 보이도록 쓰여 있지 않습니다. 제목에는 협의라는 단어가 있고
본문의 근거는 단가와 공기입니다.

---

## 4. 맥락 베이스가 이 메일을 읽는 방식

### 4.1 문서 수집과 파싱

제품은 회사 메일함, 전자결재, 공유 드라이브를 연동해 문서를 수집합니다. 첨부된 PDF는
Upstage Document Parse로 구조를 복원하고, 표에서 자재 규격과 수량을 추출합니다.
추출 결과는 회사 문서 저장소에 다음 형태로 적재됩니다. 법령 도구와 마찬가지로
검색 결과는 인용 근거가 아니며, 원문 조회에 성공한 문서만 인용할 수 있습니다.

```jsonc
{
  "docRef": "doc_2_k3f9x1qm",
  "kind": "email",
  "citable": false,
  "title": "[서진건설] 4층 슬래브 동바리 자재 변경 협의의 건",
  "siteId": "site_gimpo_gochon_01",
  "author": "권O열 (서진건설 공무)",
  "occurredAt": "2026-08-18T14:22:00+09:00",
  "confidentiality": "internal",
  "canonicalUrl": "hanshin://mail/20260818/01"
}
```

원문 조회에 성공하면 다음과 같이 인용 가능한 형태로 바뀝니다.

```jsonc
{
  "docRef": "doc_2_k3f9x1qm",
  "kind": "email",
  "citable": true,
  "title": "[서진건설] 4층 슬래브 동바리 자재 변경 협의의 건",
  "excerpt": "층고 8.2m 구간(A~C열, 약 1,850㎡)에 한해 강관동바리 혼용 시공을 검토하고 있습니다. ... 8월 24일 반입을 목표로 하며",
  "extracted": {
    "changeType": "materialSubstitution",
    "fromMaterial": { "code": "MAT_SYS_SHORE", "label": "시스템동바리" },
    "toMaterial": { "code": "MAT_PIPE_SHORE", "label": "강관동바리", "spec": "φ48.6×3.2t, 4단 조립" },
    "scope": { "floor": "4F", "grid": "A~C", "areaSqm": 1850, "maxHeightM": 8.2 },
    "reason": ["임대 물량 부족", "단가 12% 인상"],
    "targetDate": "2026-08-24"
  },
  "source": {
    "system": "메일 서버",
    "reference": "hanshin://mail/20260818/01",
    "retrievedAt": "2026-08-18T14:31:12+09:00"
  }
}
```

### 4.2 현장 상태 스냅샷

맥락 베이스는 문서만 모으지 않고 현장의 현재 상태를 하나의 스냅샷으로 유지합니다.
변경 감지는 이 스냅샷의 차이를 계산하는 방식으로 이루어집니다.

```jsonc
{
  "snapshotId": "snap_gimpo_20260818",
  "siteId": "site_gimpo_gochon_01",
  "capturedAt": "2026-08-18T18:00:00+09:00",
  "schedule": {
    "currentPhase": "골조",
    "activeTasks": [
      { "taskId": "task_4f_slab", "label": "4층 슬래브 거푸집 및 동바리", "start": "2026-08-24", "end": "2026-09-06" },
      { "taskId": "task_3f_wall", "label": "3층 벽체 콘크리트 타설", "start": "2026-08-19", "end": "2026-08-22" }
    ],
    "delayDays": 4
  },
  "materials": [
    { "code": "MAT_SYS_SHORE", "label": "시스템동바리", "supplier": "대일가설", "appliedTo": ["task_4f_slab"] }
  ],
  "equipment": [
    { "code": "EQ_TOWER_CRANE", "label": "T/C 240kg·m", "operator": "sub_jungang" }
  ],
  "openIssues": [
    { "issueId": "iss_0812", "label": "3층 개구부 덮개 미고정 지적", "status": "조치완료" }
  ],
  "lastRiskAssessment": {
    "assessmentId": "ra_2026_07_regular",
    "type": "정기",
    "completedAt": "2026-07-03",
    "coveredTasks": ["task_3f_wall", "task_4f_slab"],
    "shoringAssumption": "MAT_SYS_SHORE"
  }
}
```

여기서 결정적인 필드는 `lastRiskAssessment.shoringAssumption`입니다. 7월에 실시한
정기 위험성평가는 4층 슬래브 작업이 시스템동바리로 시공된다는 전제 위에서 작성되었습니다.
그 전제가 무너지면 평가표 전체의 유효성이 흔들립니다.

---

## 5. 변경 감지

메일 파싱 결과와 현장 스냅샷을 대조하면 변경 사항이 계산됩니다.

```jsonc
{
  "deltaId": "delta_20260818_shore",
  "siteId": "site_gimpo_gochon_01",
  "detectedAt": "2026-08-18T14:33:40+09:00",
  "sourceDocRefs": ["doc_2_k3f9x1qm", "doc_5_p8w2zzt1"],
  "category": "material",
  "summary": "4층 슬래브 동바리가 시스템동바리에서 강관동바리 혼용으로 변경될 예정입니다.",
  "before": { "material": "MAT_SYS_SHORE", "coverage": "4F 전 구간" },
  "after": { "material": "MAT_PIPE_SHORE", "coverage": "4F A~C열 1,850㎡", "mixed": true },
  "affectedTasks": ["task_4f_slab"],
  "invalidates": ["ra_2026_07_regular"],
  "severityHint": "high",
  "leadTimeDays": 6,
  "confidence": 0.91,
  "requiresHumanConfirmation": true
}
```

`requiresHumanConfirmation` 필드가 참인 이유는, 메일이 아직 검토 단계이고 최종
승인이 나지 않았기 때문입니다. 제품은 이 단계에서 결정을 내리지 않고 사람에게
확인을 요청합니다.

이어서 이 변경이 어떤 법적 사유에 해당하는지 확인하는 절차가 실행됩니다. 이때 사용하는
도구는 기존의 `search_official_law`와 `read_official_law`이고, 이벤트 구조도 동일합니다.

```jsonc
{
  "type": "tool",
  "name": "search_official_law",
  "status": "completed",
  "input": { "query": "위험성평가 실시 시기 수시평가", "search": "body" },
  "output": {
    "candidates": [
      { "ref": "law_1_a8xq2m", "kind": "eflaw", "citable": false, "title": "산업안전보건법", "authority": "고용노동부", "version": "시행 2026-01-01" },
      { "ref": "law_2_c1v7bd", "kind": "admrul", "citable": false, "title": "사업장 위험성평가에 관한 지침", "authority": "고용노동부", "version": "발령 2025-11-14" }
    ],
    "searchMode": "body",
    "fallbackUsed": false
  },
  "sources": []
}
```

```jsonc
{
  "type": "tool",
  "name": "read_official_law",
  "status": "completed",
  "input": { "ref": "law_2_c1v7bd" },
  "output": {
    "result": {
      "ref": "law_2_c1v7bd",
      "citable": true,
      "title": "사업장 위험성평가에 관한 지침",
      "provision": "제15조",
      "excerpt": "(원문 조회 결과가 이 자리에 들어갑니다. 시나리오 문서에는 실제 조문을 옮겨 적지 않습니다.)",
      "source": {
        "title": "사업장 위험성평가에 관한 지침",
        "url": "https://www.law.go.kr/LSW/admRulInfoP.do?admRulSeq=...",
        "authority": "고용노동부",
        "version": "발령 2025-11-14"
      }
    }
  },
  "sources": [{ "title": "사업장 위험성평가에 관한 지침", "url": "https://www.law.go.kr/...", "authority": "고용노동부", "version": "발령 2025-11-14" }]
}
```

원문 조회에 성공했으므로 이제 제품은 "이 변경이 수시평가 사유에 해당할 가능성이
있습니다"라는 안내를 근거와 함께 제시할 수 있습니다. 조회에 실패했다면 기존 계약대로
법적 판단을 유보하고 공식 원문 확인을 안내합니다.

---

## 6. 먼저 말을 거는 순간

2026년 8월 18일 오후 6시 12분, 박 차장이 평택 현장에서 퇴근 준비를 하던 시각에 알림이
도착합니다. 이것이 컨설팅 업체와 우리 제품이 갈리는 지점입니다. 컨설팅 업체는 다음
방문일인 9월 2일에 이 사실을 알게 되지만, 그때는 이미 타설이 시작된 뒤입니다.

```jsonc
{
  "nudgeId": "nudge_20260818_01",
  "siteId": "site_gimpo_gochon_01",
  "recipient": "user_park",
  "channel": ["push", "kakao"],
  "sentAt": "2026-08-18T18:12:00+09:00",
  "priority": "high",
  "deltaId": "delta_20260818_shore",
  "title": "4층 슬래브 동바리 자재가 바뀔 예정입니다",
  "body": "서진건설이 층고 8.2m 구간에 강관동바리 혼용을 검토 중이며 반입 목표일은 8월 24일입니다. 7월 정기 위험성평가는 시스템동바리를 전제로 작성되어 있어 재검토가 필요해 보입니다.",
  "dueBy": "2026-08-23T18:00:00+09:00",
  "actions": [
    { "actionId": "act_start", "label": "지금 위험성평가 다시 하기", "kind": "primary" },
    { "actionId": "act_photo", "label": "현장 사진부터 올리기", "kind": "secondary" },
    { "actionId": "act_defer", "label": "변경 확정된 뒤에 알림", "kind": "tertiary" },
    { "actionId": "act_dismiss", "label": "해당 없음", "kind": "dismiss", "requiresReason": true }
  ]
}
```

`act_dismiss`에 사유 입력을 강제하는 이유는 두 가지입니다. 하나는 잘못된 감지를
학습에 반영하기 위함이고, 다른 하나는 담당자가 판단을 내렸다는 기록 자체가 나중에
방어 근거가 되기 때문입니다.

박 차장은 다음 날 아침 김포 현장에 도착해 `act_photo`를 누릅니다.

---

## 7. 현장에서 올라오는 증거

### 7.1 사진 세 장과 음성 메모 한 건

박 차장은 3층 슬래브 하부에서 사진을 찍습니다. 아직 4층 작업은 시작하지 않았지만,
동일한 방식으로 시공된 3층 구간의 상태가 판단 근거가 됩니다.

```jsonc
{
  "evidenceId": "ev_20260819_a",
  "assessmentDraftId": "ra_draft_20260819",
  "capturedBy": "user_park",
  "capturedAt": "2026-08-19T09:41:22+09:00",
  "kind": "photo",
  "fileId": "file_img_0819_01",
  "geo": { "lat": 37.6012, "lng": 126.7714, "accuracyM": 8 },
  "locationLabel": "3F B열 12~14 구간 슬래브 하부",
  "vision": {
    "detected": [
      { "label": "강관동바리", "count": 34, "confidence": 0.88 },
      { "label": "수평연결재", "confidence": 0.74, "note": "일부 구간에서 확인되지 않습니다" },
      { "label": "받침철물 편심", "confidence": 0.62 }
    ],
    "caption": "강관동바리가 4단으로 조립되어 있고 중간 수평연결재가 일부 구간에서 보이지 않습니다."
  },
  "requiresHumanConfirmation": true
}
```

```jsonc
{
  "evidenceId": "ev_20260819_c",
  "assessmentDraftId": "ra_draft_20260819",
  "capturedBy": "user_park",
  "capturedAt": "2026-08-19T09:48:03+09:00",
  "kind": "voiceNote",
  "durationSec": 37,
  "transcript": "4층은 층고가 8미터가 넘어서 3층처럼 하면 안 될 것 같고, 서진 쪽에서는 24일에 자재 들어온다고 하는데 구조 검토서를 아직 못 받았어요. 타설은 9월 첫째 주로 잡혀 있습니다.",
  "extracted": {
    "concerns": ["구조 검토서 미수령", "층고 증가에 따른 좌굴 위험"],
    "dates": { "materialInbound": "2026-08-24", "concretePour": "2026-09-01" }
  }
}
```

### 7.2 되묻기

제품은 곧바로 문서를 만들지 않고 판단에 필요한 빈칸을 먼저 채웁니다. 이 되묻기는
평가표의 특정 항목과 연결되어 있어야 하며, 일반적인 질문을 나열하는 방식은 오히려
작성 부담을 늘립니다.

```jsonc
{
  "clarificationId": "clr_20260819",
  "questions": [
    {
      "questionId": "q1",
      "text": "혼용 구간의 구조 검토서를 서진건설로부터 받으셨습니까?",
      "answerType": "enum",
      "options": ["수령함", "요청했으나 미수령", "요청하지 않음"],
      "bindsTo": "riskItem.RI-03.currentControl",
      "answer": "요청했으나 미수령"
    },
    {
      "questionId": "q2",
      "text": "4층 타설 예정일이 9월 1일이 맞습니까?",
      "answerType": "date",
      "bindsTo": "assessment.scope.pourDate",
      "answer": "2026-09-01"
    },
    {
      "questionId": "q3",
      "text": "혼용 경계 구간에 별도 관리자를 지정할 계획이 있으십니까?",
      "answerType": "enum",
      "options": ["지정 예정", "미정"],
      "bindsTo": "riskItem.RI-05.owner",
      "answer": "지정 예정"
    }
  ]
}
```

---

## 8. 산출되는 문서

### 8.1 평가표 초안의 머리 부분

```jsonc
{
  "assessmentId": "ra_draft_20260819",
  "siteId": "site_gimpo_gochon_01",
  "type": "수시",
  "status": "draft",
  "createdAt": "2026-08-19T09:55:10+09:00",
  "triggeredBy": {
    "deltaId": "delta_20260818_shore",
    "reason": "동바리 자재 변경",
    "legalBasisRefs": ["law_2_c1v7bd"]
  },
  "scope": {
    "tasks": ["task_4f_slab"],
    "area": "4F A~C열 1,850㎡",
    "maxHeightM": 8.2,
    "pourDate": "2026-09-01",
    "participatingCompanies": ["sub_seojin", "sub_hanbit"]
  },
  "method": "3단계 판단법",
  "supersedes": "ra_2026_07_regular",
  "evidenceIds": ["ev_20260819_a", "ev_20260819_b", "ev_20260819_c"],
  "contextDocRefs": ["doc_2_k3f9x1qm", "doc_5_p8w2zzt1"]
}
```

### 8.2 위험 항목

각 항목은 어떤 증거와 어떤 문서에서 나왔는지를 함께 담습니다. 이 연결 고리가 없으면
문서는 다시 복사본으로 전락합니다.

```jsonc
{
  "items": [
    {
      "itemId": "RI-01",
      "process": "4층 슬래브 동바리 설치",
      "hazard": "층고 8.2m 구간에서 강관동바리 4단 조립 시 좌굴에 의한 붕괴",
      "hazardClass": "붕괴·도괴",
      "currentControl": "시스템동바리 기준의 기존 설치 지침만 존재합니다.",
      "risk": { "likelihood": 3, "severity": 4, "score": 12, "level": "높음" },
      "measures": [
        {
          "measureId": "M-01-1",
          "text": "혼용 구간 전용 구조 검토서를 반입 전까지 수령하고 원청 공무팀이 검토합니다.",
          "type": "관리적",
          "owner": "user_park",
          "dueDate": "2026-08-23",
          "status": "open"
        },
        {
          "measureId": "M-01-2",
          "text": "수평연결재를 2단마다 설치하고 설치 후 사진으로 기록합니다.",
          "type": "공학적",
          "owner": "sub_seojin",
          "dueDate": "2026-08-28",
          "status": "open"
        }
      ],
      "residualRisk": { "likelihood": 2, "severity": 4, "score": 8, "level": "보통" },
      "derivedFrom": {
        "evidenceIds": ["ev_20260819_a"],
        "contextDocRefs": ["doc_2_k3f9x1qm"],
        "clarifications": ["q1"]
      },
      "legalReferences": [
        { "ref": "law_2_c1v7bd", "citable": true, "note": "수시평가 실시 사유의 근거로 조회한 원문입니다." }
      ],
      "confirmedBy": null
    },
    {
      "itemId": "RI-03",
      "process": "시스템동바리와 강관동바리 경계 구간 시공",
      "hazard": "서로 다른 지지 방식이 만나는 지점에서 하중 전달이 불연속적으로 바뀌어 국부 침하가 발생",
      "hazardClass": "붕괴·도괴",
      "currentControl": "해당 구간에 대한 별도 지침이 없습니다.",
      "risk": { "likelihood": 3, "severity": 4, "score": 12, "level": "높음" },
      "measures": [
        {
          "measureId": "M-03-1",
          "text": "경계 구간 1.5m 범위를 시스템동바리로 통일하고 도면에 표기합니다.",
          "type": "공학적",
          "owner": "sub_seojin",
          "dueDate": "2026-08-26",
          "status": "open"
        }
      ],
      "residualRisk": { "likelihood": 2, "severity": 3, "score": 6, "level": "낮음" },
      "derivedFrom": { "evidenceIds": ["ev_20260819_a"], "contextDocRefs": ["doc_2_k3f9x1qm"], "clarifications": ["q1"] },
      "confirmedBy": null
    },
    {
      "itemId": "RI-05",
      "process": "콘크리트 타설 중 동바리 상태 감시",
      "hazard": "타설 하중이 집중되는 시점에 변형을 인지하지 못해 대피가 지연",
      "hazardClass": "붕괴·도괴",
      "currentControl": "타설 담당 반장이 겸임하여 감시합니다.",
      "risk": { "likelihood": 2, "severity": 4, "score": 8, "level": "보통" },
      "measures": [
        {
          "measureId": "M-05-1",
          "text": "타설 당일 동바리 전담 감시자를 지정하고 무전기를 지급합니다.",
          "type": "관리적",
          "owner": "sub_seojin",
          "dueDate": "2026-09-01",
          "status": "open"
        }
      ],
      "residualRisk": { "likelihood": 1, "severity": 4, "score": 4, "level": "낮음" },
      "derivedFrom": { "evidenceIds": ["ev_20260819_c"], "clarifications": ["q3"] },
      "confirmedBy": null
    }
  ]
}
```

### 8.3 초안이 끝이 아닌 이유

`confirmedBy`가 모두 비어 있다는 점이 중요합니다. 제품은 초안까지만 만들고, 위험도
점수와 감소 대책은 안전관리자가 검토한 뒤에 확정됩니다. 확정 시점에 다음 기록이
남습니다.

```jsonc
{
  "confirmation": {
    "assessmentId": "ra_draft_20260819",
    "confirmedBy": "user_park",
    "confirmedAt": "2026-08-19T11:20:44+09:00",
    "changesFromDraft": [
      { "itemId": "RI-01", "field": "risk.likelihood", "from": 3, "to": 4, "reason": "야간 작업이 포함되어 상향" }
    ],
    "participants": [
      { "personId": "sub_seojin_lee", "role": "골조 작업반장" },
      { "personId": "sub_hanbit_kim", "role": "가설 반장" },
      { "personId": "user_choi", "role": "안전보건관리담당자" }
    ],
    "signatureMethod": "모바일 서명"
  }
}
```

### 8.4 함께 만들어지는 산출물

평가표가 확정되면 그 내용을 재료로 삼아 다른 문서가 파생됩니다. 같은 사실을 여러 번
입력하지 않게 하는 것이 핵심입니다.

| 산출물 | 생성 방식 | 대상 |
| --- | --- | --- |
| TBM 자료 | RI-01, RI-03, RI-05의 감소 대책을 작업자 언어로 변환 | 8월 24일부터 9월 1일까지 매일 |
| 작업 전 점검표 | 각 감소 대책을 확인 항목으로 전환 | 동바리 설치 담당 반장 |
| 하도급사 통보 공문 | 확정된 대책과 기한을 발췌 | 서진건설, 한빛가설 |
| 감사 대응 묶음 | 트리거, 증거, 평가표, 서명, 조치 이력을 시간순으로 정렬 | 발주처 및 감독기관 요청 시 |

---

## 9. 이후의 전개

### 9.1 8월 26일: 두 번째 트리거

서진건설이 구조 검토서를 제출하면서 혼용 범위를 A열과 B열로 축소하겠다고 통보합니다.
이는 또 하나의 변경이며, 제품은 다시 감지합니다. 이번에는 변경 폭이 작고 위험을
줄이는 방향이므로 우선순위가 낮게 부여됩니다.

```jsonc
{
  "deltaId": "delta_20260826_scope",
  "category": "scope",
  "summary": "혼용 구간이 A~C열에서 A~B열로 축소되었습니다.",
  "severityHint": "medium",
  "affectedAssessments": ["ra_20260819"],
  "recommendedAction": "amend",
  "amendmentTarget": ["RI-01.scope", "RI-03.scope"]
}
```

전면 재작성이 아니라 부분 수정을 제안하는 점이 중요합니다. 매번 처음부터 다시 쓰게
만들면 사람은 결국 제품을 쓰지 않게 됩니다.

### 9.2 9월 1일: 타설 당일

타설 당일 아침, 전날 확정된 대책 가운데 아직 완료되지 않은 항목이 알림으로 정리되어
전달됩니다.

```jsonc
{
  "nudgeId": "nudge_20260901_01",
  "priority": "critical",
  "title": "오늘 타설 전에 확인이 끝나지 않은 항목이 2건 있습니다",
  "openMeasures": [
    { "measureId": "M-01-2", "text": "수평연결재 2단 설치 사진 기록", "owner": "sub_seojin", "dueDate": "2026-08-28" },
    { "measureId": "M-05-1", "text": "동바리 전담 감시자 지정", "owner": "sub_seojin", "dueDate": "2026-09-01" }
  ]
}
```

---

## 10. 데이터가 쌓인 뒤에 열리는 것

한 현장에서 19개월 동안 이런 기록이 쌓이면 다음 형태의 자산이 만들어집니다. 아래는
확장 방향에 대한 구상이며 현재 제품 범위는 아닙니다.

**첫째, 하도급사 단위의 이력입니다.** 어떤 업체가 어떤 종류의 변경을 얼마나 자주
일으키는지, 통보 시점과 실제 반입 시점의 간격이 얼마인지, 감소 대책의 기한 준수율이
어떤지가 누적됩니다. 이는 신용 평가나 시공능력 정보가 담지 못하는 실행 품질 정보이며,
입찰 심사와 협력사 관리에 직접 쓰입니다.

```jsonc
{
  "contractorProfile": {
    "companyId": "sub_seojin",
    "observationWindow": "2026-03 ~ 2026-08",
    "changeEventsInitiated": 7,
    "avgNoticeLeadTimeDays": 5.4,
    "measureOnTimeRate": 0.71,
    "recurringHazardClasses": ["붕괴·도괴", "떨어짐"]
  }
}
```

**둘째, 자재와 공법 선택에 대한 근거입니다.** 시스템동바리 대신 강관동바리를 쓰면
임대비는 줄지만 추가로 발생하는 관리 부담과 위험이 데이터로 남습니다. 여러 현장의
기록이 모이면 단가 차이와 안전 비용을 함께 놓고 비교하는 판단 자료를 제공할 수 있습니다.

**셋째, 다른 이해관계자로의 확장입니다.** 지금은 원청 안전관리자를 사용자로 삼고
있지만, 같은 데이터 위에서 발주처는 현장별 위험 상태를 비교할 수 있고, 감리는 조치
이력을 추적할 수 있으며, 하도급사는 자신에게 배정된 대책만 따로 볼 수 있습니다.
사용자를 늘리는 것이 아니라 이미 만들어진 기록의 소비자를 늘리는 방향입니다.

---

## 11. 이 시나리오가 데이터 모델에 요구하는 것

| 요구 사항 | 이유 |
| --- | --- |
| 후보와 원문의 분리를 회사 문서에도 적용 | 법령 도구와 동일한 인용 안전 계약을 유지해야 합니다. |
| 모든 위험 항목이 증거와 문서를 역참조 | 감사에서 문서의 근거를 설명할 수 있어야 합니다. |
| 변경 이력이 평가표를 무효화하는 관계를 명시 | 어떤 평가표가 언제부터 유효하지 않은지 판단해야 합니다. |
| 부분 수정을 전면 재작성과 구분 | 반복 작업 부담이 곧 이탈 사유가 되기 때문입니다. |
| 확정 주체와 시점을 기록 | 초안은 제품이 만들지만 책임은 사람이 집니다. |
| 감지 결과에 확신도와 확인 요구 플래그를 부여 | 자동 판단이 잘못되었을 때 안전한 실패가 가능해야 합니다. |
