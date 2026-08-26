/**
 * Bucket summary composition.
 *
 * A Bucket summary is a rolling digest of its Entries, bounded in length. The
 * bound is what makes it usable as model context; the retention rule is what
 * keeps it meaningful once the bound bites.
 *
 * Pure functions, no database — the storage layer calls these inside its
 * transactions and the tests can exercise the edge cases directly.
 */

import { normalizedKey, truncateCharacters } from "../domain/text.ts";

/** Default cap on a Bucket summary, in Unicode characters. */
export const DEFAULT_SUMMARY_LIMIT = 1_200;

/** How many recent Entry summaries a rebuild considers. */
export const DEFAULT_REBUILD_ENTRY_LIMIT = 40;

/**
 * Fold `fragment` into `existing`, keeping the result within `maxCharacters`.
 *
 * The retention rule is deliberate: when the summary is too long, fragments
 * are dropped from **position 1**, never position 0 and never the newest. The
 * first fragment is what the Bucket is fundamentally about and the last is
 * what is currently happening; the middle is the part that ages out.
 *
 * A fragment whose normalized key already appears is not appended, so
 * repeating the same status a dozen times does not evict the origin.
 */
export function mergeBucketSummary(
  existing: string,
  fragment: string,
  maxCharacters: number = DEFAULT_SUMMARY_LIMIT,
): string {
  const parts = existing
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part !== "");

  const existingKeys = new Set(parts.map(normalizedKey));
  const cleanedFragment = fragment.trim();
  if (
    cleanedFragment !== "" &&
    !existingKeys.has(normalizedKey(cleanedFragment))
  ) {
    parts.push(cleanedFragment);
  }

  // Drop from the middle until it fits, but never below first + newest.
  while (
    countCharacters(parts.join("\n")) > maxCharacters &&
    parts.length > 2
  ) {
    parts.splice(1, 1);
  }

  const summary = parts.join("\n");
  if (countCharacters(summary) <= maxCharacters) return summary;

  // Still too long with only two fragments left: truncate and mark it.
  const truncated = truncateCharacters(
    summary,
    Math.max(maxCharacters - 1, 0),
  ).trimEnd();
  return `${truncated}…`;
}

/**
 * Rebuild a summary from scratch out of Entry summaries, oldest first.
 *
 * Used after a correction, when folding is no longer correct because an Entry
 * that contributed to the old summary has left the Bucket.
 */
export function rebuildBucketSummary(
  entrySummariesOldestFirst: readonly (string | null)[],
  maxCharacters: number = DEFAULT_SUMMARY_LIMIT,
): string {
  let summary = "";
  for (const entrySummary of entrySummariesOldestFirst) {
    if (entrySummary === null) continue;
    const cleaned = entrySummary.trim();
    if (cleaned === "") continue;
    summary = mergeBucketSummary(summary, cleaned, maxCharacters);
  }
  return summary;
}

/** Count Unicode characters, not UTF-16 code units. */
function countCharacters(value: string): number {
  return [...value].length;
}
