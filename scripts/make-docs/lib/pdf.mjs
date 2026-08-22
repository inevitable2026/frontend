// HTML → PDF 변환. 시스템에 이미 깔린 Chrome 을 headless 로 부른다.
// 새 패키지를 설치하지 않는다 — child_process 와 fs 만 쓴다.
//
// 실측 근거 (Google Chrome 151.0.7922.172, macOS):
//   - 입력은 반드시 `file://` + 절대경로. 상대경로는 조용히 빈 페이지가 나온다.
//   - `--print-to-pdf` 값도 절대경로.
//   - stderr 에 "Trying to load the allocator multiple times." 가 찍히지만 무해하다.
//     성공 판정을 stderr 로 하면 안 된다. exit code 와 산출 파일의 %PDF 매직으로 본다.

import { spawnSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import path from "node:path";

const 후보 = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

/** 쓸 수 있는 크롬 실행 파일 경로. 없으면 null. */
export function 크롬찾기() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  for (const p of 후보) if (existsSync(p)) return p;
  return null;
}

/** 파일 앞 5바이트가 %PDF- 인지 본다. */
export function pdf인가(파일) {
  if (!existsSync(파일)) return false;
  if (statSync(파일).size < 1024) return false;
  const fd = openSync(파일, "r");
  try {
    const buf = Buffer.alloc(5);
    readSync(fd, buf, 0, 5, 0);
    return buf.toString("latin1") === "%PDF-";
  } finally {
    closeSync(fd);
  }
}

/**
 * HTML 한 장을 PDF 한 장으로 뽑는다. 두 경로 모두 절대경로여야 한다.
 * @returns {{ ok: boolean, bytes: number, 사유?: string }}
 */
export function htmlToPdf(크롬, html절대경로, pdf절대경로, { 머리꼬리 = false } = {}) {
  if (!path.isAbsolute(html절대경로) || !path.isAbsolute(pdf절대경로)) {
    return { ok: false, bytes: 0, 사유: "절대경로가 아니다" };
  }
  const args = [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--print-to-pdf=${pdf절대경로}`,
  ];
  if (!머리꼬리) args.splice(3, 0, "--no-pdf-header-footer");
  args.push(`file://${html절대경로}`);

  const r = spawnSync(크롬, args, { encoding: "utf8", timeout: 120_000 });
  if (r.error) return { ok: false, bytes: 0, 사유: String(r.error.message) };
  if (r.status !== 0) {
    return { ok: false, bytes: 0, 사유: `exit ${r.status}: ${(r.stderr ?? "").trim().slice(0, 300)}` };
  }
  if (!pdf인가(pdf절대경로)) {
    return { ok: false, bytes: 0, 사유: "산출 파일이 %PDF 로 시작하지 않는다" };
  }
  return { ok: true, bytes: statSync(pdf절대경로).size };
}
