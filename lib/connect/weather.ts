// 기상 커넥터 — 셋 가운데 유일하게 실연동이 현실적인 자리.
//
// WEATHER_API_KEY 가 있으면 기상청 단기예보 조회 서비스를 부르고, 없거나 호출이
// 실패하면 시나리오 시드로 조용히 내려간다. 키가 없다고 던지지 않는다 — 데모가
// 키 하나에 묶이면 안 된다. 어느 경로를 탔는지는 사실의 sourceDocId 와
// value.구분 에 드러난다.
//
// 타임아웃 · 응답 크기 제한 · HTML 응답 가드는 lib/agent/official-law.ts 의
// lawFetch 와 같은 모양이다. data.go.kr 은 키가 틀리면 dataType=JSON 을 줘도
// XML 오류 문서를 돌려주므로 그 경우를 따로 막는다.

import type { SnapshotFact } from "@/lib/board/types";
import { type Connector, kstCompact, kstStamp, makeFact } from "./types";
import { SLOPE_INSPECTION_MM } from "@/lib/detect/rainfall";

const KMA_VILAGE_FCST_URL =
  "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";

const WEATHER_REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const FORECAST_HORIZON_HOURS = 24;
const OBSERVATION_WINDOW_HOURS = 48;

// 시나리오는 "주말 누적 41mm" 만 주고 임계치를 말하지 않는다. 24시간 누적 30mm
// 를 기본으로 두되 환경변수로 덮을 수 있게 한다. (보고서에 결정으로 남겼다)
// lib/detect/rainfall.ts 의 사면·법면 점검 단계 값이다. 규칙과 커넥터가 같은 숫자를 보도록
// 한 곳에서만 정의한다. 공식 근거가 없는 현장 설정값이라 발주처 기준이 있으면 환경변수로 덮는다.
const DEFAULT_RAIN_THRESHOLD_MM = SLOPE_INSPECTION_MM;

// 기상청 격자 기준 김포 근사값. 정확한 좌표가 확정되면 환경변수로 덮는다.
const DEFAULT_GRID = { nx: 55, ny: 128 };

// 단기예보 발표 시각(KST). 발표 후 10분쯤 지나야 조회된다.
const BASE_TIMES = ["2300", "2000", "1700", "1400", "1100", "0800", "0500", "0200"];
const PUBLISH_DELAY_MIN = 10;

const SEED_SOURCE_DOC_ID = "seed_scenario_weather_20260817";

// 시나리오가 준 강우는 이 한 칸뿐이다. 일자별로 쪼갠 값은 어디에도 없으므로
// 쪼개지 않고 주말 전체를 한 칸으로 둔다. (감지 규칙 사양 T-01)
const SEED_RAIN_WINDOWS: Array<{
  시작: string;
  종료: string;
  밀리미터: number;
  출처: string;
}> = [
  {
    시작: "2026-08-15T00:00:00+09:00",
    종료: "2026-08-17T00:00:00+09:00",
    밀리미터: 41,
    출처: "감지 규칙 사양 T-01 — 주말 누적 41mm",
  },
];

export type RainfallFactValue = {
  구분: "관측" | "예보";
  밀리미터: number;
  기간시작: string;
  기간종료: string;
  임계치밀리미터: number;
  임계치초과: boolean;
  격자: { nx: number; ny: number };
  비고: string;
  실패사유?: string;
};

export type PrecipitationChanceValue = {
  최대확률: number;
  기간시작: string;
  기간종료: string;
  격자: { nx: number; ny: number };
};

function rainThresholdMm(): number {
  const raw = Number(process.env.WEATHER_RAIN_THRESHOLD_MM);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RAIN_THRESHOLD_MM;
}

function grid(): { nx: number; ny: number } {
  const nx = Number(process.env.WEATHER_GRID_NX);
  const ny = Number(process.env.WEATHER_GRID_NY);
  return {
    nx: Number.isInteger(nx) ? nx : DEFAULT_GRID.nx,
    ny: Number.isInteger(ny) ? ny : DEFAULT_GRID.ny,
  };
}

function weatherApiKey(): string | null {
  const key = process.env.WEATHER_API_KEY?.trim();
  return key ? key : null;
}

export function isWeatherApiConfigured(): boolean {
  return weatherApiKey() !== null;
}

// ── 시드 경로 ──────────────────────────────────────────────────────────────

