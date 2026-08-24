/** Normalize Responses and Chat Completions payloads into one small boundary. */

import { LlmApiMode } from "./config.ts";

export type WireToolCall = {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
};

export type WireResponse =
  | { readonly kind: "final_text"; readonly text: string }
  | {
      readonly kind: "tool_calls";
      readonly calls: readonly WireToolCall[];
      readonly continuation: readonly unknown[];
    };

export type WireResponseErrorKind =
  | "invalid_response"
  | "unexpected_status"
  | "incomplete"
  | "refusal"
  | "content_filter"
  | "missing_response"
  | "missing_output"
  | "invalid_tool_call";

export class WireResponseError extends Error {
  readonly kind: WireResponseErrorKind;
  readonly detail: string | undefined;

  constructor(
    kind: WireResponseErrorKind,
    message: string,
    detail?: string | undefined,
  ) {
    super(message);
    this.name = "WireResponseError";
    this.kind = kind;
    this.detail = detail;
  }

  get retryable(): boolean {
    return (
      this.kind === "invalid_response" ||
      this.kind === "incomplete" ||
      this.kind === "missing_response" ||
      this.kind === "missing_output"
    );
  }
}

export function parseWireResponse(
  mode: LlmApiMode,
  body: unknown,
): WireResponse {
  return mode === LlmApiMode.Responses
    ? parseResponses(body)
    : parseChatCompletions(body);
}

function parseResponses(body: unknown): WireResponse {
  const envelope = requiredObject(body);
  const status = optionalNullableString(envelope, "status");
  if (status !== undefined && status !== "completed") {
    if (status === "incomplete") {
      const incompleteDetails = optionalNullableObject(
        envelope,
        "incomplete_details",
      );
      const reason =
        incompleteDetails === undefined
          ? "unknown"
          : (optionalNullableString(incompleteDetails, "reason") ?? "unknown");
      if (reason.toLowerCase() === "content_filter") {
        throw new WireResponseError(
          "content_filter",
          "model response blocked by content filter",
        );
      }
      throw new WireResponseError(
        "incomplete",
        `model response incomplete: ${reason}`,
        reason,
      );
    }
    if (["failed", "cancelled", "queued", "in_progress"].includes(status)) {
      throw new WireResponseError(
        "unexpected_status",
        `model response had unexpected status: ${status}`,
        status,
      );
    }
    throw invalidResponse(`unknown Responses status: ${status}`);
  }

  const output = optionalArray(envelope, "output") ?? [];
  if (output.length === 0) {
    throw new WireResponseError(
      "missing_output",
      "model response did not contain structured output",
    );
  }

  const calls: WireToolCall[] = [];
  let firstText: string | undefined;
  let finalAnswerText: string | undefined;
  const continuation: unknown[] = [];

  for (const rawItem of output) {
    const item = requiredObject(rawItem);
    const type = requiredString(item, "type");
    continuation.push(structuredClone(rawItem));

    if (type === "function_call") {
      calls.push({
        callId: requiredNonEmpty(
          requiredString(item, "call_id"),
          "Responses function call id",
        ),
        name: requiredNonEmpty(
          requiredString(item, "name"),
          "Responses function call name",
        ),
        arguments: requiredString(item, "arguments"),
      });
      continue;
    }

    if (type === "message") {
      const phase = optionalNullableString(item, "phase");
      if (
        phase !== undefined &&
        phase !== "final_answer" &&
        phase !== "commentary"
      ) {
        throw invalidResponse(`unknown Responses message phase: ${phase}`);
      }
      const content = optionalArray(item, "content") ?? [];
      for (const rawContent of content) {
        const contentItem = requiredObject(rawContent);
        const contentType = requiredString(contentItem, "type");
        if (contentType === "refusal") {
          const refusal = requiredString(contentItem, "refusal");
          const message = refusal === "" ? "request refused" : refusal;
          throw new WireResponseError(
            "refusal",
            `model refused request: ${message}`,
            message,
          );
        }
        if (contentType !== "output_text") {
          throw invalidResponse(
            `unknown Responses message content type: ${contentType}`,
          );
        }

        const text = requiredString(contentItem, "text");
        if (text.trim() === "") continue;
        if (phase === "final_answer") {
          finalAnswerText ??= text;
        } else {
          firstText ??= text;
        }
      }
      continue;
    }

    if (!KNOWN_NON_MESSAGE_OUTPUT_TYPES.has(type)) {
      throw invalidResponse(`unknown Responses output type: ${type}`);
    }
  }

  if (calls.length > 0) {
    return { kind: "tool_calls", calls, continuation };
  }
  const text = finalAnswerText ?? firstText;
  if (text !== undefined) return { kind: "final_text", text };
  throw new WireResponseError(
    "missing_output",
    "model response did not contain structured output",
  );
}

