import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNaturalTodoPlan, shouldAutoPromoteTodo } from "./todo-time.ts";
import { BucketType } from "./types.ts";

// 2026-11-26T19:20:00+08:00 (Thursday)
const REF = new Date("2026-11-26T11:20:00.000Z");
const TZ = "Asia/Shanghai";

test("parseNaturalTodoPlan resolves relative Chinese morning/clock expressions in local timezone", () => {
  const exact = parseNaturalTodoPlan("明天早上8点完成计网作业", REF, TZ);
  assert.ok(exact);
  assert.equal(exact.scheduledAt, "2026-11-27T00:00:00.000Z");
  assert.equal(exact.dueAt, null);
  assert.equal(exact.rawTime?.scheduledText, "明天早上8点");
  assert.equal(exact.rawTime?.timeZone, TZ);

  const bareMorning = parseNaturalTodoPlan("明天早上写计网作业", REF, TZ);
  assert.ok(bareMorning);
  assert.equal(bareMorning.scheduledAt, "2026-11-27T01:00:00.000Z");
  assert.equal(bareMorning.rawTime?.scheduledText, "明天早上");

  const evening = parseNaturalTodoPlan("明晚8点半复习操作系统", REF, TZ);
  assert.ok(evening);
  assert.equal(evening.scheduledAt, "2026-11-27T12:30:00.000Z");

  const deadline = parseNaturalTodoPlan("下周一早上8点前提交实验报告", REF, TZ);
  assert.ok(deadline);
  assert.equal(deadline.scheduledAt, null);
  assert.equal(deadline.dueAt, "2026-11-30T00:00:00.000Z");
  assert.equal(deadline.rawTime?.dueText, "下周一早上8点");
});

test("parseNaturalTodoPlan supports repeating rules with concrete clock anchors and ignores timeless text", () => {
  const daily = parseNaturalTodoPlan("每天早上8点检查构建状态", REF, TZ);
  assert.ok(daily);
  assert.equal(daily.scheduledAt, "2026-11-27T00:00:00.000Z");
  assert.deepEqual(daily.repeatRule, {
    frequency: "daily",
    interval: 1,
    weekdays: undefined,
    until: undefined,
    count: undefined,
  });

  // No concrete clock time -> must return null so legacy todos stay unscheduled
  assert.equal(parseNaturalTodoPlan("每日检查", REF, TZ), null);
  assert.equal(parseNaturalTodoPlan("安排回归", REF, TZ), null);
});

test("shouldAutoPromoteTodo promotes scheduled upcoming tasks but excludes past logs", () => {
  const plan = parseNaturalTodoPlan("明天早上写计网作业", REF, TZ);
  assert.equal(
    shouldAutoPromoteTodo("明天早上写计网作业", BucketType.Experiment, plan),
    true,
  );
  assert.equal(
    shouldAutoPromoteTodo(
      "接口 A 的 p99 延迟降到 31ms",
      BucketType.Experiment,
      null,
    ),
    false,
  );
  assert.equal(
    shouldAutoPromoteTodo("接口 A 更新了", BucketType.Task, null),
    false,
  );
  assert.equal(
    shouldAutoPromoteTodo("明天早上8点已完成的旧记录", BucketType.Task, plan),
    false,
  );
});