function seedRainfall(at: Date, 실패사유?: string): RainfallFactValue {
  const 종료 = at.getTime();
  const 시작 = 종료 - OBSERVATION_WINDOW_HOURS * 60 * 60 * 1000;
  const 임계치 = rainThresholdMm();

  // 관측 창에 겹치는 칸만 더한다. 시나리오가 총량만 주므로 겹친 만큼 비례
  // 배분하지 않고 통째로 센다. 그래서 8월 17일에는 41mm 가 잡히고 8월 19일에는
  // 주말 강우가 창 밖으로 빠져 0mm 가 된다.
  const 겹친칸 = SEED_RAIN_WINDOWS.filter((칸) => {
    const s = Date.parse(칸.시작);
    const e = Date.parse(칸.종료);
    return e > 시작 && s < 종료;
  });
  const 밀리미터 = 겹친칸.reduce((sum, 칸) => sum + 칸.밀리미터, 0);

  const 비고 = 겹친칸.length
    ? `시나리오 고정값입니다. ${겹친칸.map((칸) => 칸.출처).join(" · ")}`
    : "시나리오 고정값입니다. 관측 창 안에 기록된 강우가 없어 0mm 로 둡니다.";

  return {
    구분: "관측",
    밀리미터,
    기간시작: kstStamp(new Date(시작)),
    기간종료: kstStamp(new Date(종료)),
    임계치밀리미터: 임계치,
    임계치초과: 밀리미터 >= 임계치,
    격자: grid(),
    비고,
    ...(실패사유 ? { 실패사유 } : {}),
  };
}

