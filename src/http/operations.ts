import { conversationTurnSchema } from "../domain/main-conversation.ts";
import {
  createWorkItemSchema,
  updateWorkItemSchema,
  workItemActionSchema,
  workItemAttemptSchema,
  resolveWorkItemSchema,
} from "../domain/work-item.ts";
/** One inventory for local routes, runtime validation and generated OpenAPI. */
import { z } from "zod";

import {
  agentApprovalSchema,
  agentProposalSchema,
  workspaceRequestSchema,
} from "../domain/agent.ts";
import { chatTaskPayloadSchema } from "../domain/task.ts";
import { BUCKET_TYPES } from "../domain/types.ts";
import {
  archiveRequestSchema,
  bucketStatusRequestSchema,
  chatConfirmationRequestSchema,
  chatRequestSchema,
  memoryQueryRequestSchema,
  moveEntryRequestSchema,
  queryLimitSchema,
  todoAdvanceRequestSchema,
  todoAgendaQuerySchema,
  todoPlanRequestSchema,
  todoReopenRequestSchema,
  todoTransitionRequestSchema,
} from "./contracts.ts";
import * as response from "./response-schemas.ts";

const trimmed = z.string().trim().min(1);
export const confirmedAppendRequestSchema = z.strictObject({
  text: trimmed,
  focus_bucket_id: trimmed.optional(),
  bucket_id: trimmed,
  confirmation_granted: z.literal(true),
});
export const confirmedCreateRequestSchema = z.strictObject({
  text: trimmed,
  focus_bucket_id: trimmed.optional(),
  title: trimmed,
  bucket_type: z.enum(BUCKET_TYPES),
  confirmation_granted: z.literal(true),
});
export const agentRejectionRequestSchema = z.strictObject({
  instruction: z.string().min(1).max(12_000),
});
export const emptyRequestSchema = z.strictObject({});
export const listQuerySchema = z.strictObject({ limit: queryLimitSchema });
export const searchQuerySchema = z.strictObject({
  q: trimmed,
  limit: queryLimitSchema,
});
export const bucketPathSchema = z.strictObject({ bucketId: trimmed });
export const entryPathSchema = z.strictObject({ entryId: trimmed });
export const todoPathSchema = z.strictObject({ todoId: trimmed });
export const taskPathSchema = z.strictObject({ taskId: z.string().uuid() });
export const agentTaskPathSchema = z.strictObject({ id: z.string().uuid() });

export type HttpOperation = {
  readonly operationId: string;
  readonly method: "get" | "post" | "delete";
  /** Hono route syntax; OpenAPI transforms :name into {name}. */
  readonly path: string;
  readonly successStatus: 200 | 201 | 202;
  readonly responseSchema: z.ZodType;
  readonly bodySchema?: z.ZodType;
  readonly querySchema?: z.ZodObject;
  readonly paramsSchema?: z.ZodObject;
  readonly feature?: "tasks" | "agents" | "workItems" | "conversation";
  readonly stream?: true;
  readonly description?: string;
};

