import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { DoggieHttpApi } from "./app.ts";
import { createDoggieNodeServer, MAX_HTTP_REQUEST_BYTES } from "./server.ts";
import { SECURITY_RESPONSE_HEADERS } from "./security.ts";

type RawResponse = {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Buffer;
};

function fakeApi(chatMessages: string[] = []): DoggieHttpApi {
  const ok = () => ({ ok: true });
  return {
    activeBuckets: () => ({ ok: true, buckets: [] }),
    searchBuckets: ok,
    chatHistory: ok,
    memoryQuery: (query) => ({ ok: true, query }),
    memoryQueryJson: ok,
    bucketDetail: ok,
    deleteBucket: ok,
    archive: ok,
    chat: (request) => {
      chatMessages.push(request.message);
      return { ok: true, echoed: request.message };
    },
    confirmChat: ok,
    appendConfirmed: ok,
    createConfirmed: ok,
    moveEntry: ok,
    setBucketStatus: ok,
  };
}

async function withServer<T>(
  api: DoggieHttpApi,
  action: (port: number, authority: string) => Promise<T>,
  maxRequestBytes = MAX_HTTP_REQUEST_BYTES,
): Promise<T> {
  const server = createDoggieNodeServer(api, { assets: [], maxRequestBytes });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    return await action(address.port, `${address.address}:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function rawRequest(
  port: number,
  request: string | Buffer,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.setTimeout(5_000, () => socket.destroy(new Error("socket timeout")));
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(parseRawResponse(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseRawResponse(response: Buffer): RawResponse {
  const separator = response.indexOf("\r\n\r\n");
  assert.notEqual(separator, -1, response.toString("utf8"));
  const head = response.subarray(0, separator).toString("latin1");
  const lines = head.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const status = Number(/^HTTP\/1\.1 ([0-9]{3})/u.exec(statusLine)?.[1]);
  assert.equal(Number.isInteger(status), true, statusLine);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    headers.set(
      line.slice(0, separatorIndex).toLowerCase(),
      line.slice(separatorIndex + 1).trim(),
    );
  }
  return {
    status,
    headers,
    body: response.subarray(separator + 4),
  };
}

function assertSecurityHeaders(response: RawResponse): void {
  for (const [name, value] of Object.entries(SECURITY_RESPONSE_HEADERS)) {
    assert.equal(response.headers.get(name.toLowerCase()), value, name);
  }
  assert.equal(response.headers.has("access-control-allow-origin"), false);
}

test("real socket enforces missing, duplicate, foreign and bound Host authorities", async () => {
  await withServer(fakeApi(), async (port, authority) => {
    const missing = await rawRequest(
      port,
      "GET /health HTTP/1.1\r\nConnection: close\r\n\r\n",
    );
    assert.equal(missing.status, 400);
    assertSecurityHeaders(missing);

    const duplicate = await rawRequest(
      port,
      "GET /health HTTP/1.1\r\nHost: localhost\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    assert.equal(duplicate.status, 400);
    assertSecurityHeaders(duplicate);

    const foreign = await rawRequest(
      port,
      "GET /health HTTP/1.1\r\nHost: doggie.evil.example\r\nConnection: close\r\n\r\n",
    );
    assert.equal(foreign.status, 403);
    assertSecurityHeaders(foreign);

    const bound = await rawRequest(
      port,
      `GET /health HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(bound.status, 200);
    assert.deepEqual(JSON.parse(bound.body.toString("utf8")), {
      ok: true,
      service: "doggie-local-web",
    });
    assertSecurityHeaders(bound);
  });
});

