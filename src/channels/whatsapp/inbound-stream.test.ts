import { describe, expect, it } from "bun:test";
import type { JetStreamClient, JetStreamManager } from "nats";
import { CHANNEL_INBOUND_STREAM, CHANNEL_INBOUND_SUBJECT_FILTER, type WhatsAppTransportEvent } from "./contract.js";
import { ensureChannelInboundStream, publishChannelInboundEvent } from "./inbound-stream.js";

function fakeJsm(options: { exists: boolean; addFails?: boolean }) {
  const added: unknown[] = [];
  let exists = options.exists;
  const jsm = {
    streams: {
      async info(name: string) {
        if (!exists) throw new Error(`stream not found: ${name}`);
        return { config: { name } };
      },
      async add(config: unknown) {
        if (options.addFails) {
          exists = true;
          throw new Error("stream name already in use");
        }
        added.push(config);
        exists = true;
        return { config };
      },
    },
  };
  return { jsm: jsm as unknown as JetStreamManager, added };
}

describe("ensureChannelInboundStream", () => {
  it("creates the stream with the inbound filter when missing", async () => {
    const { jsm, added } = fakeJsm({ exists: false });
    await ensureChannelInboundStream(jsm);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: CHANNEL_INBOUND_STREAM, subjects: [CHANNEL_INBOUND_SUBJECT_FILTER] });
  });

  it("does nothing when the stream exists", async () => {
    const { jsm, added } = fakeJsm({ exists: true });
    await ensureChannelInboundStream(jsm);
    expect(added).toHaveLength(0);
  });

  it("tolerates a concurrent creator", async () => {
    const { jsm } = fakeJsm({ exists: false, addFails: true });
    await expect(ensureChannelInboundStream(jsm)).resolves.toBeUndefined();
  });
});

describe("publishChannelInboundEvent", () => {
  it("publishes on the prefixed Omni subject with the event id as msgID", async () => {
    const published: Array<{ subject: string; data: string; msgID?: string }> = [];
    const js = {
      async publish(subject: string, data: Uint8Array, opts?: { msgID?: string }) {
        published.push({ subject, data: new TextDecoder().decode(data), msgID: opts?.msgID });
        return { seq: 1, duplicate: false };
      },
    } as unknown as JetStreamClient;
    const event: WhatsAppTransportEvent = {
      id: "evt-1",
      type: "message.received",
      payload: { externalId: "ABC" },
      metadata: {
        instanceId: "0b7c3d1e-1111-4222-8333-944455556666",
        channelType: "whatsapp-baileys",
        source: "ravi.whatsapp.native",
        ingestMode: "realtime",
      },
      timestamp: 1,
    };

    await publishChannelInboundEvent(js, event);

    expect(published).toEqual([
      {
        subject: "ravi.channel.inbound.message.received.whatsapp-baileys.0b7c3d1e-1111-4222-8333-944455556666",
        data: JSON.stringify(event),
        msgID: "evt-1",
      },
    ]);
  });
});
