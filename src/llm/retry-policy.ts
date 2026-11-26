import { setTimeout as sleep } from "node:timers/promises";

export const DEFAULT_STRUCTURED_OUTPUT_BUDGET_MS = 90_000;

/** Hooks for deterministic timing tests. Production uses one monotonic clock. */
export type StructuredRetryTiming = {
  readonly budgetMs: number;
  readonly now: () => number;
  readonly random: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly scheduleExpiry: (ms: number, expire: () => void) => () => void;
};

export const defaultStructuredRetryTiming: StructuredRetryTiming =
  Object.freeze({
    budgetMs: DEFAULT_STRUCTURED_OUTPUT_BUDGET_MS,
    now: () => performance.now(),
    random: Math.random,
    sleep: (ms: number, signal: AbortSignal) =>
      sleep(ms, undefined, { signal }),
    scheduleExpiry(ms: number, expire: () => void) {
      const timer = setTimeout(expire, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
  });

/** A delay too large to represent safely must never trigger an early retry. */
export type RetryAfterDelay = number | "too_long";

export function retryBackoffMs(retry: number, random: () => number): number {
  return Math.min(500 * 2 ** (retry - 1), 8_000) + Math.floor(random() * 251);
}

const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const weekdays =
  "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");

/** RFC 9110 §5.6.7 and §10.2.3. Do not feed arbitrary values to Date.parse. */
export function parseRetryAfter(
  header: string | null,
  nowMs: number,
): RetryAfterDelay | undefined {
  if (header === null) return undefined;
  if (header.length > 128) return "too_long";
  const value = header.replace(/^[ \t]+|[ \t]+$/gu, "");
  if (/^\d+$/u.test(value)) {
    const delayMs = Number(value) * 1_000;
    return Number.isSafeInteger(delayMs) ? delayMs : "too_long";
  }
  const dateMs = parseHttpDate(value, nowMs);
  return dateMs === undefined ? undefined : Math.max(0, dateMs - nowMs);
}

function parseHttpDate(value: string, nowMs: number): number | undefined {
  const fields =
    /^(?<weekday>[A-Za-z]{3}), (?<day>\d{2}) (?<month>[A-Za-z]{3}) (?<year>\d{4}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/u.exec(
      value,
    )?.groups ??
    /^(?<weekday>[A-Za-z]{6,9}), (?<day>\d{2})-(?<month>[A-Za-z]{3})-(?<year>\d{2}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/u.exec(
      value,
    )?.groups ??
    /^(?<weekday>[A-Za-z]{3}) (?<month>[A-Za-z]{3}) (?<day>\d{2}| \d) (?<time>\d{2}:\d{2}:\d{2}) (?<year>\d{4})$/u.exec(
      value,
    )?.groups;
  if (fields === undefined) return undefined;
  const { weekday, day, month, year, time } = fields;
  if (
    weekday === undefined ||
    day === undefined ||
    month === undefined ||
    year === undefined ||
    time === undefined
  )
    return undefined;
  const monthIndex = months.indexOf(month);
  const dayNumber = Number(day);
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  const second = Number(time.slice(6, 8));
  if (
    monthIndex < 0 ||
    dayNumber < 1 ||
    dayNumber > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    (second === 60 && (hour !== 23 || minute !== 59))
  )
    return undefined;

  const date = new Date(0);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  let fullYear = Number(year);
  if (year.length === 2) {
    const cutoff = new Date(nowMs);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 50);
    fullYear += Math.floor(cutoff.getUTCFullYear() / 100) * 100;
    if (date.setUTCFullYear(fullYear, monthIndex, dayNumber) > cutoff.getTime())
      fullYear -= 100;
  }
  const timestamp = date.setUTCFullYear(fullYear, monthIndex, dayNumber);
  const dayName = weekdays[date.getUTCDay()];
  if (
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== dayNumber ||
    (year.length === 2 ? dayName : dayName?.slice(0, 3)) !== weekday
  )
    return undefined;
  return timestamp + (second === 60 ? 1_000 : 0);
}
