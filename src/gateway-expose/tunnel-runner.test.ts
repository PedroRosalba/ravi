import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  dbGetTunnelRunner,
  dbLatchTunnelDrift,
  dbReadTunnelGateState,
  dbSetListenerArmed,
  dbSetTunnelRunner,
  evaluateTunnelGate,
} from "../sandbox/tunnel-state.js";
import type { SandboxListenerConfig } from "../sandbox-listener/config.js";
import { type SandboxListenerHandle, startSandboxListener } from "../sandbox-listener/server.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  TEST_ACCESS_AUD,
  TEST_ACCESS_CLIENT_ID,
  TEST_ACCESS_TEAM_DOMAIN,
  TEST_INSTALLATION_A,
} from "../test/sandbox-grant-tokens.js";
import { CLOUDFLARED_VERSION } from "./cloudflared.js";
import type { TunnelCredentials } from "./secret.js";
import {
  defaultTunnelState,
  runTunnel,
  TUNNEL_CREDENTIALS_ENV,
  TUNNEL_RUNNER_EXIT_REFUSED,
  type TunnelRunnerDeps,
  type TunnelRunOutcome,
} from "./tunnel-runner.js";

const CREDENTIALS: TunnelCredentials = {
  AccountTag: "0123456789abcdef0123456789abcdef",
  TunnelID: "6ff42ae2-765d-4adf-8112-31c55c1551ef",
  TunnelSecret: Buffer.alloc(32, 9).toString("base64"),
};
const CREDENTIALS_JSON = JSON.stringify(CREDENTIALS);
const HOSTNAME = `${TEST_INSTALLATION_A}.tun.ravi.bot`;
const CHILD_PID = 424242;
const BINARY = "/opt/ravi/bin/cloudflared-test";

const listenerConfig = (port: number): SandboxListenerConfig => ({
  port,
  accessTeamDomain: TEST_ACCESS_TEAM_DOMAIN,
  accessAud: TEST_ACCESS_AUD,
  accessClientId: TEST_ACCESS_CLIENT_ID,
  installationId: TEST_INSTALLATION_A,
  consoleIssuer: "https://console.ravi.bot",
  tunnelHostname: HOSTNAME,
});

function configBody(port: number, patch: (body: any) => void = () => {}) {
  const body: any = {
    version: -1,
    config: {
      ingress: [
        {
          hostname: HOSTNAME,
          service: `http://127.0.0.1:${port}`,
          originRequest: {
            access: { required: true, teamName: TEST_ACCESS_TEAM_DOMAIN.split(".")[0], audTag: [TEST_ACCESS_AUD] },
          },
        },
        { service: "http_status:404" },
      ],
      "warp-routing": { enabled: false },
    },
  };
  patch(body);
  return body;
}

class FakeChild extends EventEmitter {
  readonly pid = CHILD_PID;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: string[] = [];
  /** `exit`: what cloudflared reports when signalled; `ignore`: signals it does not exit on. */
  constructor(
    private readonly exit: { code: number | null; signal: NodeJS.Signals | null } = { code: 0, signal: null },
    private readonly ignore: NodeJS.Signals[] = [],
  ) {
    super();
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.kills.push(signal);
    if (!this.ignore.includes(signal)) queueMicrotask(() => this.emit("exit", this.exit.code, this.exit.signal));
    return true;
  }
}

type FetchStep = Response | Error | (() => Promise<Response>);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

interface Harness {
  deps: TunnelRunnerDeps;
  spawned: Array<{ command: string; args: string[]; env: Record<string, string>; child: FakeChild }>;
  fetchCalls: string[];
  output: string[];
  signal: (signal: NodeJS.Signals) => void;
  clock: { now: number };
}

