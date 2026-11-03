/** Node HTTP adapter for the local Doggie Hono application. */

import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { finished } from "node:stream/promises";

import type { TaskQueue } from "../application/task-queue.ts";

import {
  createDoggieApp,
  loadFrontendAssets,
  type DoggieHttpApi,
  type StaticAsset,
} from "./app.ts";
import { HttpBoundaryError } from "./contracts.ts";
import {
  assertJsonBodyContentType,
  SECURITY_RESPONSE_HEADERS,
} from "./security.ts";

export const MAX_HTTP_REQUEST_BYTES = 1024 * 1024;
export const DEFAULT_MAX_HTTP_CONNECTIONS = 32;
export const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_HTTP_EXECUTION_TIMEOUT_MS = 120_000;

export type DoggieNodeServerOptions = {
  readonly assets?: readonly StaticAsset[];
  readonly maxRequestBytes?: number;
  readonly maxConnections?: number;
  readonly headersTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly tasks?: TaskQueue;
};

type RequestFailure = {
  readonly kind: "request_failure";
  readonly status: 400;
  readonly message: string;
};

type ServerFailure = {
  readonly status: 400 | 415 | 500;
  readonly message: string;
};

const activeHandlers = new WeakMap<Server, Set<Promise<void>>>();

/** Call after stopping new connections, and before closing the database. */
export async function drainDoggieNodeServer(server: Server): Promise<void> {
  const handlers = activeHandlers.get(server);
  if (handlers === undefined) return;
  // Disconnect/deadline only abort the signal, not the actual handler promise.
  // A handler ignoring cancellation must finish before database teardown.
  while (handlers.size > 0) {
    await Promise.allSettled([...handlers]);
  }
}

export function createDoggieNodeServer(
  api: DoggieHttpApi,
  options: DoggieNodeServerOptions = {},
): Server {
  const assets = options.assets ?? loadFrontendAssets();
  const maxRequestBytes = options.maxRequestBytes ?? MAX_HTTP_REQUEST_BYTES;
  const maxConnections = positiveInteger(
    options.maxConnections ?? DEFAULT_MAX_HTTP_CONNECTIONS,
    "maxConnections",
  );
  const headersTimeoutMs = positiveInteger(
    options.headersTimeoutMs ?? DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
    "headersTimeoutMs",
  );
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
  );
  const executionTimeoutMs = positiveInteger(
    options.executionTimeoutMs ?? DEFAULT_HTTP_EXECUTION_TIMEOUT_MS,
    "executionTimeoutMs",
  );
  let app: ReturnType<typeof createDoggieApp> | undefined;
  let appAuthority: string | undefined;

  const handlers = new Set<Promise<void>>();
  const server = createServer(
    {
      joinDuplicateHeaders: false,
      maxHeaderSize: maxRequestBytes,
      requireHostHeader: false,
    },
    async (request, response) => {
      const handler = handleRequest(request, response);
      handlers.add(handler);
      try {
        await handler;
      } catch {
        if (!response.destroyed) {
          if (response.headersSent) response.destroy();
          else {
            writeJsonError(
              response,
              500,
              "internal server error",
              isHeadMethod(request.method),
            );
          }
        }
      } finally {
        handlers.delete(handler);
      }
    },
  );

  activeHandlers.set(server, handlers);

  // Keep the local MVP bounded even when a browser tab or a faulty client
  // opens many sockets. Node's parser still owns HTTP framing; these are
  // service-level resource limits rather than a second HTTP implementation.
  server.maxConnections = maxConnections;
  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  server.maxRequestsPerSocket = 1;
  server.on("clientError", (error, socket) => {
    writeSocketError(
      socket,
      400,
      "invalid HTTP request",
      isHeadRequest(rawPacketFrom(error)),
    );
  });

  async function handleRequest(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): Promise<void> {
    const lifecycle = requestLifecycle(
      incoming,
      outgoing,
      executionTimeoutMs,
      options.signal,
    );
    try {
      validateRawHeaders(incoming.rawHeaders);
      const authority = boundAuthority(server);
      if (app === undefined || appAuthority !== authority) {
        app = createDoggieApp(api, assets, [authority], options.tasks);
        appAuthority = authority;
      }
      const body = await readRequestBody(
        incoming,
        maxRequestBytes - requestHeadBytes(incoming),
        maxRequestBytes,
        lifecycle.signal,
      );
      const request = toFetchRequest(
        incoming,
        authority,
        body,
        lifecycle.signal,
      );
      const response = await app.fetch(request);
      await writeFetchResponse(
        outgoing,
        response,
        incoming.method ?? "GET",
        lifecycle.signal,
      );
    } catch (error) {
      if (lifecycle.signal.aborted || outgoing.destroyed) return;
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      const failure = requestFailure(error);
      const completion = finished(outgoing, { cleanup: true });
      writeJsonError(
        outgoing,
        failure.status,
        failure.message,
        isHeadMethod(incoming.method),
      );
      await completion.catch(() => {});
    } finally {
      lifecycle.dispose();
    }
  }

  return server;
}

