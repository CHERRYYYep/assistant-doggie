/** Real L0 restart and bounded cleanup probe; invoked only by the isolated runner. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CoreClient,
  ExperimentError,
  healthSchema,
  type CoreMessage,
  type Scope,
} from "./client.ts";
import { MatrixHarness, generationScope } from "./matrix-harness.ts";
import { MatrixJournal, type Generation } from "./matrix-journal.ts";
import type { Source } from "./source-guard.ts";

export type CoreControl = {
  readonly stop: () => Promise<void>;
  readonly start: () => Promise<void>;
};
type Capture = { readonly id: string; readonly session: string };
type QueryResult = {
  readonly total: number;
  readonly messages: readonly CoreMessage[];
};

export function cleanupIds(
  retired: Generation,
  current: Generation,
  listing: QueryResult,
  owned: readonly Capture[],
): string[] {
  const scope = generationScope(retired);
  const ownedIds = new Map(owned.map(({ id, session }) => [id, session]));
  const ids = listing.messages.map(({ id }) => id);
  if (
    retired.namespace !== current.namespace ||
    !/^d3-matrix-[0-9a-f-]{36}$/.test(retired.namespace) ||
    retired.epoch < 1 ||
    retired.epoch >= current.epoch ||
    current.phase !== "ready" ||
    ownedIds.size !== owned.length ||
    owned.length > 100 ||
    listing.total !== listing.messages.length ||
    new Set(ids).size !== ids.length ||
    listing.messages.some(
      (row) =>
        row.team_id !== scope.team_id ||
        row.agent_id !== scope.agent_id ||
        row.user_id !== scope.user_id ||
        row.role !== "user" ||
        row.session_id === undefined ||
        ownedIds.get(row.id) !== row.session_id,
    )
  )
    throw new Error("D3 unverified cleanup scope");
  return ids;
}

export async function clearRetiredL0(
  core: Pick<CoreClient, "query" | "deleteMessages">,
  retired: Generation,
  current: Generation,
  owned: readonly Capture[],
): Promise<number> {
  const scope = generationScope(retired);
  const ids = cleanupIds(retired, current, await core.query(scope), owned);
  if (ids.length === 0) return 0;
  // One mutation only. A timeout or mismatched count cannot authorize a retry.
  const result = await core.deleteMessages(scope, ids);
  if (result.deleted_count !== ids.length)
    throw new Error("D3 cleanup count mismatch");
  if (cleanupIds(retired, current, await core.query(scope), owned).length !== 0)
    throw new Error("D3 cleanup left rows");
  return result.deleted_count;
}

const sharedTerm = "matrixrestarttoken";
const retiredTerm = "retiredscopetoken";
const kept: Source = {
  id: "synthetic-recovery-kept",
  bucket: "keep",
  text: `synthetic ${sharedTerm} current`,
  version: 1,
  active: true,
};
const removed: Source = {
  ...kept,
  id: "synthetic-recovery-removed",
  bucket: "old",
  text: `synthetic ${sharedTerm} ${retiredTerm}`,
};
const steps = [
  "seed_and_index",
  "offline_local_fallback",
  "restart_and_fts_recovery",
  "cleanup_retired_l0_scope",
  "restart_without_index_ghosts",
] as const;
type Step = (typeof steps)[number];
const sourceIds = async (rows: readonly { readonly sourceId: string }[]) =>
  rows.map(({ sourceId }) => sourceId);

async function indexReady(
  core: CoreClient,
  scope: Scope,
  expected: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + 10_000;
  do {
    signal.throwIfAborted();
    try {
      const h = await core.request("/health", healthSchema);
      if (h.stores.embeddingService)
        throw new Error("D3 unexpected embedding service");
      if (h.status === "ok" && h.stores.ftsAvailable) {
        const found = await core.search(scope, sharedTerm);
        if (
          found.messages.length === expected.length &&
          found.messages.every(({ id }) => expected.includes(id)) &&
          new Set(found.messages.map(({ id }) => id)).size === expected.length
        )
          return;
      }
    } catch (error) {
      if (
        !(error instanceof ExperimentError) ||
        !["transport", "remote"].includes(error.code)
      )
        throw error;
    }
    await delay(100, undefined, { signal });
  } while (performance.now() < deadline);
  throw new Error("D3 FTS did not recover");
}

export async function runRecoveryProbe(
  core: CoreClient,
  control: CoreControl,
  root: string,
  signal: AbortSignal,
) {
  const startedAt = new Date().toISOString();
  const completed: Step[] = [];
  let failedAt: Step | null = steps[0];
  let deleted: number | null = null;
  const restartToRecallMs: number[] = [];
  let fallbackMs: number | null = null;
  const journal = new MatrixJournal(join(root, "recovery.sqlite"));
  let catalog: { revision: number; sources: readonly Source[] } = {
    revision: 1,
    sources: [removed, kept],
  };
  const harness = new MatrixHarness(journal, core, () => catalog);
  try {
    signal.throwIfAborted();
    const old = harness.begin();
    for (const source of catalog.sources)
      assert.equal(await harness.capture(source.id), "acked");
    assert.equal(await harness.verify(), true);
    const owned = journal.deliveries(old).map(({ remoteId, session }) => {
      assert.ok(remoteId);
      return { id: remoteId, session };
    });
    const oldScope = generationScope(old);
    await indexReady(
      core,
      oldScope,
      owned.map(({ id }) => id),
      signal,
    );
    catalog = {
      revision: 2,
      sources: [{ ...removed, active: false, version: 2 }, kept],
    };
    const building = harness.begin();
    assert.equal(await harness.capture(kept.id), "acked");
    assert.equal(await harness.verify(), true);
    const current = journal.state();
    assert.equal(current.epoch, building.epoch);
    const currentScope = generationScope(current);
    const currentId = journal.deliveries(current)[0]?.remoteId;
    assert.ok(currentId);
    await indexReady(core, currentScope, [currentId], signal);
    completed.push(failedAt);

    failedAt = steps[1];
    signal.throwIfAborted();
    await control.stop();
    const fallbackStarted = performance.now();
    assert.deepEqual(await harness.answer(sharedTerm, sourceIds), {
      kind: "answered",
      mode: "local",
      reason: "transport",
      value: [kept.id],
    });
    fallbackMs = Math.round(performance.now() - fallbackStarted);
    completed.push(failedAt);

    failedAt = steps[2];
    const restart = async () => {
      signal.throwIfAborted();
      const at = performance.now();
      await control.start();
      await indexReady(core, currentScope, [currentId], signal);
      assert.deepEqual(await harness.answer(sharedTerm, sourceIds), {
        kind: "answered",
        mode: "core",
        value: [kept.id],
      });
      assert.equal((await core.query(currentScope)).total, 1);
      restartToRecallMs.push(Math.round(performance.now() - at));
    };
    await restart();
    await indexReady(
      core,
      oldScope,
      owned.map(({ id }) => id),
      signal,
    );
    completed.push(failedAt);

    failedAt = steps[3];
    signal.throwIfAborted();
    assert.equal(
      cleanupIds(old, current, await core.query(oldScope), owned).length,
      owned.length,
    );
    assert.equal((await core.search(oldScope, retiredTerm)).messages.length, 1);
    deleted = await clearRetiredL0(core, old, current, owned);
    assert.equal(deleted, owned.length);
    const assertCleared = async () => {
      assert.equal((await core.query(oldScope)).total, 0);
      assert.deepEqual((await core.search(oldScope, retiredTerm)).messages, []);
      assert.deepEqual((await core.search(oldScope, sharedTerm)).messages, []);
    };
    await assertCleared();
    await indexReady(core, currentScope, [currentId], signal);
    assert.equal(await clearRetiredL0(core, old, current, owned), 0);
    completed.push(failedAt);

    failedAt = steps[4];
    await control.stop();
    await restart();
    await assertCleared();
    completed.push(failedAt);
    failedAt = null;
  } catch {
    // Share only stable stage diagnostics, never raw remote data.
  } finally {
    journal.close();
  }
  return {
    startedAt,
    completed,
    failedAt,
    deleted,
    fallbackMs,
    restartToRecallMs,
  };
}
