import { DomainError, requiredText } from "./errors.ts";

/** Lifecycle states for a user-controlled TODO. */
export const TodoStatus = {
  Open: "open",
  InProgress: "in_progress",
  Blocked: "blocked",
  Done: "done",
  Cancelled: "cancelled",
} as const;
export type TodoStatus = (typeof TodoStatus)[keyof typeof TodoStatus];

export const TODO_STATUSES: readonly TodoStatus[] = Object.values(TodoStatus);

export function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    typeof value === "string" &&
    (TODO_STATUSES as readonly string[]).includes(value)
  );
}

const ALLOWED_TRANSITIONS: Readonly<Record<TodoStatus, readonly TodoStatus[]>> =
  {
    [TodoStatus.Open]: [
      TodoStatus.InProgress,
      TodoStatus.Blocked,
      TodoStatus.Done,
      TodoStatus.Cancelled,
    ],
    [TodoStatus.InProgress]: [
      TodoStatus.Open,
      TodoStatus.Blocked,
      TodoStatus.Done,
      TodoStatus.Cancelled,
    ],
    [TodoStatus.Blocked]: [
      TodoStatus.Open,
      TodoStatus.InProgress,
      TodoStatus.Cancelled,
    ],
    [TodoStatus.Done]: [TodoStatus.Open],
    [TodoStatus.Cancelled]: [TodoStatus.Open],
  };

export function allowedTodoTransitions(
  status: TodoStatus,
): readonly TodoStatus[] {
  return ALLOWED_TRANSITIONS[status];
}

export function canTransitionTodoStatus(
  from: unknown,
  to: unknown,
): from is TodoStatus {
  if (!isTodoStatus(from) || !isTodoStatus(to)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Validate and apply one explicit lifecycle command. Same-state commands are rejected. */
export function transitionTodoStatus(from: unknown, to: unknown): TodoStatus {
  if (!isTodoStatus(from)) throw DomainError.invalidTodoStatus(from);
  if (!isTodoStatus(to)) throw DomainError.invalidTodoStatus(to);
  if (!canTransitionTodoStatus(from, to)) {
    throw DomainError.invalidTodoTransition(from, to);
  }
  return to;
}

export type RepeatFrequency = "daily" | "weekly" | "monthly";

export type RepeatRule = {
  readonly frequency: RepeatFrequency;
  readonly interval: number;
  readonly weekdays: readonly number[] | undefined;
  readonly until: string | undefined;
  readonly count: number | undefined;
};

const REPEAT_FREQUENCIES: readonly RepeatFrequency[] = [
  "daily",
  "weekly",
  "monthly",
];

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Normalize a timestamp without silently treating a date-only value as UTC. */
export function normalizeTodoTime(value: unknown, field = "time"): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value.trim())) {
    throw DomainError.invalidTodoTime(field, value);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw DomainError.invalidTodoTime(field, value);
  }
  return date.toISOString();
}

export type TodoRawTime = {
  readonly scheduledText: string | null;
  readonly dueText: string | null;
  readonly timeZone: string;
};

export type TodoRawTimeInput = {
  readonly scheduledText?: unknown;
  readonly dueText?: unknown;
  readonly timeZone: unknown;
};

function normalizeTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw DomainError.invalidTodoPlan(
      "timeZone must be a non-empty IANA time zone",
    );
  }
  const timeZone = value.trim();
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions()
      .timeZone;
  } catch {
    throw DomainError.invalidTodoPlan(`invalid IANA time zone: ${timeZone}`);
  }
}

export function createTodoRawTime(input: TodoRawTimeInput): TodoRawTime {
  const normalizeRaw = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    return requiredText(String(value), "raw TODO time");
  };
  return {
    scheduledText: normalizeRaw(input.scheduledText),
    dueText: normalizeRaw(input.dueText),
    timeZone: normalizeTimeZone(input.timeZone),
  };
}

export type RepeatRuleInput = {
  readonly frequency: unknown;
  readonly interval: unknown;
  readonly weekdays?: unknown;
  readonly until?: unknown;
  readonly count?: unknown;
};

function isRepeatFrequency(value: unknown): value is RepeatFrequency {
  return (
    typeof value === "string" &&
    (REPEAT_FREQUENCIES as readonly string[]).includes(value)
  );
}

function normalizeOptionalTimestamp(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeTodoTime(value, field);
}