export const HTTP_OPERATIONS = [
  {
    operationId: "health",
    method: "get",
    path: "/health",
    successStatus: 200,
    responseSchema: response.healthResponseSchema,
  },
  {
    operationId: "activeBuckets",
    method: "get",
    path: "/api/buckets/active",
    successStatus: 200,
    querySchema: listQuerySchema,
    responseSchema: response.activeBucketsResponseSchema,
  },
  {
    operationId: "searchBuckets",
    method: "get",
    path: "/api/buckets/search",
    successStatus: 200,
    querySchema: searchQuerySchema,
    responseSchema: response.bucketSearchResponseSchema,
  },
  {
    operationId: "chatHistory",
    method: "get",
    path: "/api/chat/history",
    successStatus: 200,
    querySchema: listQuerySchema,
    responseSchema: response.chatHistoryResponseSchema,
  },
  {
    operationId: "memoryQuery",
    method: "get",
    path: "/api/memory/query",
    successStatus: 200,
    querySchema: searchQuerySchema,
    responseSchema: response.memoryQueryResponseSchema,
  },
  {
    operationId: "memoryQueryJson",
    method: "post",
    path: "/api/memory/query",
    successStatus: 200,
    bodySchema: memoryQueryRequestSchema,
    responseSchema: response.memoryQueryResponseSchema,
  },
  {
    operationId: "bucketDetail",
    method: "get",
    path: "/api/buckets/:bucketId",
    successStatus: 200,
    paramsSchema: bucketPathSchema,
    responseSchema: response.bucketDetailResponseSchema,
  },
  {
    operationId: "deleteBucket",
    method: "delete",
    path: "/api/buckets/:bucketId",
    successStatus: 200,
    paramsSchema: bucketPathSchema,
    responseSchema: response.deleteBucketResponseSchema,
  },
  {
    operationId: "revokeEntry",
    method: "delete",
    path: "/api/entries/:entryId",
    successStatus: 200,
    paramsSchema: entryPathSchema,
    responseSchema: response.revokeEntryResponseSchema,
    description:
      "Revoke an Entry and its exclusively supported derived memories from effective use. Retain source and audit records. Repeated revocation returns the original result. No request body.",
  },
  {
    operationId: "archive",
    method: "post",
    path: "/api/archive",
    successStatus: 200,
    bodySchema: archiveRequestSchema,
    responseSchema: response.archiveProjectionSchema,
  },
  {
    operationId: "chat",
    method: "post",
    path: "/api/chat",
    successStatus: 200,
    bodySchema: chatRequestSchema,
    responseSchema: response.chatResponseSchema,
  },
  {
    operationId: "conversationTurn",
    method: "post",
    path: "/api/conversation/turns",
    successStatus: 200,
    feature: "conversation",
    bodySchema: conversationTurnSchema,
    responseSchema: response.conversationTurnResponseSchema,
  },
  {
    operationId: "conversationClarifications",
    method: "get",
    path: "/api/conversation/clarifications",
    successStatus: 200,
    feature: "conversation",
    responseSchema: response.clarificationListResponseSchema,
  },
  {
    operationId: "conversationInteractions",
    method: "get",
    path: "/api/conversation/interactions",
    successStatus: 200,
    feature: "conversation",
    responseSchema: response.conversationInteractionListResponseSchema,
  },
  {
    operationId: "confirmChat",
    method: "post",
    path: "/api/chat/confirm",
    successStatus: 200,
    bodySchema: chatConfirmationRequestSchema,
    responseSchema: response.chatConfirmationResponseSchema,
  },
  {
    operationId: "appendConfirmed",
    method: "post",
    path: "/api/archive/append",
    successStatus: 200,
    bodySchema: confirmedAppendRequestSchema,
    responseSchema: response.archiveProjectionSchema,
  },
  {
    operationId: "createConfirmed",
    method: "post",
    path: "/api/archive/create",
    successStatus: 200,
    bodySchema: confirmedCreateRequestSchema,
    responseSchema: response.archiveProjectionSchema,
  },
  {
    operationId: "moveEntry",
    method: "post",
    path: "/api/corrections/move",
    successStatus: 200,
    bodySchema: moveEntryRequestSchema,
    responseSchema: response.moveEntryResponseSchema,
  },
  {
    operationId: "setBucketStatus",
    method: "post",
    path: "/api/buckets/status",
    successStatus: 200,
    bodySchema: bucketStatusRequestSchema,
    responseSchema: response.bucketStatusResponseSchema,
  },
  {
    operationId: "agenda",
    method: "get",
    path: "/api/agenda",
    querySchema: todoAgendaQuerySchema,
    successStatus: 200,
    responseSchema: response.agendaResponseSchema,
  },
  {
    operationId: "getTodo",
    method: "get",
    path: "/api/todos/:todoId",
    paramsSchema: todoPathSchema,
    successStatus: 200,
    responseSchema: response.todoResponseSchema,
  },
  {
    operationId: "transitionTodo",
    method: "post",
    path: "/api/todos/:todoId/transition",
    paramsSchema: todoPathSchema,
    bodySchema: todoTransitionRequestSchema,
    successStatus: 200,
    responseSchema: response.todoMutationResponseSchema,
  },
  {
    operationId: "updateTodoPlan",
    method: "post",
    path: "/api/todos/:todoId/plan",
    paramsSchema: todoPathSchema,
    bodySchema: todoPlanRequestSchema,
    successStatus: 200,
    responseSchema: response.todoMutationResponseSchema,
  },
  {
    operationId: "advanceTodo",
    method: "post",
    path: "/api/todos/:todoId/advance",
    paramsSchema: todoPathSchema,
    bodySchema: todoAdvanceRequestSchema,
    successStatus: 200,
    responseSchema: response.todoMutationResponseSchema,
  },
  {
    operationId: "reopenTodo",
    method: "post",
    path: "/api/todos/:todoId/reopen",
    paramsSchema: todoPathSchema,
    bodySchema: todoReopenRequestSchema,
    successStatus: 200,
    responseSchema: response.todoMutationResponseSchema,
  },
  {
    operationId: "submitTask",
    method: "post",
    path: "/api/tasks",
    successStatus: 202,
    feature: "tasks",
    bodySchema: chatTaskPayloadSchema,
    responseSchema: response.taskResponseSchema,
    description:
      "Explicit submission. A transport timeout does not establish failure and must not cause automatic POST retry. Task payload is limited to 128 KiB of UTF-8 JSON.",
  },
  {
    operationId: "listTasks",
    method: "get",
    path: "/api/tasks",
    successStatus: 200,
    feature: "tasks",
    responseSchema: response.tasksResponseSchema,
  },
  {
    operationId: "getTask",
    method: "get",
    path: "/api/tasks/:taskId",
    successStatus: 200,
    feature: "tasks",
    paramsSchema: taskPathSchema,
    responseSchema: response.taskResponseSchema,
  },
  {
    operationId: "cancelTask",
    method: "post",
    path: "/api/tasks/:taskId/cancel",
    successStatus: 200,
    feature: "tasks",
    paramsSchema: taskPathSchema,
    bodySchema: emptyRequestSchema,
    responseSchema: response.taskResponseSchema,
  },
  {
    operationId: "watchTask",
    method: "get",
    path: "/api/tasks/:taskId/events",
    successStatus: 200,
    feature: "tasks",
    paramsSchema: taskPathSchema,
    responseSchema: response.taskEventDataSchema,
    stream: true,
    description:
      "SSE event: task; id is the decimal payload.revision; data is a TaskSnapshot. Heartbeat comments every 15 seconds. Coalesced current snapshots, no historical replay or Last-Event-ID guarantee. Terminal state closes the stream. Disconnect only stops observation; recover with GET, never resubmit POST.",
  },
  {
    operationId: "agentCapabilities",
    method: "get",
    path: "/api/agent/capabilities",
    successStatus: 200,
    feature: "agents",
    responseSchema: response.agentCapabilitiesResponseSchema,
  },
  {
    operationId: "agentWorkspaces",
    method: "get",
    path: "/api/agent/workspaces",
    successStatus: 200,
    feature: "agents",
    responseSchema: response.agentWorkspacesResponseSchema,
  },
  {
    operationId: "registerAgentWorkspace",
    method: "post",
    path: "/api/agent/workspaces",
    successStatus: 201,
    feature: "agents",
    bodySchema: workspaceRequestSchema,
    responseSchema: response.agentWorkspaceResponseSchema,
  },
  {
    operationId: "listAgentTasks",
    method: "get",
    path: "/api/agent/tasks",
    successStatus: 200,
    feature: "agents",
    responseSchema: response.agentTasksResponseSchema,
  },
  {
    operationId: "getAgentTask",
    method: "get",
    path: "/api/agent/tasks/:id",
    successStatus: 200,
    feature: "agents",
    paramsSchema: agentTaskPathSchema,
    responseSchema: response.agentTaskResponseSchema,
  },
  {
    operationId: "proposeAgentTask",
    method: "post",
    path: "/api/agent/tasks",
    successStatus: 201,
    feature: "agents",
    bodySchema: agentProposalSchema,
    responseSchema: response.agentTaskResponseSchema,
    description:
      "Proposal is pending only; never authorizes execution. UTF-8 instruction bytes times two plus 512 must fit 32 KiB; whitespace-only instruction is rejected.",
  },
  {
    operationId: "approveAgentTask",
    method: "post",
    path: "/api/agent/tasks/:id/approve",
    successStatus: 202,
    feature: "agents",
    paramsSchema: agentTaskPathSchema,
    bodySchema: agentApprovalSchema,
    responseSchema: response.agentApprovalResponseSchema,
  },
  {
    operationId: "rejectAgentTask",
    method: "post",
    path: "/api/agent/tasks/:id/reject",
    successStatus: 200,
    feature: "agents",
    paramsSchema: agentTaskPathSchema,
    bodySchema: agentRejectionRequestSchema,
    responseSchema: response.agentTaskResponseSchema,
  },
  {
    operationId: "cancelAgentTask",
    method: "post",
    path: "/api/agent/tasks/:id/cancel",
    successStatus: 200,
    feature: "agents",
    paramsSchema: agentTaskPathSchema,
    bodySchema: emptyRequestSchema,
    responseSchema: response.agentTaskResponseSchema,
  },
  {
    operationId: "listWorkItems",
    method: "get",
    path: "/api/work-items",
    successStatus: 200,
    feature: "workItems",
    responseSchema: response.workItemsResponseSchema,
  },
  {
    operationId: "createWorkItem",
    method: "post",
    path: "/api/work-items",
    successStatus: 201,
    feature: "workItems",
    responseSchema: response.workItemResponseSchema,
    bodySchema: createWorkItemSchema,
  },
  {
    operationId: "resolveWorkItem",
    method: "post",
    path: "/api/work-items/resolve",
    successStatus: 200,
    feature: "workItems",
    responseSchema: response.workItemResolutionResponseSchema,
    bodySchema: resolveWorkItemSchema,
  },
  {
    operationId: "getWorkItem",
    method: "get",
    path: "/api/work-items/:id",
    successStatus: 200,
    feature: "workItems",
    responseSchema: response.workItemDetailResponseSchema,
    paramsSchema: agentTaskPathSchema,
  },
  {
    operationId: "updateWorkItem",
    method: "post",
    path: "/api/work-items/:id/update",
    successStatus: 200,
    feature: "workItems",
    responseSchema: response.workItemResponseSchema,
    bodySchema: updateWorkItemSchema,
    paramsSchema: agentTaskPathSchema,
  },
  {
    operationId: "transitionWorkItem",
    method: "post",
    path: "/api/work-items/:id/transition",
    successStatus: 200,
    feature: "workItems",
    responseSchema: response.workItemResponseSchema,
    bodySchema: workItemActionSchema,
    paramsSchema: agentTaskPathSchema,
  },
  {
    operationId: "proposeWorkItemAttempt",
    method: "post",
    path: "/api/work-items/:id/attempts",
    successStatus: 201,
    feature: "workItems",
    responseSchema: response.agentTaskResponseSchema,
    bodySchema: workItemAttemptSchema,
    paramsSchema: agentTaskPathSchema,
  },
] as const satisfies readonly HttpOperation[];

export function operationFor(
  method: string,
  pathname: string,
): HttpOperation | undefined {
  const normalizedMethod =
    method.toLowerCase() === "head" ? "get" : method.toLowerCase();
  return HTTP_OPERATIONS.find((operation) => {
    if (operation.method !== normalizedMethod) return false;
    const parts = pathname.split("/");
    const template = operation.path.split("/");
    return (
      parts.length === template.length &&
      template.every((part, index) =>
        part.startsWith(":")
          ? (parts[index]?.length ?? 0) > 0
          : part === parts[index],
      )
    );
  });
}
