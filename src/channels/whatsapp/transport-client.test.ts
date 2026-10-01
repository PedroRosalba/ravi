import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createOmniClient, OmniApiError, type OmniClient } from "../../omni/client.js";
import { loadRouterConfig } from "../../router/config.js";
import {
  dbGetChannel,
  dbGetInstance,
  dbUpsertChannel,
  dbUpsertInstance,
  type ChannelConfig,
  type InstanceConfig,
} from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { WhatsAppRpcRequestSchema, whatsappRpcSubject, type WhatsAppRpcRequest } from "./contract.js";
import type { WhatsAppRpcConnection } from "./rpc-client.js";
import {
  OMNI_NOT_CONFIGURED_CODE,
  createChannelTransportClient,
  createNativeWhatsAppInstance,
  nativeMediaParams,
  type ChannelTransportClient,
} from "./transport-client.js";

const NATIVE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NATIVE_OFFLINE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OMNI_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Drift guard: the routing client must stay assignable to the Omni client surface.
const _assignable: (client: ChannelTransportClient) => OmniClient = (client) => client;
void _assignable;

function instance(name: string, instanceId: string): InstanceConfig {
  return {
    name,
    instanceId,
    channel: "whatsapp",
    dmPolicy: "open",
    groupPolicy: "open",
    contactIntakeMode: "off",
    createdAt: 0,
    updatedAt: 0,
  };
}

function channel(name: string, overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return { name, provider: "whatsapp", enabled: true, createdAt: 0, updatedAt: 0, ...overrides };
}

function routerConfig() {
  return {
    instances: {
      "wa-native": instance("wa-native", NATIVE_ID),
      "wa-offline": instance("wa-offline", NATIVE_OFFLINE_ID),
      "wa-omni": instance("wa-omni", OMNI_ID),
    },
    channels: {
      "wa-native": channel("wa-native"),
      "wa-offline": channel("wa-offline"),
      // A disabled native channel does not take ownership.
      "wa-omni": channel("wa-omni", { enabled: false }),
    },
    instanceToAccount: { [NATIVE_ID]: "wa-native", [NATIVE_OFFLINE_ID]: "wa-offline", [OMNI_ID]: "wa-omni" },
  };
}

type RpcHandler = (request: WhatsAppRpcRequest) => unknown;

function fakeNats(handlers: Record<string, RpcHandler>, offline: string[] = [NATIVE_OFFLINE_ID]) {
  const calls: Array<{ subject: string; request: WhatsAppRpcRequest; timeout: number }> = [];
  const connection: WhatsAppRpcConnection = {
    async request(subject, data, options) {
      const request = WhatsAppRpcRequestSchema.parse(JSON.parse(new TextDecoder().decode(data)));
      calls.push({ subject, request, timeout: options.timeout });
      if (offline.includes(request.instanceId)) throw Object.assign(new Error("503"), { code: "503" });
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
  return { connection, calls };
}

const originalFetch = globalThis.fetch;

function fakeOmni(routes: Record<string, unknown> = {}) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v2/, "");
    requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    if (key in routes) {
      const value = routes[key];
      if (value instanceof Response) return value;
      return Response.json(value);
    }
    return Response.json({ error: { message: `unexpected ${key}` } }, { status: 500 });
  }) as unknown as typeof fetch;
  return { client: createOmniClient({ baseUrl: "http://omni.local", apiKey: "k" }), requests };
}

