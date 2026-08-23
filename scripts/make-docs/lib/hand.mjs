// 손글씨 조각. OCR 난도를 올리려고 「사람이 종이에 볼펜으로 적은 것」을 흉내낸다.
//
// 폰트는 macOS 에 기본으로 깔린 한글 필기체 두 벌만 쓴다. 새 폰트를 설치하지 않는다.
//   PilGi   — 볼펜 필기체. 메모 · 체크 · 정정에 쓴다.
//   GungSeo — 궁서체. 서명처럼 붓 느낌이 필요한 자리에 쓴다.
//
// 실측 근거 (Google Chrome, macOS):
//   - `font-family: 'PilGi'` 로 CSS 패밀리명이 그대로 잡힌다. 파일명(Pilgiche.ttf)이 아니다.
//   - PilGi 는 같은 pt 에서 본문 고딕보다 작게 보인다. 그래서 기본 크기를 11pt 로 올려 둔다.
//   - `transform: rotate()` 는 인라인 요소에 먹지 않는다. `display:inline-block` 이 함께 있어야 한다.
//
// 규칙: 손글씨는 표 위에 겹쳐 놓지 않는다. 표 칸 안이나 여백에 둔다. 읽을 수는 있어야 한다.

import { esc } from "./render.mjs";

/** 문자열마다 항상 같은 값을 주는 아주 작은 해시. 각도·들여쓰기를 항목마다 다르게 만든다. */
function 흔들림(seed) {
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100_000;
  return h;
}

/** -기울기 ~ +기울기 사이의 각도. 같은 글자는 언제나 같은 각도로 기운다. */
function 각도(seed, 폭 = 1.6) {
  const h = 흔들림(seed);
  return (((h % 200) / 100) * 폭 - 폭).toFixed(2);
}

/** 손글씨 문단에 쓰는 스타일. 각 문서의 본문 맨 앞에 한 번 넣는다. */
export const 손글씨CSS = `<style>
.hand {
  font-family: "Bradley Hand", "PilGi", "GungSeo", cursive;
  color: #1a3a8f;            /* 파란 볼펜 */
  font-size: 11pt; line-height: 1.25; letter-spacing: -0.01em;
  display: inline-block;
}
.hand.ink-black { color: #222; }   /* 검정 볼펜 */
.hand.ink-red   { color: #b32020; } /* 빨간 펜 — 정정 · 강조 */
.hand.sm { font-size: 9.6pt; }
.hand.lg { font-size: 13pt; }
.hand.brush { font-family: "GungSeo", "PilGi", cursive; }

/* 표 칸 안의 여백 메모. 앞의 인쇄 글자와 줄을 바꿔 아래에 적는다. */
.hand-memo { display: block; margin-top: 0.8mm; }

/* 정정: 원래 값에 두 줄을 긋고 그 옆에 고쳐 쓴다.
   text-decoration 의 double 은 8pt 근처에서 두 줄이 붙어 한 줄로 보인다. 그래서
   배경 그라디언트로 직접 두 줄을 긋는다 — 실측으로 이쪽이 두 줄로 남는다. */
.fix-old {
  color: #666; padding: 0 0.3mm;
  background-image: linear-gradient(#b32020, #b32020), linear-gradient(#b32020, #b32020);
  background-size: 100% 0.5px, 100% 0.5px;
  background-position: 0 45%, 0 62%;
  background-repeat: no-repeat;
}

/* 손으로 그은 체크 · 사선. 인쇄 체크(✔)와 구분되게 조금 크고 기울어 있다. */
.hand-chk { font-family: "Bradley Hand", "PilGi", "GungSeo", cursive; font-size: 12pt; font-weight: 700; display: inline-block; }

/* 손글씨 서명이 들어가는 서명표. 인쇄된 이름과 겹치지 않게 칸을 키운다. */
.sign-table.hand-sign .sign-cell { height: 17mm; }
.sign-table.hand-sign .sign-cell .who { color: #666; font-size: 7.4pt; }
.sign-cell .hand-sig {
  position: absolute; left: 3.5mm; bottom: 2.8mm;
  font-family: "Bradley Hand", "GungSeo", "PilGi", cursive;
  font-size: 12pt; line-height: 1; color: #1a3a8f; white-space: nowrap;
  display: inline-block;
}

/* 문서 여백에 비스듬히 적어 넣은 쪽지. */
.margin-note {
  font-family: "Bradley Hand", "PilGi", "GungSeo", cursive;
  color: #1a3a8f; font-size: 11pt; line-height: 1.35;
  display: block; margin: 2mm 0 2mm 4mm; max-width: 150mm;
}
</style>`;

