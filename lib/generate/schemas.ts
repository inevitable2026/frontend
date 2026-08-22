import { z } from "zod";

import { DRAFT_FORMS, WORK_ITEM_STATUS_ORDER } from "@/lib/board/types";

// 모델이 낼 수 있는 모양을 여기서 못 박는다.
//
// 스키마가 곧 계약이다. 여기서 느슨하게 두면 카드에 빈 제목이 앉거나 기한 자리에 "미정"
// 같은 말이 들어오고, 그 값이 그대로 Postgres 의 체크 제약에 걸려 감지 전체가 죽는다.
// 그래서 DB 가 거절할 값은 여기서 먼저 거절한다.
//
// `.optional()` 대신 `.nullable()` 을 쓴다. 구조화 출력을 지원하는 쪽은 대개 모든 키가
// 있어야 하는 스키마를 요구하고, 없어도 되는 키를 두면 모델이 통째로 빼먹는 쪽을 고른다.
// 받은 뒤에 null 을 undefined 로 정리하는 편이 왕복이 예측 가능하다.

/* ------------------------------------------------------------------ *
 * 산출물
 * ------------------------------------------------------------------ */

export const draftFormSchema = z.enum(DRAFT_FORMS as [string, ...string[]]);

/** lib/board/types.ts 의 Produces 와 같은 모양. 선택 필드는 null 로 받는다. */
export const producesSchema = z.object({
  form: draftFormSchema.describe("이 산출물의 서식"),
  count: z.number().int().positive().nullable().describe("몇 건인지. 세지 않는 서식이면 null"),
  into: z.string().nullable().describe("편입될 문서의 식별자. 없으면 null"),
  to: z.string().nullable().describe("공문 수신처. 모르면 null 로 두고 사람이 채우게 한다"),
  for: z.string().nullable().describe("이 산출물이 겨냥하는 대상. 카드 제목으로도 쓰인다"),
  teams: z.array(z.string()).nullable().describe("팀 단위로 나가는 자료의 팀 이름들"),
});

/* ------------------------------------------------------------------ *
 * 카드 계획
 * ------------------------------------------------------------------ */

/**
 * 카드 key 는 itemId 의 재료다.
 *
 * `card_{규칙}_{key}_{서명}` 으로 이어 붙이므로 공백이나 한글이 들어오면 식별자가 깨진다.
 * 길이 상한을 두는 것도 같은 이유다 — itemId 가 work_items.item_id 의 기본키다.
 */
export const cardKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,23}$/, "영소문자로 시작하고 영소문자·숫자·밑줄만 쓴 2~24글자여야 합니다");

export const cardPlanSchema = z.object({
  key: cardKeySchema.describe("이 감지 안에서 이 카드를 가리키는 이름. 서식을 짐작할 수 있게 짓는다"),
  title: z.string().min(1).max(60).describe("담당자가 목록에서 보는 카드 제목"),
  status: z
    .enum(WORK_ITEM_STATUS_ORDER as [string, ...string[]])
    .describe(
      "todo 는 사람이 몸을 움직여야 하는 일, approval 은 초안을 검토해 승인할 일, done 은 판단이 필요 없어 이미 끝난 일",
    ),
  summary: z.string().nullable().describe("카드를 열었을 때 보이는 한두 문장. 필요 없으면 null"),
  produces: z.array(producesSchema).describe("이 카드가 만들어 낼 산출물. 없으면 빈 배열"),
  dueBy: z
    .string()
    .nullable()
    .describe(
      "기한. 시각까지 정해지면 '2026-08-24T06:40:00+09:00' 처럼 ISO 로, 시각이 정해지지 않으면 '2026-08-24 작업 착수 전' 처럼 날짜로 시작하는 문장으로. 기한을 정할 근거가 없으면 null",
    ),
  estimatedMinutes: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("예상 소요 분. 짐작할 근거가 없으면 null"),
  delegable: z.boolean().describe("다른 사람에게 넘길 수 있는 일인지"),
  blockedByKeys: z
    .array(cardKeySchema)
    .describe("이 카드보다 먼저 끝나야 하는 같은 감지 안의 다른 카드 key. 없으면 빈 배열"),
  draftForm: draftFormSchema
    .nullable()
    .describe("초안을 미리 써 둘 수 있으면 그 서식, 현장 확인이 먼저라 초안을 쓸 수 없으면 null"),
});

export const cardPlanListSchema = z.object({
  cards: z.array(cardPlanSchema).min(1).max(8),
});

export type CardPlan = z.infer<typeof cardPlanSchema>;

/* ------------------------------------------------------------------ *
 * 초안 여섯 서식
 *
 * 판별 유니온으로 묶지 않고 서식마다 따로 둔다. 카드 계획이 이미 서식을 정해 두었으므로
 * 부를 때 그 서식의 스키마 하나만 넘기면 되고, 유니온을 구조화 출력으로 요구했을 때
 * 모델이 form 필드를 흘리는 문제를 아예 만들지 않는다.
 * ------------------------------------------------------------------ */

const riskScoreSchema = z.object({
  likelihood: z.number().int().min(1).max(5).describe("가능성"),
  severity: z.number().int().min(1).max(5).describe("중대성"),
  score: z.number().int().min(1).max(25).describe("가능성 × 중대성"),
  level: z.string().describe("'낮음' · '보통' · '높음' 처럼 점수대를 부르는 말"),
});

