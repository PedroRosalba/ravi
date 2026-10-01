import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { dbUpsertChat, dbUpsertChatParticipant } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  formatOmniGroupMembersForPrompt,
  nativeGroupMetadataToOmni,
  resolveOmniGroupMetadata,
  type NativeGroupMetadataTransport,
} from "./group-metadata-cache.js";
import { getDb } from "../router/router-db.js";

let stateDir: string | null = null;
const originalFetch = globalThis.fetch;
const fetchCalls: string[] = [];

describe("Omni group metadata cache", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-omni-group-cache-");
    fetchCalls.length = 0;
    globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      const isTargetOmniCall = url.startsWith("http://omni.local/");
      if (isTargetOmniCall) {
        fetchCalls.push(url);
      }

      if (isTargetOmniCall && url.includes("/api/v2/chats?")) {
        return Response.json({
          items: [
            {
              id: "chat-uuid",
              instanceId: "instance-1",
              externalId: "120363424772797713@g.us",
              chatType: "group",
              channel: "whatsapp-baileys",
              name: "ravi - dev",
              description: "dev group",
              avatarUrl: "https://example.test/avatar.jpg",
              participantCount: 2,
              settings: { disappearing: "off" },
              platformMetadata: { source: "test" },
            },
          ],
          meta: { hasMore: false },
        });
      }

      if (isTargetOmniCall && url.includes("/api/v2/chats/chat-uuid/participants")) {
        return Response.json({
          items: [
            {
              id: "participant-1",
              platformUserId: "5511947879044",
              displayName: "Luis Filipe",
              role: "admin",
            },
            {
              id: "participant-2",
              platformUserId: "63295117615153",
              displayName: "R M",
              role: "member",
            },
            {
              id: "participant-3",
              platformUserId: "278507271802901",
              name: "-",
              role: "-",
            },
          ],
        });
      }

      return Response.json({ error: { message: "not found" } }, { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("resolves chat metadata and participants from Omni, then serves the cache locally", async () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "120363424772797713@g.us",
      chatType: "group",
      title: "ravi - dev",
      seenAt: Date.now(),
    });
    dbUpsertChatParticipant({
      chatId: chat.id,
      rawPlatformUserId: "5511947879044",
      normalizedPlatformUserId: "5511999990000",
      role: "member",
      status: "active",
      source: "inbound_message",
      metadata: { displayName: "Luis Filipe" },
      seenAt: Date.now(),
    });

    const first = await resolveOmniGroupMetadata({
      omniApiUrl: "http://omni.local",
      omniApiKey: "test-key",
      accountId: "main",
      instanceId: "instance-1",
      chatId: "120363424772797713@g.us",
      channel: "whatsapp-baileys",
      fallbackName: "ravi - dev",
    });

    expect(first).toMatchObject({
      chatUuid: "chat-uuid",
      externalId: "120363424772797713@g.us",
      name: "ravi - dev",
      participantCount: 2,
    });
    expect(first?.participants).toHaveLength(3);
    expect(first?.participants[0]).toMatchObject({
      platformUserId: "5511947879044",
      normalizedPlatformUserId: "5511999990000",
      mentionUserId: "5511999990000@s.whatsapp.net",
    });
    expect(formatOmniGroupMembersForPrompt(first)).toEqual(["Luis Filipe (admin)", "R M"]);
    expect(fetchCalls).toHaveLength(2);

    const second = await resolveOmniGroupMetadata({
      omniApiUrl: "http://omni.local",
      omniApiKey: "test-key",
      accountId: "main",
      instanceId: "instance-1",
      chatId: "120363424772797713@g.us",
    });

    expect(second?.participants).toHaveLength(3);
    expect(fetchCalls).toHaveLength(2);
  });

  describe("native WhatsApp instances", () => {
    const NATIVE_GROUP = "120363400000000001@g.us";

    function nativeTransport() {
      const request = mock(async (_ref: string, _method: string, _params: unknown, _options?: unknown) => ({
        groupJid: NATIVE_GROUP,
        subject: "grupo nativo",
        description: "descricao",
        owner: "5511000000000@s.whatsapp.net",
        participants: [
          {
            platformUserId: "111111111111111@lid",
            phoneJid: "5511947879044@s.whatsapp.net",
            phoneNumber: "+55 11 94787-9044",
            displayName: "Luis Filipe",
            role: "owner" as const,
          },
          { platformUserId: "5511900000000@s.whatsapp.net", displayName: "R M", role: "member" as const },
          { platformUserId: "  ", role: "member" as const },
        ],
        fetchedAt: 1_760_000_000_000,
      }));
      const transport = {
        isNativeInstance: mock((ref: string | null | undefined) => ref === "native-instance"),
        request,
      };
      return transport;
    }

    it("refreshes through the groups.metadata RPC into the same cache, without Omni", async () => {
      const transport = nativeTransport();

      const first = await resolveOmniGroupMetadata({
        nativeTransport: transport as unknown as NativeGroupMetadataTransport,
        accountId: "main",
        instanceId: "native-instance",
        chatId: NATIVE_GROUP,
        channel: "whatsapp-baileys",
      });

      expect(transport.request).toHaveBeenCalledTimes(1);
      expect(transport.request.mock.calls[0]?.slice(0, 3)).toEqual([
        "native-instance",
        "groups.metadata",
        { groupJid: NATIVE_GROUP },
      ]);
      expect(fetchCalls).toHaveLength(0);
      expect(first).toMatchObject({
        accountId: "main",
        instanceId: "native-instance",
        chatId: NATIVE_GROUP,
        externalId: NATIVE_GROUP,
        name: "grupo nativo",
        description: "descricao",
        participantCount: 2,
        platformMetadata: { transport: "native", owner: "5511000000000@s.whatsapp.net" },
        fetchedAt: 1_760_000_000_000,
      });
      expect(first?.participants[0]).toMatchObject({
        platformUserId: "111111111111111@lid",
        phoneJid: "5511947879044@s.whatsapp.net",
        mentionUserId: "5511947879044@s.whatsapp.net",
        normalizedPlatformUserId: "5511947879044",
        displayName: "Luis Filipe",
        role: "owner",
      });
      expect(formatOmniGroupMembersForPrompt(first)).toEqual(["Luis Filipe (owner)", "R M"]);

      const row = getDb()
        .prepare("SELECT name, participant_count FROM omni_group_metadata WHERE instance_id = ? AND chat_id = ?")
        .get("native-instance", NATIVE_GROUP) as { name: string; participant_count: number } | undefined;
      expect(row).toEqual({ name: "grupo nativo", participant_count: 2 });

      // Served from the local cache afterwards (fetchedAt is old, so pin maxAgeMs past it).
      const second = await resolveOmniGroupMetadata({
        nativeTransport: transport as unknown as NativeGroupMetadataTransport,
        accountId: "main",
        instanceId: "native-instance",
        chatId: NATIVE_GROUP,
        maxAgeMs: Number.MAX_SAFE_INTEGER,
      });
      expect(second?.participants).toHaveLength(2);
      expect(transport.request).toHaveBeenCalledTimes(1);
    });

    it("falls back to the cached metadata when the runner RPC fails", async () => {
      const transport = nativeTransport();
      await resolveOmniGroupMetadata({
        nativeTransport: transport as unknown as NativeGroupMetadataTransport,
        accountId: "main",
        instanceId: "native-instance",
        chatId: NATIVE_GROUP,
      });

      const failing = nativeTransport();
      failing.request.mockImplementation(async () => {
        throw new Error("runner down");
      });
      const cached = await resolveOmniGroupMetadata({
        nativeTransport: failing as unknown as NativeGroupMetadataTransport,
        accountId: "main",
        instanceId: "native-instance",
        chatId: NATIVE_GROUP,
        maxAgeMs: 0,
      });
      expect(cached?.name).toBe("grupo nativo");
    });

    it("uses Omni for instances the native transport does not own, and nothing without Omni", async () => {
      const transport = nativeTransport();
      const viaOmni = await resolveOmniGroupMetadata({
        omniApiUrl: "http://omni.local",
        omniApiKey: "test-key",
        nativeTransport: transport as unknown as NativeGroupMetadataTransport,
        accountId: "main",
        instanceId: "instance-1",
        chatId: "120363424772797713@g.us",
      });
      expect(viaOmni?.chatUuid).toBe("chat-uuid");
      expect(transport.request).not.toHaveBeenCalled();

      fetchCalls.length = 0;
      const none = await resolveOmniGroupMetadata({
        nativeTransport: transport as unknown as NativeGroupMetadataTransport,
        accountId: "main",
        instanceId: "omni-only",
        chatId: "120363499999999999@g.us",
      });
      expect(none).toBeNull();
      expect(fetchCalls).toHaveLength(0);
    });

    it("maps bare group ids to a group JID for the RPC", async () => {
      const transport = nativeTransport();
      await resolveOmniGroupMetadata({
        nativeTransport: transport as unknown as NativeGroupMetadataTransport,
        accountId: "main",
        instanceId: "native-instance",
        chatId: "group:120363400000000001",
      });
      expect(transport.request.mock.calls[0]?.[2]).toEqual({ groupJid: NATIVE_GROUP });
    });

    it("keeps the fallback name when the group has no subject", () => {
      const mapped = nativeGroupMetadataToOmni(
        { groupJid: NATIVE_GROUP, subject: null, participants: [], fetchedAt: 0 },
        { accountId: "main", instanceId: "native-instance", chatId: NATIVE_GROUP, fallbackName: "pelo payload" },
      );
      expect(mapped).toMatchObject({ name: "pelo payload", channel: "whatsapp-baileys", participantCount: 0 });
      expect(mapped.fetchedAt).toBeGreaterThan(0);
    });
  });
});
