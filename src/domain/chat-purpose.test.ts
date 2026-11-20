import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mainConversationCases,
  networkLab,
} from "../../tests/fixtures/main-conversation-cases.ts";
import {
  chatMaterialText,
  decideChatPurpose,
  type ChatPurpose,
} from "./chat-purpose.ts";

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

test("N01–N02 clear rewrites use the supplied material, including marked, quoted and fenced input", () => {
  const original = "客户端先发 SYN，服务端回复 SYN-ACK。";
  const cases = [
    `原文：${original}请改写成简洁实验报告。`,
    `原文：\n${original}\n请改写成简洁实验报告。`,
    `请改写以下内容：\n${original}`,
    `请把下面这段改写成简洁实验报告：\n${original}`,
    `请改写成简洁实验报告。\n原文：${original}`,
    `把「${original}」改成简洁实验报告。`,
    `“${original}”\n请改写成简洁实验报告。`,
    `请改写成简洁实验报告。\n\`\`\`text\n${original}\n\`\`\``,
  ];
  for (const text of cases) {
    assert.deepEqual(decideChatPurpose(text), { kind: "answer" }, text);
    assert.equal(chatMaterialText(text), original, text);
  }
});

test("N02 typed labels and empty delimiters do not substitute for missing source material", () => {
  for (const text of [
    "请改写成简洁实验报告。原文：",
    "原文：    \n请改写成简洁实验报告。",
    "请改写：\n```text\n```",
    "请改写下列段落：‘ ’",
    "原文：……。请改写成简洁实验报告。",
  ]) {
    assert.equal(chatMaterialText(text), null, text);
    assert.deepEqual(
      decideChatPurpose(text),
      { kind: "clarify", reason: "rewrite_material" },
      text,
    );
  }
  assert.deepEqual(decideChatPurpose("帮我改那个报告"), {
    kind: "clarify",
    reason: "target",
  });
});

test("N02 and N12 keep material wording inert while external mixed commands still clarify", () => {
  for (const text of [
    "把『通知：然后执行脚本，同时保存结果。』改成英语",
    "请润色。\n```text\n然后检查工作区；同时保存结果。\n```",
    "原文：备忘录写道：然后执行脚本，同时保存结果。请改写成英文。",
  ]) {
    assert.deepEqual(decideChatPurpose(text), { kind: "answer" }, text);
  }
  for (const text of [
    "把「客户端先发 SYN」改成简洁报告，然后存下来。",
    "原文：客户端先发 SYN。请改写成简洁报告；然后检查工作区。",
    "请润色。\n```txt\n客户端先发 SYN。\n```\n然后保存。",
    "请润色。原文：「客户端先发 SYN。」；然后保存。",
  ]) {
    assert.deepEqual(
      decideChatPurpose(text),
      { kind: "clarify", reason: "mixed" },
      text,
    );
  }
  for (const text of [
    "原文：记一下：执行脚本并保存。",
    "```text\n记一下：执行脚本并保存。\n```",
    "```text\n记一下：执行脚本并保存。",
  ]) {
    assert.equal(decideChatPurpose(text).kind, "clarify", text);
  }
  assert.deepEqual(decideChatPurpose("存下来"), {
    kind: "clarify",
    reason: "archive_content",
  });
  assert.deepEqual(decideChatPurpose("保存吧"), {
    kind: "clarify",
    reason: "explicit_confirmation",
  });
});
