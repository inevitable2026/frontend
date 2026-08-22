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

// 커넥션 수. 1 로 두면 같은 순간에 도착한 질의가 한 줄로 서는데, Railway Postgres 는
// 왕복 한 번이 300ms 가까이 걸려서 첫 화면 하나에 필요한 질의 열댓 개가 그대로 더해진다.
// Promise.all 로 함께 보낸 요청이 실제로 함께 처리되려면 그 수만큼은 있어야 한다.
//
// 8 로 잡은 근거는 Fluid Compute 가 인스턴스를 재사용해 이 풀이 요청마다 새로 생기지 않고,
// 첫 화면이 동시에 여는 질의가 넷이며, 그 위에 사용자 조작 몇 개가 겹쳐도 남는 자리가
// 있어야 하기 때문이다. 더 키우면 인스턴스가 여럿일 때 Postgres 의 max_connections 를
// 먼저 갉아먹는다.
const POOL_SIZE = 8;

// 30초 쉬면 커넥션을 놓는다. 서버리스 인스턴스가 오래 살아 있을 때 쓰지 않는 커넥션을
// 붙들고 있으면 다른 인스턴스가 자리를 잡지 못한다.
const IDLE_TIMEOUT_SECONDS = 30;

export function db() {
  if (!globalThis.__contextSql) {
    globalThis.__contextSql = postgres(connectionString(), {
      max: POOL_SIZE,
      idle_timeout: IDLE_TIMEOUT_SECONDS,
      prepare: false,
    });
  }
  return globalThis.__contextSql;
}

export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
