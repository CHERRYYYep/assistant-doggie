/** Goal coordination reuses the existing explicitly approved CLI boundary. */
import type { AgentService } from "../agent/service.ts";
import {
  resolveWorkItem,
  resolveWorkItemSchema,
  workItemActionSchema,
} from "../domain/work-item.ts";
import { WorkItemStore } from "../storage/work-items.ts";

export class WorkItemService {
  readonly #store: WorkItemStore;
  readonly #agents: AgentService;
  constructor(store: WorkItemStore, agents: AgentService) {
    this.#store = store;
    this.#agents = agents;
  }
  #reconcile(): void {
    this.#agents.list();
    this.#store.reconcile();
  }
  list() {
    this.#reconcile();
    return this.#store.list();
  }
  detail(id: string) {
    this.#reconcile();
    return this.#store.detail(id);
  }
  create(input: unknown) {
    return this.#store.create(input);
  }
  update(id: string, input: unknown) {
    this.#reconcile();
    return this.#store.update(id, input);
  }
  resolve(input: unknown) {
    const request = resolveWorkItemSchema.parse(input);
    // Explicit IDs remain addressable even when older than the recent list.
    const items =
      request.workItemId === undefined
        ? this.list()
        : [this.detail(request.workItemId).workItem];
    return resolveWorkItem(request, items);
  }
  async transition(id: string, input: unknown) {
    const request = workItemActionSchema.parse(input);
    this.#reconcile();
    this.#store.transition(id, request);
    if (request.action === "cancel") {
      // Persist intent first. A failed/aborted response cannot revive approval.
      // Repeated reads expose cancellation requested until actual termination.
      for (const taskId of this.#store.inFlight(id))
        await this.#agents.cancel(taskId);
    }
    this.#reconcile();
    return this.#store.get(id);
  }
  propose(id: string, input: unknown) {
    return this.#agents.proposeForWorkItem(id, input);
  }
}
