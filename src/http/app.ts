import type { MainConversationService } from "../application/main-conversation.ts";
import { conversationTurnSchema } from "../domain/main-conversation.ts";
import type { WorkItemService } from "../application/work-items.ts";
import {
  createWorkItemSchema,
  updateWorkItemSchema,
  workItemActionSchema,
  workItemAttemptSchema,
  resolveWorkItemSchema,
} from "../domain/work-item.ts";
import type { AgentService } from "../agent/service.ts";
import {
  agentProposalSchema,
  agentApprovalSchema,
  workspaceRequestSchema,
} from "../domain/agent.ts";
/** Hono routing surface for the local Doggie HTTP service. */

import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

import { Hono } from "hono";
import { z } from "zod";

import { chatTaskPayloadSchema } from "../domain/task.ts";
import type { TaskQueue } from "../application/task-queue.ts";
import { taskEventStream } from "./task-events.ts";

import type { BucketType } from "../domain/types.ts";

import {
  archiveRequestSchema,
  bucketStatusRequestSchema,
  chatConfirmationRequestSchema,
  chatRequestSchema,
  DEFAULT_LIST_LIMIT,
  HttpBoundaryError,
  memoryQueryRequestSchema,
  moveEntryRequestSchema,
  queryLimitSchema,
  todoAdvanceRequestSchema,
  todoAgendaQuerySchema,
  todoPlanRequestSchema,
  todoReopenRequestSchema,
  todoTransitionRequestSchema,
  stableError,
  type ArchiveRequest,
  type BucketStatusRequest,
  type ChatConfirmationRequest,
  type ChatRequest,
  type MemoryQueryRequest,
  type MoveEntryRequest,
} from "./contracts.ts";
import {
  operationFor,
  confirmedAppendRequestSchema,
  confirmedCreateRequestSchema,
  agentRejectionRequestSchema,
  emptyRequestSchema,
} from "./operations.ts";
import { errorResponseSchema } from "./response-schemas.ts";
import {
  assertSecureRequest,
  AuthorityPolicy,
  setSecurityResponseHeaders,
} from "./security.ts";

