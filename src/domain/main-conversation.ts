import { z } from "zod";
import { agentBackendSchema, agentTaskSchema } from "./agent.ts";

const id = z.uuid();
const revision = z.number().int().positive();
const requestId = { requestId: id };
const change = {
  ...requestId,
  clarificationId: id,
  expectedRevision: revision,
};
const text = z.string().trim().min(1).max(4000);
export const conversationTurnSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("message"), ...requestId, text }),
  z.strictObject({ action: z.literal("reply"), ...change, text }),
  z.strictObject({ action: z.literal("select"), ...change, workItemId: id }),
  z.strictObject({ action: z.literal("none"), ...change }),
  z.strictObject({ action: z.literal("cancel"), ...change }),
  z.strictObject({ action: z.literal("continue"), ...change }),
  z.strictObject({
    action: z.literal("delegate"),
    ...change,
    backend: agentBackendSchema,
    workspaceId: id,
  }),
]);

export const clarificationReferenceSchema = z.strictObject({
  id,
  scopeRevision: revision,
});
export const MAX_CLARIFICATION_CANDIDATES = 5;
export const MAX_CLARIFICATION_CARDS = 20;
export const clarificationStatusSchema = z.enum([
  "pending",
  "resolved",
  "cancelled",
  "stale",
]);
export const clarificationCandidateSchema = clarificationReferenceSchema.extend(
  {
    title: z.string().min(1).max(120),
    hint: z.string().max(240),
  },
);
export const conversationExecutionSchema = z.strictObject({
  taskId: id,
  status: z.union([agentTaskSchema.shape.status, z.literal("stale")]),
  output: z.string().nullable(),
  failureCode: z.string().nullable(),
});
export const clarificationCardSchema = z.strictObject({
  id,
  originalMessageId: id,
  assistantMessageId: id,
  originalText: text,
  latestReply: text.nullable(),
  status: clarificationStatusSchema,
  revision,
  candidates: z
    .array(clarificationCandidateSchema)
    .max(MAX_CLARIFICATION_CANDIDATES),
  selected: clarificationCandidateSchema.nullable(),
  question: z.string().min(1).max(240),
  execution: conversationExecutionSchema.optional(),
});
const receipt = { userMessageId: id, assistantMessageId: id };
export const conversationReceiptSchema = z.union([
  z.strictObject({
    ...receipt,
    kind: z.literal("clarification"),
    clarificationId: id,
  }),
  z.strictObject({
    ...receipt,
    kind: z.enum([
      "answer",
      "lookup",
      "archive",
      "propose_execution",
      "clarify",
    ]),
    chatError: z.string().min(1).nullable(),
  }),
]);
export type ConversationTurn = Readonly<z.infer<typeof conversationTurnSchema>>;
export type ConversationReceipt = Readonly<
  z.infer<typeof conversationReceiptSchema>
>;
export type ClarificationReference = Readonly<
  z.infer<typeof clarificationReferenceSchema>
>;
export type ClarificationCard = Readonly<
  z.infer<typeof clarificationCardSchema>
>;
export type ClarificationStatus = ClarificationCard["status"];

export class ConversationError extends Error {
  readonly code:
    | "missing"
    | "stale"
    | "conflict"
    | "in_progress"
    | "capacity"
    | "context_limit";
  constructor(code: ConversationError["code"]) {
    const messages = {
      missing: "找不到这张澄清卡。",
      stale: "澄清卡已更新，请刷新后再操作。",
      conflict: "请求编号已用于另一项操作，或选择不属于这张卡。",
      in_progress: "该请求已接收，结果尚未确认。请刷新历史，避免重复发送。",
      capacity: "待澄清任务过多，请先处理或取消一张卡。",
      context_limit: "原请求及补充超出提案上限。请用更聚焦的新请求继续。",
    };
    super(messages[code]);
    this.name = "ConversationError";
    this.code = code;
  }
}

/** Related topics rank candidates, but never authorize binding them. */
export function topicTerms(text: string): readonly string[] {
  const norm = normalized(text)
    .replace(/计算机网络|计网|computer networks?/gu, " netlab ")
    .replace(/数据库|database/gu, " database ");
  return [...new Set(norm.match(/[a-z][a-z\d-]{1,31}/gu) ?? [])].slice(0, 24);
}

export function normalized(text: string): string {
  return text.normalize("NFKC").toLowerCase().trim();
}

/** A complete command argument can identify a title; incidental mentions cannot. */
export function explicitTitle(text: string): string | undefined {
  const argument =
    /^(?:请\s*)?(?:帮我\s*)?(?:(?:接着|继续)\s*)?(?:修改|更改|修订|改|修复|续做|完成|只读检查|检查|核对|查看|update\b|edit\b|fix\b)\s*(.+)$/iu.exec(
      text.trim().replace(/[。]$/u, ""),
    )?.[1];
  return argument === undefined ? undefined : unquoteTitle(argument);
}

function unquoteTitle(text: string): string {
  return (
    /^(?:「([^」]+)」|『([^』]+)』|“([^”]+)”|"([^"]+)")$/u
      .exec(text)
      ?.slice(1)
      .find((part) => part !== undefined) ?? text
  ).trim();
}

/** A reply may identify a title in its first clause and then add instructions. */
export function replyTarget(text: string): string | undefined {
  const wording = normalized(text);
  if (
    /^(?:(?:我)?(?:都不是|不|没)|别)|[?？]|(?:然后|同时|另外|并且|以及|或者)\s*(?:再|也)?\s*(?:修改|改|选|检查)/u.test(
      wording,
    )
  )
    return undefined;
  const first = text.split(/[，,。；;\n]/u)[0]?.trim() ?? "";
  return unquoteTitle(first.replace(/^(?:(?:我)?选(?:择)?|就是|是)\s*/u, ""));
}

/** A pointing phrase can quote a distinguishing fragment, not a generic label. */
export function distinguishingFragment(target: string): string | undefined {
  const fragment =
    /^(?:抓取?|围绕)?([\p{Script=Han}]{4,16})(?:那个|这个)$/u.exec(
      normalized(target),
    )?.[1];
  return fragment !== undefined &&
    !/实验|任务|项目|报告|文件|作业|工作|上次|之前/u.test(fragment)
    ? fragment
    : undefined;
}

export function isWorkItemId(text: string): boolean {
  return id.safeParse(text).success;
}
