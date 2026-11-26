import assert from "node:assert/strict";
import { test } from "node:test";
import { ExperimentError, type CoreMessage } from "./client.ts";
import { generationScope } from "./matrix-harness.ts";
import type { Generation } from "./matrix-journal.ts";
import { cleanupIds, clearRetiredL0 } from "./recovery-probe.ts";

const retired: Generation = {
  namespace: "d3-matrix-01234567-89ab-4def-8123-456789abcdef",
  epoch: 1,
  revision: 1,
  phase: "ready",
};
const current: Generation = { ...retired, epoch: 2, revision: 2 };
const oldScope = generationScope(retired);
const owned = [{ id: "test-id", session: "test-session" }];
const row = {
  ...oldScope,
  id: "test-id",
  session_id: "test-session",
  content: "synthetic",
  role: "user",
} as const satisfies CoreMessage;
const valid = { total: 1, messages: [row] };
const empty = { total: 0, messages: [] };

test("cleanup accepts only complete listings of known IDs in an older synthetic scope", () => {
  assert.deepEqual(cleanupIds(retired, current, valid, owned), [row.id]);
  assert.deepEqual(cleanupIds(retired, current, empty, owned), []);
  for (const listing of [
    { ...valid, total: 2 },
    { total: 2, messages: [row, row] },
    { total: 1, messages: [{ ...row, id: "unowned" }] },
    {
      total: 1,
      messages: [{ ...row, team_id: generationScope(current).team_id }],
    },
    { total: 1, messages: [{ ...row, user_id: "foreign-user" }] },
    { total: 1, messages: [{ ...row, agent_id: "foreign-agent" }] },
    { total: 1, messages: [{ ...row, session_id: "not-ours" }] },
  ])
    assert.throws(
      () => cleanupIds(retired, current, listing, owned),
      /unverified cleanup scope/,
    );
  assert.throws(
    () => cleanupIds(current, current, valid, owned),
    /unverified cleanup scope/,
  );
  assert.throws(
    () => cleanupIds(retired, { ...current, phase: "building" }, valid, owned),
    /unverified cleanup scope/,
  );
});

test("unknown contents do not authorize a delete and a lost delete receipt is never retried", async () => {
  let writes = 0;
  let listing = { total: 1, messages: [{ ...row, id: "unowned" }] };
  const client = {
    query: async () => listing,
    deleteMessages: async () => {
      writes++;
      throw new ExperimentError("transport");
    },
  };
  await assert.rejects(
    () => clearRetiredL0(client, retired, current, owned),
    /unverified cleanup scope/,
  );
  assert.equal(writes, 0);
  listing = valid;
  await assert.rejects(() => clearRetiredL0(client, retired, current, owned), {
    code: "transport",
  });
  assert.equal(writes, 1);
});

test("a successful delete receipt does not override residual readback; already empty needs no write", async () => {
  let listing: { total: number; messages: CoreMessage[] } = valid;
  let writes = 0;
  const client = {
    query: async () => listing,
    deleteMessages: async (scope: typeof oldScope, ids: readonly string[]) => {
      assert.deepEqual(scope, oldScope);
      assert.deepEqual(ids, [row.id]);
      writes++;
      return { deleted_count: 1 };
    },
  };
  await assert.rejects(
    () => clearRetiredL0(client, retired, current, owned),
    /cleanup left rows/,
  );
  assert.equal(writes, 1);
  listing = empty;
  assert.equal(await clearRetiredL0(client, retired, current, owned), 0);
  assert.equal(writes, 1);
});
