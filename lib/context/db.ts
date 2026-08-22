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
// 짧게 잡으면 안 된다. 연결 하나를 새로 세우는 데 TLS 악수까지 1.8초가 걸려서, 잠깐 쉬었다고
// 끊어 버리면 다음 요청이 그 값을 고스란히 문다. 그렇다고 무한정 붙들면 인스턴스가 여럿일 때
// Postgres 의 max_connections 를 잠식하므로, 사람이 화면을 보고 있을 만한 시간은 살려 두고
// 그 뒤에 놓는 쪽으로 5분을 잡았다.
const IDLE_TIMEOUT_SECONDS = 300;

export function db() {
  if (!globalThis.__contextSql) {
    globalThis.__contextSql = postgres(connectionString(), {
      max: POOL_SIZE,
      idle_timeout: IDLE_TIMEOUT_SECONDS,
      prepare: PREPARE,
    });
  }
  return globalThis.__contextSql;
}

export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
