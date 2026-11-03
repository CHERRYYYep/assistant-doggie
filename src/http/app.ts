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
import { taskEventStream, type TaskQueue } from "../application/task-queue.ts";

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
  stableError,
  type ArchiveRequest,
  type BucketStatusRequest,
  type ChatConfirmationRequest,
  type ChatRequest,
  type MemoryQueryRequest,
  type MoveEntryRequest,
} from "./contracts.ts";
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
};

const confirmedAppendRequestSchema = z
  .object({
    text: z.string().trim().min(1),
    focus_bucket_id: z.string().trim().min(1).optional(),
    bucket_id: z.string().trim().min(1),
    confirmation_granted: z.literal(true),
  })
  .strict();

const confirmedCreateRequestSchema = z
  .object({
    text: z.string().trim().min(1),
    focus_bucket_id: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
    bucket_type: z.enum([
      "idea",
      "task",
      "incident",
      "experiment",
      "decision",
      "meeting",
      "knowledge",
      "draft",
    ]),
    confirmation_granted: z.literal(true),
  })
  .strict();

export type StaticAsset = {
  readonly path: string;
  readonly contentType: string;
  readonly body: string;
};

const FRONTEND_FILES = [
  ["/assets/agents.ts", "assets/agents.ts", "text/javascript; charset=utf-8"],
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/index.html", "index.html", "text/html; charset=utf-8"],
  ["/assets/styles.css", "assets/styles.css", "text/css; charset=utf-8"],
  ["/assets/app.ts", "assets/app.ts", "text/javascript; charset=utf-8"],
  ["/assets/api.ts", "assets/api.ts", "text/javascript; charset=utf-8"],
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
): Hono {
  const app = new Hono();
  const authorityPolicy = new AuthorityPolicy(additionalAllowedAuthorities);

  app.use("*", async (context, next) => {
    try {
      assertSecureRequest(context.req.raw, authorityPolicy);
      await next();
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
      await parseBody(context, z.object({}).strict());
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
      const request = await parseBody(
        context,
        z.object({ instruction: z.string().min(1).max(12_000) }).strict(),
      );
      return context.json({
        ok: true,
        task: agents.reject(
          agentId(context.req.param("id")),
          request.instruction,
        ),
      });
    });
    app.post("/api/agent/tasks/:id/cancel", async (context) => {
      await parseBody(context, z.object({}).strict());
      return context.json({
        ok: true,
        task: await agents.cancel(agentId(context.req.param("id"))),
      });
    });
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
  context: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>,
): Promise<T> {
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
