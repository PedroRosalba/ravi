/**
 * CHANNEL_INBOUND JetStream stream shared by the native WhatsApp runtime (publisher,
 * in the `ravi channels` runner) and the daemon's OmniConsumer (reader).
 *
 * Both sides call `ensureChannelInboundStream()` so whichever starts first creates it
 * with the same configuration.
 */

import { RetentionPolicy, StringCodec, type JetStreamClient, type JetStreamManager } from "nats";
import { getNats } from "../../nats.js";
import { logger } from "../../utils/logger.js";
import {
  CHANNEL_INBOUND_STREAM,
  CHANNEL_INBOUND_SUBJECT_FILTER,
  channelInboundSubject,
  whatsappTransportSubject,
  type WhatsAppTransportEvent,
} from "./contract.js";

const log = logger.child("channels:inbound-stream");
const sc = StringCodec();

const MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
const MAX_BYTES = 512 * 1024 * 1024;
/** JetStream dedupe window for `msgID` (redelivered Baileys upserts collapse here). */
const DUPLICATE_WINDOW_NS = 2 * 60 * 1_000_000_000;

export async function ensureChannelInboundStream(existingJsm?: JetStreamManager): Promise<void> {
  const jsm = existingJsm ?? (await getNats().jetstreamManager());

  try {
    await jsm.streams.info(CHANNEL_INBOUND_STREAM);
    return;
  } catch {
    // Stream does not exist yet.
  }

  try {
    await jsm.streams.add({
      name: CHANNEL_INBOUND_STREAM,
      description: "Native channel transport events (Omni-compatible envelopes)",
      subjects: [CHANNEL_INBOUND_SUBJECT_FILTER],
      retention: RetentionPolicy.Limits,
      storage: "file" as never,
      max_age: MAX_AGE_NS,
      max_bytes: MAX_BYTES,
      duplicate_window: DUPLICATE_WINDOW_NS,
      num_replicas: 1,
    });
  } catch (err) {
    try {
      await jsm.streams.info(CHANNEL_INBOUND_STREAM);
      return;
    } catch {
      throw err;
    }
  }

  log.info("Created CHANNEL_INBOUND JetStream stream", {
    subjects: [CHANNEL_INBOUND_SUBJECT_FILTER],
    retention: "limits",
    max_age_days: 7,
    max_bytes: MAX_BYTES,
  });
}

/**
 * Publish one transport event. The subject is derived from the event (type + instance),
 * and `event.id` is the JetStream `msgID`, so republishing the same event inside the
 * duplicate window is a no-op.
 */
export async function publishChannelInboundEvent(js: JetStreamClient, event: WhatsAppTransportEvent): Promise<void> {
  const subject = channelInboundSubject(whatsappTransportSubject(event.type, event.metadata.instanceId));
  await js.publish(subject, sc.encode(JSON.stringify(event)), { msgID: event.id });
}
