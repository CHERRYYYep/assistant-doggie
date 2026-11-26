/** Experimental HTTP contract for the pinned Core. Never imported by production. */
import { z } from "zod";

export const UPSTREAM_COMMIT = "42d4cde50c5a83182fced8c584f9ddb32a620615";
const id = z.string().min(1).max(200);
export const scopeSchema = z.strictObject({
  team_id: id,
  agent_id: id,
  user_id: id,
});
export type Scope = Readonly<z.infer<typeof scopeSchema>>;
export const messageSchema = z.strictObject({
  id,
  version: z.string().max(40).optional(),
  role: z.enum(["user", "assistant", "system", "tool", "developer"]),
  content: z.string().max(8192),
  timestamp: z.string().optional(),
  recorded_at: z.string().optional(),
  session_id: id.optional(),
  team_id: id.optional(),
  agent_id: id.optional(),
  user_id: id.optional(),
  // Upstream query projection uses the empty string for an absent task_id.
  task_id: z.string().max(200).optional(),
  score: z.number().finite().optional(),
});
export type CoreMessage = Readonly<z.infer<typeof messageSchema>>;
export const querySchema = z.strictObject({
  messages: z.array(messageSchema).max(100),
  total: z.number().int().nonnegative(),
});
export const searchSchema = z.strictObject({
  messages: z
    .array(
      z.strictObject({
        id,
        role: z.enum(["user", "assistant", "system", "tool", "developer"]),
        content: z.string().max(8192),
        timestamp: z.string().optional(),
        score: z.number().finite(),
      }),
    )
    .max(100),
});
export const addedSchema = z
  .strictObject({
    accepted_ids: z.array(id).min(1).max(100),
    accepted_versions: z.array(z.literal("v1")).min(1).max(100),
    total_count: z.number().int().positive().max(100),
  })
  .superRefine((value, ctx) => {
    if (
      value.accepted_ids.length !== value.total_count ||
      value.accepted_versions.length !== value.total_count
    )
      ctx.addIssue({ code: "custom", message: "inconsistent capture receipt" });
  });
export const deletedSchema = z.strictObject({
  deleted_count: z.number().int().nonnegative(),
});
export const atomicSearchSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id,
        version: z.union([z.string(), z.number()]),
        type: z.string().max(80),
        content: z.string().max(8192),
        score: z.number().finite().optional(),
        team_id: id.optional(),
        agent_id: id.optional(),
        user_id: id.optional(),
        task_id: id.optional(),
      }),
    )
    .max(100),
});
export const healthSchema = z.strictObject({
  status: z.enum(["ok", "degraded"]),
  version: z.string().max(80),
  uptime: z.number().nonnegative(),
  stores: z.strictObject({
    vectorStore: z.boolean(),
    embeddingService: z.boolean(),
    ftsAvailable: z.boolean(),
  }),
  // These metrics are diagnostics, never interpreted as authorization or memory.
  services: z.record(z.string(), z.unknown()),
});
const envelopeSchema = z.strictObject({
  code: z.number().int(),
  message: z.string().max(4000),
  request_id: id,
  data: z.unknown().optional(),
});

export class ExperimentError extends Error {
  readonly code: "endpoint" | "transport" | "protocol" | "limit" | "remote";
  readonly remoteCode: number | undefined;
  constructor(code: ExperimentError["code"], remoteCode?: number) {
    super(`D3 ${code}`);
    this.name = "ExperimentError";
    this.code = code;
    this.remoteCode = remoteCode;
  }
}

export function localEndpoint(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ExperimentError("endpoint");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ExperimentError("endpoint");
  return url;
}

const paths = [
  "/health",
  "/v3/conversation/add",
  "/v3/conversation/query",
  "/v3/conversation/search",
  "/v3/conversation/delete",
  "/v3/atomic/search",
  "/v3/atomic/query",
] as const;
type Path = (typeof paths)[number];

