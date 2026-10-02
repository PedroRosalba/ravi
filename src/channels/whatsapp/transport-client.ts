/**
 * Routing transport client.
 *
 * Exposes the exact `OmniClient` surface (src/omni/client.ts) so the gateway,
 * OmniSender, OmniConsumer and CLI keep calling the same methods, and dispatches
 * each call per instance:
 *
 * - the instance is owned by a native WhatsApp channel (`resolveNativeWhatsAppBinding`
 *   on the live router config) → NATS RPC to the `ravi channels` runner;
 * - otherwise → the Omni REST client, when Omni is configured;
 * - otherwise → `OmniApiError` 503 `OMNI_NOT_CONFIGURED`.
 *
 * `chats.*` are Omni database records (chat UUIDs), so they stay Omni-only. A native
 * instance has no Omni chats: `chats.list({instanceId: <native>})` returns an empty
 * page. Native group metadata goes through the `groups.metadata` RPC instead
 * (`client.native.request(id, "groups.metadata", ...)`).
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { configStore } from "../../config-store.js";
import { nats } from "../../nats.js";
import { createOmniClient, OmniApiError, type OmniClient } from "../../omni/client.js";
import { resolveOmniConnection } from "../../omni-config.js";
import {
  dbGetChannel,
  dbGetInstance,
  dbUpdateInstance,
  dbUpsertChannel,
  dbUpsertInstance,
  type ChannelConfig,
  type InstanceConfig,
} from "../../router/router-db.js";
import { loadRouterConfig } from "../../router/config.js";
import type { RouterConfig } from "../../router/types.js";
import { logger } from "../../utils/logger.js";
import { canonicalChannelId } from "../capabilities.js";
import {
  WHATSAPP_CHANNEL_TYPE,
  WHATSAPP_PROVIDER,
  WHATSAPP_RPC_ERROR_CODES,
  listNativeWhatsAppBindings,
  resolveNativeWhatsAppBinding,
  type NativeWhatsAppBinding,
  type WhatsAppRpcMethod,
  type WhatsAppRpcParams,
  type WhatsAppRpcResult,
  type WhatsAppRpcResults,
} from "./contract.js";
import {
  requestWhatsAppRpc,
  requestWhatsAppRpcRaw,
  type WhatsAppRpcConnection,
  type WhatsAppRpcRequestOptions,
} from "./rpc-client.js";

const log = logger.child("channels:whatsapp:transport-client");

type OwnershipConfig = Pick<RouterConfig, "instances" | "channels" | "instanceToAccount">;
type JsonObject = Record<string, unknown>;
type InstancesApi = OmniClient["instances"];
type InstanceListPage = Awaited<ReturnType<InstancesApi["list"]>>;
type InstanceListItem = InstanceListPage["items"][number];
type ListQuery = Parameters<InstancesApi["list"]>[0];

export const OMNI_NOT_CONFIGURED_CODE = "OMNI_NOT_CONFIGURED" as const;

/** Per-call RPC timeouts. Anything not listed uses the contract default (60s). */
export const WHATSAPP_TRANSPORT_TIMEOUTS_MS = {
  /** `instances.list` status probe per native instance; an offline runner must not stall the list. */
  listStatus: 2_500,
  status: 10_000,
  presence: 10_000,
  markRead: 15_000,
  /** Media may need ffmpeg/sharp conversion and an upload in the runner. */
  media: 120_000,
} as const;

export interface ChannelTransportClientOptions {
  /**
   * Omni REST client. `undefined` (default) resolves one lazily from
   * `resolveOmniConnection()` on first use; `null` means "Omni is not configured".
   */
  omni?: OmniClient | null;
  /** Live router config. Defaults to `configStore.getConfig()`. */
  getConfig?: () => OwnershipConfig;
  /** NATS connection for the RPC. Defaults to the shared lazy connection. */
  connection?: WhatsAppRpcConnection;
}

export interface NativeWhatsAppTransport {
  /** Native binding for an instance UUID or account name, or null when Omni (or nobody) owns it. */
  resolveBinding(instanceIdOrAccount: string | undefined | null): NativeWhatsAppBinding | null;
  isNativeInstance(instanceIdOrAccount: string | undefined | null): boolean;
  /** Call any RPC method (incl. ones without an Omni equivalent: logout, pairingCode, groups.metadata). */
  request<M extends WhatsAppRpcMethod>(
    instanceIdOrAccount: string,
    method: M,
    params: WhatsAppRpcParams<M>,
    options?: Pick<WhatsAppRpcRequestOptions, "timeoutMs">,
  ): Promise<WhatsAppRpcResult<M>>;
}

