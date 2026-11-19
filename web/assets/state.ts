/**
 * The only mutable state in the UI.
 *
 * One owner, one object. Modules read and write `state.*` rather than keeping
 * private copies, so "which bucket is selected" has exactly one answer.
 */

import type { TaskSnapshot } from "../../src/domain/task.ts";
import type { ConversationTurnRequest } from "../../src/http/contracts.ts";
import type {
  ClarificationCardDto,
  BucketDto,
  TodoDto,
  UiChatMessageDto,
} from "../../src/http/dto.ts";

export type FrontendState = {
  /** Active buckets as last returned by the server. */
  activeBuckets: readonly BucketDto[];
  agenda: readonly TodoDto[];
  /** Bucket whose detail panel is open, or null. */
  selectedBucketId: string | null;
  /** Chat messages currently rendered, oldest first. */
  history: UiChatMessageDto[];
  preview: boolean;
  clarifications: readonly ClarificationCardDto[];
  reply: { readonly clarificationId: string; readonly expectedRevision: number } | null;
  retryTurn: ConversationTurnRequest | null;
  tasks: Map<string, TaskSnapshot>;
  taskObservers: Map<string, AbortController>;
  pausedTasks: Set<string>;
  cancellingTasks: Set<string>;
  resumingTasks: boolean;
  historyRequestRevision: number;
  bucketsRequestRevision: number;
  agendaRequestRevision: number;
  detailRequestRevision: number;
  queryRequestRevision: number;
  revokingEntries: Set<string>;
};

export const state: FrontendState = {
  activeBuckets: [],
  agenda: [],
  selectedBucketId: null,
  history: [],
  preview: false,
  clarifications: [],
  reply: null,
  retryTurn: null,
  tasks: new Map(),
  taskObservers: new Map(),
  pausedTasks: new Set(),
  cancellingTasks: new Set(),
  resumingTasks: false,
  historyRequestRevision: 0,
  bucketsRequestRevision: 0,
  agendaRequestRevision: 0,
  detailRequestRevision: 0,
  queryRequestRevision: 0,
  revokingEntries: new Set(),
};

export function bucketById(id: string): BucketDto | undefined {
  return state.activeBuckets.find((bucket) => bucket.id === id);
}
