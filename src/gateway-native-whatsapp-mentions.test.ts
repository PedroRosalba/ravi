import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Gateway } from "./gateway.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

const NATIVE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GROUP = "120363400000000002@g.us";

let stateDir: string | null = null;
const originalOmniUrl = process.env.OMNI_API_URL;
const originalOmniKey = process.env.OMNI_API_KEY;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gateway-native-mentions-");
  delete process.env.OMNI_API_URL;
  delete process.env.OMNI_API_KEY;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalOmniUrl === undefined) delete process.env.OMNI_API_URL;
  else process.env.OMNI_API_URL = originalOmniUrl;
  if (originalOmniKey === undefined) delete process.env.OMNI_API_KEY;
  else process.env.OMNI_API_KEY = originalOmniKey;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function makeGateway(native: unknown) {
  return new Gateway({
    omniSender: { getNativeWhatsApp: () => native } as never,
    omniConsumer: {} as never,
  });
}

type PrepareMentions = (input: {
  accountId: string;
  instanceId: string;
  chatId: string;
  channel: string;
  text: string;
}) => Promise<{ text: string; mentions?: Array<{ id: string; type: string }> }>;

describe("Gateway outbound mentions for native WhatsApp", () => {
  it("resolves @Name mentions from group metadata fetched over the runner RPC, without Omni", async () => {
    const request = mock(async (_ref: string, _method: string, _params: unknown, _options?: unknown) => ({
      groupJid: GROUP,
      subject: "grupo",
      participants: [
        {
          platformUserId: "5511947879044@s.whatsapp.net",
          phoneJid: "5511947879044@s.whatsapp.net",
          displayName: "Luis Filipe",
          role: "admin" as const,
        },
      ],
      fetchedAt: Date.now(),
    }));
    const native = { isNativeInstance: (id: string) => id === NATIVE_ID, request };
    const gateway = makeGateway(native);
    const prepare = (gateway as unknown as { prepareOutboundMentionMessage: PrepareMentions })
      .prepareOutboundMentionMessage;

    const prepared = await prepare.call(gateway, {
      accountId: "wa-native",
      instanceId: NATIVE_ID,
      chatId: GROUP,
      channel: "whatsapp-baileys",
      text: "oi @Luis Filipe",
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.slice(0, 3)).toEqual([NATIVE_ID, "groups.metadata", { groupJid: GROUP }]);
    expect(prepared.mentions).toEqual([{ id: "5511947879044@s.whatsapp.net", type: "user" }]);
    expect(prepared.text).not.toContain("@Luis Filipe");
  });

  it("does not use the runner RPC for instances it does not own", async () => {
    // A host-level ~/.omni/config.json may still resolve an Omni connection; keep it offline.
    globalThis.fetch = mock(async () =>
      Response.json({ error: "offline" }, { status: 503 }),
    ) as unknown as typeof fetch;
    const request = mock(async () => {
      throw new Error("should not be called");
    });
    const gateway = makeGateway({ isNativeInstance: () => false, request });
    const prepare = (gateway as unknown as { prepareOutboundMentionMessage: PrepareMentions })
      .prepareOutboundMentionMessage;

    const prepared = await prepare.call(gateway, {
      accountId: "omni-account",
      instanceId: "omni-instance",
      chatId: GROUP,
      channel: "whatsapp-baileys",
      text: "oi @Luis Filipe",
    });

    expect(prepared.text).toBe("oi @Luis Filipe");
    expect(request).not.toHaveBeenCalled();
  });
});
