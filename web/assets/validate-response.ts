/** Bounded validation of the generated JSON Schema subset, with no runtime dependencies. */
import { RESPONSE_CONTRACTS } from "./response-contracts.ts";

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const KEYWORDS = new Set([
  "$defs",
  "$ref",
  "$schema",
  "type",
  "const",
  "enum",
  "anyOf",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "items",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "format",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function reference(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/$defs/")) return undefined;
  let current = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!record(current) || !own(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** Only the generated subset is interpreted; unknown validation keywords fail closed. */
export function matchesResponseSchema(value: unknown, schema: unknown): boolean {
  let remaining = MAX_NODES;
  const visit = (item: unknown, rule: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > MAX_DEPTH) return false;
    if (typeof rule === "boolean") return rule;
    if (!record(rule) || Object.keys(rule).some((key) => !KEYWORDS.has(key))) return false;
    const ref = rule["$ref"];
    if (ref !== undefined) {
      if (typeof ref !== "string" || !visit(item, reference(schema, ref), depth + 1)) return false;
    }
    if (own(rule, "const") && item !== rule["const"]) return false;
    if (own(rule, "enum")) {
      const values = rule["enum"];
      if (!Array.isArray(values) || !values.some((value) => item === value)) return false;
    }
    if (own(rule, "anyOf")) {
      const alternatives = rule["anyOf"];
      if (
        !Array.isArray(alternatives) ||
        !alternatives.some((alternative) => visit(item, alternative, depth + 1))
      )
        return false;
    }
    if (own(rule, "oneOf")) {
      const alternatives = rule["oneOf"];
      if (!Array.isArray(alternatives)) return false;
      let matched = false;
      for (const alternative of alternatives) {
        if (visit(item, alternative, depth + 1)) {
          if (matched) return false;
          matched = true;
        }
      }
      if (!matched) return false;
    }
    const type = rule["type"];
    if (type === undefined) return true;
    switch (type) {
      case "null":
        return item === null;
      case "boolean":
        return typeof item === "boolean";
      case "number":
      case "integer": {
        if (
          typeof item !== "number" ||
          !Number.isFinite(item) ||
          (type === "integer" && !Number.isSafeInteger(item))
        )
          return false;
        for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
          const boundary = rule[key];
          if (boundary === undefined) continue;
          if (typeof boundary !== "number" || !Number.isFinite(boundary)) return false;
          if (
            (key === "minimum" && item < boundary) ||
            (key === "maximum" && item > boundary) ||
            (key === "exclusiveMinimum" && item <= boundary) ||
            (key === "exclusiveMaximum" && item >= boundary)
          )
            return false;
        }
        return true;
      }
      case "string": {
        if (typeof item !== "string") return false;
        // Zod string length follows JavaScript UTF-16 units; generated limits
        // preserve the server's concrete behavior rather than reinterpret it.
        const minimum = rule["minLength"];
        const maximum = rule["maxLength"];
        if (
          (minimum !== undefined && (typeof minimum !== "number" || item.length < minimum)) ||
          (maximum !== undefined && (typeof maximum !== "number" || item.length > maximum))
        )
          return false;
        const pattern = rule["pattern"];
        if (pattern !== undefined) {
          if (typeof pattern !== "string" || pattern.length > 16_384) return false;
          try {
            if (!new RegExp(pattern, "u").test(item)) return false;
          } catch {
            return false;
          }
        }
        const format = rule["format"];
        if (format !== undefined && format !== "date-time" && format !== "uuid") return false;
        // Current Zod formats always emit a concrete pattern. Refuse a future
        // unconstrained format instead of silently treating it as plain text.
        if (format !== undefined && pattern === undefined) return false;
        return true;
      }
      case "array": {
        if (!Array.isArray(item)) return false;
        const minimum = rule["minItems"];
        const maximum = rule["maxItems"];
        if (
          (minimum !== undefined && (typeof minimum !== "number" || item.length < minimum)) ||
          (maximum !== undefined && (typeof maximum !== "number" || item.length > maximum))
        )
          return false;
        const child = rule["items"];
        if (child === undefined) return false;
        return item.every((value) => visit(value, child, depth + 1));
      }
      case "object": {
        if (!record(item)) return false;
        const properties = rule["properties"];
        if (properties !== undefined && !record(properties)) return false;
        const required = rule["required"];
        if (
          required !== undefined &&
          (!Array.isArray(required) ||
            required.some((key) => typeof key !== "string" || !own(item, key)))
        )
          return false;
        for (const [key, child] of Object.entries(item)) {
          if (own(rule, "propertyNames") && !visit(key, rule["propertyNames"], depth + 1))
            return false;
          if (properties !== undefined && own(properties, key)) {
            if (!visit(child, properties[key], depth + 1)) return false;
          } else {
            const additional = rule["additionalProperties"];
            if (additional === undefined || !visit(child, additional, depth + 1)) return false;
          }
        }
        return true;
      }
      default:
        return false;
    }
  };
  try {
    return visit(value, schema, 0);
  } catch {
    return false;
  }
}

export function validateResponse(
  value: unknown,
  method: string,
  pathname: string,
  success: boolean,
): void {
  const schemas: Readonly<Record<string, unknown>> = RESPONSE_CONTRACTS.schemas;
  const normalizedMethod = method.toLowerCase();
  const route = RESPONSE_CONTRACTS.operations.find((operation) => {
    if (operation.method !== normalizedMethod) return false;
    const parts = pathname.split("/");
    const template = operation.path.split("/");
    return (
      template.length === parts.length &&
      template.every((part, index) =>
        part.startsWith(":") ? (parts[index]?.length ?? 0) > 0 : part === parts[index],
      )
    );
  });
  const schema = success
    ? route === undefined
      ? undefined
      : schemas[route.schema]
    : schemas["ErrorResponse"];
  if (schema === undefined || !matchesResponseSchema(value, schema)) {
    const label = pathname.startsWith("/api/agent/workspaces")
      ? "工作区"
      : pathname.startsWith("/api/agent")
        ? "Agent"
        : pathname.startsWith("/api/tasks")
          ? "任务"
          : "API";
    throw new Error(`${label} 响应格式无效`);
  }
}
