import type { ChatMessageRow } from "../storage/conversation.ts";
import type { JsonValue } from "../storage/store.ts";

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

export type ChatResponderInput = {
  readonly sourceText: string;
  readonly history: readonly ChatMessageRow[];
  readonly signal?: AbortSignal;
} & (
  | {
      readonly archive: Readonly<Record<string, unknown>>;
      readonly purpose?: never;
    }
  | { readonly archive: null; readonly purpose: "answer" | "lookup" }
);

export type ChatResponder = {
  readonly respond: (request: ChatResponderInput) => Promise<ChatResponse>;
};

export type MainTurnClarifyReason =
  | "purpose"
  | "target"
  | "mixed"
  | "explicit_confirmation"
  | "archive_content"
  | "rewrite_material";

export type MainTurnDecision =
  | { readonly intent: "answer"; readonly reason: string }
  | { readonly intent: "lookup"; readonly reason: string }
  | {
      readonly intent: "archive";
      readonly archiveText: string;
      readonly reason: string;
    };

export type MainTurnRouterInput = {
  readonly text: string;
  readonly history: readonly ChatMessageRow[];
  readonly fallbackReason: MainTurnClarifyReason;
  readonly signal?: AbortSignal;
};

export type MainTurnRouter = {
  readonly route: (
    input: MainTurnRouterInput,
  ) => Promise<MainTurnDecision | null>;
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
