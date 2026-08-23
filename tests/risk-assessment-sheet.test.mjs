import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";

import {
  등급읽기,
  매트릭스읽기,
  이행확인표기,
  평가표만들기,
} from "../tmp/test-dist/lib/risk/assessment-sheet.js";

/**
 * 내려받은 파일은 **결재에 올라간다.** 화면과 달리 고칠 기회가 없고, 틀린 채로 남는다.
 * 그래서 여기 시험은 서식이 예쁜지가 아니라 **값이 뭉개지지 않는지**를 본다.
 *
 * 뼈대(병합 범위·열 너비·머리 글자)는 본보기 파일
 * `risk-assessment-20260822-292b8cba.xlsx` 에서 openpyxl 로 읽어 적어 둔 것이다.
 * 본보기를 만드는 쪽은 `gb-hackathon/backend/app/report/excel.py` 다.
 */

const 행 = (덧붙임 = {}) => ({
  회의록: "ra_2026_08_regular",
  행id: "RI-01",
  단위작업: "4층 슬래브 동바리 설치",
  ...덧붙임,
});

/** 통합문서를 실제 파일 바이트로 냈다가 **다시 열어** 돌려준다. */
async function 되열기(wb) {
  const buf = await wb.xlsx.writeBuffer();
  const 다시 = new ExcelJS.Workbook();
  await 다시.xlsx.load(buf);
  return 다시.getWorksheet("위험성평가표");
}

/* ------------------------------------------------------------------ *
 * 이행확인 — 이 파일이 있는 이유
 * ------------------------------------------------------------------ */

test('이행확인은 상태가 셋이고 "불일치" 가 "확인" 으로 뭉개지지 않는다', () => {
  assert.equal(이행확인표기(행({ 이행확인: true })), "확인");
  // `!"불일치"` 가 false 라, 참/거짓 둘로 누르면 위조 판정 행이 확인으로 넘어간다.
  assert.equal(이행확인표기(행({ 이행확인: "불일치" })), "불일치");
  assert.equal(이행확인표기(행({ 이행확인: false })), "");
  assert.equal(이행확인표기(행({})), "");
});

test("빈칸은 글자 없이 비운다 — 「빈칸」이라고 적으면 그것도 기재가 된다", async () => {
  const ws = await 되열기(평가표만들기([행({ 이행확인: false })]));
  assert.equal(ws.getCell("N9").value, null);
});

test("위조로 판정된 행은 내려받은 파일에도 「불일치」로 남는다", async () => {
  const 행들 = [
    행({ 행id: "RI-03", 이행확인: null }),
    행({ 행id: "RI-04", 이행확인: "불일치", 표시값: true, 실제실행: false, 근거: "nm_20260818_01" }),
    행({ 행id: "RI-05", 이행확인: true }),
  ];
  const ws = await 되열기(평가표만들기(행들));
  assert.deepEqual(
    [9, 10, 11].map((r) => ws.getCell(`N${r}`).value),
    [null, "불일치", "확인"],
  );
});

/* ------------------------------------------------------------------ *
 * 위험도 등급 — 매트릭스를 모르면 칠하지 않는다
 * ------------------------------------------------------------------ */

test("평가기법에서 매트릭스를 읽는다. 아는 것만 읽는다", () => {
  assert.equal(매트릭스읽기("빈도·강도법 4x3"), "4x3");
  assert.equal(매트릭스읽기("빈도강도법 5×4"), "5x4");
  assert.equal(매트릭스읽기("빈도·강도법"), null);
  assert.equal(매트릭스읽기(undefined), null);
  // 우리가 기준을 모르는 매트릭스. 색을 칠하지 않는 쪽이 맞다.
  assert.equal(매트릭스읽기("빈도·강도법 6x5"), null);
});

test("등급 경계는 매트릭스마다 다르다 — 같은 12 가 높음도 되고 중간도 된다", () => {
  assert.equal(등급읽기(12, "4x3"), "높음");
  assert.equal(등급읽기(12, "5x4"), "중간");
  assert.equal(등급읽기(9, "4x3"), "높음");
  assert.equal(등급읽기(8, "4x3"), "중간");
  assert.equal(등급읽기(3, "4x3"), "낮음");
  assert.equal(등급읽기(15, "5x4"), "높음");
  assert.equal(등급읽기(5, "5x4"), "낮음");
  // 매트릭스를 모르면 등급도 없다.
  assert.equal(등급읽기(12, null), null);
  assert.equal(등급읽기(undefined, "4x3"), null);
});

