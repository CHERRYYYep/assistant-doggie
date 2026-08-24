import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ChatConfirmationRequest,
  ChatRequest,
  MoveEntryRequest,
} from "../../../../src/http/contracts.ts";
import type {
  ActiveBucketsResponse,
  ChatHistoryResponse,
  MemoryQueryResponse,
} from "../../../../src/http/dto.ts";
import {
  fetchActiveBuckets,
  fetchChatHistory,
  fetchMemoryQuery,
  postChatConfirmation,
  postChatMessage,
  postEntryMove,
} from "../assets/api.ts";

const chatRequest: ChatRequest = { message: "事实" };
const moveRequest: MoveEntryRequest = {
  entry_id: "entry-1",
  target_bucket_id: "bucket-2",
  command_text: "移动",
};
const appendRequest: ChatConfirmationRequest = {
  confirmation_granted: true,
  action: "append",
  attempt_id: "attempt-1",
  text: "事实",
  bucket_id: "bucket-1",
};

// These assignments and calls compile only if the browser client consumes the shared DTOs.
if (false) {
  const activePromise: Promise<ActiveBucketsResponse> = fetchActiveBuckets();
  const historyPromise: Promise<ChatHistoryResponse> = fetchChatHistory();
  const queryPromise: Promise<MemoryQueryResponse> = fetchMemoryQuery("接口 A");
  void [activePromise, historyPromise, queryPromise];
  void postChatMessage(chatRequest);
  void postEntryMove(moveRequest);
  void postChatConfirmation(appendRequest);
}

// @ts-expect-error append confirmation must name its target Bucket.
const invalidAppend: ChatConfirmationRequest = {
  confirmation_granted: true,
  action: "append",
  attempt_id: "attempt-1",
  text: "事实",
};
void invalidAppend;

const invalidCamelCase: MoveEntryRequest = {
  // @ts-expect-error HTTP DTOs use snake_case, not application camelCase.
  entryId: "entry-1",
  target_bucket_id: "bucket-2",
  command_text: "移动",
};
void invalidCamelCase;

test("frontend API signatures are bound to the shared HTTP DTOs", () => {
  assert.ok(true);
});
