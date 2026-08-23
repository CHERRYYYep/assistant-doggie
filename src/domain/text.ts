/**
 * Text identity rules shared by tag merging, evidence de-duplication and
 * summary de-duplication.
 *
 * The Rust implementation this replaces used the `unicode-casefold` crate.
 * JavaScript has no built-in case folding, and `toLowerCase()` is **not**
 * equivalent — it leaves `ß` alone and produces a context-sensitive final
 * sigma, so `"ΟΣ"` and `"ος"` would compare unequal.
 *
 * `toUpperCase().toLowerCase()` recovers most of full folding (it expands
 * ligatures and `ß`), and the two remaining divergences from the Rust
 * behaviour are handled explicitly:
 *
 *   - `ẞ` (U+1E9E) is already uppercase, so the round trip yields `ß` rather
 *     than `ss`; both sharp-s forms are expanded up front.
 *   - final sigma `ς` is re-mapped to `σ` after lowercasing.
 *
 * This is an approximation of Unicode full case folding, not an
 * implementation of it. It is exact for the cases the Rust tests pin
 * (`Straße`, `ẞ`, `ΟΣ`/`ος`) and for Latin, Greek and Cyrillic generally. It
 * is not guaranteed for every `Status=F` entry in `CaseFolding.txt`. If a
 * future feature needs conformant folding, replace this one function.
 */

const SHARP_S = /[ßẞ]/g;
const FINAL_SIGMA = /ς/g;
const WHITESPACE_RUN = /\s+/g;

/** Case-fold `value` for identity comparison. */
export function unicodeCaseFold(value: string): string {
  return value
    .replace(SHARP_S, "ss")
    .toUpperCase()
    .toLowerCase()
    .replace(FINAL_SIGMA, "σ");
}

/**
 * The comparison key for "are these two strings the same thing".
 *
 * Trims, collapses internal whitespace runs to a single space, then folds.
 */
export function normalizedKey(value: string): string {
  return unicodeCaseFold(value.trim().replace(WHITESPACE_RUN, " "));
}

/**
 * Trim `value`, returning `undefined` when nothing is left.
 *
 * Mirrors the Rust `normalize_optional_text`: an all-whitespace field is
 * absent, not empty.
 */
export function normalizeOptionalText(
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const cleaned = value.trim();
  return cleaned === "" ? undefined : cleaned;
}

/**
 * Trim each entry, drop empties, and de-duplicate **exactly** — preserving
 * order and original casing.
 *
 * Note this is exact de-duplication, not folded: the Rust
 * `normalize_string_list` uses a plain `HashSet<String>`, so `"Rust"` and
 * `"rust"` both survive here. Folded de-duplication is a separate rule that
 * belongs to tag merging, below.
 */
export function normalizeStringList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (cleaned !== "" && !seen.has(cleaned)) {
      seen.add(cleaned);
      normalized.push(cleaned);
    }
  }
  return normalized;
}

/**
 * Merge tag lists, de-duplicating by folded key while keeping the **first**
 * spelling seen.
 *
 * `merge(["Payments"], ["payments", "Rust"])` is `["Payments", "Rust"]`: the
 * existing casing wins, the new distinct tag is appended.
 */
export function mergeTags(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of [...existing, ...incoming]) {
    const cleaned = value.trim();
    if (cleaned === "") continue;
    const key = normalizedKey(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(cleaned);
  }
  return merged;
}

/**
 * Truncate to `maxCharacters` **Unicode characters**, not UTF-16 code units.
 *
 * Counting code units would split a surrogate pair and corrupt any
 * non-BMP character; the Rust implementation counts `char`s for the same
 * reason.
 */
export function truncateCharacters(
  value: string,
  maxCharacters: number,
): string {
  if (maxCharacters <= 0) return "";
  const characters = [...value];
  return characters.length <= maxCharacters
    ? value
    : characters.slice(0, maxCharacters).join("");
}
