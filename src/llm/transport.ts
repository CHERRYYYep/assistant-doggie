/** Sanitized, injectable HTTP transport for structured model calls. */

import { inspect } from "node:util";

import { abortError, isAbortError, throwIfAborted } from "./cancellation.ts";
import { parseRetryAfter, type RetryAfterDelay } from "./retry-policy.ts";

export const DEFAULT_LLM_HTTP_TIMEOUT_MS = 30_000;
export const MAX_LLM_HTTP_TIMEOUT_MS = 2_147_483_647;
export const MAX_LLM_RESPONSE_BYTES = 1_048_576;

export type LlmHttpRequest = {
  readonly url: string;
  readonly body: unknown;
  readonly signal?: AbortSignal | undefined;
};

export type LlmHttpResponse = {
  readonly body: unknown;
};

export type LlmTransportErrorKind =
  "request" | "http_status" | "response_too_large";

export class LlmTransportError extends Error {
  readonly kind: LlmTransportErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: RetryAfterDelay | undefined;

  private constructor(
    kind: LlmTransportErrorKind,
    message: string,
    status?: number | undefined,
    retryAfterMs?: RetryAfterDelay,
  ) {
    super(message);
    this.name = "LlmTransportError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  static request(): LlmTransportError {
    return new LlmTransportError("request", "LLM HTTP request failed");
  }

  static httpStatus(
    status: number,
    retryAfterMs?: RetryAfterDelay,
  ): LlmTransportError {
    return new LlmTransportError(
      "http_status",
      `HTTP ${status}: LLM endpoint returned an HTTP error`,
      status,
      retryAfterMs,
    );
  }

  static responseTooLarge(): LlmTransportError {
    return new LlmTransportError(
      "response_too_large",
      "LLM response exceeded the configured size limit",
    );
  }

  get retryable(): boolean {
    if (this.kind === "response_too_large") return false;
    if (this.status === undefined) return true;
    return (
      this.status === 408 ||
      this.status === 409 ||
      this.status === 429 ||
      (this.status >= 500 && this.status <= 599)
    );
  }
}

export interface StructuredOutputTransport {
  /** Process cancellation must also stop any adapter wait between sends. */
  readonly processSignal?: AbortSignal | undefined;
  send(request: LlmHttpRequest): Promise<LlmHttpResponse>;
}

export type LlmHttpTransportConfig = {
  readonly timeoutMs?: number | undefined;
  /** Optional process-level cancellation, combined with each request signal. */
  readonly signal?: AbortSignal | undefined;
};

export class LlmTransportConfigurationError extends Error {
  readonly kind: "missing_api_key" | "invalid_timeout";

  constructor(kind: "missing_api_key" | "invalid_timeout", message: string) {
    super(message);
    this.name = "LlmTransportConfigurationError";
    this.kind = kind;
  }
}

/**
 * Fetch-backed transport. The API key is held in a JavaScript private field,
 * omitted from inspection, and never copied into an error message.
 */
export class FetchStructuredOutputTransport implements StructuredOutputTransport {
  readonly #timeoutMs: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #signal: AbortSignal | undefined;

  constructor(
    apiKey: string,
    config: LlmHttpTransportConfig = {},
    fetchImplementation: typeof fetch = fetch,
  ) {
    const cleanedApiKey = apiKey.trim();
    if (cleanedApiKey === "") {
      throw new LlmTransportConfigurationError(
        "missing_api_key",
        "OPENAI_API_KEY is not configured",
      );
    }

    const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_HTTP_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_LLM_HTTP_TIMEOUT_MS
    ) {
      throw new LlmTransportConfigurationError(
        "invalid_timeout",
        `LLM HTTP timeout must be an integer between 1 and ${MAX_LLM_HTTP_TIMEOUT_MS} milliseconds`,
      );
    }

    this.#apiKey = cleanedApiKey;
    this.#fetch = fetchImplementation;
    this.#timeoutMs = timeoutMs;
    this.#signal = config.signal;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  get processSignal(): AbortSignal | undefined {
    return this.#signal;
  }

  static fromEnv(
    config: LlmHttpTransportConfig = {},
    environment: NodeJS.ProcessEnv = process.env,
    fetchImplementation: typeof fetch = fetch,
  ): FetchStructuredOutputTransport {
    return new FetchStructuredOutputTransport(
      environment["OPENAI_API_KEY"] ?? "",
      config,
      fetchImplementation,
    );
  }

  [inspect.custom](): string {
    return `FetchStructuredOutputTransport { apiKey: '<redacted>', timeoutMs: ${this.#timeoutMs} }`;
  }

  async send(request: LlmHttpRequest): Promise<LlmHttpResponse> {
    throwIfAborted(request.signal);
    throwIfAborted(this.#signal);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref();
    const signals = [controller.signal];
    if (this.#signal !== undefined) signals.push(this.#signal);
    if (request.signal !== undefined) signals.push(request.signal);
    const signal = AbortSignal.any(signals);
    const checkCancellation = (): void => {
      throwIfAborted(request.signal);
      throwIfAborted(this.#signal);
      // A timeout remains a retryable transport failure, not request cancellation.
      if (controller.signal.aborted) throw LlmTransportError.request();
    };

    let response: Response | undefined;
    try {
      checkCancellation();
      response = await this.#fetch(request.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request.body),
        signal,
      });
      checkCancellation();
      if (!response.ok) {
        throw LlmTransportError.httpStatus(
          response.status,
          parseRetryAfter(response.headers.get("retry-after"), Date.now()),
        );
      }

      const body = await readJsonBody(response, signal, checkCancellation);
      checkCancellation();
      return { body };
    } catch (error: unknown) {
      checkCancellation();
      if (isAbortError(error)) throw abortError();
      if (error instanceof LlmTransportError) throw error;
      throw LlmTransportError.request();
    } finally {
      clearTimeout(timeout);
      // Rejected headers, status errors and cancellation before reader ownership
      // must also terminate the response without reading its error body.
      const body = response?.body;
      if (body != null && response?.bodyUsed === false && !body.locked)
        void body.cancel().catch(() => undefined);
    }
  }
}

async function readJsonBody(
  response: Response,
  signal: AbortSignal,
  checkCancellation: () => void,
): Promise<unknown> {
  const declared = response.headers.get("content-length")?.trim();
  if (
    declared !== undefined &&
    /^\d+$/u.test(declared) &&
    Number(declared) > MAX_LLM_RESPONSE_BYTES
  )
    throw LlmTransportError.responseTooLarge();
  const body = response.body;
  if (body === null) throw LlmTransportError.request();

  // Retained bytes never grow with the number of chunks. Check the remaining
  // capacity before copying: the delivered chunk itself belongs to fetch.
  const buffer = new Uint8Array(MAX_LLM_RESPONSE_BYTES);
  const reader = body.getReader();
  let received = 0;
  let ended = false;
  const cancelReader = (): void => {
    // Do not let an upstream cancel hook that rejects or never settles replace
    // the primary failure or delay caller/endpoint cancellation.
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    for (;;) {
      checkCancellation();
      const next = await reader.read();
      checkCancellation();
      if (next.done) {
        ended = true;
        break;
      }
      if (next.value.byteLength > MAX_LLM_RESPONSE_BYTES - received)
        throw LlmTransportError.responseTooLarge();
      buffer.set(next.value, received);
      received += next.value.byteLength;
    }
    checkCancellation();
    const result: unknown = JSON.parse(
      new TextDecoder().decode(buffer.subarray(0, received)),
    );
    checkCancellation();
    return result;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    if (!ended) cancelReader();
    reader.releaseLock();
  }
}
