import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import {
  FetchStructuredOutputTransport,
  LlmTransportConfigurationError,
  LlmTransportError,
  MAX_LLM_HTTP_TIMEOUT_MS,
  MAX_LLM_RESPONSE_BYTES,
  type LlmHttpRequest,
} from "./transport.ts";

function fakeFetch(
  implementation: (
    input: string | URL | Request,
    init: RequestInit | undefined,
  ) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

test("fetch transport posts JSON with authorization while redacting its API key", async () => {
  const captured: Array<{
    input: string | URL | Request;
    init: RequestInit | undefined;
  }> = [];
  const secret = "fixture-key-not-a-secret";
  const transport = new FetchStructuredOutputTransport(
    secret,
    { timeoutMs: 2_000 },
    fakeFetch(async (input, init) => {
      captured.push({ input, init });
      return new Response(JSON.stringify({ status: "completed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const request: LlmHttpRequest = {
    url: "http://localhost:8000/v1/responses",
    body: {
      model: "test-model",
      input: [{ role: "user", content: "secret prompt" }],
    },
  };

  assert.deepEqual(await transport.send(request), {
    body: { status: "completed" },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.input, request.url);
  assert.equal(captured[0]?.init?.method, "POST");
  assert.deepEqual(captured[0]?.init?.headers, {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(captured[0]?.init?.body)), request.body);
  assert.doesNotMatch(inspect(transport), new RegExp(secret));
});

test("transport errors are sanitized and classify retryable HTTP statuses", async () => {
  const secret = "fixture-key-not-a-secret";
  const prompt = "request-body-must-not-leak";

  for (const [status, retryable] of [
    [401, false],
    [408, true],
    [409, true],
    [429, true],
    [500, true],
  ] as const) {
    const transport = new FetchStructuredOutputTransport(
      secret,
      {},
      fakeFetch(
        async () => new Response("sensitive upstream body", { status }),
      ),
    );
    await assert.rejects(
      transport.send({
        url: "http://localhost/v1/responses",
        body: { prompt },
      }),
      (error: unknown) => {
        assert.ok(error instanceof LlmTransportError);
        assert.equal(error.status, status);
        assert.equal(error.retryable, retryable);
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.doesNotMatch(error.message, new RegExp(prompt));
        assert.doesNotMatch(error.message, /sensitive upstream body/u);
        return true;
      },
    );
  }
});

test("invalid JSON and timeout become sanitized retryable request failures", async () => {
  const invalidJson = new FetchStructuredOutputTransport(
    "fixture-key",
    {},
    fakeFetch(async () => new Response("{not valid JSON", { status: 200 })),
  );
  await assert.rejects(
    invalidJson.send({
      url: "http://localhost/v1/responses",
      body: { secret: "body" },
    }),
    (error: unknown) =>
      error instanceof LlmTransportError &&
      error.kind === "request" &&
      error.retryable &&
      error.message === "LLM HTTP request failed",
  );

  const timeout = new FetchStructuredOutputTransport(
    "fixture-key",
    { timeoutMs: 10 },
    fakeFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("request detail", "AbortError")),
            { once: true },
          );
        }),
    ),
  );
  await assert.rejects(
    timeout.send({
      url: "http://localhost/v1/responses",
      body: { prompt: "must not leak" },
    }),
    (error: unknown) =>
      error instanceof LlmTransportError &&
      error.kind === "request" &&
      error.message === "LLM HTTP request failed",
  );
});

test("transport configuration rejects empty keys and invalid timeouts", () => {
  assert.throws(
    () => new FetchStructuredOutputTransport("  "),
    (error: unknown) =>
      error instanceof LlmTransportConfigurationError &&
      error.kind === "missing_api_key",
  );
  for (const timeoutMs of [
    0,
    -1,
    0.5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_LLM_HTTP_TIMEOUT_MS + 1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.throws(
      () => new FetchStructuredOutputTransport("key", { timeoutMs }),
      (error: unknown) =>
        error instanceof LlmTransportConfigurationError &&
        error.kind === "invalid_timeout",
    );
  }
  const maximumTimeoutTransport = new FetchStructuredOutputTransport("key", {
    timeoutMs: MAX_LLM_HTTP_TIMEOUT_MS,
  });
  assert.equal(maximumTimeoutTransport.timeoutMs, MAX_LLM_HTTP_TIMEOUT_MS);
  assert.equal(
    Reflect.set(maximumTimeoutTransport, "timeoutMs", Number.POSITIVE_INFINITY),
    false,
  );
  assert.equal(maximumTimeoutTransport.timeoutMs, MAX_LLM_HTTP_TIMEOUT_MS);
  assert.throws(
    () => FetchStructuredOutputTransport.fromEnv({}, {}),
    (error: unknown) =>
      error instanceof LlmTransportConfigurationError &&
      error.kind === "missing_api_key",
  );
});

test("process-level cancellation aborts an in-flight model request without leaking credentials", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const transport = new FetchStructuredOutputTransport(
    "cancel-secret",
    { timeoutMs: 30_000, signal: controller.signal },
    fakeFetch(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      observedSignal = signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }),
  );
  const pending = transport.send({
    url: "http://localhost/v1/responses",
    body: {},
  });
  controller.abort(new Error("cancel-secret"));
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DOMException &&
      error.name === "AbortError" &&
      error.message === "The operation was aborted",
  );
  assert.equal(observedSignal?.aborted, true);
});

