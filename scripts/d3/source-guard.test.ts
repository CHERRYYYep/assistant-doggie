import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  CoreClient,
  ExperimentError,
  localEndpoint,
  messageSchema,
} from "./client.ts";
import {
  NON_SOURCES,
  SYNTHETIC_ENTRIES,
  SYNTHETIC_QUERIES,
  WORK_ITEM_CASES,
} from "./fixtures.ts";
import {
  admitL0,
  scoreSources,
  type Binding,
  type Source,
} from "./source-guard.ts";
import { resolveWorkItem } from "../../src/domain/work-item.ts";

const scope = {
  team_id: "d3-team",
  agent_id: "d3-agent",
  user_id: "d3-user",
} as const;
const source: Source = {
  id: "entry-1",
  bucket: "payments",
  text: "order-latency is 120ms",
  active: true,
  version: 2,
};
const binding: Binding = {
  remoteId: "remote-1",
  sourceId: source.id,
  sourceVersion: source.version,
  session: "session-1",
  epoch: 3,
  scope,
};
const snapshot = { epoch: 3, revision: 8, ready: true } as const;
const candidate = messageSchema.parse({
  id: binding.remoteId,
  version: "v1",
  role: "user",
  content: source.text,
  session_id: binding.session,
  ...scope,
});

test("L0 admission requires exactly one current, active, exact source binding", () => {
  assert.deepEqual(
    admitL0([candidate], [binding], [source], scope, snapshot, snapshot),
    [{ sourceId: source.id, text: source.text }],
  );
  assert.deepEqual(
    admitL0(
      [candidate],
      [binding, binding],
      [source],
      scope,
      snapshot,
      snapshot,
    ),
    [],
  );
  assert.deepEqual(
    admitL0([candidate], [], [source], scope, snapshot, snapshot),
    [],
  );
  assert.deepEqual(
    admitL0(
      [candidate],
      [binding],
      [{ ...source, active: false }],
      scope,
      snapshot,
      snapshot,
    ),
    [],
  );
  assert.deepEqual(
    admitL0(
      [candidate],
      [binding],
      [{ ...source, version: 3 }],
      scope,
      snapshot,
      snapshot,
    ),
    [],
  );
  assert.deepEqual(
    admitL0([candidate], [binding], [source], scope, snapshot, {
      ...snapshot,
      revision: 9,
    }),
    [],
  );
  assert.deepEqual(
    admitL0([candidate], [binding], [source], scope, snapshot, {
      ...snapshot,
      epoch: 4,
    }),
    [],
  );
  assert.deepEqual(
    admitL0(
      [candidate],
      [binding],
      [source],
      scope,
      snapshot,
      snapshot,
      "search",
    ),
    [],
  );
  const foreign = messageSchema.parse({ ...candidate, user_id: "other-user" });
  assert.deepEqual(
    admitL0([foreign], [binding], [source], scope, snapshot, snapshot),
    [],
  );
  const assistant = messageSchema.parse({ ...candidate, role: "assistant" });
  assert.deepEqual(
    admitL0([assistant], [binding], [source], scope, snapshot, snapshot),
    [],
  );
  const altered = messageSchema.parse({
    ...candidate,
    content: "unbound text",
  });
  assert.deepEqual(
    admitL0([altered], [binding], [source], scope, snapshot, snapshot),
    [],
  );
  const compact = messageSchema.parse({
    id: candidate.id,
    role: "user",
    content: source.text,
  });
  assert.deepEqual(
    admitL0(
      [compact],
      [binding],
      [source],
      { ...scope, user_id: "other" },
      snapshot,
      snapshot,
    ),
    [],
  );
  assert.deepEqual(
    admitL0([candidate], [binding], [source], scope, snapshot, {
      ...snapshot,
      ready: false,
    }),
    [],
  );
});

test("scoring measures top-five sources and negative queries", () => {
  assert.deepEqual(scoreSources([], []), {
    recallAt5: null,
    precisionAt5: null,
    unexpected: [],
    negativePassed: true,
  });
  assert.deepEqual(scoreSources([], ["wrong-source"]), {
    recallAt5: null,
    precisionAt5: null,
    unexpected: ["wrong-source"],
    negativePassed: false,
  });
  assert.deepEqual(scoreSources(["a", "b"], ["b", "a", "x"]), {
    recallAt5: 1,
    precisionAt5: 2 / 3,
    unexpected: ["x"],
    negativePassed: null,
  });
});