const riskMeasureSchema = z.object({
  measureId: z.string().describe("이 대책을 가리키는 짧은 식별자"),
  text: z.string().describe("무엇을 어떻게 하는지 적은 대책 한 줄"),
  type: z.string().describe("공학적 · 관리적 · 보호구 가운데 하나"),
  owner: z.string().describe("대책을 실행할 주체"),
  dueDate: z.string().describe("'2026-08-24' 형식의 기한"),
  status: z.string().describe("'예정' 처럼 지금 상태를 부르는 말"),
});

export const 회의록DraftSchema = z.object({
  제목: z.string().min(1),
  supersedes: z.string().nullable().describe("이 회의록이 대체하는 기존 평가서의 식별자. 없으면 null"),
  rows: z
    .array(
      z.object({
        itemId: z.string().describe("행을 가리키는 짧은 식별자"),
        process: z.string().describe("공종"),
        hazard: z.string().describe("유해위험요인"),
        hazardClass: z.string().describe("위험 분류"),
        currentControl: z.string().describe("현재 안전조치"),
        risk: riskScoreSchema.describe("대책 전 위험도"),
        measures: z.array(riskMeasureSchema).min(1),
        residualRisk: riskScoreSchema.describe("대책 후 잔여 위험도"),
        legalReferences: z
          .array(
            z.object({
              ref: z.string().describe("법령명과 조문"),
              citable: z
                .boolean()
                .describe("공식 원문을 확인한 조문만 true. 확인하지 못했으면 반드시 false"),
              note: z.string(),
            }),
          )
          .describe("근거 조문. 원문을 확인하지 못했으면 빈 배열로 두고 지어내지 않는다"),
        derivedFrom: z.object({
          evidenceIds: z.array(z.string()).describe("이 행이 딛고 선 근거의 key"),
          contextDocRefs: z.array(z.string()).describe("근거 문서의 식별자"),
        }),
      }),
    )
    .min(1),
});

export const 공문DraftSchema = z.object({
  수신: z.string().min(1).describe("수신처. 근거에서 확인되지 않으면 '(수신처 확인 필요)' 로 둔다"),
  제목: z.string().min(1),
  본문: z.string().min(1).describe("공문 본문. 계약상 효력이 따라오므로 근거에 있는 사실만 적는다"),
  첨부: z.array(z.string()).describe("첨부 문서 이름. 없으면 빈 배열"),
});

export const 회의자료DraftSchema = z.object({
  제목: z.string().min(1),
  안건: z
    .array(
      z.object({
        번호: z.number().int().positive(),
        제목: z.string().min(1),
        문항: z.array(z.string()).min(1).describe("그 안건에서 물어야 할 것들"),
      }),
    )
    .min(1),
});

export const TBM자료DraftSchema = z.object({
  팀: z.string().min(1),
  항목: z.array(z.string()).min(1).describe("작업 전에 짚어야 할 것들"),
  통역필요인원: z.number().int().min(0).describe("근거에서 확인되지 않으면 0"),
});

export const 점검표DraftSchema = z.object({
  제목: z.string().min(1),
  항목: z
    .array(
      z.object({
        확인: z.string().min(1),
        done: z.literal(false).describe("초안은 아무것도 확인되지 않은 상태로 나간다"),
      }),
    )
    .min(1),
});

export const 기록DraftSchema = z.object({
  제목: z.string().min(1),
  본문: z.string().min(1),
});

/** 서식 이름으로 스키마를 고른다. 카드 계획의 draftForm 이 그대로 열쇠가 된다. */
export const DRAFT_SCHEMA_BY_FORM = {
  회의록: 회의록DraftSchema,
  공문: 공문DraftSchema,
  회의자료: 회의자료DraftSchema,
  TBM자료: TBM자료DraftSchema,
  점검표: 점검표DraftSchema,
  기록: 기록DraftSchema,
} as const;

/* ------------------------------------------------------------------ *
 * 서사
 * ------------------------------------------------------------------ */

/**
 * 감지 한 건에 대한 문장들. BriefingEntry 의 여섯 칸 가운데 다섯 개를 채운다.
 *
 * 무효화 칸은 여기 없다. 그 칸은 `docId — scope` 라는 좌표이지 문장이 아니고, 규칙이
 * 이미 정확히 짚어 두었으므로 다시 쓰게 하면 문서 이름이 흔들린다.
 */
export const detectionNarrativeSchema = z.object({
  headline: z.string().min(1).max(120).describe("이 조건이 무엇인지 한 줄로"),
  관측: z
    .array(z.string())
    .describe("밖에서 새로 들어온 사실. 각 줄 끝에 언제 어느 문서에서 왔는지 적는다"),
  대조: z.array(z.string()).describe("우리가 이미 들고 있던 상태. 관측과 무엇이 다른지 드러나게 적는다"),
  판단: z.array(z.string()).describe("그래서 무엇이 문제인지"),
  만든것: z.array(z.string()).describe("이 조건 때문에 올린 카드와 산출물을 사람 말로"),
  불확실성: z.array(z.string()).describe("확신하지 못하는 것과 사람이 확인해야 하는 것"),
});

export const briefingParagraphsSchema = z.object({
  paragraphs: z
    .array(z.string().min(1))
    .min(1)
    .max(6)
    .describe("브리핑 맨 위 문단들. 한 문단이 한 줄이고 화면에서 공백으로 이어진다"),
});
