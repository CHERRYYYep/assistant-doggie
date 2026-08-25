/** Node HTTP adapter for the local Doggie Hono application. */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
  createDoggieApp,
  loadFrontendAssets,
  type DoggieHttpApi,
  type StaticAsset,
} from "./app.ts";
import { SECURITY_RESPONSE_HEADERS } from "./security.ts";

export const MAX_HTTP_REQUEST_BYTES = 1024 * 1024;
export const DEFAULT_MAX_HTTP_CONNECTIONS = 32;
export const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 120_000;

export type DoggieNodeServerOptions = {
  readonly assets?: readonly StaticAsset[];
  readonly maxRequestBytes?: number;
  readonly maxConnections?: number;
  readonly headersTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
};

type RequestFailure = {
  readonly kind: "request_failure";
  readonly status: 400;
  readonly message: string;
};

type ServerFailure = {
  readonly status: 400 | 500;
  readonly message: string;
};

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
  let app: ReturnType<typeof createDoggieApp> | undefined;
  let appAuthority: string | undefined;

  const server = createServer(
    {
      joinDuplicateHeaders: false,
      maxHeaderSize: maxRequestBytes,
      requireHostHeader: false,
    },
    (request, response) => {
      void handleRequest(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          writeJsonError(
            response,
            500,
            "internal server error",
            isHeadMethod(request.method),
          );
        } else {
          response.destroy(error instanceof Error ? error : undefined);
        }
      });
    },
  );

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
    try {
      validateRawHeaders(incoming.rawHeaders);
      const authority = boundAuthority(server);
      if (app === undefined || appAuthority !== authority) {
        app = createDoggieApp(api, assets, [authority]);
        appAuthority = authority;
      }
      const body = await readRequestBody(
        incoming,
        maxRequestBytes - requestHeadBytes(incoming),
        maxRequestBytes,
      );
      const request = toFetchRequest(incoming, authority, body);
      const response = await app.fetch(request);
      await writeFetchResponse(outgoing, response, incoming.method ?? "GET");
    } catch (error) {
      const failure = requestFailure(error);
      writeJsonError(
        outgoing,
        failure.status,
        failure.message,
        isHeadMethod(incoming.method),
      );
    }
  }

  return server;
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
): Promise<Buffer> {
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

    const finishFailure = (failure: RequestFailure) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      request.off("data", onData);
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
      resolve(Buffer.concat(chunks, total));
    };
    const onAborted = () =>
      finishFailure(badRequest("request ended before body"));
    const onError = () => finishFailure(badRequest("invalid request body"));

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

  return new Request(`http://${authority}${target}`, {
    method,
    headers,
    ...(decodedBody === undefined || method === "GET" || method === "HEAD"
      ? {}
      : { body: decodedBody }),
  });
}

async function writeFetchResponse(
  outgoing: ServerResponse,
  response: Response,
  method: string,
): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  outgoing.setHeader("Content-Length", body.length);
  outgoing.setHeader("Connection", "close");
  outgoing.end(method.toUpperCase() === "HEAD" ? undefined : body);
}

function writeJsonError(
  response: ServerResponse,
  status: 400 | 500,
  message: string,
  headRequest = false,
): void {
  if (response.writableEnded) return;
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
