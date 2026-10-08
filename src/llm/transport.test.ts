import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import {
  FetchStructuredOutputTransport,
  LlmTransportConfigurationError,
  LlmTransportError,
  MAX_LLM_HTTP_TIMEOUT_MS,
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
