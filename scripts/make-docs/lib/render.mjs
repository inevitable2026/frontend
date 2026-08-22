// 서식 렌더링 헬퍼.
//
// 모든 더미 문서는 여기 있는 `문서()` 로 감싸서 만든다. 그래야 고지 문구와
// 표·서명란·도장 자리의 모양이 문서마다 어긋나지 않는다.
//
// 외부 의존성 없음. Node 표준 라이브러리만 쓴다.

/** 가상 시나리오 고지. 모든 문서의 머리와 각 쪽 꼬리에 박힌다. */
export const 고지문 =
  "가상 시나리오이며 등장하는 회사와 인물과 문서와 금액은 모두 허구입니다.";

/** 법령 인용 규칙 안내. 조문 본문을 옮겨 적지 않는다는 계약을 문서에도 남긴다. */
export const 법령고지문 =
  "법적 근거는 조문 번호와 제목까지만 적는다. 조문 본문은 공식 원문 조회 결과로만 채운다.";

export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 값이 비었으면 공란 표시(옅은 점선)를 그린다. 「빈 칸이 비어 있다」가 눈에 보여야 한다. */
export function 칸(v) {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "" ? '<span class="blank"></span>' : esc(s);
}

export function 체크(done) {
  return done ? '<span class="chk">✔</span>' : '<span class="blank sm"></span>';
}

