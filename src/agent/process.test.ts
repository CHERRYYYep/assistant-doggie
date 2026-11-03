import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError, agentTaskSchema, sessionSchema } from "../domain/agent.ts";
import {
  AgentEventParser,
  MAX_AGENT_LINE_BYTES,
  buildAgentLaunch,
  runAgentProcess,
  withAgentCwd,
  CliAgentRunner,
  type AgentLaunchSpec,
} from "./process.ts";
const id = randomUUID();
const events = (backend: "codex" | "claude", output = "evidence") =>
  backend === "codex"
    ? [
        { type: "thread.started", thread_id: id },
        {
          type: "item.completed",
          item: { type: "agent_message", text: output },
        },
        { type: "turn.completed", usage: {} },
      ]
    : [
        { type: "system", subtype: "init", session_id: id },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: output,
          session_id: id,
        },
      ];
const jsonl = (value: unknown[]) =>
  value.map((v) => JSON.stringify(v)).join("\n") + "\n";
function request(
  backend: "claude" | "codex" = "codex",
  workspaceId: string | null = null,
  remoteId: string | null = null,
) {
  const session = sessionSchema.parse({
    id,
    backend,
    workspaceId,
    remoteId,
    createdAt: new Date().toISOString(),
  });
  const task = agentTaskSchema.parse({
    id: randomUUID(),
    sessionId: id,
    workspaceId,
    backend,
    instruction: "$(touch pwned)\n`unsafe`; read only",
    pendingActionId: randomUUID(),
    queueId: randomUUID(),
    status: "running",
    output: "",
    failureCode: null,
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
  });
  return {
    task,
    session,
    cwd: tmpdir(),
    databasePath: join(tmpdir(), "doggie-fixture.db"),
    signal: new AbortController().signal,
  };
}
test("T13 both CLI JSONL protocols: split UTF8, bounded final output, identity and terminal validation", () => {
  for (const backend of ["codex", "claude"] as const) {
    const parser = new AgentEventParser(backend);
    const bytes = Buffer.from(jsonl(events(backend, "中文事实")));
    for (const byte of bytes) parser.push(Uint8Array.of(byte));
    assert.deepEqual(parser.finish(), { output: "中文事实", remoteId: id });
    assert.throws(() => parser.push(Buffer.from("{}\n")), /invalid_event/);
    const invalid = new AgentEventParser(backend);
    assert.throws(
      () => invalid.push(Buffer.from("secret raw invalid\n")),
      /invalid_event/,
    );
    assert.throws(
      () => new AgentEventParser(backend).finish(),
      /invalid_event/,
    );
    assert.throws(
      () =>
        new AgentEventParser(backend).push(
          Buffer.alloc(MAX_AGENT_LINE_BYTES + 1, 120),
        ),
      /output_limit/,
    );
    assert.throws(
      () =>
        new AgentEventParser(backend).push(
          Buffer.from(jsonl(events(backend, "x".repeat(65537)))),
        ),
      /output_limit/,
    );
  }
  assert.throws(
    () =>
      new AgentEventParser("codex").push(
        Buffer.from('{"type":"item.completed","item":null}\n'),
      ),
    AgentError,
  );
  const changed = new AgentEventParser("claude");
  assert.throws(
    () =>
      changed.push(
        Buffer.from(
          jsonl([
            { type: "system", subtype: "init", session_id: id },
            { ...events("claude")[1], session_id: randomUUID() },
          ]),
        ),
      ),
    /invalid_event/,
  );
});
test("T13 launch commands use stdin, explicit session identities, read-only tools and isolated configuration", () => {
  for (const backend of ["codex", "claude"] as const) {
    const req = request(backend);
    const launch = buildAgentLaunch(req, process.execPath);
    assert.equal(launch.input, req.task.instruction);
    assert.ok(!launch.args.includes(req.task.instruction));
    assert.equal(launch.env["NODE_OPTIONS"], undefined);
    assert.equal(launch.env["OPENAI_API_KEY"], undefined);
    assert.equal(launch.env["DOGGIE_MCP_READ_ONLY"], "1");
    const resumed = buildAgentLaunch(
      request(backend, null, id),
      process.execPath,
    );
    if (backend === "codex") {
      assert.ok(launch.args.includes('sandbox_mode="read-only"'));
      assert.ok(launch.args.includes("shell_tool"));
      assert.ok(launch.args.includes("--ignore-user-config"));
      assert.ok(launch.args.includes("--ignore-rules"));
      assert.deepEqual(resumed.args.slice(-3), ["resume", id, "-"]);
      assert.ok(!resumed.args.includes("--last"));
      assert.ok(
        !buildAgentLaunch(
          request(backend, randomUUID()),
          process.execPath,
        ).args.includes("shell_tool"),
      );
    } else {
      assert.ok(launch.args.includes("--bare"));
      assert.ok(launch.args.includes("--restricted"));
      assert.equal(
        launch.args[launch.args.indexOf("--tools") + 1],
        "WebSearch",
      );
      assert.ok(resumed.args.includes("--resume"));
      assert.ok(!resumed.args.includes("--session-id"));
    }
  }
  assert.throws(() => buildAgentLaunch(request(), "relative"), /unavailable/);
});
test("T13 subprocess lifecycle: stdin, redaction, sanitized failure, missing executable and stderr budget", async () => {
  const script = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{for(const e of ${JSON.stringify(events("codex"))}){if(e.item)e.item.text=input;process.stdout.write(JSON.stringify(e)+'\\n');}});`;
  const spec: AgentLaunchSpec = {
    command: process.execPath,
    args: ["-e", script],
    cwd: tmpdir(),
    env: { FIXTURE_API_KEY: "private-key" },
    input: "stdin private-key $(never execute)",
  };
  assert.deepEqual(
    await runAgentProcess(spec, "codex", new AbortController().signal),
    { output: "stdin [redacted] $(never execute)", remoteId: id },
  );
  await assert.rejects(
    runAgentProcess(
      {
        ...spec,
        args: ["-e", "process.stderr.write('secret');process.exit(1)"],
      },
      "codex",
      new AbortController().signal,
    ),
    /process_failed/,
  );
  await assert.rejects(
    runAgentProcess(
      { ...spec, command: "/nonexistent/doggie-cli" },
      "codex",
      new AbortController().signal,
    ),
    /unavailable/,
  );
  await assert.rejects(
    runAgentProcess(
      {
        ...spec,
        args: [
          "-e",
          "process.stderr.write('x'.repeat(70000));setInterval(()=>{},1000)",
        ],
      },
      "codex",
      new AbortController().signal,
    ),
    /output_limit/,
  );
  await assert.rejects(
    new CliAgentRunner({ codex: process.execPath }).run(request()),
    /unavailable/,
  );
});
test("T13 cancellation kills stubborn process group and waits for close, with sanitized reason", async () => {
  const controller = new AbortController();
  const result = runAgentProcess(
    {
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{});const {spawn}=require('node:child_process');spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)",
      ],
      cwd: tmpdir(),
      env: {},
      input: "",
    },
    "codex",
    controller.signal,
  );
  const timer = setTimeout(
    () => controller.abort("secret cancellation reason"),
    200,
  );
  try {
    await assert.rejects(
      result,
      (e: unknown) =>
        e instanceof Error &&
        e.name === "AbortError" &&
        !e.message.includes("secret"),
    );
  } finally {
    clearTimeout(timer);
  }
});
test("T13 noncoding cwd stable per session; symlinks and world-readable state rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "doggie-cwd-test-"));
  const db = join(root, "test.db");
  try {
    const first = await withAgentCwd(null, db, id, async (cwd) => cwd);
    assert.equal(await withAgentCwd(null, db, id, async (cwd) => cwd), first);
    const otherId = randomUUID();
    await symlink(tmpdir(), join(root, ".doggie-agent-sessions", otherId));
    await assert.rejects(
      withAgentCwd(null, db, otherId, async () => {}),
      /invalid_workspace/,
    );
    const readableId = randomUUID();
    await mkdir(join(root, ".doggie-agent-sessions", readableId), {
      mode: 0o755,
    });
    await assert.rejects(
      withAgentCwd(null, db, readableId, async () => {}),
      /invalid_workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