/** A completed request body is not a disconnect: IncomingMessage.close is normal. */
function requestLifecycle(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  executionTimeoutMs: number,
  shutdownSignal: AbortSignal | undefined,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const dispose = (): void => {
    clearTimeout(deadline);
    incoming.off("aborted", onAborted);
    outgoing.off("close", onClose);
    outgoing.off("error", onError);
    shutdownSignal?.removeEventListener("abort", onShutdown);
  };
  const abort = (reason: unknown): void => {
    controller.abort(reason);
    dispose();
  };
  const onAborted = (): void =>
    abort(new DOMException("HTTP request disconnected", "AbortError"));
  const onClose = (): void => {
    if (!outgoing.writableFinished) onAborted();
    else dispose();
  };
  const onError = (): void => {
    onAborted();
    outgoing.destroy();
  };
  const onShutdown = (): void => {
    abort(shutdownSignal?.reason);
    outgoing.destroy();
  };
  const deadline = setTimeout(() => {
    abort(new DOMException("HTTP execution deadline exceeded", "TimeoutError"));
    // Destroy even when the handler or a stream producer ignores cancellation.
    // No Error argument: never emit an unhandled socket error or expose details.
    outgoing.destroy();
  }, executionTimeoutMs);
  deadline.unref();
  incoming.once("aborted", onAborted);
  outgoing.once("close", onClose);
  outgoing.once("error", onError);
  shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  if (shutdownSignal?.aborted) onShutdown();
  return { signal: controller.signal, dispose };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateRawHeaders(rawHeaders: readonly string[]): void {
  const occurrences = new Map<string, string[]>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    const value = rawHeaders[index + 1];
    if (name === undefined || value === undefined) continue;
    const values = occurrences.get(name) ?? [];
    values.push(value);
    occurrences.set(name, values);
  }

  const hosts = occurrences.get("host") ?? [];
  if (hosts.length === 0) {
    throw badRequest("HTTP/1.1 requires a Host header");
  }
  if (hosts.length !== 1)
    throw badRequest("multiple Host headers are not allowed");
  if ((occurrences.get("origin")?.length ?? 0) > 1) {
    throw badRequest("multiple Origin headers are not allowed");
  }
  if ((occurrences.get("content-type")?.length ?? 0) > 1) {
    throw badRequest("multiple Content-Type headers are not allowed");
  }
  if ((occurrences.get("content-length")?.length ?? 0) > 1) {
    throw badRequest("multiple Content-Length headers are not allowed");
  }
  if (
    occurrences.has("content-length") &&
    occurrences.has("transfer-encoding")
  ) {
    throw badRequest("Content-Length and Transfer-Encoding cannot be combined");
  }
  const transferEncodings = occurrences.get("transfer-encoding") ?? [];
  if (transferEncodings.length > 1) {
    throw badRequest("multiple Transfer-Encoding headers are not allowed");
  }
  if (
    transferEncodings.length === 1 &&
    transferEncodings[0]?.trim().toLowerCase() !== "chunked"
  ) {
    throw badRequest("Transfer-Encoding must be chunked");
  }
}

function requestHeadBytes(request: IncomingMessage): number {
  let size = Buffer.byteLength(
    `${request.method ?? ""} ${request.url ?? ""} HTTP/${request.httpVersion}\r\n`,
  );
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    size += Buffer.byteLength(
      `${request.rawHeaders[index] ?? ""}: ${request.rawHeaders[index + 1] ?? ""}\r\n`,
    );
  }
  return size + 2;
}