const BASE_CSS = `
@page { size: A4; margin: 14mm 13mm 18mm 13mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Apple SD Gothic Neo", "AppleSDGothicNeo-Regular", "Malgun Gothic",
               "Nanum Gothic", "Noto Sans KR", sans-serif;
  font-size: 9.4pt; line-height: 1.5; color: #111;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1 { font-size: 17pt; letter-spacing: 0.06em; text-align: center; margin: 2mm 0 1mm; }
h2 { font-size: 11pt; margin: 6mm 0 2mm; padding-left: 2mm; border-left: 3px solid #111; }
h3 { font-size: 9.8pt; margin: 4mm 0 1.5mm; color: #333; }
p  { margin: 0 0 2mm; }
small { font-size: 8pt; color: #555; }

/* ── 고지 ───────────────────────────────────────────── */
/* 쪽마다 반복시키려고 바깥 표의 thead 에 넣는다.
   Chrome 의 --print-to-pdf 는 position:fixed 를 본문 상자 밖으로 밀면 잘라 버리는데,
   display:table-header-group 은 매 쪽 위에 다시 그려 준다. 실측으로 확인했다 —
   40mm 짜리 머리를 thead 에 넣으면 쪽수가 늘고, tbody 에 넣으면 늘지 않는다. */
table.pageframe { width: 100%; border-collapse: collapse; }
table.pageframe > thead { display: table-header-group; }
table.pageframe > thead > tr > td { padding: 0 0 3mm 0; border: 0; }
table.pageframe > tbody > tr > td { padding: 0; border: 0; }
.notice-bar {
  border: 1.2px solid #b00; color: #b00; background: #fff5f5;
  font-size: 7.8pt; font-weight: 700; padding: 1.3mm 2mm; letter-spacing: 0.02em;
  display: flex; justify-content: space-between; gap: 4mm;
}
.notice-bar .no { color: #888; font-weight: 400; white-space: nowrap; }

/* ── 문서 머리 ───────────────────────────────────────── */
.doc-meta { width: 100%; border-collapse: collapse; margin: 2mm 0 4mm; }
.doc-meta th, .doc-meta td { border: 0.8px solid #444; padding: 1.4mm 2mm; font-size: 8.8pt; }
.doc-meta th { background: #f0f0f0; width: 22mm; font-weight: 600; text-align: center; white-space: nowrap; }

/* ── 일반 표 ─────────────────────────────────────────── */
table.grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.grid th, table.grid td {
  border: 0.7px solid #555; padding: 1.1mm 1.4mm; font-size: 8.1pt;
  vertical-align: top; word-break: break-all; overflow-wrap: anywhere;
}
table.grid thead th { background: #e8e8e8; text-align: center; font-weight: 700; font-size: 8.1pt; word-break: keep-all; }
table.grid thead { display: table-header-group; }
table.grid tr { break-inside: avoid; }
table.grid td.c { text-align: center; }
table.grid td.r { text-align: right; }
table.grid td.num, table.grid th.num { text-align: center; }
tr.hi td { background: #fff8e1; }

.blank {
  display: inline-block; min-width: 14mm; height: 3.4mm;
  border-bottom: 0.7px dotted #b0b0b0; vertical-align: middle;
}
.blank.sm { min-width: 6mm; }
.chk { font-weight: 700; }

/* ── 서명 · 도장 ─────────────────────────────────────── */
.sign-table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
.sign-table th, .sign-table td { border: 0.7px solid #555; font-size: 8pt; padding: 0; }
.sign-table th { background: #eee; padding: 1.2mm; text-align: center; white-space: nowrap; }
.sign-cell { height: 13mm; position: relative; padding: 1.2mm !important; }
.sign-cell .who { font-size: 8pt; }
.sign-cell .rule {
  position: absolute; left: 3mm; right: 10mm; bottom: 2.5mm;
  border-bottom: 0.7px solid #999;
}
.sign-cell .seal {
  position: absolute; right: 2mm; bottom: 1.5mm;
  width: 9mm; height: 9mm; border: 0.8px dashed #c00; border-radius: 50%;
  color: #c88; font-size: 5.6pt; text-align: center; line-height: 9mm;
}
.approval { border-collapse: collapse; float: right; margin: 0 0 2mm 3mm; }
.approval th, .approval td { border: 0.7px solid #444; text-align: center; font-size: 7.4pt; }
.approval th { background: #f0f0f0; padding: 1mm 2mm; white-space: nowrap; }
.approval td { width: 17mm; height: 15mm; vertical-align: bottom; padding-bottom: 1mm; color: #999; font-size: 6.6pt; }

/* ── 기타 ────────────────────────────────────────────── */
.note { border: 0.7px solid #999; background: #fafafa; padding: 2mm 2.5mm; font-size: 8pt; margin: 2.5mm 0; }
.note b { color: #b00; }
.page-break { break-before: page; }
ul.tight { margin: 0 0 2mm; padding-left: 5mm; }
ul.tight li { margin-bottom: 0.6mm; font-size: 8.6pt; }
.legend { font-size: 7.6pt; color: #666; margin-top: 1.5mm; }
.stamp-recv {
  float: right; width: 30mm; border: 0.8px solid #555; font-size: 7pt; text-align: center;
  margin-left: 3mm;
}
.stamp-recv .hd { background: #eee; border-bottom: 0.8px solid #555; padding: 0.8mm; }
.stamp-recv .bd { height: 14mm; color: #aaa; line-height: 14mm; }
.clear { clear: both; }
`;

/**
 * 한 장의 문서를 완성된 HTML 문자열로 만든다.
 *
 * @param {object} o
 * @param {string} o.제목      문서 표제 (h1)
 * @param {string} o.문서번호   우측 상단·꼬리에 박히는 관리번호
 * @param {string} [o.머리말]   표제 위 작은 줄 (발신기관 등)
 * @param {string} o.본문      HTML 조각
 */
export function 문서({ 제목, 문서번호, 머리말 = "", 본문 }) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>${esc(제목)}</title>
<style>${BASE_CSS}</style>
</head><body>
<table class="pageframe">
<thead><tr><td>
  <div class="notice-bar"><span>${esc(고지문)}</span><span class="no">${esc(문서번호)}</span></div>
</td></tr></thead>
<tbody><tr><td>
${머리말 ? `<div style="font-size:8.6pt;color:#444">${머리말}</div>` : ""}
<h1>${esc(제목)}</h1>
${본문}
<div style="margin-top:6mm;border-top:0.6px solid #999;padding-top:1.5mm;font-size:7.4pt;color:#666">
  <b style="color:#b00">${esc(고지문)}</b> ${esc(법령고지문)} &nbsp;·&nbsp; 문서번호 ${esc(문서번호)}
