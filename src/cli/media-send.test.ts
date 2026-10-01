import { afterEach, describe, expect, it, mock } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../config-store.js", () => ({
  configStore: {
    resolveInstanceId: (accountId: string) => (accountId === "hana-slack" ? undefined : accountId),
    // No native WhatsApp channels: the routing client leaves these targets on the Omni CLI path.
    getConfig: () => ({ instances: {}, channels: {}, instanceToAccount: {} }),
  },
}));

import { runWithContext } from "./context.js";
import { MediaSendAuthError } from "./media-send-auth.js";
import { WhatsAppRpcRequestSchema, type WhatsAppRpcRequest } from "../channels/whatsapp/contract.js";
import { createChannelTransportClient } from "../channels/whatsapp/transport-client.js";
import type { ChannelConfig, InstanceConfig } from "../router/router-db.js";

const { sendMediaWithOmniCli, resolveMediaSendTarget } = await import("./media-send.js");

const ORIGINAL_OMNI_API_URL = process.env.OMNI_API_URL;
const ORIGINAL_OMNI_API_KEY = process.env.OMNI_API_KEY;

function restoreOmniEnv(): void {
  if (ORIGINAL_OMNI_API_URL === undefined) delete process.env.OMNI_API_URL;
  else process.env.OMNI_API_URL = ORIGINAL_OMNI_API_URL;
  if (ORIGINAL_OMNI_API_KEY === undefined) delete process.env.OMNI_API_KEY;
  else process.env.OMNI_API_KEY = ORIGINAL_OMNI_API_KEY;
}

const ORIGINAL_PATH = process.env.PATH ?? "";
const tempDirs: string[] = [];

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  restoreOmniEnv();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveMediaSendTarget", () => {
  it("resolves account and chat from tool context source without --account/--to", () => {
    const target = runWithContext(
      {
        source: {
          channel: "whatsapp-baileys",
          accountId: "acct-media",
          chatId: "group:120363425628305127",
          threadId: "thread-1",
        },
      },
      () => resolveMediaSendTarget(),
    );

    expect(target).toEqual({
      channel: "whatsapp-baileys",
      accountId: "acct-media",
      instanceId: "acct-media",
      chatId: "120363425628305127@g.us",
      threadId: "thread-1",
    });
  });
});