async function captureError(promise: Promise<unknown>): Promise<OmniApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OmniApiError);
    return err as OmniApiError;
  }
  throw new Error("expected the call to fail");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createChannelTransportClient dispatch", () => {
  it("sends native messages over RPC without the instanceId param", async () => {
    const { connection, calls } = fakeNats({ "messages.send": () => ({ messageId: "BAE5", status: "sent" }) });
    const { client: omni, requests } = fakeOmni();
    const client = createChannelTransportClient({ omni, getConfig: routerConfig, connection });

    const result = await client.messages.send({
      instanceId: NATIVE_ID,
      to: "120363@g.us",
      text: "@1 oi",
      threadId: "t1",
      mentions: [{ id: "1@lid", type: "user" }],
    });

    expect(result).toEqual({ messageId: "BAE5", status: "sent" });
    expect(requests).toHaveLength(0);
    expect(calls[0]!.subject).toBe(whatsappRpcSubject(NATIVE_ID));
    expect(calls[0]!.request.params).toEqual({
      to: "120363@g.us",
      text: "@1 oi",
      threadId: "t1",
      mentions: [{ id: "1@lid", type: "user" }],
    });
  });

  it("resolves account names to the native instance UUID", async () => {
    const { connection, calls } = fakeNats({
      "instances.status": () => ({ state: "connected", isConnected: true, profileName: "Ravi" }),
    });
    const client = createChannelTransportClient({ omni: null, getConfig: routerConfig, connection });
    expect(await client.instances.status("wa-native")).toEqual({
      state: "connected",
      isConnected: true,
      profileName: "Ravi",
    });
    expect(calls[0]!.request.instanceId).toBe(NATIVE_ID);
    expect(client.native.isNativeInstance("wa-native")).toBe(true);
    expect(client.native.isNativeInstance(OMNI_ID)).toBe(false);
  });

  it("sends other instances to Omni", async () => {
    const { connection, calls } = fakeNats({});
    const { client: omni, requests } = fakeOmni({
      "POST /messages/send": { data: { messageId: "omni-1", status: "sent" } },
    });
    const client = createChannelTransportClient({ omni, getConfig: routerConfig, connection });

    const result = await client.messages.send({ instanceId: OMNI_ID, to: "5511@s.whatsapp.net", text: "hi" });

    expect(result).toEqual({ messageId: "omni-1", status: "sent" });
    expect(calls).toHaveLength(0);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/messages/send", body: { instanceId: OMNI_ID } });
  });

  it("fails with 503 OMNI_NOT_CONFIGURED for non-native instances without Omni", async () => {
    const { connection } = fakeNats({});
    const client = createChannelTransportClient({ omni: null, getConfig: routerConfig, connection });
    for (const call of [
      client.messages.send({ instanceId: OMNI_ID, to: "x", text: "y" }),
      client.instances.status(OMNI_ID),
      client.instances.create({ name: "new", channel: "whatsapp-baileys" }),
      client.chats.listParticipants("chat-uuid"),
    ]) {
      const err = await captureError(call);
      expect(err.status).toBe(503);
      expect(err.code).toBe(OMNI_NOT_CONFIGURED_CODE);
    }
    expect(client.hasOmni()).toBe(false);
  });

  it("propagates runner unavailability as a 503 OmniApiError", async () => {
    const { connection } = fakeNats({});
    const client = createChannelTransportClient({ omni: null, getConfig: routerConfig, connection });
    const err = await captureError(client.messages.send({ instanceId: NATIVE_OFFLINE_ID, to: "x@g.us", text: "hi" }));
    expect(err.status).toBe(503);
    expect(err.code).toBe("WHATSAPP_RUNNER_UNAVAILABLE");
    expect(err.message).toContain("ravi channels start");
  });

  it("maps every Omni message call to its RPC method", async () => {
    const { connection, calls } = fakeNats({
      "messages.sendPresence": () => ({}),
      "messages.sendReaction": () => ({ messageId: "r1", success: true }),
      "messages.deleteChannel": () => ({}),
      "messages.editChannel": () => ({}),
      "messages.sendMedia": () => ({ messageId: "m1", status: "sent" }),
      "messages.sendSticker": () => ({ messageId: "s1", status: "sent" }),
      "messages.batchMarkRead": () => ({}),
    });
    const client = createChannelTransportClient({ omni: null, getConfig: routerConfig, connection });

    await client.messages.sendPresence({ instanceId: NATIVE_ID, to: "x@g.us", type: "typing", duration: 30_000 });
    expect(
      await client.messages.sendReaction({ instanceId: NATIVE_ID, to: "x@g.us", messageId: "m", emoji: "👍" }),
    ).toEqual({ messageId: "r1", success: true });
    await client.messages.deleteChannel({ instanceId: NATIVE_ID, channelId: "x@g.us", messageId: "m" });
    await client.messages.editChannel({ instanceId: NATIVE_ID, channelId: "x@g.us", messageId: "m", text: "t" });
    expect(
      await client.messages.sendMedia({
        instanceId: NATIVE_ID,
        to: "x@g.us",
        type: "image",
        filePath: "/tmp/a.png",
        base64: "AAAA",
        filename: "a.png",
      }),
    ).toEqual({ messageId: "m1", status: "sent" });
    expect(await client.messages.sendSticker({ instanceId: NATIVE_ID, to: "x@g.us", filePath: "/tmp/s.webp" })).toEqual(
      {
        messageId: "s1",
        status: "sent",
      },
    );
    await client.messages.batchMarkRead({ instanceId: NATIVE_ID, chatId: "x@g.us", messageIds: ["m"] });

    expect(calls.map((call) => call.request.method)).toEqual([
      "messages.sendPresence",
      "messages.sendReaction",
      "messages.deleteChannel",
      "messages.editChannel",
      "messages.sendMedia",
      "messages.sendSticker",
      "messages.batchMarkRead",
    ]);
    for (const call of calls) expect(call.request.params).not.toHaveProperty("instanceId");
    expect(calls[4]!.request.params).toEqual({
      to: "x@g.us",
      type: "image",
      filePath: "/tmp/a.png",
      filename: "a.png",
    });
    expect(calls[4]!.timeout).toBe(120_000);
    expect(calls[0]!.timeout).toBe(10_000);
  });

  it("maps group calls to RPC and Omni-shaped results", async () => {
    const group = {
      id: "120363@g.us",
      externalId: "120363@g.us",
      subject: "Team",
      name: "Team",
      participants: [{ id: "1@lid", admin: "superadmin" }],
      memberCount: 1,
      isCommunity: false,
    };
    const { connection, calls } = fakeNats({
      "instances.listGroups": () => ({ items: [group] }),
      "instances.createGroup": () => group,
      "instances.addGroupParticipants": (req) => ({
        groupJid: (req.params as { groupJid: string }).groupJid,
        results: [{ jid: "2@s.whatsapp.net", status: "200" }],
      }),
      "instances.updateGroupParticipants": () => ({ groupJid: group.id, results: [] }),
      "instances.getGroupInvite": () => ({
        groupJid: group.id,
        code: "abc",
        inviteLink: "https://chat.whatsapp.com/abc",
      }),
      "instances.revokeGroupInvite": () => ({
        groupJid: group.id,
        code: "def",
        inviteLink: "https://chat.whatsapp.com/def",
      }),
      "instances.joinGroup": () => ({ groupJid: group.id, joined: true }),
      "instances.leaveGroup": () => ({ groupJid: group.id, left: true }),
      "instances.renameGroup": () => ({ groupJid: group.id, subject: "New" }),
      "instances.setGroupDescription": () => ({ groupJid: group.id, description: "d" }),
      "instances.setGroupSettings": () => ({ groupJid: group.id, setting: "announcement" }),
      "instances.connect": () => ({ status: "connecting", message: "Connection initiated" }),
      "instances.disconnect": () => ({}),
    });
    const client = createChannelTransportClient({ omni: null, getConfig: routerConfig, connection });

    expect((await client.instances.listGroups(NATIVE_ID, { limit: 500, search: undefined })).items).toEqual([group]);
    expect(calls.at(-1)!.request.params).toEqual({ limit: 500 });
    expect(await client.instances.createGroup(NATIVE_ID, { subject: "Team", participants: ["2"] })).toEqual(group);
    expect(await client.instances.addGroupParticipants(NATIVE_ID, group.id, { participants: ["2"] })).toEqual({
      groupJid: group.id,
      results: [{ jid: "2@s.whatsapp.net", status: "200" }],
    });
    await client.instances.updateGroupParticipants(NATIVE_ID, group.id, { action: "promote", participants: ["2"] });
    expect(calls.at(-1)!.request.params).toEqual({ groupJid: group.id, action: "promote", participants: ["2"] });
    expect((await client.instances.getGroupInvite(NATIVE_ID, group.id)).inviteLink).toBe(
      "https://chat.whatsapp.com/abc",
    );
    expect((await client.instances.revokeGroupInvite(NATIVE_ID, group.id)).code).toBe("def");
    expect(await client.instances.joinGroup(NATIVE_ID, { code: "abc" })).toEqual({ groupJid: group.id, joined: true });
    expect(await client.instances.leaveGroup(NATIVE_ID, group.id)).toEqual({ groupJid: group.id, left: true });
    expect(await client.instances.renameGroup(NATIVE_ID, group.id, { subject: "New" })).toMatchObject({
      subject: "New",
    });
    await client.instances.setGroupDescription(NATIVE_ID, group.id, { description: "d" });
    await client.instances.setGroupSettings(NATIVE_ID, group.id, { setting: "announcement" });
    expect(await client.instances.connect(NATIVE_ID, { whatsapp: { syncFullHistory: false } })).toEqual({
      status: "connecting",
      message: "Connection initiated",
    });
    expect(calls.at(-1)!.request.params).toEqual({ whatsapp: { syncFullHistory: false } });
    await client.instances.disconnect(NATIVE_ID);
    expect(calls.at(-1)!.request.method).toBe("instances.disconnect");
  });

  it("keeps chats Omni-only and returns no Omni chats for native instances", async () => {
    const { connection, calls } = fakeNats({});
    const { client: omni, requests } = fakeOmni({ "GET /chats": { items: [{ id: "chat-1" }], meta: {} } });
    const client = createChannelTransportClient({ omni, getConfig: routerConfig, connection });

    expect((await client.chats.list({ instanceId: NATIVE_ID, chatType: "group" })).items).toEqual([]);
    expect(requests).toHaveLength(0);
    expect((await client.chats.list({ instanceId: OMNI_ID })).items).toEqual([{ id: "chat-1" }]);
    expect(requests).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it("exposes native-only RPC methods and rejects non-native targets", async () => {
    const { connection } = fakeNats({
      "groups.metadata": () => ({ groupJid: "1@g.us", subject: "G", participants: [], fetchedAt: 1 }),
    });
    const client = createChannelTransportClient({ omni: null, getConfig: routerConfig, connection });
    expect((await client.native.request("wa-native", "groups.metadata", { groupJid: "1@g.us" })).subject).toBe("G");
    const err = await captureError(client.native.request(OMNI_ID, "groups.metadata", { groupJid: "1@g.us" }));
    expect(err.status).toBe(404);
  });
});

