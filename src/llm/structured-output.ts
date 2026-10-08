/** Transport-independent strict structured-output calls with bounded retries. */

import { abortError, isAbortError, throwIfAborted } from "./cancellation.ts";
import type { LlmEndpointConfig } from "./config.ts";
import { LlmApiMode, resolveLlmEndpoint } from "./config.ts";
import type { StructuredOutputContract } from "./contracts.ts";
import type { LlmHttpRequest, StructuredOutputTransport } from "./transport.ts";
import { LlmTransportError } from "./transport.ts";
import {
  parseWireResponse,
  WireResponseError,
  type WireResponseErrorKind,
} from "./wire-response.ts";

export type LlmErrorKind =
  | "empty_model"
  | "empty_system_prompt"
  | "empty_user_prompt"
  | "invalid_max_retries"
  | "transport"
  | "unexpected_status"
  | "incomplete"
  | "refusal"
  | "content_filter"
  | "missing_output"
  | "invalid_tool_call"
  | "invalid_json"
  | "invalid_response"
  | "contract"
  | "attempts_exhausted";

/**
 * Stable, sanitized failure returned by the structured-output boundary.
 *
 * `lastError` deliberately contains only another `LlmError`; arbitrary
 * transport, JSON, and validation exceptions never become part of this
 * public error or its message.
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly attempts: number | undefined;
  readonly lastError: LlmError | undefined;

  private constructor(
    kind: LlmErrorKind,
    message: string,
    retryable: boolean,
    attempts?: number | undefined,
    lastError?: LlmError | undefined,
  ) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.retryable = retryable;
    this.attempts = attempts;
    this.lastError = lastError;
  }

  static requestValidation(
    kind:
      | "empty_model"
      | "empty_system_prompt"
      | "empty_user_prompt"
      | "invalid_max_retries",
    message: string,
  ): LlmError {
    return new LlmError(kind, message, false);
  }

  static transport(error: LlmTransportError): LlmError {
    return new LlmError("transport", "LLM transport failed", error.retryable);
  }

  static response(
    kind: Exclude<
      LlmErrorKind,
      | "empty_model"
      | "empty_system_prompt"
      | "empty_user_prompt"
      | "invalid_max_retries"
      | "transport"
      | "attempts_exhausted"
    >,
    message: string,
    retryable: boolean,
  ): LlmError {
    return new LlmError(kind, message, retryable);
  }

  static attemptsExhausted(attempts: number, lastError: LlmError): LlmError {
    return new LlmError(
      "attempts_exhausted",
      `structured model call failed after ${attempts} attempt(s)`,
      false,
      attempts,
      lastError,
    );
  }
}

export type StructuredOutputInput<T> = {
  readonly contract: StructuredOutputContract<T>;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxRetries: number;
  readonly signal?: AbortSignal | undefined;
};

export class StructuredOutputAdapter {
  readonly #endpoint: LlmEndpointConfig;
  readonly #transport: StructuredOutputTransport;

  constructor(
    endpoint: LlmEndpointConfig,
    transport: StructuredOutputTransport,
  ) {
    // Re-resolve even a structurally forged or later-mutated object. TypeScript
    // `readonly` is not a runtime security boundary, while this adapter will
    // eventually hand a bearer token to its transport.
    this.#endpoint = resolveLlmEndpoint({
      site: endpoint.site,
      baseUrl: endpoint.baseUrl,
      apiMode: endpoint.apiMode,
    });
    this.#transport = transport;
  }

  get endpoint(): LlmEndpointConfig {
    return this.#endpoint;
  }

  get transport(): StructuredOutputTransport {
    return this.#transport;
  }

  /** Parse one strict contract with bounded retries and no model fallback. */
  async parse<T>(
    contract: StructuredOutputContract<T>,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxRetries: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.generate({
      contract,
      model,
      systemPrompt,
      userPrompt,
      maxRetries,
      signal,
    });
  }

  async generate<T>(input: StructuredOutputInput<T>): Promise<T> {
    const { contract, model, systemPrompt, userPrompt, maxRetries, signal } =
      input;
    throwIfAborted(signal);
    const cleanedModel = model.trim();
    if (cleanedModel === "") {
      throw LlmError.requestValidation(
        "empty_model",
        "model must not be empty",
      );
    }
    if (systemPrompt.trim() === "") {
      throw LlmError.requestValidation(
        "empty_system_prompt",
        "systemPrompt must not be empty",
      );
    }
    if (userPrompt.trim() === "") {
      throw LlmError.requestValidation(
        "empty_user_prompt",
        "userPrompt must not be empty",
      );
    }
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
      throw LlmError.requestValidation(
        "invalid_max_retries",
        "maxRetries must be a non-negative safe integer",
      );
    }

    const request = requestForContract(
      this.#endpoint,
      contract,
      cleanedModel,
      systemPrompt,
      userPrompt,
      signal,
    );

    for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
      const attempt = attemptIndex + 1;
      try {
        throwIfAborted(signal);
        const response = await this.#transport.send(request);
        throwIfAborted(signal);
        const result = parseStructuredResponse(
          this.#endpoint.apiMode,
          contract,
          response.body,
        );
        throwIfAborted(signal);
        return result;
      } catch (error: unknown) {
        throwIfAborted(signal);
        if (isAbortError(error)) throw abortError();
        const normalized = normalizeAttemptError(error);
        if (attemptIndex < maxRetries && normalized.retryable) continue;
        throw LlmError.attemptsExhausted(attempt, normalized);
      }
    }

    throw new Error("bounded retry loop must return or throw");
  }
}

