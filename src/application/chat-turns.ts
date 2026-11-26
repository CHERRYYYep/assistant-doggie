/** Admit one local conversation turn at a time. No SQLite lock spans an await. */
import { abortError, throwIfAborted } from "../llm/cancellation.ts";

const MAX_WAITING_TURNS = 32;

export class ChatCapacityError extends Error {
  constructor() {
    super("conversation capacity exceeded");
    this.name = "ChatCapacityError";
  }
}

type WaitingTurn = {
  readonly admit: () => void;
};

export class ChatTurns {
  #active = false;
  readonly #waiting: WaitingTurn[] = [];

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (!this.#active) {
      this.#active = true;
    } else {
      if (this.#waiting.length >= MAX_WAITING_TURNS)
        throw new ChatCapacityError();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          const index = this.#waiting.indexOf(turn);
          if (index < 0) return;
          this.#waiting.splice(index, 1);
          reject(abortError());
        };
        const turn: WaitingTurn = {
          admit: () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          },
        };
        this.#waiting.push(turn);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    try {
      throwIfAborted(signal);
      return await operation();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#active = false;
      else next.admit();
    }
  }
}