export type ChannelTransportClient = OmniClient & {
  readonly native: NativeWhatsAppTransport;
  /** Whether an Omni REST client is available (configured). */
  hasOmni(): boolean;
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function omniNotConfigured(instanceId?: string): OmniApiError {
  const subject = instanceId ? ` and instance ${instanceId} is not owned by a native WhatsApp channel` : "";
  return new OmniApiError(`Omni is not configured${subject}`, { status: 503, code: OMNI_NOT_CONFIGURED_CODE });
}

function invalidRequest(message: string): OmniApiError {
  return new OmniApiError(message, { status: 400, code: WHATSAPP_RPC_ERROR_CODES.invalidRequest });
}

function bodyInstanceId(body: JsonObject): string | undefined {
  const value = body.instanceId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function withoutInstanceId(body: JsonObject): JsonObject {
  const { instanceId: _instanceId, ...rest } = body;
  return rest;
}

function definedEntries(query: ListQuery): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * The runner reads `filePath` from disk (same host), so media always travels as an
 * absolute path: a relative `filePath` is resolved against this process's cwd (the
 * same as OmniSender's `resolve(localPath)`) and `base64` is dropped. A body without a
 * `filePath` is rejected.
 */
export function nativeMediaParams(body: JsonObject): JsonObject {
  const { base64: _base64, ...params } = withoutInstanceId(body);
  const filePath = typeof params.filePath === "string" ? params.filePath.trim() : "";
  if (!filePath) throw invalidRequest("filePath is required for WhatsApp media");
  return { ...params, filePath: resolve(filePath) };
}

/** Omni presence body `{to, type, duration}` → `presence.set` params `{to, state, durationMs}`. */
export function nativePresenceParams(body: JsonObject): JsonObject {
  const { type, duration, ...rest } = withoutInstanceId(body);
  return {
    ...rest,
    ...(type !== undefined ? { state: type } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
  };
}

/** Omni `{channelId}` (delete/edit body) → v2 `{chatId}`. */
export function nativeChatParams(body: JsonObject): JsonObject {
  const { channelId, ...rest } = withoutInstanceId(body);
  return { ...rest, chatId: channelId };
}

function isWhatsAppChannelFilter(channel: unknown): boolean {
  if (channel === undefined || channel === null || channel === "") return true;
  return typeof channel === "string" && canonicalChannelId(channel) === WHATSAPP_PROVIDER;
}

function nativeInstanceRecord(
  binding: NativeWhatsAppBinding,
  status: WhatsAppRpcResults["connection.status"],
): InstanceListItem {
  return {
    id: binding.instanceId,
    name: binding.accountName,
    channel: WHATSAPP_CHANNEL_TYPE,
    // Omni flips `isActive` with connect/disconnect, and ravi reads it as "connected".
    isActive: status.isConnected,
    isConnected: status.isConnected,
    profileName: status.profileName,
    state: status.state,
  };
}

const OFFLINE_STATUS: WhatsAppRpcResults["connection.status"] = {
  state: "disconnected",
  isConnected: false,
  profileName: null,
};

export function createChannelTransportClient(options: ChannelTransportClientOptions = {}): ChannelTransportClient {
  const getConfig = options.getConfig ?? (() => configStore.getConfig());
  const connection = options.connection;
  let omniResolved = options.omni !== undefined;
  let omniClient: OmniClient | null = options.omni ?? null;

  function omni(): OmniClient | null {
    if (!omniResolved) {
      omniResolved = true;
      const conn = resolveOmniConnection();
      omniClient = conn ? createOmniClient({ baseUrl: conn.apiUrl, apiKey: conn.apiKey }) : null;
    }
    return omniClient;
  }

  function resolveBinding(ref: string | undefined | null): NativeWhatsAppBinding | null {
    return resolveNativeWhatsAppBinding(getConfig(), ref);
  }

  function requireOmni(instanceId?: string): OmniClient {
    const client = omni();
    if (!client) throw omniNotConfigured(instanceId);
    return client;
  }

  function rpc<M extends WhatsAppRpcMethod>(
    binding: NativeWhatsAppBinding,
    method: M,
    params: unknown,
    timeoutMs?: number,
  ): Promise<WhatsAppRpcResult<M>> {
    return requestWhatsAppRpcRaw(binding.instanceId, method, params, {
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(connection ? { connection } : {}),
    });
  }

  /** Route a call whose instance comes from a JSON body (`messages.*`). */
  function routeBody(body: JsonObject): { binding: NativeWhatsAppBinding } | { omni: OmniClient } {
    const instanceId = bodyInstanceId(body);
    const binding = resolveBinding(instanceId);
    if (binding) return { binding };
    const client = omni();
    if (client) return { omni: client };
    if (!instanceId) throw invalidRequest("instanceId is required");
    throw omniNotConfigured(instanceId);
  }

  async function listInstances(params?: ListQuery): Promise<InstanceListPage> {
    const bindings = isWhatsAppChannelFilter(params?.channel) ? listNativeWhatsAppBindings(getConfig()) : [];
    const nativeItems = await Promise.all(
      bindings.map(async (binding) => {
        try {
          const status = await rpc(binding, "connection.status", {}, WHATSAPP_TRANSPORT_TIMEOUTS_MS.listStatus);
          return nativeInstanceRecord(binding, status);
        } catch (err) {
          log.debug("Native WhatsApp status unavailable while listing instances", {
            instanceId: binding.instanceId,
            error: errorText(err),
          });
          return nativeInstanceRecord(binding, OFFLINE_STATUS);
        }
      }),
    );
    const nativeIds = new Set(bindings.map((binding) => binding.instanceId));
    const meta: JsonObject = { nativeInstanceIds: [...nativeIds] };

    const client = omni();
    if (!client) return { items: nativeItems, meta };
    try {
      const page = await client.instances.list(params);
      return {
        // A natively owned instance wins over a stale Omni record with the same UUID.
        items: [...nativeItems, ...page.items.filter((item) => !item.id || !nativeIds.has(item.id))],
        meta: { ...(page.meta ?? {}), ...meta },
      };
    } catch (err) {
      if (nativeItems.length === 0) throw err;
      log.warn("Omni instance list failed; returning native instances only", { error: errorText(err) });
      return { items: nativeItems, meta: { ...meta, omniError: errorText(err) } };
    }
  }

  const instances = {
    list: listInstances,
    async create(body: { name: string; channel: string }) {
      // Native instances are created locally with createNativeWhatsAppInstance().
      return requireOmni().instances.create(body);
    },
    async status(id: string) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.status(id);
      return rpc(binding, "connection.status", {}, WHATSAPP_TRANSPORT_TIMEOUTS_MS.status);
    },
    async connect(id: string, body?: unknown) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.connect(id, body);
      return rpc(binding, "connection.connect", body ?? {});
    },
    async disconnect(id: string) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.disconnect(id);
      await rpc(binding, "connection.disconnect", {});
    },
    async listGroups(id: string, params?: ListQuery) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.listGroups(id, params);
      const data = await rpc(binding, "groups.list", definedEntries(params));
      return { items: data.items, meta: { transport: "native" } };
    },
    async createGroup(id: string, body: { subject: string; participants: string[] }) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.createGroup(id, body);
      return { ...(await rpc(binding, "groups.create", body)) };
    },
    async addGroupParticipants(id: string, groupJid: string, body: { participants: string[] }) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.addGroupParticipants(id, groupJid, body);
      return {
        ...(await rpc(binding, "groups.addParticipants", { groupJid, participants: body.participants })),
      };
    },
    async updateGroupParticipants(
      id: string,
      groupJid: string,
      body: Parameters<InstancesApi["updateGroupParticipants"]>[2],
    ) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.updateGroupParticipants(id, groupJid, body);
      return {
        ...(await rpc(binding, "groups.updateParticipants", {
          groupJid,
          action: body.action,
          participants: body.participants,
        })),
      };
    },
    async getGroupInvite(id: string, groupJid: string) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.getGroupInvite(id, groupJid);
      return { ...(await rpc(binding, "groups.getInvite", { groupJid })) };
    },
    async revokeGroupInvite(id: string, groupJid: string) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.revokeGroupInvite(id, groupJid);
      return { ...(await rpc(binding, "groups.revokeInvite", { groupJid })) };
    },
    async joinGroup(id: string, body: { code: string }) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.joinGroup(id, body);
      return { ...(await rpc(binding, "groups.join", { code: body.code })) };
    },
    async leaveGroup(id: string, groupJid: string) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.leaveGroup(id, groupJid);
      return { ...(await rpc(binding, "groups.leave", { groupJid })) };
    },
    async renameGroup(id: string, groupJid: string, body: { subject: string }) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.renameGroup(id, groupJid, body);
      return { ...(await rpc(binding, "groups.rename", { groupJid, subject: body.subject })) };
    },
    async setGroupDescription(id: string, groupJid: string, body: { description: string }) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.setGroupDescription(id, groupJid, body);
      return { ...(await rpc(binding, "groups.setDescription", { groupJid, description: body.description })) };
    },
    async setGroupSettings(id: string, groupJid: string, body: { setting: string }) {
      const binding = resolveBinding(id);
      if (!binding) return requireOmni(id).instances.setGroupSettings(id, groupJid, body);
      return { ...(await rpc(binding, "groups.setSettings", { groupJid, setting: body.setting })) };
    },
  } satisfies InstancesApi;

  const chats = {
    async list(params?: Parameters<OmniClient["chats"]["list"]>[0]) {
      const instanceId = typeof params?.instanceId === "string" ? params.instanceId : undefined;
      // Omni has no chat records for an instance it does not own.
      if (resolveBinding(instanceId)) return { items: [], meta: { transport: "native" } };
      return requireOmni(instanceId).chats.list(params);
    },
    async listParticipants(id: string) {
      return requireOmni().chats.listParticipants(id);
    },
    async addParticipant(id: string, body: Parameters<OmniClient["chats"]["addParticipant"]>[1]) {
      return requireOmni().chats.addParticipant(id, body);
    },
  } satisfies OmniClient["chats"];

  const messages = {
    async send(body: JsonObject) {
      const route = routeBody(body);
      if ("omni" in route) return route.omni.messages.send(body);
      return rpc(route.binding, "messages.sendText", withoutInstanceId(body));
    },
    async sendPresence(body: JsonObject) {
      const route = routeBody(body);
      if ("omni" in route) return route.omni.messages.sendPresence(body);
      await rpc(route.binding, "presence.set", nativePresenceParams(body), WHATSAPP_TRANSPORT_TIMEOUTS_MS.presence);
    },
    async sendReaction(body: JsonObject) {
      const route = routeBody(body);
      if ("omni" in route) return route.omni.messages.sendReaction(body);
      return rpc(route.binding, "messages.react", withoutInstanceId(body));
    },
    async deleteChannel(body: { instanceId: string; channelId: string; messageId: string }) {
      const route = routeBody(body);
      if ("omni" in route) return route.omni.messages.deleteChannel(body);
      await rpc(route.binding, "messages.delete", nativeChatParams(body));
    },
    async editChannel(body: { instanceId: string; channelId: string; messageId: string; text: string }) {
      const route = routeBody(body);
      if ("omni" in route) return route.omni.messages.editChannel(body);
      await rpc(route.binding, "messages.edit", nativeChatParams(body));
    },
    async sendMedia(body: JsonObject) {
      const route = routeBody(body);
      if ("omni" in route) return route.omni.messages.sendMedia(body);
      return rpc(route.binding, "messages.sendMedia", nativeMediaParams(body), WHATSAPP_TRANSPORT_TIMEOUTS_MS.media);
    },
    async sendSticker(body: JsonObject) {
      const route = routeBody(body);
      if ("omni" in route) return route.omni.messages.sendSticker(body);
      return rpc(route.binding, "messages.sendSticker", nativeMediaParams(body), WHATSAPP_TRANSPORT_TIMEOUTS_MS.media);
    },
    async batchMarkRead(body: { instanceId: string; chatId: string; messageIds: string[] }) {
      const route = routeBody(body);
      if ("omni" in route) return route.omni.messages.batchMarkRead(body);
      await rpc(route.binding, "messages.markRead", withoutInstanceId(body), WHATSAPP_TRANSPORT_TIMEOUTS_MS.markRead);
    },
  } satisfies OmniClient["messages"];

  const native: NativeWhatsAppTransport = {
    resolveBinding,
    isNativeInstance: (ref) => resolveBinding(ref) !== null,
    request(ref, method, params, requestOptions) {
      const binding = resolveBinding(ref);
      if (!binding) {
        return Promise.reject(
          new OmniApiError(`Instance ${ref} is not owned by a native WhatsApp channel`, {
            status: 404,
            code: WHATSAPP_RPC_ERROR_CODES.notFound,
          }),
        );
      }
      return requestWhatsAppRpc(binding.instanceId, method, params, {
        ...(requestOptions?.timeoutMs ? { timeoutMs: requestOptions.timeoutMs } : {}),
        ...(connection ? { connection } : {}),
      });
    },
  };

  const surface = { instances, chats, messages } satisfies OmniClient;
  return { ...surface, native, hasOmni: () => omni() !== null };
}

