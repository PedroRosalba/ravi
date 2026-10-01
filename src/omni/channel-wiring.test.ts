import { describe, expect, it } from "bun:test";
import { consumerSourcesFor, createDaemonChannelWiring } from "./channel-wiring.js";

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

describe("createDaemonChannelWiring", () => {
  it("consumes only native transports and routes through the native client when Omni is not configured", () => {
    const wiring = createDaemonChannelWiring({ omni: null, transport: { getConfig: nativeConfig } });

    expect(wiring.sources).toEqual(["native"]);
    expect(wiring.client.hasOmni()).toBe(false);
    expect(wiring.sender.getClient()).toBe(wiring.client);
    expect(wiring.sender.getNativeWhatsApp()).toBe(wiring.client.native);
    expect(wiring.client.native.isNativeInstance(NATIVE_ID)).toBe(true);
    expect(wiring.consumer["omniApiUrl"]).toBeNull();
    expect(wiring.consumer["options"].sources).toEqual(["native"]);
    expect(wiring.consumer["options"].nativeWhatsApp).toBe(wiring.client.native);
  });

  it("adds the Omni source and client when Omni is configured", () => {
    const wiring = createDaemonChannelWiring({
      omni: { apiUrl: "http://omni.local", apiKey: "key", source: "env" },
      transport: { getConfig: nativeConfig },
      consumer: { isRuntimeSessionActive: () => true },
    });

    expect(wiring.sources).toEqual(["native", "omni"]);
    expect(wiring.client.hasOmni()).toBe(true);
    expect(wiring.consumer["omniApiUrl"]).toBe("http://omni.local");
    expect(wiring.consumer["omniApiKey"]).toBe("key");
    expect(wiring.consumer["options"].isRuntimeSessionActive?.("s")).toBe(true);
  });

  it("derives sources from the Omni connection", () => {
    expect(consumerSourcesFor(null)).toEqual(["native"]);
    expect(consumerSourcesFor({ apiUrl: "u", apiKey: "k", source: "env" })).toEqual(["native", "omni"]);
  });
});
