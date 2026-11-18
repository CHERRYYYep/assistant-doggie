/** A single local worker. No tool execution or new approval authority. */
import { randomUUID } from "node:crypto";
import {
  TaskError,
  type TaskPayload,
  type TaskSnapshot,
} from "../domain/task.ts";
import type { TaskStore } from "../storage/tasks.ts";

export type TaskExecutor = (
  payload: TaskPayload,
  signal: AbortSignal,
) => Promise<unknown>;
export class TaskQueue {
  readonly #store: TaskStore;
  readonly #execute: TaskExecutor;
  readonly #owner = randomUUID();
  readonly #listeners = new Set<(task: TaskSnapshot) => void>();
  #running:
    | { id: string; controller: AbortController; done: Promise<void> }
    | undefined;
  #worker: Promise<void> | undefined;
  #closed = false;
  #fault: TaskError | undefined;
  #closePromise: Promise<void> | undefined;
  constructor(store: TaskStore, execute: TaskExecutor) {
    this.#store = store;
    this.#execute = execute;
    store.acquireExecutor(this.#owner);
    this.#wake();
  }
  submit(payload: unknown): TaskSnapshot {
    if (this.#fault !== undefined) throw this.#fault;
    if (this.#closed) throw new TaskError("closed");
    return this.submitUsing(() => this.#store.enqueue(payload));
  }
  submitUsing(enqueue: () => TaskSnapshot): TaskSnapshot {
    if (this.#fault !== undefined) throw this.#fault;
    if (this.#closed) throw new TaskError("closed");
    const task = enqueue();
    this.#publish(task);
    this.#wake();
    return task;
  }

  get(id: string): TaskSnapshot {
    return this.#store.get(id);
  }
  list(): readonly TaskSnapshot[] {
    return this.#store.list();
  }
  async cancel(id: string): Promise<TaskSnapshot> {
    const task = this.get(id);
    if (task.status === "queued") {
      const cancelled = this.#store.cancelQueued(id);
      this.#publish(cancelled);
      return cancelled;
    }
    if (task.status === "running" && this.#running?.id === id) {
      this.#running.controller.abort();
      // Observe actual completion. A synchronous commit already completed is
      // not undone and must not be misrepresented as cancelled.
      await this.#running.done;
    }
    return this.get(id);
  }
  subscribe(listener: (task: TaskSnapshot) => void): () => void {
    if (this.#listeners.size >= 32) throw new TaskError("capacity");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }
  async #performClose(): Promise<void> {
    this.#closed = true;
    this.#running?.controller.abort();
    try {
      await this.#worker;
      if (this.#fault !== undefined) throw this.#fault;
    } finally {
      this.#listeners.clear();
      try {
        this.#store.releaseExecutor(this.#owner);
      } catch {
        throw new TaskError("faulted");
      }
    }
  }
  #wake(): void {
    if (this.#closed || this.#fault !== undefined || this.#worker !== undefined)
      return;
    // Defer execution until submit has returned its immutable queued snapshot.
    let healthy = false;
    this.#worker = Promise.resolve()
      .then(() => this.#drain())
      .then(() => {
        healthy = true;
      })
      .finally(() => {
        this.#worker = undefined;
        if (healthy && !this.#closed && this.#fault === undefined) {
          try {
            if (this.#store.hasQueued()) this.#wake();
          } catch {
            this.#fault = new TaskError("faulted");
            throw this.#fault;
          }
        }
      })
      .catch(() => {
        this.#fault ??= new TaskError("faulted");
        throw this.#fault;
      });
    // Stable terminal errors are handled per job; storage failures stop rather
    // than spin or silently re-execute. Runtime shutdown still observes them.
    void this.#worker.catch(() => undefined);
  }
  async #drain(): Promise<void> {
    while (!this.#closed) {
      const work = this.#store.claim();
      if (work === undefined) break;
      const controller = new AbortController();
      let complete = () => {};
      const done = new Promise<void>((resolve) => {
        complete = resolve;
      });
      this.#running = { id: work.task.id, controller, done };
      const timeout = setTimeout(() => controller.abort(), 120_000);
      timeout.unref();
      this.#publish(work.task);
      try {
        let status: "succeeded" | "cancelled" | "failed" = "succeeded";
        let errorCode: TaskSnapshot["errorCode"] = null;
        try {
          await this.#execute(work.payload, controller.signal);
        } catch (error) {
          if (error instanceof TaskError && error.kind === "faulted")
            throw error;
          status = controller.signal.aborted ? "cancelled" : "failed";
          errorCode = status === "failed" ? "execution_failed" : null;
        }
        // Persistence failure is NOT an executor failure. The effect may
        // already exist; stop admission and never mislabel it or replay it.
        this.#publish(this.#store.finish(work.task.id, status, errorCode));
      } finally {
        clearTimeout(timeout);
        this.#running = undefined;
        complete();
      }
    }
  }
  #publish(task: TaskSnapshot): void {
    for (const listener of this.#listeners) {
      try {
        listener(task);
      } catch {
        this.#listeners.delete(listener);
      }
    }
  }
}
