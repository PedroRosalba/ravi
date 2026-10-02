/**
 * INTERIM daemon channel wiring (WP-A tasks 1-3). Replaced by `src/daemon-channels.ts`
 * (`createDaemonChannels`, WP-A task 4), which also deletes this file.
 *
 * - Outbound is unchanged: one routing transport client (WhatsApp runner RPC for bound
 *   WhatsApp instances, Omni otherwise) behind `OmniSender`.
 * - Inbound is the new shape: one `ChannelInboundPipeline` shared by the WhatsApp runner
 *   source and, when Omni is configured, the legacy bridge source. Sources start in parallel.
 */

import { ChannelInboundPipeline, type ChannelInboundPipelineOptions } from "../channels/inbound/pipeline.js";
import type { ChannelInboundSource } from "../channels/inbound/types.js";
import { createWhatsAppClient, type CreateWhatsAppClientOptions } from "../channels/whatsapp/client.js";
import { WhatsAppInboundSource, type WhatsAppInboundSourceOptions } from "../channels/whatsapp/inbound-source.js";
import {
  createChannelTransportClient,
  type ChannelTransportClient,
  type ChannelTransportClientOptions,
} from "../channels/whatsapp/transport-client.js";
import type { OmniConnection } from "../omni-config.js";
import { logger } from "../utils/logger.js";
import { createOmniClient } from "./client.js";
import { OmniLegacyInboundSource } from "./inbound-source.js";
import { OmniSender } from "./sender.js";

const log = logger.child("omni:channel-wiring");

export interface DaemonChannelWiringInput {
  /** Resolved Omni connection, or null when Omni is not configured. */
  omni: OmniConnection | null;
  pipeline?: Pick<ChannelInboundPipelineOptions, "isRuntimeSessionActive" | "abortRuntimeSession">;
  /** Test seam: extra routing-client options (config source, NATS connection). */
  transport?: Omit<ChannelTransportClientOptions, "omni">;
  /** Test seam: WhatsApp RPC client options (group metadata refresh). */
  whatsappClient?: CreateWhatsAppClientOptions;
  /** Test seam: NATS connection for both inbound sources. */
  natsConnection?: WhatsAppInboundSourceOptions["natsConnection"];
}

export interface DaemonChannelWiring {
  client: ChannelTransportClient;
  sender: OmniSender;
  pipeline: ChannelInboundPipeline;
  sources: ChannelInboundSource[];
  /** Starts every source in parallel; a failing source is logged and does not stop the others. */
  start(): Promise<void>;
  /** Stops the sources, then the pipeline. */
  stop(): Promise<void>;
}

export function createDaemonChannelWiring(input: DaemonChannelWiringInput): DaemonChannelWiring {
  const omniClient = input.omni ? createOmniClient({ baseUrl: input.omni.apiUrl, apiKey: input.omni.apiKey }) : null;
  const client = createChannelTransportClient({ ...input.transport, omni: omniClient });
  const sender = new OmniSender(client);
  const pipeline = new ChannelInboundPipeline(sender, { ...input.pipeline });
  const sources: ChannelInboundSource[] = [
    new WhatsAppInboundSource(pipeline, {
      client: createWhatsAppClient(input.whatsappClient),
      natsConnection: input.natsConnection,
    }),
  ];
  if (input.omni) {
    sources.push(
      new OmniLegacyInboundSource(pipeline, {
        apiUrl: input.omni.apiUrl,
        apiKey: input.omni.apiKey,
        natsConnection: input.natsConnection,
      }),
    );
  }

  return {
    client,
    sender,
    pipeline,
    sources,
    async start() {
      const results = await Promise.allSettled(sources.map((source) => source.start()));
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          log.error("Failed to start inbound source", { source: sources[index]?.id, error: result.reason });
        }
      });
    },
    async stop() {
      await Promise.allSettled(sources.map((source) => source.stop()));
      await pipeline.stop();
    },
  };
}
