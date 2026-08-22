import postgres from "postgres";

declare global {
  var __contextSql: ReturnType<typeof postgres> | undefined;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 이 없습니다. 로컬은 .env.local, 배포는 Vercel 환경변수에 Railway Postgres 주소를 넣으세요.",
    );
  }
  return url;
}

// 준비된 구문(prepared statement)을 쓴다.
//
// 끄면 매개변수가 붙은 질의마다 Parse 와 Bind 가 따로 나가서 왕복이 두 번이 된다. 이
// 데이터베이스는 도쿄에 있어 왕복 한 번이 274ms 이므로, 11행짜리 카드 목록을 읽는 데
// 715ms 가 걸렸다. 켜면 두 번째 호출부터 Parse 를 건너뛰어 같은 질의가 340ms 로 줄어든다.
// 조건을 끼워 넣는 listItems 처럼 SQL 모양이 여러 벌인 질의도 모양마다 따로 캐시되므로
// 그대로 돈다.
//
// 끄는 것이 맞는 경우는 PgBouncer 를 transaction 모드로 앞에 두었을 때다. 그때는 구문을
// 준비한 연결과 실행하는 연결이 달라져 26000 으로 죽는다. 지금 붙는 곳은 Railway 의 TCP
// 프록시(tokaido.proxy.rlwy.net)라 연결이 그대로 이어지므로 해당하지 않는다. 나중에
// 풀러를 끼우게 되면 이 값을 false 로 되돌려야 한다.
const PREPARE = true;

// 커넥션 수. 1 로 두면 같은 순간에 도착한 질의가 한 줄로 서고, 왕복이 300ms 가까운
// 데이터베이스에서 그 대기가 그대로 더해진다. Promise.all 로 함께 보낸 질의가 실제로 함께
// 처리되려면 그 수만큼은 있어야 한다.
//
// 8 로 잡은 근거는 Fluid Compute 가 인스턴스를 재사용해 이 풀이 요청마다 새로 생기지 않고,
// 첫 화면이 동시에 여는 질의가 넷이며, 그 위에 사용자 조작 몇 개가 겹쳐도 남는 자리가
// 있어야 하기 때문이다. 더 키우면 인스턴스가 여럿일 때 Postgres 의 max_connections 를
// 먼저 갉아먹는다.
const POOL_SIZE = 8;

// 쉬는 커넥션을 놓기까지의 시간.
//
// 처음에는 300초였다. 근거는 "연결 하나를 새로 세우는 데 TLS 악수까지 1.8초가 걸리니 잠깐
// 쉬었다고 끊으면 다음 요청이 그 값을 문다" 였고, 그 자체는 맞다. 그런데 **Railway 의 TCP
// 프록시가 우리보다 먼저 끊는다.** 그러면 풀은 살아 있다고 믿는 소켓에 질의를 써 넣고,
// 그 결과가 이렇다:
//
//   POST /api/context/ingest   500  in 3.5min
//     ⨯ write CONNECTION_CLOSED tokaido.proxy.rlwy.net:19001
//   GET /api/context/sites     500  in 70s   (read ECONNRESET)
//
// 사용자에게는 "업로드 요청에 실패했습니다" 로 보였다. 라이브 게이트는 통과한 뒤였고,
// 죽은 것은 DB 소켓이었다.
//
// 그래서 **프록시보다 우리가 먼저 놓는다.** 대가는 1분 넘게 쉰 뒤 첫 질의에 붙는 2초이고,
// 얻는 것은 그 자리에서 나던 500 이 사라지는 것이다. 2초 기다리는 것과 실패하는 것 중에
// 고르는 문제라면 기다리는 쪽이다.
const IDLE_TIMEOUT_SECONDS = 60;

// 커넥션 하나를 얼마나 오래 쓸 것인가.
//
// 쉬지 않고 계속 쓰이는 커넥션은 `idle_timeout` 이 손대지 않는다. 그런 것도 프록시 쪽에서
// 언젠가 끊기므로, 우리가 먼저 돌려 쓴다. postgres.js 가 이 값에 흔들림을 섞어 여러 커넥션이
// 동시에 끊기지 않게 한다.
const MAX_LIFETIME_SECONDS = 10 * 60;

// 질의 하나가 붙들 수 있는 시간.
//
// 위 3.5분짜리 500 은 죽은 소켓 위에서 질의가 **아무 제한 없이 매달려 있다가** 소켓이
// 완전히 닫힐 때에야 끝난 것이다. 화면은 그동안 "분석 중…" 을 띄우고 있었다. 30초면
// 원본 바이트를 넣는 트랜잭션에도 넉넉하고(도쿄 왕복 2초), 죽은 연결은 그 전에 드러난다.
const STATEMENT_TIMEOUT_MS = 30_000;

export function db() {
  if (!globalThis.__contextSql) {
    globalThis.__contextSql = postgres(connectionString(), {
      max: POOL_SIZE,
      idle_timeout: IDLE_TIMEOUT_SECONDS,
      max_lifetime: MAX_LIFETIME_SECONDS,
      connect_timeout: 15,
      prepare: PREPARE,
      connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
      // 질의가 없는 사이에 소켓이 끊기면 postgres.js 가 처리되지 않은 거절을 낸다.
      // 잡아 주지 않으면 Node 가 그것을 unhandledRejection 으로 올리고, 배포 환경에서는
      // 그 한 번이 인스턴스를 내린다. 풀은 다음 질의에서 새 커넥션을 세우므로 여기서는
      // 삼키는 것이 맞다 — 진짜 실패는 질의를 부른 쪽이 받는다.
      onclose: () => {},
    });
  }
  return globalThis.__contextSql;
}

export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
