// `ravi gateway tunnel-run` (PM2 `ravi-gateway`): runs cloudflared for this
// installation's locally managed tunnel and is its drift poller. Normative:
// Console `sandbox-gateway/listener` SPEC §Host And cloudflared, §Drift Check
// (Fail Closed, Latching); OSS `.ravi/specs/sandbox/tunnel-runner`.
//
// Order on start: refuse when latched, unconfigured, without credentials or
// without cloudflared; stop a cloudflared a dead predecessor left behind;
// write the ingress template; wait until the daemon's listener is armed;
// close the listener's tunnel gate; start cloudflared with the credentials
// ONLY in its environment; poll `/config` immediately and then every 5 s.
//
// On drift the latch is written first (the listener refuses within 1 s), then
// cloudflared is stopped and the runner exits 78, which PM2 is told not to
// restart (`--stop-exit-codes 78`); a restarted runner refuses while latched.
// SIGTERM/SIGINT are forwarded and the runner exits with cloudflared's code.

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { writeUserOnlyFile } from "../cloud-auth/secret-backends.js";
import { dbGetSetting } from "../router/router-db.js";
import {
  dbClearTunnelPoll,
  dbClearTunnelRunner,
  dbGetListenerArmed,
  dbGetTunnelDriftLatch,
  dbGetTunnelRunner,
  dbLatchTunnelDrift,
  dbRecordTunnelPoll,
  dbSetTunnelRunner,
  TUNNEL_POLL_MAX_AGE_MS,
} from "../sandbox/tunnel-state.js";
import {
  type ReadSandboxListenerConfigResult,
  readSandboxListenerConfig,
  type SandboxListenerConfig,
} from "../sandbox-listener/config.js";
import { logger } from "../utils/logger.js";
import { type LocatedCloudflared, locateCloudflared } from "./cloudflared.js";
import {
  accessTeamName,
  buildCloudflaredArgs,
  checkRemoteConfig,
  type DriftReason,
  LOOPBACK,
  renderCloudflaredConfig,
  type TunnelIngressTemplate,
} from "./ingress.js";
import {
  gatewayStateDir,
  type ReadTunnelCredentialsResult,
  readTunnelCredentials,
  serializeTunnelCredentials,
} from "./secret.js";

/** Exit code for "do not restart me" (EX_CONFIG); PM2 is registered with `--stop-exit-codes 78`. */
export const TUNNEL_RUNNER_EXIT_REFUSED = 78;
/** The gateway settings changed under a running tunnel: exit so PM2 restarts the runner with a fresh template (EX_TEMPFAIL). */
export const TUNNEL_RUNNER_EXIT_RESTART = 75;
export const TUNNEL_METRICS_PORT_SETTING = "gateway.tunnel.metricsPort";
/** cloudflared's own default metrics port. */
export const TUNNEL_DEFAULT_METRICS_PORT = 20241;
export const TUNNEL_POLL_INTERVAL_MS = 5_000;
export const TUNNEL_POLL_TIMEOUT_MS = 2_000;
/** Before the first success, an unreachable metrics server is retried for this long (cloudflared starting up). */
export const TUNNEL_STARTUP_GRACE_MS = 10_000;
export const TUNNEL_CHILD_STOP_TIMEOUT_MS = 5_000;
export const TUNNEL_CONFIG_FILE = "cloudflared.yml";
/** The only variable that carries the secret, and only in cloudflared's environment. */
export const TUNNEL_CREDENTIALS_ENV = "TUNNEL_CRED_CONTENTS";
const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"];

export interface TunnelChild {
  readonly pid?: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type TunnelSpawn = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; stdio: ["ignore", "pipe", "pipe"] },
) => TunnelChild;

export interface TunnelStateStore {
  getLatch: typeof dbGetTunnelDriftLatch;
  latch: typeof dbLatchTunnelDrift;
  recordPoll: typeof dbRecordTunnelPoll;
  clearPoll: typeof dbClearTunnelPoll;
  getRunner: typeof dbGetTunnelRunner;
  setRunner: typeof dbSetTunnelRunner;
  clearRunner: typeof dbClearTunnelRunner;
  getListenerArmed: typeof dbGetListenerArmed;
}

