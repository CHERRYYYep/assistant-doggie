import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Hono } from "hono";
import { SmartRouter } from "hono/router/smart-router";

import type { DoggieHttpApi } from "./app.ts";
import { SECURITY_RESPONSE_HEADERS } from "./security.ts";
import {
  createDoggieNodeServer,
  drainDoggieNodeServer,
  type DoggieNodeServerOptions,
} from "./server.ts";

const encoder = new TextEncoder();
const TEST_TIMEOUT_MS = 5_000;

type TestHandler = (request: Request) => Response | Promise<Response>;
type Exchange = {
  readonly incoming: IncomingMessage;
  readonly outgoing: ServerResponse;
};

function fakeApi(
  chat: DoggieHttpApi["chat"] = () => ({ ok: true }),
): DoggieHttpApi {
  const ok = () => ({ ok: true });
  return {
    activeBuckets: ok,
    searchBuckets: ok,
    chatHistory: ok,
    memoryQuery: ok,
    memoryQueryJson: ok,
    bucketDetail: ok,
    deleteBucket: ok,
    archive: ok,
    chat,
    confirmChat: ok,
    appendConfirmed: ok,
    createConfirmed: ok,
    moveEntry: ok,
    setBucketStatus: ok,
  };
}

async function fixture(
  context: TestContext,
  options: DoggieNodeServerOptions = {},
  api: DoggieHttpApi = fakeApi(),
  handler?: TestHandler,
): Promise<{ readonly server: Server; readonly port: number }> {
  if (handler !== undefined) {
    // Inject only a test route, retaining the real app's security middleware.
    // No production adapter/app seam or task executor is needed for fake SSE.
    const routes = new Hono();
    routes.get("/adapter-test", (route) => handler(route.req.raw));
    const injected = new WeakSet<object>();
    const original = SmartRouter.prototype.match;
    context.mock.method(
      SmartRouter.prototype,
      "match",
      function (
        this: SmartRouter<Parameters<Hono["router"]["add"]>[2]>,
        method: string,
        path: string,
      ) {
        if (!injected.has(this)) {
          for (const route of routes.routes) {
            this.add(route.method, route.path, [route.handler, route]);
          }
          injected.add(this);
        }
        return original.call(this, method, path);
      },
    );
  }
  const server = createDoggieNodeServer(api, { assets: [], ...options });
  context.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    await drainDoggieNodeServer(server);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { server, port: address.port };
}

async function socketFor(context: TestContext, port: number): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  context.after(() => socket.destroy());
  await once(socket, "connect");
  return socket;
}

function send(socket: Socket, port: number, path = "/adapter-test"): void {
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
  );
}

