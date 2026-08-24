/** Hono routing surface for the local Doggie HTTP service. */

import { readFileSync } from "node:fs";

import { Hono } from "hono";
import { z } from "zod";

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
  readonly archive: (request: ArchiveRequest) => unknown | Promise<unknown>;
  readonly chat: (request: ChatRequest) => unknown | Promise<unknown>;
  readonly confirmChat: (
    request: ChatConfirmationRequest,
  ) => unknown | Promise<unknown>;
  readonly appendConfirmed: (
    request: ArchiveRequest & { readonly bucket_id: string },
  ) => unknown | Promise<unknown>;
  readonly createConfirmed: (
    request: ArchiveRequest & {
      readonly title: string;
      readonly bucket_type: BucketType;
    },
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
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/index.html", "index.html", "text/html; charset=utf-8"],
  ["/assets/styles.css", "assets/styles.css", "text/css; charset=utf-8"],
  ["/assets/app.js", "assets/app.js", "text/javascript; charset=utf-8"],
  ["/assets/api.js", "assets/api.js", "text/javascript; charset=utf-8"],
  ["/assets/state.js", "assets/state.js", "text/javascript; charset=utf-8"],
  ["/assets/dom.js", "assets/dom.js", "text/javascript; charset=utf-8"],
  ["/assets/views.js", "assets/views.js", "text/javascript; charset=utf-8"],
  [
    "/assets/markdown.js",
    "assets/markdown.js",
    "text/javascript; charset=utf-8",
  ],
  [
    "/assets/render-bucket.js",
    "assets/render-bucket.js",
    "text/javascript; charset=utf-8",
  ],
  [
    "/assets/render-archive.js",
    "assets/render-archive.js",
    "text/javascript; charset=utf-8",
  ],
  [
    "/assets/render-chat.js",
    "assets/render-chat.js",
    "text/javascript; charset=utf-8",
  ],
  [
    "/assets/render-query.js",
    "assets/render-query.js",
    "text/javascript; charset=utf-8",
  ],
] as const;

export function loadFrontendAssets(): readonly StaticAsset[] {
  return FRONTEND_FILES.map(([path, relativePath, contentType]) => ({
    path,
    contentType,
    body: readFileSync(
      new URL(
        `../../apps/doggie-local-web/frontend/${relativePath}`,
        import.meta.url,
      ),
      "utf8",
    ),
  }));
}

export function createDoggieApp(
  api: DoggieHttpApi,
  assets: readonly StaticAsset[] = loadFrontendAssets(),
  additionalAllowedAuthorities: readonly string[] = [],
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
  app.post("/api/archive", async (context) =>
    json(
      context,
      await api.archive(await parseBody(context, archiveRequestSchema)),
    ),
  );
  app.post("/api/chat", async (context) =>
    json(context, await api.chat(await parseBody(context, chatRequestSchema))),
  );
  app.post("/api/chat/confirm", async (context) =>
    json(
      context,
      await api.confirmChat(
        await parseBody(context, chatConfirmationRequestSchema),
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
    return json(context, await api.appendConfirmed(payload));
  });
  app.post("/api/archive/create", async (context) => {
    const request = await parseBody(context, confirmedCreateRequestSchema);
    if (!request.confirmation_granted) {
      throw new HttpBoundaryError(400, "confirmation is required");
    }
    const { confirmation_granted: _, ...payload } = request;
    return json(context, await api.createConfirmed(payload));
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

function httpStatus(status: number): 400 | 403 | 404 | 409 | 415 | 500 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 415:
    case 500:
      return status;
    default:
      return 500;
  }
}
