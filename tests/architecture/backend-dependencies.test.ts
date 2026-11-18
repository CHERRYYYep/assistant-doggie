import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { existsSync } from "node:fs";

test("chat and read-only tool paths do not depend on HTTP or MCP adapters, including type imports", () => {
  const visited = new Set<string>();
  const dependencies = (url: URL): void => {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    assert.doesNotMatch(url.pathname, /\/src\/(?:http|mcp)\//u);
    const imports = readFileSync(url, "utf8").matchAll(
      /(?:from\s*|import\s*|import\(\s*)["'](\.[^"']+)["']/gu,
    );
    for (const [, specifier] of imports) {
      if (specifier === undefined || !specifier.endsWith(".ts")) continue;
      const dependency = new URL(specifier, url);
      assert.ok(existsSync(dependency), "Cannot read " + dependency.pathname);
      dependencies(dependency);
    }
  };
  for (const file of [
    "application/chat.ts",
    "application/memory-tools.ts",
    "agent/harness.ts",
    "application/task-queue.ts",
  ])
    dependencies(new URL(`../../src/${file}`, import.meta.url));
});
