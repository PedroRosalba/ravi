/**
 * Omni Sender
 *
 * Sends messages, typing indicators, reactions, and media through an Omni-shaped
 * client: the Omni REST API directly (`new OmniSender(apiUrl, apiKey)`), or the
 * routing transport client that also reaches native WhatsApp instances
 * (`new OmniSender(createChannelTransportClient(...))`).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChannelTransportClient, NativeWhatsAppTransport } from "../channels/whatsapp/transport-client.js";
import { createOmniClient, type OmniClient } from "./client.js";
import { logger } from "../utils/logger.js";
import type { OmniUserMention } from "./mentions.js";

const log = logger.child("omni:sender");

const MAX_RETRIES = 3;

/**
 * 5xx codes that retrying cannot fix. `OMNI_NOT_CONFIGURED` (503, from the routing
 * client, `OMNI_NOT_CONFIGURED_CODE` in channels/whatsapp/transport-client.ts) means the
 * instance is neither native nor reachable through a configured Omni.
 */
const NON_RETRYABLE_CODES = new Set(["OMNI_NOT_CONFIGURED"]);

/**
 * Determine if an error is retryable (network/server errors, not client errors).
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch network error (ECONNREFUSED etc.)
  if (err && typeof err === "object" && "code" in err && NON_RETRYABLE_CODES.has(String(err.code))) return false;
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: number }).status;
    return status >= 500; // Only retry 5xx, not 4xx
  }
  return false; // Don't retry unknown errors (could be application bugs)
}

function isChannelTransportClient(client: OmniClient | ChannelTransportClient): client is ChannelTransportClient {
  return "native" in client && typeof client.native?.isNativeInstance === "function";
}

export class OmniSender {
  private client: OmniClient | ChannelTransportClient;

  /** Omni REST sender (legacy form). */
  constructor(apiUrl: string, apiKey: string);
  /** Sender over an existing Omni-shaped client (e.g. the routing transport client). */
  constructor(client: OmniClient | ChannelTransportClient);
  constructor(apiUrlOrClient: string | OmniClient | ChannelTransportClient, apiKey?: string) {
    if (typeof apiUrlOrClient === "string") {
      if (apiKey === undefined) throw new TypeError("OmniSender(apiUrl, apiKey) requires an apiKey");
      this.client = createOmniClient({ baseUrl: apiUrlOrClient, apiKey });
    } else {
      this.client = apiUrlOrClient;
    }
  }

  /**
   * Native WhatsApp transport of the routing client, or null for a plain Omni client.
   * Callers use it for calls with no Omni equivalent (e.g. `groups.metadata`).
   */
  getNativeWhatsApp(): NativeWhatsAppTransport | null {
    return isChannelTransportClient(this.client) ? this.client.native : null;
  }

  /**
   * Native WhatsApp runners read media straight from `filePath` (same host), so the
   * file is only base64-encoded for Omni targets.
   */
  private needsBase64(instanceId: string): boolean {
    return !(isChannelTransportClient(this.client) && this.client.native.isNativeInstance(instanceId));
  }

  private mediaSource(instanceId: string, localPath: string): { filePath: string; base64?: string } {
    const filePath = resolve(localPath);
    if (!this.needsBase64(instanceId)) return { filePath };
    return { filePath, base64: readFileSync(filePath).toString("base64") };
  }

  /**
   * Retry wrapper with exponential backoff.
   */
  private async withRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES && isRetryable(err)) {
          const delayMs = attempt * 1000;
          log.warn(`${context} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs}ms`, { error: err });
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          break;
        }
      }
    }
    throw lastError;
  }

  /**
   * Send a text message via omni.
   */
  async send(
    instanceId: string,
    to: string,
    text: string,
    optionsOrThreadId?: string | { threadId?: string; mentions?: OmniUserMention[] },
  ): Promise<{ messageId?: string }> {
    try {
      const options =
        typeof optionsOrThreadId === "string" ? { threadId: optionsOrThreadId } : (optionsOrThreadId ?? {});
      const result = (await this.withRetry(
        () =>
          this.client.messages.send({
            instanceId,
            to,
            text,
            ...(options.threadId ? { threadId: options.threadId } : {}),
            ...(options.mentions?.length ? { mentions: options.mentions } : {}),
          }),
        `send(${instanceId})`,
      )) as { messageId?: string };
      return { messageId: result.messageId };
    } catch (err) {
      log.error("Failed to send message", { instanceId, to, error: err });
      throw err;
    }
  }

  /**
   * Send a typing presence indicator.
   * @param active - true = start typing, false = stop (paused)
   */
  async sendTyping(instanceId: string, to: string, active = true): Promise<void> {
    try {
      await this.client.messages.sendPresence({
        instanceId,
        to,
        type: active ? "typing" : "paused",
        duration: active ? 30_000 : 0,
      });
    } catch (err) {
      // Typing indicators are best-effort — don't throw
      log.debug("Failed to send typing indicator", { instanceId, to, active, error: err });
    }
  }

  /**
   * Send an emoji reaction to a message.
   */
  async sendReaction(instanceId: string, to: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.withRetry(
        () => this.client.messages.sendReaction({ instanceId, to, messageId, emoji }),
        `sendReaction(${instanceId})`,
      );
    } catch (err) {
      log.error("Failed to send reaction", { instanceId, to, messageId, emoji, error: err });
      throw err;
    }
  }

  /**
   * Delete a channel message sent by the current instance.
   */
  async deleteMessage(instanceId: string, to: string, messageId: string): Promise<void> {
    try {
      await this.withRetry(
        () => this.client.messages.deleteChannel({ instanceId, channelId: to, messageId }),
        `deleteMessage(${instanceId})`,
      );
    } catch (err) {
      log.error("Failed to delete message", { instanceId, to, messageId, error: err });
      throw err;
    }
  }

  /**
   * Edit a channel message sent by the current instance.
   */
  async editMessage(instanceId: string, to: string, messageId: string, text: string): Promise<void> {
    try {
      await this.withRetry(
        () => this.client.messages.editChannel({ instanceId, channelId: to, messageId, text }),
        `editMessage(${instanceId})`,
      );
    } catch (err) {
      log.error("Failed to edit message", { instanceId, to, messageId, error: err });
      throw err;
    }
  }

  /**
   * Send a media file (image, video, document, audio).
   * Always passes the absolute `filePath` (Omni ignores it); adds base64 unless the
   * target is a native WhatsApp instance.
   */
  async sendMedia(
    instanceId: string,
    to: string,
    localPath: string,
    type: "image" | "video" | "audio" | "document",
    filename: string,
    caption?: string,
    voiceNote?: boolean,
  ): Promise<{ messageId?: string }> {
    try {
      const result = await this.client.messages.sendMedia({
        instanceId,
        to,
        type,
        ...this.mediaSource(instanceId, localPath),
        filename,
        caption,
        ...(voiceNote ? { voiceNote: true } : {}),
      });
      return { messageId: result.messageId };
    } catch (err) {
      log.error("Failed to send media", { instanceId, to, localPath, type, error: err });
      throw err;
    }
  }

  /**
   * Send a WhatsApp sticker.
   *
   * Omni exposes stickers as a dedicated contract instead of generic media.
   * Using /messages/send/media with type=sticker returns 400 on WhatsApp.
   */
  async sendSticker(instanceId: string, to: string, localPath: string): Promise<{ messageId?: string }> {
    try {
      const result = await this.client.messages.sendSticker({
        instanceId,
        to,
        ...this.mediaSource(instanceId, localPath),
      });
      return { messageId: result.messageId };
    } catch (err) {
      log.error("Failed to send sticker", { instanceId, to, localPath, error: err });
      throw err;
    }
  }

  /**
   * Mark messages as read in a chat.
   */
  async markRead(instanceId: string, chatId: string, messageIds: string[]): Promise<void> {
    try {
      await this.client.messages.batchMarkRead({
        instanceId,
        chatId,
        messageIds,
      });
    } catch (err) {
      // Best-effort — don't throw
      log.debug("Failed to mark messages as read", { instanceId, chatId, error: err });
    }
  }

  /**
   * Get the underlying omni client for advanced operations (CLI commands).
   */
  getClient(): OmniClient {
    return this.client;
  }
}