function harness(options: {
  port?: number;
  fetchSteps?: FetchStep[];
  child?: () => FakeChild;
  overrides?: Partial<TunnelRunnerDeps>;
}): Harness {
  const port = options.port ?? 7790;
  const clock = { now: 1_800_000_000_000 };
  const steps = [...(options.fetchSteps ?? [json(configBody(port))])];
  const spawned: Harness["spawned"] = [];
  const fetchCalls: string[] = [];
  const output: string[] = [];
  let signalHandler: (signal: NodeJS.Signals) => void = () => {};
  const deps: TunnelRunnerDeps = {
    spawn: (command, args, opts) => {
      const child = options.child?.() ?? new FakeChild();
      spawned.push({ command, args, env: opts.env, child });
      return child;
    },
    fetch: async (url): Promise<Response> => {
      fetchCalls.push(url);
      const step = steps.length > 1 ? steps.shift()! : steps[0]!;
      if (step instanceof Error) throw step;
      if (typeof step === "function") return step();
      return step.clone() as Response;
    },
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      return new Promise((resolve) => setImmediate(resolve));
    },
    readListenerConfig: () => ({ enabled: true, config: listenerConfig(port) }),
    readSetting: () => null,
    readCredentials: () => ({ found: true, credentials: CREDENTIALS, backend: "file" }),
    locate: () => ({ found: true, path: BINARY, verified: true, source: "pinned", version: CLOUDFLARED_VERSION }),
    socketOwners: async () => [CHILD_PID],
    isAlive: () => true,
    processName: async () => "cloudflared",
    killPid: () => {},
    gatewayDir,
    baseEnv: { PATH: "/usr/bin:/bin", HOME: "/home/test", RAVI_CONTEXT_KEY: "rctx-should-not-pass", TUNNEL_TOKEN: "x" },
    onSignal: (handler) => {
      signalHandler = handler;
      return () => {};
    },
    output: { stdout: (text) => output.push(text), stderr: (text) => output.push(text) },
    ...options.overrides,
  };
  return { deps, spawned, fetchCalls, output, signal: (signal) => signalHandler(signal), clock };
}

async function until(condition: () => boolean, label: string) {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let stateDir: string;
let gatewayDir: string;
let listener: SandboxListenerHandle | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-tunnel-runner-");
  gatewayDir = mkdtempSync(join(tmpdir(), "ravi-gateway-dir-"));
  dbSetListenerArmed({ pid: process.pid, port: 7790, at: Date.now() });
});

afterEach(async () => {
  await listener?.stop();
  listener = null;
  rmSync(gatewayDir, { recursive: true, force: true });
  await cleanupIsolatedRaviState(stateDir);
});

describe("tunnel-run: credentials", () => {
  test("credentials reach cloudflared only through its env: not argv, not process.env, not logs", async () => {
    const envBefore = JSON.stringify(process.env);
    const h = harness({
      child: () => new FakeChild(),
      fetchSteps: [
        json(configBody(7790)),
        () => {
          // cloudflared prints the secret (it never should): the forwarded log line is masked.
          h.spawned[0]!.child.stderr.write(`oops ${CREDENTIALS.TunnelSecret}\n`);
          return Promise.resolve(json(configBody(7790)));
        },
      ],
    });
    const written: string[] = [];
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      return stdoutWrite(chunk as never, ...(rest as []));
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      return stderrWrite(chunk as never, ...(rest as []));
    }) as typeof process.stderr.write;
    let result: TunnelRunOutcome;
    try {
      const run = runTunnel(h.deps);
      await until(() => h.fetchCalls.length >= 3, "polls");
      h.signal("SIGTERM");
      result = await run;
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }

    expect(result).toEqual({ outcome: "signal", exitCode: 0, signal: "SIGTERM" });
    const [{ command, args, env, child }] = h.spawned;
    expect(command).toBe(BINARY);
    expect(args.join(" ")).not.toContain(CREDENTIALS.TunnelSecret);
    expect(args.join(" ")).not.toContain(CREDENTIALS.AccountTag);
    expect(args).toContain("127.0.0.1:20241");
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/test", [TUNNEL_CREDENTIALS_ENV]: CREDENTIALS_JSON });
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(JSON.stringify(process.env)).toBe(envBefore);
    expect(process.env[TUNNEL_CREDENTIALS_ENV]).toBeUndefined();
    const logs = [...written, ...h.output].join("");
    expect(logs).not.toContain(CREDENTIALS.TunnelSecret);
    expect(h.output.join("")).toContain("oops [redacted]");

    // The ingress file on disk holds no credentials and is private.
    const configPath = join(gatewayDir, "cloudflared.yml");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, "utf8")).not.toContain(CREDENTIALS.TunnelSecret);
    expect(args).toContain(configPath);
  });

  test("refuses with exit 78 and never spawns without credentials, settings, cloudflared or with a latch", async () => {
    const cases: Array<[Partial<TunnelRunnerDeps>, string]> = [
      [{ readCredentials: () => ({ found: false, reason: "missing" }) }, "credentials_missing"],
      [{ readListenerConfig: () => ({ enabled: false, reason: "not_configured" }) }, "gateway_not_configured"],
      [{ locate: () => ({ found: false, reason: "not_installed", path: "/x" }) }, "cloudflared_not_installed"],
      [{ readSetting: () => "7790" }, "metrics_port_invalid"],
    ];
    for (const [overrides, reason] of cases) {
      const h = harness({ overrides });
      expect(await runTunnel(h.deps)).toEqual({ outcome: "refused", exitCode: TUNNEL_RUNNER_EXIT_REFUSED, reason });
      expect(h.spawned).toHaveLength(0);
    }
    dbLatchTunnelDrift("config_version");
    const latched = harness({});
    expect(await runTunnel(latched.deps)).toMatchObject({ outcome: "refused", reason: "drift_latched:config_version" });
    expect(latched.spawned).toHaveLength(0);
  });
});

