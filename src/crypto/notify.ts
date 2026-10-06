/**
 * Outbound side effects of the crypto service, behind an interface so the
 * service stays synchronous-ledger + testable:
 * - inform the originating session (the person who asked) via a session prompt
 * - publish `ravi.crypto.*` events for triggers / the crypto runner
 */

import { logger } from "../utils/logger.js";
import type { NotificationTarget } from "./types.js";

const log = logger.child("crypto:notify");

export interface CryptoNotifier {
  informSession(target: NotificationTarget | null, text: string): Promise<void>;
  publish(event: string, data: Record<string, unknown>): Promise<void>;
}

export const CRYPTO_TOPIC_PREFIX = "ravi.crypto";

class RuntimeNotifier implements CryptoNotifier {
  async informSession(target: NotificationTarget | null, text: string): Promise<void> {
    if (!target?.sessionName) return;
    try {
      const { publishSessionPrompt } = await import("../omni/session-stream.js");
      await publishSessionPrompt(target.sessionName, {
        prompt: `[System] Inform: [from: crypto] ${text}`,
        ...(target.source ? { source: target.source } : {}),
      });
    } catch (error) {
      log.warn("Failed to inform session", { sessionName: target.sessionName, error });
    }
  }

  async publish(event: string, data: Record<string, unknown>): Promise<void> {
    try {
      const { publish } = await import("../nats.js");
      await publish(`${CRYPTO_TOPIC_PREFIX}.${event}`, { event, ...data, timestamp: new Date().toISOString() });
    } catch (error) {
      log.warn("Failed to publish crypto event", { event, error });
    }
  }
}

export class RecordingNotifier implements CryptoNotifier {
  readonly informed: Array<{ target: NotificationTarget | null; text: string }> = [];
  readonly events: Array<{ event: string; data: Record<string, unknown> }> = [];

  async informSession(target: NotificationTarget | null, text: string): Promise<void> {
    this.informed.push({ target, text });
  }

  async publish(event: string, data: Record<string, unknown>): Promise<void> {
    this.events.push({ event, data });
  }
}

let override: CryptoNotifier | null = null;
const runtime = new RuntimeNotifier();

export function getCryptoNotifier(): CryptoNotifier {
  return override ?? runtime;
}

export function setCryptoNotifierForTest(notifier: CryptoNotifier | null): void {
  override = notifier;
}