test("real socket rejects duplicate and foreign Origin before write dispatch", async () => {
  const messages: string[] = [];
  await withServer(fakeApi(messages), async (port, authority) => {
    const body = JSON.stringify({ message: "blocked" });
    const duplicate = await rawRequest(
      port,
      `POST /api/chat HTTP/1.1\r\nHost: ${authority}\r\nOrigin: http://localhost\r\nOrigin: http://127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    assert.equal(duplicate.status, 400);
    assertSecurityHeaders(duplicate);

    const foreign = await rawRequest(
      port,
      `POST /api/chat HTTP/1.1\r\nHost: ${authority}\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    assert.equal(foreign.status, 403);
    assert.deepEqual(messages, []);
    assertSecurityHeaders(foreign);
  });
});

test("real socket accepts chunked UTF-8 JSON without an Origin", async () => {
  const messages: string[] = [];
  await withServer(fakeApi(messages), async (port, authority) => {
    const body = Buffer.from(JSON.stringify({ message: "接口 A 已恢复" }));
    const request = Buffer.concat([
      Buffer.from(
        `POST /api/chat HTTP/1.1\r\nHost: ${authority}\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n${body.length.toString(16)}\r\n`,
      ),
      body,
      Buffer.from("\r\n0\r\n\r\n"),
    ]);
    const response = await rawRequest(port, request);
    assert.equal(response.status, 200);
    assert.deepEqual(messages, ["接口 A 已恢复"]);
    assertSecurityHeaders(response);
  });
});

test("real socket requires JSON for GET and HEAD bodies before read dispatch", async () => {
  let readCalls = 0;
  const api = {
    ...fakeApi(),
    activeBuckets: () => {
      readCalls += 1;
      return { ok: true, buckets: [] };
    },
  };
  await withServer(api, async (port, authority) => {
    for (const method of ["GET", "HEAD"]) {
      for (const chunked of [false, true]) {
        for (const contentType of [
          undefined,
          "text/plain",
          "application/json; charset=utf-16",
          "application/json, text/plain",
          "application/json",
          "Application/JSON; Charset=UTF-8",
        ]) {
          const accepted =
            contentType === "application/json" ||
            contentType === "Application/JSON; Charset=UTF-8";
          const previousCalls = readCalls;
          const response = await rawRequest(
            port,
            `${method} /api/buckets/active HTTP/1.1\r\nHost: ${authority}\r\n` +
              (contentType === undefined
                ? ""
                : `Content-Type: ${contentType}\r\n`) +
              (chunked
                ? "Transfer-Encoding: chunked\r\n"
                : "Content-Length: 2\r\n") +
              "Connection: close\r\n\r\n" +
              (chunked ? "2\r\n{}\r\n0\r\n\r\n" : "{}"),
          );
          const context = `${method} chunked=${chunked} ${contentType}`;
          assert.equal(response.status, accepted ? 200 : 415, context);
          assert.equal(readCalls, previousCalls + Number(accepted), context);
          assertSecurityHeaders(response);
          if (method === "HEAD") {
            assert.equal(response.body.length, 0, context);
          } else if (!accepted) {
            assert.deepEqual(JSON.parse(response.body.toString("utf8")), {
              ok: false,
              error: "request body must use Content-Type: application/json",
            });
          }
        }
      }
    }
  });
});

test("real socket rejects duplicate Content-Type on reads and allows empty framed bodies", async () => {
  await withServer(fakeApi(), async (port, authority) => {
    for (const method of ["GET", "HEAD"]) {
      const duplicate = await rawRequest(
        port,
        `${method} /health HTTP/1.1\r\nHost: ${authority}\r\n` +
          "Content-Type: application/json\r\nContent-Type: text/plain\r\n" +
          "Content-Length: 2\r\nConnection: close\r\n\r\n{}",
      );
      assert.equal(duplicate.status, 400);
      assertSecurityHeaders(duplicate);
      if (method === "HEAD") assert.equal(duplicate.body.length, 0);

      for (const chunked of [false, true]) {
        const empty = await rawRequest(
          port,
          `${method} /health HTTP/1.1\r\nHost: ${authority}\r\n` +
            (chunked
              ? "Transfer-Encoding: chunked\r\n"
              : "Content-Length: 0\r\n") +
            "Connection: close\r\n\r\n" +
            (chunked ? "0\r\n\r\n" : ""),
        );
        assert.equal(empty.status, 200);
        assertSecurityHeaders(empty);
        if (method === "HEAD") assert.equal(empty.body.length, 0);
      }
    }
  });
});

test("real socket rejects conflicting Content-Length framing with a safe response", async () => {
  await withServer(fakeApi(), async (port, authority) => {
    const response = await rawRequest(
      port,
      `POST /api/chat HTTP/1.1\r\nHost: ${authority}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 3\r\nConnection: close\r\n\r\n{}`,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body.toString("utf8")), {
      ok: false,
      error: "invalid HTTP request",
    });
    assertSecurityHeaders(response);
  });
});

