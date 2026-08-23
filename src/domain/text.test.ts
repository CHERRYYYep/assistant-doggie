import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mergeTags,
  normalizeOptionalText,
  normalizeStringList,
  normalizedKey,
  truncateCharacters,
  unicodeCaseFold,
} from "./text.ts";

/**
 * These four assertions are ported verbatim from the Rust test
 * `normalization_matches_legacy_casefold_and_whitespace_rules`
 * (`crates/doggie-storage-sqlite/src/archive_write.rs`). They are the
 * behaviour contract, not examples.
 */
test("normalization matches the Rust casefold and whitespace rules", () => {
  assert.equal(normalizedKey("  Straße\tSTATUS  "), "strasse status");
  assert.equal(normalizedKey("ΟΣ  ος"), "οσ οσ");
  assert.deepEqual(mergeTags(["Payments"], ["payments", "Rust"]), [
    "Payments",
    "Rust",
  ]);
  assert.equal(unicodeCaseFold("ẞ"), "ss");
});

test("case folding makes the forms that must compare equal actually equal", () => {
  for (const [a, b] of [
    ["Straße", "STRASSE"],
    ["ΟΣ", "ος"],
    ["ǅ", "ǆ"],
    ["Ĳ", "ĳ"],
    ["ПРИВЕТ", "привет"],
  ] as const) {
    assert.equal(
      unicodeCaseFold(a),
      unicodeCaseFold(b),
      `${a} should fold equal to ${b}`,
    );
  }
});

test("case folding keeps genuinely different strings different", () => {
  assert.notEqual(unicodeCaseFold("payments"), unicodeCaseFold("payment"));
  assert.notEqual(unicodeCaseFold("接口 A"), unicodeCaseFold("接口 B"));
});

test("normalizedKey trims and collapses whitespace runs", () => {
  assert.equal(normalizedKey("  a   b  "), "a b");
  assert.equal(normalizedKey("a\t\n b"), "a b");
  assert.equal(normalizedKey(""), "");
  assert.equal(normalizedKey("   "), "");
});

test("optional text treats all-whitespace as absent", () => {
  assert.equal(normalizeOptionalText("  hi  "), "hi");
  assert.equal(normalizeOptionalText("   "), undefined);
  assert.equal(normalizeOptionalText(""), undefined);
  assert.equal(normalizeOptionalText(null), undefined);
  assert.equal(normalizeOptionalText(undefined), undefined);
});

test("string list de-duplicates exactly, preserving order and casing", () => {
  // Exact, not folded: the Rust HashSet<String> keeps both spellings.
  assert.deepEqual(normalizeStringList([" a ", "a", "b", "A", ""]), [
    "a",
    "b",
    "A",
  ]);
  assert.deepEqual(normalizeStringList([]), []);
  assert.deepEqual(normalizeStringList(["  ", "\t"]), []);
});

test("tag merge de-duplicates by folded key and keeps the first spelling", () => {
  assert.deepEqual(mergeTags(["Rust"], ["RUST", "rust"]), ["Rust"]);
  assert.deepEqual(mergeTags([], ["  spaced  "]), ["spaced"]);
  assert.deepEqual(mergeTags(["Straße"], ["strasse"]), ["Straße"]);
});

test("truncation counts Unicode characters, never splitting a surrogate pair", () => {
  assert.equal(truncateCharacters("abcdef", 3), "abc");
  assert.equal(truncateCharacters("abc", 10), "abc");
  assert.equal(truncateCharacters("接口压测结果", 2), "接口");
  // Each emoji is one character but two UTF-16 code units.
  assert.equal(truncateCharacters("👍👍👍", 2), "👍👍");
  assert.equal([...truncateCharacters("👍👍👍", 2)].length, 2);
  assert.equal(truncateCharacters("abc", 0), "");
});
