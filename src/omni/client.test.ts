import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOmniClient, OmniApiError } from "./client.js";

// A server that accepts requests and never answers, like a stalled omni-api.
let hangingServer: Server;
let port = 0;

beforeAll(async () => {
  hangingServer = createServer(() => {});
  await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
  port = (hangingServer.address() as AddressInfo).port;
});

afterAll(() => {
  hangingServer.closeAllConnections();
  hangingServer.close();
});

describe("createOmniClient", () => {
  it("fails a request that never gets a response instead of hanging", async () => {
    const client = createOmniClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "test",
      timeoutMs: 50,
    });

    const error = await client.messages
      .sendPresence({ instanceId: "discord", to: "channel", type: "typing" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OmniApiError);
    expect((error as OmniApiError).code).toBe("TIMEOUT");
    expect((error as OmniApiError).message).toContain("POST /messages/send/presence");
  });
});
