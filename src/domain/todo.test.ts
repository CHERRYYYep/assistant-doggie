import { test } from "node:test";
import assert from "node:assert/strict";

import { DomainError } from "./errors.ts";
import {
  calculateNextTodoOccurrence,
  canTransitionTodoStatus,
  createRepeatRule,
  createTodoPlan,
  createTodoRawTime,
  TodoStatus,
  transitionTodoStatus,
} from "./todo.ts";

const errorKind = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof DomainError);
    return error.kind;
  }
  throw new Error("expected DomainError");
};

test("TODO lifecycle accepts only the five explicit states and transitions", () => {
  assert.equal(
    transitionTodoStatus(TodoStatus.Open, TodoStatus.Done),
    TodoStatus.Done,
  );
  assert.equal(
    transitionTodoStatus(TodoStatus.Done, TodoStatus.Open),
    TodoStatus.Open,
  );
  assert.equal(
    canTransitionTodoStatus(TodoStatus.Blocked, TodoStatus.Done),
    false,
  );
  assert.equal(
    errorKind(() =>
      transitionTodoStatus(TodoStatus.Done, TodoStatus.Cancelled),
    ),
    "invalid_todo_transition",
  );
  assert.equal(
    errorKind(() => transitionTodoStatus("unknown", TodoStatus.Open)),
    "invalid_todo_status",
  );
});

test("TODO plan normalizes explicit timezone timestamps and rejects inverted ranges", () => {
  const plan = createTodoPlan({
    scheduledAt: "2026-11-04T10:00:00+08:00",
    dueAt: "2026-11-04T05:00:00Z",
    rawTime: {
      scheduledText: "今天上午",
      dueText: "今天中午",
      timeZone: "Asia/Shanghai",
    },
  });
  assert.equal(plan.scheduledAt, "2026-11-04T02:00:00.000Z");
  assert.equal(plan.dueAt, "2026-11-04T05:00:00.000Z");
  assert.equal(plan.rawTime?.timeZone, "Asia/Shanghai");
  assert.equal(
    errorKind(() =>
      createTodoPlan({
        scheduledAt: "2026-11-05T00:00:00Z",
        dueAt: "2026-11-04T00:00:00Z",
      }),
    ),
    "invalid_todo_plan",
  );
  assert.equal(
    errorKind(() => createTodoPlan({ scheduledAt: "2026-11-04" })),
    "invalid_todo_time",
  );
});

test("repeat rules are narrow, normalized, and reject ambiguous combinations", () => {
  const weekly = createRepeatRule({
    frequency: "weekly",
    interval: 1,
    weekdays: [3, 1, 3],
  });
  assert.deepEqual(weekly.weekdays, [1, 3]);
  assert.equal(
    errorKind(() => createRepeatRule({ frequency: "daily", interval: 0 })),
    "invalid_repeat_rule",
  );
  assert.equal(
    errorKind(() =>
      createRepeatRule({ frequency: "daily", interval: 1, weekdays: [1] }),
    ),
    "invalid_repeat_rule",
  );
  assert.equal(
    errorKind(() =>
      createRepeatRule({
        frequency: "daily",
        interval: 1,
        until: "2026-11-30T00:00:00Z",
        count: 2,
      }),
    ),
    "invalid_repeat_rule",
  );
  assert.equal(
    errorKind(() =>
      createRepeatRule({ frequency: "weekly", interval: 1, weekdays: [8] }),
    ),
    "invalid_repeat_rule",
  );
});

test("next occurrence respects daily, weekly weekdays, count, and until", () => {
  assert.equal(
    calculateNextTodoOccurrence("2026-11-04T09:00:00Z", {
      frequency: "daily",
      interval: 2,
    }),
    "2026-11-06T09:00:00.000Z",
  );
  assert.equal(
    calculateNextTodoOccurrence("2026-11-05T09:00:00Z", {
      frequency: "weekly",
      interval: 1,
      weekdays: [1, 3],
    }),
    "2026-11-09T09:00:00.000Z",
  );
  assert.equal(
    calculateNextTodoOccurrence("2026-11-04T09:00:00Z", {
      frequency: "daily",
      interval: 1,
      count: 1,
    }),
    null,
  );
  assert.equal(
    calculateNextTodoOccurrence("2026-11-04T09:00:00Z", {
      frequency: "daily",
      interval: 1,
      until: "2026-11-04T09:00:00Z",
    }),
    null,
  );
});

test("monthly month-end ambiguity is rejected instead of silently rolling over", () => {
  assert.equal(
    errorKind(() =>
      calculateNextTodoOccurrence("2026-01-31T09:00:00Z", {
        frequency: "monthly",
        interval: 1,
      }),
    ),
    "unsupported_repeat_rule",
  );
});

test("raw time preserves user wording and validates IANA timezone", () => {
  const raw = createTodoRawTime({
    scheduledText: "明早",
    timeZone: "America/Los_Angeles",
  });
  assert.deepEqual(raw, {
    scheduledText: "明早",
    dueText: null,
    timeZone: "America/Los_Angeles",
  });
  assert.equal(
    errorKind(() => createTodoRawTime({ timeZone: "Mars/Olympus" })),
    "invalid_todo_plan",
  );
});
