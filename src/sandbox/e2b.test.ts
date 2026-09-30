import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SandboxConfigError,
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
}

function fakeSandbox(options: FakeOptions = {}) {
  const commands: string[] = [];
  const statuses = [...(options.statuses ?? ["in_progress", "done"])];
  const state = {
    killed: false,
    paused: false,
    created: null as CreateSandboxInput | null,
    cloned: null as unknown,
  };
  const handle: SandboxHandle = {
    sandboxId: "sbx-test",
    commands: {
      async run(cmd) {
        commands.push(cmd);
        if (options.failOn?.test(cmd)) throw new Error(`boom: ${cmd}`);
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
        if (cmd.includes("git diff")) return { stdout: "diff --git a/x b/x" };
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
    expect(readFileSync(join(outputDir, "changes.patch"), "utf8")).toContain("diff --git");
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
});