export interface TunnelRunnerDeps {
  spawn: TunnelSpawn;
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readListenerConfig?: () => ReadSandboxListenerConfigResult;
  readSetting?: (key: string) => string | null;
  readCredentials?: () => ReadTunnelCredentialsResult;
  locate?: () => LocatedCloudflared;
  /** PIDs listening on 127.0.0.1:<port>; `null` when ownership cannot be determined (fail closed). */
  socketOwners?: (port: number) => Promise<number[] | null>;
  isAlive?: (pid: number) => boolean;
  /** Command name of a pid, to stop a stale cloudflared and never an unrelated reused pid. */
  processName?: (pid: number) => Promise<string | null>;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  gatewayDir?: string;
  /** Source of the child's non-secret variables (allowlisted). Never mutated. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Registers the SIGTERM/SIGINT handler; returns its remover. */
  onSignal?: (handler: (signal: NodeJS.Signals) => void) => () => void;
  state?: TunnelStateStore;
  output?: { stdout: (text: string) => void; stderr: (text: string) => void };
  pollIntervalMs?: number;
  startupGraceMs?: number;
  armedWaitMs?: number;
}

export type TunnelRunOutcome =
  | { outcome: "refused"; exitCode: typeof TUNNEL_RUNNER_EXIT_REFUSED; reason: string }
  | { outcome: "drift"; exitCode: typeof TUNNEL_RUNNER_EXIT_REFUSED; reason: DriftReason; detail: string }
  | { outcome: "config_changed"; exitCode: typeof TUNNEL_RUNNER_EXIT_RESTART; reason: string }
  | { outcome: "child_exit"; exitCode: number; signal: NodeJS.Signals | null }
  | { outcome: "signal"; exitCode: number; signal: NodeJS.Signals };

const log = logger.child("gateway-tunnel");

export const defaultTunnelState: TunnelStateStore = {
  getLatch: dbGetTunnelDriftLatch,
  latch: dbLatchTunnelDrift,
  recordPoll: dbRecordTunnelPoll,
  clearPoll: dbClearTunnelPoll,
  getRunner: dbGetTunnelRunner,
  setRunner: dbSetTunnelRunner,
  clearRunner: dbClearTunnelRunner,
  getListenerArmed: dbGetListenerArmed,
};

export function buildTunnelChildEnv(baseEnv: NodeJS.ProcessEnv, credentialsJson: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = baseEnv[key];
    if (typeof value === "string" && value) env[key] = value;
  }
  env[TUNNEL_CREDENTIALS_ENV] = credentialsJson;
  return env;
}

export function readTunnelMetricsPort(read: (key: string) => string | null, listenerPort: number): number | null {
  const raw = read(TUNNEL_METRICS_PORT_SETTING)?.trim();
  const port = raw ? (/^[0-9]{1,5}$/.test(raw) ? Number(raw) : Number.NaN) : TUNNEL_DEFAULT_METRICS_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === listenerPort) return null;
  return port;
}

