/**
 * Native WhatsApp transport contract.
 *
 * The native WhatsApp driver runs inside the `ravi channels` runner and owns the
 * Baileys socket. It is a drop-in replacement for the Omni WhatsApp bridge:
 *
 * - Inbound: the driver publishes the same event envelopes Omni publishes
 *   (`message.received`, `reaction.received`, `instance.*`) on the Ravi-owned
 *   `CHANNEL_INBOUND` JetStream stream, under `ravi.channel.inbound.<omni subject>`.
 *   The daemon's channel consumer (`src/omni/consumer.ts`) strips the prefix and
 *   runs the exact same pipeline it runs for Omni events, so session keys, chats,
 *   contacts and prompts stay identical.
 * - Outbound and control: callers keep using the Omni client surface. For an
 *   instance owned by a native WhatsApp channel, each client call becomes a NATS
 *   request on `_RAVI.channels.whatsapp.rpc.<instanceId>` that the runner answers.
 *
 * A native channel binds a Ravi instance by name: `ravi channels create <instance>
 * --provider whatsapp`. The instance keeps its `instances.instance_id` UUID, which
 * stays the transport instance id on every event and request.
 */

import { z } from "zod";
import type { ChannelConfig, InstanceConfig } from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import { canonicalChannelId } from "../capabilities.js";

export const WHATSAPP_PROVIDER = "whatsapp" as const;
/** Channel type carried on transport subjects and `MessageTarget.channel`, as Omni does. */
export const WHATSAPP_CHANNEL_TYPE = "whatsapp-baileys" as const;
export const WHATSAPP_DRIVER_ID = "ravi.whatsapp" as const;

export const CHANNEL_INBOUND_STREAM = "CHANNEL_INBOUND" as const;
export const CHANNEL_INBOUND_SUBJECT_PREFIX = "ravi.channel.inbound." as const;
export const CHANNEL_INBOUND_SUBJECT_FILTER = "ravi.channel.inbound.>" as const;

export const WHATSAPP_RPC_PROTOCOL = "ravi.channels.whatsapp.rpc" as const;
export const WHATSAPP_RPC_SCHEMA_VERSION = 1 as const;
export const WHATSAPP_RPC_SUBJECT_PREFIX = "_RAVI.channels.whatsapp.rpc." as const;
export const WHATSAPP_RPC_QUEUE = "ravi-whatsapp-rpc" as const;
export const DEFAULT_WHATSAPP_RPC_TIMEOUT_MS = 60_000;

export type WhatsAppIngestMode = "realtime" | "history-sync";

const InstanceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/, "instance id must be a NATS-safe token");

export function whatsappRpcSubject(instanceId: string): string {
  return `${WHATSAPP_RPC_SUBJECT_PREFIX}${InstanceIdSchema.parse(instanceId)}`;
}

/** Omni-compatible transport subject, e.g. `message.received.whatsapp-baileys.<uuid>`. */
export function whatsappTransportSubject(eventType: string, instanceId: string): string {
  return `${eventType}.${WHATSAPP_CHANNEL_TYPE}.${InstanceIdSchema.parse(instanceId)}`;
}

export function channelInboundSubject(transportSubject: string): string {
  return `${CHANNEL_INBOUND_SUBJECT_PREFIX}${transportSubject}`;
}

/** Strip the Ravi inbound prefix, returning the Omni-compatible subject. */
export function transportSubjectFromChannelInbound(subject: string): string | null {
  if (!subject.startsWith(CHANNEL_INBOUND_SUBJECT_PREFIX)) return null;
  const rest = subject.slice(CHANNEL_INBOUND_SUBJECT_PREFIX.length);
  return rest.length > 0 ? rest : null;
}

// ============================================================================
// Inbound event envelope (Omni-compatible)
// ============================================================================

export const WhatsAppTransportEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown(),
  metadata: z.object({
    instanceId: z.string().min(1),
    channelType: z.literal(WHATSAPP_CHANNEL_TYPE),
    source: z.literal("ravi.whatsapp.native"),
    ingestMode: z.enum(["realtime", "history-sync"]).optional(),
    pluginReceivedAt: z.number().optional(),
    receivedAt: z.number().optional(),
  }),
  timestamp: z.number(),
});

export type WhatsAppTransportEvent = z.infer<typeof WhatsAppTransportEventSchema>;

// ============================================================================
// RPC
// ============================================================================

