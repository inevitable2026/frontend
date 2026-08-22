// ③-1 서진건설 자재 변경 협의 공문 — T-03 의 입구.
//
// 제목에는 「협의」가 있고 본문의 근거는 단가와 공기다. 안전 문서처럼 보이지 않는
// 문서가 수시평가 사유라는 것이 이 시나리오의 요점이므로, 서식도 그렇게 쓴다.

import { 문서, 머리표, 표, 서명란, 접수인, esc } from "../lib/render.mjs";
import { 현장, 회사, 인물 } from "../data/site.mjs";

export const 변경정보 = {
  docId: "doc_2_k3f9x1qm",
  발신일: "2026-08-18",
  수신시각: "2026-08-18T14:22:00+09:00",
  changeType: "materialSubstitution",
  from: { code: "MAT_SYS_SHORE", label: "시스템동바리" },
  to: { code: "MAT_PIPE_SHORE", label: "강관동바리", spec: "φ48.6×3.2t, 4단 조립" },
  scope: { floor: "4F", grid: "A~C", areaSqm: 1850, maxHeightM: 8.2, taskId: "task_4f_slab" },
  reason: ["임대 물량 부족", "단가 12% 인상"],
  targetDate: "2026-08-24",
};

export default {
  id: "seojin-material-letter",
  파일명: "03_서진건설_자재변경_협의공문",
  kind: "기타",
  제목: "4층 슬래브 동바리 자재 변경 협의의 건",
  먹이는조건: ["T-03"],
  html() {
    const 본문 = `
${접수인(`${회사.원청} 공무팀`)}
${머리표([
  [["문서번호", "서진-공무-2026-0818-03"], ["발신일자", 변경정보.발신일]],
  [["수    신", `${회사.원청} 공무팀장`], ["참    조", `${회사.원청} 안전관리자 ${인물.박정우.성명}`]],
  [["발    신", `${회사.골조} 공무담당 ${인물.권상열.성명}`], ["연 락 처", "kwon@seojin-const.co.kr"]],
  [["현    장", 현장.name], ["대상 공정", "4층 슬래브 거푸집 및 동바리 (task_4f_slab)"]],
  [["제    목", "4층 슬래브 동바리 자재 변경 협의의 건"]],
])}
<div class="clear"></div>

<h2>1. 협의 내용</h2>
<p>귀사의 무궁한 발전을 기원합니다. 당사가 시공 중인 위 현장 4층 슬래브 공정과 관련하여
아래와 같이 동바리 자재 변경을 협의드리오니 검토 후 회신하여 주시기 바랍니다.</p>
<p>당초 4층 슬래브 전 구간에 <b>시스템동바리</b>를 적용하기로 하였으나, 임대사 물량 부족과
8월 단가 인상(전월 대비 12%)으로 인해 <b>층고 8.2m 구간(A~C열, 약 1,850㎡)에 한해
강관동바리 혼용 시공</b>을 검토하고 있습니다. 공기 지연 방지를 위해
<b>8월 24일 반입</b>을 목표로 하며, 회신 부탁드립니다.</p>

<h2>2. 변경 대비표</h2>
${표(
  [
    { 제목: "구분", w: "16%", cls: "c" },
    { 제목: "당초 (변경 전)", w: "34%" },
    { 제목: "변경 후 (검토안)", w: "34%" },
    { 제목: "비고", w: "16%" },
  ],
  [
    ["자재 코드", `<b>${esc(변경정보.from.code)}</b>`, `<b>${esc(변경정보.to.code)}</b>`, "자재 대체"],
    ["자재명", esc(변경정보.from.label), esc(변경정보.to.label), ""],
    ["규격", "수직재 φ60.5×2.3t · 수평재 1,800mm", esc(변경정보.to.spec), "혼용"],
    ["적용 범위", "4층 슬래브 전 구간", `4F ${esc(변경정보.scope.grid)}열 약 ${변경정보.scope.areaSqm.toLocaleString()}㎡`, "부분 적용"],
    ["최대 층고", "8.2 m", "8.2 m", "동일"],
    ["반입 목표일", "2026-08-31", `<b>${esc(변경정보.targetDate)}</b>`, "7일 단축"],
    ["변경 사유", "-", esc(변경정보.reason.join(" · ")), ""],
  ],
)}

<h2>3. 첨부</h2>
${표(
  [
    { 제목: "연번", w: "8%", cls: "c" },
    { 제목: "문서명", w: "46%" },
    { 제목: "쪽수", w: "10%", cls: "c" },
    { 제목: "비고", w: "36%" },
  ],
  [
    ["1", "동바리 대체자재 견적서", "3", "단가 및 수량"],
    ["2", "강관동바리 사양서", "8", "규격 · 수량 · 조립 기준"],
    ["3", "구조 검토서", "-", "<b>미첨부.</b> 별도 협의 후 제출 예정"],
  ],
)}

<div class="note">
<b>회신 요청</b> — 반입 예정일이 ${esc(변경정보.targetDate)} 이므로 그 전에 회신하여 주시기 바랍니다.
본 문서는 검토 단계의 협의 요청이며 최종 승인 문서가 아닙니다.
</div>

<h2>4. 발신 명의</h2>
<p style="text-align:center;font-size:12pt;margin-top:8mm;letter-spacing:0.3em">${esc(회사.골조)} 대표이사</p>
<div style="text-align:center;margin-top:3mm">
  <span style="display:inline-block;width:22mm;height:22mm;border:1px dashed #c00;border-radius:50%;color:#c88;font-size:7pt;line-height:22mm">(직인)</span>
</div>

${서명란(
  [
    { 소속: 회사.골조, 직위: "작성", 성명: 인물.권상열.성명 },
    { 소속: 회사.골조, 직위: "검토", 성명: "홍재석" },
    { 소속: 회사.골조, 직위: "승인", 성명: "우병국" },
  ],
  3,
  "발신 검토 · 승인",
)}

<h2>수신처 처리란</h2>
${표(
  [
    { 제목: "처리 구분", w: "20%", cls: "c" },
    { 제목: "담당", w: "16%", cls: "c" },
    { 제목: "처리일", w: "16%", cls: "c" },
    { 제목: "처리 결과", w: "48%" },
  ],
  [
    ["공무팀 접수", '<span class="blank"></span>', '<span class="blank"></span>', '<span class="blank" style="min-width:60mm"></span>'],
    ["안전관리자 검토", '<span class="blank"></span>', '<span class="blank"></span>', '<span class="blank" style="min-width:60mm"></span>'],
    ["회신 발송", '<span class="blank"></span>', '<span class="blank"></span>', '<span class="blank" style="min-width:60mm"></span>'],
  ],
)}
`;
    return 문서({
      제목: "협 조 공 문",
      문서번호: `서진-공무-2026-0818-03 · ${변경정보.docId}`,
      머리말: `${esc(회사.골조)} &nbsp;|&nbsp; ${esc(현장.name)}`,
      본문,
    });
  },
};