export async function runTunnel(deps: TunnelRunnerDeps): Promise<TunnelRunOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = deps.state ?? defaultTunnelState;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const output = deps.output ?? {
    stdout: (text: string) => process.stdout.write(text),
    stderr: (text: string) => process.stderr.write(text),
  };
  const refused = (reason: string): TunnelRunOutcome => {
    log.error("Tunnel runner refused to start cloudflared", { reason });
    return { outcome: "refused", exitCode: TUNNEL_RUNNER_EXIT_REFUSED, reason };
  };

  const latch = state.getLatch();
  if (latch) return refused(`drift_latched:${latch.reason}`);
  const readListener = deps.readListenerConfig ?? (() => readSandboxListenerConfig());
  const listener = readListener();
  if (!listener.enabled) return refused(`gateway_${listener.reason}`);
  const config = listener.config;
  const metricsPort = readTunnelMetricsPort(deps.readSetting ?? dbGetSetting, config.port);
  if (metricsPort === null) return refused("metrics_port_invalid");
  const credentials = (deps.readCredentials ?? (() => readTunnelCredentials()))();
  if (!credentials.found) return refused(`credentials_${credentials.reason}`);
  const binary = (deps.locate ?? (() => locateCloudflared()))();
  if (!binary.found) return refused(`cloudflared_${binary.reason}`);
  if (!binary.verified) log.warn("Running an unverified cloudflared (explicit path)", { path: binary.path });

  await stopStaleCloudflared(state, isAlive, deps);

  const template: TunnelIngressTemplate = {
    tunnelId: credentials.credentials.TunnelID,
    hostname: config.tunnelHostname,
    servicePort: config.port,
    teamName: accessTeamName(config.accessTeamDomain),
    accessAud: config.accessAud,
  };
  const gatewayDir = deps.gatewayDir ?? gatewayStateDir();
  mkdirSync(gatewayDir, { recursive: true, mode: 0o700 });
  const configPath = join(gatewayDir, TUNNEL_CONFIG_FILE);
  writeUserOnlyFile(configPath, renderCloudflaredConfig(template));

  // Signals before anything long-running, so a stop during the armed wait is honoured.
  let stopSignal: NodeJS.Signals | null = null;
  let child: TunnelChild | null = null;
  let wake: () => void = () => {};
  const removeSignal = (deps.onSignal ?? defaultOnSignal)((signal) => {
    if (stopSignal) return;
    stopSignal = signal;
    log.info("Stopping cloudflared", { signal });
    child?.kill(signal);
    wake();
  });

  try {
    // Order (Console SPEC): the listener checks are armed before cloudflared starts.
    let waitingLogged = false;
    for (;;) {
      if (stopSignal) return { outcome: "signal", exitCode: 0, signal: stopSignal };
      const armed = state.getListenerArmed();
      if (armed && armed.port === config.port && isAlive(armed.pid)) break;
      if (!waitingLogged) {
        log.info("Waiting for the daemon's sandbox listener before starting cloudflared", { port: config.port });
        waitingLogged = true;
      }
      await interruptibleSleep(sleep, deps.armedWaitMs ?? 1_000, (resolve) => {
        wake = resolve;
      });
    }

    state.clearPoll();
    const secret = credentials.credentials.TunnelSecret;
    const args = buildCloudflaredArgs({ configPath, metricsPort, tunnelId: template.tunnelId });
    const spawned = deps.spawn(binary.path, args, {
      env: buildTunnelChildEnv(deps.baseEnv ?? process.env, serializeTunnelCredentials(credentials.credentials)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;
    const startedAt = now();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      spawned.once("exit", (code, signal) => resolve({ code, signal }));
      spawned.once("error", (error) => {
        log.error("cloudflared failed to start", { error: error.message });
        resolve({ code: 1, signal: null });
      });
    });
    let childDone = false;
    void exited.then(() => {
      childDone = true;
      wake();
    });
    forward(spawned.stdout, output.stdout, secret);
    forward(spawned.stderr, output.stderr, secret);
    state.setRunner({ pid: process.pid, cloudflaredPid: spawned.pid ?? null, startedAt }, startedAt);
    log.info("cloudflared started", {
      pid: spawned.pid,
      version: binary.version,
      verified: binary.verified,
      metrics: `${LOOPBACK}:${metricsPort}`,
      hostname: template.hostname,
    });
    if (stopSignal) spawned.kill(stopSignal);

    const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    const socketOwners = deps.socketOwners ?? defaultSocketOwners;
    let lastSuccess: number | null = null;
    let drift: { reason: DriftReason; detail: string } | null = null;
    let configChanged: string | null = null;
    try {
      while (!childDone && !stopSignal) {
        const at = now();
        if (lastSuccess !== null && at - lastSuccess > TUNNEL_POLL_MAX_AGE_MS) {
          drift = { reason: "poll_stale", detail: `last success ${at - lastSuccess} ms ago` };
          break;
        }
        const result = await pollOnce({ fetchImpl, socketOwners, metricsPort, childPid: spawned.pid, template });
        if (childDone || stopSignal) break;
        if (result.ok) {
          lastSuccess = now();
          state.recordPoll(lastSuccess);
          configChanged = templateSettingsChanged(readListener, config);
          if (configChanged) break;
        } else if (
          !(
            result.transient &&
            lastSuccess === null &&
            now() - startedAt < (deps.startupGraceMs ?? TUNNEL_STARTUP_GRACE_MS)
          )
        ) {
          drift = { reason: result.reason, detail: result.detail };
          break;
        }
        const wait = lastSuccess === null ? 500 : (deps.pollIntervalMs ?? TUNNEL_POLL_INTERVAL_MS);
        await interruptibleSleep(sleep, wait, (resolve) => {
          wake = resolve;
        });
      }
    } catch (error) {
      drift = { reason: "poll_failed", detail: error instanceof Error ? error.message : String(error) };
    }

    if (drift) {
      // Latch first: the listener refuses from its next gate read (≤ 1 s).
      try {
        state.latch(`${drift.reason}`, now());
      } catch (error) {
        log.error("Could not persist the drift latch; stopping cloudflared anyway", { error });
      }
      log.error("Tunnel drift: stopping cloudflared; the latch holds until a rotate", drift);
      await stopChild(spawned, () => childDone, exited, sleep);
      return { outcome: "drift", exitCode: TUNNEL_RUNNER_EXIT_REFUSED, ...drift };
    }

    if (configChanged) {
      log.info("Gateway settings changed; restarting the tunnel with a new template", { reason: configChanged });
      await stopChild(spawned, () => childDone, exited, sleep);
      return { outcome: "config_changed", exitCode: TUNNEL_RUNNER_EXIT_RESTART, reason: configChanged };
    }

    const result = await exited;
    if (stopSignal) {
      return { outcome: "signal", exitCode: exitCodeOf(result), signal: stopSignal };
    }
    log.warn("cloudflared exited", result);
    return { outcome: "child_exit", exitCode: exitCodeOf(result), signal: result.signal };
  } finally {
    removeSignal();
    if (child) {
      // Fail closed: the listener's gate stays shut until the next runner polls.
      safe(() => state.clearPoll());
      safe(() => state.clearRunner());
    }
  }
}

