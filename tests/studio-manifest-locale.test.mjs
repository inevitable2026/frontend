import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

// 매니페스트 지문은 **로케일에 의존하면 안 된다.**
//
// 이 그물이 있는 이유는 결함의 성질 때문이다. 예전 canonicalizer 는 키를 `localeCompare` 로
// 정렬했는데, 그 함수는 런타임 기본 Collator 로케일을 따른다. 이 매니페스트에는 `저감조치ID`
// 처럼 한글 뒤에 라틴 접미사가 붙은 키가 있어서, ICU 한국어 콜레이션과 코드유닛 정렬이 서로
// 다른 순서를 냈다. 결과로 같은 바이트가 en-US 에서는 통과하고 ko-KR 에서는 던졌다.
//
// 이 종류의 결함은 **en-US CI 에서 영원히 초록불**이다. 그래서 로케일을 바꿔 가며 확인하는
// 테스트가 없으면 재발해도 아무도 모른다. 여기서는 자식 프로세스의 LC_ALL/LANG 을 바꿔
// 실제로 다른 Collator 아래에서 모듈을 평가시킨다 — 같은 프로세스 안에서 Intl 기본 로케일만
// 바꾸는 방법이 없기 때문이다.
const LOCALES = ["ko_KR.UTF-8", "en_US.UTF-8", "C"];

const manifest = JSON.parse(
  readFileSync(new URL("../lib/context/studio-manifest.json", import.meta.url), "utf8"),
);

function shaUnder(locale) {
  return execFileSync(
    process.execPath,
    ["-e", 'import("./tmp/test-dist/lib/context/studio-manifest.js").then((m) => process.stdout.write(m.STUDIO_MANIFEST_SHA))'],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env, LC_ALL: locale, LANG: locale } },
  );
}

test("manifest fingerprint is identical under every locale", () => {
  const seen = LOCALES.map((locale) => [locale, shaUnder(locale)]);
  for (const [locale, sha] of seen) {
    // 값이 저장된 서명과 달라지면 검증자가 아니라 **서명 쪽을 고친 것**이다. 그 순간
    // 지문은 "누가 어느 로케일에서 찍었나" 의 기록이 되어 위조 감지 기능을 잃는다.
    assert.equal(sha, manifest.fingerprint, `${locale} 에서 지문이 저장값과 다르다`);
  }
});

test("module evaluation does not throw under a Korean collation", () => {
  // 모듈 최상위에서 validateStudioManifest() 가 돌기 때문에, 지문이 어긋나면 import 자체가
  // 던진다. 그 경우 라이브·데모 두 진입점이 함께 500 으로 죽으므로 여기서 따로 못 박아 둔다.
  assert.doesNotThrow(() => shaUnder("ko_KR.UTF-8"));
});