function untilText(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const dispose = (): void => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes(text)) {
        dispose();
        resolve(output);
      }
    };
    const onClose = (): void => {
      dispose();
      reject(new Error(`socket closed before ${JSON.stringify(text)}`));
    };
    const onError = (error: Error): void => {
      dispose();
      reject(error);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function captureExchange(server: Server): Promise<Exchange> {
  return new Promise((resolve) => {
    server.once("request", (incoming, outgoing) => {
      resolve({ incoming, outgoing });
    });
  });
}

function assertDisposed(exchange: Exchange): void {
  assert.equal(exchange.incoming.listenerCount("aborted"), 0);
  assert.equal(exchange.incoming.listenerCount("data"), 0);
  assert.equal(exchange.outgoing.listenerCount("close"), 0);
  assert.equal(exchange.outgoing.listenerCount("drain"), 0);
  assert.equal(exchange.outgoing.listenerCount("error"), 0);
}

test(
  "completed IncomingMessage.close does not abort; response disconnect aborts fake API",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const started = Promise.withResolvers<AbortSignal>();
    const aborted = Promise.withResolvers<void>();
    const api = fakeApi(async (_request, signal) => {
      assert.ok(signal);
      started.resolve(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      return { ok: true };
    });
    const { server, port } = await fixture(context, {}, api);
    const exchangePromise = captureExchange(server);
    const incomingClosed = Promise.withResolvers<void>();
    server.once("request", (incoming) =>
      incoming.once("close", incomingClosed.resolve),
    );
    const socket = await socketFor(context, port);
    const body = JSON.stringify({ message: "fake cancellable work" });
    socket.write(
      `POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    const signal = await started.promise;
    await incomingClosed.promise;
    assert.equal(signal.aborted, false);
    const exchange = await exchangePromise;
    assert.equal(exchange.incoming.complete, true);
    socket.destroy();
    await aborted.promise;
    await drainDoggieNodeServer(server);
    assert.equal(signal.aborted, true);
    assertDisposed(exchange);
  },
);

test(
  "aborted partial upload disposes request-body and lifecycle listeners",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    let calls = 0;
    const { server, port } = await fixture(
      context,
      {},
      fakeApi(() => {
        calls += 1;
        return { ok: true };
      }),
    );
    const captured = captureExchange(server);
    const socket = await socketFor(context, port);
    socket.write(
      `POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`,
    );
    const exchange = await captured;
    const closed = once(exchange.outgoing, "close");
    socket.destroy();
    await closed;
    await drainDoggieNodeServer(server);
    assert.equal(calls, 0);
    assertDisposed(exchange);
  },
);

test(
  "SSE first frame reaches the socket before stream completion, then finishes cleanly",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const output =
      Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    let requestSignal: AbortSignal | undefined;
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
        output.resolve(controller);
      },
      cancel() {
        cancels += 1;
      },
    });
    const { server, port } = await fixture(
      context,
      { executionTimeoutMs: 1000 },
      fakeApi(),
      (request) => {
        requestSignal = request.signal;
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Content-Length": "999",
          },
        });
      },
    );
    const captured = captureExchange(server);
    const socket = await socketFor(context, port);
    const first = untilText(socket, "data: first\n\n");
    send(socket, port);
    const initial = await first;
    assert.match(initial, /HTTP\/1\.1 200/u);
    assert.doesNotMatch(initial, /content-length:/iu);
    assert.match(initial, /transfer-encoding: chunked/iu);
    for (const [name, value] of Object.entries(SECURITY_RESPONSE_HEADERS)) {
      assert.ok(
        initial
          .toLowerCase()
          .includes(`${name.toLowerCase()}: ${value.toLowerCase()}\r\n`),
      );
    }
    assert.doesNotMatch(initial, /access-control-allow-origin/iu);
    assert.equal(cancels, 0);
    const next = untilText(socket, "data: second\n\n");
    const closed = once(socket, "close");
    const controller = await output.promise;
    controller.enqueue(encoder.encode("data: second\n\n"));
    controller.close();
    await next;
    await closed;
    await drainDoggieNodeServer(server);
    assert.equal(stream.locked, false);
    assertDisposed(await captured);
    assert.ok(requestSignal);
    assert.equal(getEventListeners(requestSignal, "abort").length, 0);
    await delay(1100);
    assert.equal(
      requestSignal.aborted,
      false,
      "finished response cleared its deadline",
    );
    assert.equal(cancels, 0);
  },
);

test(
  "SSE disconnect cancels a pending read once even if producer cancellation never settles",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const cancelled = Promise.withResolvers<unknown>();
    let requestSignal: AbortSignal | undefined;
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: ready\n\n"));
      },
      cancel(reason: unknown) {
        cancels += 1;
        cancelled.resolve(reason);
        return new Promise<void>(() => {});
      },
    });
    const { server, port } = await fixture(
      context,
      {},
      fakeApi(),
      (request) => {
        requestSignal = request.signal;
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    );
    const captured = captureExchange(server);
    const socket = await socketFor(context, port);
    const ready = untilText(socket, "data: ready\n\n");
    send(socket, port);
    await ready;
    socket.destroy();
    const reason = await cancelled.promise;
    await drainDoggieNodeServer(server);
    assert.ok(reason instanceof DOMException);
    assert.equal(reason.name, "AbortError");
    assert.equal(cancels, 1);
    assert.equal(stream.locked, false);
    assert.ok(requestSignal?.aborted);
    assert.equal(getEventListeners(requestSignal, "abort").length, 0);
    assertDisposed(await captured);
  },
);

test(
  "execution deadline destroys a stuck SSE response and releases its reader",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const cancelled = Promise.withResolvers<unknown>();
    const stream = new ReadableStream<Uint8Array>({
      cancel: cancelled.resolve,
    });
    const { server, port } = await fixture(
      context,
      { executionTimeoutMs: 100 },
      fakeApi(),
      () =>
        new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const captured = captureExchange(server);
    const socket = await socketFor(context, port);
    const headers = untilText(socket, "\r\n\r\n");
    const closed = once(socket, "close");
    send(socket, port);
    assert.match(await headers, /HTTP\/1\.1 200/u);
    await closed;
    const reason = await cancelled.promise;
    assert.ok(reason instanceof DOMException);
    assert.equal(reason.name, "TimeoutError");
    await drainDoggieNodeServer(server);
    assert.equal(stream.locked, false);
    assertDisposed(await captured);
  },
);

test(
  "SSE backpressure stops pulling and disconnect cleans the drain waiter",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    let pulls = 0;
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(encoder.encode(`data: ${pulls}\n\n`));
        },
        cancel() {
          cancels += 1;
        },
      },
      { highWaterMark: 0 },
    );
    const { server, port } = await fixture(
      context,
      {},
      fakeApi(),
      () =>
        new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const captured = captureExchange(server);
    server.once("request", (_incoming, outgoing) => {
      const original = outgoing.write.bind(outgoing);
      context.mock.method(outgoing, "write", (chunk: Uint8Array) => {
        original(chunk);
        return false; // deterministic backpressure, with drain controlled by test
      });
    });
    const socket = await socketFor(context, port);
    const first = untilText(socket, "data: 1\n\n");
    send(socket, port);
    await first;
    const exchange = await captured;
    assert.equal(pulls, 1);
    assert.equal(exchange.outgoing.listenerCount("drain"), 1);
    const second = untilText(socket, "data: 2\n\n");
    exchange.outgoing.emit("drain");
    await second;
    assert.equal(pulls, 2);
    const closed = once(exchange.outgoing, "close");
    socket.destroy();
    await closed;
    await drainDoggieNodeServer(server);
    assert.equal(cancels, 1);
    assert.equal(stream.locked, false);
    assertDisposed(exchange);
  },
);

test(
  "non-SSE responses remain buffered with accurate Content-Length",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const output =
      Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first"));
        output.resolve(controller);
      },
    });
    const { server, port } = await fixture(
      context,
      {},
      fakeApi(),
      () =>
        new Response(stream, {
          headers: { "Content-Type": "text/plain", "Content-Length": "999" },
        }),
    );
    const socket = await socketFor(context, port);
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    const response = untilText(socket, "firstsecond");
    send(socket, port);
    await delay(30);
    assert.equal(bytes, 0);
    const controller = await output.promise;
    controller.enqueue(encoder.encode("second"));
    controller.close();
    const result = await response;
    assert.match(result, /content-length: 11\r\n/iu);
    assert.doesNotMatch(result, /transfer-encoding/iu);
    await drainDoggieNodeServer(server);
    assert.equal(stream.locked, false);
  },
);

test(
  "normal HEAD retains GET Content-Length while sending no body",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const { server, port } = await fixture(context);
    const socket = await socketFor(context, port);
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    const closed = once(socket, "close");
    socket.write(
      `HEAD /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    await closed;
    const expected = JSON.stringify({ ok: true, service: "doggie-local-web" });
    assert.match(
      response,
      new RegExp(`content-length: ${Buffer.byteLength(expected)}\\r\\n`, "iu"),
    );
    assert.equal(response.split("\r\n\r\n")[1], "");
    await drainDoggieNodeServer(server);
  },
);

test(
  "SSE producer error after headers destroys the socket without appending JSON",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const output =
      Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        output.resolve(controller);
        controller.enqueue(encoder.encode("data: ready\n\n"));
      },
    });
    const { server, port } = await fixture(
      context,
      {},
      fakeApi(),
      () =>
        new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const captured = captureExchange(server);
    const socket = await socketFor(context, port);
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    const ready = untilText(socket, "data: ready\n\n");
    const closed = once(socket, "close");
    send(socket, port);
    await ready;
    (await output.promise).error(new Error("private stream failure"));
    await closed;
    await drainDoggieNodeServer(server);
    assert.doesNotMatch(
      response,
      /internal server error|private stream failure|"ok":false/u,
    );
    assert.equal(stream.locked, false);
    assertDisposed(await captured);
  },
);