describe("tunnel-run: drift poller and latch", () => {
  test("first-poll gate, drift ⇒ latch ⇒ listener 503 ⇒ cloudflared stopped, and the latch survives a restart", async () => {
    let gateNow = Date.now();
    listener = await startSandboxListener({
      port: 0,
      config: listenerConfig(0),
      deps: { jwksPersistDir: null, now: () => gateNow, fetch: async () => new Response("down", { status: 503 }) },
    });
    const port = listener.port;
    let releaseFirstPoll: (response: Response) => void = () => {};
    const h = harness({
      port,
      fetchSteps: [
        () => new Promise<Response>((resolve) => (releaseFirstPoll = resolve)),
        json(configBody(port, (body) => (body.version = 3))),
      ],
    });
    // The runner and the listener share one clock for the gate.
    h.deps.now = () => gateNow;
    let releaseSleep: () => void = () => {};
    h.deps.sleep = (ms) =>
      new Promise((resolve) => {
        releaseSleep = () => {
          gateNow += ms;
          resolve();
        };
      });

    const run = runTunnel(h.deps);
    await until(() => h.fetchCalls.length === 1, "first poll");
    // Before the first successful poll the listener serves nothing.
    expect(await gateCode(port)).toBe("tunnel_drift");

    releaseFirstPoll(json(configBody(port)));
    await until(() => dbReadTunnelGateState().lastPollAt !== null, "poll recorded");
    gateNow += 1_000;
    expect(await gateCode(port)).not.toBe("tunnel_drift");

    // Next poll: cloudflared reports a remote config version.
    releaseSleep();
    const result = await run;
    expect(result).toMatchObject({ outcome: "drift", exitCode: 78, reason: "config_version" });
    expect(h.spawned[0]!.child.kills).toEqual(["SIGTERM"]);
    expect(dbReadTunnelGateState().latch).toMatchObject({ reason: "config_version" });
    gateNow += 1_000;
    expect(await gateCode(port)).toBe("tunnel_drift");
    expect(dbGetTunnelRunner()).toBeNull();

    // PM2 (or a host restart) starts the runner again: it refuses while latched.
    const again = harness({ port });
    expect(await runTunnel(again.deps)).toMatchObject({ outcome: "refused", exitCode: 78 });
    expect(again.spawned).toHaveLength(0);
  });

  const driftCases: Array<[string, Partial<Parameters<typeof harness>[0]>, string]> = [
    [
      "remote version 0",
      { fetchSteps: [json(configBody(7790)), json(configBody(7790, (b) => (b.version = 0)))] },
      "config_version",
    ],
    [
      "ingress changed",
      {
        fetchSteps: [
          json(configBody(7790)),
          json(configBody(7790, (b) => (b.config.ingress[0].service = "http://127.0.0.1:4222"))),
        ],
      },
      "ingress_mismatch",
    ],
    [
      "warp-routing enabled",
      {
        fetchSteps: [json(configBody(7790)), json(configBody(7790, (b) => (b.config["warp-routing"].enabled = true)))],
      },
      "warp_routing",
    ],
    ["a poll error", { fetchSteps: [json(configBody(7790)), new Error("ECONNREFUSED")] }, "poll_failed"],
    [
      "a 2 s timeout",
      { fetchSteps: [json(configBody(7790)), new DOMException("The operation timed out.", "TimeoutError")] },
      "poll_failed",
    ],
    ["no successful poll for 10 s", { overrides: { pollIntervalMs: 10_001 } }, "poll_stale"],
    [
      "metrics socket owned by another pid",
      { overrides: { socketOwners: async () => [CHILD_PID, 999] } },
      "metrics_socket_owner",
    ],
    ["socket ownership unverifiable", { overrides: { socketOwners: async () => null } }, "metrics_socket_owner"],
  ];
  for (const [name, options, reason] of driftCases) {
    test(`${name} stops cloudflared and sets the latch (${reason})`, async () => {
      const h = harness(options);
      const result = await runTunnel(h.deps);
      expect(result).toMatchObject({ outcome: "drift", exitCode: 78, reason });
      expect(h.spawned[0]!.child.kills[0]).toBe("SIGTERM");
      const state = dbReadTunnelGateState();
      expect(state.latch).toMatchObject({ reason });
      expect(evaluateTunnelGate(state, Date.now())).toEqual({ open: false, reason: "drift_latched" });
    });
  }

  test("cloudflared that ignores SIGTERM is SIGKILLed", async () => {
    const h = harness({
      child: () => new FakeChild({ code: null, signal: "SIGKILL" }, ["SIGTERM"]),
      fetchSteps: [json(configBody(7790)), json(configBody(7790, (b) => (b.version = 1)))],
    });
    expect(await runTunnel(h.deps)).toMatchObject({ outcome: "drift" });
    expect(h.spawned[0]!.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("startup: an unreachable metrics server is retried within the grace window, then the gate opens", async () => {
    const h = harness({ fetchSteps: [new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), json(configBody(7790))] });
    const run = runTunnel(h.deps);
    await until(() => h.fetchCalls.length >= 4, "polls");
    expect(dbReadTunnelGateState().latch).toBeNull();
    expect(dbReadTunnelGateState().lastPollAt).not.toBeNull();
    h.signal("SIGINT");
    expect(await run).toMatchObject({ outcome: "signal", signal: "SIGINT" });
    // Stopping closes the gate again until the next runner polls.
    expect(dbReadTunnelGateState().lastPollAt).toBeNull();
    expect(dbReadTunnelGateState().latch).toBeNull();
  });

  test("startup: never reachable within the grace window is drift", async () => {
    const h = harness({ fetchSteps: [new Error("ECONNREFUSED")] });
    expect(await runTunnel(h.deps)).toMatchObject({ outcome: "drift", reason: "poll_failed" });
  });

  test("a crash inside the poller still stops cloudflared (the child is tied to the poller)", async () => {
    const h = harness({
      overrides: {
        state: {
          ...defaultTunnelState,
          recordPoll: () => {
            throw new Error("database is locked");
          },
        },
      },
    });
    expect(await runTunnel(h.deps)).toMatchObject({ outcome: "drift", reason: "poll_failed" });
    expect(h.spawned[0]!.child.kills).toEqual(["SIGTERM"]);
  });
});

describe("tunnel-run: lifecycle", () => {
  test("exits with cloudflared's own exit code and closes the gate", async () => {
    const h = harness({});
    const run = runTunnel(h.deps);
    await until(() => h.fetchCalls.length >= 2, "polls");
    h.spawned[0]!.child.emit("exit", 3, null);
    expect(await run).toEqual({ outcome: "child_exit", exitCode: 3, signal: null });
    expect(dbReadTunnelGateState().lastPollAt).toBeNull();
    expect(dbGetTunnelRunner()).toBeNull();
  });

  test("a gateway settings change stops cloudflared and exits 75 for a restart (no latch)", async () => {
    let port = 7790;
    const h = harness({
      overrides: { readListenerConfig: () => ({ enabled: true, config: listenerConfig(port) }) },
    });
    const run = runTunnel(h.deps);
    await until(() => h.fetchCalls.length >= 2, "polls");
    port = 7799;
    expect(await run).toEqual({ outcome: "config_changed", exitCode: 75, reason: "port_changed" });
    expect(h.spawned[0]!.child.kills).toEqual(["SIGTERM"]);
    expect(dbReadTunnelGateState()).toEqual({ latch: null, lastPollAt: null });
  });

  test("SIGTERM is forwarded and a signalled child maps to 128+n", async () => {
    const h = harness({ child: () => new FakeChild({ code: null, signal: "SIGTERM" }) });
    const run = runTunnel(h.deps);
    await until(() => h.fetchCalls.length >= 1, "poll");
    h.signal("SIGTERM");
    expect(await run).toEqual({ outcome: "signal", exitCode: 143, signal: "SIGTERM" });
    expect(h.spawned[0]!.child.kills).toEqual(["SIGTERM"]);
  });

  test("waits for the daemon's listener to be armed before starting cloudflared", async () => {
    dbSetListenerArmed({ pid: process.pid, port: 1, at: Date.now() });
    const h = harness({});
    const run = runTunnel(h.deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.spawned).toHaveLength(0);
    dbSetListenerArmed({ pid: process.pid, port: 7790, at: Date.now() });
    await until(() => h.spawned.length === 1, "spawn after armed");
    h.signal("SIGTERM");
    await run;
  });

  test("a signal during the armed wait exits without starting cloudflared", async () => {
    dbSetListenerArmed({ pid: process.pid, port: 1, at: Date.now() });
    const h = harness({});
    const run = runTunnel(h.deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.signal("SIGTERM");
    expect(await run).toEqual({ outcome: "signal", exitCode: 0, signal: "SIGTERM" });
    expect(h.spawned).toHaveLength(0);
  });

  test("stops a cloudflared its dead predecessor left behind, and never an unrelated pid", async () => {
    const killed: Array<[number, string]> = [];
    dbSetTunnelRunner({ pid: 1111, cloudflaredPid: 2222, startedAt: 1 });
    const h = harness({
      overrides: {
        isAlive: (pid) => pid !== 1111,
        killPid: (pid, signal) => killed.push([pid, signal]),
      },
    });
    const run = runTunnel(h.deps);
    await until(() => h.spawned.length === 1, "spawn");
    expect(killed).toEqual([[2222, "SIGTERM"]]);
    expect(dbGetTunnelRunner()).toMatchObject({ pid: process.pid, cloudflaredPid: CHILD_PID });
    h.signal("SIGTERM");
    await run;

    killed.length = 0;
    dbSetTunnelRunner({ pid: 1111, cloudflaredPid: 2222, startedAt: 1 });
    const reused = harness({
      overrides: {
        isAlive: (pid) => pid !== 1111,
        processName: async () => "postgres",
        killPid: (pid, signal) => killed.push([pid, signal]),
      },
    });
    const run2 = runTunnel(reused.deps);
    await until(() => reused.spawned.length === 1, "spawn");
    expect(killed).toEqual([]);
    reused.signal("SIGTERM");
    await run2;
  });
});

/** A Gate-shaped request without tokens: past Host and routing, it shows whether the tunnel gate is open. */
function gateCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/v1/tasks/report",
        headers: {
          host: HOSTNAME,
          "x-ravi-gate": "1",
          "x-ravi-request-id": crypto.randomUUID(),
          "content-type": "application/json",
          "content-length": "2",
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve((JSON.parse(text) as { error: { code: string } }).error.code));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}
