import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { startWebhookHttpServer, type WebhookHttpServerHandle } from "../webhooks/http-server.js";
import { getAccountBalanceAtomic, getDeposit, openVault, upsertWatchedWallet, listWalletEvents } from "./db.js";
import { setMarketDataForTest } from "./market/index.js";
import { RecordingNotifier, setCryptoNotifierForTest } from "./notify.js";
import { getPixProvider } from "./pix/index.js";
import type { SandboxPixProvider } from "./pix/sandbox.js";
import { createPixDeposit } from "./service.js";
import { FakeMarket, TSLAX } from "./test-market.js";
import { withTempCryptoDb } from "./test-support.js";
import { ASSET_USDC, vaultAccount } from "./types.js";

withTempCryptoDb();

let server: WebhookHttpServerHandle;

beforeEach(() => {
  setMarketDataForTest(new FakeMarket());
  setCryptoNotifierForTest(new RecordingNotifier());
  server = startWebhookHttpServer({ host: "127.0.0.1", port: 0, gateway: null });
});

afterEach(async () => {
  await server.stop();
  setMarketDataForTest(null);
  setCryptoNotifierForTest(null);
  delete process.env.HELIUS_WEBHOOK_AUTH;
});

describe("crypto webhooks over HTTP", () => {
  it("credits a signed sandbox Pix payment exactly once", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    const deposit = await createPixDeposit({ vault, amount: "100", notify: null });
    const provider = getPixProvider("sandbox") as SandboxPixProvider;
    const delivery = provider.signPayload({
      eventId: "evt_http",
      txid: deposit.txid,
      status: "paid",
      amountBrl: deposit.amountBrl,
      paidAt: Date.now(),
    });
    const post = () =>
      fetch(`${server.url}/webhooks/crypto/pix/sandbox`, {
        method: "POST",
        headers: delivery.headers,
        body: delivery.body,
      });

    const first = await post();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { results: Array<{ outcome: string }> }).results[0].outcome).toBe("converted");
    const replay = await post();
    expect(((await replay.json()) as { results: Array<{ outcome: string }> }).results[0].outcome).toBe("duplicate");
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), ASSET_USDC)).toBe(20_000_000n);
    expect(getDeposit(deposit.id)?.status).toBe("converted");
  });

  it("rejects forged signatures with 401 and credits nothing", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    const deposit = await createPixDeposit({ vault, amount: "100", notify: null });
    const body = JSON.stringify({ eventId: "x", txid: deposit.txid, status: "paid", amountBrl: "999999", paidAt: 1 });
    const response = await fetch(`${server.url}/webhooks/crypto/pix/sandbox`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ravi-signature": `sha256=${"0".repeat(64)}` },
      body,
    });
    expect(response.status).toBe(401);
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), ASSET_USDC)).toBe(0n);
  });

  it("rejects unknown providers and non-POST methods", async () => {
    expect((await fetch(`${server.url}/webhooks/crypto/pix/evil`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${server.url}/webhooks/crypto/pix/sandbox`)).status).toBe(405);
  });

  it("ingests Helius activity only with the shared auth header", async () => {
    process.env.HELIUS_WEBHOOK_AUTH = "helius-secret";
    upsertWatchedWallet({ chain: "solana", address: "W1", source: "manual" });
    const payload = JSON.stringify([
      {
        signature: "sig-http",
        timestamp: Math.floor(Date.now() / 1000),
        feePayer: "W1",
        tokenTransfers: [
          { fromUserAccount: "W1", toUserAccount: "pool", tokenAmount: 100, mint: ASSET_USDC },
          { fromUserAccount: "pool", toUserAccount: "W1", tokenAmount: 0.25, mint: TSLAX },
        ],
      },
    ]);
    const denied = await fetch(`${server.url}/webhooks/crypto/helius`, { method: "POST", body: payload });
    expect(denied.status).toBe(401);
    const ok = await fetch(`${server.url}/webhooks/crypto/helius`, {
      method: "POST",
      headers: { authorization: "helius-secret" },
      body: payload,
    });
    expect(ok.status).toBe(200);
    expect(listWalletEvents({ limit: 10, offset: 0 }).items[0]).toMatchObject({
      kind: "swap",
      tokenOut: TSLAX,
      usdValue: 100,
    });
  });
});
