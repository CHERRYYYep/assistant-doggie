import { httpApiFixture } from "./test-fixtures.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { DoggieHttpApi } from "./app.ts";
import {
  createDoggieNodeServer,
  DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_HTTP_CONNECTIONS,
} from "./server.ts";

test("T9b applies bounded connection and request resource limits", () => {
  const defaults = createDoggieNodeServer(httpApiFixture(), { assets: [] });
  try {
    assert.equal(defaults.maxConnections, DEFAULT_MAX_HTTP_CONNECTIONS);
    assert.equal(defaults.headersTimeout, DEFAULT_HTTP_HEADERS_TIMEOUT_MS);
    assert.equal(defaults.requestTimeout, DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
    assert.equal(defaults.maxRequestsPerSocket, 1);
  } finally {
    defaults.close();
  }

  const overridden = createDoggieNodeServer(httpApiFixture(), {
    assets: [],
    maxConnections: 3,
    headersTimeoutMs: 4_000,
    requestTimeoutMs: 15_000,
  });
  try {
    assert.equal(overridden.maxConnections, 3);
    assert.equal(overridden.headersTimeout, 4_000);
    assert.equal(overridden.requestTimeout, 15_000);
  } finally {
    overridden.close();
  }
});

test("T9b rejects invalid resource limits instead of silently disabling them", () => {
  for (const options of [
    { maxConnections: 0 },
    { headersTimeoutMs: Number.NaN },
    { requestTimeoutMs: -1 },
  ]) {
    assert.throws(
      () =>
        createDoggieNodeServer(httpApiFixture(), { assets: [], ...options }),
      { name: "TypeError" },
    );
  }
});
