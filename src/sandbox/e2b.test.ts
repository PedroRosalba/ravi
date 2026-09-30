import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SandboxConfigError,
  describeCommandError,
  githubCloneAuth,
  resolveSandboxCredentials,
  runE2bSandboxTask,
  shellQuote,
  type CreateSandboxInput,
  type SandboxHandle,
} from "./e2b.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ravi-sandbox-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeOptions {
  statuses?: string[];
  failOn?: RegExp;
  failWith?: unknown;
}

const PATCH = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n \n-a\n+b\n";

function fakeSandbox(options: FakeOptions = {}) {
  const commands: string[] = [];
  const statuses = [...(options.statuses ?? ["in_progress", "done"])];
  const state = {
    killed: false,
    kills: 0,
    paused: false,
    created: null as CreateSandboxInput | null,
    cloned: null as unknown,
  };
  const handle: SandboxHandle = {
    sandboxId: "sbx-test",
    commands: {
      async run(cmd) {
        commands.push(cmd);
        if (options.failOn?.test(cmd)) throw options.failWith ?? new Error(`boom: ${cmd}`);
        if (cmd.startsWith("ravi tasks create")) return { stdout: JSON.stringify({ task: { id: "task-1" } }) };
        if (cmd.startsWith("ravi tasks show")) {
          const status = statuses.length > 1 ? statuses.shift() : statuses[0];
          return {
            stdout: JSON.stringify({
              task: {
                id: "task-1",
                status,
                progress: status === "done" ? 100 : 10,
              },
            }),
          };
        }
        if (cmd.includes("git diff")) return { stdout: PATCH };
        if (cmd.includes("git write-tree")) return { stdout: "tree-base\n" };
        if (cmd.startsWith("cat ")) return { stdout: "# TASK" };
        return { stdout: "" };
      },
    },
    git: {
      async clone(url, opts) {
        state.cloned = { url, ...opts };
      },
    },
    async kill() {
      state.killed = true;
      state.kills += 1;
    },
    async pause() {
      state.paused = true;
    },
  };
  return {
    commands,
    state,
    create: async (input: CreateSandboxInput) => {
      state.created = input;
      return handle;
    },
  };
}

const credentials = {
  e2bApiKey: "e2b_test",
  agentEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
};

describe("resolveSandboxCredentials", () => {
  it("accepts RAVI_-prefixed Claude credentials and maps them to the standard names", () => {
    const resolved = resolveSandboxCredentials({
      E2B_API_KEY: "e2b_x",
      RAVI_CLAUDE_CODE_OAUTH_TOKEN: "tok",
    });
    expect(resolved.agentEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(resolved.githubToken).toBeUndefined();
  });

  it("requires the E2B key and some Claude credential", () => {
    expect(() => resolveSandboxCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "tok" })).toThrow(SandboxConfigError);
    expect(() => resolveSandboxCredentials({ E2B_API_KEY: "e2b_x" })).toThrow(SandboxConfigError);
  });
});