test(
  "shutdown aborts a disconnected handler but drain waits for actual API completion",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const shutdown = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    context.after(() => release.resolve());
    const api = fakeApi(async (_request, signal) => {
      assert.ok(signal);
      started.resolve(signal);
      await release.promise; // deliberately ignores cancellation
      return { ok: true };
    });
    const { server, port } = await fixture(
      context,
      { signal: shutdown.signal },
      api,
    );
    const captured = captureExchange(server);
    const socket = await socketFor(context, port);
    const body = JSON.stringify({ message: "work still owns database" });
    socket.write(
      `POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    const signal = await started.promise;
    const exchange = await captured;
    const closed = once(exchange.outgoing, "close");
    shutdown.abort();
    server.closeAllConnections();
    await closed;
    assert.equal(signal.aborted, true);
    assert.equal(getEventListeners(shutdown.signal, "abort").length, 0);
    let drained = false;
    const draining = drainDoggieNodeServer(server).then(() => {
      drained = true;
    });
    await delay(20);
    assert.equal(drained, false, "disconnect is not handler completion");
    release.resolve();
    await draining;
    assert.equal(drained, true);
    assertDisposed(exchange);
  },
);

test(
  "already-aborted shutdown never dispatches the fake API",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const shutdown = new AbortController();
    shutdown.abort();
    let calls = 0;
    const { server, port } = await fixture(
      context,
      { signal: shutdown.signal },
      fakeApi(() => {
        calls += 1;
        return { ok: true };
      }),
    );
    const socket = await socketFor(context, port);
    const closed = once(socket, "close");
    const body = JSON.stringify({ message: "must not dispatch" });
    socket.write(
      `POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await closed;
    await drainDoggieNodeServer(server);
    assert.equal(calls, 0);
    assert.equal(getEventListeners(shutdown.signal, "abort").length, 0);
  },
);

