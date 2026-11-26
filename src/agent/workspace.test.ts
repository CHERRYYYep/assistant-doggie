import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspacePolicy } from "./workspace.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "doggie-workspace-links-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"],
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Fixture");
  await writeFile(join(repo, "baseline"), "baseline");
  git("add", ".");
  git("commit", "-qm", "baseline");
  return {
    root,
    repo,
    git,
    policy: new WorkspacePolicy([repo]),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

for (const tracked of [false, true]) {
  for (const directory of [false, true]) {
    test(`workspace rejects ${tracked ? "tracked" : "untracked"} external ${directory ? "directory" : "file"} symlinks`, async () => {
      const f = await fixture();
      try {
        const outside = join(f.root, "outside");
        if (directory) await mkdir(outside);
        else await writeFile(outside, "temporary test content");
        await symlink(outside, join(f.repo, "link\nwith-newline"));
        if (tracked) {
          f.git("add", ".");
          f.git("commit", "-qm", "track link");
        }
        await assert.rejects(f.policy.inspect(f.repo), /invalid_workspace/);
      } finally {
        await f.cleanup();
      }
    });
  }
}

test("workspace accepts internal file and directory symlinks and deleted tracked files", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.repo, "nested"));
    await writeFile(join(f.repo, "nested", "file"), "temporary test content");
    await symlink("nested/file", join(f.repo, "tracked-link"));
    f.git("add", ".");
    f.git("commit", "-qm", "track internal link");
    await symlink("nested", join(f.repo, "untracked-link"));
    await rm(join(f.repo, "baseline"));
    assert.equal((await f.policy.inspect(f.repo)).path, f.repo);
  } finally {
    await f.cleanup();
  }
});

test("workspace rejects a tracked directory replaced by an external symlink", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.repo, "nested"));
    await writeFile(join(f.repo, "nested", "file"), "original");
    f.git("add", ".");
    f.git("commit", "-qm", "track directory");
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "file"), "temporary test content");
    await rm(join(f.repo, "nested"), { recursive: true });
    await symlink(outside, join(f.repo, "nested"));
    await assert.rejects(f.policy.inspect(f.repo), /invalid_workspace/);
  } finally {
    await f.cleanup();
  }
});

test("workspace rejects dangling and chained external symlinks", async () => {
  const f = await fixture();
  try {
    await symlink("missing", join(f.repo, "link"));
    await assert.rejects(f.policy.inspect(f.repo), /invalid_workspace/);
    await rm(join(f.repo, "link"));
    const outside = join(f.root, "outside");
    await writeFile(outside, "temporary test content");
    await symlink(outside, join(f.repo, "target"));
    await symlink("target", join(f.repo, "link"));
    await assert.rejects(f.policy.inspect(f.repo), /invalid_workspace/);
  } finally {
    await f.cleanup();
  }
});

for (const kind of ["file", "directory", "nested"] as const) {
  test(`workspace rejects ignored external ${kind} symlinks`, async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.repo, ".gitignore"), "ignored\n");
      const outside = join(f.root, "outside");
      if (kind === "directory") await mkdir(outside);
      else await writeFile(outside, "temporary test content");
      if (kind === "nested") {
        await mkdir(join(f.repo, "ignored", "nested"), { recursive: true });
        await symlink(outside, join(f.repo, "ignored", "nested", "link"));
      } else {
        await symlink(outside, join(f.repo, "ignored"));
      }
      assert.equal(
        f.git("ls-files", "--others", "--exclude-standard").trim(),
        ".gitignore",
      );
      await assert.rejects(f.policy.inspect(f.repo), /invalid_workspace/);
    } finally {
      await f.cleanup();
    }
  });
}

test("workspace accepts ignored internal links including directory cycles without following them", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, ".gitignore"), "ignored\n");
    await mkdir(join(f.repo, "ignored"));
    await symlink("../baseline", join(f.repo, "ignored", "file"));
    await symlink("..", join(f.repo, "ignored", "directory"));
    assert.equal((await f.policy.inspect(f.repo)).path, f.repo);
  } finally {
    await f.cleanup();
  }
});

test("workspace rejects external symlinks inside Git metadata", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside");
    await writeFile(outside, "temporary test content");
    await symlink(outside, join(f.repo, ".git", "hidden-link"));
    await assert.rejects(f.policy.inspect(f.repo), /invalid_workspace/);
  } finally {
    await f.cleanup();
  }
});

test("workspace scanning fails closed when its time budget is exhausted", async (t) => {
  const f = await fixture();
  try {
    let checks = 0;
    t.mock.method(performance, "now", () => checks++ * 5_001);
    await assert.rejects(f.policy.inspect(f.repo), /invalid_workspace/);
    assert.ok(checks >= 2);
  } finally {
    t.mock.restoreAll();
    await f.cleanup();
  }
});
