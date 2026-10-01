/**
 * The Baileys-loading half of the WhatsApp runtime.
 *
 * Every module re-exported here imports runtime values from `baileys`. The runtime
 * (`runtime.ts`) only holds a type reference to this file and loads it through its
 * injected `loadLibrary` dependency (default: a dynamic `import()`), so constructing
 * a runtime, reading its health, or building the CLI never evaluates Baileys.
 * Tests inject a library whose `createSocket` returns a fake socket.
 */

import { DisconnectReason } from "baileys";
import { clearAuthState, createStorageAuthState } from "./lib/auth.js";
import { setupAllEventHandlers } from "./lib/handlers/all-events.js";
import {
  cancelPendingReconnect,
  resetConnectionState,
  seedAuthenticated,
  setupConnectionHandlers,
} from "./lib/handlers/connection.js";
import { extractQuotedContext, setupMessageHandlers, tryDownloadMedia } from "./lib/handlers/messages.js";
import { closeSocket, createSocket } from "./lib/socket.js";
import { convertBufferForVoiceNote } from "./lib/utils/audio-converter.js";

export interface WhatsAppLibrary {
  createSocket: typeof createSocket;
  closeSocket: typeof closeSocket;
  createStorageAuthState: typeof createStorageAuthState;
  clearAuthState: typeof clearAuthState;
  setupConnectionHandlers: typeof setupConnectionHandlers;
  setupMessageHandlers: typeof setupMessageHandlers;
  setupAllEventHandlers: typeof setupAllEventHandlers;
  seedAuthenticated: typeof seedAuthenticated;
  cancelPendingReconnect: typeof cancelPendingReconnect;
  resetConnectionState: typeof resetConnectionState;
  tryDownloadMedia: typeof tryDownloadMedia;
  extractQuotedContext: typeof extractQuotedContext;
  convertBufferForVoiceNote: typeof convertBufferForVoiceNote;
  /** Baileys `DisconnectReason` status codes the runtime branches on. */
  disconnectReason: { loggedOut: number; connectionReplaced: number };
}

export const whatsappLibrary: WhatsAppLibrary = {
  createSocket,
  closeSocket,
  createStorageAuthState,
  clearAuthState,
  setupConnectionHandlers,
  setupMessageHandlers,
  setupAllEventHandlers,
  seedAuthenticated,
  cancelPendingReconnect,
  resetConnectionState,
  tryDownloadMedia,
  extractQuotedContext,
  convertBufferForVoiceNote,
  disconnectReason: {
    loggedOut: DisconnectReason.loggedOut,
    connectionReplaced: DisconnectReason.connectionReplaced,
  },
};

export async function loadWhatsAppLibrary(): Promise<WhatsAppLibrary> {
  return whatsappLibrary;
}
