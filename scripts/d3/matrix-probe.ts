/** Targeted L0 probe. Only invoked by the isolated runner with test credentials. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { CoreClient, ExperimentError, type Scope } from "./client.ts";
import { MatrixHarness, generationScope } from "./matrix-harness.ts";
import { MatrixJournal } from "./matrix-journal.ts";
import type { Source } from "./source-guard.ts";

class DropReceiptClient extends CoreClient {
  committed = 0;
  override async add(
    scope: Scope,
    session: string,
    text: string,
    requestId?: string,
  ): ReturnType<CoreClient["add"]> {
    await super.add(scope, session, text, requestId);
    this.committed++;
    // Actual remote write; simulate loss at the Doggie adapter boundary.
    throw new ExperimentError("transport");
  }
}

const steps = [
  "remote_commit_receipt_dropped",
  "no_replay_on_local_reopen",
  "rebuild_from_effective_sources",
  "old_scope_write_excluded",
] as const;

export async function runMatrixProbe(
  endpoint: string,
  key: string,
  instance: string,
  root: string,
  signal: AbortSignal,
) {
  if (!key.startsWith("d3-synthetic-"))
    throw new Error("D3 synthetic credentials required");
  const startedAt = new Date().toISOString();
  const completed: (typeof steps)[number][] = [];
  const oldSource: Source = {
    id: "synthetic-matrix-old",
    bucket: "old",
    text: "synthetic rollbacktoken old 701",
    active: true,
    version: 1,
  };
  const keptSource: Source = {
    ...oldSource,
    id: "synthetic-matrix-kept",
    bucket: "current",
    text: "synthetic rollbacktoken current 702",
  };
  const path = join(root, "matrix.sqlite");
  const loss = new DropReceiptClient(endpoint, key, instance);
  const client = new CoreClient(endpoint, key, instance);
  let catalog = { revision: 1, sources: [oldSource, keptSource] };
  let journal = new MatrixJournal(path);
  let failedAt: (typeof steps)[number] | null = steps[0];
  try {
    signal.throwIfAborted();
    let harness = new MatrixHarness(journal, loss, () => catalog);
    const old = harness.begin();
    assert.equal(await harness.capture(oldSource.id), "unknown");
    assert.equal(loss.committed, 1);
    assert.equal((await client.query(generationScope(old))).total, 1);
    completed.push(failedAt);

    failedAt = steps[1];
    signal.throwIfAborted();
    journal.close();
    journal = new MatrixJournal(path);
    harness = new MatrixHarness(journal, client, () => catalog);
    assert.equal(await harness.capture(oldSource.id), "skipped");
    assert.equal(await harness.verify(), false);
    assert.equal((await client.query(generationScope(old))).total, 1);
    completed.push(failedAt);

    failedAt = steps[2];
    signal.throwIfAborted();
    catalog = {
      revision: 2,
      sources: [{ ...oldSource, active: false, version: 2 }, keptSource],
    };
    const current = harness.begin();
    const summarize = async (
      evidence: readonly { readonly sourceId: string }[],
    ) => evidence.map(({ sourceId }) => sourceId);
    assert.deepEqual(await harness.answer("rollbacktoken", summarize), {
      kind: "answered",
      mode: "local",
      reason: "generation_unavailable",
      value: [keptSource.id],
    });
    assert.equal(await harness.capture(oldSource.id), "skipped");
    assert.equal(await harness.capture(keptSource.id), "acked");
    assert.equal(await harness.verify(), true);
    completed.push(failedAt);

    failedAt = steps[3];
    signal.throwIfAborted();
    await client.add(
      generationScope(old),
      "synthetic-matrix-late",
      "synthetic rollbacktoken late 703",
    );
    assert.equal((await client.query(generationScope(old))).total, 2);
    const currentScope = generationScope(current);
    const currentQuery = await client.query(currentScope);
    assert.equal(currentQuery.total, 1);
    const currentId = currentQuery.messages[0]?.id;
    assert.ok(currentId);
    assert.deepEqual(
      (await client.search(currentScope, "rollbacktoken")).messages.map(
        ({ id }) => id,
      ),
      [currentId],
    );
    assert.deepEqual(
      await harness.answer("rollbacktoken", summarize, "current"),
      { kind: "answered", mode: "core", value: [keptSource.id] },
    );
    assert.deepEqual(await harness.answer("rollbacktoken", summarize, "old"), {
      kind: "answered",
      mode: "core",
      value: [],
    });
    completed.push(failedAt);
    failedAt = null;
  } catch {
    // Reports contain only the completed steps and stable failing stage, not wire data.
  } finally {
    journal.close();
  }
  return { startedAt, completed, failedAt };
}
