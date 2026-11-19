import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LlmApiMode,
  LlmConfigurationError,
  type LlmEndpointConfig,
  resolveLlmEndpoint,
} from "./config.ts";
import { bucketSummaryContract } from "./contracts.ts";
import { LlmError, StructuredOutputAdapter } from "./structured-output.ts";
import type {
  LlmHttpRequest,
  LlmHttpResponse,
  StructuredOutputTransport,
} from "./transport.ts";
import {
  FetchStructuredOutputTransport,
  LlmTransportError,
  MAX_LLM_RESPONSE_BYTES,
} from "./transport.ts";

class FakeTransport implements StructuredOutputTransport {
  readonly requests: LlmHttpRequest[] = [];
  readonly #results: Array<LlmHttpResponse | Error>;

  constructor(results: Iterable<LlmHttpResponse | Error> = []) {
    this.#results = [...results];
  }

  async send(request: LlmHttpRequest): Promise<LlmHttpResponse> {
    this.requests.push(structuredClone(request));
    const result = this.#results.shift();
    if (result === undefined) throw new Error("fake transport queue exhausted");
    if (result instanceof Error) throw result;
    return result;
  }
}

function responsesText(text: string): LlmHttpResponse {
  return {
    body: {
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text }],
        },
      ],
    },
  };
}

function chatText(text: string): LlmHttpResponse {
  return {
    body: {
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: text, refusal: null },
        },
      ],
    },
  };
}

async function expectAttemptError(
  promise: Promise<unknown>,
  expected: {
    attempts: number;
    kind: LlmError["kind"];
    retryable?: boolean | undefined;
  },
): Promise<LlmError> {
  try {
    await promise;
  } catch (error: unknown) {
    assert.ok(error instanceof LlmError);
    assert.equal(error.kind, "attempts_exhausted");
    assert.equal(error.attempts, expected.attempts);
    assert.ok(error.lastError);
    assert.equal(error.lastError.kind, expected.kind);
    if (expected.retryable !== undefined) {
      assert.equal(error.lastError.retryable, expected.retryable);
    }
    return error;
  }
  assert.fail("expected structured output call to fail");
}

test("Responses requests strict JSON Schema and preserve prompt whitespace", async () => {
  const endpoint = resolveLlmEndpoint({});
  const transport = new FakeTransport([
    responsesText('{"summary":"  rolling summary  "}'),
  ]);
  const adapter = new StructuredOutputAdapter(endpoint, transport);

  assert.deepEqual(
    await adapter.parse(
      bucketSummaryContract,
      "  gpt-fixture  ",
      " system prompt\n",
      "\tuser prompt ",
      0,
    ),
    { summary: "rolling summary" },
  );
  assert.deepEqual(transport.requests, [
    {
      url: "https://api.openai.com/v1/responses",
      body: {
        model: "gpt-fixture",
        input: [
          { role: "system", content: " system prompt\n" },
          { role: "user", content: "\tuser prompt " },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "BucketSummaryResult",
            strict: true,
            schema: bucketSummaryContract.strictJsonSchema,
          },
        },
      },
    },
  ]);
});

test("Chat Completions requests the equivalent strict JSON Schema shape", async () => {
  const endpoint = resolveLlmEndpoint({
    site: "relay",
    baseUrl: "https://relay.example/v1",
    apiMode: "chat",
  });
  const transport = new FakeTransport([chatText('{"summary":"chat summary"}')]);
  const adapter = new StructuredOutputAdapter(endpoint, transport);

  assert.deepEqual(
    await adapter.parse(
      bucketSummaryContract,
      " chat-model ",
      "system",
      "user",
      0,
    ),
    { summary: "chat summary" },
  );
  assert.deepEqual(transport.requests, [
    {
      url: "https://relay.example/v1/chat/completions",
      body: {
        model: "chat-model",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "user" },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "BucketSummaryResult",
            strict: true,
            schema: bucketSummaryContract.strictJsonSchema,
          },
        },
      },
    },
  ]);
});

test("invalid call configuration fails before the transport boundary", async () => {
  const transport = new FakeTransport();
  const adapter = new StructuredOutputAdapter(
    resolveLlmEndpoint({}),
    transport,
  );

  for (const [promise, kind] of [
    [
      adapter.parse(bucketSummaryContract, "  ", "system", "user", 0),
      "empty_model",
    ],
    [
      adapter.parse(bucketSummaryContract, "model", " \n ", "user", 0),
      "empty_system_prompt",
    ],
    [
      adapter.parse(bucketSummaryContract, "model", "system", " \t ", 0),
      "empty_user_prompt",
    ],
    [
      adapter.parse(bucketSummaryContract, "model", "system", "user", -1),
      "invalid_max_retries",
    ],
    [
      adapter.parse(bucketSummaryContract, "model", "system", "user", 0.5),
      "invalid_max_retries",
    ],
    [
      adapter.parse(
        bucketSummaryContract,
        "model",
        "system",
        "user",
        Number.NaN,
      ),
      "invalid_max_retries",
    ],
  ] as const) {
    await assert.rejects(
      promise,
      (error: unknown) =>
        error instanceof LlmError &&
        error.kind === kind &&
        error.attempts === undefined &&
        error.lastError === undefined,
    );
  }
  assert.deepEqual(transport.requests, []);
});

