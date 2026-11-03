import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";

import {
  matchesResponseSchema,
  validateResponse,
} from "../../web/assets/validate-response.ts";
import {
  createBrowserResponseContracts,
  serializeBrowserResponseContracts,
} from "./browser-contracts.ts";
import { HTTP_OPERATIONS, type HttpOperation } from "./operations.ts";
import { errorResponseSchema } from "./response-schemas.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return Object.fromEntries(Object.entries(value));
}

function example(schema: unknown, root: unknown = schema): unknown {
  const rule = record(schema);
  const ref = rule["$ref"];
  if (typeof ref === "string") {
    let target = root;
    for (const part of ref.slice(2).split("/"))
      target = record(target)[part.replace(/~1/gu, "/").replace(/~0/gu, "~")];
    return example(target, root);
  }
  if (Object.prototype.hasOwnProperty.call(rule, "const")) return rule["const"];
  if (Array.isArray(rule["enum"])) return rule["enum"][0];
  if (Array.isArray(rule["anyOf"])) {
    const alternatives = rule["anyOf"];
    return example(
      alternatives.find((candidate) => record(candidate)["type"] === "null") ??
        alternatives[0],
      root,
    );
  }
  switch (rule["type"]) {
    case "object": {
      const result: Record<string, unknown> = {};
      const properties = record(rule["properties"] ?? {});
      const required = rule["required"];
      assert.ok(required === undefined || Array.isArray(required));
      for (const key of required ?? []) {
        assert.equal(typeof key, "string");
        result[key] = example(properties[key], root);
      }
      return result;
    }
    case "array":
      return [];
    case "null":
      return null;
    case "boolean":
      return false;
    case "number":
    case "integer":
      return typeof rule["exclusiveMinimum"] === "number"
        ? rule["exclusiveMinimum"] + 1
        : (rule["minimum"] ?? 0);
    case "string": {
      if (rule["format"] === "date-time") return "2026-11-03T00:00:00.000Z";
      if (rule["format"] === "uuid")
        return "00000000-0000-4000-8000-000000000001";
      if (typeof rule["pattern"] === "string" && rule["pattern"].includes("40"))
        return "a".repeat(40);
      return "x".repeat(
        typeof rule["minLength"] === "number" ? rule["minLength"] : 0,
      );
    }
    default:
      throw new Error("unsupported fixture schema");
  }
}

test("generated browser contracts are deterministic and match the operation schemas", () => {
  const generated = createBrowserResponseContracts();
  assert.equal(
    readFileSync(
      new URL("../../web/assets/response-contracts.ts", import.meta.url),
      "utf8",
    ),
    serializeBrowserResponseContracts(),
  );
  assert.equal(
    serializeBrowserResponseContracts(),
    serializeBrowserResponseContracts(),
  );
  for (const operation of HTTP_OPERATIONS as readonly HttpOperation[]) {
    if (operation.stream) continue;
    const descriptor = generated.operations.find(
      (candidate) =>
        candidate.method === operation.method &&
        candidate.path === operation.path,
    );
    assert.ok(descriptor);
    const { $schema: _dialect, ...expected } = z.toJSONSchema(
      operation.responseSchema,
    );
    assert.deepEqual(generated.schemas[descriptor.schema], expected);
    const fixture = example(expected);
    assert.equal(
      operation.responseSchema.safeParse(fixture).success,
      true,
      operation.operationId,
    );
    assert.equal(
      matchesResponseSchema(fixture, expected),
      true,
      operation.operationId,
    );
    const pathname = operation.path.replace(
      /:[^/]+/gu,
      "00000000-0000-4000-8000-000000000001",
    );
    validateResponse(fixture, operation.method, pathname, true);
    const invalid = { ...record(fixture), unexpected: "not in contract" };
    assert.equal(
      operation.responseSchema.safeParse(invalid).success,
      false,
      operation.operationId,
    );
    assert.equal(
      matchesResponseSchema(invalid, expected),
      false,
      operation.operationId,
    );
    assert.throws(() =>
      validateResponse(invalid, operation.method, pathname, true),
    );
    for (const key of Object.keys(record(fixture))) {
      const incomplete = { ...record(fixture) };
      delete incomplete[key];
      assert.equal(
        matchesResponseSchema(incomplete, expected),
        operation.responseSchema.safeParse(incomplete).success,
        `${operation.operationId}.${key}`,
      );
    }
  }
});

test("browser schema interpreter rejects unsupported rules, broken refs and resource exhaustion", () => {
  assert.equal(
    matchesResponseSchema("x", { type: "string", unknownConstraint: true }),
    false,
  );
  assert.equal(
    matchesResponseSchema("x", { $ref: "https://example.com/schema" }),
    false,
  );
  assert.equal(matchesResponseSchema("x", { $ref: "#/$defs/missing" }), false);
  assert.equal(
    matchesResponseSchema("x", { type: "string", pattern: "[" }),
    false,
  );
  assert.equal(
    matchesResponseSchema("x", { type: "string", format: "future-format" }),
    false,
  );
  const errorSchema = z.toJSONSchema(errorResponseSchema);
  let nested: unknown = null;
  for (let depth = 0; depth < 70; depth++) nested = { value: nested };
  assert.equal(
    matchesResponseSchema(
      {
        ok: false,
        error: "x",
        user_message: {
          id: "x",
          sequence: 1,
          role: "user",
          content: "x",
          tool_name: null,
          tool_call_id: null,
          details: nested,
          created_at: "2026-11-03T00:00:00.000Z",
        },
      },
      errorSchema,
    ),
    false,
  );
  assert.equal(
    matchesResponseSchema(
      Array.from({ length: 100_001 }, () => null),
      { type: "array", items: { type: "null" } },
    ),
    false,
  );
  assert.throws(() =>
    validateResponse({ ok: true }, "GET", "/api/unknown", true),
  );
});

test("browser and Zod agree on JSON metadata, nulls, confidence, dates and integer constraints", () => {
  const contracts = createBrowserResponseContracts();
  const route = contracts.operations.find(
    (operation) => operation.path === "/api/chat/history",
  );
  assert.ok(route);
  const jsonSchema = contracts.schemas[route.schema];
  const runtime = (HTTP_OPERATIONS as readonly HttpOperation[]).find(
    (operation) => operation.path === route.path,
  )?.responseSchema;
  assert.ok(runtime);
  const message = {
    id: "x",
    sequence: 1,
    role: "user",
    content: "x",
    tool_name: null,
    tool_call_id: null,
    details: { array: [null, true, 1, "text", { nested: "value" }] },
    created_at: "2026-11-03T00:00:00.000Z",
  };
  for (const candidate of [
    { ok: true, messages: [message] },
    { ok: true, messages: [{ ...message, sequence: 0 }] },
    { ok: true, messages: [{ ...message, created_at: "yesterday" }] },
    { ok: true, messages: [{ ...message, details: { invalid: Infinity } }] },
  ])
    assert.equal(
      matchesResponseSchema(candidate, jsonSchema),
      runtime.safeParse(candidate).success,
    );
  const archiveOperation = (HTTP_OPERATIONS as readonly HttpOperation[]).find(
    (operation) => operation.operationId === "archive",
  );
  assert.ok(archiveOperation);
  const archiveSchema = z.toJSONSchema(archiveOperation.responseSchema);
  const archive = record(example(archiveSchema));
  for (const confidence of [-0.01, 0, 0.5, 1, 1.01, null, "1"]) {
    const candidate = { ...archive, confidence };
    assert.equal(
      matchesResponseSchema(candidate, archiveSchema),
      archiveOperation.responseSchema.safeParse(candidate).success,
    );
  }
});
