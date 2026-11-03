import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";

import type * as dto from "./dto.ts";
import { createOpenApiDocument, serializeOpenApi } from "./openapi.ts";
import { HTTP_OPERATIONS, operationFor } from "./operations.ts";
import * as schema from "./response-schemas.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return Object.fromEntries(Object.entries(value));
}

// Zod includes undefined explicitly for optional fields; JSON serialization
// omits them. Normalize this difference from exact handwritten optional DTOs.
type JsonOptional<T> = T extends readonly (infer Item)[]
  ? readonly JsonOptional<Item>[]
  : T extends object
    ? {
        [Key in keyof T]:
          JsonOptional<T[Key]> | ({} extends Pick<T, Key> ? undefined : never);
      }
    : T;
function acceptsDto<T>(_schema: z.ZodType<JsonOptional<T>>): void {}
acceptsDto<dto.BucketDto>(schema.bucketResponseSchema);
acceptsDto<dto.EntryDto>(schema.entryResponseSchema);
acceptsDto<dto.MemoryDto>(schema.memoryResponseSchema);
acceptsDto<dto.BucketDetailDto>(schema.bucketDetailSchema);
acceptsDto<dto.CandidateBucketDto>(schema.candidateBucketSchema);
acceptsDto<dto.ArchiveExtractionDto>(schema.archiveExtractionSchema);
acceptsDto<dto.ArchiveProjectionDto>(schema.archiveProjectionSchema);
acceptsDto<dto.DiscardedArchiveDto>(schema.discardedArchiveSchema);
acceptsDto<dto.ChatMessageDto>(schema.chatMessageSchema);
acceptsDto<dto.QueryPlanDto>(schema.queryPlanSchema);
acceptsDto<dto.MemoryQueryResponse>(schema.memoryQueryResponseSchema);
acceptsDto<dto.ActiveBucketsResponse>(schema.activeBucketsResponseSchema);
acceptsDto<dto.BucketSearchResponse>(schema.bucketSearchResponseSchema);
acceptsDto<dto.BucketDetailResponse>(schema.bucketDetailResponseSchema);
acceptsDto<dto.ChatHistoryResponse>(schema.chatHistoryResponseSchema);
acceptsDto<dto.ChatResponse>(schema.chatResponseSchema);
acceptsDto<dto.ChatConfirmationResponse>(schema.chatConfirmationResponseSchema);
acceptsDto<dto.MoveEntryResponse>(schema.moveEntryResponseSchema);
acceptsDto<dto.DeleteBucketResponse>(schema.deleteBucketResponseSchema);
acceptsDto<dto.BucketStatusResponse>(schema.bucketStatusResponseSchema);
acceptsDto<dto.ErrorResponse>(schema.errorResponseSchema);

test("operation registry covers every explicit Hono route once with unique IDs", () => {
  const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
  const actual = [...source.matchAll(/app\.(get|post|delete)\(\s*"([^"]+)"/gu)]
    .map((match) => `${match[1]} ${match[2]}`)
    .sort();
  const registered = HTTP_OPERATIONS.map(
    (operation) => `${operation.method} ${operation.path}`,
  ).sort();
  assert.deepEqual(registered, actual);
  assert.equal(new Set(registered).size, registered.length);
  assert.equal(
    new Set(HTTP_OPERATIONS.map((operation) => operation.operationId)).size,
    registered.length,
  );
  for (const operation of HTTP_OPERATIONS) {
    const path = operation.path.replace(/:[^/]+/gu, "test-id");
    assert.equal(
      operationFor(operation.method, path)?.operationId,
      operation.operationId,
    );
    if (operation.method === "get")
      assert.equal(
        operationFor("HEAD", path)?.operationId,
        operation.operationId,
      );
  }
  assert.equal(operationFor("post", "/api/not-registered"), undefined);
});

test("generated OpenAPI is deterministic, checked in, and has resolvable schema references", () => {
  assert.equal(serializeOpenApi(), serializeOpenApi());
  assert.equal(
    readFileSync(new URL("../../docs/openapi.json", import.meta.url), "utf8"),
    serializeOpenApi(),
  );
  const document = createOpenApiDocument();
  assert.equal(document["openapi"], "3.1.0");
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") {
        assert.equal(typeof child, "string");
        assert.ok(child.startsWith("#/components/schemas/"));
        let target: unknown = document;
        for (const segment of child.slice(2).split("/")) {
          target =
            record(target)[segment.replace(/~1/gu, "/").replace(/~0/gu, "~")];
          assert.notEqual(target, undefined, `unresolved ${child}`);
        }
      } else visit(child);
    }
  };
  visit(document);
});