export type DoggieHttpApi = {
  readonly activeBuckets: (limit: number) => unknown | Promise<unknown>;
  readonly searchBuckets: (
    query: string,
    limit: number,
  ) => unknown | Promise<unknown>;
  readonly chatHistory: (limit: number) => unknown | Promise<unknown>;
  readonly memoryQuery: (
    query: string,
    limit: number,
  ) => unknown | Promise<unknown>;
  readonly memoryQueryJson: (
    request: MemoryQueryRequest,
  ) => unknown | Promise<unknown>;
  readonly bucketDetail: (bucketId: string) => unknown | Promise<unknown>;
  readonly deleteBucket: (bucketId: string) => unknown | Promise<unknown>;
  readonly revokeEntry: (entryId: string) => unknown | Promise<unknown>;
  readonly archive: (
    request: ArchiveRequest,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>;
  readonly chat: (
    request: ChatRequest,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>;
  readonly confirmChat: (
    request: ChatConfirmationRequest,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>;
  readonly appendConfirmed: (
    request: ArchiveRequest & { readonly bucket_id: string },
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>;
  readonly createConfirmed: (
    request: ArchiveRequest & {
      readonly title: string;
      readonly bucket_type: BucketType;
    },
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>;
  readonly moveEntry: (request: MoveEntryRequest) => unknown | Promise<unknown>;
  readonly setBucketStatus: (
    request: BucketStatusRequest,
  ) => unknown | Promise<unknown>;
  readonly agenda: (
    request: import("./contracts.ts").TodoAgendaQuery,
  ) => unknown | Promise<unknown>;
  readonly getTodo: (todoId: string) => unknown | Promise<unknown>;
  readonly transitionTodo: (
    todoId: string,
    request: import("./contracts.ts").TodoTransitionRequest,
  ) => unknown | Promise<unknown>;
  readonly updateTodoPlan: (
    todoId: string,
    request: import("./contracts.ts").TodoPlanRequest,
  ) => unknown | Promise<unknown>;
  readonly advanceTodo: (
    todoId: string,
    request: import("./contracts.ts").TodoAdvanceRequest,
  ) => unknown | Promise<unknown>;
  readonly reopenTodo: (
    todoId: string,
    request: import("./contracts.ts").TodoReopenRequest,
  ) => unknown | Promise<unknown>;
};

export type StaticAsset = {
  readonly path: string;
  readonly contentType: string;
  readonly body: string;
};

const FRONTEND_FILES = [
  [
    "/assets/work-items.ts",
    "assets/work-items.ts",
    "text/javascript; charset=utf-8",
  ],
  ["/assets/agents.ts", "assets/agents.ts", "text/javascript; charset=utf-8"],
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/index.html", "index.html", "text/html; charset=utf-8"],
  ["/assets/styles.css", "assets/styles.css", "text/css; charset=utf-8"],
  [
    "/assets/workspace.ts",
    "assets/workspace.ts",
    "text/javascript; charset=utf-8",
  ],
  ["/assets/app.ts", "assets/app.ts", "text/javascript; charset=utf-8"],
  ["/assets/api.ts", "assets/api.ts", "text/javascript; charset=utf-8"],
  [
    "/assets/response-contracts.ts",
    "assets/response-contracts.ts",
    "text/javascript; charset=utf-8",
  ],
  [
    "/assets/validate-response.ts",
    "assets/validate-response.ts",
    "text/javascript; charset=utf-8",
  ],
  ["/assets/state.ts", "assets/state.ts", "text/javascript; charset=utf-8"],
  ["/assets/dom.ts", "assets/dom.ts", "text/javascript; charset=utf-8"],
  ["/assets/views.ts", "assets/views.ts", "text/javascript; charset=utf-8"],
  [
    "/assets/markdown.ts",
    "assets/markdown.ts",
    "text/javascript; charset=utf-8",
  ],
  [
    "/assets/render-bucket.ts",
    "assets/render-bucket.ts",
    "text/javascript; charset=utf-8",
  ],
  [
    "/assets/render-archive.ts",
    "assets/render-archive.ts",
    "text/javascript; charset=utf-8",
  ],
  [
    "/assets/render-chat.ts",
    "assets/render-chat.ts",
    "text/javascript; charset=utf-8",
  ],
  [
    "/assets/render-query.ts",
    "assets/render-query.ts",
    "text/javascript; charset=utf-8",
  ],
] as const;

export function loadFrontendAssets(): readonly StaticAsset[] {
  return FRONTEND_FILES.map(([path, relativePath, contentType]) => {
    const source = readFileSync(
      new URL(`../../web/${relativePath}`, import.meta.url),
      "utf8",
    );
    return {
      path,
      contentType,
      body: relativePath.endsWith(".ts")
        ? stripTypeScriptTypes(source, { mode: "strip" })
        : source,
    };
  });
}

export function createDoggieApp(
  api: DoggieHttpApi,
  assets: readonly StaticAsset[] = loadFrontendAssets(),
  additionalAllowedAuthorities: readonly string[] = [],
  tasks?: TaskQueue,
  agents?: AgentService,
  workItems?: WorkItemService,
  conversation?: MainConversationService,
): Hono {
  const app = new Hono();
  const authorityPolicy = new AuthorityPolicy(additionalAllowedAuthorities);

  app.use("*", async (context, next) => {
    try {
      assertSecureRequest(context.req.raw, authorityPolicy);
      const operation = operationFor(
        context.req.method,
        new URL(context.req.url).pathname,
      );
      const enabled =
        operation !== undefined &&
        (operation.feature !== "tasks" || tasks !== undefined) &&
        (operation.feature !== "agents" || agents !== undefined) &&
        (operation.feature !== "workItems" || workItems !== undefined) &&
        (operation.feature !== "conversation" || conversation !== undefined);
      if (enabled) {
        const query: Record<string, string> = {};
        for (const [key, value] of new URL(context.req.url).searchParams) {
          if (Object.hasOwn(query, key))
            throw new HttpBoundaryError(400, "duplicate query parameter");
          Object.defineProperty(query, key, { value, enumerable: true });
        }
        (operation.querySchema ?? emptyRequestSchema).parse(query);
        if (operation.paramsSchema !== undefined) {
          const actual = new URL(context.req.url).pathname.split("/");
          const params: Record<string, string> = {};
          operation.path.split("/").forEach((part, index) => {
            if (part.startsWith(":")) {
              try {
                params[part.slice(1)] = decodeURIComponent(actual[index] ?? "");
              } catch {
                throw new HttpBoundaryError(400, "invalid path encoding");
              }
            }
          });
          operation.paramsSchema.parse(params);
        }
        if (operation.method === "delete" && context.req.raw.body !== null) {
          throw new HttpBoundaryError(400, "delete does not accept a body");
        }
      }
      await next();
      if (
        enabled &&
        !(operation.stream === true && context.res.status === 200)
      ) {
        let output: unknown;
        try {
          output = await context.res.clone().json();
        } catch {
          throw new HttpBoundaryError(
            500,
            "internal response contract violation",
          );
        }
        const valid =
          context.res.status >= 400
            ? errorResponseSchema.safeParse(output).success
            : context.res.status === operation.successStatus &&
              operation.responseSchema.safeParse(output).success;
        if (!valid)
          throw new HttpBoundaryError(
            500,
            "internal response contract violation",
          );
      }
    } catch (error) {
      const failure = stableError(error);
      context.res = context.json(failure.body, httpStatus(failure.status));
    } finally {
      setSecurityResponseHeaders(context.res.headers);
    }
  });

  for (const asset of assets) {
    app.get(asset.path, (context) =>
      context.body(asset.body, 200, { "Content-Type": asset.contentType }),
    );
  }

  app.get("/health", (context) =>
    context.json({ ok: true, service: "doggie-local-web" }),
  );
  app.get("/api/buckets/active", async (context) =>
    json(
      context,
      await api.activeBuckets(parseLimit(context.req.query("limit"))),
    ),
  );
  app.get("/api/buckets/search", async (context) =>
    json(
      context,
      await api.searchBuckets(
        requiredQuery(context.req.query("q"), "q"),
        parseLimit(context.req.query("limit")),
      ),
    ),
  );
  app.get("/api/chat/history", async (context) =>
    json(
      context,
      await api.chatHistory(parseLimit(context.req.query("limit"))),
    ),
  );
  app.get("/api/memory/query", async (context) =>
    json(
      context,
      await api.memoryQuery(
        requiredQuery(context.req.query("q"), "q"),
        parseLimit(context.req.query("limit")),
      ),
    ),
  );
  app.get("/api/buckets/:bucketId", async (context) =>
    json(context, await api.bucketDetail(context.req.param("bucketId"))),
  );
  app.delete("/api/buckets/:bucketId", async (context) =>
    json(context, await api.deleteBucket(context.req.param("bucketId"))),
  );
  app.delete("/api/entries/:entryId", async (context) => {
    if (context.req.raw.body !== null) {
      throw new HttpBoundaryError(
        400,
        "entry revocation does not accept a body",
      );
    }
    const id = z.string().trim().min(1).parse(context.req.param("entryId"));
    return json(context, await api.revokeEntry(id));
  });
  app.post("/api/archive", async (context) =>
    json(
      context,
      await api.archive(
        await parseBody(context, archiveRequestSchema),
        context.req.raw.signal,
      ),
    ),
  );
  app.post("/api/chat", async (context) =>
    json(
      context,
      await api.chat(
        await parseBody(context, chatRequestSchema),
        context.req.raw.signal,
      ),
    ),
  );
  app.post("/api/chat/confirm", async (context) =>
    json(
      context,
      await api.confirmChat(
        await parseBody(context, chatConfirmationRequestSchema),
        context.req.raw.signal,
      ),
    ),
  );
  app.post("/api/memory/query", async (context) =>
    json(
      context,
      await api.memoryQueryJson(
        await parseBody(context, memoryQueryRequestSchema),
      ),
    ),
  );
  app.post("/api/archive/append", async (context) => {
    const request = await parseBody(context, confirmedAppendRequestSchema);
    if (!request.confirmation_granted) {
      throw new HttpBoundaryError(400, "confirmation is required");
    }
    const { confirmation_granted: _, ...payload } = request;
    return json(
      context,
      await api.appendConfirmed(payload, context.req.raw.signal),
    );
  });
  app.post("/api/archive/create", async (context) => {
    const request = await parseBody(context, confirmedCreateRequestSchema);
    if (!request.confirmation_granted) {
      throw new HttpBoundaryError(400, "confirmation is required");
    }
    const { confirmation_granted: _, ...payload } = request;
    return json(
      context,
      await api.createConfirmed(payload, context.req.raw.signal),
    );
  });
  app.post("/api/corrections/move", async (context) =>
    json(
      context,
      await api.moveEntry(await parseBody(context, moveEntryRequestSchema)),
    ),
  );
  app.post("/api/buckets/status", async (context) =>
    json(
      context,
      await api.setBucketStatus(
        await parseBody(context, bucketStatusRequestSchema),
      ),
    ),
  );
  app.get("/api/agenda", async (context) =>
    json(
      context,
      await api.agenda(
        todoAgendaQuerySchema.parse({
          from: context.req.query("from"),
          to: context.req.query("to"),
          bucket_id: context.req.query("bucket_id"),
          include_history: context.req.query("include_history") ?? "false",
        }),
      ),
    ),
  );
  app.get("/api/todos/:todoId", async (context) =>
    json(context, await api.getTodo(context.req.param("todoId"))),
  );
  app.post("/api/todos/:todoId/transition", async (context) =>
    json(
      context,
      await api.transitionTodo(
        context.req.param("todoId"),
        await parseBody(context, todoTransitionRequestSchema),
      ),
    ),
  );
  app.post("/api/todos/:todoId/plan", async (context) =>
    json(
      context,
      await api.updateTodoPlan(
        context.req.param("todoId"),
        await parseBody(context, todoPlanRequestSchema),
      ),
    ),
  );
  app.post("/api/todos/:todoId/advance", async (context) =>
    json(
      context,
      await api.advanceTodo(
        context.req.param("todoId"),
        await parseBody(context, todoAdvanceRequestSchema),
      ),
    ),
  );
  app.post("/api/todos/:todoId/reopen", async (context) =>
    json(
      context,
      await api.reopenTodo(
        context.req.param("todoId"),
        await parseBody(context, todoReopenRequestSchema),
      ),
    ),
  );

  if (tasks !== undefined) {
    app.post("/api/tasks", async (context) => {
      const payload = await parseBody(context, chatTaskPayloadSchema);
      context.req.raw.signal.throwIfAborted();
      return context.json({ ok: true, task: tasks.submit(payload) }, 202);
    });
    app.get("/api/tasks", (context) =>
      context.json({ ok: true, tasks: tasks.list() }),
    );
    app.get("/api/tasks/:taskId", (context) =>
      context.json({
        ok: true,
        task: tasks.get(z.string().uuid().parse(context.req.param("taskId"))),
      }),
    );
    app.post("/api/tasks/:taskId/cancel", async (context) => {
      await parseBody(context, emptyRequestSchema);
      return context.json({
        ok: true,
        task: await tasks.cancel(
          z.string().uuid().parse(context.req.param("taskId")),
        ),
      });
    });
    app.get("/api/tasks/:taskId/events", (context) => {
      const id = z.string().uuid().parse(context.req.param("taskId"));
      return new Response(taskEventStream(tasks, id, context.req.raw.signal), {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    });
  }

  if (agents !== undefined) {
    const agentId = (id: string) => z.string().uuid().parse(id);
    app.get("/api/agent/capabilities", (context) =>
      context.json({ ok: true, ...agents.capabilities() }),
    );
    app.get("/api/agent/workspaces", (context) =>
      context.json({ ok: true, workspaces: agents.workspaces() }),
    );
    app.post("/api/agent/workspaces", async (context) => {
      const request = await parseBody(context, workspaceRequestSchema);
      return context.json(
        {
          ok: true,
          workspace: await agents.register(request.path, request.bucketId),
        },
        201,
      );
    });
    app.get("/api/agent/tasks", (context) =>
      context.json({ ok: true, tasks: agents.list() }),
    );
    app.get("/api/agent/tasks/:id", (context) =>
      context.json({
        ok: true,
        task: agents.get(agentId(context.req.param("id"))),
      }),
    );
    app.post("/api/agent/tasks", async (context) =>
      context.json(
        {
          ok: true,
          task: await agents.propose(
            await parseBody(context, agentProposalSchema),
          ),
        },
        201,
      ),
    );
    app.post("/api/agent/tasks/:id/approve", async (context) => {
      const request = await parseBody(context, agentApprovalSchema);
      context.req.raw.signal.throwIfAborted();
      return context.json(
        {
          ok: true,
          ...(await agents.approve(
            agentId(context.req.param("id")),
            request.instruction,
            context.req.raw.signal,
          )),
        },
        202,
      );
    });
    app.post("/api/agent/tasks/:id/reject", async (context) => {
      const request = await parseBody(context, agentRejectionRequestSchema);
      return context.json({
        ok: true,
        task: agents.reject(
          agentId(context.req.param("id")),
          request.instruction,
        ),
      });
    });
    app.post("/api/agent/tasks/:id/cancel", async (context) => {
      await parseBody(context, emptyRequestSchema);
      return context.json({
        ok: true,
        task: await agents.cancel(agentId(context.req.param("id"))),
      });
    });
  }

  if (conversation !== undefined) {
    app.get("/api/conversation/clarifications", (context) =>
      context.json({ ok: true, clarifications: conversation.list() }),
    );
    app.post("/api/conversation/turns", async (context) =>
      context.json({
        ok: true,
        result: await conversation.turn(
          await parseBody(context, conversationTurnSchema),
          context.req.raw.signal,
        ),
      }),
    );
  }

  if (workItems !== undefined) {
    app.get("/api/work-items", (context) =>
      context.json({ ok: true, workItems: workItems.list() }),
    );
    app.post("/api/work-items", async (context) =>
      context.json(
        {
          ok: true,
          workItem: workItems.create(
            await parseBody(context, createWorkItemSchema),
          ),
        },
        201,
      ),
    );
    app.post("/api/work-items/resolve", async (context) =>
      context.json({
        ok: true,
        ...workItems.resolve(await parseBody(context, resolveWorkItemSchema)),
      }),
    );
    app.get("/api/work-items/:id", (context) =>
      context.json({ ok: true, ...workItems.detail(context.req.param("id")) }),
    );
    app.post("/api/work-items/:id/update", async (context) =>
      context.json({
        ok: true,
        workItem: workItems.update(
          context.req.param("id"),
          await parseBody(context, updateWorkItemSchema),
        ),
      }),
    );
    app.post("/api/work-items/:id/transition", async (context) =>
      context.json({
        ok: true,
        workItem: await workItems.transition(
          context.req.param("id"),
          await parseBody(context, workItemActionSchema),
        ),
      }),
    );
    app.post("/api/work-items/:id/attempts", async (context) =>
      context.json(
        {
          ok: true,
          task: await workItems.propose(
            context.req.param("id"),
            await parseBody(context, workItemAttemptSchema),
          ),
        },
        201,
      ),
    );
  }

  app.notFound((context) =>
    context.json({ ok: false, error: "route not found" }, 404),
  );
  app.onError((error, context) => {
    const failure = stableError(error);
    return context.json(failure.body, httpStatus(failure.status));
  });

  return app;
}

function parseLimit(raw: string | undefined): number {
  return queryLimitSchema.parse(raw ?? DEFAULT_LIST_LIMIT);
}

function requiredQuery(value: string | undefined, name: string): string {
  const cleaned = value?.trim() ?? "";
  if (cleaned === "") {
    throw new HttpBoundaryError(400, `${name} must not be empty`);
  }
  return cleaned;
}

async function parseBody<T>(
  context: {
    req: { json: () => Promise<unknown>; method: string; url: string };
  },
  schema: z.ZodType<T>,
): Promise<T> {
  const operation = operationFor(
    context.req.method,
    new URL(context.req.url).pathname,
  );
  if (operation?.bodySchema !== schema) {
    throw new HttpBoundaryError(500, "internal request contract violation");
  }
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new HttpBoundaryError(400, "request body must be valid JSON");
  }
  return schema.parse(body);
}

function json(
  context: { json: (value: never) => Response },
  value: unknown,
): Response {
  return context.json(value as never);
}

function httpStatus(
  status: number,
): 400 | 403 | 404 | 409 | 415 | 429 | 503 | 500 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 415:
    case 429:
    case 503:
    case 500:
      return status;
    default:
      return 500;
  }
}
