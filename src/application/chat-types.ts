import type { ChatMessageRow, JsonValue } from "../storage/store.ts";

export type ChatInput = {
  readonly text: string;
  readonly focusBucketId?: string | undefined;
};

export type ChatToolMessage = {
  readonly name: string;
  readonly callId: string;
  readonly arguments: JsonValue;
  readonly output: JsonValue;
};

export type ChatResponse = {
  readonly assistantText: string;
  readonly toolMessages?: readonly ChatToolMessage[];
};

export type ChatResponder = {
  readonly respond: (request: {
    readonly sourceText: string;
    readonly history: readonly ChatMessageRow[];
    readonly archive: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }) => Promise<ChatResponse>;
};

/** A failure after accepting a user message. Adapters project the saved rows. */
export class ChatFailure extends Error {
  readonly userMessage: ChatMessageRow;
  readonly assistantMessage: ChatMessageRow | undefined;

  constructor(
    message: string,
    userMessage: ChatMessageRow,
    assistantMessage: ChatMessageRow | undefined,
  ) {
    super(message);
    this.name = "ChatFailure";
    this.userMessage = userMessage;
    this.assistantMessage = assistantMessage;
  }
}