test("OpenAPI preserves query defaults, confirmation inputs, empty DELETE and SSE framing", () => {
  const document = createOpenApiDocument();
  const paths = record(document["paths"]);
  const active = record(record(paths["/api/buckets/active"])["get"]);
  const parameters = active["parameters"];
  assert.ok(Array.isArray(parameters));
  assert.equal(record(parameters[0])["required"], false);
  assert.equal(record(record(parameters[0])["schema"])["default"], 20);
  assert.equal(record(record(parameters[0])["schema"])["maximum"], 100);
  const revoke = record(record(paths["/api/entries/{entryId}"])["delete"]);
  assert.equal(revoke["requestBody"], undefined);
  const watch = record(record(paths["/api/tasks/{taskId}/events"])["get"]);
  const success = record(record(watch["responses"])["200"]);
  const content = record(record(success["content"])["text/event-stream"]);
  assert.equal(content["x-event-name"], "task");
  assert.equal(content["x-event-id"], "payload.revision");
  const components = record(record(document["components"])["schemas"]);
  const moveInput = record(components["moveEntryRequest"]);
  assert.ok(Array.isArray(moveInput["required"]));
  assert.ok(!moveInput["required"].includes("command_text"));
});

test("strict response schemas preserve chat recovery and reject unknown error details", () => {
  const message = {
    id: "message-1",
    sequence: 1,
    role: "user",
    content: "原文",
    tool_name: null,
    tool_call_id: null,
    details: { archive: { arbitrary_legacy: true } },
    created_at: "2026-11-03T00:00:00.000Z",
  };
  assert.deepEqual(
    schema.errorResponseSchema.parse({
      ok: false,
      error: "failed",
      user_message: message,
    }),
    { ok: false, error: "failed", user_message: message },
  );
  assert.equal(
    schema.errorResponseSchema.safeParse({
      ok: false,
      error: "failed",
      secret: "must not leak",
    }).success,
    false,
  );
  assert.equal(
    schema.chatHistoryResponseSchema.safeParse({
      ok: true,
      messages: [message],
    }).success,
    true,
  );
  assert.equal(
    schema.chatHistoryResponseSchema.safeParse({
      ok: true,
      messages: [{ ...message, sequence: "1" }],
    }).success,
    false,
  );
  assert.equal(
    schema.bucketDetailResponseSchema.safeParse({ ok: true, detail: {} })
      .success,
    false,
  );
  assert.equal(
    schema.revokeEntryResponseSchema.safeParse({
      ok: true,
      entry_id: "old-id",
      bucket_id: "bucket-1",
      correction_id: "correction-1",
      revoked_at: "invalid",
      memory_item_ids: [],
    }).success,
    false,
  );
  assert.equal(
    schema.revokeEntryResponseSchema.safeParse({
      ok: true,
      entry_id: "old-id",
      bucket_id: "bucket-1",
      correction_id: "correction-1",
      revoked_at: "2026-11-03T00:00:00.000Z",
      memory_item_ids: [],
    }).success,
    true,
  );
});

test("task stream data and REST payload share the same strict snapshot schema", () => {
  const task = {
    id: "00000000-0000-4000-8000-000000000001",
    status: "running",
    revision: 2,
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:01.000Z",
    errorCode: null,
  };
  assert.deepEqual(
    schema.taskResponseSchema.parse({ ok: true, task }).task,
    schema.taskEventDataSchema.parse(task),
  );
  assert.equal(
    schema.taskEventDataSchema.safeParse({ ...task, revision: 0 }).success,
    false,
  );
  assert.equal(
    schema.taskEventDataSchema.safeParse({ ...task, command: "untrusted" })
      .success,
    false,
  );
});