test(
  "HEAD on SSE cancels the open stream instead of waiting for its body",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancels += 1;
      },
    });
    const { server, port } = await fixture(
      context,
      {},
      fakeApi(),
      () =>
        new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Content-Length": "999",
          },
        }),
    );
    const socket = await socketFor(context, port);
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    const closed = once(socket, "close");
    socket.write(
      `HEAD /adapter-test HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    await closed;
    await drainDoggieNodeServer(server);
    assert.match(response, /HTTP\/1\.1 200/u);
    assert.doesNotMatch(response, /content-length:/iu);
    assert.equal(response.split("\r\n\r\n")[1], "");
    assert.equal(cancels, 1);
    assert.equal(stream.locked, false);
  },
);

test(
  "deadline also cancels a stuck buffered non-SSE body before headers",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const cancelled = Promise.withResolvers<unknown>();
    const stream = new ReadableStream<Uint8Array>({
      cancel: cancelled.resolve,
    });
    const { server, port } = await fixture(
      context,
      { executionTimeoutMs: 100 },
      fakeApi(),
      () =>
        new Response(stream, {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const captured = captureExchange(server);
    const socket = await socketFor(context, port);
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    const closed = once(socket, "close");
    send(socket, port);
    await closed;
    await drainDoggieNodeServer(server);
    const reason = await cancelled.promise;
    assert.ok(reason instanceof DOMException);
    assert.equal(reason.name, "TimeoutError");
    assert.equal(bytes, 0);
    assert.equal(stream.locked, false);
    assertDisposed(await captured);
  },
);

test(
  "deadline destroys an uncooperative handler's socket, but drain waits and cancels its late response",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<unknown>();
    context.after(() => release.resolve());
    const stream = new ReadableStream<Uint8Array>({
      cancel: cancelled.resolve,
    });
    const { server, port } = await fixture(
      context,
      { executionTimeoutMs: 100 },
      fakeApi(),
      async (request) => {
        started.resolve(request.signal);
        await release.promise;
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    );
    const captured = captureExchange(server);
    const socket = await socketFor(context, port);
    const closed = once(socket, "close");
    send(socket, port);
    const signal = await started.promise;
    await closed;
    assert.equal(signal.aborted, true);
    assert.ok(signal.reason instanceof DOMException);
    assert.equal(signal.reason.name, "TimeoutError");
    let drained = false;
    const draining = drainDoggieNodeServer(server).then(() => {
      drained = true;
    });
    await delay(20);
    assert.equal(drained, false);
    release.resolve();
    await draining;
    assert.equal(await cancelled.promise, signal.reason);
    assert.equal(stream.locked, false);
    assertDisposed(await captured);
  },
);

test("executionTimeoutMs rejects invalid resource limits", () => {
  for (const executionTimeoutMs of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        createDoggieNodeServer(fakeApi(), { assets: [], executionTimeoutMs }),
      /executionTimeoutMs must be a positive safe integer/u,
    );
  }
});