const KNOWN_NON_MESSAGE_OUTPUT_TYPES = new Set([
  "reasoning",
  "file_search_call",
  "web_search_call",
  "computer_call",
  "image_generation_call",
  "code_interpreter_call",
  "local_shell_call",
  "shell_call",
  "custom_tool_call",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
]);

function parseChatCompletions(body: unknown): WireResponse {
  const envelope = requiredObject(body);
  const choices = optionalArray(envelope, "choices") ?? [];
  const rawChoice = choices[0];
  if (rawChoice === undefined) {
    throw new WireResponseError(
      "missing_response",
      "model response did not contain a choice",
    );
  }

  const choice = requiredObject(rawChoice);
  const finishReason = optionalNullableString(choice, "finish_reason");
  if (
    finishReason !== undefined &&
    ![
      "stop",
      "length",
      "tool_calls",
      "content_filter",
      "function_call",
    ].includes(finishReason)
  ) {
    throw invalidResponse(
      `unknown Chat Completions finish reason: ${finishReason}`,
    );
  }
  if (finishReason === "length") {
    throw new WireResponseError(
      "incomplete",
      "model response incomplete: length",
      "length",
    );
  }
  if (finishReason === "content_filter") {
    throw new WireResponseError(
      "content_filter",
      "model response blocked by content filter",
    );
  }

  const message = requiredObject(choice["message"]);
  const refusal = optionalNullableString(message, "refusal");
  if (refusal !== undefined && refusal !== "") {
    throw new WireResponseError(
      "refusal",
      `model refused request: ${refusal}`,
      refusal,
    );
  }

  const calls: WireToolCall[] = [];
  const toolCalls = optionalNullableArray(message, "tool_calls");
  for (const rawToolCall of toolCalls ?? []) {
    const toolCall = requiredObject(rawToolCall);
    const type = requiredString(toolCall, "type");
    if (type === "custom") {
      throw new WireResponseError(
        "invalid_tool_call",
        "model response contained an invalid tool call: custom tool calls are not registered by this Harness",
        "custom tool calls are not registered by this Harness",
      );
    }
    if (type !== "function") {
      throw invalidResponse(`unknown Chat Completions tool call type: ${type}`);
    }
    const fn = requiredObject(toolCall["function"]);
    calls.push({
      callId: requiredNonEmpty(
        requiredString(toolCall, "id"),
        "Chat Completions function call id",
      ),
      name: requiredNonEmpty(
        requiredString(fn, "name"),
        "Chat Completions function name",
      ),
      arguments: requiredString(fn, "arguments"),
    });
  }

  if (calls.length > 0) {
    return {
      kind: "tool_calls",
      calls,
      continuation: [structuredClone(message)],
    };
  }

  if (
    message["function_call"] !== undefined &&
    message["function_call"] !== null
  ) {
    throw new WireResponseError(
      "invalid_tool_call",
      "model response contained an invalid tool call: legacy Chat Completions function_call is unsupported; use tool_calls",
      "legacy Chat Completions function_call is unsupported; use tool_calls",
    );
  }

  const content = optionalNullableString(message, "content")?.trim();
  if (content === undefined || content === "") {
    throw new WireResponseError(
      "missing_output",
      "model response did not contain structured output",
    );
  }
  return { kind: "final_text", text: content };
}

function invalidResponse(detail: string): WireResponseError {
  return new WireResponseError(
    "invalid_response",
    "model response had an invalid wire shape",
    detail,
  );
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse("expected an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  object: Record<string, unknown>,
  field: string,
): string {
  const value = object[field];
  if (typeof value !== "string") {
    throw invalidResponse(`${field} must be a string`);
  }
  return value;
}

function optionalNullableString(
  object: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = object[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw invalidResponse(`${field} must be a string or null`);
  }
  return value;
}

function optionalArray(
  object: Record<string, unknown>,
  field: string,
): unknown[] | undefined {
  const value = object[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidResponse(`${field} must be an array`);
  return value;
}

function optionalNullableArray(
  object: Record<string, unknown>,
  field: string,
): unknown[] | undefined {
  const value = object[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value))
    throw invalidResponse(`${field} must be an array or null`);
  return value;
}

function optionalNullableObject(
  object: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = object[field];
  if (value === undefined || value === null) return undefined;
  return requiredObject(value);
}

function requiredNonEmpty(value: string, description: string): string {
  const cleaned = value.trim();
  if (cleaned === "") {
    throw new WireResponseError(
      "invalid_tool_call",
      `model response contained an invalid tool call: ${description} is missing`,
      `${description} is missing`,
    );
  }
  return cleaned;
}
