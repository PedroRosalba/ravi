/**
 * `ravi instances` transport tests: `connect --transport native|omni` and the live
 * status surfaces (list/show/status/disconnect) through the routing client.
 *
 * Uses an isolated Ravi state (real router DB) and a fake NATS RPC connection for
 * the native WhatsApp runner, plus a fake pairing-event bus standing in for the
 * daemon's `ravi.whatsapp.qr.<uuid>` / `ravi.whatsapp.connected.<uuid>` relay.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  WhatsAppRpcRequestSchema,
  type WhatsAppRpcMethod,
  type WhatsAppRpcRequest,
} from "../../channels/whatsapp/contract.js";
import type { WhatsAppRpcConnection } from "../../channels/whatsapp/rpc-client.js";
import { createChannelTransportClient } from "../../channels/whatsapp/transport-client.js";
import { createOmniClient } from "../../omni/client.js";
import { loadRouterConfig } from "../../router/config.js";
import {
  dbGetChannel,
  dbGetInstance,
  dbSetSetting,
  dbUpsertChannel,
  dbUpsertInstance,
} from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

// Manual v2 contract: hasContext() true makes the contract helpers throw
// ContractError instead of process.exit, which is what tests need.
const actualContext = await import("../context.js");
mock.module("../context.js", () => ({
  ...actualContext,
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { InstancesCommands, resolveInstanceConnectTransport, setInstancesTransportDependenciesForTests } = await import(
  "./instances.js"
);
const { ContractError } = await import("../agent-contract.js");

afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type RpcHandler = (request: WhatsAppRpcRequest) => unknown;
type PairingEvent = { topic: string; data: Record<string, unknown> };

const NO_RESPONDERS = () => Object.assign(new Error("503"), { code: "503" });

function fakeRunner(handlers: Partial<Record<WhatsAppRpcMethod, RpcHandler>>) {
  const calls: Array<{ subject: string; request: WhatsAppRpcRequest }> = [];
  let unavailableFor = 0;
  const connection: WhatsAppRpcConnection = {
    async request(subject, data) {
      const request = WhatsAppRpcRequestSchema.parse(JSON.parse(new TextDecoder().decode(data)));
      calls.push({ subject, request });
      if (unavailableFor > 0) {
        unavailableFor -= 1;
        throw NO_RESPONDERS();
      }
      const handler = handlers[request.method];
      const response = handler
        ? { ok: true, requestId: request.requestId, data: handler(request) }
        : {
            ok: false,
            requestId: request.requestId,
            error: { status: 400, code: "INVALID_REQUEST", message: `no handler for ${request.method}` },
          };
      return { data: new TextEncoder().encode(JSON.stringify(response)) };
    },
  };
  return {
    connection,
    calls,
    methods: () => calls.map((call) => call.request.method),
    /** The next `n` requests get "no responders" (runner not up / channel not hot-added yet). */
    failNext(n: number) {
      unavailableFor = n;
    },
  };
}

function fakeBus() {
  const queue: PairingEvent[] = [];
  const subscriptions: string[][] = [];
  let wake: (() => void) | null = null;
  return {
    subscriptions,
    push(event: PairingEvent) {
      queue.push(event);
      wake?.();
    },
    subscribe(...topics: string[]): AsyncIterable<PairingEvent> {
      subscriptions.push(topics);
      return (async function* () {
        for (;;) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      })();
    },
  };
}

const OFFLINE_STATUS = { state: "disconnected", isConnected: false, profileName: null };

let stateDir: string | null = null;
let output: string[] = [];
let configChanged = 0;
let exitCodes: number[] = [];
let printedQrs: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalFetch = globalThis.fetch;

function useTransport(options: {
  runner: ReturnType<typeof fakeRunner>;
  bus?: ReturnType<typeof fakeBus>;
  omni?: ReturnType<typeof createOmniClient> | null;
  runnerWaitMs?: number;
}) {
  const bus = options.bus ?? fakeBus();
  setInstancesTransportDependenciesForTests({
    createClient: () =>
      createChannelTransportClient({
        omni: options.omni ?? null,
        getConfig: () => loadRouterConfig(),
        connection: options.runner.connection,
      }),
    isOmniConfigured: () => Boolean(options.omni),
    subscribe: (...topics) => bus.subscribe(...topics),
    ensureNats: async () => undefined,
    emitConfigChanged: () => {
      configChanged += 1;
    },
    sleep: async () => undefined,
    printQr: (qr) => {
      printedQrs.push(qr);
    },
    exit: (code) => {
      exitCodes.push(code);
    },
    runnerWaitMs: options.runnerWaitMs ?? 1_000,
    runnerRetryIntervalMs: 1,
    pairingTimeoutMs: 2_000,
  });
  return bus;
}

