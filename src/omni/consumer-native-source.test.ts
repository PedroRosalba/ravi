import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { StringCodec } from "nats";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  consumerSubscriptionsFor,
  NATIVE_SOURCE_SUBSCRIPTIONS,
  OMNI_SOURCE_SUBSCRIPTIONS,
  OmniConsumer,
  type OmniConsumerOptions,
} from "./consumer.js";

const sc = StringCodec();
const NATIVE_INSTANCE = "11111111-2222-4333-8444-555555555555";
const OMNI_INSTANCE = "99999999-2222-4333-8444-555555555555";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-omni-consumer-native-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function nativeEnvelope(type: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: `evt-${type}`,
    type,
    payload,
    metadata: {
      instanceId: NATIVE_INSTANCE,
      channelType: "whatsapp-baileys",
      source: "ravi.whatsapp.native",
      ingestMode: "realtime" as const,
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

type Handled = Array<[string, string, { id: string }]>;

function createConsumer(options: OmniConsumerOptions = {}) {
  const consumer = new OmniConsumer({} as never, null, null, options);
  const handled: Handled = [];
  const record = (kind: string) =>
    mock(async (subject: string, event: { id: string }) => {
      handled.push([kind, subject, event]);
    });
  consumer["handleMessageEvent"] = record("message");
  consumer["handleInstanceEvent"] = record("instance");
  consumer["handleReactionEvent"] = record("reaction");
  return { consumer, handled };
}

interface FakeMsg {
  subject: string;
  data: Uint8Array;
  ack: ReturnType<typeof mock>;
  nak: ReturnType<typeof mock>;
}

function fakeMsg(subject: string, body: unknown): FakeMsg {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return { subject, data: sc.encode(raw), ack: mock(() => {}), nak: mock(() => {}) };
}

/**
 * Fake JetStream: streams named in `existing` exist up front; others appear once
 * `ensureNativeStream` creates them. Each durable yields its queued messages once
 * and then idles until `release()` is called.
 */
function fakeJetStream(input: { existing: string[]; messages?: Record<string, FakeMsg[]> }) {
  const streams = new Set(input.existing);
  const consumers = new Map<string, { stream: string; filter_subject: string }>();
  const consumerAdds: Array<{ stream: string; durable: string; filter: string }> = [];
  const consumed = new Set<string>();
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const jsm = {
    streams: {
      info: mock(async (stream: string) => {
        if (!streams.has(stream)) throw new Error("stream not found");
        return { config: { name: stream } };
      }),
    },
    consumers: {
      info: mock(async (stream: string, name: string) => {
        const existing = consumers.get(`${stream}/${name}`);
        if (!existing) throw new Error("consumer not found");
        return existing;
      }),
      add: mock(async (stream: string, config: { durable_name: string; filter_subject: string }) => {
        consumers.set(`${stream}/${config.durable_name}`, { stream, filter_subject: config.filter_subject });
        consumerAdds.push({ stream, durable: config.durable_name, filter: config.filter_subject });
        return config;
      }),
    },
  };

  const js = {
    consumers: {
      get: mock(async (_stream: string, durable: string) => ({
        consume: async () =>
          (async function* () {
            if (!consumed.has(durable)) {
              consumed.add(durable);
              for (const msg of input.messages?.[durable] ?? []) yield msg;
            }
            await released;
          })(),
      })),
    },
  };

  const ensureNativeStream = mock(async () => {
    streams.add("CHANNEL_INBOUND");
  });

  return {
    connection: { jetstream: () => js, jetstreamManager: async () => jsm } as never,
    jsm,
    consumerAdds,
    ensureNativeStream,
    release: () => release(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OmniConsumer sources", () => {
  it("declares the native CHANNEL_INBOUND durables and filters", () => {
    expect(
      NATIVE_SOURCE_SUBSCRIPTIONS.map(({ stream, durable, filterSubject, kind }) => [
        stream,
        durable,
        filterSubject,
        kind,
      ]),
    ).toEqual([
      ["CHANNEL_INBOUND", "ravi-native-messages", "ravi.channel.inbound.message.received.>", "message"],
      ["CHANNEL_INBOUND", "ravi-native-instances", "ravi.channel.inbound.instance.>", "instance"],
      ["CHANNEL_INBOUND", "ravi-native-reactions", "ravi.channel.inbound.reaction.received.>", "reaction"],
    ]);
    expect(
      OMNI_SOURCE_SUBSCRIPTIONS.map(({ stream, durable, filterSubject }) => [stream, durable, filterSubject]),
    ).toEqual([
      ["MESSAGE", "ravi-messages", "message.received.>"],
      ["INSTANCE", "ravi-instances", "instance.>"],
      ["REACTION", "ravi-reactions", "reaction.received.>"],
    ]);
    expect(consumerSubscriptionsFor(["native"]).map((s) => s.durable)).toEqual([
      "ravi-native-messages",
      "ravi-native-instances",
      "ravi-native-reactions",
    ]);
    expect(consumerSubscriptionsFor(["native", "omni", "native"])).toHaveLength(6);
  });

  it("consumes only the native source without Omni, creating CHANNEL_INBOUND and stripping the prefix", async () => {
    const messageSubject = `ravi.channel.inbound.message.received.whatsapp-baileys.${NATIVE_INSTANCE}`;
    const qrSubject = `ravi.channel.inbound.instance.qr_code.whatsapp-baileys.${NATIVE_INSTANCE}`;
    const reactionSubject = `ravi.channel.inbound.reaction.received.whatsapp-baileys.${NATIVE_INSTANCE}`;
    const goodMessage = fakeMsg(messageSubject, nativeEnvelope("message.received", { externalId: "m1" }));
    const brokenMessage = fakeMsg(messageSubject, "{not json");
    const qr = fakeMsg(qrSubject, nativeEnvelope("instance.qr_code", { qrCode: "qr" }));
    const reaction = fakeMsg(reactionSubject, nativeEnvelope("reaction.received", { emoji: "👍" }));
    const fake = fakeJetStream({
      existing: [],
      messages: {
        "ravi-native-messages": [goodMessage, brokenMessage],
        "ravi-native-instances": [qr],
        "ravi-native-reactions": [reaction],
      },
    });
    const { consumer, handled } = createConsumer({
      sources: ["native"],
      natsConnection: fake.connection,
      ensureNativeStream: fake.ensureNativeStream,
    });

    await consumer.start();
    await flush();
    await consumer.stop();
    fake.release();

    expect(fake.ensureNativeStream).toHaveBeenCalled();
    expect(fake.consumerAdds.map(({ stream, durable, filter }) => `${stream}/${durable}/${filter}`).sort()).toEqual([
      "CHANNEL_INBOUND/ravi-native-instances/ravi.channel.inbound.instance.>",
      "CHANNEL_INBOUND/ravi-native-messages/ravi.channel.inbound.message.received.>",
      "CHANNEL_INBOUND/ravi-native-reactions/ravi.channel.inbound.reaction.received.>",
    ]);
    expect(fake.jsm.streams.info).not.toHaveBeenCalledWith("MESSAGE");

    expect(handled.map(([kind, subject, event]) => [kind, subject, event.id]).sort()).toEqual([
      ["instance", `instance.qr_code.whatsapp-baileys.${NATIVE_INSTANCE}`, "evt-instance.qr_code"],
      ["message", `message.received.whatsapp-baileys.${NATIVE_INSTANCE}`, "evt-message.received"],
      ["reaction", `reaction.received.whatsapp-baileys.${NATIVE_INSTANCE}`, "evt-reaction.received"],
    ]);
    // Same ack/nak semantics as the Omni source: ack before handling, nak on undecodable payloads.
    expect(goodMessage.ack).toHaveBeenCalledTimes(1);
    expect(goodMessage.nak).not.toHaveBeenCalled();
    expect(brokenMessage.nak).toHaveBeenCalledTimes(1);
    expect(brokenMessage.ack).not.toHaveBeenCalled();
    expect(qr.ack).toHaveBeenCalledTimes(1);
    expect(reaction.ack).toHaveBeenCalledTimes(1);
  });

  it("consumes native and Omni sources together when Omni is configured", async () => {
    const fake = fakeJetStream({ existing: ["MESSAGE", "INSTANCE", "REACTION"] });
    const { consumer } = createConsumer({
      sources: ["native", "omni"],
      natsConnection: fake.connection,
      ensureNativeStream: fake.ensureNativeStream,
    });

    await consumer.start();
    await consumer.stop();
    fake.release();

    expect(fake.consumerAdds.map(({ durable }) => durable).sort()).toEqual([
      "ravi-instances",
      "ravi-messages",
      "ravi-native-instances",
      "ravi-native-messages",
      "ravi-native-reactions",
      "ravi-reactions",
    ]);
    // Only the Ravi-owned stream is created by the consumer; Omni streams already exist (Omni owns them).
    expect(fake.ensureNativeStream).toHaveBeenCalled();
  });

  it("defaults to the Omni source only (legacy constructor callers)", async () => {
    const fake = fakeJetStream({ existing: ["MESSAGE", "INSTANCE", "REACTION"] });
    const { consumer } = createConsumer({
      natsConnection: fake.connection,
      ensureNativeStream: fake.ensureNativeStream,
    });

    await consumer.start();
    await consumer.stop();
    fake.release();

    expect(fake.consumerAdds.map(({ durable }) => durable).sort()).toEqual([
      "ravi-instances",
      "ravi-messages",
      "ravi-reactions",
    ]);
    expect(fake.ensureNativeStream).not.toHaveBeenCalled();
  });
});

describe("OmniConsumer source dispatch", () => {
  it("skips Omni events for natively owned instances and keeps the others", async () => {
    const isNativeInstance = mock((instanceId: string) => instanceId === NATIVE_INSTANCE);
    const { consumer, handled } = createConsumer({ nativeWhatsApp: { isNativeInstance, request: mock() as never } });
    const omniEvent = { id: "evt-omni", type: "message.received", payload: {}, metadata: {}, timestamp: Date.now() };

    for (const kind of ["message", "instance", "reaction"] as const) {
      await consumer["dispatchSourceEvent"](
        { source: "omni", kind },
        `message.received.whatsapp-baileys.${NATIVE_INSTANCE}`,
        omniEvent,
      );
    }
    await consumer["dispatchSourceEvent"](
      { source: "omni", kind: "message" },
      `message.received.whatsapp-baileys.${OMNI_INSTANCE}`,
      omniEvent,
    );

    expect(handled.map(([kind, subject]) => [kind, subject])).toEqual([
      ["message", `message.received.whatsapp-baileys.${OMNI_INSTANCE}`],
    ]);
    expect(isNativeInstance).toHaveBeenCalledWith(NATIVE_INSTANCE);
  });

  it("prefers an explicit ownership predicate", async () => {
    const { consumer, handled } = createConsumer({ isNativeInstance: () => true });
    await consumer["dispatchSourceEvent"](
      { source: "omni", kind: "message" },
      `message.received.whatsapp-baileys.${OMNI_INSTANCE}`,
      { id: "evt", type: "message.received", payload: {}, metadata: {}, timestamp: Date.now() },
    );
    expect(handled).toHaveLength(0);
  });

  it("does not apply the Omni ownership filter to native events", async () => {
    const { consumer, handled } = createConsumer({ isNativeInstance: () => true });
    await consumer["dispatchSourceEvent"](
      { source: "native", kind: "message" },
      `ravi.channel.inbound.message.received.whatsapp-baileys.${NATIVE_INSTANCE}`,
      nativeEnvelope("message.received", { externalId: "m1" }),
    );
    expect(handled.map(([, subject]) => subject)).toEqual([`message.received.whatsapp-baileys.${NATIVE_INSTANCE}`]);
  });

  it("drops native events with an invalid envelope or a subject outside the inbound prefix", async () => {
    const { consumer, handled } = createConsumer();

    await consumer["dispatchSourceEvent"](
      { source: "native", kind: "message" },
      `ravi.channel.inbound.message.received.whatsapp-baileys.${NATIVE_INSTANCE}`,
      nativeEnvelope("message.received", {}, { metadata: { instanceId: NATIVE_INSTANCE, channelType: "slack" } }),
    );
    await consumer["dispatchSourceEvent"](
      { source: "native", kind: "message" },
      `message.received.whatsapp-baileys.${NATIVE_INSTANCE}`,
      nativeEnvelope("message.received", {}),
    );

    expect(handled).toHaveLength(0);
  });
});