describe("instances.list", () => {
  it("merges native instances (offline as disconnected) with Omni's list", async () => {
    const { connection, calls } = fakeNats({
      "instances.status": () => ({ state: "connected", isConnected: true, profileName: "Ravi" }),
    });
    const { client: omni } = fakeOmni({
      "GET /instances": {
        items: [
          { id: OMNI_ID, name: "wa-omni", isActive: true, profileName: "Omni" },
          { id: NATIVE_ID, name: "wa-native", isActive: false, profileName: "stale omni record" },
        ],
        meta: { hasMore: false },
      },
    });
    const client = createChannelTransportClient({ omni, getConfig: routerConfig, connection });

    const page = await client.instances.list({});

    expect(page.items).toEqual([
      {
        id: NATIVE_ID,
        name: "wa-native",
        channel: "whatsapp-baileys",
        isActive: true,
        isConnected: true,
        profileName: "Ravi",
        state: "connected",
      },
      {
        id: NATIVE_OFFLINE_ID,
        name: "wa-offline",
        channel: "whatsapp-baileys",
        isActive: false,
        isConnected: false,
        profileName: null,
        state: "disconnected",
      },
      { id: OMNI_ID, name: "wa-omni", isActive: true, profileName: "Omni" },
    ]);
    expect(page.meta).toMatchObject({ hasMore: false, nativeInstanceIds: [NATIVE_ID, NATIVE_OFFLINE_ID] });
    expect(calls.every((call) => call.timeout === 2_500)).toBe(true);
  });

  it("lists native instances without Omni and when Omni fails", async () => {
    const { connection } = fakeNats({
      "instances.status": () => ({ state: "qr", isConnected: false, profileName: null }),
    });
    const withoutOmni = createChannelTransportClient({ omni: null, getConfig: routerConfig, connection });
    expect((await withoutOmni.instances.list()).items.map((item) => item.id)).toEqual([NATIVE_ID, NATIVE_OFFLINE_ID]);

    const { client: omni } = fakeOmni({ "GET /instances": Response.json({ error: "down" }, { status: 502 }) });
    const failingOmni = createChannelTransportClient({ omni, getConfig: routerConfig, connection });
    const page = await failingOmni.instances.list();
    expect(page.items).toHaveLength(2);
    expect(page.meta).toMatchObject({ omniError: "down" });
  });

  it("skips native instances when filtering on another channel", async () => {
    const { connection, calls } = fakeNats({});
    const { client: omni } = fakeOmni({ "GET /instances": { items: [{ id: "tg", name: "tg" }] } });
    const client = createChannelTransportClient({ omni, getConfig: routerConfig, connection });
    expect((await client.instances.list({ channel: "telegram" })).items).toEqual([{ id: "tg", name: "tg" }]);
    expect(calls).toHaveLength(0);
  });
});

