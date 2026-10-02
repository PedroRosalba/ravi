import { describe, expect, it } from "bun:test";
import { AckPolicy, DeliverPolicy, type JetStreamClient, type JetStreamManager } from "nats";
import { CHANNEL_INBOUND_STREAM, CHANNEL_INBOUND_SUBJECT_FILTER, type WhatsAppTransportEvent } from "./contract.js";
import { WHATSAPP_INBOUND_DURABLES } from "./events.js";
import {
  ensureChannelInboundStream,
  ensureWhatsAppInboundDurables,
  publishChannelInboundEvent,
} from "./inbound-stream.js";

interface FakeConsumersOptions {
  existing?: string[];
  /** Durables whose `add` fails (and that never appear). */
  failing?: string[];
  /** Durables whose `add` fails because a concurrent creator just made them. */
  racing?: string[];
}

function fakeConsumers(options: FakeConsumersOptions = {}) {
  const present = new Set(options.existing ?? []);
  const added: Array<{ stream: string; config: Record<string, unknown> }> = [];
  const mutations: string[] = [];
  const consumers = {
    async info(stream: string, name: string) {
      if (!present.has(name)) throw new Error(`consumer not found: ${stream}/${name}`);
      return { name, stream_name: stream };
    },
    async add(stream: string, config: Record<string, unknown>) {
      const name = String(config.durable_name);
      if (options.racing?.includes(name)) {
        present.add(name);
        throw new Error("consumer name already in use");
      }
      if (options.failing?.includes(name)) throw new Error("jetstream unavailable");
      added.push({ stream, config });
      present.add(name);
      return { name, stream_name: stream };
    },
    async update(_stream: string, name: string) {
      mutations.push(`update:${name}`);
      throw new Error("must not update");
    },
    async delete(_stream: string, name: string) {
      mutations.push(`delete:${name}`);
      throw new Error("must not delete");
    },
  };
  return { consumers, added, mutations };
}

function fakeJsm(options: { exists: boolean; addFails?: boolean; consumers?: FakeConsumersOptions }) {
  const added: unknown[] = [];
  let exists = options.exists;
  const consumerFake = fakeConsumers(options.consumers);
  const jsm = {
    consumers: consumerFake.consumers,
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
  return { jsm: jsm as unknown as JetStreamManager, added, durablesAdded: consumerFake.added };
}

const EXPECTED_DURABLES = Object.values(WHATSAPP_INBOUND_DURABLES).map((durable) => ({
  stream: CHANNEL_INBOUND_STREAM,
  config: {
    durable_name: durable.durable,
    filter_subject: durable.filterSubject,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
  },
}));

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

describe("ensureChannelInboundStream durables", () => {
  it("creates the WhatsApp inbound durables with the stream", async () => {
    const { jsm, durablesAdded } = fakeJsm({ exists: false });
    await ensureChannelInboundStream(jsm);
    expect(durablesAdded).toEqual(EXPECTED_DURABLES);
  });

  it("creates them when the stream already existed", async () => {
    const { jsm, durablesAdded } = fakeJsm({ exists: true });
    await ensureChannelInboundStream(jsm);
    expect(durablesAdded).toEqual(EXPECTED_DURABLES);
  });

  it("creates them when a concurrent creator made the stream", async () => {
    const { jsm, durablesAdded } = fakeJsm({ exists: false, addFails: true });
    await ensureChannelInboundStream(jsm);
    expect(durablesAdded).toEqual(EXPECTED_DURABLES);
  });
});

describe("ensureWhatsAppInboundDurables", () => {
  it("creates the 3 durables when missing, with the pull loop's exact config", async () => {
    const { consumers, added } = fakeConsumers();
    await ensureWhatsAppInboundDurables({ consumers } as unknown as JetStreamManager);
    expect(added).toEqual(EXPECTED_DURABLES);
    expect(added.map((entry) => entry.config.durable_name)).toEqual([
      "ravi-whatsapp-messages",
      "ravi-whatsapp-reactions",
      "ravi-whatsapp-connection",
    ]);
  });

  it("leaves existing durables untouched", async () => {
    const { consumers, added, mutations } = fakeConsumers({
      existing: ["ravi-whatsapp-messages", "ravi-whatsapp-connection"],
    });
    await ensureWhatsAppInboundDurables({ consumers } as unknown as JetStreamManager);
    expect(added.map((entry) => entry.config.durable_name)).toEqual(["ravi-whatsapp-reactions"]);
    expect(mutations).toEqual([]);
  });

  it("keeps going when one durable fails, without throwing", async () => {
    const { consumers, added } = fakeConsumers({ failing: ["ravi-whatsapp-messages"] });
    await expect(ensureWhatsAppInboundDurables({ consumers } as unknown as JetStreamManager)).resolves.toBeUndefined();
    expect(added.map((entry) => entry.config.durable_name)).toEqual([
      "ravi-whatsapp-reactions",
      "ravi-whatsapp-connection",
    ]);
  });

  it("accepts a durable a concurrent creator made", async () => {
    const { consumers, added } = fakeConsumers({ racing: ["ravi-whatsapp-reactions"] });
    await expect(ensureWhatsAppInboundDurables({ consumers } as unknown as JetStreamManager)).resolves.toBeUndefined();
    expect(added.map((entry) => entry.config.durable_name)).toEqual([
      "ravi-whatsapp-messages",
      "ravi-whatsapp-connection",
    ]);
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
