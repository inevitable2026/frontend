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

export function db() {
  if (!globalThis.__contextSql) {
    globalThis.__contextSql = postgres(connectionString(), { max: 1, prepare: false });
  }
  return globalThis.__contextSql;
}

export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
