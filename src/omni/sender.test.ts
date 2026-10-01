import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { WhatsAppRpcRequestSchema, type WhatsAppRpcRequest } from "../channels/whatsapp/contract.js";
import type { WhatsAppRpcConnection } from "../channels/whatsapp/rpc-client.js";
import { createChannelTransportClient } from "../channels/whatsapp/transport-client.js";
import { createOmniClient } from "./client.js";
import { OmniSender } from "./sender.js";

const NATIVE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

function fakeRunner(replies: Array<(request: WhatsAppRpcRequest) => unknown>) {
  const requests: WhatsAppRpcRequest[] = [];
  const connection: WhatsAppRpcConnection = {
    async request(_subject, data) {
      const request = WhatsAppRpcRequestSchema.parse(JSON.parse(new TextDecoder().decode(data)));
      requests.push(request);
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
      return { data: new TextEncoder().encode(JSON.stringify(reply(request))) };
    },
  };
  return { connection, requests };
}

function withTempFile(name: string, contents: string, run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ravi-omni-sender-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const originalFetch = globalThis.fetch;

describe("OmniSender", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes mentions through to Omni message send", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { messageId: "msg-1", status: "sent" } });
    }) as unknown as typeof fetch;

    const sender = new OmniSender("http://omni.local", "test-key");
    const result = await sender.send("instance-1", "120363@g.us", "@91015272759397 oi", {
      threadId: "thread-1",
      mentions: [{ id: "91015272759397@lid", type: "user" }],
    });

    expect(result).toEqual({ messageId: "msg-1" });
    expect(bodies[0]).toEqual({
      instanceId: "instance-1",
      to: "120363@g.us",
      text: "@91015272759397 oi",
      threadId: "thread-1",
      mentions: [{ id: "91015272759397@lid", type: "user" }],
    });
  });

  it("sends Omni media with base64 plus the absolute filePath", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { messageId: "media-1", status: "sent" } });
    }) as unknown as typeof fetch;

    await withTempFile("photo.png", "png-bytes", async (path) => {
      const sender = new OmniSender("http://omni.local", "test-key");
      const result = await sender.sendMedia(
        "instance-1",
        "120363@g.us",
        relative(process.cwd(), path),
        "image",
        "photo.png",
      );
      expect(result).toEqual({ messageId: "media-1" });
      await sender.sendSticker("instance-1", "120363@g.us", path);
      expect(bodies[0]).toMatchObject({
        instanceId: "instance-1",
        type: "image",
        filePath: path,
        base64: Buffer.from("png-bytes").toString("base64"),
        filename: "photo.png",
      });
      expect(bodies[1]).toMatchObject({ filePath: path, base64: Buffer.from("png-bytes").toString("base64") });
    });
  });

  it("can be built from an existing client", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { messageId: "msg-2", status: "sent" } });
    }) as unknown as typeof fetch;
    const client = createOmniClient({ baseUrl: "http://omni.local", apiKey: "k" });
    const sender = new OmniSender(client);
    expect(sender.getClient()).toBe(client);
    expect(await sender.send("instance-1", "5511@s.whatsapp.net", "oi")).toEqual({ messageId: "msg-2" });
    expect(bodies).toHaveLength(1);
  });

  it("sends native media by filePath only", async () => {
    const { connection, requests } = fakeRunner([
      (request) => ({ ok: true, requestId: request.requestId, data: { messageId: "BAE5", status: "sent" } }),
    ]);
    const sender = new OmniSender(createChannelTransportClient({ omni: null, getConfig: nativeConfig, connection }));

    await withTempFile("note.ogg", "audio-bytes", async (path) => {
      expect(
        await sender.sendMedia(NATIVE_ID, "5511@s.whatsapp.net", path, "audio", "note.ogg", undefined, true),
      ).toEqual({
        messageId: "BAE5",
      });
      await sender.sendSticker("wa-native", "5511@s.whatsapp.net", path);
    });

    expect(requests[0]!.method).toBe("messages.sendMedia");
    expect(requests[0]!.params).toMatchObject({ to: "5511@s.whatsapp.net", type: "audio", voiceNote: true });
    expect(requests[0]!.params).not.toHaveProperty("base64");
    expect(String((requests[0]!.params as { filePath: string }).filePath)).toEndWith("note.ogg");
    expect(requests[1]!.method).toBe("messages.sendSticker");
    expect(requests[1]!.params).not.toHaveProperty("base64");
  });

  it("retries native 5xx runner errors and not 4xx ones", async () => {
    const notConnected = (request: WhatsAppRpcRequest) => ({
      ok: false,
      requestId: request.requestId,
      error: { status: 503, code: "NOT_CONNECTED", message: "socket down" },
    });
    const sent = (request: WhatsAppRpcRequest) => ({
      ok: true,
      requestId: request.requestId,
      data: { messageId: "BAE6", status: "sent" },
    });
    const retrying = fakeRunner([notConnected, sent]);
    const sender = new OmniSender(
      createChannelTransportClient({ omni: null, getConfig: nativeConfig, connection: retrying.connection }),
    );
    expect(await sender.send(NATIVE_ID, "x@g.us", "hi")).toEqual({ messageId: "BAE6" });
    expect(retrying.requests).toHaveLength(2);

    const rejecting = fakeRunner([
      (request) => ({
        ok: false,
        requestId: request.requestId,
        error: { status: 404, code: "NOT_FOUND", message: "unknown chat" },
      }),
    ]);
    const strict = new OmniSender(
      createChannelTransportClient({ omni: null, getConfig: nativeConfig, connection: rejecting.connection }),
    );
    await expect(strict.send(NATIVE_ID, "x@g.us", "hi")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(rejecting.requests).toHaveLength(1);
  });
});
