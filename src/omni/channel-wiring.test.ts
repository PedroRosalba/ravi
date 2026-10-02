import { describe, expect, it, spyOn } from "bun:test";
import { ChannelInboundPipeline } from "../channels/inbound/pipeline.js";
import { WhatsAppInboundSource } from "../channels/whatsapp/inbound-source.js";
import { createDaemonChannelWiring } from "./channel-wiring.js";
import { OmniLegacyInboundSource } from "./inbound-source.js";

const NATIVE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function nativeConfig() {
  return {
    instances: {
      "wa-native": {
        name: "wa-native",
        instanceId: NATIVE_ID,
        channel: "whatsapp",
        dmPolicy: "open" as const,
        groupPolicy: "open" as const,
        contactIntakeMode: "off" as const,
        createdAt: 0,
        updatedAt: 0,
      },
    },
    channels: { "wa-native": { name: "wa-native", provider: "whatsapp", enabled: true, createdAt: 0, updatedAt: 0 } },
    instanceToAccount: { [NATIVE_ID]: "wa-native" },
  };
}

describe("createDaemonChannelWiring (interim)", () => {
  it("wires only the WhatsApp source and routes through the native client when Omni is not configured", () => {
    const wiring = createDaemonChannelWiring({ omni: null, transport: { getConfig: nativeConfig } });

    expect(wiring.sources.map((source) => source.id)).toEqual(["whatsapp"]);
    expect(wiring.sources[0]).toBeInstanceOf(WhatsAppInboundSource);
    expect(wiring.client.hasOmni()).toBe(false);
    expect(wiring.sender.getClient()).toBe(wiring.client);
    expect(wiring.sender.getNativeWhatsApp()).toBe(wiring.client.native);
    expect(wiring.client.native.isNativeInstance(NATIVE_ID)).toBe(true);
    expect(wiring.pipeline).toBeInstanceOf(ChannelInboundPipeline);
    expect(wiring.pipeline["sender"]).toBe(wiring.sender);
  });

  it("adds the legacy bridge source when Omni is configured, sharing one pipeline", () => {
    const wiring = createDaemonChannelWiring({
      omni: { apiUrl: "http://omni.local", apiKey: "key", source: "env" },
      transport: { getConfig: nativeConfig },
      pipeline: { isRuntimeSessionActive: () => true },
    });

    expect(wiring.sources.map((source) => source.id)).toEqual(["whatsapp", "omni"]);
    expect(wiring.sources[1]).toBeInstanceOf(OmniLegacyInboundSource);
    expect(wiring.client.hasOmni()).toBe(true);
    const [whatsapp, omni] = wiring.sources as [WhatsAppInboundSource, OmniLegacyInboundSource];
    expect(whatsapp["handler"]).toBe(wiring.pipeline);
    expect(omni["handler"]).toBe(wiring.pipeline);
    expect(wiring.pipeline["options"].isRuntimeSessionActive?.("s")).toBe(true);
  });

  it("starts every source even when one fails, and stops sources before the pipeline", async () => {
    const wiring = createDaemonChannelWiring({ omni: { apiUrl: "u", apiKey: "k", source: "env" } });
    const order: string[] = [];
    const [whatsapp, omni] = wiring.sources;
    if (!whatsapp || !omni) throw new Error("expected two sources");
    spyOn(whatsapp, "start").mockImplementation(async () => {
      throw new Error("nats down");
    });
    spyOn(omni, "start").mockImplementation(async () => {
      order.push("omni.start");
    });
    spyOn(whatsapp, "stop").mockImplementation(async () => {
      order.push("whatsapp.stop");
    });
    spyOn(omni, "stop").mockImplementation(async () => {
      order.push("omni.stop");
    });
    spyOn(wiring.pipeline, "stop").mockImplementation(async () => {
      order.push("pipeline.stop");
    });

    await wiring.start();
    await wiring.stop();

    expect(order).toEqual(["omni.start", "whatsapp.stop", "omni.stop", "pipeline.stop"]);
  });
});
