import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LlmApiMode,
  LlmConfigurationError,
  type LlmEndpointConfig,
  resolveLlmEndpoint,
} from "./config.ts";
import {
  defaultStructuredRetryTiming,
  type StructuredRetryTiming,
} from "./retry-policy.ts";
import { inspect } from "node:util";
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
  readonly requests: Omit<LlmHttpRequest, "signal">[] = [];
  readonly #results: Array<LlmHttpResponse | Error>;

  constructor(results: Iterable<LlmHttpResponse | Error> = []) {
    this.#results = [...results];
  }

  async send(request: LlmHttpRequest): Promise<LlmHttpResponse> {
    assert.ok(request.signal instanceof AbortSignal);
    this.requests.push(
      structuredClone({ url: request.url, body: request.body }),
    );
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
    fakeTiming().timing,
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
    fakeTiming().timing,
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
    fakeTiming().timing,
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

for (const apiMode of ["responses", "chat"] as const) {
  test(`structured ${apiMode} retries wait between retryable failures`, async () => {
    let time = 0;
    const events: string[] = [];
    const transport = new FakeTransport([
      LlmTransportError.httpStatus(429),
      LlmTransportError.request(),
      apiMode === "chat"
        ? chatText('{"summary":"recovered"}')
        : responsesText('{"summary":"recovered"}'),
    ]);
    const adapter = new StructuredOutputAdapter(
      resolveLlmEndpoint({ apiMode }),
      {
        send(request) {
          events.push(`send:${time}`);
          return transport.send(request);
        },
      },
      {
        now: () => time,
        random: () => 0,
        async sleep(ms: number) {
          events.push(`wait:${ms}`);
          time += ms;
        },
      },
    );
    assert.deepEqual(
      await adapter.parse(bucketSummaryContract, "fake", "system", "user", 2),
      { summary: "recovered" },
    );
    assert.deepEqual(events, [
      "send:0",
      "wait:500",
      "send:500",
      "wait:1000",
      "send:1500",
    ]);
  });
}

function fakeTiming(budgetMs = 90_000) {
  let time = 0;
  let onExpiry: (() => void) | undefined;
  const waits: number[] = [];
  const advance = (ms: number) => {
    time += ms;
  };
  const timing: StructuredRetryTiming = {
    budgetMs,
    now: () => time,
    random: () => 0,
    async sleep(ms) {
      waits.push(ms);
      advance(ms);
    },
    scheduleExpiry(_ms, expire) {
      onExpiry = expire;
      return () => {
        onExpiry = undefined;
      };
    },
  };
  return {
    timing,
    advance,
    waits,
    expire: () => onExpiry?.(),
    scheduled: () => onExpiry !== undefined,
  };
}

function expectBudget(attempts: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.kind, "budget_exhausted");
    assert.equal(error.attempts, attempts);
    assert.equal(error.retryable, false);
    assert.doesNotMatch(inspect(error), /private-retry-data/u);
    return true;
  };
}

for (const apiMode of ["responses", "chat"] as const) {
  test(
    apiMode +
      " honors Retry-After propagated from fetch without exposing error data",
    async () => {
      const { timing, waits, scheduled } = fakeTiming();
      const endpoint = resolveLlmEndpoint({ apiMode });
      let calls = 0;
      const transport = new FetchStructuredOutputTransport(
        "private-retry-data",
        {},
        async () =>
          ++calls === 1
            ? new Response("private-retry-data", {
                status: 429,
                headers: { "retry-after": "2" },
              })
            : Response.json(
                (apiMode === "chat" ? chatText : responsesText)(
                  '{"summary":"recovered"}',
                ).body,
              ),
      );
      const adapter = new StructuredOutputAdapter(endpoint, transport, timing);
      assert.deepEqual(
        await adapter.parse(bucketSummaryContract, "fake", "system", "user", 2),
        { summary: "recovered" },
      );
      assert.deepEqual(waits, [2000]);
      assert.equal(calls, 2);
      assert.equal(scheduled(), false);
    },
  );
}

for (const retryAfter of [1000, 2000, "too_long"] as const) {
  test(
    "retry exceeding the remaining budget never waits or sends: " + retryAfter,
    async () => {
      const { timing, waits, scheduled } = fakeTiming(1000);
      const transport = new FakeTransport([
        LlmTransportError.httpStatus(503, retryAfter),
      ]);
      const adapter = new StructuredOutputAdapter(
        resolveLlmEndpoint({}),
        transport,
        timing,
      );
      await assert.rejects(
        adapter.parse(
          bucketSummaryContract,
          "fake",
          "system",
          "private-retry-data",
          2,
        ),
        (error: unknown) => {
          expectBudget(1)(error);
          assert.ok(error instanceof LlmError);
          assert.equal(error.lastError?.retryAfterMs, retryAfter);
          return true;
        },
      );
      assert.deepEqual(waits, []);
      assert.equal(transport.requests.length, 1);
      assert.equal(scheduled(), false);
    },
  );
}

