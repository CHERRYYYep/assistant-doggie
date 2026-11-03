import assert from "node:assert/strict";
import { test } from "node:test";

import type { DoggieHttpApi } from "./app.ts";
import {
  createDoggieNodeServer,
  DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_HTTP_CONNECTIONS,
} from "./server.ts";

function fakeApi(): DoggieHttpApi {
  const ok = () => ({ ok: true });
  return {
    activeBuckets: ok,
    searchBuckets: ok,
    chatHistory: ok,
    memoryQuery: ok,
    memoryQueryJson: ok,
    bucketDetail: ok,
    deleteBucket: ok,
    revokeEntry: ok,
    archive: ok,
    chat: ok,
    confirmChat: ok,
    appendConfirmed: ok,
    createConfirmed: ok,
    moveEntry: ok,
    setBucketStatus: ok,
  };
}

test("T9b applies bounded connection and request resource limits", () => {
  const defaults = createDoggieNodeServer(fakeApi(), { assets: [] });
  try {
    assert.equal(defaults.maxConnections, DEFAULT_MAX_HTTP_CONNECTIONS);
    assert.equal(defaults.headersTimeout, DEFAULT_HTTP_HEADERS_TIMEOUT_MS);
    assert.equal(defaults.requestTimeout, DEFAULT_HTTP_REQUEST_TIMEOUT_MS);
    assert.equal(defaults.maxRequestsPerSocket, 1);
  } finally {
    defaults.close();
  }

  const overridden = createDoggieNodeServer(fakeApi(), {
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
      () => createDoggieNodeServer(fakeApi(), { assets: [], ...options }),
      { name: "TypeError" },
    );
  }
});