export const WHATSAPP_RPC_METHODS = [
  // Instance lifecycle
  "instances.status",
  "instances.connect",
  "instances.disconnect",
  "instances.logout",
  "instances.pairingCode",
  // Groups
  "instances.listGroups",
  "instances.createGroup",
  "instances.addGroupParticipants",
  "instances.updateGroupParticipants",
  "instances.getGroupInvite",
  "instances.revokeGroupInvite",
  "instances.joinGroup",
  "instances.leaveGroup",
  "instances.renameGroup",
  "instances.setGroupDescription",
  "instances.setGroupSettings",
  "groups.metadata",
  // Messages
  "messages.send",
  "messages.sendPresence",
  "messages.sendReaction",
  "messages.deleteChannel",
  "messages.editChannel",
  "messages.sendMedia",
  "messages.sendSticker",
  "messages.batchMarkRead",
] as const;

export const WhatsAppRpcMethodSchema = z.enum(WHATSAPP_RPC_METHODS);
export type WhatsAppRpcMethod = z.infer<typeof WhatsAppRpcMethodSchema>;

const JidLikeSchema = z.string().trim().min(1).max(512);
const MentionSchema = z.object({ id: z.string().min(1), type: z.literal("user") });

/** Params per method. `instanceId` is implied by the subject and never trusted from params. */
export const WhatsAppRpcParamsSchemas = {
  "instances.status": z.object({}).passthrough(),
  "instances.connect": z
    .object({
      forceNewQr: z.boolean().optional(),
      whatsapp: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  "instances.disconnect": z.object({}).passthrough(),
  "instances.logout": z.object({}).passthrough(),
  "instances.pairingCode": z.object({ phoneNumber: z.string().trim().min(8).max(32) }),
  "instances.listGroups": z
    .object({ limit: z.coerce.number().int().positive().max(5000).optional(), search: z.string().optional() })
    .passthrough(),
  "instances.createGroup": z.object({
    subject: z.string().trim().min(1).max(512),
    participants: z.array(JidLikeSchema).max(1024),
  }),
  "instances.addGroupParticipants": z.object({
    groupJid: JidLikeSchema,
    participants: z.array(JidLikeSchema).min(1).max(1024),
  }),
  "instances.updateGroupParticipants": z.object({
    groupJid: JidLikeSchema,
    action: z.enum(["remove", "promote", "demote"]),
    participants: z.array(JidLikeSchema).min(1).max(1024),
  }),
  "instances.getGroupInvite": z.object({ groupJid: JidLikeSchema }),
  "instances.revokeGroupInvite": z.object({ groupJid: JidLikeSchema }),
  "instances.joinGroup": z.object({ code: z.string().trim().min(1).max(512) }),
  "instances.leaveGroup": z.object({ groupJid: JidLikeSchema }),
  "instances.renameGroup": z.object({ groupJid: JidLikeSchema, subject: z.string().trim().min(1).max(512) }),
  "instances.setGroupDescription": z.object({ groupJid: JidLikeSchema, description: z.string().max(4096) }),
  "instances.setGroupSettings": z.object({ groupJid: JidLikeSchema, setting: z.string().trim().min(1).max(64) }),
  "groups.metadata": z.object({ groupJid: JidLikeSchema, maxAgeMs: z.number().int().nonnegative().optional() }),
  "messages.send": z
    .object({
      to: JidLikeSchema,
      text: z.string(),
      threadId: z.string().optional(),
      mentions: z.array(MentionSchema).optional(),
      replyTo: z.string().optional(),
    })
    .passthrough(),
  "messages.sendPresence": z
    .object({
      to: JidLikeSchema,
      type: z.enum(["typing", "recording", "paused", "available", "unavailable"]),
      duration: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  "messages.sendReaction": z
    .object({
      to: JidLikeSchema,
      messageId: z.string().min(1),
      emoji: z.string(),
      fromMe: z.boolean().optional(),
      participant: z.string().optional(),
    })
    .passthrough(),
  "messages.deleteChannel": z.object({ channelId: JidLikeSchema, messageId: z.string().min(1) }).passthrough(),
  "messages.editChannel": z
    .object({ channelId: JidLikeSchema, messageId: z.string().min(1), text: z.string().min(1) })
    .passthrough(),
  "messages.sendMedia": z
    .object({
      to: JidLikeSchema,
      type: z.enum(["image", "video", "audio", "document"]),
      /** Absolute path readable by the runner (same host). Preferred over base64. */
      filePath: z.string().optional(),
      base64: z.string().optional(),
      filename: z.string().optional(),
      mimeType: z.string().optional(),
      caption: z.string().optional(),
      voiceNote: z.boolean().optional(),
    })
    .passthrough()
    .refine((value) => Boolean(value.filePath || value.base64), "filePath or base64 is required"),
  "messages.sendSticker": z
    .object({ to: JidLikeSchema, filePath: z.string().optional(), base64: z.string().optional() })
    .passthrough()
    .refine((value) => Boolean(value.filePath || value.base64), "filePath or base64 is required"),
  "messages.batchMarkRead": z
    .object({ chatId: JidLikeSchema, messageIds: z.array(z.string().min(1)).min(1).max(500) })
    .passthrough(),
} satisfies Record<WhatsAppRpcMethod, z.ZodType>;

export type WhatsAppRpcParams<M extends WhatsAppRpcMethod> = z.infer<(typeof WhatsAppRpcParamsSchemas)[M]>;

export const WhatsAppRpcRequestSchema = z.object({
  protocol: z.literal(WHATSAPP_RPC_PROTOCOL),
  schemaVersion: z.literal(WHATSAPP_RPC_SCHEMA_VERSION),
  requestId: z.string().min(1).max(128),
  instanceId: InstanceIdSchema,
  method: WhatsAppRpcMethodSchema,
  params: z.unknown(),
});

export type WhatsAppRpcRequest = z.infer<typeof WhatsAppRpcRequestSchema>;

export const WhatsAppRpcErrorSchema = z.object({
  message: z.string(),
  /** HTTP-like status so Omni-style retry logic keeps working (5xx = retryable). */
  status: z.number().int(),
  code: z.string(),
});

export type WhatsAppRpcError = z.infer<typeof WhatsAppRpcErrorSchema>;

export const WhatsAppRpcResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), requestId: z.string(), data: z.unknown() }),
  z.object({ ok: z.literal(false), requestId: z.string(), error: WhatsAppRpcErrorSchema }),
]);

