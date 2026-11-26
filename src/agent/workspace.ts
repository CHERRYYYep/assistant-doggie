/** Canonical directory checks and immutable git baseline, without shell evaluation. */
import {
  realpath,
  stat,
  lstat,
  readFile,
  readlink,
  opendir,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { AgentError } from "../domain/agent.ts";
const exec = promisify(execFile);
const directoryScanLimits = {
  entries: 100_000,
  directories: 10_000,
  durationMs: 5_000,
} as const;
export type WorkspaceSnapshot = {
  readonly path: string;
  readonly baseCommit: string;
  readonly gitStatus: string;
};
export class WorkspacePolicy {
  readonly #roots: readonly string[];
  constructor(roots: readonly string[]) {
    this.#roots = roots.map((root) => {
      if (!isAbsolute(root)) throw new AgentError("invalid_workspace");
      return resolve(root);
    });
  }
  async inspect(input: string): Promise<WorkspaceSnapshot> {
    if (!this.#roots.length) throw new AgentError("disabled");
    try {
      if (!isAbsolute(input) || input.includes("\0")) throw new Error();
      const path = await realpath(input);
      const roots = await Promise.all(
        this.#roots.map((root) => realpath(root)),
      );
      if (
        !roots.some((root) => within(root, path)) ||
        !(await stat(path)).isDirectory()
      )
        throw new Error();
      // Git excludes ignored paths and its metadata; neither may hide an escape.
      await assertContainedTree(path);
      const options = {
        cwd: path,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8" as const,
        env: {
          PATH: process.env["PATH"],
          HOME: process.env["HOME"],
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        },
      };
      const git = async (...args: string[]) =>
        (
          await exec(
            "git",
            [
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.hooksPath=/dev/null",
              ...args,
            ],
            options,
          )
        ).stdout.trim();
      const top = await realpath(await git("rev-parse", "--show-toplevel"));
      if (top !== path) throw new Error();
      const baseCommit = await git("rev-parse", "--verify", "HEAD");
      if (!/^[a-f0-9]{40,64}$/u.test(baseCommit)) throw new Error();
      const porcelain = await git(
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      );
      // Fingerprint changed contents too; porcelain alone misses subsequent edits.
      // Reject huge snapshots and submodules rather than claim an incomplete baseline.
      const tracked = (await git("ls-files", "--stage", "-z"))
        .split("\0")
        .filter(Boolean);
      for (const entry of tracked) {
        const delimiter = entry.indexOf("\t");
        if (entry.startsWith("160000 ") || delimiter < 0) throw new Error();
        await assertContainedPath(path, entry.slice(delimiter + 1));
      }
      const digest = createHash("sha256");
      digest.update(
        await git(
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          "HEAD",
          "--",
        ),
      );
      const untracked = (
        await git("ls-files", "--others", "--exclude-standard", "-z")
      )
        .split("\0")
        .filter(Boolean)
        .sort();
      if (untracked.length > 1000) throw new Error();
      let size = 0;
      for (const name of untracked) {
        const file = resolve(path, name);
        await assertContainedPath(path, name);
        const info = await lstat(file);
        if (!info.isFile() && !info.isSymbolicLink()) throw new Error();
        size += info.size;
        if (size > 8 * 1024 * 1024) throw new Error();
        const data = info.isSymbolicLink()
          ? Buffer.from(await readlink(file))
          : await readFile(file);
        digest.update(JSON.stringify([name, info.mode, data.length]));
        digest.update(data);
      }
      const gitStatus = JSON.stringify({
        porcelain,
        digest: digest.digest("hex"),
      });
      return { path, baseCommit, gitStatus };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError("invalid_workspace");
    }
  }
}
/** Enumerate metadata only, including ignored paths; never follow directory links. */
async function assertContainedTree(root: string): Promise<void> {
  const deadline = performance.now() + directoryScanLimits.durationMs;
  const pending = [root];
  let entries = 0;
  let directories = 1;
  const checkBudget = () => {
    if (
      entries > directoryScanLimits.entries ||
      directories > directoryScanLimits.directories ||
      performance.now() > deadline
    )
      throw new Error();
  };
  while (pending.length > 0) {
    checkBudget();
    const current = pending.pop();
    if (current === undefined) throw new Error();
    if (!within(root, await realpath(current))) throw new Error();
    const directory = await opendir(current);
    for await (const entry of directory) {
      entries++;
      checkBudget();
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (!within(root, await realpath(path))) throw new Error();
      } else if (entry.isDirectory()) {
        directories++;
        checkBudget();
        pending.push(path);
      }
      checkBudget();
    }
  }
  checkBudget();
}
/** Check each component so a replaced parent directory cannot redirect reads. */
async function assertContainedPath(root: string, name: string): Promise<void> {
  const file = resolve(root, name);
  if (!within(root, file)) throw new Error();
  let current = root;
  for (const component of relative(root, file).split(sep)) {
    current = resolve(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      // Tracked paths can be deleted in an otherwise valid dirty baseline.
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    if (info.isSymbolicLink() && !within(root, await realpath(current)))
      throw new Error();
  }
}
function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part))
  );
}
export function assertWorkspaceUnchanged(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): void {
  if (
    before.path !== after.path ||
    before.baseCommit !== after.baseCommit ||
    before.gitStatus !== after.gitStatus
  )
    throw new AgentError("workspace_changed");
}