test("the fixed fixture stays synthetic and contains 30 entries, 20 queries and 8 routing cases", () => {
  assert.equal(SYNTHETIC_ENTRIES.length, 30);
  assert.equal(SYNTHETIC_QUERIES.length, 20);
  assert.equal(WORK_ITEM_CASES.length, 8);
  assert.equal(NON_SOURCES.length, 3);
  assert.ok(
    SYNTHETIC_ENTRIES.every(
      ({ status }) => status === "active" || status === "revoked",
    ),
  );
  assert.ok(
    SYNTHETIC_ENTRIES.every(
      ({ id, text }) =>
        id.startsWith("synthetic-entry-") &&
        !/@|sk-[A-Za-z0-9]{20,}/u.test(text),
    ),
  );
});

test("fixed routing cases agree with Doggie routing rules", () => {
  for (const item of WORK_ITEM_CASES) {
    const candidates = item.titles.map((title, index) => ({
      id: item.id + "-" + index,
      title,
      status: "open" as const,
    }));
    assert.equal(
      resolveWorkItem(item.input, candidates).kind,
      item.expected,
      item.id,
    );
  }
});

test("Core endpoint cannot escape loopback or carry URL credentials/options", () => {
  assert.equal(localEndpoint("http://127.0.0.1:8420").hostname, "127.0.0.1");
  assert.throws(() => localEndpoint("https://127.0.0.1:8420"), ExperimentError);
  assert.throws(
    () => localEndpoint("http://example.com:8420"),
    ExperimentError,
  );
  assert.throws(
    () => localEndpoint("http://user:pass@127.0.0.1:8420"),
    ExperimentError,
  );
});

test("Core HTTP client validates scope and never automatically retries writes", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(new URL(String(input)).pathname, "/v3/conversation/add");
    assert.equal(
      new Headers(init?.headers).get("x-request-id"),
      "same-request",
    );
    return Response.json({
      code: 0,
      message: "ok",
      request_id: "req-1",
      data: {
        accepted_ids: ["m-1"],
        accepted_versions: ["v1"],
        total_count: 1,
      },
    });
  };
  try {
    const client = new CoreClient(
      "http://127.0.0.1:8420",
      "d3-test-only",
      "d3-test-instance",
    );
    await client.add(scope, "session-1", source.text, "same-request");
    await client.add(scope, "session-1", source.text, "same-request");
    assert.equal(calls, 2);
    assert.throws(() =>
      client.add({ ...scope, team_id: "" }, "session-1", source.text),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Core client rejects unknown response fields and caps response bytes", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({
        code: 0,
        message: "ok",
        request_id: "r",
        data: {
          accepted_ids: ["m"],
          accepted_versions: ["v1"],
          total_count: 1,
          hidden: true,
        },
      });
    const strict = new CoreClient(
      "http://127.0.0.1:8420",
      "d3-test-only",
      "d3-test-instance",
    );
    await assert.rejects(
      () => strict.add(scope, "s", "content"),
      ExperimentError,
    );
    globalThis.fetch = async () =>
      new Response("x".repeat(8192), { status: 200 });
    const bounded = new CoreClient(
      "http://127.0.0.1:8420",
      "d3-test-only",
      "d3-test-instance",
      1000,
      64,
    );
    await assert.rejects(
      () => bounded.request("/health", z.unknown()),
      ExperimentError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("write transport failures remain unknown and never trigger automatic retries", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new DOMException("synthetic timeout", "TimeoutError");
  };
  try {
    const client = new CoreClient(
      "http://127.0.0.1:8420",
      "d3-test-only",
      "d3-test-instance",
      5,
    );
    await assert.rejects(
      () => client.add(scope, "session-1", source.text, "d3-synthetic-unknown"),
      (error: unknown) =>
        error instanceof ExperimentError && error.code === "transport",
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote errors are surfaced as unavailable and are not converted to empty recall", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { code: 503, message: "synthetic unavailable", request_id: "r" },
      { status: 503 },
    );
  try {
    const client = new CoreClient(
      "http://127.0.0.1:8420",
      "d3-test-only",
      "d3-test-instance",
    );
    await assert.rejects(
      () => client.search(scope, "synthetic query"),
      (error: unknown) =>
        error instanceof ExperimentError &&
        error.code === "remote" &&
        error.remoteCode === 503,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