describe("sendMediaWithOmniCli", () => {
  it("uses omni send directly and preserves thread-aware arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);

    const argsFile = join(dir, "args.txt");
    const omniPath = join(dir, "omni");
    writeFileSync(
      omniPath,
      `#!/bin/sh
printf '%s\n' "$@" > "${argsFile}"
printf '{"success":true,"message":"Media sent","data":{"messageId":"msg-test","status":"sent"}}\n'
`,
    );
    chmodSync(omniPath, 0o755);

    const mediaPath = join(dir, "sample.ogg");
    writeFileSync(mediaPath, "audio");

    process.env.PATH = `${dir}:${ORIGINAL_PATH}`;

    const result = await sendMediaWithOmniCli({
      filePath: mediaPath,
      voiceNote: true,
      target: {
        channel: "whatsapp-baileys",
        accountId: "bdd3db21-63ef-41b1-a48c-2fdf86df238c",
        chatId: "group:120363425628305127",
        threadId: "thread-1",
      },
    });

    const args = readFileSync(argsFile, "utf-8").trim().split("\n");
    expect(args).toEqual([
      "send",
      "--instance",
      "bdd3db21-63ef-41b1-a48c-2fdf86df238c",
      "--to",
      "120363425628305127@g.us",
      "--media",
      mediaPath,
      "--voice",
      "--thread-id",
      "thread-1",
    ]);
    expect(result.target).toEqual({
      channel: "whatsapp-baileys",
      accountId: "bdd3db21-63ef-41b1-a48c-2fdf86df238c",
      instanceId: "bdd3db21-63ef-41b1-a48c-2fdf86df238c",
      chatId: "120363425628305127@g.us",
      threadId: "thread-1",
    });
    expect(result.delivery).toMatchObject({
      transport: "omni-send",
      message: "Media sent",
      messageId: "msg-test",
      status: "sent",
    });
  });

  it("injects the runtime Omni credentials so the CLI cannot prefer a stale servers.list key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);

    const envFile = join(dir, "env.txt");
    const configFile = join(dir, "captured-config.json");
    const omniPath = join(dir, "omni");
    writeFileSync(
      omniPath,
      `#!/bin/sh
printf 'OMNI_API_URL=%s\\nOMNI_API_KEY=%s\\nOMNI_CONFIG_DIR=%s\\n' \\
  "$OMNI_API_URL" "$OMNI_API_KEY" "$OMNI_CONFIG_DIR" > "${envFile}"
if [ -n "$OMNI_CONFIG_DIR" ] && [ -f "$OMNI_CONFIG_DIR/config.json" ]; then
  cp "$OMNI_CONFIG_DIR/config.json" "${configFile}"
fi
printf '{"success":true,"message":"Media sent","data":{"messageId":"msg-auth","status":"sent"}}\\n'
`,
    );
    chmodSync(omniPath, 0o755);

    const mediaPath = join(dir, "sample.png");
    writeFileSync(mediaPath, "image");

    process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
    process.env.OMNI_API_URL = "http://omni.runtime.test:8882";
    process.env.OMNI_API_KEY = "runtime-primary-key";

    await sendMediaWithOmniCli({
      filePath: mediaPath,
      target: {
        channel: "whatsapp-baileys",
        accountId: "acct-media",
        chatId: "5511999999999",
      },
    });

    const env = readFileSync(envFile, "utf-8");
    expect(env).toContain("OMNI_API_URL=http://omni.runtime.test:8882");
    expect(env).toContain("OMNI_API_KEY=runtime-primary-key");
    expect(env).toMatch(/OMNI_CONFIG_DIR=\/.+/);

    const captured = JSON.parse(readFileSync(configFile, "utf-8")) as {
      apiKey: string;
      apiUrl: string;
      servers: { active: string; list: { default: { apiKey: string; url: string } } };
    };
    expect(captured.apiUrl).toBe("http://omni.runtime.test:8882");
    expect(captured.apiKey).toBe("runtime-primary-key");
    expect(captured.servers.active).toBe("default");
    expect(captured.servers.list.default).toEqual({
      url: "http://omni.runtime.test:8882",
      apiKey: "runtime-primary-key",
    });
  });

  it("throws MediaSendAuthError when Omni reports Invalid API key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);

    const omniPath = join(dir, "omni");
    writeFileSync(
      omniPath,
      `#!/bin/sh
printf '{"success":false,"error":"Invalid API key"}\\n' >&2
exit 1
`,
    );
    chmodSync(omniPath, 0o755);

    const mediaPath = join(dir, "sample.png");
    writeFileSync(mediaPath, "image");

    process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
    process.env.OMNI_API_URL = "http://omni.runtime.test:8882";
    process.env.OMNI_API_KEY = "runtime-primary-key";

    await expect(
      sendMediaWithOmniCli({
        filePath: mediaPath,
        target: {
          channel: "whatsapp-baileys",
          accountId: "acct-media",
          chatId: "5511999999999",
        },
      }),
    ).rejects.toBeInstanceOf(MediaSendAuthError);
  });

  it("uses native Slack delivery when the source channel is Slack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);
    const mediaPath = join(dir, "sample.png");
    writeFileSync(mediaPath, "image");
    const slackCalls: unknown[] = [];

    const result = await sendMediaWithOmniCli(
      {
        filePath: mediaPath,
        caption: "native upload",
        target: {
          channel: "slack",
          accountId: "hana-slack",
          chatId: "C123",
          threadId: "1783999999.000099",
        },
      },
      {
        sendSlackMedia: async (input) => {
          slackCalls.push(input);
          return {
            transport: "slack-native",
            provider: "slack",
            success: true,
            status: "sent",
            fileId: "F123",
            messageId: "1784000000.000100",
            raw: { ok: true },
          };
        },
      },
    );

    expect(slackCalls).toEqual([
      {
        accountId: "hana-slack",
        chatId: "C123",
        filePath: mediaPath,
        filename: "sample.png",
        caption: "native upload",
        threadId: "1783999999.000099",
      },
    ]);
    expect(result.target).toEqual({
      channel: "slack",
      accountId: "hana-slack",
      instanceId: "hana-slack",
      chatId: "C123",
      threadId: "1783999999.000099",
    });
    expect(result.delivery).toMatchObject({
      transport: "slack-native",
      provider: "slack",
      fileId: "F123",
      messageId: "1784000000.000100",
    });
  });
});

