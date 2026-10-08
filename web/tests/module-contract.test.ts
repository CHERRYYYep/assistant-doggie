import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const assets = new URL("../assets/", import.meta.url);

test("browser runtime imports remain local and only api.ts can fetch or open event streams", () => {
  const files = readdirSync(assets).filter((name) => name.endsWith(".ts"));
  const imports = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(new URL(file, assets), "utf8");
    // Type-only shared imports must disappear from the actual served browser graph.
    const runtime = stripTypeScriptTypes(source);
    const dependencies: string[] = [];
    for (const match of runtime.matchAll(/\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)) {
      const specifier = match[1];
      assert.ok(specifier);
      assert.ok(specifier.startsWith("./"), `${file}: nonlocal runtime import ${specifier}`);
      const dependency = specifier.slice(2);
      assert.ok(files.includes(dependency), `${file}: missing module ${dependency}`);
      dependencies.push(dependency);
    }
    if (file !== "api.ts") {
      // Check the served runtime, not type-only declarations or explanatory comments.
      const code = runtime.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      assert.ok(
        !/\b(?:fetch|EventSource|XMLHttpRequest|WebSocket)\s*(?:\(|\[|\.)/.test(code),
        `${file}: network access outside api.ts`,
      );
    }
    imports.set(file, dependencies);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const walk = (file: string): void => {
    assert.ok(!visiting.has(file), `circular runtime dependency at ${file}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const child of imports.get(file) ?? []) walk(child);
    visiting.delete(file);
    visited.add(file);
  };
  walk("app.ts");
  assert.equal(visited.size, files.length, "all frontend assets must be in the real module graph");
});

test("task UI markup remains external-script/CSP compatible", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(!/\s(?:style|on\w+)\s*=/i.test(html));
  assert.ok(!/<style\b/i.test(html));
  assert.deepEqual(
    [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((match) => [
      match[1],
      match[2],
    ]),
    [[' type="module" src="assets/app.ts"', ""]],
  );
});
