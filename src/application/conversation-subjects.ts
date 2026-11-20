import {
  normalized,
  type SubjectCandidate,
  type SubjectReference,
} from "../domain/main-conversation.ts";
import type { EntryRow } from "../storage/store.ts";
import { parseMemoryQuery } from "./memory-query.ts";
import type { MemoryQueryService } from "./query.ts";

export function entryCandidate(
  entry: EntryRow,
  memoryRevision: number,
): Extract<SubjectCandidate, { kind: "entry" }> {
  const label = /^([^:：\n]{2,90})[:：]/u.exec(entry.rawText)?.[1]?.trim();
  return {
    kind: "entry",
    id: entry.id,
    memoryRevision,
    title:
      label ||
      "摘要：" + (entry.summary?.trim() || entry.rawText.trim()).slice(0, 116),
    hint: entry.rawText.slice(0, 240),
    bucketId: entry.bucketId,
    createdAt: entry.createdAt,
  };
}

export function subjectRef(candidate: SubjectCandidate): SubjectReference {
  return candidate.kind === "entry"
    ? {
        kind: "entry",
        id: candidate.id,
        memoryRevision: candidate.memoryRevision,
      }
    : {
        kind: "work_item",
        id: candidate.id,
        scopeRevision: candidate.scopeRevision,
      };
}

export function locateEntries(
  query: MemoryQueryService,
  text: string,
  memoryRevision: number,
) {
  const plan = parseMemoryQuery(
    text
      .replace(
        /^(?:请\s*)?(?:帮我\s*)?(?:继续\s*)?(?:修改|改写|改|修订|查看|查找|回顾)\s*(?:那个|这个)?/u,
        "",
      )
      .slice(0, 500),
    7,
  );
  const terms = [
    ...new Set([
      ...plan.terms,
      ...(/计网|计算机网络|computer networks?/iu.test(text)
        ? ["TCP", "UDP"]
        : []),
    ]),
  ].slice(0, 24);
  if (terms.length === 0) return { candidates: [], truncated: false };
  const result = query.searchWithPlan({ ...plan, terms });
  const matches = result.results.filter(
    ({ matchedFields, entry }) =>
      matchedFields.includes("entry.raw_text") &&
      terms.some((term) =>
        normalized(entry.rawText).includes(normalized(term)),
      ),
  );
  return {
    candidates: matches
      .slice(0, 6)
      .map(({ entry }) => entryCandidate(entry, memoryRevision)),
    truncated: result.hasMore || matches.length > 6,
  };
}