function jsonOutput(): Record<string, unknown> {
  const text = output.join("\n");
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`no JSON output: ${text}`);
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

async function expectContractError(run: () => Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContractError);
  const error = caught as InstanceType<typeof ContractError>;
  expect(error.code).toBe(code);
  return error;
}

function fakeOmniFetch(routes: Record<string, unknown>) {
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname.replace(/^\/api\/v2/, "")}`;
    requests.push(key);
    if (key in routes) return Response.json(routes[key]);
    return Response.json({ error: { message: `unexpected ${key}` } }, { status: 500 });
  }) as unknown as typeof fetch;
  return { client: createOmniClient({ baseUrl: "http://omni.local", apiKey: "k" }), requests };
}

/** An instance already bound to a native WhatsApp channel. */
function seedNativeInstance(name = "wa-native", instanceId = "11111111-1111-4111-8111-111111111111") {
  dbUpsertInstance({ name, instanceId, channel: "whatsapp" });
  dbUpsertChannel({ name, provider: "whatsapp" });
  return instanceId;
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-instances-cli-");
  output = [];
  configChanged = 0;
  exitCodes = [];
  printedQrs = [];
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  console.error = () => {};
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
  setInstancesTransportDependenciesForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

describe("resolveInstanceConnectTransport", () => {
  const base = { channel: "whatsapp", nativeBound: false, setting: null, omniConfigured: true };

  it("defaults to omni when omni is configured and to native when it is not", () => {
    expect(resolveInstanceConnectTransport(base)).toEqual({ transport: "omni", reason: "omni_configured" });
    expect(resolveInstanceConnectTransport({ ...base, omniConfigured: false })).toEqual({
      transport: "native",
      reason: "default",
    });
  });

  it("keeps an instance that already has a native channel on native", () => {
    expect(resolveInstanceConnectTransport({ ...base, nativeBound: true })).toEqual({
      transport: "native",
      reason: "native_channel",
    });
  });

  it("honours the whatsapp.transport setting, then the explicit flag", () => {
    expect(resolveInstanceConnectTransport({ ...base, setting: "native" })).toEqual({
      transport: "native",
      reason: "setting",
    });
    expect(resolveInstanceConnectTransport({ ...base, setting: "native", requested: "OMNI" })).toEqual({
      transport: "omni",
      reason: "flag",
    });
  });

  it("keeps non-WhatsApp channels on omni and rejects native for them", () => {
    expect(resolveInstanceConnectTransport({ ...base, channel: "telegram", omniConfigured: false })).toEqual({
      transport: "omni",
      reason: "channel",
    });
    expect(resolveInstanceConnectTransport({ ...base, channel: "telegram", requested: "native" })).toEqual({
      error: '--transport native only supports WhatsApp (channel "telegram")',
    });
    expect(resolveInstanceConnectTransport({ ...base, requested: "bridge" })).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// connect --transport native
// ---------------------------------------------------------------------------

describe("instances connect --transport native", () => {
  it("creates the native instance and channel, asks the runner to connect and returns the first QR", async () => {
    const bus = fakeBus();
    const runner = fakeRunner({
      "connection.status": () => OFFLINE_STATUS,
      "connection.connect": (request) => {
        // The runner starts a socket; the daemon relays the QR code it publishes.
        bus.push({ topic: `ravi.whatsapp.qr.${request.instanceId}`, data: { type: "qr", qr: "QR-DATA" } });
        return { status: "connecting", message: "Waiting for QR code" };
      },
    });
    useTransport({ runner, bus });

    await new InstancesCommands().connect("wa-test", undefined, undefined, true, "native");

    const instance = dbGetInstance("wa-test");
    expect(instance?.channel).toBe("whatsapp");
    expect(instance?.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const instanceId = instance?.instanceId as string;
    expect(dbGetChannel("wa-test")?.provider).toBe("whatsapp");
    expect(configChanged).toBeGreaterThan(0);

    expect(runner.methods()).toEqual(["connection.status", "connection.connect"]);
    expect(runner.calls.every((call) => call.subject === `_RAVI.channels.whatsapp.rpc.${instanceId}`)).toBe(true);
    expect(runner.calls[1]?.request.params).toEqual({ whatsapp: { syncFullHistory: false } });
    expect(bus.subscriptions).toEqual([[`ravi.whatsapp.qr.${instanceId}`, `ravi.whatsapp.connected.${instanceId}`]]);

    expect(jsonOutput()).toMatchObject({
      status: "qr_required",
      instanceId,
      channel: "whatsapp",
      qr: "QR-DATA",
      transport: "native",
      channelName: "wa-test",
      createdInstance: true,
      createdChannel: true,
      mintedInstanceId: true,
      createdOmniInstance: false,
      changedCount: 1,
    });
  });

  it("defaults to native when omni is not configured and keeps an existing instance UUID", async () => {
    const existingId = "22222222-2222-4222-8222-222222222222";
    dbUpsertInstance({ name: "wa-migrate", instanceId: existingId, channel: "whatsapp", agent: "main" });
    const bus = fakeBus();
    const runner = fakeRunner({
      "connection.status": () => OFFLINE_STATUS,
      "connection.connect": () => {
        bus.push({
          topic: `ravi.whatsapp.connected.${existingId}`,
          data: { type: "connected", profileName: "Ravi Bot", ownerIdentifier: "5511999@s.whatsapp.net" },
        });
        return { status: "connecting", message: "Reconnecting with saved credentials" };
      },
    });
    useTransport({ runner, bus });

    await new InstancesCommands().connect("wa-migrate", undefined, undefined, true);

    expect(dbGetInstance("wa-migrate")?.instanceId).toBe(existingId);
    expect(dbGetInstance("wa-migrate")?.agent).toBe("main");
    expect(jsonOutput()).toMatchObject({
      status: "connected",
      instanceId: existingId,
      live: { type: "connected", profileName: "Ravi Bot" },
      transport: "native",
      createdInstance: false,
      createdChannel: true,
      mintedInstanceId: false,
    });
  });

  it("prints QR codes in text mode and exits once the connected event arrives", async () => {
    const bus = fakeBus();
    const runner = fakeRunner({
      "connection.status": () => OFFLINE_STATUS,
      "connection.connect": (request) => {
        bus.push({ topic: `ravi.whatsapp.qr.${request.instanceId}`, data: { type: "qr", qr: "QR-1" } });
        bus.push({
          topic: `ravi.whatsapp.connected.${request.instanceId}`,
          data: { type: "connected", profileName: "Bot" },
        });
        return { status: "connecting", message: "" };
      },
    });
    useTransport({ runner, bus });

    await new InstancesCommands().connect("wa-text", undefined, undefined, false, "native");

    expect(printedQrs).toEqual(["QR-1"]);
    expect(output.join("\n")).toContain("✓ Connected as Bot");
    expect(exitCodes).toEqual([0]);
  });

  it("reports an already connected instance without asking for a new socket", async () => {
    const instanceId = seedNativeInstance();
    const runner = fakeRunner({
      "connection.status": () => ({ state: "connected", isConnected: true, profileName: "Ravi Bot" }),
    });
    const bus = useTransport({ runner });

    await new InstancesCommands().connect("wa-native", undefined, undefined, true);

    expect(runner.methods()).toEqual(["connection.status"]);
    expect(bus.subscriptions).toEqual([]);
    expect(jsonOutput()).toMatchObject({
      status: "connected",
      instanceId,
      live: { state: "connected", isConnected: true, profileName: "Ravi Bot" },
      transport: "native",
      createdChannel: false,
    });
  });

  it("retries while the runner hot-adds the new channel", async () => {
    const runner = fakeRunner({
      "connection.status": () => ({ state: "connected", isConnected: true, profileName: null }),
    });
    runner.failNext(2);
    useTransport({ runner });

    await new InstancesCommands().connect("wa-hot", undefined, undefined, true, "native");

    expect(runner.methods()).toEqual(["connection.status", "connection.status", "connection.status"]);
    expect(jsonOutput()).toMatchObject({ status: "connected", transport: "native" });
  });

  it("tells the user to start the channel runner when nobody answers the RPC", async () => {
    const runner = fakeRunner({});
    runner.failNext(Number.MAX_SAFE_INTEGER);
    const bus = useTransport({ runner, runnerWaitMs: 0 });

    const error = await expectContractError(
      () => new InstancesCommands().connect("wa-down", undefined, undefined, true, "native"),
      "WHATSAPP_RUNNER_UNAVAILABLE",
    );

    expect(error.message).toContain("ravi channels start");
    expect(String(error.details.suggestedAction)).toContain("ravi channels restart");
    expect(bus.subscriptions).toEqual([]);
    // The instance and channel stay provisioned, so a retry after `ravi channels start` just connects.
    expect(dbGetChannel("wa-down")?.provider).toBe("whatsapp");
  });

  it("refuses --transport omni for an instance owned by a native channel", async () => {
    seedNativeInstance();
    const runner = fakeRunner({});
    useTransport({ runner });

    await expectContractError(
      () => new InstancesCommands().connect("wa-native", undefined, undefined, true, "omni"),
      "INSTANCE_NATIVE_OWNED",
    );
    expect(runner.calls).toEqual([]);
  });

  it("rejects an unknown transport as a usage error", async () => {
    useTransport({ runner: fakeRunner({}) });

    const error = await expectContractError(
      () => new InstancesCommands().connect("wa-any", undefined, undefined, true, "bridge"),
      "USAGE_ERROR",
    );
    expect(error.exitCode).toBe(2);
    expect(dbGetInstance("wa-any")).toBeFalsy();
  });

  it("uses the whatsapp.transport setting when no flag is given", async () => {
    dbSetSetting("whatsapp.transport", "native");
    const runner = fakeRunner({
      "connection.status": () => ({ state: "connected", isConnected: true, profileName: null }),
    });
    useTransport({ runner, omni: createOmniClient({ baseUrl: "http://omni.local", apiKey: "k" }) });

    await new InstancesCommands().connect("wa-setting", undefined, undefined, true);

    expect(dbGetChannel("wa-setting")?.provider).toBe("whatsapp");
    expect(jsonOutput()).toMatchObject({ status: "connected", transport: "native" });
  });
});

// ---------------------------------------------------------------------------
// status / show / list / disconnect
// ---------------------------------------------------------------------------

describe("instances live status through the routing client", () => {
  it("status reads the native runner", async () => {
    const instanceId = seedNativeInstance();
    const runner = fakeRunner({
      "connection.status": () => ({ state: "connected", isConnected: true, profileName: "Ravi Bot" }),
    });
    useTransport({ runner });

    const payload = await new InstancesCommands().status("wa-native", true);

    expect(runner.calls[0]?.subject).toBe(`_RAVI.channels.whatsapp.rpc.${instanceId}`);
    expect(payload).toMatchObject({
      status: "connected",
      transport: "native",
      live: { state: "connected", isConnected: true, profileName: "Ravi Bot" },
    });
  });

  it("status explains a stopped runner", async () => {
    seedNativeInstance();
    const runner = fakeRunner({});
    runner.failNext(1);
    useTransport({ runner });

    await expect(new InstancesCommands().status("wa-native", true)).rejects.toThrow("ravi channels start");
  });

  it("status of a non-native instance without omni says omni is not configured", async () => {
    dbUpsertInstance({ name: "wa-omni", instanceId: "33333333-3333-4333-8333-333333333333", channel: "whatsapp" });
    useTransport({ runner: fakeRunner({}) });

    await expect(new InstancesCommands().status("wa-omni", true)).rejects.toThrow("Omni is not configured");
  });

  it("show includes the native live status and transport", async () => {
    seedNativeInstance();
    const runner = fakeRunner({ "connection.status": () => ({ state: "qr", isConnected: false, profileName: null }) });
    useTransport({ runner });

    const payload = await new InstancesCommands().show("wa-native", true);

    expect(payload).toMatchObject({ transport: "native", live: { state: "qr", isConnected: false } });
  });

  it("list merges native runner status with omni's list", async () => {
    const nativeId = seedNativeInstance();
    const omniId = "44444444-4444-4444-8444-444444444444";
    dbUpsertInstance({ name: "wa-omni", instanceId: omniId, channel: "whatsapp" });
    const omni = fakeOmniFetch({
      "GET /instances": {
        items: [{ id: omniId, name: "wa-omni", isActive: true, profileName: "Omni Bot", state: "connected" }],
      },
    });
    const runner = fakeRunner({
      "connection.status": () => ({ state: "connected", isConnected: true, profileName: "Native Bot" }),
    });
    useTransport({ runner, omni: omni.client });

    const payload = (await new InstancesCommands().list(true)) as {
      items: Array<{ name: string; transport: string | null; live: Record<string, unknown> | null }>;
    };

    const byName = Object.fromEntries(payload.items.map((item) => [item.name, item]));
    expect(byName["wa-native"]).toMatchObject({
      transport: "native",
      live: { isConnected: true, profileName: "Native Bot", state: "connected" },
    });
    // Omni rows keep their previous live shape (no state).
    expect(byName["wa-omni"]?.transport).toBe("omni");
    expect(byName["wa-omni"]?.live).toEqual({ isConnected: true, profileName: "Omni Bot" });
    expect(runner.calls[0]?.subject).toBe(`_RAVI.channels.whatsapp.rpc.${nativeId}`);
  });

  it("list reports a stopped runner as disconnected instead of failing", async () => {
    seedNativeInstance();
    const runner = fakeRunner({});
    runner.failNext(1);
    useTransport({ runner });

    const payload = (await new InstancesCommands().list(true)) as {
      items: Array<{ name: string; live: Record<string, unknown> | null }>;
    };

    expect(payload.items[0]).toMatchObject({ name: "wa-native", live: { isConnected: false, state: "disconnected" } });
  });

  it("disconnect sends the native disconnect RPC", async () => {
    seedNativeInstance();
    const runner = fakeRunner({ "connection.disconnect": () => ({}) });
    useTransport({ runner });

    const payload = await new InstancesCommands().disconnect("wa-native", true);

    expect(runner.methods()).toEqual(["connection.disconnect"]);
    expect(payload).toMatchObject({ status: "disconnected", transport: "native" });
  });
});
