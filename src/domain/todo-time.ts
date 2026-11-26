/** Deterministic natural Chinese / ISO time parser for TODO scheduling and timeline ordering. */

import { createTodoPlan, type RepeatRuleInput, type TodoPlan } from "./todo.ts";
import type { BucketType } from "./types.ts";

const DEFAULT_PERIOD_HOURS: Readonly<Record<string, number>> = {
  凌晨: 1,
  早: 9,
  早上: 9,
  早晨: 9,
  明早: 9,
  上午: 10,
  中午: 12,
  下午: 14,
  傍晚: 18,
  晚: 20,
  晚上: 20,
  今晚: 20,
  明晚: 20,
};

const CHINESE_NUMERALS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
};

const WEEKDAY_CHAR: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

const PAST_OR_METRIC_LOG =
  /(?:昨天|昨日|前天|上周|刚才|刚刚|已完成|已经完成|已修复|已解决|已上线|已提交|降至|升至|降到|升到|达到|(?:更新|完成|修复|解决|上线|提交|结束|做好|改好|处理)了)/u;
const FUTURE_TASK_ACTION =
  /(?:完成|写|提交|交|做|准备|复习|预习|开会|讨论|检查|排查|修改|更新|整理|发送|联系|购买|买|预约|提醒|参加|办理|看|学习|回顾)/u;
const EXPLICIT_TODO_INTENT =
  /(?:待办|提醒我|记得|别忘了|不要忘了|需要(?:完成|写|提交|做|准备|交)|要(?:完成|写|提交|交|准备|开会))/u;

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

type WallClockParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number; // 1 = Mon .. 7 = Sun
};

