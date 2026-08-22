"use client";

import type { JSX } from "react";

import type {
  BoardCalendar,
  CalendarDay,
  CalendarViewMode,
  MarkerTone,
} from "./types";

type WeekCalendarProps = {
  calendar: BoardCalendar;
  viewMode: CalendarViewMode;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
  onPrevRange: () => void;
  onNextRange: () => void;
  onViewModeChange: (mode: CalendarViewMode) => void;
};

/* ------------------------------------------------------------------ *
 * 날짜 셈 — Date 객체를 쓰지 않는다.
 *
 * 서버는 UTC 로 돌기 때문에 'YYYY-MM-DD' 를 Date 로 왕복시키면 하루가 밀린다
 * (docs/tbm-check-types.md 의 같은 경고). 그래서 월간 격자의 앞뒤 주를 셀 때도
 * 문자열을 정수로 풀어 민수(民數)로만 더하고 뺀다. 시간대가 끼어들 자리가 없다.
 * ------------------------------------------------------------------ */

/** 1970-01-01 을 0 으로 하는 일련번호. 그레고리력 순수 정수 셈이다. */
function toDayNumber(date: string): number {
  const parts = date.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;

  return era * 146097 + dayOfEra - 719468;
}

/** `toDayNumber` 의 역. 'YYYY-MM-DD' 로 되돌린다. */
function toDateString(dayNumber: number): string {
  const shifted = dayNumber + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra +
      Math.floor(yearOfEra / 4) -
      Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);

  return `${pad(month <= 2 ? year + 1 : year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function addDays(date: string, amount: number): string {
  return toDateString(toDayNumber(date) + amount);
}

function monthOf(date: string): number {
  return Number(date.split("-")[1]);
}

function dayOfMonth(date: string): number {
  return Number(date.split("-")[2]);
}

/* ------------------------------------------------------------------ *
 * 월간 격자 — 새 데이터를 받지 않는다.
 *
 * 받은 주를 가운데 두고 앞 2주 · 뒤 2주를 붙여 5주를 만든다. 앞뒤 네 줄은 픽스처에
 * 없는 날이므로 요일과 날짜만 적고 누를 수 없게 둔다. 질의는 늘지 않는다.
 * ------------------------------------------------------------------ */

const MONTH_WEEK_OFFSETS: readonly number[] = [-2, -1, 0, 1, 2];

/** 픽스처에 없는 날. 요일 자리는 같은 열의 요일을 그대로 물려받는다. */
type FillerDay = {
  date: string;
  dow: string;
  dayNumber: number;
  isWeekend: boolean;
};

type MonthCell =
  | { kind: "day"; day: CalendarDay }
  | { kind: "filler"; filler: FillerDay };

function buildMonthGrid(days: CalendarDay[]): MonthCell[][] {
  return MONTH_WEEK_OFFSETS.map((weekOffset) =>
    days.map((day): MonthCell => {
      if (weekOffset === 0) {
        return { kind: "day", day };
      }
      const date = addDays(day.date, weekOffset * 7);
      return {
        kind: "filler",
        filler: {
          date,
          dow: day.dow,
          dayNumber: dayOfMonth(date),
          isWeekend: day.isWeekend,
        },
      };
    }),
  );
}

/* ------------------------------------------------------------------ *
 * 그리기
 * ------------------------------------------------------------------ */

function dayClassName(day: CalendarDay, isSelected: boolean): string {
  const names = ["board-day"];
  if (day.isToday) names.push("is-today");
  if (isSelected) names.push("is-active");
  if (day.isWeekend) names.push("is-weekend");
  if (day.isAway) names.push("is-away");
  return names.join(" ");
}

/** 눈으로 읽는 것과 같은 것을 귀로도 읽게 한다. "부재" 는 CSS 로만 나오므로 여기서 말로 적는다. */
function dayLabel(day: CalendarDay): string {
  const head = `${monthOf(day.date)}월 ${day.dayNumber}일 ${day.dow}요일`;
  const marks: string[] = [];
  if (day.isToday) marks.push("오늘");
  if (day.isAway) marks.push("부재");

  const parts = [marks.length > 0 ? `${head}, ${marks.join(", ")}` : head];
  parts.push(`${day.count}건`);
  for (const chip of day.chips) {
    parts.push(chip.text);
  }
  if (day.moreCount > 0) {
    parts.push(`외 ${day.moreCount}건`);
  }
  return parts.join(", ");
}

function ChipDot({ tone }: { tone: MarkerTone }): JSX.Element {
  return <span className={`board-day-chip-dot is-${tone}`} aria-hidden="true" />;
}

type DayCardProps = {
  day: CalendarDay;
  isSelected: boolean;
  onSelectDate: (date: string | null) => void;
};

function DayCard({ day, isSelected, onSelectDate }: DayCardProps): JSX.Element {
  return (
    <button
      type="button"
      className={dayClassName(day, isSelected)}
      aria-pressed={isSelected}
      aria-label={dayLabel(day)}
      onClick={() => onSelectDate(isSelected ? null : day.date)}
    >
      <span className="board-day-top">
        <span className="board-day-dow">{day.dow}</span>
        <span className="board-day-num">{day.dayNumber}</span>
        {day.isToday ? (
          <span className="board-day-flag">오늘</span>
        ) : (
          <span className="board-day-count">{day.count}</span>
        )}
      </span>
      {day.chips.map((chip, index) => (
        <span
          key={`${day.date}-chip-${index}`}
          className={`board-day-chip is-${chip.tone}`}
        >
          <ChipDot tone={chip.tone} />
          <span className="board-day-chip-text">{chip.text}</span>
        </span>
      ))}
      {day.moreCount > 0 ? (
        <span className="board-day-more">+{day.moreCount}건</span>
      ) : null}
    </button>
  );
}

function FillerCard({ filler }: { filler: FillerDay }): JSX.Element {
  const names = ["board-day"];
  if (filler.isWeekend) names.push("is-weekend");

  return (
    <button
      type="button"
      className={names.join(" ")}
      disabled
      aria-label={`${monthOf(filler.date)}월 ${filler.dayNumber}일 ${filler.dow}요일, 불러온 일정 없음`}
    >
      <span className="board-day-top">
        <span className="board-day-dow">{filler.dow}</span>
        <span className="board-day-num">{filler.dayNumber}</span>
      </span>
    </button>
  );
}

function ChevronLeftIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function ChevronDownIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function WeekCalendar({
  calendar,
  viewMode,
  selectedDate,
  onSelectDate,
  onPrevRange,
  onNextRange,
  onViewModeChange,
}: WeekCalendarProps): JSX.Element {
  const isMonth = viewMode === "month";
  const monthGrid = isMonth ? buildMonthGrid(calendar.days) : null;

  return (
    <section className="board-cal" aria-label="일정">
      <div className="board-cal-bar">
        <div className="board-cal-nav">
          <button
            type="button"
            className="board-cal-nav-button"
            aria-label="이전 주"
            disabled
            onClick={onPrevRange}
          >
            <ChevronLeftIcon />
          </button>
          <button
            type="button"
            className="board-cal-nav-button"
            aria-label="다음 주"
            disabled
            onClick={onNextRange}
          >
            <ChevronRightIcon />
          </button>
        </div>

        <span className="board-cal-range">
          {calendar.rangeLabel}{" "}
          <em className="board-cal-range-count">{calendar.totalCount}건</em>
        </span>

        <div className="board-cal-legend">
          {calendar.legend.map((item) => (
            <span key={item.tone} className="board-cal-legend-item">
              <span
                className={`board-cal-legend-dot is-${item.tone}`}
                aria-hidden="true"
              />
              {item.label}
            </span>
          ))}
          <button
            type="button"
            className="board-cal-expand"
            aria-pressed={isMonth}
            onClick={() => onViewModeChange(isMonth ? "week" : "month")}
          >
            <ChevronDownIcon />
            월간 펼치기
          </button>
        </div>
      </div>

      {monthGrid ? (
        <div className="board-month">
          {monthGrid.map((week, weekIndex) =>
            week.map((cell) =>
              cell.kind === "day" ? (
                <DayCard
                  key={cell.day.date}
                  day={cell.day}
                  isSelected={selectedDate === cell.day.date}
                  onSelectDate={onSelectDate}
                />
              ) : (
                <FillerCard
                  key={`${weekIndex}-${cell.filler.date}`}
                  filler={cell.filler}
                />
              ),
            ),
          )}
        </div>
      ) : (
        <div className="board-week">
          {calendar.days.map((day) => (
            <DayCard
              key={day.date}
              day={day}
              isSelected={selectedDate === day.date}
              onSelectDate={onSelectDate}
            />
          ))}
        </div>
      )}
    </section>
  );
}