test("retryable response failures use the complete bounded retry budget", async () => {
  const transport = new FakeTransport([
    {
      body: { status: "incomplete", incomplete_details: { reason: "length" } },
    },
    responsesText("not json"),
    responsesText('{"summary":"ok","unknown":true}'),
    responsesText('{"summary":"success"}'),
  ]);
  const adapter = new StructuredOutputAdapter(
    resolveLlmEndpoint({}),
    transport,
  );

  assert.deepEqual(
    await adapter.parse(bucketSummaryContract, "model", "system", "user", 3),
    { summary: "success" },
  );
  assert.equal(transport.requests.length, 4);
  for (const request of transport.requests.slice(1)) {
    assert.deepEqual(request, transport.requests[0]);
  }
});

test("request failures and retryable HTTP statuses can recover", async () => {
  const transport = new FakeTransport([
    LlmTransportError.request(),
    LlmTransportError.httpStatus(500),
    LlmTransportError.httpStatus(429),
    responsesText('{"summary":"recovered"}'),
  ]);
  const adapter = new StructuredOutputAdapter(
    resolveLlmEndpoint({}),
    transport,
  );

  assert.deepEqual(
    await adapter.parse(bucketSummaryContract, "model", "system", "user", 3),
    { summary: "recovered" },
  );
  assert.equal(transport.requests.length, 4);
});

for (const [apiMode, envelope] of [
  [LlmApiMode.Responses, responsesText],
  [LlmApiMode.ChatCompletions, chatText],
] as const) {
  test(`${apiMode} uses ordinary fetch output and never retries an oversized body`, async () => {
    const json = JSON.stringify(envelope('{"summary":"bounded summary"}').body);
    let requests = 0;
    const transport = new FetchStructuredOutputTransport(
      "fixture-key",
      {},
      async () =>
        new Response(
          ++requests === 2 ? json + " ".repeat(MAX_LLM_RESPONSE_BYTES) : json,
        ),
    );
    const adapter = new StructuredOutputAdapter(
      resolveLlmEndpoint({ apiMode }),
      transport,
    );
    const parse = () =>
      adapter.parse(bucketSummaryContract, "model", "system", "user", 3);

    assert.deepEqual(await parse(), { summary: "bounded summary" });
    await expectAttemptError(parse(), {
      attempts: 1,
      kind: "transport",
      retryable: false,
    });
    assert.equal(requests, 2);
  });
}

test("non-retryable HTTP refusal filtering and nonterminal statuses stop immediately", async () => {
  const cases: ReadonlyArray<{
    response: LlmHttpResponse | Error;
    mode?: "chat" | undefined;
    kind: LlmError["kind"];
  }> = [
    { response: LlmTransportError.httpStatus(401), kind: "transport" },
    {
      response: {
        body: {
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "not allowed" }],
            },
          ],
        },
      },
      kind: "refusal",
    },
    {
      response: {
        body: {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        },
      },
      kind: "content_filter",
    },
    {
      response: {
        body: {
          choices: [
            {
              finish_reason: "content_filter",
              message: { role: "assistant", content: null },
            },
          ],
        },
      },
      mode: "chat",
      kind: "content_filter",
    },
    {
      response: { body: { status: "in_progress", output: [] } },
      kind: "unexpected_status",
    },
  ];

  for (const scenario of cases) {
    const endpoint =
      scenario.mode === "chat"
        ? resolveLlmEndpoint({
            site: "relay",
            baseUrl: "https://relay.example/v1",
            apiMode: "chat",
          })
        : resolveLlmEndpoint({});
    const transport = new FakeTransport([scenario.response]);
    const adapter = new StructuredOutputAdapter(endpoint, transport);
    await expectAttemptError(
      adapter.parse(bucketSummaryContract, "model", "system", "user", 3),
      { attempts: 1, kind: scenario.kind, retryable: false },
    );
    assert.equal(transport.requests.length, 1);
  }
});