/**
 * The template was built from the settings at start; a change to any of them
 * (05b re-expose with a new port, unexpose) means cloudflared is routing by
 * stale values. A read error is not a change (the next poll re-reads).
 */
function templateSettingsChanged(
  read: () => ReadSandboxListenerConfigResult,
  started: SandboxListenerConfig,
): string | null {
  let current: ReadSandboxListenerConfigResult;
  try {
    current = read();
  } catch {
    return null;
  }
  if (!current.enabled) return `gateway_${current.reason}`;
  for (const key of ["port", "tunnelHostname", "accessAud", "accessTeamDomain"] as const) {
    if (current.config[key] !== started[key]) return `${key}_changed`;
  }
  return null;
}

type PollResult = { ok: true } | { ok: false; reason: DriftReason; detail: string; transient: boolean };

async function pollOnce(input: {
  fetchImpl: NonNullable<TunnelRunnerDeps["fetch"]>;
  socketOwners: NonNullable<TunnelRunnerDeps["socketOwners"]>;
  metricsPort: number;
  childPid: number | undefined;
  template: TunnelIngressTemplate;
}): Promise<PollResult> {
  const owners = await input.socketOwners(input.metricsPort);
  if (owners === null) {
    return { ok: false, reason: "metrics_socket_owner", detail: "socket owner unverifiable", transient: false };
  }
  if (owners.length === 0) {
    return { ok: false, reason: "poll_failed", detail: "metrics port not listening", transient: true };
  }
  if (input.childPid === undefined || owners.some((pid) => pid !== input.childPid)) {
    return { ok: false, reason: "metrics_socket_owner", detail: "metrics port owned by another pid", transient: false };
  }
  let response: Response;
  try {
    response = await input.fetchImpl(`http://${LOOPBACK}:${input.metricsPort}/config`, {
      signal: AbortSignal.timeout(TUNNEL_POLL_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "poll_failed",
      detail: error instanceof Error ? error.name : "fetch failed",
      transient: true,
    };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason: "poll_failed", detail: `HTTP ${response.status}`, transient: true };
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return { ok: false, reason: "config_unparseable", detail: "invalid JSON", transient: false };
  }
  const check = checkRemoteConfig(body, input.template);
  return check.ok ? { ok: true } : { ...check, transient: false };
}

async function stopStaleCloudflared(
  state: TunnelStateStore,
  isAlive: (pid: number) => boolean,
  deps: TunnelRunnerDeps,
): Promise<void> {
  const previous = state.getRunner();
  if (!previous?.cloudflaredPid || previous.pid === process.pid) return;
  const pid = previous.cloudflaredPid;
  if (isAlive(previous.pid) || !isAlive(pid)) return;
  const name = await (deps.processName ?? defaultProcessName)(pid);
  if (!name || !/cloudflared/.test(name)) return;
  log.warn("Stopping a cloudflared left behind by a dead tunnel runner", { pid });
  (deps.killPid ?? ((target, signal) => process.kill(target, signal)))(pid, "SIGTERM");
}

async function stopChild(
  child: TunnelChild,
  isDone: () => boolean,
  exited: Promise<unknown>,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (isDone()) return;
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(TUNNEL_CHILD_STOP_TIMEOUT_MS)]);
  if (!isDone()) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(TUNNEL_CHILD_STOP_TIMEOUT_MS)]);
  }
}

function interruptibleSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  setWake: (resolve: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    setWake(resolve);
    void sleep(ms).then(resolve);
  });
}

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

function exitCodeOf(result: { code: number | null; signal: NodeJS.Signals | null }): number {
  if (result.code !== null) return result.code;
  return result.signal ? 128 + (SIGNAL_NUMBERS[result.signal] ?? 0) : 1;
}

/** Child output goes to the runner's (PM2) log, with the secret masked should it ever appear. */
function forward(stream: Readable | null, write: (text: string) => void, secret: string): void {
  stream?.on("data", (chunk: Buffer | string) => {
    write(String(chunk).split(secret).join("[redacted]"));
  });
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    log.warn("Tunnel state cleanup failed", { error });
  }
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultOnSignal(handler: (signal: NodeJS.Signals) => void): () => void {
  const onTerm = () => handler("SIGTERM");
  const onInt = () => handler("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  return () => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  };
}

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3_000, encoding: "utf8" }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
      resolve({ code, stdout: stdout ?? "", missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" });
    });
  });
}

/** `lsof` (macOS, most Linux), then `ss` (iproute2); `null` when neither can answer. */
export async function defaultSocketOwners(port: number): Promise<number[] | null> {
  const lsof = await run("lsof", ["-nP", "-a", `-iTCP@${LOOPBACK}:${port}`, "-sTCP:LISTEN", "-Fp"]);
  if (!lsof.missing && (lsof.code === 0 || (lsof.code === 1 && lsof.stdout.trim() === ""))) {
    return [...new Set([...lsof.stdout.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1])))];
  }
  const ss = await run("ss", ["-Hltnp", "sport", "=", `:${port}`]);
  if (!ss.missing && ss.code === 0) {
    return [...new Set([...ss.stdout.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])))];
  }
  return null;
}

async function defaultProcessName(pid: number): Promise<string | null> {
  const ps = await run("ps", ["-o", "comm=", "-p", String(pid)]);
  return ps.code === 0 ? ps.stdout.trim() || null : null;
}