</div>
</td></tr></tbody>
</table>
</body></html>`;
}

/**
 * 문서 머리의 라벨-값 격자. rows 는 [[라벨,값],[라벨,값]] 을 한 줄에 두 쌍씩 넣는다.
 * 값은 HTML 조각으로 그대로 들어간다 — 여기 들어오는 값은 전부 이 레포가 쓴 문자열이다.
 */
export function 머리표(rows) {
  const 값 = (v) => {
    const s = v === null || v === undefined ? "" : String(v).trim();
    return s === "" ? '<span class="blank"></span>' : s;
  };
  const tr = rows
    .map((r) => {
      if (r.length === 1) {
        return `<tr><th>${esc(r[0][0])}</th><td colspan="3">${값(r[0][1])}</td></tr>`;
      }
      return `<tr>${r.map(([k, v]) => `<th>${esc(k)}</th><td>${값(v)}</td>`).join("")}</tr>`;
    })
    .join("\n");
  return `<table class="doc-meta">${tr}</table>`;
}

/** 결재란(도장 자리). names 는 직위 배열. */
export function 결재란(names) {
  return `<table class="approval">
<tr><th rowspan="2" style="writing-mode:vertical-rl;padding:2mm 1mm">결재</th>${names.map((n) => `<th>${esc(n)}</th>`).join("")}</tr>
<tr>${names.map(() => `<td>(인)</td>`).join("")}</tr>
</table>`;
}

/** 접수인 자리. */
export function 접수인(기관) {
  return `<div class="stamp-recv"><div class="hd">접 수</div><div class="bd">${esc(기관)}</div></div>`;
}

/**
 * 서명란. people 은 [{ 소속, 직위, 성명 }] 이며 cols 개씩 끊어 그린다.
 * 서명 줄과 날인 자리를 실제로 그린다 — 파이프라인의 「표·서명인식」 단계가 볼 것이 있어야 한다.
 */
export function 서명란(people, cols = 4, 표제 = "확인 · 서명") {
  const rows = [];
  for (let i = 0; i < people.length; i += cols) rows.push(people.slice(i, i + cols));
  const body = rows
    .map((row) => {
      const head = row
        .map((p) => `<th>${esc(p.소속 ?? "")}${p.직위 ? ` ${esc(p.직위)}` : ""}</th>`)
        .join("");
      const pad = cols - row.length;
      const headPad = "<th></th>".repeat(pad);
      const cells = row
        .map(
          (p) =>
            `<td class="sign-cell"><span class="who">${esc(p.성명)}</span><span class="rule"></span><span class="seal">(서명)</span></td>`,
        )
        .join("");
      const cellPad = '<td class="sign-cell"></td>'.repeat(pad);
      return `<tr>${head}${headPad}</tr><tr>${cells}${cellPad}</tr>`;
    })
    .join("\n");
  return `<h3>${esc(표제)}</h3><table class="sign-table">${body}</table>`;
}

/** 표 한 장. cols = [{ 제목, w?(퍼센트), cls? }], rows = 문자열 배열의 배열(이미 HTML). */
export function 표(cols, rows, { cls = "" } = {}) {
  const colgroup = cols.some((c) => c.w)
    ? `<colgroup>${cols.map((c) => `<col style="width:${c.w ?? ""}">`).join("")}</colgroup>`
    : "";
  const thead = `<thead><tr>${cols.map((c) => `<th>${esc(c.제목)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map((r) => {
      const rowCls = r.__cls ? ` class="${r.__cls}"` : "";
      const cells = (r.__cells ?? r)
        .map((v, i) => `<td class="${cols[i]?.cls ?? ""}">${v}</td>`)
        .join("");
      return `<tr${rowCls}>${cells}</tr>`;
    })
    .join("\n")}</tbody>`;
  return `<table class="grid ${cls}">${colgroup}${thead}${tbody}</table>`;
}

/** 강조 행 만들기 도우미. */
export function 강조행(cells) {
  return { __cells: cells, __cls: "hi" };
}