test("transport rejects a successful response larger than 1 MiB before returning it", async () => {
  const transport = new FetchStructuredOutputTransport(
    "fixture-key",
    {},
    fakeFetch(
      async () => new Response(JSON.stringify({ text: "x".repeat(2_097_152) })),
    ),
  );
  await assert.rejects(
    transport.send({ url: "http://localhost/v1/responses", body: {} }),
    (error: unknown) => error instanceof LlmTransportError && !error.retryable,
  );
});

function byteStream(chunks: readonly Uint8Array[], cancelError = false) {
  let pulls = 0;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancellations++;
        if (cancelError) throw new Error("secret cleanup detail");
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancellations: () => cancellations };
}
const transportRequest = {
  url: "http://localhost/v1/responses?secret=endpoint",
  body: {},
};
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const sizeFailure = (error: unknown): boolean => {
  assert.ok(error instanceof LlmTransportError);
  assert.equal(error.kind, "response_too_large");
  assert.equal(error.retryable, false);
  assert.equal(error.status, undefined);
  assert.equal(
    error.message,
    "LLM response exceeded the configured size limit",
  );
  assert.doesNotMatch(JSON.stringify(error), /secret|endpoint|fixture-key/);
  return true;
};

for (const declared of [
  undefined,
  "17",
  "invalid",
  "-1",
  "1.5",
  "1e7",
] as const) {
  test(`stream byte budget rejects oversized chunks with Content-Length ${declared ?? "missing"}`, async () => {
    const source = byteStream(
      [
        encode('{"text":"'),
        new Uint8Array(MAX_LLM_RESPONSE_BYTES).fill(97),
        encode('must not read remaining secret data"}'),
      ],
      true,
    );
    const transport = new FetchStructuredOutputTransport(
      "fixture-key",
      {},
      fakeFetch(
        async () =>
          new Response(source.stream, {
            headers:
              declared === undefined ? {} : { "content-length": declared },
          }),
      ),
    );
    await assert.rejects(transport.send(transportRequest), sizeFailure);
    assert.equal(source.pulls(), 2);
    assert.equal(source.cancellations(), 1);
    assert.equal(source.stream.locked, false);
  });
}

for (const declared of [
  String(MAX_LLM_RESPONSE_BYTES + 1),
  "99999999999999999999999999999999",
] as const) {
  test(`valid oversized Content-Length ${declared} cancels without reading`, async () => {
    const source = byteStream([encode('{"ok":true}')], true);
    const transport = new FetchStructuredOutputTransport(
      "fixture-key",
      {},
      fakeFetch(
        async () =>
          new Response(source.stream, {
            headers: { "content-length": declared },
          }),
      ),
    );
    await assert.rejects(transport.send(transportRequest), sizeFailure);
    assert.equal(source.pulls(), 0);
    assert.equal(source.cancellations(), 1);
    assert.equal(source.stream.locked, false);
  });
}

test("exact byte budget parses split multi-byte UTF-8 and permits a declared boundary", async () => {
  const bytes = encode(JSON.stringify({ text: "你🙂" }));
  const padding = new Uint8Array(MAX_LLM_RESPONSE_BYTES - bytes.length).fill(
    32,
  );
  const source = byteStream([
    bytes.subarray(0, 10),
    bytes.subarray(10, 12),
    bytes.subarray(12),
    padding,
  ]);
  const transport = new FetchStructuredOutputTransport(
    "fixture-key",
    {},
    fakeFetch(
      async () =>
        new Response(source.stream, {
          headers: { "content-length": String(MAX_LLM_RESPONSE_BYTES) },
        }),
    ),
  );
  assert.deepEqual(await transport.send(transportRequest), {
    body: { text: "你🙂" },
  });
  assert.equal(source.stream.locked, false);
});

