import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import { StructuredMemoryModel } from "../application/archive-runtime.ts";
import { resolveLlmEndpoint } from "./config.ts";
import { bucketSummaryContract } from "./contracts.ts";
import { StructuredOutputAdapter } from "./structured-output.ts";
import {
  FetchStructuredOutputTransport,
  LlmTransportError,
  type LlmHttpRequest,
  type LlmHttpResponse,
  type StructuredOutputTransport,
} from "./transport.ts";

const secret = "private-abort-reason-and-key";
const endpoint = resolveLlmEndpoint({ site: "official" });
const response: LlmHttpResponse = {
  body: {
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: '{"summary":"ok"}' }],
      },
    ],
  },
};

function sanitizedAbort(error: unknown): boolean {
  assert.ok(error instanceof DOMException);
  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "The operation was aborted");
  assert.doesNotMatch(inspect(error), /private-abort-reason-and-key/u);
  assert.equal(error.cause, undefined);
  return true;
}

function generate(adapter: StructuredOutputAdapter, signal?: AbortSignal) {
  return adapter.generate({
    contract: bucketSummaryContract,
    model: "fake-model",
    systemPrompt: "system",
    userPrompt: "user",
    maxRetries: 3,
    signal,
  });
}

for (const source of ["request", "process"] as const) {
  test(`pre-aborted ${source} signal avoids fetch and sanitizes arbitrary reasons`, async () => {
    const controller = new AbortController();
    controller.abort({ secret });
    let calls = 0;
    const transport = new FetchStructuredOutputTransport(
      secret,
      source === "process" ? { signal: controller.signal } : {},
      async () => {
        calls += 1;
        return Response.json(response.body);
      },
    );
    await assert.rejects(
      transport.send({
        url: endpoint.requestUrl,
        body: {},
        ...(source === "request" ? { signal: controller.signal } : {}),
      }),
      sanitizedAbort,
    );
    assert.equal(calls, 0);
  });

  test(`${source} cancellation combines request/process/timeout signals and never retries`, async () => {
    const processController = new AbortController();
    const requestController = new AbortController();
    let observed: AbortSignal | null | undefined;
    let calls = 0;
    const transport = new FetchStructuredOutputTransport(
      secret,
      { signal: processController.signal, timeoutMs: 30_000 },
      async (_input, init) => {
        calls += 1;
        const signal = init?.signal;
        assert.ok(signal);
        observed = signal;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const pending = generate(
      new StructuredOutputAdapter(endpoint, transport),
      requestController.signal,
    );
    (source === "request" ? requestController : processController).abort(
      new Error(secret),
    );
    await assert.rejects(pending, sanitizedAbort);
    assert.equal(calls, 1);
    assert.equal(observed?.aborted, true);
  });
}

for (const outcome of [
  "success",
  "http_error",
  "network_error",
  "body_success",
  "body_error",
] as const) {
  test(`transport checks cancellation after ${outcome} without leaking reasons`, async () => {
    const controller = new AbortController();
    const transport = new FetchStructuredOutputTransport(
      secret,
      {},
      async () => {
        if (outcome === "body_success" || outcome === "body_error") {
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(stream) {
                  if (outcome === "body_error") stream.error(new Error(secret));
                  else {
                    stream.enqueue(
                      new TextEncoder().encode(JSON.stringify(response.body)),
                    );
                    stream.close();
                  }
                  controller.abort(secret);
                },
              },
              { highWaterMark: 0 },
            ),
          );
        }
        controller.abort(secret);
        if (outcome === "network_error") throw new Error(secret);
        return outcome === "http_error"
          ? new Response(null, { status: 503 })
          : Response.json(response.body);
      },
    );
    await assert.rejects(
      transport.send({
        url: endpoint.requestUrl,
        body: {},
        signal: controller.signal,
      }),
      sanitizedAbort,
    );
  });
}

test("combined timeout stays retryable when request and process signals are live", async (t) => {
  const processController = new AbortController();
  const requestController = new AbortController();
  // The transport timer is intentionally unref'ed; keep this fake I/O alive.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const transport = new FetchStructuredOutputTransport(
    secret,
    { timeoutMs: 5, signal: processController.signal },
    async (_input, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  );
  await assert.rejects(
    transport.send({
      url: endpoint.requestUrl,
      body: {},
      signal: requestController.signal,
    }),
    (error: unknown) => error instanceof LlmTransportError && error.retryable,
  );
  assert.equal(requestController.signal.aborted, false);
  assert.equal(processController.signal.aborted, false);
});

test("generate and legacy parse avoid transport for pre-aborted input", async () => {
  let calls = 0;
  const adapter = new StructuredOutputAdapter(endpoint, {
    send: async () => {
      calls += 1;
      return response;
    },
  });
  const signal = AbortSignal.abort(secret);
  await assert.rejects(generate(adapter, signal), sanitizedAbort);
  await assert.rejects(
    adapter.parse(bucketSummaryContract, "model", "system", "user", 3, signal),
    sanitizedAbort,
  );
  assert.equal(calls, 0);
});

for (const outcome of ["valid", "invalid", "failure", "abort_error"] as const) {
  test(`adapter forwards signal and stops retries after cancelled ${outcome} response`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const adapter = new StructuredOutputAdapter(endpoint, {
      send: async (request) => {
        calls += 1;
        assert.ok(request.signal);
        assert.equal(request.signal.aborted, false);
        if (outcome === "abort_error")
          throw new DOMException(secret, "AbortError");
        controller.abort(secret);
        assert.equal(request.signal.aborted, true);
        if (outcome === "failure") throw LlmTransportError.request();
        return outcome === "valid" ? response : { body: {} };
      },
    });
    await assert.rejects(generate(adapter, controller.signal), sanitizedAbort);
    assert.equal(calls, 1);
  });
}

test("legacy parse and generate both preserve normal bounded retries", async () => {
  const controller = new AbortController();
  let calls = 0;
  const waits: number[] = [];
  const transport: StructuredOutputTransport = {
    send: async (request) => {
      assert.ok(request.signal && !request.signal.aborted);
      calls += 1;
      if (calls % 2 === 1) throw LlmTransportError.request();
      return response;
    },
  };
  const adapter = new StructuredOutputAdapter(endpoint, transport, {
    random: () => 0,
    async sleep(ms) {
      waits.push(ms);
    },
  });
  assert.deepEqual(await generate(adapter, controller.signal), {
    summary: "ok",
  });
  assert.deepEqual(
    await adapter.parse(
      bucketSummaryContract,
      "model",
      "system",
      "user",
      3,
      controller.signal,
    ),
    { summary: "ok" },
  );
  assert.equal(calls, 4);
  assert.deepEqual(waits, [500, 500]);
});

test("StructuredMemoryModel forwards both classify and extract cancellation", async () => {
  const controller = new AbortController();
  const requests: LlmHttpRequest[] = [];
  const adapter = new StructuredOutputAdapter(endpoint, {
    send: async (request) => {
      requests.push(request);
      throw new DOMException(secret, "AbortError");
    },
  });
  const model = new StructuredMemoryModel(adapter, "fake-model");
  await assert.rejects(
    model.classify("facts 100%", [], controller.signal),
    sanitizedAbort,
  );
  await assert.rejects(
    model.extract("facts 100%", controller.signal),
    sanitizedAbort,
  );
  assert.equal(requests.length, 2);
  for (const request of requests)
    assert.ok(request.signal && !request.signal.aborted);
  controller.abort(secret);
  for (const request of requests) assert.equal(request.signal?.aborted, true);
});
