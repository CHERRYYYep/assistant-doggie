import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LlmApiMode,
  LlmConfigurationError,
  OFFICIAL_OPENAI_BASE_URL,
  resolveLlmEndpoint,
} from "./config.ts";

function configKind(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error: unknown) {
    return error instanceof LlmConfigurationError ? error.kind : undefined;
  }
}

test("endpoint configuration preserves secure official and compatible URL policy", () => {
  assert.deepEqual(resolveLlmEndpoint({}), {
    site: "official",
    baseUrl: OFFICIAL_OPENAI_BASE_URL,
    apiMode: LlmApiMode.Responses,
    isOfficial: true,
    requestUrl: "https://api.openai.com/v1/responses",
  });
  assert.equal(
    resolveLlmEndpoint({
      site: "local-gateway",
      baseUrl: "http://localhost:8000/v1/",
      apiMode: "chat",
    }).requestUrl,
    "http://localhost:8000/v1/chat/completions",
  );
  assert.equal(
    resolveLlmEndpoint({
      baseUrl: "http://[::1]:8000/v1",
      apiMode: "response",
    }).site,
    "custom",
  );
  assert.equal(
    resolveLlmEndpoint({
      site: "relay",
      baseUrl: "https://relay.example/v1/",
      apiMode: "chat-completions",
    }).baseUrl,
    "https://relay.example/v1",
  );

  assert.equal(
    configKind(() => resolveLlmEndpoint({ site: "relay" })),
    "missing_base_url",
  );
  assert.equal(
    configKind(() =>
      resolveLlmEndpoint({ site: "relay", baseUrl: "http://127.0.0.2/v1" }),
    ),
    "insecure_remote_base_url",
  );
  assert.equal(
    configKind(() =>
      resolveLlmEndpoint({
        site: "relay",
        baseUrl: "https://u:p@relay.example/v1",
      }),
    ),
    "credentials_in_base_url",
  );
  assert.equal(
    configKind(() =>
      resolveLlmEndpoint({
        site: "relay",
        baseUrl: "https://relay.example/v1?q=secret",
      }),
    ),
    "query_or_fragment_in_base_url",
  );
  assert.equal(
    configKind(() =>
      resolveLlmEndpoint({
        site: "relay",
        baseUrl: "https://relay.example:not-a-port/v1",
      }),
    ),
    "invalid_base_url",
  );
  assert.equal(
    configKind(() => resolveLlmEndpoint({ apiMode: "unknown" })),
    "invalid_api_mode",
  );
  assert.equal(
    configKind(() => resolveLlmEndpoint({ site: "bad\nsite" })),
    "invalid_site",
  );
});

test("endpoint configuration locks UTF-8 site and empty URL delimiter boundaries", () => {
  const endpoint = resolveLlmEndpoint({});
  assert.equal(Object.isFrozen(endpoint), true);
  assert.equal(
    Reflect.set(endpoint, "requestUrl", "http://attacker.example/steal"),
    false,
  );
  assert.equal(endpoint.requestUrl, "https://api.openai.com/v1/responses");

  assert.equal(
    resolveLlmEndpoint({
      site: "a".repeat(100),
      baseUrl: "https://relay.example/v1",
    }).site.length,
    100,
  );
  for (const site of ["a".repeat(101), "界".repeat(34)]) {
    assert.equal(
      configKind(() =>
        resolveLlmEndpoint({
          site,
          baseUrl: "https://relay.example/v1",
        }),
      ),
      "invalid_site",
    );
  }

  for (const baseUrl of [
    "https://relay.example/v1?",
    "https://relay.example/v1#",
    "https://relay.example/v1/?",
    "https://relay.example/v1/#",
  ]) {
    assert.equal(
      configKind(() => resolveLlmEndpoint({ site: "relay", baseUrl })),
      "query_or_fragment_in_base_url",
    );
  }
});
