import { z } from "zod";
import { failureCodeSchema } from "./failure-code.ts";
export const agentBackendSchema = z.enum(["claude", "codex"]);
export type AgentBackend = z.infer<typeof agentBackendSchema>;
export const workspaceRequestSchema = z
  .object({
    path: z.string().min(1).max(4096),
    bucketId: z.string().min(1).max(200).optional(),
  })
  .strict();
export const agentProposalSchema = z
  .object({
    instruction: z
      .string()
      .min(1)
      .max(12_000)
      .refine((s) => s.trim() !== ""),
    backend: agentBackendSchema,
    workspaceId: z.string().uuid().nullable(),
    sessionId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(value.instruction).length * 2 + 512 <= 32 * 1024,
    "proposal too large",
  );
export type AgentProposal = z.infer<typeof agentProposalSchema>;
export const agentApprovalSchema = z
  .object({
    instruction: z.string().min(1).max(12_000),
    confirmation_granted: z.literal(true),
  })
  .strict();
export const workspaceSchema = z
  .object({
    id: z.string().uuid(),
    path: z.string(),
    baseCommit: z.string(),
    gitStatus: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type AgentWorkspace = Readonly<z.infer<typeof workspaceSchema>>;
export const sessionSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid().nullable(),
    backend: agentBackendSchema,
    remoteId: z.string().uuid().nullable(),
    memoryRevision: z.number().int().nonnegative().default(0),
    createdAt: z.string(),
  })
  .strict();
export type AgentSession = Readonly<z.infer<typeof sessionSchema>>;
export const agentTaskSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    workspaceId: z.string().uuid().nullable(),
    backend: agentBackendSchema,
    instruction: z.string(),
    pendingActionId: z.string().uuid(),
    queueId: z.string().uuid().nullable(),
    status: z.enum([
      "pending",
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "rejected",
    ]),
    output: z.string(),
    failureCode: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type AgentTask = Readonly<z.infer<typeof agentTaskSchema>>;

/**
 * The only shapes that may cross the AgentStore completion boundary.
 * A terminal failure never carries output or a remote identity, and a
 * successful result never carries a failure code.
 */
export const agentCompletionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("succeeded"),
      output: z.string(),
      failureCode: z.null(),
      remoteId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      output: z.literal(""),
      failureCode: failureCodeSchema.refine(
        (value) => value !== "cancelled",
        "failed results must use a non-cancelled failure code",
      ),
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
      output: z.literal(""),
      failureCode: z.literal("cancelled"),
    })
    .strict(),
]);
export type AgentCompletion = Readonly<z.infer<typeof agentCompletionSchema>>;

export class AgentError extends Error {
  readonly code:
    | "disabled"
    | "invalid_workspace"
    | "workspace_changed"
    | "missing"
    | "conflict"
    | "binding_mismatch"
    | "memory_changed"
    | "process_failed"
    | "output_limit"
    | "invalid_event"
    | "unavailable";
  constructor(code: AgentError["code"]) {
    super(`agent: ${code}`);
    this.name = "AgentError";
    this.code = code;
  }
}

export class HarnessError extends Error {
  readonly code:
    "context_limit" | "round_limit" | "invalid_response" | "model_failed";
  constructor(code: HarnessError["code"]) {
    super(`agent harness: ${code}`);
    this.name = "HarnessError";
    this.code = code;
  }
}
