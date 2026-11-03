/** Control plane: proposal is not execution, approval is exact and durable. */
import {
  AgentError,
  agentProposalSchema,
  type AgentBackend,
  type AgentTask,
} from "../domain/agent.ts";
import { TaskError } from "../domain/task.ts";
import type { TaskQueue } from "../application/task-queue.ts";
import { throwIfAborted } from "../llm/cancellation.ts";
import { AgentStore } from "../storage/agents.ts";
import { WorkspacePolicy, assertWorkspaceUnchanged } from "./workspace.ts";
import { withAgentCwd, type AgentProcessRunner } from "./process.ts";
export class AgentService {
  readonly #store: AgentStore;
  readonly #policy: WorkspacePolicy;
  readonly #runner: AgentProcessRunner;
  readonly #databasePath: string;
  readonly #enabled: readonly AgentBackend[];
  #queue: TaskQueue | undefined;
  constructor(input: {
    store: AgentStore;
    policy: WorkspacePolicy;
    runner: AgentProcessRunner;
    databasePath: string;
    enabled: readonly AgentBackend[];
  }) {
    this.#store = input.store;
    this.#policy = input.policy;
    this.#runner = input.runner;
    this.#databasePath = input.databasePath;
    this.#enabled = input.enabled;
  }
  attachQueue(queue: TaskQueue): void {
    if (this.#queue !== undefined) throw new AgentError("conflict");
    this.#queue = queue;
    this.#store.reconcile();
  }
  capabilities() {
    return { backends: this.#enabled, permission: "read_only" as const };
  }
  list() {
    this.#store.reconcile();
    return this.#store.tasks();
  }
  get(id: string) {
    this.#store.reconcile();
    return this.#store.task(id);
  }
  workspaces() {
    return this.#store.workspaces();
  }
  async register(path: string, bucketId?: string) {
    return this.#store.registerWorkspace(
      await this.#policy.inspect(path),
      bucketId,
    );
  }
  async propose(input: unknown): Promise<AgentTask> {
    const proposal = agentProposalSchema.parse(input);
    this.#requireBackend(proposal.backend);
    if (proposal.workspaceId !== null) {
      const workspace = this.#store.workspace(proposal.workspaceId);
      assertWorkspaceUnchanged(
        workspace,
        await this.#policy.inspect(workspace.path),
      );
    }
    return this.#store.propose(proposal);
  }
  async approve(id: string, instruction: string, signal?: AbortSignal) {
    const task = this.#store.task(id);
    this.#requireBackend(task.backend);
    if (task.instruction !== instruction)
      throw new AgentError("binding_mismatch");
    if (task.workspaceId !== null) {
      const workspace = this.#store.workspace(task.workspaceId);
      assertWorkspaceUnchanged(
        workspace,
        await this.#policy.inspect(workspace.path),
      );
    }
    throwIfAborted(signal);
    if (this.#queue === undefined) throw new AgentError("disabled");
    const queueTask = this.#queue.submitUsing(() =>
      this.#store.approve(id, instruction),
    );
    return { task: this.#store.task(id), queueTask };
  }
  reject(id: string, instruction: string) {
    return this.#store.reject(id, instruction);
  }
  async cancel(id: string): Promise<AgentTask> {
    const task = this.#store.task(id);
    if (task.status === "pending") throw new AgentError("conflict");
    if (task.queueId !== null && this.#queue !== undefined)
      await this.#queue.cancel(task.queueId);
    this.#store.reconcile();
    return this.#store.task(id);
  }
  async execute(id: string, signal: AbortSignal): Promise<void> {
    try {
      const task = this.#store.start(id);
      throwIfAborted(signal);
      this.#requireBackend(task.backend);
      const workspace =
        task.workspaceId === null
          ? null
          : this.#store.workspace(task.workspaceId);
      if (workspace !== null)
        assertWorkspaceUnchanged(
          workspace,
          await this.#policy.inspect(workspace.path),
        );
      const session = this.#store.session(task.sessionId);
      if (
        session.backend !== task.backend ||
        session.workspaceId !== task.workspaceId
      )
        throw new AgentError("binding_mismatch");
      const result = await withAgentCwd(
        workspace?.path ?? null,
        this.#databasePath,
        task.sessionId,
        async (cwd) => {
          throwIfAborted(signal);
          this.#store.assertMemoryContextCurrent(task.sessionId);
          return this.#runner.run({
            task,
            session,
            cwd,
            databasePath: this.#databasePath,
            signal,
          });
        },
      );
      throwIfAborted(signal);
      this.#store.assertMemoryContextCurrent(task.sessionId);
      // A resumed CLI must return the same remote identity; otherwise do not
      // rebind a stored session to an unrelated conversation.
      if (session.remoteId !== null && session.remoteId !== result.remoteId)
        throw new AgentError("binding_mismatch");
      this.#complete(id, {
        status: "succeeded",
        output: result.output,
        failureCode: null,
        remoteId: result.remoteId,
      });
    } catch (error) {
      if (error instanceof TaskError && error.kind === "faulted") throw error;
      const code = signal.aborted
        ? "cancelled"
        : error instanceof AgentError
          ? error.code
          : "process_failed";
      // Persist an execution failure once. If persistence fails, fault the
      // worker rather than retrying or misreporting the task.
      this.#complete(id, {
        status: signal.aborted ? "cancelled" : "failed",
        output: "",
        failureCode: code,
      });
      if (signal.aborted) throwIfAborted(signal);
      throw new AgentError(
        error instanceof AgentError ? error.code : "process_failed",
      );
    }
  }
  #complete(id: string, outcome: Parameters<AgentStore["complete"]>[1]): void {
    try {
      this.#store.complete(id, outcome);
    } catch (error) {
      if (error instanceof AgentError && error.code === "memory_changed")
        throw error;
      throw new TaskError("faulted");
    }
  }
  #requireBackend(backend: AgentBackend): void {
    if (!this.#enabled.includes(backend)) throw new AgentError("disabled");
  }
}
