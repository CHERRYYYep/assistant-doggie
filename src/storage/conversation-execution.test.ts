import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { AgentService } from "../agent/service.ts";
import { WorkspacePolicy } from "../agent/workspace.ts";
import { createNew } from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { AgentStore } from "./agents.ts";
import { ClarificationStore } from "./clarifications.ts";
import { ConversationStore } from "./conversation.ts";
import { openDatabase, withTransaction } from "./database.ts";
import { Store } from "./store.ts";
import { TaskStore } from "./tasks.ts";
import { WorkItemStore } from "./work-items.ts";

function fixture(db: DatabaseSync) {
  const memory = new Store(db);
  const evidence = memory.archive(
    "TCP reference material",
    createNew(BucketType.Task, "Networks", 0.99, "fixture"),
    minimalExtraction("TCP citation"),
    { candidateBucketIds: [], promptVersion: "fixture", modelName: "fake" },
  );
  assert.ok(evidence.entryId);
  const entryId = evidence.entryId;
  const goals = new WorkItemStore(db);
  const goal = goals.create(
    {
      requestId: randomUUID(),
      title: "TCP Lab",
      goal: "Check the TCP report",
      acceptance: "List issues without editing files",
      sources: [{ kind: "entry", id: entryId }],
    },
    (item) => item.goal,
  );
  const conversation = new ConversationStore(db);
  const cards = new ClarificationStore(db, conversation);
  const card = withTransaction(db, () => {
    const original = cards.append({ role: "user", content: "Read the report" });
    const resolved = cards.append({ role: "assistant", content: "TCP Lab" });
    const ref = { id: goal.id, scopeRevision: goal.scopeRevision };
    return {
      id: cards.create(original.id, resolved.id, [ref], false, ref),
      revision: 1,
    };
  });
  const agents = new AgentStore(db);
  const workspace = agents.registerWorkspace({
    path: "/fixture/repo",
    baseCommit: "fake",
    gitStatus: "",
  });
  const request = {
    requestId: randomUUID(),
    expectedRevision: goal.revision,
    workspaceId: workspace.id,
    backend: "codex" as const,
    instruction: "Read the report; only list errors",
  };
  const propose = () =>
    agents.proposeForConversationWithinTransaction(goal.id, request, card);
  const cancelCard = () =>
    withTransaction(db, () =>
      cards.update(cards.get(card.id), {
        status: "cancelled",
        candidates: [],
        truncated: false,
        selected: null,
        latestReplyId: null,
      }),
    );
  return {
    agents,
    card,
    cards,
    cancelCard,
    goals,
    goal,
    request,
    propose,
    memory,
    entryId,
    queue: new TaskStore(db),
  };
}

test("conversation proposal shares transaction, idempotency, exclusivity and exact approval", () => {
  using db = openDatabase(":memory:");
  const f = fixture(db);
  assert.throws(() => f.propose(), /conflict/);
  assert.throws(
    () =>
      withTransaction(db, () => {
        f.propose();
        throw new Error("receipt persistence failed");
      }),
    /receipt persistence failed/,
  );
  assert.deepEqual(f.agents.tasks(), []);
  assert.equal(f.goals.get(f.goal.id).revision, f.goal.revision);
  assert.equal(f.agents.conversationExecution(f.card.id), null);

  const task = withTransaction(db, f.propose);
  assert.equal(withTransaction(db, f.propose).id, task.id);
  assert.deepEqual(f.agents.conversationExecution(f.card.id), {
    taskId: task.id,
    status: "pending",
    output: null,
    failureCode: null,
  });
  assert.match(task.instruction, /List issues without editing files/);
  assert.throws(() => f.agents.approve(task.id, f.request.instruction));
  assert.deepEqual(f.queue.list(), []);
  assert.throws(
    () =>
      f.agents.proposeForWorkItem(f.goal.id, {
        ...f.request,
        expectedRevision: f.goals.get(f.goal.id).revision,
        requestId: randomUUID(),
      }),
    /conflict/,
  );
  f.cancelCard();
  assert.throws(() => f.agents.approve(task.id, task.instruction), /conflict/);
  assert.equal(
    f.memory.getPendingAction(task.pendingActionId)?.status,
    "pending",
  );
  assert.deepEqual(f.queue.list(), []);
  assert.equal(f.agents.conversationExecution(f.card.id)?.status, "stale");
});

