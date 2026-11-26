import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AgentService } from "../agent/service.ts";
import { WorkspacePolicy } from "../agent/workspace.ts";
import { AgentStore } from "../storage/agents.ts";
import { openDatabase } from "../storage/database.ts";
import { WorkItemStore } from "../storage/work-items.ts";
import { WorkItemService } from "./work-items.ts";

test("work item exact title resolution sees old terminal goals and ambiguity outside the recent list", () => {
  using database = openDatabase(":memory:");
  const store = new WorkItemStore(database);
  const service = new WorkItemService(
    store,
    new AgentService({
      store: new AgentStore(database),
      policy: new WorkspacePolicy([]),
      databasePath: ":memory:",
      enabled: [],
      runner: { run: () => assert.fail("resolution must not run an Agent") },
    }),
  );
  const create = (title: string) =>
    service.create({
      requestId: randomUUID(),
      title,
      goal: "定位任务",
      acceptance: "找到确切目标",
    });
  const old = create("较早的目标");
  const duplicate = create("同名实验");
  for (const item of [old, duplicate])
    store.transition(item.id, {
      expectedRevision: item.revision,
      action: "complete",
    });
  for (let index = 0; index < 101; index++) create(`活跃目标 ${index}`);
  const current = create(duplicate.title);

  assert.equal(
    service.list().some(({ id }) => id === duplicate.id),
    false,
  );
  assert.equal(service.resolve({ title: old.title }).workItemId, old.id);
  assert.equal(service.resolve({ workItemId: old.id }).workItemId, old.id);
  const sameTitle = service.resolve({ title: duplicate.title });
  assert.equal(sameTitle.kind, "clarify");
  assert.deepEqual(
    new Set(sameTitle.candidates.map(({ id }) => id)),
    new Set([duplicate.id, current.id]),
  );
  assert.equal(service.resolve({ title: "同名" }).kind, "unassigned");
  assert.throws(
    () => service.resolve({ workItemId: randomUUID() }),
    /missing/u,
  );
});
