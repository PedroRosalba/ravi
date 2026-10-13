import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutRaviRuntimeContextEnv } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { validateSandboxRunFlags } from "./sandbox.js";

setDefaultTimeout(60_000);

const stateDir = mkdtempSync(join(tmpdir(), "ravi-sandbox-cli-"));

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function usageError(run: () => unknown): ContractError {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("expected a usage error");
}

describe("sandbox run flag validation", () => {
  it("accepts whole minutes from 1 to 55 and nothing else", () => {
    expect(validateSandboxRunFlags({}).timeoutMin).toBe(55);
    expect(validateSandboxRunFlags({ timeoutMin: "1" }).timeoutMin).toBe(1);
    expect(validateSandboxRunFlags({ timeoutMin: " 55 " }).timeoutMin).toBe(55);
    for (const timeoutMin of ["0", "56", "1.5", "abc", "-5", "1e1"]) {
      const error = usageError(() => validateSandboxRunFlags({ timeoutMin }, true));
      expect(error.exitCode).toBe(2);
      expect(error.code).toBe("USAGE_ERROR");
      expect(error.message).toContain("--timeout-min");
    }
  });

  it("rejects unknown --model-auth and --egress values with the accepted list", () => {
    const auth = usageError(() => validateSandboxRunFlags({ modelAuth: "bogus" }, true));
    expect(auth.exitCode).toBe(2);
    expect(auth.details.acceptedValues).toEqual(["broker", "header", "env"]);
    const egress = usageError(() => validateSandboxRunFlags({ egress: "bogus" }, true));
    expect(egress.exitCode).toBe(2);
    expect(egress.details.acceptedValues).toEqual(["dev-registries", "strict"]);
    expect(validateSandboxRunFlags({ modelAuth: "header", egress: "strict" })).toMatchObject({
      modelAuth: "header",
      egress: "strict",
    });
    // No flag: the mode is decided from the environment later, the preset is the default.
    expect(validateSandboxRunFlags({})).toMatchObject({ modelAuth: undefined, egress: "dev-registries" });
  });

  it("gates env model auth behind --allow-key-in-env and refuses --keep with it", () => {
    expect(usageError(() => validateSandboxRunFlags({ modelAuth: "env" }, true)).message).toContain(
      "--allow-key-in-env",
    );
    expect(validateSandboxRunFlags({ modelAuth: "env", allowKeyInEnv: true }).modelAuth).toBe("env");
    const keep = usageError(() => validateSandboxRunFlags({ modelAuth: "env", allowKeyInEnv: true, keep: true }, true));
    expect(keep.exitCode).toBe(2);
    expect(keep.message).toContain("--keep");
    expect(validateSandboxRunFlags({ modelAuth: "header", keep: true }).modelAuth).toBe("header");
  });

  it("normalizes --allow-host entries and rejects anything that is not a host name", () => {
    expect(
      validateSandboxRunFlags({ allowHost: ["Internal.Example.com, *.corp.example", "pypi.org"] }).allowHosts,
    ).toEqual(["internal.example.com", "*.corp.example", "pypi.org"]);
    for (const bad of ["http://x.example.com", "x.example.com/path", "x.example.com:443", "localhost", "*"]) {
      expect(usageError(() => validateSandboxRunFlags({ allowHost: [bad] }, true)).exitCode).toBe(2);
    }
  });
});

/**
 * Process-level proof: the usage errors happen before any credential is read or
 * any E2B call is made, so the spawned CLI gets no credential at all.
 */
describe("sandbox run usage exit codes", () => {
  function runCli(args: string[]) {
    const env = withoutRaviRuntimeContextEnv();
    for (const name of [
      "E2B_API_KEY",
      "ANTHROPIC_API_KEY",
      "RAVI_ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "RAVI_CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
      "RAVI_SANDBOX_ANTHROPIC_BASE_URL",
    ]) {
      delete env[name];
    }
    const result = spawnSync(
      "bun",
      ["src/cli/index.ts", "sandbox", "run", "--repo", "https://github.com/o/r.git", "--task", "x", ...args],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...env, RAVI_STATE_DIR: stateDir, RAVI_SUPPRESS_AUDIT_EVENTS: "1" },
      },
    );
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  it("exits 2 with a USAGE_ERROR envelope for --timeout-min 0, --model-auth bogus and --egress bogus", () => {
    for (const args of [
      ["--timeout-min", "0"],
      ["--timeout-min", "56"],
      ["--timeout-min", "1.5"],
      ["--timeout-min", "abc"],
      ["--model-auth", "bogus"],
      ["--egress", "bogus"],
    ]) {
      const result = runCli([...args, "--json"]);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        success: false,
        op: "sandbox run",
        error: { code: "USAGE_ERROR" },
      });
    }
  });
});
