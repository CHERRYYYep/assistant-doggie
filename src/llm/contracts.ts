/**
 * Strict model-output contracts and their JSON Schemas.
 *
 * The schema is sent to Responses or Chat Completions with `strict: true`,
 * while the runtime parser repeats every important check locally. A compatible
 * endpoint therefore cannot bypass Doggie's domain invariants by ignoring the
 * requested schema.
 */

import { z } from "zod";

import {
  createClassification,
  type ClassificationResult,
} from "../domain/classification.ts";
import { requiredText } from "../domain/errors.ts";
import { createExtraction, type ExtractionResult } from "../domain/memory.ts";
import { BucketType, ClassificationAction } from "../domain/types.ts";

export type JsonSchema = Readonly<Record<string, unknown>>;

export type StructuredOutputContract<T> = {
  readonly schemaName: string;
  readonly strictJsonSchema: JsonSchema;
  readonly parse: (value: unknown) => T;
};

const nullableString = z.string().nullable().optional();
const defaultedNullableStringArray = z
  .array(z.string())
  .nullable()
  .optional()
  .transform((value) => value ?? []);

const classificationInputSchema = z
  .object({
    action: z.enum([
      ClassificationAction.AppendExisting,
      ClassificationAction.CreateNew,
      ClassificationAction.AskUser,
    ]),
    bucket_id: nullableString,
    bucket_type: z
      .enum([
        BucketType.Idea,
        BucketType.Task,
        BucketType.Incident,
        BucketType.Experiment,
        BucketType.Decision,
        BucketType.Meeting,
        BucketType.Knowledge,
        BucketType.Draft,
      ])
      .nullable()
      .optional(),
    title: nullableString,
    confidence: z.number(),
    reason: z.string(),
    should_ask_user: z.boolean().optional().default(false),
    question: nullableString,
    candidate_bucket_ids: defaultedNullableStringArray,
  })
  .strict();

const timelineEventInputSchema = z
  .object({
    event_time: nullableString,
    text: z.string(),
  })
  .strict();

const extractionInputSchema = z
  .object({
    summary: z.string(),
    todos: defaultedNullableStringArray,
    evidences: defaultedNullableStringArray,
    timeline_events: z
      .array(timelineEventInputSchema)
      .optional()
      .default(() => []),
    decisions: defaultedNullableStringArray,
    hypotheses: defaultedNullableStringArray,
    entities: defaultedNullableStringArray,
    tags: defaultedNullableStringArray,
  })
  .strict();

const bucketSummaryInputSchema = z
  .object({
    summary: z.string(),
  })
  .strict();

const mainTurnRouteInputSchema = z
  .object({
    intent: z.enum(["answer", "lookup", "archive"]),
    archive_text: nullableString,
    reason: z.string(),
  })
  .strict();

export type BucketSummaryResult = {
  readonly summary: string;
};

export type MainTurnRouteResult =
  | {
      readonly intent: "answer" | "lookup";
      readonly archiveText: null;
      readonly reason: string;
    }
  | {
      readonly intent: "archive";
      readonly archiveText: string;
      readonly reason: string;
    };

export const classificationJsonSchema: JsonSchema = {
  additionalProperties: false,
  description: "A routing decision for one user memory entry.",
  properties: {
    action: {
      description: "Whether to append, create, or ask the user.",
      enum: ["append_existing", "create_new", "ask_user"],
      title: "Action",
      type: "string",
    },
    bucket_id: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Existing bucket ID when action is append_existing.",
      title: "Bucket Id",
    },
    bucket_type: {
      anyOf: [
        {
          enum: [
            "idea",
            "task",
            "incident",
            "experiment",
            "decision",
            "meeting",
            "knowledge",
            "draft",
          ],
          type: "string",
        },
        { type: "null" },
      ],
      description: "Selected type for a new bucket or the matched bucket type.",
      title: "Bucket Type",
    },
    candidate_bucket_ids: {
      description: "Likely bucket IDs to present when asking the user.",
      items: { type: "string" },
      title: "Candidate Bucket Ids",
      type: "array",
    },
    confidence: {
      description: "Confidence score between 0 and 1.",
      title: "Confidence",
      type: "number",
    },
    question: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Clarifying question when action is ask_user.",
      title: "Question",
    },
    reason: {
      description: "Short evidence-based explanation for the routing decision.",
      title: "Reason",
      type: "string",
    },
    should_ask_user: {
      default: false,
      description: "Whether user confirmation is required before persistence.",
      title: "Should Ask User",
      type: "boolean",
    },
    title: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Concise new bucket title when action is create_new.",
      title: "Title",
    },
  },
  required: [
    "action",
    "bucket_id",
    "bucket_type",
    "title",
    "confidence",
    "reason",
    "should_ask_user",
    "question",
    "candidate_bucket_ids",
  ],
  title: "ClassificationResult",
  type: "object",
};

