import { isTerminalTask } from "../domain/task.ts";
import type { TaskQueue } from "../application/task-queue.ts";

/** Coalesced snapshots, not unbounded log replay. Disconnect only unsubscribes. */
export function taskEventStream(
  queue: TaskQueue,
  id: string,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let latest = queue.get(id);
  let sentRevision = 0;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const dispose = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (heartbeat !== undefined) clearInterval(heartbeat);
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    dispose();
    output.close();
  };
  const emit = () => {
    if (
      closed ||
      latest.revision <= sentRevision ||
      (output.desiredSize ?? 0) <= 0
    )
      return;
    sentRevision = latest.revision;
    output.enqueue(
      encoder.encode(
        `id: ${latest.revision}\nevent: task\ndata: ${JSON.stringify(latest)}\n\n`,
      ),
    );
    if (isTerminalTask(latest)) {
      dispose();
      output.close();
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller;
        unsubscribe = queue.subscribe((task) => {
          if (task.id === id) {
            latest = task;
            emit();
          }
        });
        signal.addEventListener("abort", abort, { once: true });
        heartbeat = setInterval(() => {
          if (!closed && (output.desiredSize ?? 0) > 0)
            output.enqueue(encoder.encode(": heartbeat\n\n"));
        }, 15_000);
        heartbeat.unref();
        if (signal.aborted) abort();
        else emit();
      },
      pull() {
        emit();
      },
      cancel() {
        dispose();
      },
    },
    { highWaterMark: 1 },
  );
}