test("structured output rejects Responses tool calls and legacy Chat function_call", async () => {
  const responsesTransport = new FakeTransport([
    {
      body: {
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "search_memory",
            arguments: "{}",
          },
        ],
      },
    },
  ]);
  const responsesAdapter = new StructuredOutputAdapter(
    resolveLlmEndpoint({}),
    responsesTransport,
  );
  const toolError = await expectAttemptError(
    responsesAdapter.parse(bucketSummaryContract, "model", "system", "user", 3),
    { attempts: 1, kind: "invalid_tool_call", retryable: false },
  );
  assert.equal(
    toolError.lastError?.message,
    "tool calls are not valid structured output",
  );
  assert.equal(responsesTransport.requests.length, 1);

  const chatTransport = new FakeTransport([
    {
      body: {
        choices: [
          {
            finish_reason: "function_call",
            message: {
              role: "assistant",
              content: null,
              function_call: { name: "search_memory", arguments: "{}" },
            },
          },
        ],
      },
    },
  ]);
  const chatAdapter = new StructuredOutputAdapter(
    resolveLlmEndpoint({
      site: "relay",
      baseUrl: "https://relay.example/v1",
      apiMode: LlmApiMode.ChatCompletions,
    }),
    chatTransport,
  );
  await expectAttemptError(
    chatAdapter.parse(bucketSummaryContract, "model", "system", "user", 3),
    { attempts: 1, kind: "invalid_tool_call", retryable: false },
  );
  assert.equal(chatTransport.requests.length, 1);
});

test("attempt exhaustion reports the exact count and sanitized last failure", async () => {
  const secretPrompt = "prompt-must-not-leak";
  const transport = new FakeTransport([
    responsesText("not json"),
    responsesText("still not json"),
  ]);
  const adapter = new StructuredOutputAdapter(
    resolveLlmEndpoint({}),
    transport,
  );
  const error = await expectAttemptError(
    adapter.parse(bucketSummaryContract, "model", "system", secretPrompt, 1),
    { attempts: 2, kind: "invalid_json", retryable: true },
  );

  assert.doesNotMatch(error.message, new RegExp(secretPrompt));
  assert.doesNotMatch(error.lastError?.message ?? "", new RegExp(secretPrompt));
  assert.equal(transport.requests.length, 2);
});

test("adapter revalidates structurally forged endpoint configuration", () => {
  const forged = {
    site: "relay",
    baseUrl: "http://attacker.example/v1",
    apiMode: LlmApiMode.Responses,
    isOfficial: false,
    requestUrl: "http://attacker.example/v1/responses",
  } as LlmEndpointConfig;

  assert.throws(
    () => new StructuredOutputAdapter(forged, new FakeTransport()),
    (error: unknown) =>
      error instanceof LlmConfigurationError &&
      error.kind === "insecure_remote_base_url",
  );

  const safeBaseWithForgedRequest = {
    site: "relay",
    baseUrl: "https://relay.example/v1",
    apiMode: LlmApiMode.Responses,
    isOfficial: false,
    requestUrl: "http://attacker.example/steal",
  } as LlmEndpointConfig;
  const safeTransport = new FakeTransport();
  const adapter = new StructuredOutputAdapter(
    safeBaseWithForgedRequest,
    safeTransport,
  );
  assert.equal(
    adapter.endpoint.requestUrl,
    "https://relay.example/v1/responses",
  );
  assert.equal(Object.isFrozen(adapter.endpoint), true);
  assert.equal(
    Reflect.set(adapter, "endpoint", {
      ...safeBaseWithForgedRequest,
      baseUrl: "http://attacker.example/v1",
      requestUrl: "http://attacker.example/steal",
    }),
    false,
  );
  assert.equal(
    adapter.endpoint.requestUrl,
    "https://relay.example/v1/responses",
  );
  assert.equal(Reflect.set(adapter, "transport", new FakeTransport()), false);
  assert.equal(adapter.transport, safeTransport);
});

test("unsupported or malformed tool-call states are non-retryable structured failures", async () => {
  const scenarios: ReadonlyArray<{
    endpoint: LlmEndpointConfig;
    response: LlmHttpResponse;
  }> = [
    {
      endpoint: resolveLlmEndpoint({}),
      response: {
        body: {
          status: "completed",
          output: [
            { type: "custom_tool_call", name: "do_it", input: "{}" },
            {
              type: "message",
              phase: "final_answer",
              content: [
                {
                  type: "output_text",
                  text: '{"summary":"must not win"}',
                },
              ],
            },
          ],
        },
      },
    },
    ...["tool_calls", "function_call"].map((finishReason) => ({
      endpoint: resolveLlmEndpoint({
        site: "relay",
        baseUrl: "https://relay.example/v1",
        apiMode: "chat",
      }),
      response: {
        body: {
          choices: [
            {
              finish_reason: finishReason,
              message: {
                role: "assistant",
                content: '{"summary":"must not win"}',
                ...(finishReason === "tool_calls" ? { tool_calls: [] } : {}),
              },
            },
          ],
        },
      },
    })),
  ];

  for (const scenario of scenarios) {
    const transport = new FakeTransport([scenario.response]);
    const adapter = new StructuredOutputAdapter(scenario.endpoint, transport);
    await expectAttemptError(
      adapter.parse(bucketSummaryContract, "model", "system", "user", 3),
      { attempts: 1, kind: "invalid_tool_call", retryable: false },
    );
    assert.equal(transport.requests.length, 1);
  }
});
