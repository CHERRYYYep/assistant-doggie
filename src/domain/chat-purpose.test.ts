import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mainConversationCases,
  networkLab,
} from "../../tests/fixtures/main-conversation-cases.ts";
import { decideChatPurpose, type ChatPurpose } from "./chat-purpose.ts";

test("C1 clear questions and self-contained rewrites need neither a target nor an archive", () => {
  const clear = mainConversationCases.find(({ stage }) => stage === "C1");
  assert.ok(clear);
  for (const step of clear.steps) {
    assert.ok("text" in step.input);
    assert.deepEqual(decideChatPurpose(step.input.text), { kind: "answer" });
  }
});

test("C1 routes representative fresh messages without granting authority or inferring an ID", () => {
  const cases: readonly [string, ChatPurpose][] = [
    [networkLab.request, { kind: "clarify", reason: "target" }],
    [networkLab.supplement, { kind: "clarify", reason: "purpose" }],
    ["好", { kind: "clarify", reason: "explicit_confirmation" }],
    ["批准", { kind: "clarify", reason: "explicit_confirmation" }],
    ["修好了", { kind: "clarify", reason: "purpose" }],
    ["上次发布审批是什么时候？", { kind: "lookup" }],
    ["查一下以前的压测记录", { kind: "lookup" }],
    ["查一下 SYN-ACK 是什么？", { kind: "answer" }],
    ["查一下我上次记录的结论是什么？", { kind: "lookup" }],
    ["只读检查 TCP 抓包报告里握手的两句描述", { kind: "propose_execution" }],
    ["请修改 TCP 抓包与三次握手报告", { kind: "propose_execution" }],
    ["检查那个工作区", { kind: "clarify", reason: "target" }],
    ["记一下：接口 p99 从 62ms 降到 31ms", { kind: "archive" }],
    ["接口 p99 从 62ms 降到 31ms", { kind: "archive" }],
    ["接口 p99 为 31ms 吗", { kind: "answer" }],
    ["如果接口 p99 为 31ms", { kind: "clarify", reason: "purpose" }],
    ["记一下", { kind: "clarify", reason: "purpose" }],
    ["记一下：实验完成；然后检查报告", { kind: "clarify", reason: "mixed" }],
    ["记一下：「然后检查报告」是会议中的引文", { kind: "archive" }],
    ["把「然后执行脚本」改成英语", { kind: "answer" }],
    ["不要保存，SYN-ACK 是什么？", { kind: "answer" }],
  ];
  for (const [text, expected] of cases)
    assert.deepEqual(decideChatPurpose(text), expected, text);
});