describe("shellQuote", () => {
  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("runE2bSandboxTask", () => {
  it("runs the task to done, collects outputs and kills the sandbox", async () => {
    const fake = fakeSandbox();
    const outputDir = tempDir();
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      branch: "dev",
      instructions: "Fix it's typo",
      credentials,
      outputDir,
      createSandbox: fake.create,
      sleep: async () => {},
    });

    expect(result).toMatchObject({
      sandboxId: "sbx-test",
      taskId: "task-1",
      status: "done",
      kept: false,
      error: null,
    });
    expect(fake.state.killed).toBe(true);
    expect(fake.state.created?.envs).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    });
    expect(fake.state.cloned).toMatchObject({
      url: "https://github.com/o/r.git",
      branch: "dev",
    });
    expect(fake.commands.some((cmd) => cmd.includes(`--instructions 'Fix it'\\''s typo'`))).toBe(true);
    expect(fake.commands.some((cmd) => cmd.includes(".git/info/exclude"))).toBe(true);
    expect(result.files.sort()).toEqual(["TASK.md", "changes.patch", "daemon.log", "task.json"]);
    // Written byte for byte: trimming would drop the blank context line and the final newline.
    expect(readFileSync(join(outputDir, "changes.patch"), "utf8")).toBe(PATCH);
    // The patch is taken against the tree captured after Ravi scaffolded the worker's cwd.
    const baselineAt = fake.commands.findIndex((cmd) => cmd.includes("git write-tree"));
    const permissionsAt = fake.commands.findIndex((cmd) => cmd.startsWith("ravi agents permissions worker"));
    const tasksAt = fake.commands.findIndex((cmd) => cmd.startsWith("ravi tasks create"));
    expect(baselineAt).toBeGreaterThan(permissionsAt);
    expect(baselineAt).toBeLessThan(tasksAt);
    expect(fake.commands.some((cmd) => cmd.includes("git diff --binary tree-base"))).toBe(true);
    expect(fake.state.cloned).toMatchObject({ timeoutMs: 600_000 });
  });

  it("sends GITHUB_TOKEN only when cloning from github.com over https", async () => {
    const fake = fakeSandbox();
    await runE2bSandboxTask({
      repo: "https://gitlab.example.com/o/r.git",
      instructions: "x",
      credentials: { ...credentials, githubToken: "ghp_secret" },
      outputDir: tempDir(),
      createSandbox: fake.create,
      sleep: async () => {},
    });
    expect(fake.state.cloned).not.toHaveProperty("password");

    expect(githubCloneAuth("https://github.com/o/r.git", "t")).toEqual({ username: "x-access-token", password: "t" });
    expect(githubCloneAuth("http://github.com/o/r.git", "t")).toBeNull();
    expect(githubCloneAuth("https://github.com.evil.dev/o/r.git", "t")).toBeNull();
    expect(githubCloneAuth("git@github.com:o/r.git", "t")).toBeNull();
    expect(githubCloneAuth("https://github.com/o/r.git")).toBeNull();
  });

  it("reports which command failed with its stderr", async () => {
    const fake = fakeSandbox({
      failOn: /ravi agents create worker/,
      failWith: Object.assign(new Error("exit status 1"), {
        exitCode: 2,
        stderr: "noise\nprovider claude is not configured\n",
      }),
    });
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir: tempDir(),
      createSandbox: fake.create,
      sleep: async () => {},
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("ravi agents create worker");
    expect(result.error).toContain("exited with code 2");
    expect(result.error).toContain("provider claude is not configured");
    expect(describeCommandError("x", new Error("plain")).message).toBe("plain");
  });

  it("kills the sandbox on Ctrl-C and removes its signal handlers afterwards", async () => {
    const fake = fakeSandbox({ statuses: ["in_progress", "done"] });
    const before = process.listeners("SIGINT");
    const termBefore = process.listeners("SIGTERM");
    const exits: number[] = [];
    await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir: tempDir(),
      createSandbox: fake.create,
      exit: (code) => {
        exits.push(code);
      },
      sleep: async () => {
        const handler = process.listeners("SIGINT").find((listener) => !before.includes(listener));
        (handler as (signal: NodeJS.Signals) => void)("SIGINT");
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    // Once from the signal handler, once from the normal cleanup (exit is stubbed here).
    expect(fake.state.kills).toBe(2);
    expect(exits).toEqual([130]);
    expect(process.listeners("SIGINT")).toEqual(before);
    expect(process.listeners("SIGTERM")).toEqual(termBefore);
  });

  it("reports the error, still collects logs and pauses when keep is set", async () => {
    const fake = fakeSandbox({ failOn: /ravi agents create worker/ });
    const outputDir = tempDir();
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir,
      keep: true,
      createSandbox: fake.create,
      sleep: async () => {},
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("boom");
    expect(result.taskId).toBeNull();
    expect(fake.state.paused).toBe(true);
    expect(fake.state.killed).toBe(false);
    expect(existsSync(join(outputDir, "daemon.log"))).toBe(true);
    expect(result.files).not.toContain("TASK.md");
  });

  it("times out when the task never reaches a terminal status", async () => {
    const fake = fakeSandbox({ statuses: ["in_progress"] });
    let clock = 0;
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir: tempDir(),
      timeoutMin: 1,
      createSandbox: fake.create,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(result.status).toBe("timeout");
    expect(fake.state.killed).toBe(true);
  });

  it("records a kill failure in the result instead of rejecting", async () => {
    const fake = fakeSandbox();
    const create = async (input: CreateSandboxInput) => {
      const handle = await fake.create(input);
      handle.kill = async () => {
        throw new Error("api down");
      };
      return handle;
    };
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir: tempDir(),
      createSandbox: create,
      sleep: async () => {},
    });

    expect(result.status).toBe("done");
    expect(result.taskId).toBe("task-1");
    expect(result.error).toContain("Failed to kill sandbox: api down");
  });

  it("kills the sandbox when the output directory cannot be created", async () => {
    const fake = fakeSandbox();
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    await expect(
      runE2bSandboxTask({
        repo: "https://github.com/o/r.git",
        instructions: "x",
        credentials,
        outputDir: join(blocker, "sub"),
        createSandbox: fake.create,
        sleep: async () => {},
      }),
    ).rejects.toThrow();
    expect(fake.state.killed).toBe(true);
  });
});