describe("sendMediaWithOmniCli on a native WhatsApp instance", () => {
  const NATIVE_ID = "5f0c6a8e-4d5b-4c1e-9b7a-2a6f1d3c8e90";

  function nativeConfig() {
    const instance = { name: "wa-native", instanceId: NATIVE_ID, channel: "whatsapp" } as InstanceConfig;
    const channel = { name: "wa-native", provider: "whatsapp", enabled: true } as ChannelConfig;
    return {
      instances: { "wa-native": instance },
      channels: { "wa-native": channel },
      instanceToAccount: { [NATIVE_ID]: "wa-native" },
    };
  }

  function fakeRunner() {
    const requests: Array<{ subject: string; request: WhatsAppRpcRequest; timeout: number }> = [];
    const connection = {
      async request(subject: string, data: Uint8Array, options: { timeout: number }) {
        const request = WhatsAppRpcRequestSchema.parse(JSON.parse(new TextDecoder().decode(data)));
        requests.push({ subject, request, timeout: options.timeout });
        const response = { ok: true, requestId: request.requestId, data: { messageId: "BAE5NATIVE", status: "sent" } };
        return { data: new TextEncoder().encode(JSON.stringify(response)) };
      },
    };
    return { connection, requests };
  }

  it("sends through the channel runner by absolute file path, without spawning the omni CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);
    const mediaPath = join(dir, "voice.ogg");
    writeFileSync(mediaPath, "audio");
    // An omni binary that fails loudly if it is ever spawned.
    const omniPath = join(dir, "omni");
    writeFileSync(omniPath, "#!/bin/sh\necho 'omni must not run' >&2\nexit 9\n");
    chmodSync(omniPath, 0o755);
    process.env.PATH = `${dir}:${ORIGINAL_PATH}`;

    const runner = fakeRunner();
    const transportClient = createChannelTransportClient({
      omni: null,
      getConfig: nativeConfig,
      connection: runner.connection,
    });

    const result = await sendMediaWithOmniCli(
      {
        filePath: mediaPath,
        caption: "ouça",
        voiceNote: true,
        target: { channel: "whatsapp-baileys", accountId: NATIVE_ID, chatId: "group:120363425628305127" },
      },
      { transportClient },
    );

    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.subject).toBe(`_RAVI.channels.whatsapp.rpc.${NATIVE_ID}`);
    expect(runner.requests[0]?.request.method).toBe("messages.sendMedia");
    expect(runner.requests[0]?.request.params).toEqual({
      to: "120363425628305127@g.us",
      type: "audio",
      filePath: mediaPath,
      filename: "voice.ogg",
      mimeType: "audio/ogg",
      caption: "ouça",
      voiceNote: true,
    });
    expect(result.delivery).toMatchObject({ transport: "whatsapp-native", messageId: "BAE5NATIVE", status: "sent" });
    expect(result.target.instanceId).toBe(NATIVE_ID);
  });

  it("keeps non-native WhatsApp targets on the omni CLI", async () => {
    const transportClient = {
      native: {
        isNativeInstance: () => false,
        resolveBinding: () => null,
        request: async () => {
          throw new Error("unexpected native RPC");
        },
      },
      messages: {} as ReturnType<typeof createChannelTransportClient>["messages"],
    };
    const dir = mkdtempSync(join(tmpdir(), "ravi-media-send-"));
    tempDirs.push(dir);
    const omniPath = join(dir, "omni");
    writeFileSync(
      omniPath,
      `#!/bin/sh
printf '{"success":true,"message":"Media sent","data":{"messageId":"msg-omni","status":"sent"}}\n'
`,
    );
    chmodSync(omniPath, 0o755);
    const mediaPath = join(dir, "sample.png");
    writeFileSync(mediaPath, "image");
    process.env.PATH = `${dir}:${ORIGINAL_PATH}`;

    const result = await sendMediaWithOmniCli(
      {
        filePath: mediaPath,
        target: { channel: "whatsapp-baileys", accountId: "acct-media", chatId: "5511999999999" },
      },
      { transportClient },
    );

    expect(result.delivery).toMatchObject({ transport: "omni-send", messageId: "msg-omni" });
  });
});
