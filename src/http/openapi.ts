/** Deterministic OpenAPI 3.1 generation from the executable local HTTP contracts. */
import { z } from "zod";

import { HTTP_OPERATIONS, type HttpOperation } from "./operations.ts";
import { errorResponseSchema } from "./response-schemas.ts";

export const HTTP_ERROR_STATUSES = [
  400, 403, 404, 409, 415, 429, 500, 503,
] as const;

export function createOpenApiDocument(): Readonly<Record<string, unknown>> {
  const schemas: Record<string, unknown> = {};
  const registered = new Map<z.ZodType, string>();
  const component = (
    schema: z.ZodType,
    name: string,
    io: "input" | "output" = "output",
  ): Readonly<Record<string, string>> => {
    const known = registered.get(schema);
    if (known !== undefined) return { $ref: `#/components/schemas/${known}` };
    registered.set(schema, name);
    const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, {
      io,
      target: "draft-2020-12",
    });
    // Zod's recursive JSON values use local $defs. Their fragment references
    // must resolve against this component, not the surrounding OpenAPI root.
    schemas[name] = rewriteReferences(jsonSchema, name);
    return { $ref: `#/components/schemas/${name}` };
  };
  const failure = component(errorResponseSchema, "ErrorResponse");
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of HTTP_OPERATIONS as readonly HttpOperation[]) {
    const path = operation.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
    const contentType = operation.stream
      ? "text/event-stream"
      : "application/json";
    const successSchema = component(
      operation.responseSchema,
      `${operation.operationId}Response`,
    );
    const successContent = operation.stream
      ? {
          schema: { type: "string" },
          "x-event-name": "task",
          "x-event-data-schema": successSchema,
          "x-event-id": "payload.revision",
        }
      : { schema: successSchema };
    const responses: Record<string, unknown> = {
      [operation.successStatus]: {
        description: operation.stream
          ? "Bounded stream of current task snapshots"
          : "Success",
        content: { [contentType]: successContent },
      },
    };
    for (const status of HTTP_ERROR_STATUSES) {
      responses[status] = {
        description: "Stable local HTTP error",
        content: { "application/json": { schema: failure } },
      };
    }
    const parameters = [
      ...parameterSchemas(operation.paramsSchema, "path"),
      ...parameterSchemas(operation.querySchema, "query"),
    ];
    const entry = {
      operationId: operation.operationId,
      description:
        operation.description ??
        "Local-only HTTP operation. GET also supports HEAD with an empty response body.",
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(operation.bodySchema === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: component(
                    operation.bodySchema,
                    `${operation.operationId}Request`,
                    "input",
                  ),
                },
              },
            },
          }),
      ...(operation.feature === undefined
        ? {}
        : { "x-optional-feature": operation.feature }),
      responses,
    };
    const pathItem = paths[path] ?? {};
    pathItem[operation.method] = entry;
    paths[path] = pathItem;
  }
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Doggie local HTTP API",
      version: "0.1.0",
      description:
        "Personal local-first assistant. Loopback Host and same-origin policy are mandatory; JSON bodies only; no permissive CORS. No remote pairing, authentication or relay routes. Feature-gated task and agent routes may be unavailable. Custom semantic and byte-budget constraints remain enforced by runtime Zod/application rules. See docs/API_CONTRACT.md.",
    },
    // A relative server binds callers to the existing origin and advertises no
    // public address or a promise that arbitrary loopback ports are trusted.
    servers: [
      { url: "/", description: "The existing trusted loopback origin" },
    ],
    paths,
    components: { schemas },
  };
}

export function serializeOpenApi(): string {
  return `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`;
}

function parameterSchemas(
  schema: z.ZodObject | undefined,
  location: "path" | "query",
): readonly Readonly<Record<string, unknown>>[] {
  if (schema === undefined) return [];
  return Object.entries(schema.shape).map(([name, field]) => {
    // Query limits are coerced from URL text at runtime. Document their numeric
    // value constraint; converting a coercion's unknown input would erase it.
    const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(field, {
      io: "output",
      target: "draft-2020-12",
    });
    return {
      name,
      in: location,
      required: location === "path" || !field.isOptional(),
      schema: jsonSchema,
    };
  });
}

function rewriteReferences(value: unknown, componentName: string): unknown {
  if (Array.isArray(value))
    return value.map((child) => rewriteReferences(child, componentName));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] =
      key === "$ref" && typeof child === "string" && child.startsWith("#")
        ? `#/components/schemas/${componentName}${child.slice(1)}`
        : rewriteReferences(child, componentName);
  }
  return result;
}
