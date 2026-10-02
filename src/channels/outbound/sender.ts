/**
 * Transport-neutral outbound sender contract.
 *
 * Implemented by the WhatsApp sender (runner RPC), the legacy bridge sender
 * (Telegram/Discord) and the per-instance router that picks between them. The
 * method shapes match the legacy bridge sender, so callers moved to this interface
 * mechanically.
 */

export interface ChannelUserMention {
  id: string;
  type: "user";
}

export interface ChannelSendOptions {
  threadId?: string;
  mentions?: ChannelUserMention[];
}

export interface ChannelSendResult {
  messageId?: string;
}

export type ChannelMediaType = "image" | "video" | "audio" | "document";

/** Instance-keyed sender. Method shapes deliberately match the legacy bridge sender. */
export interface ChannelMessageSender {
  send(instanceId: string, to: string, text: string, options?: ChannelSendOptions): Promise<ChannelSendResult>;
  /** Best-effort: never throws. active=false sends "paused". */
  sendTyping(instanceId: string, to: string, active?: boolean): Promise<void>;
  sendReaction(instanceId: string, to: string, messageId: string, emoji: string): Promise<void>;
  deleteMessage(instanceId: string, chatId: string, messageId: string): Promise<void>;
  editMessage(instanceId: string, chatId: string, messageId: string, text: string): Promise<void>;
  /** A relative `localPath` is resolved against process.cwd() (parity). The RPC then gets the absolute path. */
  sendMedia(
    instanceId: string,
    to: string,
    localPath: string,
    type: ChannelMediaType,
    filename: string,
    caption?: string,
    voiceNote?: boolean,
  ): Promise<ChannelSendResult>;
  sendSticker(instanceId: string, to: string, localPath: string): Promise<ChannelSendResult>;
  /** Best-effort: never throws. */
  markRead(instanceId: string, chatId: string, messageIds: string[]): Promise<void>;
}