function requestForContract<T>(
  endpoint: LlmEndpointConfig,
  contract: StructuredOutputContract<T>,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): LlmHttpRequest {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const jsonSchema = {
    name: contract.schemaName,
    strict: true,
    schema: contract.strictJsonSchema,
  };
  const body =
    endpoint.apiMode === LlmApiMode.Responses
      ? {
          model,
          input: messages,
          text: { format: { type: "json_schema", ...jsonSchema } },
        }
      : {
          model,
          messages,
          response_format: {
            type: "json_schema",
            json_schema: jsonSchema,
          },
        };
  return {
    url: endpoint.requestUrl,
    body,
    ...(signal === undefined ? {} : { signal }),
  };
}

function parseStructuredResponse<T>(
  mode: LlmApiMode,
  contract: StructuredOutputContract<T>,
  body: unknown,
): T {
  let wire;
  try {
    wire = parseWireResponse(mode, body);
  } catch (error: unknown) {
    if (error instanceof WireResponseError) throw mapWireError(error);
    throw LlmError.response(
      "invalid_response",
      "model response had an invalid wire shape",
      true,
    );
  }

  if (wire.kind === "tool_calls") {
    throw LlmError.response(
      "invalid_tool_call",
      "tool calls are not valid structured output",
      false,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(wire.text) as unknown;
  } catch {
    throw LlmError.response(
      "invalid_json",
      "structured output was not valid JSON",
      true,
    );
  }

  try {
    return contract.parse(value);
  } catch {
    throw LlmError.response(
      "contract",
      "structured output violated the contract",
      true,
    );
  }
}

function normalizeAttemptError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof LlmTransportError) return LlmError.transport(error);
  return LlmError.transport(LlmTransportError.request());
}

function mapWireError(error: WireResponseError): LlmError {
  const kind = mapWireErrorKind(error.kind);
  const messages: Record<typeof kind, string> = {
    unexpected_status: "model response had an unexpected status",
    incomplete: "model response was incomplete",
    refusal: "model refused the request",
    content_filter: "model response was blocked by a content filter",
    missing_output: "model response did not contain structured output",
    invalid_tool_call: "model response contained an invalid tool call",
    invalid_response: "model response had an invalid wire shape",
  };
  return LlmError.response(kind, messages[kind], error.retryable);
}

function mapWireErrorKind(
  kind: WireResponseErrorKind,
):
  | "unexpected_status"
  | "incomplete"
  | "refusal"
  | "content_filter"
  | "missing_output"
  | "invalid_tool_call"
  | "invalid_response" {
  switch (kind) {
    case "unexpected_status":
      return "unexpected_status";
    case "incomplete":
      return "incomplete";
    case "refusal":
      return "refusal";
    case "content_filter":
      return "content_filter";
    case "missing_response":
    case "missing_output":
      return "missing_output";
    case "invalid_tool_call":
      return "invalid_tool_call";
    case "invalid_response":
      return "invalid_response";
  }
}
