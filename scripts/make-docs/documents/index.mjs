// 문서 목록. 우선순위 순으로 늘어놓는다 — 시간이 모자라면 앞에서부터 만든다.

import ra202607 from "./ra-2026-07-regular.mjs";
import ra202608 from "./ra-2026-08-minutes.mjs";
import letter from "./seojin-material-letter.mjs";
import spec from "./seojin-shoring-spec.mjs";
import correction from "./supervisor-correction.mjs";
import tbm from "./tbm-minutes.mjs";
import attendance from "./attendance.mjs";
import schedule from "./schedule-weekly.mjs";
import weather from "./weather-log.mjs";
import nearMiss from "./near-miss.mjs";
import notice from "./labor-notice.mjs";
import ledger from "./approval-ledger.mjs";

/** @type {Array<{id:string, 파일명:string, kind:string, 제목:string, 먹이는조건:string[], html:()=>string}>} */
export const 문서목록 = [
  ra202607,
  ra202608,
  letter,
  spec,
  correction,
  ...tbm,
  ...attendance,
  schedule,
  weather,
  nearMiss,
  notice,
  ledger,
];

export default 문서목록;