test("many small chunks enforce total bytes rather than decoded characters", async () => {
  const chunk = encode("你".repeat(341)); // 1023 bytes
  const source = byteStream([
    encode('{"text":"'),
    ...Array.from({ length: 1100 }, () => chunk),
    encode('"}'),
  ]);
  const transport = new FetchStructuredOutputTransport(
    "fixture-key",
    {},
    fakeFetch(async () => new Response(source.stream)),
  );
  await assert.rejects(transport.send(transportRequest), sizeFailure);
  assert.ok(source.pulls() < 1101);
  assert.equal(source.cancellations(), 1);
});

for (const status of [401, 429, 503]) {
  test(`HTTP ${status} terminates error body without reading`, async () => {
    const source = byteStream([new Uint8Array(2_097_152)], true);
    const transport = new FetchStructuredOutputTransport(
      "fixture-key",
      {},
      fakeFetch(async () => new Response(source.stream, { status })),
    );
    await assert.rejects(
      transport.send(transportRequest),
      (error: unknown) =>
        error instanceof LlmTransportError && error.status === status,
    );
    assert.equal(source.pulls(), 0);
    assert.equal(source.cancellations(), 1);
  });
}

test("valid Content-Length below the limit returns decoded JSON", async () => {
  const content = new TextEncoder().encode('{"text":"正常"}');
  const transport = new FetchStructuredOutputTransport(
    "fixture-key",
    {},
    fakeFetch(
      async () =>
        new Response(content, {
          headers: { "content-length": String(content.byteLength) },
        }),
    ),
  );
  assert.deepEqual(await transport.send(transportRequest), {
    body: { text: "正常" },
  });
});

for (const [name, content] of [
  ["absent", null],
  ["empty", ""],
  ["malformed", "{secret invalid JSON"],
] as const) {
  test(`body syntax failure (${name}) releases reader and preserves retry classification`, async () => {
    const source = content === null ? null : byteStream([encode(content)]);
    const transport = new FetchStructuredOutputTransport(
      "fixture-key",
      {},
      fakeFetch(async () => new Response(source?.stream ?? null)),
    );
    await assert.rejects(
      transport.send(transportRequest),
      (error: unknown) =>
        error instanceof LlmTransportError &&
        error.kind === "request" &&
        error.retryable &&
        !error.message.includes("secret"),
    );
    if (source !== null) assert.equal(source.stream.locked, false);
  });
}

for (const cancellation of ["caller", "process", "timeout"] as const) {
  test(`body read responds to ${cancellation} cancellation even with a fetch stream that ignores its signal`, async () => {
    const controller = new AbortController();
    let pulled = () => {};
    const began = new Promise<void>((resolve) => {
      pulled = resolve;
    });
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled();
        },
        cancel() {
          cancellations++;
          throw new Error("secret cancel detail");
        },
      },
      { highWaterMark: 0 },
    );
    const transport = new FetchStructuredOutputTransport(
      "fixture-key",
      {
        timeoutMs: cancellation === "timeout" ? 10 : 1000,
        ...(cancellation === "process" ? { signal: controller.signal } : {}),
      },
      fakeFetch(async () => new Response(body)),
    );
    const pending = transport.send({
      ...transportRequest,
      ...(cancellation === "caller" ? { signal: controller.signal } : {}),
    });
    const rejection = assert.rejects(pending, (error: unknown) =>
      cancellation === "timeout"
        ? error instanceof LlmTransportError &&
          error.kind === "request" &&
          error.retryable
        : error instanceof DOMException &&
          error.name === "AbortError" &&
          error.message === "The operation was aborted",
    );
    await began;
    // The production deadline is unref'ed. Keep this isolated fake test alive.
    const alive = setTimeout(() => {}, 2000);
    if (cancellation !== "timeout") controller.abort("secret reason");
    try {
      await rejection;
    } finally {
      clearTimeout(alive);
    }
    assert.ok(cancellations >= 1);
    assert.equal(body.locked, false);
  });
}

test("body stream failure is sanitized and retryable and releases reader", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("secret parser stream detail"));
    },
  });
  const transport = new FetchStructuredOutputTransport(
    "fixture-key",
    {},
    fakeFetch(async () => new Response(body)),
  );
  await assert.rejects(
    transport.send(transportRequest),
    (error: unknown) =>
      error instanceof LlmTransportError &&
      error.kind === "request" &&
      error.retryable &&
      !error.message.includes("secret"),
  );
  assert.equal(body.locked, false);
});

test("caller abort takes priority when oversized response cancels during cleanup", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(MAX_LLM_RESPONSE_BYTES + 1));
    },
    cancel() {
      controller.abort("secret reason");
    },
  });
  const transport = new FetchStructuredOutputTransport(
    "fixture-key",
    {},
    fakeFetch(async () => new Response(body)),
  );
  await assert.rejects(
    transport.send({ ...transportRequest, signal: controller.signal }),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
});
