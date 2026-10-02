/**
 * Headless presence surface used when no inbound pipeline runs.
 *
 * Presence and delivery degrade to no-ops. These methods are part of the
 * gateway typing/presence surface and must never throw.
 *
 * @deprecated Use `createNoopPresenceTargets()` (`src/channels/inbound/presence-targets.ts`).
 * Deleted by WP-Z together with its test.
 */
import type { ChannelPresenceTargets } from "../channels/inbound/types.js";

/** Public consumer methods the daemon and gateway may call without an inbound pipeline. */
export type OmniConsumerStubSurface = ChannelPresenceTargets & {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createStubOmniConsumer(): OmniConsumerStubSurface {
  return {
    start: async () => {},
    stop: async () => {},
    getActiveTarget: () => undefined,
    clearActiveTarget: async () => {},
    renewActiveTarget: async () => false,
  };
}
