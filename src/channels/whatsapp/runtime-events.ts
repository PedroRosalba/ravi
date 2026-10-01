/**
 * Omni-compatible transport envelopes and payloads built by `WhatsAppNativeRuntime`.
 *
 * Payload shapes are copied field by field from Omni's `BaseChannelPlugin` emitters
 * (`emitMessageReceived`, `emitReactionReceived/Removed`, `emitQrCode`,
 * `emitInstanceConnected/Disconnected`, receipts) and the WhatsApp plugin call sites,
 * so the daemon's consumer reads exactly what it reads from Omni. Only the envelope
 * metadata differs (`source: "ravi.whatsapp.native"`, see contract.ts).
 *
 * Event ids for `message.received` and reactions are derived from Omni's ingress
 * idempotency key (`whatsapp-baileys:{instance}:{externalId}:{kind}`), so a redelivered
 * Baileys upsert republishes the same JetStream `msgID` and collapses in the stream's
 * duplicate window, the way Omni's claim table collapsed it.
 */

import { createHash, randomUUID } from "node:crypto";
import { WHATSAPP_CHANNEL_TYPE, type WhatsAppIngestMode, type WhatsAppTransportEvent } from "./contract.js";

export const WHATSAPP_NATIVE_EVENT_SOURCE = "ravi.whatsapp.native" as const;

/** Event types the daemon consumer reads (`src/omni/consumer.ts` subscriptions). */
export const DEFAULT_PUBLISHED_EVENT_TYPES: readonly string[] = [
  "message.received",
  "reaction.received",
  "instance.qr_code",
  "instance.connected",
  "instance.disconnected",
];

/** UUID-formatted sha256 of `key` (stable across processes and restarts). */
export function deterministicEventId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Omni `emitMessageReceived` idempotency key. */
export function messageIdempotencyKey(instanceId: string, externalId: string, contentType: string): string {
  return `${WHATSAPP_CHANNEL_TYPE}:${instanceId}:${externalId}:${contentType}`;
}

/** Omni `reactionClaimParams` idempotency key. */
export function reactionIdempotencyKey(
  instanceId: string,
  kind: "reaction.received" | "reaction.removed",
  payload: ReactionPayload,
): string {
  const raw = payload.rawPayload?.externalId;
  const externalId = typeof raw === "string" && raw.length > 0 ? raw : `${payload.messageId}:${payload.from}`;
  return `${WHATSAPP_CHANNEL_TYPE}:${instanceId}:${externalId}:${kind}:${payload.emoji}`;
}

export interface TransportEnvelopeInput {
  type: string;
  instanceId: string;
  payload: unknown;
  now: number;
  id?: string;
  ingestMode?: WhatsAppIngestMode;
  pluginReceivedAt?: number;
}

export function buildTransportEvent(input: TransportEnvelopeInput): WhatsAppTransportEvent {
  return {
    id: input.id ?? randomUUID(),
    type: input.type,
    payload: input.payload,
    metadata: {
      instanceId: input.instanceId,
      channelType: WHATSAPP_CHANNEL_TYPE,
      source: WHATSAPP_NATIVE_EVENT_SOURCE,
      ...(input.ingestMode ? { ingestMode: input.ingestMode } : {}),
      ...(input.pluginReceivedAt !== undefined ? { pluginReceivedAt: input.pluginReceivedAt } : {}),
      receivedAt: input.now,
    },
    timestamp: input.now,
  };
}

// ============================================================================
// Payloads (Omni field order; undefined members vanish in JSON like Omni's)
// ============================================================================

export interface MessageReceivedContent {
  type: string;
  text?: string;
  mediaUrl?: string;
  mimeType?: string;
  /** Absolute path of the downloaded inbound media (ravi addition; `mediaUrl` is its `file://` URL). */
  localPath?: string;
}

export interface MessageReceivedPayload {
  externalId: string;
  chatId: string;
  /** Bare sender id (`fromJid(jid).id`), exactly as Omni emits it. */
  from: string;
  senderName?: string;
  chatName?: string;
  content: MessageReceivedContent;
  replyToId?: string;
  senderInstanceId?: string;
  rawPayload?: Record<string, unknown>;
}

export function messageReceivedPayload(input: MessageReceivedPayload): MessageReceivedPayload {
  return {
    externalId: input.externalId,
    chatId: input.chatId,
    from: input.from,
    senderName: input.senderName,
    chatName: input.chatName,
    content: {
      type: input.content.type,
      text: input.content.text,
      mediaUrl: input.content.mediaUrl,
      mimeType: input.content.mimeType,
      ...(input.content.localPath ? { localPath: input.content.localPath } : {}),
    },
    replyToId: input.replyToId,
    senderInstanceId: input.senderInstanceId,
    rawPayload: input.rawPayload,
  };
}

export interface ReactionPayload {
  messageId: string;
  chatId: string;
  from: string;
  emoji: string;
  rawPayload?: Record<string, unknown>;
}

export function qrCodePayload(instanceId: string, qrCode: string, expiresAt: Date) {
  return { instanceId, channelType: WHATSAPP_CHANNEL_TYPE, qrCode, expiresAt: expiresAt.getTime() };
}

export interface InstanceConnectedInfo {
  profileName?: string;
  profilePicUrl?: string;
  ownerIdentifier?: string;
  isNewLogin?: boolean;
}

export function instanceConnectedPayload(instanceId: string, info: InstanceConnectedInfo) {
  return {
    instanceId,
    channelType: WHATSAPP_CHANNEL_TYPE,
    profileName: info.profileName,
    profilePicUrl: info.profilePicUrl,
    ownerIdentifier: info.ownerIdentifier,
    ...(info.isNewLogin ? { isNewLogin: true } : {}),
  };
}

export function instanceDisconnectedPayload(instanceId: string, reason: string | undefined, willReconnect: boolean) {
  return { instanceId, channelType: WHATSAPP_CHANNEL_TYPE, reason, willReconnect };
}