test("매트릭스를 모르면 위험도 칸에 색을 칠하지 않고 머리에 괄호도 안 붙인다", async () => {
  const 점수행 = 행({ 개선전: { 빈도: 3, 강도: 4, 위험도: 12 } });
  const 모름 = await 되열기(평가표만들기([점수행]));
  assert.equal(모름.getCell("E7").value, "⑤개선 전 위험성 산정");
  assert.equal(모름.getCell("G9").fill.pattern, "none");

  const 앎 = await 되열기(평가표만들기([점수행], { 평가기법: "빈도·강도법 4x3" }));
  assert.equal(앎.getCell("E7").value, "⑤개선 전 위험성 산정 (4x3)");
  assert.equal(앎.getCell("G9").fill.fgColor.argb, "FFF8CBCB"); // 높음
});

/* ------------------------------------------------------------------ *
 * 서식 뼈대 — 본보기와 같은 모양인가
 * ------------------------------------------------------------------ */

test("본보기와 같은 열 너비 15열", async () => {
  const ws = await 되열기(평가표만들기([행()]));
  assert.deepEqual(
    Array.from({ length: 15 }, (_, i) => ws.getColumn(i + 1).width),
    [14, 16, 10, 52, 6, 6, 7, 52, 6, 6, 7, 26, 12, 11, 11],
  );
});

test("자료 9행이면 본보기와 병합 범위가 같다", async () => {
  const 행들 = Array.from({ length: 9 }, (_, i) => 행({ 행id: `RI-0${i + 1}` }));
  const ws = await 되열기(평가표만들기(행들));
  // 본보기 파일에서 openpyxl 로 읽은 34개 범위 그대로.
  assert.deepEqual(ws.model.merges.slice().sort(), [
    "A1:C3", "A19:O19", "A27:O27", "A7:D7",
    "B20:G20", "B21:G21", "B22:G22", "B23:G23", "B24:G24", "B25:G25",
    "B4:C4", "B5:G5", "D1:I3", "E4:F4", "E7:G7", "H4:J4",
    "I5:O5", "I7:K7", "J1:O1", "J2:K2", "J3:K3",
    "L2:M2", "L3:M3", "L4:N4", "L7:M7",
    "N20:O20", "N21:O21", "N22:O22", "N23:O23", "N24:O24", "N25:O25",
    "N2:O2", "N3:O3", "N7:O7",
  ].sort());
});

test("본보기와 같은 머리 글자", async () => {
  // 본보기와 같은 자리에 놓이도록 자료도 9행으로 맞춘다.
  const 행들 = Array.from({ length: 9 }, (_, i) => 행({ 행id: `RI-0${i + 1}` }));
  const ws = await 되열기(평가표만들기(행들));
  const 글자 = (co) => ws.getCell(co).value;
  assert.equal(글자("J1"), "①위험성 결정, 감소대책 수립 및 실행계획 확인");
  assert.equal(글자("J2"), "검토자\n(위험성평가담당자)");
  assert.equal(글자("L2"), "근로자대표\n(작업반장 등)");
  assert.equal(글자("N2"), "승인자\n(현장소장)");
  assert.deepEqual(["A4", "D4", "G4", "K4"].map(글자), ["작성일자", "관리기간", "평가기법", "근거"]);
  assert.deepEqual(["A5", "H5"].map(글자), ["공종", "장비·자재"]);
  assert.equal(글자("A7"), "분석 기반 정보");
  assert.equal(글자("N7"), "⑩이행확인 (조치한 경우)");
  assert.deepEqual(
    ["A8", "B8", "C8", "D8", "E8", "F8", "G8", "H8", "I8", "J8", "K8", "L8", "M8", "N8", "O8"].map(글자),
    ["①공종분류", "②단위작업", "③사고분류", "④위험요인", "빈도", "강도", "위험도",
     "⑥위험방지대책", "빈도", "강도", "위험도", "⑧법적 근거", "⑨개선조치\n담당자",
     "근로자대표", "공사담당자"],
  );
  assert.equal(글자("A19"), "주간 위험성평가 결과 논의·공유 및 이행현황 점검");
  assert.equal(글자("N20"), "《 TBM 순서 》");
  assert.deepEqual(
    ["N21", "N22", "N23", "N24", "N25"].map(글자),
    ["01. 상호 인사", "02. 보호구 확인", "03. 당일 작업 전달", "04. 가설자재 점검", "05. 지적확인"],
  );
});

test("주간 점검란과 꼬리줄은 자료 행 수만큼 아래로 밀린다", async () => {
  const 행들 = Array.from({ length: 21 }, (_, i) => 행({ 행id: `RI-${i + 1}` }));
  const ws = await 되열기(평가표만들기(행들));
  // 9행부터 21행 → 마지막 자료는 29행, 한 줄 띄고 31행이 주간 제목.
  assert.equal(ws.getCell("A31").value, "주간 위험성평가 결과 논의·공유 및 이행현황 점검");
  assert.equal(ws.getCell("A32").value, "주차");
  assert.equal(ws.getCell("A37").value, "5주차");
  assert.match(String(ws.getCell("A39").value), /^출력 \d{4}\. \d{2}\. \d{2}$/);
});