// ============================================================================
// Native instance provisioning
// ============================================================================

export interface CreateNativeWhatsAppInstanceOptions {
  /** Agent for a newly created instance (ignored when the instance exists). */
  agent?: string;
  /** Defaults to publishing `ravi.config.changed`. */
  emitConfigChanged?: () => void;
  /** Refresh this process's cached router config. Defaults to `configStore.refresh()`. */
  refreshConfig?: () => void;
}

export interface NativeWhatsAppInstanceResult {
  instanceId: string;
  instance: InstanceConfig;
  channel: ChannelConfig;
  createdInstance: boolean;
  /** A new UUID was minted (new instance, or an existing instance without one). */
  mintedInstanceId: boolean;
  createdChannel: boolean;
}

function defaultEmitConfigChanged(): void {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

/**
 * Make `name` a natively owned WhatsApp instance: ensure the `instances` row exists
 * with a transport UUID (an existing UUID, e.g. the Omni one, is kept so chats,
 * identities and sessions stay attached) and a `whatsapp` channel row binds it.
 * Existing instance settings are never overwritten. Emits `ravi.config.changed`
 * (the runner hot-adds the channel) and refreshes this process's config cache.
 */
export function createNativeWhatsAppInstance(
  name: string,
  options: CreateNativeWhatsAppInstanceOptions = {},
): NativeWhatsAppInstanceResult {
  const accountName = name.trim();
  if (!accountName) throw new Error("Instance name is required");

  let instance = dbGetInstance(accountName);
  if (instance && canonicalChannelId(instance.channel) !== WHATSAPP_PROVIDER) {
    throw new Error(`Instance "${accountName}" uses channel "${instance.channel}", not WhatsApp`);
  }

  const existingBinding = listNativeWhatsAppBindings(loadRouterConfig()).find(
    (binding) => binding.accountName === accountName,
  );

  let channel = existingBinding?.channel ?? dbGetChannel(accountName);
  if (!existingBinding && channel) {
    if (canonicalChannelId(channel.provider) !== WHATSAPP_PROVIDER) {
      throw new Error(`Channel "${accountName}" already exists with provider "${channel.provider}"`);
    }
    if (channel.enabled === false) {
      throw new Error(
        `Channel "${accountName}" is disabled; enable it with \`ravi channels set ${accountName} enabled true\``,
      );
    }
  }

  let createdInstance = false;
  let mintedInstanceId = false;
  if (!instance) {
    instance = dbUpsertInstance({
      name: accountName,
      instanceId: randomUUID(),
      channel: WHATSAPP_PROVIDER,
      ...(options.agent ? { agent: options.agent } : {}),
    });
    createdInstance = true;
    mintedInstanceId = true;
  } else if (!instance.instanceId?.trim()) {
    instance = dbUpdateInstance(accountName, { instanceId: randomUUID() });
    mintedInstanceId = true;
  }

  let createdChannel = false;
  if (!channel) {
    channel = dbUpsertChannel({ name: accountName, provider: WHATSAPP_PROVIDER });
    createdChannel = true;
  }

  if (createdInstance || mintedInstanceId || createdChannel) {
    (options.emitConfigChanged ?? defaultEmitConfigChanged)();
  }
  (options.refreshConfig ?? (() => configStore.refresh()))();

  const instanceId = instance.instanceId?.trim();
  if (!instanceId) throw new Error(`Instance "${accountName}" has no transport instance id`);
  log.info("Native WhatsApp instance ready", { accountName, instanceId, createdInstance, createdChannel });
  return { instanceId, instance, channel, createdInstance, mintedInstanceId, createdChannel };
}