export const extractionJsonSchema: JsonSchema = {
  $defs: {
    TimelineEventExtract: {
      additionalProperties: false,
      description: "A time expression and event extracted from the raw input.",
      properties: {
        event_time: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description:
            "Original time expression, or null when no time is stated.",
          title: "Event Time",
        },
        text: {
          description: "What happened at that time.",
          title: "Text",
          type: "string",
        },
      },
      required: ["event_time", "text"],
      title: "TimelineEventExtract",
      type: "object",
    },
  },
  additionalProperties: false,
  description: "Structured Doggie memory facts extracted from one raw entry.",
  properties: {
    decisions: {
      description: "Decisions or actions already taken.",
      items: { type: "string" },
      title: "Decisions",
      type: "array",
    },
    entities: {
      description:
        "Important systems, APIs, customers, projects, or components.",
      items: { type: "string" },
      title: "Entities",
      type: "array",
    },
    evidences: {
      description:
        "Logs, metrics, observations, test results, or user feedback.",
      items: { type: "string" },
      title: "Evidences",
      type: "array",
    },
    hypotheses: {
      description:
        "Unverified explanations or claims that still need validation.",
      items: { type: "string" },
      title: "Hypotheses",
      type: "array",
    },
    summary: {
      description: "Faithful one-sentence summary of the input.",
      title: "Summary",
      type: "string",
    },
    tags: {
      description: "Short labels useful for keyword search.",
      items: { type: "string" },
      title: "Tags",
      type: "array",
    },
    timeline_events: {
      description:
        "Events with their original time expressions when available.",
      items: { $ref: "#/$defs/TimelineEventExtract" },
      title: "Timeline Events",
      type: "array",
    },
    todos: {
      description: "Concrete actions that still need to be completed.",
      items: { type: "string" },
      title: "Todos",
      type: "array",
    },
  },
  required: [
    "summary",
    "todos",
    "evidences",
    "timeline_events",
    "decisions",
    "hypotheses",
    "entities",
    "tags",
  ],
  title: "ExtractionResult",
  type: "object",
};

export const bucketSummaryJsonSchema: JsonSchema = {
  additionalProperties: false,
  description: "A compact rolling summary for a long-lived Bucket.",
  properties: {
    summary: {
      title: "Summary",
      type: "string",
    },
  },
  required: ["summary"],
  title: "BucketSummaryResult",
  type: "object",
};

export const mainTurnRouteJsonSchema: JsonSchema = {
  additionalProperties: false,
  description:
    "Structured intent decision for a natural main-conversation user turn.",
  properties: {
    intent: {
      description:
        "Choose archive for personal todos/facts/schedules to save, lookup for personal memory queries, or answer for general chat/planning/clarification.",
      enum: ["answer", "lookup", "archive"],
      title: "Intent",
      type: "string",
    },
    archive_text: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "Exact faithful user text to archive when intent is archive; must be null otherwise.",
      title: "Archive Text",
    },
    reason: {
      description: "Concise rationale for the routing decision.",
      title: "Reason",
      type: "string",
    },
  },
  required: ["intent", "archive_text", "reason"],
  title: "MainTurnRouteResult",
  type: "object",
};

export const classificationContract: StructuredOutputContract<ClassificationResult> =
  {
    schemaName: "ClassificationResult",
    strictJsonSchema: classificationJsonSchema,
    parse(value) {
      const input = classificationInputSchema.parse(value);
      return createClassification({
        action: input.action,
        bucketId: input.bucket_id ?? undefined,
        bucketType: input.bucket_type ?? undefined,
        title: input.title ?? undefined,
        confidence: input.confidence,
        reason: input.reason,
        shouldAskUser: input.should_ask_user,
        question: input.question ?? undefined,
        candidateBucketIds: input.candidate_bucket_ids,
      });
    },
  };

export const extractionContract: StructuredOutputContract<ExtractionResult> = {
  schemaName: "ExtractionResult",
  strictJsonSchema: extractionJsonSchema,
  parse(value) {
    const input = extractionInputSchema.parse(value);
    return createExtraction({
      summary: input.summary,
      todos: input.todos,
      evidences: input.evidences,
      timelineEvents: input.timeline_events.map((event) => ({
        text: event.text,
        occurredAt: event.event_time ?? undefined,
      })),
      decisions: input.decisions,
      hypotheses: input.hypotheses,
      entities: input.entities,
      tags: input.tags,
    });
  },
};

export const bucketSummaryContract: StructuredOutputContract<BucketSummaryResult> =
  {
    schemaName: "BucketSummaryResult",
    strictJsonSchema: bucketSummaryJsonSchema,
    parse(value) {
      const input = bucketSummaryInputSchema.parse(value);
      return { summary: requiredText(input.summary, "summary") };
    },
  };

export const mainTurnRouteContract: StructuredOutputContract<MainTurnRouteResult> =
  {
    schemaName: "MainTurnRouteResult",
    strictJsonSchema: mainTurnRouteJsonSchema,
    parse(value) {
      const input = mainTurnRouteInputSchema.parse(value);
      const reason = requiredText(input.reason, "reason");
      if (input.intent === "archive") {
        const archiveText = requiredText(
          input.archive_text ?? "",
          "archive_text",
        );
        return { intent: "archive", archiveText, reason };
      }
      return { intent: input.intent, archiveText: null, reason };
    },
  };
