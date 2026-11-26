/** Personal goals are distinct from TODOs, queue jobs and CLI attempts. */
import { z } from "zod";
import { agentProposalSchema, agentTaskSchema } from "./agent.ts";

export const WORK_ITEM_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;
const text = (max: number) => z.string().trim().min(1).max(max);
export const sourceReferenceSchema = z.strictObject({
  kind: z.enum(["entry", "bucket", "message"]),
  id: text(200),
});
const goalFields = {
  title: text(120),
  goal: text(4000),
  acceptance: text(2000),
};
export const createWorkItemSchema = z.strictObject({
  requestId: z.string().uuid(),
  ...goalFields,
  sources: z.array(sourceReferenceSchema).max(16).default([]),
});
export const updateWorkItemSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  ...goalFields,
});
export const workItemActionSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  action: z.enum(["complete", "reopen", "cancel"]),
});
export const workItemAttemptSchema = z.strictObject({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  backend: agentProposalSchema.shape.backend,
  workspaceId: agentProposalSchema.shape.workspaceId,
  sessionId: z.string().uuid().optional(),
  instruction: text(4000),
});
export const resolveWorkItemSchema = z.strictObject({
  workItemId: z.string().uuid().optional(),
  title: text(120).optional(),
});
export const workItemSchema = z.strictObject({
  id: z.string().uuid(),
  ...goalFields,
  status: z.enum(WORK_ITEM_STATUSES),
  revision: z.number().int().positive(),
  scopeRevision: z.number().int().positive(),
  cancelRequested: z.boolean(),
  lastAttemptId: z.string().uuid().nullable(),
  lastAttemptStatus: agentTaskSchema.shape.status.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const workItemSourceSchema = sourceReferenceSchema.extend({
  available: z.boolean(),
});
export type WorkItem = Readonly<z.infer<typeof workItemSchema>>;
export type SourceReference = Readonly<z.infer<typeof sourceReferenceSchema>>;
export type WorkItemAttempt = Readonly<z.infer<typeof workItemAttemptSchema>>;

export class WorkItemError extends Error {
  readonly code: "missing" | "conflict" | "stale" | "invalid_reference";
  constructor(code: WorkItemError["code"]) {
    super(`work item: ${code}`);
    this.name = "WorkItemError";
    this.code = code;
  }
}

export type WorkItemResolution = {
  readonly kind: "resolved" | "clarify" | "unassigned";
  readonly workItemId: string | null;
  readonly candidates: readonly {
    readonly id: string;
    readonly title: string;
  }[];
};

/** Never infer ownership from global recency, fuzzy keywords or UI focus. */
export function resolveWorkItem(
  input: z.infer<typeof resolveWorkItemSchema>,
  items: readonly Pick<WorkItem, "id" | "title" | "status">[],
): WorkItemResolution {
  if (input.workItemId !== undefined) {
    const item = items.find(({ id }) => id === input.workItemId);
    if (item === undefined) throw new WorkItemError("missing");
    if (input.title !== undefined && input.title !== item.title)
      throw new WorkItemError("conflict");
    return { kind: "resolved", workItemId: item.id, candidates: [] };
  }
  const candidates = items.filter((item) =>
    input.title === undefined
      ? item.status !== "done" && item.status !== "cancelled"
      : item.title === input.title,
  );
  if (input.title !== undefined && candidates.length === 1) {
    const [item] = candidates;
    if (item !== undefined)
      return { kind: "resolved", workItemId: item.id, candidates: [] };
  }
  return {
    kind: candidates.length === 0 ? "unassigned" : "clarify",
    workItemId: null,
    candidates: candidates.map(({ id, title }) => ({ id, title })),
  };
}

export function workItemInstruction(
  item: Pick<WorkItem, "goal" | "acceptance">,
  instruction: string,
): string {
  return `工作目标：\n${item.goal}\n\n验收要求：\n${item.acceptance}\n\n本次要求：\n${instruction}`;
}
