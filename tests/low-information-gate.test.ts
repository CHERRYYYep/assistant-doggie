/**
 * Differential regression guard for the low-information gate.
 *
 * The expected column in `tests/fixtures/low-information-gate.tsv` was
 * produced by running each input through the **Rust** implementation
 * (`crates/doggie-domain/examples/low_info_oracle.rs`), not by hand. When
 * the Rust workspace is deleted this file is what preserves the behaviour it
 * encoded.
 *
 * The corpus stresses the parts of the rule that the ported unit tests do
 * not: every vague-reference × action pairing, action × Unicode-number
 * pairing, the 24-character boundary, and long inputs with no reference.
 *
 * Regenerate after an intentional rule change:
 *
 *   cargo build -p doggie-domain --example low_info_oracle --offline
 *   cut -f1 tests/fixtures/low-information-gate.tsv > /tmp/corpus.txt
 *   ./target/debug/examples/low_info_oracle < /tmp/corpus.txt > /tmp/out
 *   paste -d'\t' /tmp/corpus.txt /tmp/out > tests/fixtures/low-information-gate.tsv
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isLowInformationReference } from "../src/domain/classification.ts";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/low-information-gate.tsv", import.meta.url),
);

test("low-information gate matches the Rust implementation on the full corpus", () => {
  const rows = readFileSync(FIXTURE, "utf8").split("\n");
  const divergences: string[] = [];
  let checked = 0;
  let lowInformation = 0;

  for (const row of rows) {
    if (row === "") continue;
    const tab = row.lastIndexOf("\t");
    assert.notEqual(tab, -1, `malformed fixture row: ${row}`);
    const input = row.slice(0, tab);
    const expected = row.slice(tab + 1) === "1";

    const actual = isLowInformationReference(input);
    if (actual !== expected) {
      divergences.push(
        `${JSON.stringify(input)}: rust=${expected} ts=${actual}`,
      );
    }
    checked += 1;
    if (expected) lowInformation += 1;
  }

  assert.equal(
    divergences.length,
    0,
    `diverged from Rust:\n${divergences.slice(0, 20).join("\n")}`,
  );
  assert.ok(checked > 900, `corpus shrank to ${checked} rows`);
  // Guard against a rule that trivially answers "yes" or "no" to everything.
  assert.ok(
    lowInformation > 100 && lowInformation < checked - 100,
    "corpus lost its balance",
  );
});
