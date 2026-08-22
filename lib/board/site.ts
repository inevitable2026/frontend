// 보드가 그리는 현장 하나의 식별자다.
//
// public.sites 의 행 하나를 가리키는 uuid 이고, gen_random_uuid() 에 맡기지 않고 사람이
// 고른 고정 리터럴을 쓴다. 이유는 이 값이 세 곳에서 같아야 하기 때문이다 —
// scripts/seed-board.mjs 의 INSERT, 적재하는 사실과 카드의 site_id, 그리고 화면 상수.
// DB 가 발급한 값을 쓰면 그 세 곳이 배포마다 갈라지고, 시드를 다시 넣을 때마다 화면
// 상수를 손으로 고쳐야 한다. 리터럴로 못 박아 두면 DB 를 다시 만들어도 같은 값을 다시
// 넣기만 하면 된다.
//
// 시드 JSON(data/board/seed-*.json)은 여전히 'site_gimpo_gochon_01' 이라는 사람이 읽는
// 이름을 쓴다. 그 파일은 docs/scenario-gimpo-logistics.md 와 짝을 이루는 시나리오 기록이라
// 배포 상태에 묶이면 안 되고, 100곳 가까운 자리를 uuid 로 바꾸면 diff 도 grep 도 읽히지
// 않는다. 치환은 적재 스크립트가 읽는 도중에 한다.
export const BOARD_SITE_ID = "0198a1d4-6c3f-4b2a-9e51-3f8c6b0d21ae";

/** public.sites.code. 재적재의 멱등 판정 기준이다. */
export const BOARD_SITE_CODE = "gimpo-gochon";

/** public.sites.name. */
export const BOARD_SITE_NAME = "김포 고촌 물류센터";

// 시드 JSON 안에 적힌 옛 문자열 식별자다. 적재 스크립트가 이 값을 BOARD_SITE_ID 로
// 바꿔 넣는다. board.*.site_id 는 uuid 라 이 문자열을 그대로 바인딩하면 22P02 로 죽는데,
// 빈 보드가 아니라 오류로 드러나는 편이 낫기 때문에 굳이 완충하지 않는다.
export const BOARD_SITE_SEED_ID = "site_gimpo_gochon_01";
