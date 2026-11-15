/** Per-batch hard request cap. Does not load credentials or run a model on import. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  StructuredOutputTransport,
  LlmHttpRequest,
  LlmHttpResponse,
} from "../../src/llm/transport.ts";
import { LlmTransportError } from "../../src/llm/transport.ts";

export class ModelBudgetError extends Error {
  constructor() {
    super("D3 model budget or request boundary rejected");
  }
}
export type ModelCall = {
  readonly ordinal: number;
  readonly label: string;
  readonly requestSha256: string;
  readonly systemSha256: string;
  readonly maxOutputTokens: number;
  outcome: "in_flight" | "ok" | "transport_error";
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
};
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
});
const envelopeSchema = z.object({ usage: usageSchema.optional() });
const bodySchema = z.looseObject({
  model: z.string(),
  stream: z.boolean().optional(),
});
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ModelBudget implements StructuredOutputTransport {
  readonly #inner: StructuredOutputTransport;
  readonly #url: string;
  readonly #model: string;
  readonly #limit: number;
  readonly #calls: ModelCall[] = [];
  #label = "";
  #busy = false;
  #closed = false;
  constructor(
    inner: StructuredOutputTransport,
    url: string,
    model: string,
    limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new ModelBudgetError();
    this.#inner = inner;
    this.#url = url;
    this.#model = model;
    this.#limit = limit;
  }
  setLabel(label: string): void {
    if (this.#busy || !/^(tencent|doggie)-l1-case-\d{2}-[0-2]$/.test(label))
      throw new ModelBudgetError();
    this.#label = label;
  }
  get calls(): readonly Readonly<ModelCall>[] {
    return this.#calls.map((call) => ({ ...call }));
  }
  close(): void {
    this.#closed = true;
  }
  async send(request: LlmHttpRequest): Promise<LlmHttpResponse> {
    const parsed = bodySchema.safeParse(request.body);
    if (
      this.#closed ||
      this.#busy ||
      this.#calls.length >= this.#limit ||
      this.#label === "" ||
      request.url !== this.#url ||
      !parsed.success ||
      parsed.data.model !== this.#model ||
      parsed.data.stream === true
    )
      throw new ModelBudgetError();
    const raw = JSON.stringify(request.body);
    if (Buffer.byteLength(raw) > 131072) throw new ModelBudgetError();
    const body: Record<string, unknown> = { ...parsed.data };
    // Regardless of caller defaults, bound generation at the only upstream gate.
    const isResponses = new URL(request.url).pathname.endsWith("/responses");
    const outputField = isResponses
      ? "max_output_tokens"
      : "max_completion_tokens";
    delete body["max_tokens"];
    body[outputField] = 4096;
    if (isResponses) body["store"] = false;
    const system =
      typeof body["instructions"] === "string"
        ? body["instructions"]
        : JSON.stringify(body["input"] ?? body["messages"]);
    const call: ModelCall = {
      ordinal: this.#calls.length + 1,
      label: this.#label,
      requestSha256: digest(JSON.stringify(body)),
      systemSha256: digest(system),
      maxOutputTokens: 4096,
      outcome: "in_flight",
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
    };
    // Consume synchronously before the await, including timeouts and failures.
    this.#calls.push(call);
    this.#busy = true;
    const start = performance.now();
    try {
      const response = await this.#inner.send({ ...request, body });
      const parsedUsage = envelopeSchema.safeParse(response.body);
      const usage = parsedUsage.success ? parsedUsage.data.usage : undefined;
      call.inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? null;
      call.outputTokens =
        usage?.output_tokens ?? usage?.completion_tokens ?? null;
      call.outcome = "ok";
      return response;
    } catch (error) {
      call.outcome = "transport_error";
      // A failed batch cannot be restarted in-process or silently retried.
      this.#closed = true;
      if (error instanceof LlmTransportError) throw error;
      throw new ModelBudgetError();
    } finally {
      call.latencyMs = performance.now() - start;
      this.#busy = false;
    }
  }
}

/** Strip redirects and bound bytes before transport.response.json() allocates. */
export function boundedModelFetch(
  upstream: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await upstream(input, { ...init, redirect: "error" });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new ModelBudgetError();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 1048576) throw new ModelBudgetError();
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}