/* ------------------------------------------------------------------ *
 * 머리칸 — 모르는 것은 채우지 않는다
 * ------------------------------------------------------------------ */

test("이름을 모르는 결재자는 빈칸으로 둔다 — 총칭을 적으면 없는 서명을 지어낸다", async () => {
  const ws = await 되열기(
    평가표만들기([행()], {
      결재자: { 검토자: "user_park", 근로자대표: "sub_seojin_lee", 승인자: "현장소장" },
    }),
  );
  assert.equal(ws.getCell("J3").value, "박정우");
  assert.equal(ws.getCell("L3").value, null);
  assert.equal(ws.getCell("N3").value, null);
});

test("머리 정보를 아예 안 주면 서식만 그리고 칸을 비운다", async () => {
  const 행들 = Array.from({ length: 9 }, (_, i) => 행({ 행id: `RI-0${i + 1}` }));
  const ws = await 되열기(평가표만들기(행들));
  assert.equal(ws.getCell("A1").value, null); // 업종
  assert.equal(ws.getCell("B4").value, null); // 작성일자
  assert.equal(ws.getCell("I5").value, null); // 장비·자재
  // 월을 모르면 제목에 월을 붙이지 않는다.
  assert.equal(ws.getCell("D1").value, "위험성평가 및 점검 회의록");
  // 꼬리줄도 모르는 토막은 통째로 뺀다. `장비·설비: -` 는 "확인했더니 없다" 로 읽힌다.
  assert.match(String(ws.getCell("A27").value), /^출력 /);
});

test("작성일자의 월이 제목에 들어간다", async () => {
  const ws = await 되열기(평가표만들기([행()], { 작성일자: "2026-08-05" }));
  assert.equal(ws.getCell("D1").value, "(08월) 위험성평가 및 점검 회의록");
  assert.equal(ws.getCell("B4").value, "2026.08.05");
});

/* ------------------------------------------------------------------ *
 * 자료 칸
 * ------------------------------------------------------------------ */

test("대책은 ● 로 시작하는 줄바꿈 목록, 법적 근거는 글머리 없는 줄바꿈 목록", async () => {
  const ws = await 되열기(
    평가표만들기([
      행({
        위험요인: "층고 8.2m 구간에서 동바리 좌굴에 의한 붕괴",
        대책: ["설치 상세도에 따라 조립합니다.", "설치 후 원청이 검측합니다."],
        법적근거: ["제330조(거푸집 및 동바리의 구조)", "제42조(추락의 방지)"],
      }),
    ]),
  );
  assert.equal(ws.getCell("D9").value, "● 층고 8.2m 구간에서 동바리 좌굴에 의한 붕괴");
  assert.equal(
    ws.getCell("H9").value,
    "● 설치 상세도에 따라 조립합니다.\n● 설치 후 원청이 검측합니다.",
  );
  assert.equal(
    ws.getCell("L9").value,
    "제330조(거푸집 및 동바리의 구조)\n제42조(추락의 방지)",
  );
});

test("법적 근거가 비어 있으면 비워 둔다 — 「-」 를 적으면 공란이 기재로 보인다", async () => {
  // 시드의 `미비` 는 「법적 근거란 공란 12행」이라고 말한다. 그 공란이 이 파일에서
  // 채워진 것처럼 보이면, 결재를 막고 있는 사유가 문서에서 사라진다.
  const ws = await 되열기(평가표만들기([행({ 법적근거: [] })]));
  assert.equal(ws.getCell("L9").value, null);
});

test("개선 후 위험도가 없는 행은 세 칸을 비운다", async () => {
  const ws = await 되열기(평가표만들기([행({ 개선전: { 빈도: 3, 강도: 3, 위험도: 9 } })]));
  assert.deepEqual([9, 3, null, null, null], [
    ws.getCell("G9").value,
    ws.getCell("F9").value,
    ws.getCell("I9").value,
    ws.getCell("J9").value,
    ws.getCell("K9").value,
  ]);
});

test("담당사는 회사 이름으로 적는다", async () => {
  const ws = await 되열기(
    평가표만들기([행({ 담당사: "sub_seojin" }), 행({ 행id: "RI-02", 담당사: "sub_unknown" })]),
  );
  assert.equal(ws.getCell("M9").value, "서진건설");
  // 목록에 없는 코드를 그대로 내보내면 서식에 저장소 키가 찍힌다.
  assert.equal(ws.getCell("M10").value, "협력사");
});