export type WhatsAppRpcResponse = z.infer<typeof WhatsAppRpcResponseSchema>;

// ============================================================================
// Native ownership
// ============================================================================

export interface NativeWhatsAppBinding {
  /** Ravi account / instance name. */
  readonly accountName: string;
  /** Transport instance id (the instance UUID). */
  readonly instanceId: string;
  readonly channel: ChannelConfig;
  readonly instance: InstanceConfig;
}

type OwnershipConfig = Pick<RouterConfig, "instances" | "channels" | "instanceToAccount">;

function boundInstanceName(channel: ChannelConfig): string {
  const override = channel.defaults?.instance;
  return typeof override === "string" && override.trim() ? override.trim() : channel.name;
}

/** Every enabled native WhatsApp channel that is bound to an instance with a transport id. */
export function listNativeWhatsAppBindings(config: OwnershipConfig): NativeWhatsAppBinding[] {
  const bindings: NativeWhatsAppBinding[] = [];
  for (const channel of Object.values(config.channels ?? {})) {
    if (channel.enabled === false || channel.deletedAt) continue;
    if (canonicalChannelId(channel.provider) !== WHATSAPP_PROVIDER) continue;
    const accountName = boundInstanceName(channel);
    const instance = config.instances?.[accountName];
    const instanceId = instance?.instanceId?.trim();
    if (!instance || !instanceId || instance.deletedAt) continue;
    bindings.push({ accountName, instanceId, channel, instance });
  }
  return bindings;
}

/** Resolve a native WhatsApp binding from an instance UUID or account name. */
export function resolveNativeWhatsAppBinding(
  config: OwnershipConfig,
  instanceIdOrAccount: string | undefined | null,
): NativeWhatsAppBinding | null {
  const ref = instanceIdOrAccount?.trim();
  if (!ref) return null;
  const accountName = config.instanceToAccount?.[ref] ?? ref;
  return (
    listNativeWhatsAppBindings(config).find(
      (binding) => binding.instanceId === ref || binding.accountName === accountName,
    ) ?? null
  );
}

export function isNativeWhatsAppInstance(config: OwnershipConfig, instanceIdOrAccount: string | undefined | null) {
  return resolveNativeWhatsAppBinding(config, instanceIdOrAccount) !== null;
}