const WEEKDAY_SHORT: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function wallClockParts(date: Date, timeZone: string): WallClockParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hourRaw = Number(pick("hour"));
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number(pick("minute")),
    weekday: WEEKDAY_SHORT[pick("weekday")] ?? 1,
  };
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): { readonly year: number; readonly month: number; readonly day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Convert a local wall-clock timestamp in `timeZone` into an exact UTC ISO string. */
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): string {
  const targetAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = targetAsUtcMs;
  for (let i = 0; i < 3; i += 1) {
    const actual = wallClockParts(new Date(guess), timeZone);
    const actualAsUtcMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0,
      0,
    );
    const diff = targetAsUtcMs - actualAsUtcMs;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

function parseHourToken(token: string): number | null {
  if (/^\d{1,2}$/u.test(token)) {
    const value = Number(token);
    return value >= 0 && value <= 23 ? value : null;
  }
  const mapped = CHINESE_NUMERALS[token];
  return mapped === undefined ? null : mapped;
}

function adjustHourForPeriod(hour: number, period: string | undefined): number {
  if (period === undefined) return hour;
  if (
    period === "下午" ||
    period === "傍晚" ||
    period === "晚上" ||
    period === "晚" ||
    period === "今晚" ||
    period === "明晚"
  ) {
    return hour >= 1 && hour <= 11 ? hour + 12 : hour;
  }
  if (period === "中午") {
    return hour >= 1 && hour <= 10 ? hour + 12 : hour;
  }
  if (period === "凌晨") {
    return hour === 12 ? 0 : hour;
  }
  return hour;
}

type ParsedTimeOfDay = {
  readonly hour: number;
  readonly minute: number;
  readonly matched: string;
};

function parseTimeOfDay(segment: string): ParsedTimeOfDay | null {
  // 1. Explicit clock: e.g. 早上8点半 / 下午3:30 / 晚上八点 / 08:00
  const clockMatch =
    /(?<period>凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|早|晚)?\s*(?:(?<colonHour>\d{1,2})[:：](?<colonMin>\d{2})|(?<dotHour>\d{1,2}|十二|十一|[一二两三四五六七八九十])点(?<half>半)?(?:(?<dotMin>\d{1,2})分?)?)/u.exec(
      segment,
    );
  if (clockMatch !== null && clockMatch.groups !== undefined) {
    const period = clockMatch.groups["period"];
    const rawHour =
      clockMatch.groups["colonHour"] !== undefined
        ? parseHourToken(clockMatch.groups["colonHour"])
        : clockMatch.groups["dotHour"] !== undefined
          ? parseHourToken(clockMatch.groups["dotHour"])
          : null;
    if (rawHour !== null) {
      const minute =
        clockMatch.groups["colonMin"] !== undefined
          ? Number(clockMatch.groups["colonMin"])
          : clockMatch.groups["half"] !== undefined
            ? 30
            : clockMatch.groups["dotMin"] !== undefined
              ? Number(clockMatch.groups["dotMin"])
              : 0;
      if (minute >= 0 && minute <= 59) {
        const hour = adjustHourForPeriod(rawHour, period);
        if (hour >= 0 && hour <= 23) {
          return { hour, minute, matched: clockMatch[0] };
        }
      }
    }
  }

  // 2. Bare period attached to a day anchor: e.g. 明天早上 / 今天下午
  const barePeriod = /^(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)/u.exec(
    segment.trim(),
  );
  if (barePeriod?.[1] !== undefined) {
    const defaultHour = DEFAULT_PERIOD_HOURS[barePeriod[1]];
    if (defaultHour !== undefined) {
      return { hour: defaultHour, minute: 0, matched: barePeriod[1] };
    }
  }
  return null;
}

/**
 * Parse natural Chinese or ISO schedule/deadline text into a validated T14 `TodoPlan`.
 * Returns `null` when no concrete date/time anchor is present.
 */
export function parseNaturalTodoPlan(
  text: string,
  referenceNow: Date = new Date(),
  timeZone: string = localTimeZone(),
): TodoPlan | null {
  const trimmed = text.trim();
  if (!trimmed || !Number.isFinite(referenceNow.getTime())) return null;

  const now = wallClockParts(referenceNow, timeZone);

  // 1. Explicit ISO/date-time: 2026-11-28 09:00 or 2026/11/28 09:30
  const isoDateMatch =
    /(?<year>\d{4})[-/年](?<month>\d{1,2})[-/月](?<day>\d{1,2})日?(?:[T\s]*(?<tail>[^\n，,。；;]{0,16}))?/u.exec(
      trimmed,
    );
  if (isoDateMatch !== null && isoDateMatch.groups !== undefined) {
    const year = Number(isoDateMatch.groups["year"]);
    const month = Number(isoDateMatch.groups["month"]);
    const day = Number(isoDateMatch.groups["day"]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const tail = isoDateMatch.groups["tail"] ?? "";
      const tod = parseTimeOfDay(tail);
      const hour = tod?.hour ?? 9;
      const minute = tod?.minute ?? 0;
      const phrase =
        `${isoDateMatch[0].slice(0, isoDateMatch[0].length - tail.length)}${tod?.matched ?? ""}`.trim();
      const afterIndex = isoDateMatch.index + phrase.length;
      const isDue = /^\s*(?:之?前|截止|为止)/u.test(trimmed.slice(afterIndex));
      const iso = zonedWallClockToUtc(year, month, day, hour, minute, timeZone);
      return buildPlan(iso, phrase, isDue, null, timeZone);
    }
  }

  // 2. Repeating rules WITH explicit clock time (T14 requires scheduledAt anchor)
  const repeatMatch =
    /(?<rule>每天|每日|每周(?<wd>[一二三四五六日天]))\s*(?<tail>[^\n，,。；;]{0,16})/u.exec(
      trimmed,
    );
  if (repeatMatch !== null && repeatMatch.groups !== undefined) {
    const tail = repeatMatch.groups["tail"] ?? "";
    const tod = parseTimeOfDay(tail);
    if (tod !== null) {
      const wdChar = repeatMatch.groups["wd"];
      let deltaDays = 0;
      let repeatRule: RepeatRuleInput;
      if (wdChar !== undefined && WEEKDAY_CHAR[wdChar] !== undefined) {
        const targetWd = WEEKDAY_CHAR[wdChar];
        deltaDays = (targetWd - now.weekday + 7) % 7;
        repeatRule = { frequency: "weekly", interval: 1, weekdays: [targetWd] };
      } else {
        repeatRule = { frequency: "daily", interval: 1 };
      }
      let targetDate = addCalendarDays(now.year, now.month, now.day, deltaDays);
      let iso = zonedWallClockToUtc(
        targetDate.year,
        targetDate.month,
        targetDate.day,
        tod.hour,
        tod.minute,
        timeZone,
      );
      if (Date.parse(iso) <= referenceNow.getTime()) {
        targetDate = addCalendarDays(
          targetDate.year,
          targetDate.month,
          targetDate.day,
          wdChar !== undefined ? 7 : 1,
        );
        iso = zonedWallClockToUtc(
          targetDate.year,
          targetDate.month,
          targetDate.day,
          tod.hour,
          tod.minute,
          timeZone,
        );
      }
      const phrase = `${repeatMatch.groups["rule"] ?? ""}${tod.matched}`.trim();
      return buildPlan(iso, phrase, false, repeatRule, timeZone);
    }
  }

  // 3. Relative Chinese day anchors: 今晚/明早/明晚/今天/明天/后天/大后天/本周X/下周X/MM月DD日
  const dayMatch =
    /(?<day>大后天|后天|后日|明天|明日|明早|明晚|今天|今日|今晚|(?:下|本|这)?周(?<wd>[一二三四五六日天])|(?<m>\d{1,2})月(?<d>\d{1,2})[日号])(?<tail>[^\n，,。；;]{0,16})/u.exec(
      trimmed,
    );
  if (dayMatch !== null && dayMatch.groups !== undefined) {
    const dayToken = dayMatch.groups["day"] ?? "";
    const tail = dayMatch.groups["tail"] ?? "";
    let targetDate: {
      readonly year: number;
      readonly month: number;
      readonly day: number;
    };
    let impliedPeriod: string | undefined;

    if (dayToken === "今天" || dayToken === "今日") {
      targetDate = { year: now.year, month: now.month, day: now.day };
    } else if (dayToken === "今晚") {
      targetDate = { year: now.year, month: now.month, day: now.day };
      impliedPeriod = "今晚";
    } else if (dayToken === "明天" || dayToken === "明日") {
      targetDate = addCalendarDays(now.year, now.month, now.day, 1);
    } else if (dayToken === "明早") {
      targetDate = addCalendarDays(now.year, now.month, now.day, 1);
      impliedPeriod = "明早";
    } else if (dayToken === "明晚") {
      targetDate = addCalendarDays(now.year, now.month, now.day, 1);
      impliedPeriod = "明晚";
    } else if (dayToken === "后天" || dayToken === "后日") {
      targetDate = addCalendarDays(now.year, now.month, now.day, 2);
    } else if (dayToken === "大后天") {
      targetDate = addCalendarDays(now.year, now.month, now.day, 3);
    } else if (dayMatch.groups["wd"] !== undefined) {
      const targetWd = WEEKDAY_CHAR[dayMatch.groups["wd"]];
      if (targetWd === undefined) return null;
      const isNextWeek = dayToken.startsWith("下");
      const diff = isNextWeek
        ? 7 - now.weekday + targetWd
        : (targetWd - now.weekday + 7) % 7;
      targetDate = addCalendarDays(now.year, now.month, now.day, diff);
    } else if (
      dayMatch.groups["m"] !== undefined &&
      dayMatch.groups["d"] !== undefined
    ) {
      const month = Number(dayMatch.groups["m"]);
      const day = Number(dayMatch.groups["d"]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const year =
        month < now.month || (month === now.month && day < now.day)
          ? now.year + 1
          : now.year;
      targetDate = { year, month, day };
    } else {
      return null;
    }

    const tod = parseTimeOfDay(
      impliedPeriod !== undefined &&
        !/^(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)/u.test(tail.trim())
        ? `${impliedPeriod}${tail}`
        : tail,
    );
    const defaultHour =
      impliedPeriod !== undefined
        ? (DEFAULT_PERIOD_HOURS[impliedPeriod] ?? 9)
        : 9;
    const hour = tod?.hour ?? defaultHour;
    const minute = tod?.minute ?? 0;

    // Strip any synthesized impliedPeriod prefix from matched phrase length
    const rawTailMatched =
      tod === null
        ? ""
        : impliedPeriod !== undefined && tod.matched.startsWith(impliedPeriod)
          ? tod.matched.slice(impliedPeriod.length)
          : tod.matched;
    const phrase = `${dayToken}${rawTailMatched}`.trim();
    const afterIndex = dayMatch.index + dayToken.length + rawTailMatched.length;
    const isDue = /^\s*(?:之?前|截止|为止)/u.test(trimmed.slice(afterIndex));
    const iso = zonedWallClockToUtc(
      targetDate.year,
      targetDate.month,
      targetDate.day,
      hour,
      minute,
      timeZone,
    );
    return buildPlan(iso, phrase, isDue, null, timeZone);
  }

  return null;
}

function buildPlan(
  iso: string,
  phrase: string,
  isDue: boolean,
  repeatRule: RepeatRuleInput | null,
  timeZone: string,
): TodoPlan {
  if (isDue && repeatRule === null) {
    return createTodoPlan({
      scheduledAt: null,
      dueAt: iso,
      repeatRule: null,
      rawTime: { scheduledText: null, dueText: phrase, timeZone },
    });
  }
  return createTodoPlan({
    scheduledAt: iso,
    dueAt: isDue ? iso : null,
    repeatRule,
    rawTime: {
      scheduledText: phrase,
      dueText: isDue ? phrase : null,
      timeZone,
    },
  });
}

/**
 * Determine whether an archived input with no extracted `todos` should still be
 * automatically promoted into the user's TODO/Timeline list.
 */
export function shouldAutoPromoteTodo(
  text: string,
  bucketType: BucketType | undefined,
  plan: TodoPlan | null,
): boolean {
  const trimmed = text.trim();
  if (!trimmed || PAST_OR_METRIC_LOG.test(trimmed)) return false;
  if (plan !== null && FUTURE_TASK_ACTION.test(trimmed)) return true;
  if (bucketType === "task" && EXPLICIT_TODO_INTENT.test(trimmed)) return true;
  return false;
}
