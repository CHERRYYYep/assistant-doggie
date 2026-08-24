import assert from "node:assert/strict";
import { test } from "node:test";

import { LlmApiMode } from "./config.ts";
import {
  parseWireResponse,
  WireResponseError,
  type WireResponseErrorKind,
} from "./wire-response.ts";

function errorKind(run: () => unknown): WireResponseErrorKind | undefined {
  try {
    run();
    return undefined;
  } catch (error: unknown) {
    return error instanceof WireResponseError ? error.kind : undefined;
  }
}

function responseMessage(
  text: string,
  phase?: string,
): Record<string, unknown> {
  return {
    type: "message",
    id: "msg-fixture",
    role: "assistant",
    status: "completed",
    ...(phase === undefined ? {} : { phase }),
    content: [{ type: "output_text", text, annotations: [], logprobs: null }],
  };
}

test("Responses prefers the first final-answer phase across multiple messages", () => {
  const parsed = parseWireResponse(LlmApiMode.Responses, {
    status: "completed",
    output: [
      responseMessage('{"summary":"commentary"}', "commentary"),
      responseMessage('{"summary":"final"}', "final_answer"),
      responseMessage('{"summary":"later"}', "final_answer"),
    ],
  });
  assert.deepEqual(parsed, {
    kind: "final_text",
    text: '{"summary":"final"}',
  });

  assert.deepEqual(
    parseWireResponse(LlmApiMode.Responses, {
      output: [
        responseMessage("   ", "final_answer"),
        responseMessage('{"summary":"fallback"}'),
      ],
    }),
    { kind: "final_text", text: '{"summary":"fallback"}' },
  );
});

test("Responses reports refusal incomplete filtering and nonterminal statuses", () => {
  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.Responses, {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "cannot process" }],
          },
        ],
      }),
    ),
    "refusal",
  );
  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.Responses, {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ),
    "incomplete",
  );
  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.Responses, {
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      }),
    ),
    "content_filter",
  );
  for (const status of ["failed", "cancelled", "queued", "in_progress"]) {
    assert.equal(
      errorKind(() => parseWireResponse(LlmApiMode.Responses, { status })),
      "unexpected_status",
    );
  }
  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.Responses, { status: "future" }),
    ),
    "invalid_response",
  );
});

test("Responses preserves tool calls and never silently selects coexisting text", () => {
  const output = [
    responseMessage('{"summary":"must wait"}', "final_answer"),
    {
      type: "function_call",
      id: "fc-1",
      call_id: " call-1 ",
      name: " search_memory ",
      arguments: "{not parsed here}",
      status: "completed",
    },
  ];
  assert.deepEqual(
    parseWireResponse(LlmApiMode.Responses, { status: "completed", output }),
    {
      kind: "tool_calls",
      calls: [
        {
          callId: "call-1",
          name: "search_memory",
          arguments: "{not parsed here}",
        },
      ],
      continuation: output,
    },
  );

  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.Responses, {
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: " ",
            name: "tool",
            arguments: "{}",
          },
        ],
      }),
    ),
    "invalid_tool_call",
  );
});

test("Chat Completions parses first-choice text and explicit terminal errors", () => {
  const parsed = parseWireResponse(LlmApiMode.ChatCompletions, {
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: '  {"summary":"first"}  ' },
      },
      {
        finish_reason: "stop",
        message: { role: "assistant", content: '{"summary":"ignored"}' },
      },
    ],
  });
  assert.deepEqual(parsed, {
    kind: "final_text",
    text: '{"summary":"first"}',
  });

  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.ChatCompletions, { choices: [] }),
    ),
    "missing_response",
  );
  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.ChatCompletions, {
        choices: [{ finish_reason: "length", message: { content: null } }],
      }),
    ),
    "incomplete",
  );
  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.ChatCompletions, {
        choices: [
          { finish_reason: "content_filter", message: { content: null } },
        ],
      }),
    ),
    "content_filter",
  );
  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.ChatCompletions, {
        choices: [
          {
            finish_reason: "stop",
            message: { refusal: "cannot process", content: null },
          },
        ],
      }),
    ),
    "refusal",
  );
});

test("Chat Completions preserves modern calls and rejects legacy function_call", () => {
  const message = {
    role: "assistant",
    content: '{"summary":"not final"}',
    tool_calls: [
      {
        id: " call-1 ",
        type: "function",
        function: { name: " search_memory ", arguments: "{}" },
      },
    ],
  };
  assert.deepEqual(
    parseWireResponse(LlmApiMode.ChatCompletions, {
      choices: [{ finish_reason: "tool_calls", message }],
    }),
    {
      kind: "tool_calls",
      calls: [{ callId: "call-1", name: "search_memory", arguments: "{}" }],
      continuation: [message],
    },
  );

  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.ChatCompletions, {
        choices: [
          {
            finish_reason: "function_call",
            message: {
              content: null,
              function_call: { name: "search_memory", arguments: "{}" },
            },
          },
        ],
      }),
    ),
    "invalid_tool_call",
  );
  assert.equal(
    errorKind(() =>
      parseWireResponse(LlmApiMode.ChatCompletions, {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{ id: "custom-1", type: "custom", custom: {} }],
            },
          },
        ],
      }),
    ),
    "invalid_tool_call",
  );
});
