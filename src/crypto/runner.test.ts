import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeSetting } from "./config.js";
import { getTrade, openVault, postJournal } from "./db.js";
import { setMarketDataForTest } from "./market/index.js";
import { RecordingNotifier, setCryptoNotifierForTest } from "./notify.js";
import { requestOperatorApproval } from "./runner.js";
import { proposeTrade } from "./service.js";
import { FakeMarket } from "./test-market.js";
import { withTempCryptoDb } from "./test-support.js";
import { ASSET_USDC, SYSTEM_ACCOUNTS, vaultAccount } from "./types.js";

withTempCryptoDb();

beforeEach(() => {
  setMarketDataForTest(new FakeMarket());
  setCryptoNotifierForTest(new RecordingNotifier());
});

afterEach(() => {
  setMarketDataForTest(null);
  setCryptoNotifierForTest(null);
});

async function pendingTrade() {
  const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
  postJournal({
    kind: "test.fund",
    refType: "test",
    refId: vault.id,
    entries: [
      { account: vaultAccount(vault.id), assetId: ASSET_USDC, amount: 100_000_000n },
      { account: SYSTEM_ACCOUNTS.adjustments, assetId: ASSET_USDC, amount: -100_000_000n },
    ],
  });
  const { trade } = await proposeTrade({
    vault,
    side: "buy",
    assetRef: "TSLAx",
    amount: "10",
    unit: "usd",
    origin: "user",
    notify: null,
  });
  return trade;
}

describe("crypto runner operator approval", () => {
  it("skips when no approval target is configured", async () => {
    const trade = await pendingTrade();
    expect(await requestOperatorApproval(trade.id, { requestApproval: async () => ({ approved: true }) })).toBe(
      "skipped",
    );
    expect(getTrade(trade.id)?.status).toBe("pending_approval");
  });

  it("executes on an approving reaction and records who decided", async () => {
    writeSetting("approval.target", JSON.stringify({ channel: "whatsapp", accountId: "main", chatId: "5511" }));
    const trade = await pendingTrade();
    let prompt = "";
    const outcome = await requestOperatorApproval(trade.id, {
      requestApproval: async (target, text) => {
        expect(target.chatId).toBe("5511");
        prompt = text;
        return { approved: true };
      },
    });
    expect(outcome).toBe("approved");
    expect(prompt).toContain(trade.id);
    const after = getTrade(trade.id);
    expect(after?.status).toBe("executed");
    expect(after?.approval).toMatchObject({ decision: "approve", decidedBy: "approval-service", via: "reaction" });
  });

  it("rejects on denial or timeout", async () => {
    writeSetting("approval.target", JSON.stringify({ channel: "whatsapp", accountId: "main", chatId: "5511" }));
    const trade = await pendingTrade();
    expect(
      await requestOperatorApproval(trade.id, {
        requestApproval: async () => ({ approved: false, reason: "timeout" }),
      }),
    ).toBe("rejected");
    expect(getTrade(trade.id)?.status).toBe("rejected");
  });
});