describe("nativeMediaParams", () => {
  it("drops base64 when an absolute filePath is present", () => {
    expect(nativeMediaParams({ instanceId: NATIVE_ID, to: "x", filePath: "/a/b.png", base64: "AA" })).toEqual({
      to: "x",
      filePath: "/a/b.png",
    });
  });

  it("drops a relative filePath when base64 is available and rejects it otherwise", () => {
    expect(nativeMediaParams({ to: "x", filePath: "b.png", base64: "AA" })).toEqual({ to: "x", base64: "AA" });
    expect(() => nativeMediaParams({ to: "x", filePath: "b.png" })).toThrow(OmniApiError);
  });
});

describe("createNativeWhatsAppInstance", () => {
  // Other suites in the same bun process may replace the config-store module.
  const quiet = { emitConfigChanged: () => {}, refreshConfig: () => {} };
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-wa-transport-client-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("creates the instance with a fresh UUID and binds a whatsapp channel", () => {
    const emitted: number[] = [];
    const result = createNativeWhatsAppInstance("wa-new", { ...quiet, emitConfigChanged: () => emitted.push(1) });

    expect(result.createdInstance).toBe(true);
    expect(result.mintedInstanceId).toBe(true);
    expect(result.createdChannel).toBe(true);
    expect(result.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(dbGetInstance("wa-new")).toMatchObject({ instanceId: result.instanceId, channel: "whatsapp" });
    expect(dbGetChannel("wa-new")).toMatchObject({ provider: "whatsapp", enabled: true });
    expect(emitted).toHaveLength(1);

    const client = createChannelTransportClient({ omni: null, getConfig: loadRouterConfig });
    expect(client.native.resolveBinding("wa-new")?.instanceId).toBe(result.instanceId);
    expect(client.native.isNativeInstance(result.instanceId)).toBe(true);
  });

  it("keeps an existing (Omni) UUID and the instance settings", () => {
    dbUpsertInstance({ name: "wa-migrate", instanceId: OMNI_ID, channel: "whatsapp", dmPolicy: "closed" });
    const result = createNativeWhatsAppInstance("wa-migrate", quiet);

    expect(result.instanceId).toBe(OMNI_ID);
    expect(result.createdInstance).toBe(false);
    expect(result.mintedInstanceId).toBe(false);
    expect(result.createdChannel).toBe(true);
    expect(dbGetInstance("wa-migrate")).toMatchObject({ instanceId: OMNI_ID, dmPolicy: "closed" });
  });

  it("mints a UUID for an existing instance without one", () => {
    dbUpsertInstance({ name: "wa-bare", channel: "whatsapp" });
    const result = createNativeWhatsAppInstance("wa-bare", quiet);
    expect(result.mintedInstanceId).toBe(true);
    expect(dbGetInstance("wa-bare")?.instanceId).toBe(result.instanceId);
  });

  it("is idempotent", () => {
    createNativeWhatsAppInstance("wa-twice", quiet);
    const emitted: number[] = [];
    const second = createNativeWhatsAppInstance("wa-twice", { ...quiet, emitConfigChanged: () => emitted.push(1) });
    expect(second.createdInstance || second.createdChannel || second.mintedInstanceId).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it("refuses names owned by another provider, channel type or a disabled channel", () => {
    dbUpsertChannel({ name: "slack-main", provider: "slack" });
    expect(() => createNativeWhatsAppInstance("slack-main", quiet)).toThrow(/provider "slack"/);

    dbUpsertInstance({ name: "tg", instanceId: "tg-1", channel: "telegram" });
    expect(() => createNativeWhatsAppInstance("tg", quiet)).toThrow(/not WhatsApp/);

    dbUpsertChannel({ name: "wa-off", provider: "whatsapp", enabled: false });
    expect(() => createNativeWhatsAppInstance("wa-off", quiet)).toThrow(/disabled/);
    expect(dbGetInstance("wa-off")).toBeNull();
  });
});