/**
 * 손글씨 한 조각.
 * @param {string} 글 적을 말
 * @param {{잉크?: "파랑"|"검정"|"빨강", 크기?: "sm"|"lg"|"", 붓?: boolean, 폭?: number}} [o]
 */
export function 손(글, o = {}) {
  const { 잉크 = "파랑", 크기 = "", 붓 = false, 폭 = 1.6 } = o;
  const cls = [
    "hand",
    잉크 === "검정" ? "ink-black" : 잉크 === "빨강" ? "ink-red" : "",
    크기,
    붓 ? "brush" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<span class="${cls}" style="transform:rotate(${각도(글, 폭)}deg)">${esc(글)}</span>`;
}

/** 표 칸 안에서 인쇄 글자 아래에 줄을 바꿔 적는 메모. */
export function 손메모(글, o = {}) {
  const inner = 손(글, { 크기: "sm", ...o });
  return `<span class="hand-memo">${inner}</span>`;
}

/** 여백에 비스듬히 적은 쪽지. */
export function 여백메모(줄들, o = {}) {
  const { 잉크 = "파랑" } = o;
  const color = 잉크 === "검정" ? "#222" : 잉크 === "빨강" ? "#b32020" : "#1a3a8f";
  const 본문 = (Array.isArray(줄들) ? 줄들 : [줄들])
    .map((줄) => esc(줄))
    .join("<br>");
  const seed = Array.isArray(줄들) ? 줄들.join("") : String(줄들);
  return `<span class="margin-note" style="color:${color};transform:rotate(${각도(seed, 1.1)}deg)">${본문}</span>`;
}

/** 손으로 그은 체크. `표시` 를 바꾸면 ✓ 대신 ✗ 나 △ 도 그릴 수 있다. */
export function 손체크(표시 = "✓", o = {}) {
  const { 잉크 = "파랑" } = o;
  const color = 잉크 === "검정" ? "#222" : 잉크 === "빨강" ? "#b32020" : "#1a3a8f";
  return `<span class="hand-chk" style="color:${color};transform:rotate(${각도(표시 + 잉크, 9)}deg)">${esc(표시)}</span>`;
}

/**
 * 정정. 인쇄된 원래 값에 두 줄을 긋고 그 옆에 손으로 고쳐 쓴다.
 * @param {string} 원값 인쇄되어 있던 값
 * @param {string} 고친값 손으로 다시 적은 값
 */
export function 정정(원값, 고친값, o = {}) {
  const { 잉크 = "빨강" } = o;
  return `<span class="fix-old">${esc(원값)}</span> ${손(고친값, { 잉크, ...o })}`;
}

/**
 * 서명란. `lib/render.mjs` 의 `서명란()` 과 같은 뼈대에 손으로 쓴 이름을 얹는다.
 * 인쇄된 이름은 칸 왼쪽 위에 작게 남고, 서명 줄 위에 손글씨 이름이 놓인다.
 *
 * @param {Array<{소속?:string, 직위?:string, 성명:string, 서명?:string, 미서명?:boolean}>} people
 *        `서명` 을 주면 그 글자를 손으로 쓴다(예: 이름 대신 「대리 서명」). `미서명` 이면 빈 칸으로 둔다.
 */
export function 손서명란(people, cols = 4, 표제 = "확인 · 서명") {
  const rows = [];
  for (let i = 0; i < people.length; i += cols) rows.push(people.slice(i, i + cols));
  const body = rows
    .map((row) => {
      const head = row
        .map((p) => `<th>${esc(p.소속 ?? "")}${p.직위 ? ` ${esc(p.직위)}` : ""}</th>`)
        .join("");
      const pad = cols - row.length;
      const cells = row
        .map((p) => {
          const 손글씨 = p.미서명
            ? ""
            : `<span class="hand-sig" style="transform:rotate(${각도(p.성명, 2.2)}deg)">${esc(p.서명 ?? p.성명)}</span>`;
          return `<td class="sign-cell"><span class="who">${esc(p.성명)}</span><span class="rule"></span>${손글씨}</td>`;
        })
        .join("");
      return (
        `<tr>${head}${"<th></th>".repeat(pad)}</tr>` +
        `<tr>${cells}${'<td class="sign-cell"></td>'.repeat(pad)}</tr>`
      );
    })
    .join("\n");
  return `<h3>${esc(표제)}</h3><table class="sign-table hand-sign">${body}</table>`;
}