export class CoreClient {
  readonly #url: URL;
  readonly #key: string;
  readonly #instance: string;
  readonly #timeout: number;
  readonly #maxBytes: number;
  readonly metrics = { requests: 0, bytes: 0, latenciesMs: [] as number[] };
  constructor(
    endpoint: string,
    key: string,
    instance: string,
    timeout = 3000,
    maxBytes = 262144,
  ) {
    this.#url = localEndpoint(endpoint);
    if (
      !key ||
      !/^d3-[a-z0-9-]+$/.test(instance) ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 30000 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 1048576
    )
      throw new ExperimentError("endpoint");
    this.#key = key;
    this.#instance = instance;
    this.#timeout = timeout;
    this.#maxBytes = maxBytes;
  }

  /** Single attempt only: capture timeout is an unknown outcome, never retried. */
  async request<T>(
    path: Path,
    schema: z.ZodType<T>,
    body?: unknown,
    userKey?: string,
    requestId?: string,
  ): Promise<T> {
    if (!paths.includes(path)) throw new ExperimentError("endpoint");
    const start = performance.now();
    this.metrics.requests++;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#key}`,
      "x-tdai-service-id": this.#instance,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (userKey !== undefined) headers["x-tdai-user-key"] = userKey;
    if (requestId !== undefined) headers["x-request-id"] = requestId;
    try {
      const response = await fetch(new URL(path, this.#url), {
        method: body === undefined ? "GET" : "POST",
        headers,
        redirect: "error",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeout),
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new ExperimentError("protocol");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          this.metrics.bytes += part.value.byteLength;
          if (size > this.#maxBytes) throw new ExperimentError("limit");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        throw new ExperimentError("protocol");
      }
      if (path !== "/health") {
        const envelope = envelopeSchema.safeParse(value);
        if (!envelope.success) throw new ExperimentError("protocol");
        if (envelope.data.code !== 0 || !response.ok)
          throw new ExperimentError("remote", envelope.data.code);
        value = envelope.data.data;
      } else if (!response.ok)
        throw new ExperimentError("remote", response.status);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ExperimentError("protocol");
      return parsed.data;
    } catch (error) {
      if (error instanceof ExperimentError) throw error;
      throw new ExperimentError("transport");
    } finally {
      this.metrics.latenciesMs.push(performance.now() - start);
    }
  }

  add(scope: Scope, session: string, content: string, requestId?: string) {
    scopeSchema.parse(scope);
    id.parse(session);
    z.string().min(1).max(8192).parse(content);
    return this.request(
      "/v3/conversation/add",
      addedSchema,
      { ...scope, session_id: session, messages: [{ role: "user", content }] },
      undefined,
      requestId,
    );
  }
  search(scope: Scope, query: string, session?: string) {
    scopeSchema.parse(scope);
    z.string().min(1).max(2048).parse(query);
    return this.request("/v3/conversation/search", searchSchema, {
      ...scope,
      query,
      limit: 20,
      ...(session === undefined ? {} : { session_id: session }),
    });
  }
  query(scope: Scope, session?: string) {
    scopeSchema.parse(scope);
    return this.request("/v3/conversation/query", querySchema, {
      ...scope,
      ...(session === undefined ? {} : { session_id: session }),
      limit: 100,
    });
  }
  deleteMessages(scope: Scope, ids: readonly string[]) {
    scopeSchema.parse(scope);
    const messageIds = z.array(id).min(1).max(5000).parse(ids);
    return this.request("/v3/conversation/delete", deletedSchema, {
      ...scope,
      message_ids: messageIds,
    });
  }
  searchAtomic(scope: Scope, query: string) {
    scopeSchema.parse(scope);
    z.string().min(1).max(2048).parse(query);
    return this.request("/v3/atomic/search", atomicSearchSchema, {
      ...scope,
      query,
      limit: 20,
    });
  }
}
