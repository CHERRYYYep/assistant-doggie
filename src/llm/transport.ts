/** Sanitized, injectable HTTP transport for structured model calls. */

import { inspect } from "node:util";

export const DEFAULT_LLM_HTTP_TIMEOUT_MS = 30_000;
export const MAX_LLM_HTTP_TIMEOUT_MS = 2_147_483_647;

export type LlmHttpRequest = {
  readonly url: string;
  readonly body: unknown;
};

export type LlmHttpResponse = {
  readonly body: unknown;
};

export type LlmTransportErrorKind = "request" | "http_status";

export class LlmTransportError extends Error {
  readonly kind: LlmTransportErrorKind;
  readonly status: number | undefined;

  private constructor(
    kind: LlmTransportErrorKind,
    message: string,
    status?: number | undefined,
  ) {
    super(message);
    this.name = "LlmTransportError";
    this.kind = kind;
    this.status = status;
  }

  static request(): LlmTransportError {
    return new LlmTransportError("request", "LLM HTTP request failed");
  }

  static httpStatus(status: number): LlmTransportError {
    return new LlmTransportError(
      "http_status",
      `HTTP ${status}: LLM endpoint returned an HTTP error`,
      status,
    );
  }

  get retryable(): boolean {
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
  send(request: LlmHttpRequest): Promise<LlmHttpResponse>;
}

export type LlmHttpTransportConfig = {
  readonly timeoutMs?: number | undefined;
  /** Optional process-level cancellation. Request-level cancellation is T12. */
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref();
    const signal =
      this.#signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, this.#signal]);

    try {
      if (signal.aborted) throw LlmTransportError.request();
      const response = await this.#fetch(request.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request.body),
        signal,
      });
      if (!response.ok) {
        throw LlmTransportError.httpStatus(response.status);
      }

      try {
        return { body: await response.json() };
      } catch {
        throw LlmTransportError.request();
      }
    } catch (error: unknown) {
      if (error instanceof LlmTransportError) throw error;
      throw LlmTransportError.request();
    } finally {
      clearTimeout(timeout);
    }
  }
}
