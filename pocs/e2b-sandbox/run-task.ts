/**
 * Runs one Ravi task in a fresh E2B sandbox created from the ravi-runner template.
 *
 *   E2B_API_KEY=... CLAUDE_CODE_OAUTH_TOKEN=... \
 *     bun run-task.ts --repo https://github.com/owner/repo.git --task "Fix the typo in README"
 *
 * Flow: create sandbox (NATS already up from the snapshot) -> clone the repo ->
 * start the Ravi daemon with this task's credentials -> create a Claude-backed
 * agent whose cwd is the clone -> create and dispatch the task -> poll until it
 * is done/failed/blocked -> save TASK.md, the git patch and the daemon log to
 * ./out/<sandbox-id>/ -> kill the sandbox (or pause it with --keep).
 *
 * GITHUB_TOKEN is only used to clone private repos; it is not stored in the clone.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Sandbox } from "e2b";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    branch: { type: "string" },
    task: { type: "string" },
    title: { type: "string", default: "Sandbox task" },
    template: { type: "string", default: "ravi-runner" },
    model: { type: "string", default: "sonnet" },
    "timeout-min": { type: "string", default: "55" },
    keep: { type: "boolean", default: false },
  },
});

if (!values.repo || !values.task) {
  console.error('Usage: bun run-task.ts --repo <git url> --task "<instructions>" [--branch b] [--model m] [--keep]');
  process.exit(2);
}

const authEnv: Record<string, string> = {};
for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
  const value = process.env[key];
  if (value) authEnv[key] = value;
}
if (Object.keys(authEnv).length === 0) {
  console.error("Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY for the agent.");
  process.exit(2);
}

const REPO_DIR = "/home/user/work/repo";
const timeoutMs = Number(values["timeout-min"]) * 60_000;
const startedAt = Date.now();
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
const step = (message: string) => console.log(`[${elapsed()}] ${message}`);

step(`Creating sandbox from ${values.template}`);
const sandbox = await Sandbox.create(values.template, {
  // Sandbox lifetime; the task poll below stops a little earlier.
  timeoutMs: timeoutMs + 5 * 60_000,
  envs: { ...authEnv, RAVI_ALLOW_STALE_BUNDLE: "1" },
  metadata: { purpose: "ravi-task", title: values.title },
});
step(`Sandbox ${sandbox.sandboxId} is up`);

const sh = async (cmd: string, timeoutMs = 120_000) => {
  const result = await sandbox.commands.run(cmd, { timeoutMs });
  return result.stdout.trim();
};

const outDir = join("out", sandbox.sandboxId);
mkdirSync(outDir, { recursive: true });

let finalStatus = "unknown";
try {
  await sh("timeout 5 bash -c '</dev/tcp/127.0.0.1/4222' || (echo 'nats-server is not listening' >&2; exit 1)", 10_000);
  step("NATS already listening (restored from snapshot)");

  const githubToken = process.env.GITHUB_TOKEN;
  step(`Cloning ${values.repo}`);
  await sandbox.git.clone(values.repo, {
    path: REPO_DIR,
    branch: values.branch,
    depth: 50,
    ...(githubToken ? { username: "x-access-token", password: githubToken } : {}),
  });

  step("Starting Ravi daemon");
  await sandbox.commands.run("ravi daemon run </dev/null > /home/user/.ravi/daemon.log 2>&1", {
    background: true,
    timeoutMs: 0,
  });
  await sh(
    "for i in $(seq 1 60); do grep -q 'Daemon ready' /home/user/.ravi/daemon.log && exit 0; sleep 1; done; " +
      "tail -20 /home/user/.ravi/daemon.log >&2; exit 1",
    90_000,
  );
  step("Daemon ready");

  // The default provider is codex; tasks here run on Claude.
  await sh(`ravi agents create worker ${REPO_DIR} --provider claude --model ${values.model}`);
  await sh("ravi agents permissions worker full-access --execute");
  // `tasks create` outside a Ravi session needs an existing session to report to.
  // A cheap operator agent receives those reports.
  await sh("ravi agents create operator /home/user/work --provider claude --model haiku");
  await sh('ravi sessions send -a operator operator "Operator inbox for sandbox task reports. Reply OK."');

  step("Creating and dispatching the task");
  const created = JSON.parse(
    await sh(
      `ravi tasks create ${shellQuote(values.title)} --instructions ${shellQuote(values.task)} ` +
        "--agent worker --report-to operator --json",
    ),
  );
  const taskId: string = created.task.id;
  step(`Task ${taskId} dispatched`);

  const deadline = startedAt + timeoutMs;
  let lastLine = "";
  while (Date.now() < deadline) {
    const shown = JSON.parse(await sh(`ravi tasks show ${taskId} --json`));
    const task = shown.task ?? shown;
    const line = `status=${task.status} progress=${task.progress ?? 0}`;
    if (line !== lastLine) {
      step(line);
      lastLine = line;
    }
    if (["done", "failed", "blocked"].includes(task.status)) {
      finalStatus = task.status;
      break;
    }
    await Bun.sleep(10_000);
  }
  if (finalStatus === "unknown") step("Timed out waiting for the task");

  await collectOutputs(taskId);
} catch (error) {
  console.error(error);
  await collectOutputs().catch(() => {});
} finally {
  if (values.keep) {
    await sandbox.pause();
    step(`Sandbox paused; resume with Sandbox.connect("${sandbox.sandboxId}")`);
  } else {
    await sandbox.kill();
    step("Sandbox killed");
  }
  step(`Finished with status=${finalStatus}; outputs in ${outDir}`);
}

async function collectOutputs(taskId?: string) {
  const grab = async (name: string, cmd: string) => {
    const content = await sh(cmd).catch((error) => `(failed: ${error})`);
    writeFileSync(join(outDir, name), `${content}\n`);
  };
  await grab("daemon.log", "tail -500 /home/user/.ravi/daemon.log");
  await grab("changes.patch", `cd ${REPO_DIR} && git add -A && git diff --cached HEAD`);
  if (taskId) {
    await grab("task.json", `ravi tasks show ${taskId} --json`);
    await grab("TASK.md", `cat /home/user/.ravi/tasks/${taskId}/TASK.md`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