function readRequestBody(
  request: IncomingMessage,
  remainingBytes: number,
  maxRequestBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  if (remainingBytes < 0 || request.socket.bytesRead > maxRequestBytes) {
    request.resume();
    return Promise.reject(badRequest("request is too large"));
  }

  const declaredLength = request.headers["content-length"];
  if (
    declaredLength !== undefined &&
    Number.parseInt(declaredLength, 10) > remainingBytes
  ) {
    request.resume();
    return Promise.reject(badRequest("request is too large"));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const dispose = (): void => {
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      request.off("data", onData);
      signal.removeEventListener("abort", onCancellation);
    };
    const finishFailure = (failure: RequestFailure) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      dispose();
      request.resume();
      reject(failure);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (
        total > remainingBytes ||
        request.socket.bytesRead > maxRequestBytes
      ) {
        finishFailure(badRequest("request is too large"));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      dispose();
      resolve(Buffer.concat(chunks, total));
    };
    const onAborted = () =>
      finishFailure(badRequest("request ended before body"));
    const onError = () => finishFailure(badRequest("invalid request body"));
    const onCancellation = () => finishFailure(badRequest("request cancelled"));

    signal.addEventListener("abort", onCancellation, { once: true });
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function toFetchRequest(
  incoming: IncomingMessage,
  authority: string,
  body: Buffer,
  signal: AbortSignal,
): Request {
  const method = incoming.method ?? "GET";
  const target = incoming.url ?? "/";
  if (!target.startsWith("/")) throw badRequest("invalid HTTP request target");

  let decodedBody: string | undefined;
  if (body.length > 0) {
    try {
      decodedBody = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw badRequest("request body is not UTF-8");
    }
  }

  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }

  // Fetch forbids GET/HEAD bodies, so validate their actual wire body first.
  if (method === "GET" || method === "HEAD") {
    assertJsonBodyContentType(headers, body.length > 0);
  }

  return new Request(`http://${authority}${target}`, {
    // Hono discards HEAD bodies before returning them. Dispatch as GET so the
    // adapter can compute the representation length, then suppress wire bytes.
    method: method.toUpperCase() === "HEAD" ? "GET" : method,
    headers,
    signal,
    ...(decodedBody === undefined || method === "GET" || method === "HEAD"
      ? {}
      : { body: decodedBody }),
  });
}

async function writeFetchResponse(
  outgoing: ServerResponse,
  response: Response,
  method: string,
  signal: AbortSignal,
): Promise<void> {
  const streaming =
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() === "text/event-stream";
  const reader = response.body?.getReader();
  let complete = reader === undefined;
  let cancelled = false;
  const cancelReader = (): void => {
    if (reader === undefined || complete || cancelled) return;
    cancelled = true;
    // A producer's cancel hook may itself stall. Initiate and observe it, but
    // never let it hold the socket or lifecycle listeners past cancellation.
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Buffer[] = [];
    if (streaming) {
      setResponseHeaders(outgoing, response);
      outgoing.removeHeader("Content-Length");
      outgoing.flushHeaders();
    }
    // HEAD on an SSE route must not wait for an indefinitely open event stream.
    if (streaming && isHeadMethod(method)) {
      cancelReader();
    } else if (reader !== undefined) {
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) {
          complete = true;
          break;
        }
        if (streaming) {
          if (!outgoing.write(chunk.value)) {
            await once(outgoing, "drain", { signal });
          }
        } else {
          chunks.push(Buffer.from(chunk.value));
        }
      }
    }
    signal.throwIfAborted();
    const body = streaming ? undefined : Buffer.concat(chunks);
    if (body !== undefined) {
      setResponseHeaders(outgoing, response);
      outgoing.setHeader("Content-Length", body.length);
    }
    const completion = finished(outgoing, { cleanup: true });
    outgoing.end(isHeadMethod(method) ? undefined : body);
    await completion;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    cancelReader();
    reader?.releaseLock();
  }
}

function setResponseHeaders(
  outgoing: ServerResponse,
  response: Response,
): void {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  outgoing.setHeader("Connection", "close");
}

function writeJsonError(
  response: ServerResponse,
  status: ServerFailure["status"],
  message: string,
  headRequest = false,
): void {
  if (response.writableEnded || response.destroyed) return;
  const body = Buffer.from(JSON.stringify({ ok: false, error: message }));
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(SECURITY_RESPONSE_HEADERS)) {
    response.setHeader(name, value);
  }
  response.setHeader("Content-Length", body.length);
  response.setHeader("Connection", "close");
  response.end(headRequest ? undefined : body);
}

function writeSocketError(
  socket: Duplex,
  status: 400,
  message: string,
  headRequest: boolean,
): void {
  if (!socket.writable) return;
  const body = Buffer.from(JSON.stringify({ ok: false, error: message }));
  const headers = Object.entries(SECURITY_RESPONSE_HEADERS)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const bodyHeaders = headRequest
    ? "Content-Length: 0\r\n"
    : `Content-Length: ${body.length}\r\n`;
  const responseBody = headRequest ? "" : body.toString("utf8");
  socket.end(
    `HTTP/1.1 ${status} Bad Request\r\nContent-Type: application/json; charset=utf-8\r\n${headers}${bodyHeaders}Connection: close\r\n\r\n${responseBody}`,
  );
}

function isHeadMethod(method: string | undefined): boolean {
  return method?.toUpperCase() === "HEAD";
}

function rawPacketFrom(error: Error): Buffer | undefined {
  if (!("rawPacket" in error)) return undefined;
  return Buffer.isBuffer(error.rawPacket) ? error.rawPacket : undefined;
}

function isHeadRequest(rawPacket: Buffer | undefined): boolean {
  return (
    rawPacket !== undefined && /^HEAD\s/iu.test(rawPacket.toString("latin1"))
  );
}

function boundAuthority(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Doggie HTTP server is not bound to an IP socket");
  }
  return authorityForAddress(address);
}

function authorityForAddress(address: AddressInfo): string {
  return address.family === "IPv6"
    ? `[${address.address}]:${address.port}`
    : `${address.address}:${address.port}`;
}

function badRequest(message: string): RequestFailure {
  return { kind: "request_failure", status: 400, message };
}

function requestFailure(error: unknown): ServerFailure {
  if (error instanceof HttpBoundaryError && error.status === 415) {
    return { status: 415, message: error.message };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    error.kind === "request_failure" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return { status: 400, message: error.message };
  }
  return { status: 500, message: "internal server error" };
}