test("remaining budget is checked after a delayed wakeup before sending any retry", async () => {
  const { timing, advance, scheduled } = fakeTiming(1000);
  const transport = new FakeTransport([LlmTransportError.request()]);
  const adapter = new StructuredOutputAdapter(
    resolveLlmEndpoint({}),
    transport,
    {
      ...timing,
      async sleep() {
        advance(1000);
      },
    },
  );
  await assert.rejects(
    adapter.parse(bucketSummaryContract, "fake", "system", "user", 2),
    expectBudget(1),
  );
  assert.equal(transport.requests.length, 1);
  assert.equal(scheduled(), false);
});

for (const phase of [
  "before sending",
  "during transport",
  "during parsing",
] as const) {
  test(
    "monotonic deadline refuses results " +
      phase +
      " even before its timer fires",
    async () => {
      const { timing, advance, scheduled } = fakeTiming(1000);
      let sends = 0;
      let parses = 0;
      const transport = {
        get processSignal() {
          return undefined;
        },
        async send() {
          sends++;
          if (phase === "during transport") advance(1000);
          return responsesText('{"summary":"late"}');
        },
      };
      const adapter = new StructuredOutputAdapter(
        resolveLlmEndpoint({}),
        transport,
        {
          ...timing,
          scheduleExpiry(ms, callback) {
            const cleanup = timing.scheduleExpiry(ms, callback);
            if (phase === "before sending") advance(1000);
            return cleanup;
          },
        },
      );
      const contract = {
        ...bucketSummaryContract,
        parse(value: unknown) {
          parses++;
          advance(1000);
          return bucketSummaryContract.parse(value);
        },
      };
      await assert.rejects(
        adapter.parse(contract, "fake", "system", "user", 2),
        expectBudget(phase === "before sending" ? 0 : 1),
      );
      assert.equal(sends, phase === "before sending" ? 0 : 1);
      assert.equal(parses, phase === "during parsing" ? 1 : 0);
      assert.equal(scheduled(), false);
    },
  );
}

for (const cause of [
  "caller",
  "process",
  "budget",
  "caller and budget",
] as const) {
  test(
    cause + " stops a pending retry wait and cleans the deadline timer",
    async () => {
      const { timing, expire, scheduled } = fakeTiming();
      const caller = new AbortController();
      const process = new AbortController();
      const started = Promise.withResolvers<void>();
      let calls = 0;
      const transport = new FetchStructuredOutputTransport(
        "private-retry-data",
        { signal: process.signal },
        async () => {
          calls++;
          return new Response("private-retry-data", {
            status: 503,
            headers: { "retry-after": "10" },
          });
        },
      );
      const adapter = new StructuredOutputAdapter(
        resolveLlmEndpoint({}),
        transport,
        {
          ...timing,
          sleep(ms, signal) {
            const wait = defaultStructuredRetryTiming.sleep(ms, signal);
            started.resolve();
            return wait;
          },
        },
      );
      const promise = adapter.parse(
        bucketSummaryContract,
        "fake",
        "system",
        "user",
        2,
        caller.signal,
      );
      const checked = assert.rejects(
        promise,
        cause === "budget"
          ? expectBudget(1)
          : {
              name: "AbortError",
              message: "The operation was aborted",
            },
      );
      await started.promise;
      if (cause === "budget" || cause === "caller and budget") expire();
      if (cause === "caller" || cause === "caller and budget")
        caller.abort("private-retry-data");
      if (cause === "process") process.abort("private-retry-data");
      await checked;
      assert.equal(calls, 1);
      assert.equal(scheduled(), false);
    },
  );
}

test("total deadline aborts a stalled fetch body without retrying or leaking its reader", async () => {
  const { timing, expire, scheduled } = fakeTiming();
  const reading = Promise.withResolvers<void>();
  let calls = 0;
  let bodyCancelled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        reading.resolve();
      },
      cancel() {
        bodyCancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  const transport = new FetchStructuredOutputTransport(
    "private-retry-data",
    {},
    async () => {
      calls++;
      return new Response(body);
    },
  );
  const adapter = new StructuredOutputAdapter(
    resolveLlmEndpoint({}),
    transport,
    timing,
  );
  const checked = assert.rejects(
    adapter.parse(bucketSummaryContract, "fake", "system", "user", 2),
    expectBudget(1),
  );
  await reading.promise;
  expire();
  await checked;
  assert.equal(calls, 1);
  assert.equal(bodyCancelled, 1);
  assert.equal(body.locked, false);
  assert.equal(scheduled(), false);
});
