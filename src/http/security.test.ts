import { httpApiFixture } from "./test-fixtures.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import { createDoggieApp, type DoggieHttpApi } from "./app.ts";
import {
  assertSecureRequest,
  AuthorityPolicy,
  CONTENT_SECURITY_POLICY,
  SECURITY_RESPONSE_HEADERS,
} from "./security.ts";

const policy = new AuthorityPolicy();

function secureRequest(
  method: string,
  headers: ConstructorParameters<typeof Headers>[0] = {},
  body?: string,
): Request {
  return new Request("http://127.0.0.1:8787/api/test", {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function errorFrom(request: Request): {
  readonly status: number;
  readonly message: string;
} {
  try {
    assertSecureRequest(request, policy);
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok("status" in error && typeof error.status === "number");
    return { status: error.status, message: error.message };
  }
  assert.fail("expected the request to be rejected");
}

test("authority policy accepts loopback aliases and an explicitly bound authority", () => {
  const withBoundAddress = new AuthorityPolicy(["192.0.2.4:8787"]);
  for (const authority of [
    "localhost",
    "LOCALHOST:8787",
    "127.0.0.1:8787",
    "127.42.7.9",
    "::1",
    "[::1]:8787",
    "192.0.2.4:8787",
  ]) {
    assert.equal(withBoundAddress.allowsAuthority(authority), true, authority);
  }
  assert.equal(withBoundAddress.allowsOrigin("http://localhost:9999"), true);
  assert.equal(withBoundAddress.allowsOrigin("https://127.0.0.2"), true);
});

test("authority policy rejects foreign, wildcard, userinfo and suffix tricks", () => {
  for (const authority of [
    "",
    "evil.example",
    "localhost.evil.example",
    "127.0.0.1.evil.example",
    "user@localhost:8787",
    "0.0.0.0:8787",
    "[::]:8787",
    "10.0.0.5:8787",
    "localhost/path",
    "localhost:0",
    "localhost:65536",
  ]) {
    assert.equal(policy.allowsAuthority(authority), false, authority);
  }
  for (const origin of [
    "null",
    "http://evil.example",
    "http://evil.example/127.0.0.1:8787",
    "http://user@localhost:8787",
    "file://localhost",
    "http://localhost:8787/",
  ]) {
    assert.equal(policy.allowsOrigin(origin), false, origin);
  }
});

test("Host is mandatory, singular and checked on read requests", () => {
  assert.deepEqual(errorFrom(secureRequest("GET")), {
    status: 400,
    message: "HTTP/1.1 requires a Host header",
  });

  const duplicateHeaders = new Headers();
  duplicateHeaders.append("Host", "localhost");
  duplicateHeaders.append("Host", "127.0.0.1");
  assert.equal(errorFrom(secureRequest("GET", duplicateHeaders)).status, 400);
  assert.equal(
    errorFrom(secureRequest("GET", { Host: "doggie.evil.example" })).status,
    403,
  );
  assert.equal(
    errorFrom(secureRequest("GET", { Host: "localhost/path" })).status,
    400,
  );
  assert.doesNotThrow(() =>
    assertSecureRequest(
      secureRequest("GET", { Host: "127.9.8.7:8787" }),
      policy,
    ),
  );
});

test("state changes reject duplicate, opaque and foreign origins but allow CLI requests", () => {
  const jsonHeaders = {
    Host: "127.0.0.1:8787",
    "Content-Type": "application/json",
  };
  assert.doesNotThrow(() =>
    assertSecureRequest(secureRequest("POST", jsonHeaders, "{}"), policy),
  );
  assert.doesNotThrow(() =>
    assertSecureRequest(
      secureRequest("GET", {
        Host: "localhost:8787",
        Origin: "http://evil.example",
      }),
      policy,
    ),
  );
  assert.doesNotThrow(() =>
    assertSecureRequest(
      secureRequest(
        "POST",
        { ...jsonHeaders, Origin: "http://localhost:9999" },
        "{}",
      ),
      policy,
    ),
  );
  assert.equal(
    errorFrom(secureRequest("POST", { ...jsonHeaders, Origin: "null" }, "{}"))
      .status,
    403,
  );
  assert.equal(
    errorFrom(
      secureRequest(
        "POST",
        { ...jsonHeaders, Origin: "http://evil.example" },
        "{}",
      ),
    ).status,
    403,
  );

  const duplicateHeaders = new Headers(jsonHeaders);
  duplicateHeaders.append("Origin", "http://localhost");
  duplicateHeaders.append("Origin", "http://127.0.0.1");
  assert.equal(
    errorFrom(secureRequest("POST", duplicateHeaders, "{}")).status,
    400,
  );
});

test("body-bearing writes require the narrow JSON media types", () => {
  for (const contentType of [
    "application/json",
    "application/json; charset=utf-8",
    "Application/JSON; Charset=UTF-8",
  ]) {
    assert.doesNotThrow(() =>
      assertSecureRequest(
        secureRequest(
          "POST",
          { Host: "localhost:8787", "Content-Type": contentType },
          "{}",
        ),
        policy,
      ),
    );
  }
  for (const contentType of [
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
    "application/json; charset=utf-16",
    "application/json; profile=test",
  ]) {
    assert.equal(
      errorFrom(
        secureRequest(
          "POST",
          { Host: "localhost:8787", "Content-Type": contentType },
          "{}",
        ),
      ).status,
      415,
      contentType,
    );
  }
  assert.equal(
    errorFrom(secureRequest("POST", { Host: "localhost:8787" }, "{}")).status,
    415,
  );
  assert.doesNotThrow(() =>
    assertSecureRequest(
      secureRequest("DELETE", {
        Host: "localhost:8787",
        Origin: "http://localhost:8787",
      }),
      policy,
    ),
  );
  assert.equal(
    errorFrom(
      secureRequest(
        "DELETE",
        { Host: "localhost:8787", "Content-Type": "text/plain" },
        "{}",
      ),
    ).status,
    415,
  );
});

test("security rejection happens before write-route dispatch", async () => {
  let chatCalls = 0;
  const app = createDoggieApp(
    {
      ...httpApiFixture(),
      chat: () => {
        chatCalls += 1;
        return httpApiFixture().chat({ message: "fixture" });
      },
    },
    [],
  );
  const response = await app.request("http://127.0.0.1:8787/api/chat", {
    method: "POST",
    headers: {
      Host: "127.0.0.1:8787",
      Origin: "http://evil.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: "must not persist" }),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "cross-origin state change is not allowed",
  });
  assert.equal(chatCalls, 0);
});

test("all Hono responses carry the security headers without CORS relaxation", async () => {
  const app = createDoggieApp(httpApiFixture(), [
    { path: "/", contentType: "text/html; charset=utf-8", body: "Doggie" },
  ]);
  const failingApp = createDoggieApp(
    {
      ...httpApiFixture(),
      activeBuckets: () => {
        throw new Error("fixture failure");
      },
    },
    [],
  );
  const cases = [
    await app.request("http://127.0.0.1:8787/", {
      headers: { Host: "127.0.0.1:8787" },
    }),
    await app.request("http://127.0.0.1:8787/missing", {
      headers: { Host: "127.0.0.1:8787" },
    }),
    await app.request("http://127.0.0.1:8787/", {
      method: "HEAD",
      headers: { Host: "127.0.0.1:8787" },
    }),
    await app.request("http://127.0.0.1:8787/"),
    await app.request("http://127.0.0.1:8787/", {
      headers: { Host: "evil.example" },
    }),
    await app.request("http://127.0.0.1:8787/api/chat", {
      method: "POST",
      headers: { Host: "localhost", "Content-Type": "text/plain" },
      body: "{}",
    }),
    await failingApp.request("http://127.0.0.1:8787/api/buckets/active", {
      headers: { Host: "localhost" },
    }),
  ];

  assert.deepEqual(
    cases.map((response) => response.status),
    [200, 404, 200, 400, 403, 415, 500],
  );
  for (const response of cases) {
    for (const [name, value] of Object.entries(SECURITY_RESPONSE_HEADERS)) {
      assert.equal(
        response.headers.get(name),
        value,
        `${response.status} ${name}`,
      );
    }
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(CONTENT_SECURITY_POLICY.includes("unsafe-inline"), false);
  assert.equal(CONTENT_SECURITY_POLICY.includes("unsafe-eval"), false);
});