test("changing a card retires its unapproved attempt atomically and releases the goal", () => {
  using db = openDatabase(":memory:");
  const f = fixture(db);
  const task = withTransaction(db, f.propose);
  const goalBefore = f.goals.get(f.goal.id);
  const revise = () => {
    const card = f.cards.get(f.card.id);
    f.cards.update(card, { ...card, candidates: [], truncated: false });
    f.agents.rejectPendingForConversationWithinTransaction(f.card.id);
  };
  assert.throws(
    () =>
      withTransaction(db, () => {
        revise();
        throw new Error("could not publish new revision");
      }),
    /could not publish new revision/,
  );
  assert.equal(f.cards.get(f.card.id).revision, f.card.revision);
  assert.equal(f.agents.task(task.id).status, "pending");
  assert.equal(
    f.memory.getPendingAction(task.pendingActionId)?.status,
    "pending",
  );
  assert.equal(f.goals.get(f.goal.id).revision, goalBefore.revision);
  withTransaction(db, revise);
  assert.equal(f.agents.task(task.id).status, "rejected");
  assert.equal(
    f.memory.getPendingAction(task.pendingActionId)?.status,
    "rejected",
  );
  assert.equal(f.goals.get(f.goal.id).lastAttemptStatus, "rejected");
  const replacement = withTransaction(db, () =>
    f.agents.proposeForConversationWithinTransaction(
      f.goal.id,
      {
        ...f.request,
        requestId: randomUUID(),
        expectedRevision: f.goals.get(f.goal.id).revision,
      },
      { ...f.card, revision: f.card.revision + 1 },
    ),
  );
  assert.notEqual(replacement.id, task.id);
  assert.equal(
    f.agents.conversationExecution(f.card.id)?.taskId,
    replacement.id,
  );
  assert.deepEqual(f.queue.list(), []);
});

test("an approved conversation attempt checks card again at worker start", () => {
  using db = openDatabase(":memory:");
  const f = fixture(db);
  const task = withTransaction(db, f.propose);
  const approved = f.agents.approve(task.id, task.instruction);
  f.cancelCard();
  assert.equal(f.queue.claim()?.task.id, approved.id);
  assert.throws(() => f.agents.start(task.id), /conflict/);
  assert.equal(f.agents.task(task.id).output, "");
  f.queue.finish(approved.id, "failed", "execution_failed");
  assert.equal(f.agents.task(task.id).status, "failed");
});

const success = () => ({
  status: "succeeded" as const,
  output: "Reference file read",
  failureCode: null,
  remoteId: randomUUID(),
});

for (const invalidation of ["card", "goal", "memory"] as const) {
  test(`conversation attempt discards a success returned after ${invalidation} invalidation`, () => {
    using db = openDatabase(":memory:");
    const f = fixture(db);
    const task = withTransaction(db, f.propose);
    const queued = f.agents.approve(task.id, task.instruction);
    assert.equal(f.queue.claim()?.task.id, queued.id);
    assert.equal(f.agents.start(task.id).status, "running");
    if (invalidation === "card") f.cancelCard();
    if (invalidation === "goal")
      f.goals.transition(f.goal.id, {
        action: "cancel",
        expectedRevision: f.goals.get(f.goal.id).revision,
      });
    if (invalidation === "memory") f.memory.deleteEntry(f.entryId, "fixture");
    assert.throws(
      () => f.agents.complete(task.id, success()),
      /memory_changed|conflict/,
    );
    f.agents.complete(task.id, {
      status: "failed",
      output: "",
      failureCode: "conflict",
    });
    assert.equal(f.agents.task(task.id).output, "");
    assert.equal(f.agents.session(task.sessionId).remoteId, null);
    assert.deepEqual(f.agents.conversationExecution(f.card.id), {
      taskId: task.id,
      status: "stale",
      output: null,
      failureCode: null,
    });
  });
}

test("current result returns only to its card; its session cannot seed an unlinked attempt", () => {
  using db = openDatabase(":memory:");
  const f = fixture(db);
  const task = withTransaction(db, f.propose);
  const queued = f.agents.approve(task.id, task.instruction);
  assert.equal(f.queue.claim()?.task.id, queued.id);
  f.agents.start(task.id);
  const result = success();
  f.agents.complete(task.id, result);
  f.queue.finish(queued.id, "succeeded", null);
  const service = new AgentService({
    store: f.agents,
    policy: new WorkspacePolicy([]),
    runner: { run: () => Promise.reject(new Error("must not run")) },
    databasePath: ":memory:",
    enabled: [],
  });
  assert.equal(f.goals.get(f.goal.id).status, "in_progress");
  assert.equal(f.agents.conversationExecution(randomUUID()), null);
  assert.deepEqual(f.agents.conversationExecution(f.card.id), {
    taskId: task.id,
    status: "succeeded",
    output: result.output,
    failureCode: null,
  });
  assert.equal(service.get(task.id).output, result.output);
  assert.equal(service.list()[0]?.output, result.output);
  assert.equal(f.goals.detail(f.goal.id).attempts[0]?.output, result.output);
  assert.throws(
    () =>
      f.agents.proposeForWorkItem(f.goal.id, {
        ...f.request,
        requestId: randomUUID(),
        expectedRevision: f.goals.get(f.goal.id).revision,
        sessionId: task.sessionId,
      }),
    /binding_mismatch/,
  );
  f.cancelCard();
  assert.equal(f.agents.conversationExecution(f.card.id)?.status, "stale");
  assert.equal(f.agents.conversationExecution(f.card.id)?.output, null);
  assert.equal(f.agents.task(task.id).output, result.output); // internal audit is retained
  assert.equal(service.get(task.id).status, "succeeded");
  assert.equal(service.get(task.id).output, "");
  assert.equal(service.list()[0]?.output, "");
  assert.equal(f.goals.detail(f.goal.id).attempts[0]?.output, "");
});
