import {
  createRepeatRule,
  createTodoRawTime,
  type RepeatRule,
  type TodoRawTime,
} from "../domain/todo.ts";
import { StorageError } from "./database.ts";
import type { JsonValue } from "./store.ts";

export function parseMetadata(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

export function parseTodoRule(value: string | null): RepeatRule | null {
  if (value === null) return null;
  try {
    return createRepeatRule(JSON.parse(value) as unknown);
  } catch {
    throw StorageError.invalidWrite(
      "todo_rule_json",
      "contains invalid stored data",
    );
  }
}

export function parseTodoRawTime(value: string | null): TodoRawTime | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error();
    const candidate = parsed as {
      readonly scheduledText?: unknown;
      readonly dueText?: unknown;
      readonly timeZone?: unknown;
    };
    return createTodoRawTime({
      scheduledText: candidate.scheduledText,
      dueText: candidate.dueText,
      timeZone: candidate.timeZone,
    });
  } catch {
    throw StorageError.invalidWrite(
      "todo_raw_time_json",
      "contains invalid stored data",
    );
  }
}
