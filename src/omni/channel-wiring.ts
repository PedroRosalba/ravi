/**
 * Daemon channel wiring: one routing transport client, one sender and one consumer
 * for every bridge-compatible channel transport.
 *
 * - The routing client sends calls for natively-owned WhatsApp instances to the
 *   `ravi channels` runner over NATS RPC and everything else to Omni (when configured).
 * - The consumer always reads the native CHANNEL_INBOUND source; the Omni streams are
 *   added only when Omni is configured. Native WhatsApp therefore works with no Omni.
 */

import {
  createChannelTransportClient,
  type ChannelTransportClient,
  type ChannelTransportClientOptions,
} from "../channels/whatsapp/transport-client.js";
import type { OmniConnection } from "../omni-config.js";
import { createOmniClient } from "./client.js";
import { OmniConsumer, type OmniConsumerOptions, type OmniConsumerSource } from "./consumer.js";
import { OmniSender } from "./sender.js";

export interface DaemonChannelWiringInput {
  /** Resolved Omni connection, or null when Omni is not configured. */
  omni: OmniConnection | null;
  consumer?: Pick<OmniConsumerOptions, "isRuntimeSessionActive" | "abortRuntimeSession">;
  /** Test seam: extra routing-client options (config source, NATS connection). */
  transport?: Omit<ChannelTransportClientOptions, "omni">;
}

export interface DaemonChannelWiring {
  client: ChannelTransportClient;
  sender: OmniSender;
  consumer: OmniConsumer;
  sources: OmniConsumerSource[];
}

export function consumerSourcesFor(omni: OmniConnection | null): OmniConsumerSource[] {
  return omni ? ["native", "omni"] : ["native"];
}

export function createDaemonChannelWiring(input: DaemonChannelWiringInput): DaemonChannelWiring {
  const omniClient = input.omni ? createOmniClient({ baseUrl: input.omni.apiUrl, apiKey: input.omni.apiKey }) : null;
  const client = createChannelTransportClient({ ...input.transport, omni: omniClient });
  const sender = new OmniSender(client);
  const sources = consumerSourcesFor(input.omni);
  const consumer = new OmniConsumer(sender, input.omni?.apiUrl ?? null, input.omni?.apiKey ?? null, {
    ...input.consumer,
    sources,
    nativeWhatsApp: client.native,
  });
  return { client, sender, consumer, sources };
}