// ── 실연동 경로 ────────────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error("WEATHER_RESPONSE_TOO_LARGE");
  if (!response.body) throw new Error("WEATHER_RESPONSE_EMPTY");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("WEATHER_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** at 시점에 조회 가능한 가장 최근 발표분. 02:10 이전이면 전날 23시 발표로 내려간다. */
export function latestBaseSlot(at: Date): { base_date: string; base_time: string } {
  const now = kstCompact(at);
  const 분 = Number(now.시각.slice(0, 2)) * 60 + Number(now.시각.slice(2, 4));
  for (const time of BASE_TIMES) {
    const 발표분 = Number(time.slice(0, 2)) * 60 + PUBLISH_DELAY_MIN;
    if (분 >= 발표분) return { base_date: now.날짜, base_time: time };
  }
  const 전날 = kstCompact(new Date(at.getTime() - 24 * 60 * 60 * 1000));
  return { base_date: 전날.날짜, base_time: "2300" };
}

/**
 * 단기예보 PCP 값을 밀리미터로 읽는다.
 * "강수없음" · "1mm 미만" · "1.0mm" · "30.0~50.0mm" 가 실제로 오는 형태다.
 * 구간값은 과잉 발화를 막으려고 아래쪽 경계를 쓴다.
 */
export function parsePcp(raw: unknown): number {
  const text = asText(raw);
  if (!text || text === "강수없음" || text === "-" || text === "0") return 0;
  if (text.includes("미만")) {
    const 상한 = text.match(/([\d.]+)/);
    return 상한 ? Number(상한[1]) / 2 : 0.5;
  }
  const 구간 = text.match(/([\d.]+)\s*~\s*([\d.]+)/);
  if (구간) return Number(구간[1]);
  const 단일 = text.match(/([\d.]+)/);
  return 단일 ? Number(단일[1]) : 0;
}

function fcstMillis(item: JsonRecord): number {
  const date = asText(item.fcstDate);
  const time = asText(item.fcstTime).padStart(4, "0");
  if (date.length !== 8) return Number.NaN;
  return Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:00+09:00`,
  );
}

async function fetchVilageFcst(at: Date): Promise<JsonRecord[]> {
  const key = weatherApiKey();
  if (!key) throw new Error("WEATHER_API_KEY_MISSING");

  const { nx, ny } = grid();
  const slot = latestBaseSlot(at);
  const url = new URL(KMA_VILAGE_FCST_URL);
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "1000");
  url.searchParams.set("dataType", "JSON");
  url.searchParams.set("base_date", slot.base_date);
  url.searchParams.set("base_time", slot.base_time);
  url.searchParams.set("nx", String(nx));
  url.searchParams.set("ny", String(ny));

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEATHER_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        if (response.status >= 500 && attempt === 0) continue;
        throw new Error("WEATHER_UPSTREAM_STATUS");
      }
      const text = await readBoundedBody(response);
      // 키가 틀리면 JSON 을 요청해도 XML 오류 문서가 온다.
      if (/^\s*</.test(text)) throw new Error("WEATHER_UPSTREAM_XML");

      const data: unknown = JSON.parse(text);
      const root = isRecord(data) && isRecord(data.response) ? data.response : null;
      if (!root) throw new Error("WEATHER_UPSTREAM_SHAPE");
      const header = isRecord(root.header) ? root.header : null;
      if (header && asText(header.resultCode) !== "00") {
        throw new Error(`WEATHER_UPSTREAM_RESULT_${asText(header.resultCode) || "UNKNOWN"}`);
      }
      const body = isRecord(root.body) ? root.body : null;
      const items = body && isRecord(body.items) ? body.items : null;
      const list = items && Array.isArray(items.item) ? items.item : [];
      return list.filter(isRecord);
    } catch (error) {
      lastError = error;
      if (
        attempt === 0 &&
        !(error instanceof Error && /XML|SHAPE|TOO_LARGE|MISSING|RESULT_/.test(error.message))
      ) {
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("WEATHER_UPSTREAM_FAILED");
}

function liveRainfall(items: JsonRecord[], at: Date): {
  강우: RainfallFactValue;
  강수확률: PrecipitationChanceValue | null;
} {
  const 시작 = at.getTime();
  const 종료 = 시작 + FORECAST_HORIZON_HOURS * 60 * 60 * 1000;
  const 임계치 = rainThresholdMm();

  let 밀리미터 = 0;
  let 최대확률 = 0;
  let 강수확률있음 = false;

  for (const item of items) {
    const when = fcstMillis(item);
    if (!Number.isFinite(when) || when < 시작 || when > 종료) continue;
    const category = asText(item.category);
    if (category === "PCP") 밀리미터 += parsePcp(item.fcstValue);
    if (category === "POP") {
      const 확률 = Number(asText(item.fcstValue));
      if (Number.isFinite(확률)) {
        강수확률있음 = true;
        최대확률 = Math.max(최대확률, 확률);
      }
    }
  }

  밀리미터 = Math.round(밀리미터 * 10) / 10;

  return {
    강우: {
      구분: "예보",
      밀리미터,
      기간시작: kstStamp(new Date(시작)),
      기간종료: kstStamp(new Date(종료)),
      임계치밀리미터: 임계치,
      임계치초과: 밀리미터 >= 임계치,
      격자: grid(),
      비고: `기상청 단기예보 ${FORECAST_HORIZON_HOURS}시간 합계입니다. 구간값은 아래쪽 경계로 셌습니다.`,
    },
    강수확률: 강수확률있음
      ? {
          최대확률,
          기간시작: kstStamp(new Date(시작)),
          기간종료: kstStamp(new Date(종료)),
          격자: grid(),
        }
      : null,
  };
}

// ── 커넥터 ────────────────────────────────────────────────────────────────

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchWeatherFacts(siteId: string, at: Date): Promise<SnapshotFact[]> {
  const observedAt = kstStamp(at);

  if (!isWeatherApiConfigured()) {
    return [
      makeFact({
        siteId,
        factType: "weatherObservation",
        key: "누적강우",
        value: seedRainfall(at),
        observedAt,
        sourceDocId: SEED_SOURCE_DOC_ID,
        confidence: 0.9,
      }),
    ];
  }

  try {
    const items = await fetchVilageFcst(at);
    const slot = latestBaseSlot(at);
    const sourceDocId = `kma_vilagefcst_${slot.base_date}_${slot.base_time}`;
    const { 강우, 강수확률 } = liveRainfall(items, at);

    const facts = [
      makeFact({
        siteId,
        factType: "weatherObservation",
        key: "누적강우",
        value: 강우,
        observedAt,
        sourceDocId,
        // 예보라 관측보다 낮게 잡는다.
        confidence: 0.8,
      }),
    ];
    if (강수확률) {
      facts.push(
        makeFact({
          siteId,
          factType: "weatherObservation",
          key: "강수확률",
          value: 강수확률,
          observedAt,
          sourceDocId,
          confidence: 0.8,
        }),
      );
    }
    return facts;
  } catch (error) {
    // 실연동이 넘어져도 감지는 돌아야 한다. 시드로 내려가되 넘어졌다는 사실을
    // 값 안에 남긴다 — sourceDocId 만 보면 시드 경로였는지 알 수 있다.
    return [
      makeFact({
        siteId,
        factType: "weatherObservation",
        key: "누적강우",
        value: seedRainfall(at, describe(error)),
        observedAt,
        sourceDocId: SEED_SOURCE_DOC_ID,
        confidence: 0.7,
      }),
    ];
  }
}

export const weatherConnector: Connector = {
  id: "weather",
  label: "기상 관측",
  factTypes: ["weatherObservation"],
  fetch: fetchWeatherFacts,
};
