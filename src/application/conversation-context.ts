import { z } from "zod";
import { materialText } from "../domain/natural-reply.ts";
import type { WorkItem } from "../domain/work-item.ts";
import { withCancellation, throwIfAborted } from "../llm/cancellation.ts";
import type { Store } from "../storage/store.ts";
import { parseMemoryQuery } from "./memory-query.ts";
import { MemoryQueryService } from "./query.ts";

export const MAX_SUPPLEMENTS = 32;
const MAX_CONTEXT_BYTES = 28 * 1024;
const MAX_ENTRIES = 6;
const MAX_SOURCE_BYTES = 8 * 1024;

type Citation = { readonly entryId: string; readonly bucketId: string };
type Evidence = Citation & { readonly text: string };
export type ConversationContext = {
  readonly original: string;
  readonly operation?: "rewrite" | "lookup";
  readonly subject?: {
    readonly kind: "entry" | "work_item";
    readonly id: string;
  };
  readonly materialSources?: readonly {
    readonly messageId: string;
    readonly text: string;
  }[];
  readonly supplements: readonly string[];
  readonly target: Pick<
    WorkItem,
    | "id"
    | "title"
    | "goal"
    | "acceptance"
    | "status"
    | "lastAttemptId"
    | "lastAttemptStatus"
  > | null;
};
const answerSchema = z.union([
  z.strictObject({ kind: z.literal("missing") }),
  z.strictObject({
    kind: z.literal("answer"),
    text: z.string().trim().min(1).max(4000).nullable(),
    quotes: z
      .array(
        z.strictObject({
          entryId: z.string().min(1).max(200).nullable(),
          quote: z.string().trim().min(2).max(1500),
        }),
      )
      .min(1)
      .max(MAX_ENTRIES),
  }),
]);
export type GroundedInput = ConversationContext & {
  readonly evidence: readonly Evidence[];
  readonly material: readonly string[];
};
export type GroundedResponder = (
  input: GroundedInput,
  signal?: AbortSignal,
) => Promise<unknown>;
export type GroundedResult = {
  readonly text: string;
  readonly citations: readonly Citation[];
  readonly materialMessageIds?: readonly string[];
  readonly missing?: boolean;
};
const noEvidence = (target: ConversationContext["target"]): GroundedResult => ({
  text:
    target === null
      ? "现有有效记录没有提供足够依据回答这个问题。"
      : "我已关联目标和要求，但没有找到能支撑改写或回答的材料。请补充原文，或在卡片中选择工作区创建只读检查提案。",
  citations: [],
  missing: true,
});
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export class ConversationContextService {
  readonly #memory: Pick<Store, "getEntry" | "searchEntryCandidates">;
  readonly #query: MemoryQueryService;
  readonly #answer: GroundedResponder | undefined;
  constructor(
    memory: Pick<Store, "getEntry" | "searchEntryCandidates">,
    answer?: GroundedResponder,
  ) {
    this.#memory = memory;
    this.#query = new MemoryQueryService(memory);
    this.#answer = answer;
  }
  async answer(
    context: ConversationContext,
    directIds: readonly string[],
    allowTitleSearch: boolean,
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<GroundedResult> {
    const material =
      context.materialSources?.map(({ text }) => text) ??
      (context.target === null
        ? []
        : [context.original, ...context.supplements].flatMap((text) => {
            const part = materialText(text);
            return part === undefined ? [] : [part];
          }));
    const base = { ...context, material };
    if (
      context.supplements.length > MAX_SUPPLEMENTS ||
      bytes(base) > MAX_CONTEXT_BYTES
    )
      return {
        text: "原请求和补充超出本轮上下文上限。请用更聚焦的新请求继续；旧要求未被截断。",
        citations: [],
      };
    const direct = this.#load(directIds);
    const tryAnswer = async (candidates: readonly Evidence[]) => {
      let evidence: Evidence[] = [];
      for (const part of candidates) {
        if (evidence.length >= MAX_ENTRIES) break;
        if (
          bytes({ ...base, evidence: [...evidence, part] }) <= MAX_CONTEXT_BYTES
        )
          evidence = [...evidence, part];
      }
      if ((evidence.length === 0 && material.length === 0) || !current())
        return undefined;
      const answer = this.#answer;
      if (answer === undefined)
        return {
          text: "材料已定位，但回答模型当前不可用。请查看所列原始记录。",
          citations: evidence.map(({ entryId, bucketId }) => ({
            entryId,
            bucketId,
          })),
        };
      throwIfAborted(signal);
      const raw = await withCancellation(signal, () =>
        answer({ ...base, evidence }, signal),
      );
      throwIfAborted(signal);
      const parsed = answerSchema.safeParse(raw);
      if (!parsed.success)
        return {
          text: "回复未通过证据校验，请查看原始材料或缩小问题。",
          citations: [],
        };
      if (parsed.data.kind === "missing") return undefined;
      const citations = new Map<string, Citation>();
      const quotes: string[] = [];
      const materialMessageIds = new Set<string>();
      for (const { entryId, quote } of parsed.data.quotes) {
        if (entryId === null) {
          if (!material.some((source) => source.includes(quote)))
            return {
              text: "回复未通过证据校验，请查看原始材料或缩小问题。",
              citations: [],
            };
          const source = context.materialSources?.find(({ text }) =>
            text.includes(quote),
          );
          if (source !== undefined) materialMessageIds.add(source.messageId);
        } else {
          const source = evidence.find((part) => part.entryId === entryId);
          if (source === undefined || !source.text.includes(quote))
            return {
              text: "回复未通过证据校验，请查看原始材料或缩小问题。",
              citations: [],
            };
          citations.set(entryId, { entryId, bucketId: source.bucketId });
        }
        quotes.push(quote);
      }
      // A personal lookup only returns verbatim excerpts. A bound rewrite can
      // compose new text, but must refer to a verified piece of source material.
      const rewrite =
        context.operation === "rewrite" ||
        (context.operation === undefined && context.target !== null);
      if (rewrite && parsed.data.text === null) return undefined;
      return {
        text: !rewrite
          ? [...new Set(quotes)].join("\n\n")
          : (parsed.data.text ?? ""),
        citations: [...citations.values()],
        materialMessageIds: [...materialMessageIds],
      };
    };
    if (direct.length > 0 || material.length > 0) {
      const first = await tryAnswer(direct);
      if (first !== undefined) return first;
      if (context.operation !== undefined) return noEvidence(context.target);
    }
    if (!current()) return noEvidence(context.target);
    const searchTerm =
      context.subject?.kind === "entry"
        ? ""
        : context.target === null
          ? lookupTerms(context.original)
          : allowTitleSearch
            ? context.target.title
            : "";
    if (!searchTerm) return noEvidence(context.target);
    const query = parseMemoryQuery(searchTerm, 12);
    const results = this.#query.searchWithPlan({
      ...query,
      timeRange: undefined,
      statuses: [],
    }).results;
    const admitted = results.filter(
      ({ entry, matchedFields }) =>
        matchedFields.includes("entry.raw_text") &&
        (context.target === null || entry.rawText.includes(searchTerm)) &&
        !direct.some(({ entryId }) => entryId === entry.id),
    );
    const fallback = this.#load(admitted.map(({ entry }) => entry.id));
    if (fallback.length === 0) return noEvidence(context.target);
    return (
      (await tryAnswer([...fallback, ...direct])) ?? noEvidence(context.target)
    );
  }
  entry(id: string) {
    return this.#memory.getEntry(id);
  }
  query() {
    return this.#query;
  }
  #load(ids: readonly string[]): Evidence[] {
    return [...new Set(ids)].flatMap((id) => {
      const entry = this.#memory.getEntry(id);
      return entry !== undefined && bytes(entry.rawText) <= MAX_SOURCE_BYTES
        ? [{ entryId: id, bucketId: entry.bucketId, text: entry.rawText }]
        : [];
    });
  }
}

function lookupTerms(question: string): string {
  return [
    ...question
      .trim()
      .replace(
        /^(?:请\s*)?(?:帮我\s*)?(?:查(?:找|询|一下)|搜索|检索|翻一下|回顾)?\s*(?:我(?:们)?(?:的)?\s*)?(?:上次|上回|之前的?记录|先前的?记录)?\s*/u,
        "",
      )
      .replace(
        /(?:的)?(?:联系人的?号码|联系人|电话号码|手机号|是什么时候|是何时|在什么时候|什么时候|是什么|是多少|的日期|日期|号码)(?:是多少|是什么|是几号)?[？?。！!\s]*$/u,
        "",
      )
      .replace(/[？?。！!\s]+$/u, "")
      .replace(/^「(.+)」$/u, "$1"),
  ]
    .slice(0, 500)
    .join("")
    .trim();
}

export function explicitGoalReview(text: string): string | undefined {
  return /^(?:请\s*)?(?:查一下|回顾|查看|核对)\s*「([^」]+)」\s*的(?:验收要求|目标状态|状态)[。？?]?$/u.exec(
    text.trim(),
  )?.[1];
}
