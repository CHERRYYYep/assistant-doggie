import { formatTimestamp, StorageError } from "../storage/database.ts";
import {
  type Store,
  type TodoAgendaInput,
  type TodoMutationOutcome,
  type TodoRow,
} from "../storage/store.ts";
import type { TodoPlanInput } from "../domain/todo.ts";

export type AgendaResult = {
  readonly now: string;
  readonly todos: readonly TodoRow[];
};

export class TodoService {
  readonly #store: Store;
  readonly #clock: () => Date;

  constructor(store: Store, clock: () => Date = () => new Date()) {
    this.#store = store;
    this.#clock = clock;
  }

  listAgenda(input: Omit<TodoAgendaInput, "now"> = {}): AgendaResult {
    const now = formatTimestamp(this.#clock());
    return {
      now,
      todos: this.#store.listAgenda({ ...input, now }),
    };
  }

  getTodo(todoId: string): TodoRow {
    const todo = this.#store.getTodo(todoId);
    if (todo === undefined) {
      throw StorageError.missingRecord("memory_items", todoId);
    }
    return todo;
  }

  transitionTodo(
    todoId: string,
    status: unknown,
    commandText: string,
    expectedUpdatedAt: string,
  ): TodoMutationOutcome {
    return this.#store.transitionTodo(
      todoId,
      status,
      commandText,
      expectedUpdatedAt,
    );
  }

  updateTodoPlan(
    todoId: string,
    plan: TodoPlanInput,
    commandText: string,
    expectedUpdatedAt: string,
  ): TodoMutationOutcome {
    return this.#store.updateTodoPlan(
      todoId,
      plan,
      commandText,
      expectedUpdatedAt,
    );
  }

  advanceRepeatingTodo(
    todoId: string,
    commandText: string,
    expectedUpdatedAt: string,
  ): TodoMutationOutcome {
    return this.#store.advanceRepeatingTodo(
      todoId,
      commandText,
      expectedUpdatedAt,
    );
  }

  reopenTodo(
    todoId: string,
    commandText: string,
    expectedUpdatedAt: string,
  ): TodoMutationOutcome {
    return this.#store.transitionTodo(
      todoId,
      "open",
      commandText,
      expectedUpdatedAt,
    );
  }
}