test("real socket rejects unsupported transfer codings", async () => {
  await withServer(fakeApi(), async (port, authority) => {
    const response = await rawRequest(
      port,
      `POST /api/chat HTTP/1.1\r\nHost: ${authority}\r\nTransfer-Encoding: gzip, chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(response.status, 400);
    assertSecurityHeaders(response);
  });
});

test("real socket enforces the one MiB total request limit", async () => {
  await withServer(fakeApi(), async (port, authority) => {
    const body = Buffer.alloc(MAX_HTTP_REQUEST_BYTES, 0x20);
    const head = Buffer.from(
      `POST /api/chat HTTP/1.1\r\nHost: ${authority}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
    );
    const response = await rawRequest(port, Buffer.concat([head, body]));
    assert.equal(response.status, 400);
    assert.match(response.body.toString("utf8"), /request is too large/u);
    assertSecurityHeaders(response);
  });
});

test("real socket counts chunk framing toward the request limit", async () => {
  const maxRequestBytes = 512;
  await withServer(
    fakeApi(),
    async (port, authority) => {
      const payload = `{"message":"${"x".repeat(60)}"}`;
      const chunks = [...Buffer.from(payload)]
        .map((byte) => `1\r\n${String.fromCharCode(byte)}\r\n`)
        .join("");
      const request =
        `POST /api/chat HTTP/1.1\r\nHost: ${authority}\r\n` +
        "Transfer-Encoding: chunked\r\nContent-Type: application/json\r\n" +
        `Connection: close\r\n\r\n${chunks}0\r\n\r\n`;
      assert.ok(Buffer.byteLength(request) > maxRequestBytes);
      assert.ok(Buffer.byteLength(payload) < maxRequestBytes);

      const response = await rawRequest(port, request);
      assert.equal(response.status, 400);
      assert.match(response.body.toString("utf8"), /request is too large/u);
      assertSecurityHeaders(response);
    },
    maxRequestBytes,
  );
});

test("real socket rejects a non-UTF-8 request body", async () => {
  await withServer(fakeApi(), async (port, authority) => {
    const head = Buffer.from(
      `POST /api/chat HTTP/1.1\r\nHost: ${authority}\r\nContent-Type: application/json\r\nContent-Length: 1\r\nConnection: close\r\n\r\n`,
    );
    const response = await rawRequest(
      port,
      Buffer.concat([head, Buffer.from([0xff])]),
    );
    assert.equal(response.status, 400);
    assert.match(response.body.toString("utf8"), /not UTF-8/u);
    assertSecurityHeaders(response);
  });
});

test("real socket writes no response body for HEAD", async () => {
  await withServer(fakeApi(), async (port, authority) => {
    const response = await rawRequest(
      port,
      `HEAD /health HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 0);
    assertSecurityHeaders(response);
  });
});

test("adapter-level HEAD errors do not send a response body", async () => {
  await withServer(fakeApi(), async (port) => {
    const response = await rawRequest(
      port,
      "HEAD /health HTTP/1.1\r\nConnection: close\r\n\r\n",
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.length, 0);
    assertSecurityHeaders(response);
  });
});

test("parser-level HEAD errors do not send a response body", async () => {
  await withServer(fakeApi(), async (port) => {
    const response = await rawRequest(
      port,
      "HEAD /health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n",
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.length, 0);
    assertSecurityHeaders(response);
  });
});
