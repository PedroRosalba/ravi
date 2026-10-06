/**
 * Regression tests for the adversarial review of the crypto domain. Each block
 * names the finding it pins down.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { writeSetting } from "./config.js";
import {
  getAccountBalanceAtomic,
  getDeposit,
  getLedgerTrialBalance,
  getTrade,
  getVault,
  openVault,
  postJournal,
  postJournalInTransaction,
  transitionTrade,
  withCryptoTransaction,
} from "./db.js";
import { ExecutionError, JupiterLiveExecutor, setExecutorForTest, type TradeExecutor } from "./execution/executors.js";
import { base58Decode, base58Encode, parseSolanaSecretKey } from "./execution/solana.js";
import { setMarketDataForTest } from "./market/index.js";
import type { SwapExecution, SwapQuote } from "./market/types.js";
import { RecordingNotifier, setCryptoNotifierForTest } from "./notify.js";
import { getPixProvider } from "./pix/index.js";
import type { PixPaymentEvent } from "./pix/types.js";
import {
  createPixDeposit,
  decideTrade,
  processPixEvent,
  proposeTrade,
  reconcileTrade,
  sweepExpired,
  sweepStaleTrades,
} from "./service.js";
import { FakeMarket, TSLAX, buildUnsignedV0 } from "./test-market.js";
import { withTempCryptoDb } from "./test-support.js";
import { ASSET_BRL, ASSET_USDC, SYSTEM_ACCOUNTS, vaultAccount, type CryptoTrade, type CryptoVault } from "./types.js";
import { handleCryptoWebhook } from "./webhook.js";

withTempCryptoDb();

let market: FakeMarket;
let notifier: RecordingNotifier;
const dm = {
  sessionName: "dm-session",
  source: { channel: "whatsapp", accountId: "main", chatId: "5511" },
  private: true,
};
const group = {
  sessionName: "group-session",
  source: { channel: "whatsapp", accountId: "main", chatId: "g1@g.us" },
  private: false,
};

beforeEach(() => {
  market = new FakeMarket();
  notifier = new RecordingNotifier();
  setMarketDataForTest(market);
  setCryptoNotifierForTest(notifier);
});

afterEach(() => {
  setMarketDataForTest(null);
  setCryptoNotifierForTest(null);
  setExecutorForTest("live", null);
  setExecutorForTest("paper", null);
});

function paid(txid: string, amountBrl: bigint, status: PixPaymentEvent["status"] = "paid"): PixPaymentEvent {
  return {
    eventId: `e-${txid}-${status}`,
    txid,
    providerChargeId: null,
    status,
    amountBrl,
    paidAt: 1,
    payerName: null,
    conversion: null,
  };
}

function fund(vault: CryptoVault, usdc: bigint) {
  postJournal({
    kind: "test.fund",
    refType: "test",
    refId: `${vault.id}-${usdc}`,
    entries: [
      { account: vaultAccount(vault.id), assetId: ASSET_USDC, amount: usdc },
      { account: SYSTEM_ACCOUNTS.adjustments, assetId: ASSET_USDC, amount: -usdc },
    ],
  });
}

const usdcOf = (vault: CryptoVault) => getAccountBalanceAtomic(vaultAccount(vault.id), ASSET_USDC);
const balanced = () => {
  for (const row of getLedgerTrialBalance()) expect(row.net).toBe("0");
};

describe("#3 sandbox money stays sandbox", () => {
  it("rejects sandbox webhooks when a real provider is configured", async () => {
    writeSetting("pix.provider", "ripio");
    const result = await handleCryptoWebhook({
      method: "POST",
      pathname: "/webhooks/crypto/pix/sandbox",
      headers: new Headers(),
      rawBody: "{}",
    });
    expect(result).toEqual({ status: 404, body: { ok: false, error: "provider_disabled" } });
  });

  it("never credits more than the charge amount", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    const deposit = await createPixDeposit({ vault, amount: "50", notify: dm });
    await processPixEvent("sandbox", paid(deposit.txid, 100_000_000n), market);
    expect(usdcOf(vault)).toBe(10_000_000n); // R$50 at 5 BRL/USD, not R$1,000,000
    expect(notifier.events.map((e) => e.event)).toContain("deposit.overpaid");
  });

  it("refuses live trades from sandbox-funded vaults", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    const deposit = await createPixDeposit({ vault, amount: "100", notify: dm });
    await processPixEvent("sandbox", paid(deposit.txid, 10_000n), market);
    writeSetting("execution.mode", "live");
    const { trade } = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "5",
      unit: "usd",
      origin: "user",
      notify: dm,
    });
    await expect(
      decideTrade(trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market),
    ).rejects.toMatchObject({
      code: "CRYPTO_TRADE_RISK_BLOCKED",
    });
    expect(getTrade(trade.id)?.status).toBe("rejected");
    expect(usdcOf(vault)).toBe(20_000_000n);
  });
});

describe("#4 a Pix that lands after local expiry is still credited", () => {
  it("credits paid events on locally-expired charges and only expires after a grace period", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    const deposit = await createPixDeposit({ vault, amount: "100", notify: dm });
    const justAfterDeadline = (deposit.expiresAt as number) + 60_000;
    expect((await sweepExpired(justAfterDeadline)).deposits).toBe(0); // inside grace
    expect((await sweepExpired(justAfterDeadline + 60 * 60_000)).deposits).toBe(1);
    expect(getDeposit(deposit.id)?.status).toBe("expired");

    const result = await processPixEvent("sandbox", paid(deposit.txid, 10_000n), market);
    expect(result.outcome).toBe("converted");
    expect(usdcOf(vault)).toBe(20_000_000n);
  });
});

describe("#5 risk is re-checked at approval", () => {
  it("enforces the daily cap across proposals approved later", async () => {
    writeSetting("risk.maxDailyUsd", "100");
    writeSetting("risk.maxPositionFraction", "1");
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    fund(vault, 1_000_000_000n);
    const proposals: CryptoTrade[] = [];
    for (let i = 0; i < 3; i++) {
      proposals.push(
        (
          await proposeTrade({
            vault,
            side: "buy",
            assetRef: "TSLAx",
            amount: "90",
            unit: "usd",
            origin: "user",
            notify: dm,
          })
        ).trade,
      );
    }
    const first = await decideTrade(proposals[0].id, { decision: "approve", decidedBy: "op", via: "cli" }, market);
    expect(first.status).toBe("executed");
    for (const trade of proposals.slice(1)) {
      await expect(
        decideTrade(trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market),
      ).rejects.toMatchObject({
        code: "CRYPTO_TRADE_RISK_BLOCKED",
      });
      expect(getTrade(trade.id)?.status).toBe("rejected");
    }
    expect(usdcOf(vault)).toBe(910_000_000n);
  });

  it("applies limits lowered after the proposal", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    fund(vault, 100_000_000n);
    const { trade } = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "20",
      unit: "usd",
      origin: "user",
      notify: dm,
    });
    writeSetting("risk.maxTradeUsd", "10");
    await expect(
      decideTrade(trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market),
    ).rejects.toMatchObject({
      code: "CRYPTO_TRADE_RISK_BLOCKED",
    });
  });
});

describe("#2/#6 unknown live outcomes keep funds held until reconciled", () => {
  async function liveTrade(): Promise<{ vault: CryptoVault; trade: CryptoTrade }> {
    writeSetting("execution.mode", "live");
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    fund(vault, 100_000_000n);
    const { trade } = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "10",
      unit: "usd",
      origin: "user",
      notify: dm,
    });
    return { vault, trade };
  }

  const unknownOutcome: TradeExecutor = {
    mode: "live",
    execute: async () => {
      throw new ExecutionError("timeout after signing", "EXECUTION_OUTCOME_UNKNOWN");
    },
  };

  it("keeps the trade executing with the hold in place, then reconciles a fill", async () => {
    const { vault, trade } = await liveTrade();
    setExecutorForTest("live", unknownOutcome);
    const pending = await decideTrade(trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market);
    expect(pending.status).toBe("executing");
    expect(pending.error).toContain("OUTCOME UNKNOWN");
    expect(usdcOf(vault)).toBe(90_000_000n); // held, not released
    expect((await sweepStaleTrades(Date.now() + 11 * 60_000, market)).stuck).toEqual([trade.id]);

    const filled = await reconcileTrade(
      trade.id,
      { outcome: "filled", outputAmount: 2_500_000n, txSignature: "sig" },
      market,
    );
    expect(filled.status).toBe("executed");
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), TSLAX)).toBe(2_500_000n);
    expect(usdcOf(vault)).toBe(90_000_000n);
    balanced();
  });

  it("reconciles a provably-failed swap by releasing the hold", async () => {
    const { vault, trade } = await liveTrade();
    setExecutorForTest("live", unknownOutcome);
    await decideTrade(trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market);
    const failed = await reconcileTrade(trade.id, { outcome: "failed", reason: "not on chain" }, market);
    expect(failed.status).toBe("failed");
    expect(usdcOf(vault)).toBe(100_000_000n);
    balanced();
    await expect(reconcileTrade(trade.id, { outcome: "retry" }, market)).rejects.toMatchObject({
      code: "CRYPTO_TRADE_NOT_RECONCILABLE",
    });
  });

  it("retries trades stuck in approved (never sent)", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    fund(vault, 100_000_000n);
    const { trade } = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "10",
      unit: "usd",
      origin: "user",
      notify: dm,
    });
    // Crash right after the approval commit: funds held, execution never started.
    withCryptoTransaction("test-approve", (db) => {
      transitionTrade(db, trade.id, ["pending_approval"], "approved", { decidedAt: Date.now() - 5 * 60_000 });
      postJournalInTransaction(db, {
        kind: "trade.hold",
        refType: "trade",
        refId: trade.id,
        entries: [
          { account: vaultAccount(vault.id), assetId: ASSET_USDC, amount: -10_000_000n },
          { account: "system:holds", assetId: ASSET_USDC, amount: 10_000_000n },
        ],
      });
    });
    expect(usdcOf(vault)).toBe(90_000_000n);
    const swept = await sweepStaleTrades(Date.now(), market);
    expect(swept.retried).toEqual([trade.id]);
    expect(getTrade(trade.id)?.status).toBe("executed");
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), TSLAX)).toBe(2_500_000n);
    balanced();
  });
});

describe("#8 live executor refuses incomplete or ambiguous Jupiter responses", () => {
  function newKey() {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    const seed = pkcs8.subarray(pkcs8.length - 32);
    const probe = parseSolanaSecretKey(base58Encode(seed));
    return {
      secret: base58Encode(Uint8Array.from([...seed, ...base58Decode(probe.publicKey)])),
      publicKey: probe.publicKey,
    };
  }

  function liveMarket(order: Partial<SwapQuote>, execute: () => Promise<SwapExecution>) {
    const fake = new FakeMarket();
    const baseQuote = fake.getQuote.bind(fake);
    fake.getQuote = async (input) => ({ ...(await baseQuote(input)), ...order });
    fake.executeSwap = execute as never;
    return fake;
  }

  async function setup(
    order: (key: { publicKey: string }) => Partial<SwapQuote>,
    execute: () => Promise<SwapExecution>,
  ) {
    const key = newKey();
    writeSetting("live.walletAddress", key.publicKey);
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    const trade = {
      id: "trd_live",
      vaultId: vault.id,
      inputAssetId: ASSET_USDC,
      outputAssetId: TSLAX,
      inputAmount: "10000000",
      minOutput: "2000000",
      slippageBps: 50,
    } as CryptoTrade;
    const fake = liveMarket(order(key), execute);
    return { exec: () => new JupiterLiveExecutor(key.secret).execute(trade, fake) };
  }

  const tx = (key: { publicKey: string }) => ({
    transaction: buildUnsignedV0([key.publicKey], base58Decode),
    requestId: "req",
    reported: { inAmount: true, otherAmountThreshold: true },
  });

  it("refuses to sign orders missing safety fields", async () => {
    const { exec } = await setup(
      (key) => ({ ...tx(key), reported: { inAmount: true, otherAmountThreshold: false } }),
      async () => ({ status: "Success", signature: "s", code: 0, inputAmount: 1n, outputAmount: 1n, error: null }),
    );
    await expect(exec()).rejects.toMatchObject({ code: "EXECUTION_INCOMPLETE_ORDER" });
  });

  it("classifies execute errors after signing as unknown outcome", async () => {
    const { exec } = await setup(tx, async () => {
      throw new Error("socket hang up");
    });
    await expect(exec()).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
  });

  it("classifies success without an output amount as unknown outcome", async () => {
    const { exec } = await setup(tx, async () => ({
      status: "Success",
      signature: "s",
      code: 0,
      inputAmount: null,
      outputAmount: null,
      error: null,
    }));
    await expect(exec()).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
  });

  it("credits only the reported output on success", async () => {
    const { exec } = await setup(tx, async () => ({
      status: "Success",
      signature: "sig",
      code: 0,
      inputAmount: 9_990_000n,
      outputAmount: 2_400_000n,
      error: null,
    }));
    expect(await exec()).toMatchObject({ outputAmount: 2_400_000n, inputAmount: 9_990_000n, txSignature: "sig" });
  });
});

describe("#7 refunds after credit are reversed", () => {
  it("reverses credit and conversion exactly", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    const deposit = await createPixDeposit({ vault, amount: "100", notify: dm });
    await processPixEvent("sandbox", paid(deposit.txid, 10_000n), market);
    expect(usdcOf(vault)).toBe(20_000_000n);
    await processPixEvent("sandbox", paid(deposit.txid, 10_000n, "failed"), market);
    expect(getDeposit(deposit.id)?.status).toBe("reversed");
    expect(usdcOf(vault)).toBe(0n);
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), ASSET_BRL)).toBe(0n);
    balanced();
  });

  it("freezes the vault when the refunded money was already spent", async () => {
    writeSetting("risk.maxPositionFraction", "1");
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    const deposit = await createPixDeposit({ vault, amount: "100", notify: dm });
    await processPixEvent("sandbox", paid(deposit.txid, 10_000n), market);
    const { trade } = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "15",
      unit: "usd",
      origin: "user",
      notify: dm,
    });
    await decideTrade(trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market);
    await processPixEvent("sandbox", paid(deposit.txid, 10_000n, "failed"), market);
    expect(getDeposit(deposit.id)?.status).toBe("reversal_blocked");
    expect(getVault(vault.id)?.status).toBe("frozen");
    expect(notifier.events.map((e) => e.event)).toContain("deposit.reversal_blocked");
    balanced();
  });
});

describe("#11 group chats never see amounts", () => {
  it("redacts deposit confirmations delivered to group sessions", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c" } });
    const deposit = await createPixDeposit({ vault, amount: "100", notify: group });
    await processPixEvent("sandbox", paid(deposit.txid, 10_000n), market);
    const text = notifier.informed.at(-1)?.text ?? "";
    expect(text).not.toContain("R$");
    expect(text).not.toContain(vault.id);
    expect(text).toContain("privado");
  });
});

describe("pix provider registry", () => {
  it("still resolves the sandbox provider for tests", () => {
    expect(getPixProvider("sandbox").id).toBe("sandbox");
  });
});