/** Validate the deliberately small repeat vocabulary used by T14. */
export function createRepeatRule(input: unknown): RepeatRule {
  if (typeof input !== "object" || input === null) {
    throw DomainError.invalidRepeatRule("repeat rule must be an object");
  }
  const candidate = input as RepeatRuleInput;
  if (!isRepeatFrequency(candidate.frequency)) {
    throw DomainError.invalidRepeatRule(
      "frequency must be daily, weekly, or monthly",
    );
  }
  if (
    typeof candidate.interval !== "number" ||
    !Number.isInteger(candidate.interval) ||
    candidate.interval < 1 ||
    candidate.interval > 31
  ) {
    throw DomainError.invalidRepeatRule(
      "interval must be an integer from 1 to 31",
    );
  }

  let weekdays: readonly number[] | undefined;
  if (candidate.weekdays !== undefined && candidate.weekdays !== null) {
    if (
      candidate.frequency !== "weekly" ||
      !Array.isArray(candidate.weekdays)
    ) {
      throw DomainError.invalidRepeatRule(
        "weekdays are only allowed for weekly rules",
      );
    }
    const values = candidate.weekdays;
    if (
      values.length === 0 ||
      values.some(
        (value): value is number =>
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 1 ||
          value > 7,
      )
    ) {
      throw DomainError.invalidRepeatRule(
        "weekly weekdays must contain integers from 1 to 7",
      );
    }
    weekdays = [...new Set(values)].sort((left, right) => left - right);
  }

  const until = normalizeOptionalTimestamp(candidate.until, "repeat until");
  let count: number | undefined;
  if (candidate.count !== undefined && candidate.count !== null) {
    if (
      typeof candidate.count !== "number" ||
      !Number.isInteger(candidate.count) ||
      candidate.count < 1 ||
      candidate.count > 366
    ) {
      throw DomainError.invalidRepeatRule(
        "count must be an integer from 1 to 366",
      );
    }
    count = candidate.count;
  }
  if (until !== undefined && count !== undefined) {
    throw DomainError.invalidRepeatRule("until and count cannot both be set");
  }
  return {
    frequency: candidate.frequency,
    interval: candidate.interval,
    weekdays,
    until,
    count,
  };
}

export type TodoPlan = {
  readonly scheduledAt: string | null;
  readonly dueAt: string | null;
  readonly repeatRule: RepeatRule | null;
  readonly rawTime: TodoRawTime | null;
};

export type TodoPlanInput = {
  readonly scheduledAt?: unknown;
  readonly dueAt?: unknown;
  readonly repeatRule?: unknown;
  readonly rawTime?: TodoRawTimeInput | null;
};

export function createTodoPlan(input: TodoPlanInput = {}): TodoPlan {
  const scheduledAt =
    input.scheduledAt === undefined || input.scheduledAt === null
      ? null
      : normalizeTodoTime(input.scheduledAt, "scheduledAt");
  const dueAt =
    input.dueAt === undefined || input.dueAt === null
      ? null
      : normalizeTodoTime(input.dueAt, "dueAt");
  if (scheduledAt !== null && dueAt !== null && scheduledAt > dueAt) {
    throw DomainError.invalidTodoPlan(
      "scheduledAt must not be later than dueAt",
    );
  }
  const repeatRule =
    input.repeatRule === undefined || input.repeatRule === null
      ? null
      : createRepeatRule(input.repeatRule);
  if (repeatRule !== null && scheduledAt === null) {
    throw DomainError.invalidTodoPlan(
      "a repeating TODO requires scheduledAt as its occurrence anchor",
    );
  }
  const rawTime =
    input.rawTime === undefined || input.rawTime === null
      ? null
      : createTodoRawTime(input.rawTime);
  return { scheduledAt, dueAt, repeatRule, rawTime };
}

function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

function startOfIsoWeek(date: Date): Date {
  const result = new Date(date.getTime());
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCDate(result.getUTCDate() - (isoWeekday(result) - 1));
  return result;
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function nextOccurrenceDate(current: Date, rule: RepeatRule): Date {
  if (rule.frequency === "daily") {
    return addUtcDays(current, rule.interval);
  }
  if (rule.frequency === "weekly") {
    if (rule.weekdays === undefined)
      return addUtcDays(current, rule.interval * 7);
    const targetWeek = startOfIsoWeek(current);
    targetWeek.setUTCDate(targetWeek.getUTCDate() + rule.interval * 7);
    const firstWeekday = rule.weekdays[0];
    if (firstWeekday === undefined) {
      throw DomainError.invalidRepeatRule("weekly weekdays cannot be empty");
    }
    targetWeek.setUTCDate(targetWeek.getUTCDate() + firstWeekday - 1);
    targetWeek.setUTCHours(
      current.getUTCHours(),
      current.getUTCMinutes(),
      current.getUTCSeconds(),
      current.getUTCMilliseconds(),
    );
    return targetWeek;
  }
  const day = current.getUTCDate();
  const result = new Date(current.getTime());
  result.setUTCMonth(result.getUTCMonth() + rule.interval);
  if (result.getUTCDate() !== day) {
    throw DomainError.unsupportedRepeatRule(
      "monthly rules cannot advance across a month without the original day",
    );
  }
  return result;
}

/**
 * Calculate the next occurrence after a completed occurrence.
 * `completedOccurrences` includes the occurrence represented by `current`.
 */
export function calculateNextTodoOccurrence(
  current: unknown,
  rule: unknown,
  completedOccurrences = 1,
): string | null {
  const normalizedCurrent = normalizeTodoTime(current, "current occurrence");
  const normalizedRule = createRepeatRule(rule);
  if (!Number.isInteger(completedOccurrences) || completedOccurrences < 1) {
    throw DomainError.invalidRepeatRule(
      "completedOccurrences must be a positive integer",
    );
  }
  if (
    normalizedRule.count !== undefined &&
    completedOccurrences >= normalizedRule.count
  ) {
    return null;
  }
  const currentDate = new Date(normalizedCurrent);
  const candidate = nextOccurrenceDate(currentDate, normalizedRule);
  const normalizedCandidate = candidate.toISOString();
  if (
    normalizedRule.until !== undefined &&
    normalizedCandidate > normalizedRule.until
  ) {
    return null;
  }
  return normalizedCandidate;
}
