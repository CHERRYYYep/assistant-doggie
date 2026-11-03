/** Print, update, or verify the checked-in OpenAPI document without starting Doggie. */
import { readFileSync, writeFileSync } from "node:fs";

import { serializeOpenApi } from "../src/http/openapi.ts";
import { serializeBrowserResponseContracts } from "../src/http/browser-contracts.ts";

const mode = process.argv[2];
const target = new URL("../docs/openapi.json", import.meta.url);
const generated = serializeOpenApi();
const artifacts = [
  { target, generated },
  {
    target: new URL("../web/assets/response-contracts.ts", import.meta.url),
    generated: serializeBrowserResponseContracts(),
  },
];
if (mode === "--write") {
  for (const artifact of artifacts)
    writeFileSync(artifact.target, artifact.generated);
} else if (mode === "--check") {
  for (const artifact of artifacts) {
    let current: string;
    try {
      current = readFileSync(artifact.target, "utf8");
    } catch {
      throw new Error(
        "API contract artifact is missing; run node scripts/openapi.ts --write",
      );
    }
    if (current !== artifact.generated)
      throw new Error(
        "API contract artifact is stale; run node scripts/openapi.ts --write",
      );
  }
} else if (mode === undefined) {
  process.stdout.write(generated);
} else {
  throw new Error("Use --write, --check, or no argument");
}
