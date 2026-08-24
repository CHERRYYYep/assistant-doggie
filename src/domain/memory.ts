/**
 * Extraction results: the structured memory derived from an Entry's raw text.
 *
 * Derived, and therefore rebuildable — which is why `entries.raw_text` is the
 * only column that must never be lost. Extraction may be wrong; the user's
 * original words may not be.
 */

import { DomainError, requiredText } from "./errors.ts";
import { normalizeStringList } from "./text.ts";

/** The structured memory kinds stored in `memory_items`. */
export const MemoryKind = {
  Summary: "summary",
  Todo: "todo",
  Evidence: "evidence",
  Timeline: "timeline",
  Decision: "decision",
  Hypothesis: "hypothesis",
  Entity: "entity",
  Tag: "tag",
} as const;
export type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

export const MEMORY_KINDS: readonly MemoryKind[] = Object.values(MemoryKind);

export function isMemoryKind(value: unknown): value is MemoryKind {
  return (
    typeof value === "string" &&
    (MEMORY_KINDS as readonly string[]).includes(value)
  );
}

export type TimelineEvent = {
  readonly text: string;
  readonly occurredAt: string | undefined;
};

declare const extractionBrand: unique symbol;

type ExtractionFields = {
  readonly summary: string;
  readonly todos: readonly string[];
  readonly evidences: readonly string[];
  readonly timelineEvents: readonly TimelineEvent[];
  readonly decisions: readonly string[];
  readonly hypotheses: readonly string[];
  readonly entities: readonly string[];
  readonly tags: readonly string[];
};

export type ExtractionResult = ExtractionFields & {
  readonly [extractionBrand]: true;
};

export type ExtractionInput = {
  readonly summary: string;
  readonly todos?: readonly string[];
  readonly evidences?: readonly string[];
  readonly timelineEvents?: readonly TimelineEvent[];
  readonly decisions?: readonly string[];
  readonly hypotheses?: readonly string[];
  readonly entities?: readonly string[];
  readonly tags?: readonly string[];
};

/**
 * Validate an extraction.
 *
 * A summary is mandatory — an extraction with nothing to say should not have
 * been produced. Every list is trimmed and de-duplicated; timeline events keep
 * their order because sequence is their meaning.
 */
export function createExtraction(input: ExtractionInput): ExtractionResult {
  const timelineEvents = (input.timelineEvents ?? []).map((event) => {
    const text = requiredText(event.text, "timeline event text");
    const occurredAt = event.occurredAt?.trim();
    return {
      text,
      occurredAt:
        occurredAt === undefined || occurredAt === "" ? undefined : occurredAt,
    };
  });

  const fields: ExtractionFields = {
    summary: requiredText(input.summary, "summary"),
    todos: normalizeStringList(input.todos ?? []),
    evidences: normalizeStringList(input.evidences ?? []),
    timelineEvents,
    decisions: normalizeStringList(input.decisions ?? []),
    hypotheses: normalizeStringList(input.hypotheses ?? []),
    entities: normalizeStringList(input.entities ?? []),
    tags: normalizeStringList(input.tags ?? []),
  };
  return fields as ExtractionResult;
}

/** The smallest valid extraction: a summary and nothing else. */
export function minimalExtraction(summary: string): ExtractionResult {
  return createExtraction({ summary });
}

/** Flatten the structured child records derived from an extraction. */
export type ExtractedMemoryRow = {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly status: string | null;
  readonly occurredAt: string | null;
  readonly source: string | null;
};

/**
 * Entry summaries stay on `entries.summary`; they are not duplicated as memory
 * rows. Todo and evidence metadata mirrors the Rust canonical store.
 */
export function extractionToMemoryRows(
  extraction: ExtractionResult,
): ExtractedMemoryRow[] {
  const rows: ExtractedMemoryRow[] = [];
  const push = (
    kind: MemoryKind,
    values: readonly string[],
    metadata: Pick<ExtractedMemoryRow, "status" | "source"> = {
      status: null,
      source: null,
    },
  ) => {
    for (const text of values) {
      rows.push({ kind, text, ...metadata, occurredAt: null });
    }
  };
  push(MemoryKind.Todo, extraction.todos, { status: "open", source: null });
  push(MemoryKind.Evidence, extraction.evidences, {
    status: null,
    source: "llm",
  });
  for (const event of extraction.timelineEvents) {
    rows.push({
      kind: MemoryKind.Timeline,
      text: event.text,
      status: null,
      occurredAt: event.occurredAt ?? null,
      source: null,
    });
  }
  push(MemoryKind.Decision, extraction.decisions);
  push(MemoryKind.Hypothesis, extraction.hypotheses);
  push(MemoryKind.Entity, extraction.entities);
  push(MemoryKind.Tag, extraction.tags);
  return rows;
}

/** Re-exported so callers do not need to reach into the errors module. */
export { DomainError };
