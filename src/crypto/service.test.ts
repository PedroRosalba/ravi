import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeSetting } from "./config.js";
import { getAccountBalanceAtomic, getLedgerTrialBalance, getTrade, openVault, updateVault } from "./db.js";
import { setMarketDataForTest } from "./market/index.js";
import { RecordingNotifier, setCryptoNotifierForTest } from "./notify.js";
import { getPixProvider } from "./pix/index.js";
import type { SandboxPixProvider } from "./pix/sandbox.js";
import {
  CryptoServiceError,
  cancelTrade,
  createPixDeposit,
  decideTrade,
  getPortfolio,
  processPixEvent,
  proposeTrade,
  sweepExpired,
} from "./service.js";
import { FakeMarket, TSLAX } from "./test-market.js";
import { withTempCryptoDb } from "./test-support.js";
import { ASSET_BRL, ASSET_USDC, vaultAccount, type CryptoVault } from "./types.js";

withTempCryptoDb();

let market: FakeMarket;
let notifier: RecordingNotifier;
const notify = {
  sessionName: "agent-main-dm-5511",
  source: { channel: "whatsapp", accountId: "main", chatId: "5511" },
  private: true,
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
});

async function fundedVault(brl = "100"): Promise<CryptoVault> {
  const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
  const deposit = await createPixDeposit({ vault, amount: brl, notify });
  const provider = getPixProvider("sandbox") as SandboxPixProvider;
  const delivery = provider.signPayload({
    eventId: `evt_${deposit.id}`,
    txid: deposit.txid,
    status: "paid",
    amountBrl: deposit.amountBrl,
    paidAt: Date.now(),
  });
  const [event] = await provider.parseWebhook({ headers: delivery.headers, rawBody: delivery.body });
  const result = await processPixEvent("sandbox", event, market);
  expect(result.outcome).toBe("converted");
  return vault;
}

function usdc(vault: CryptoVault): bigint {
  return getAccountBalanceAtomic(vaultAccount(vault.id), ASSET_USDC);
}

function expectBalancedLedger() {
  for (const row of getLedgerTrialBalance()) expect(row.net).toBe("0");
}

describe("pix deposits", () => {
  it("credits, converts at the FX rate, and notifies the depositor's session", async () => {
    const vault = await fundedVault("100");
    // R$100 at 5 BRL/USD = 20 USDC
    expect(usdc(vault)).toBe(20_000_000n);
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), ASSET_BRL)).toBe(0n);
    expect(notifier.events.map((e) => e.event)).toEqual(["deposit.created", "deposit.converted"]);
    expect(notifier.informed[0].target?.sessionName).toBe(notify.sessionName);
    expect(notifier.informed[0].text).toContain("R$ 100,00");
    expectBalancedLedger();
  });

  it("ignores webhook replays", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    const deposit = await createPixDeposit({ vault, amount: "50", notify });
    const event = {
      eventId: "e1",
      txid: deposit.txid,
      providerChargeId: null,
      status: "paid" as const,
      amountBrl: 5_000n,
      paidAt: 1,
      payerName: null,
      conversion: null,
    };
    expect((await processPixEvent("sandbox", event, market)).outcome).toBe("converted");
    expect((await processPixEvent("sandbox", event, market)).outcome).toBe("duplicate");
    expect(usdc(vault)).toBe(10_000_000n);
  });

  it("refuses to let one provider settle another provider's charge", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    const deposit = await createPixDeposit({ vault, amount: "50", notify });
    const result = await processPixEvent(
      "ripio",
      {
        eventId: "x",
        txid: deposit.txid,
        providerChargeId: null,
        status: "paid",
        amountBrl: 5_000n,
        paidAt: 1,
        payerName: null,
        conversion: null,
      },
      market,
    );
    expect(result.outcome).toBe("provider_mismatch");
    expect(usdc(vault)).toBe(0n);
  });

  it("credits the amount actually received, not the amount requested", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    const deposit = await createPixDeposit({ vault, amount: "50", notify });
    await processPixEvent(
      "sandbox",
      {
        eventId: "e",
        txid: deposit.txid,
        providerChargeId: null,
        status: "paid",
        amountBrl: 2_500n,
        paidAt: 1,
        payerName: null,
        conversion: null,
      },
      market,
    );
    expect(usdc(vault)).toBe(5_000_000n);
  });

  it("enforces deposit limits and frozen vaults", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    await expect(createPixDeposit({ vault, amount: "1", notify })).rejects.toMatchObject({
      code: "CRYPTO_DEPOSIT_OUT_OF_RANGE",
    });
    await expect(createPixDeposit({ vault, amount: "1,234", notify })).rejects.toMatchObject({
      code: "CRYPTO_INVALID_AMOUNT",
    });
    const frozen = updateVault(vault.id, { status: "frozen" });
    await expect(createPixDeposit({ vault: frozen, amount: "50", notify })).rejects.toMatchObject({
      code: "CRYPTO_VAULT_FROZEN",
    });
  });

  it("expires stale charges", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    await createPixDeposit({ vault, amount: "50", notify });
    expect(await sweepExpired(Date.now() + 10 * 60 * 60 * 1000)).toEqual({ deposits: 1, trades: 0 });
  });
});

describe("trades", () => {
  it("runs propose → operator approve → paper fill, moving funds exactly once", async () => {
    const vault = await fundedVault("100"); // 20 USDC
    const { trade } = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "5",
      unit: "usd",
      origin: "user",
      notify,
    });
    expect(trade.status).toBe("pending_approval");
    expect(trade.executionMode).toBe("paper");
    expect(usdc(vault)).toBe(20_000_000n); // nothing moves until approval

    const executed = await decideTrade(trade.id, { decision: "approve", decidedBy: "operator", via: "cli" }, market);
    expect(executed.status).toBe("executed");
    expect(usdc(vault)).toBe(15_000_000n);
    // $5 / $400 = 0.0125 TSLAx = 1_250_000 atomic (8 decimals)
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), TSLAX)).toBe(1_250_000n);
    expect(notifier.events.map((e) => e.event)).toContain("trade.executed");
    expectBalancedLedger();

    await expect(
      decideTrade(trade.id, { decision: "approve", decidedBy: "operator", via: "cli" }, market),
    ).rejects.toMatchObject({
      code: "CRYPTO_TRADE_NOT_PENDING",
    });
  });

  it("sells back to USDC", async () => {
    const vault = await fundedVault("100");
    const buy = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLA",
      amount: "5",
      unit: "usd",
      origin: "user",
      notify,
    });
    await decideTrade(buy.trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market);
    const sell = await proposeTrade({
      vault,
      side: "sell",
      assetRef: TSLAX,
      amount: "100",
      unit: "percent",
      origin: "user",
      notify,
    });
    await decideTrade(sell.trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market);
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), TSLAX)).toBe(0n);
    expect(usdc(vault)).toBe(20_000_000n);
    expectBalancedLedger();
  });

  it("sizes USD sells of 0-decimal tokens correctly", async () => {
    const vault = await fundedVault("100");
    const mint = "Zero111111111111111111111111111111111111111";
    market.tokens = [
      { mint, symbol: "ZERO", name: "", decimals: 0, isVerified: true, tags: [], usdPrice: 0.05, liquidityUsd: 1e7 },
    ];
    market.prices.set(mint, { usdPrice: 0.05, liquidityUsd: 1e7 });
    market.decimals.set(mint, 0);
    const buy = await proposeTrade({
      vault,
      side: "buy",
      assetRef: mint,
      amount: "6",
      unit: "usd",
      origin: "user",
      notify,
    });
    await decideTrade(buy.trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market);
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), mint)).toBe(120n);
    // $5 at $0.05 = 100 units (not "1" from trimming the zeros of "100").
    const sell = await proposeTrade({
      vault,
      side: "sell",
      assetRef: mint,
      amount: "5",
      unit: "usd",
      origin: "user",
      notify,
    });
    expect(sell.trade.inputAmount).toBe("100");
  });

  it("blocks oversize positions and insufficient funds before creating anything", async () => {
    const vault = await fundedVault("100"); // $20 equity, 35% cap = $7
    await expect(
      proposeTrade({ vault, side: "buy", assetRef: "TSLAx", amount: "10", unit: "usd", origin: "user", notify }),
    ).rejects.toMatchObject({ code: "CRYPTO_TRADE_RISK_BLOCKED" });
    await expect(
      proposeTrade({ vault, side: "buy", assetRef: "TSLAx", amount: "50", unit: "usd", origin: "user", notify }),
    ).rejects.toMatchObject({ code: "CRYPTO_INSUFFICIENT_FUNDS" });
  });

  it("refuses unverified tokens", async () => {
    const vault = await fundedVault("100");
    market.tokens = [
      {
        mint: "Fake111111111111111111111111111111111111111",
        symbol: "SCAM",
        name: "",
        decimals: 6,
        isVerified: false,
        tags: [],
        usdPrice: 1,
        liquidityUsd: 1,
      },
    ];
    await expect(
      proposeTrade({
        vault,
        side: "buy",
        assetRef: "Fake111111111111111111111111111111111111111",
        amount: "1",
        unit: "usd",
        origin: "user",
        notify,
      }),
    ).rejects.toMatchObject({ code: "CRYPTO_ASSET_UNVERIFIED" });
  });

  it("fails safely and releases the hold when price moves past tolerance", async () => {
    const vault = await fundedVault("100");
    const { trade } = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "5",
      unit: "usd",
      origin: "user",
      notify,
    });
    market.quoteMultiplier = 0.9; // 10% worse than proposed, tolerance is 0.5%
    const result = await decideTrade(trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Price moved");
    expect(usdc(vault)).toBe(20_000_000n);
    expectBalancedLedger();
  });

  it("honors the kill switch at execution time", async () => {
    const vault = await fundedVault("100");
    const { trade } = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "5",
      unit: "usd",
      origin: "user",
      notify,
    });
    writeSetting("risk.killSwitch", "true");
    // Caught by the approval-time risk re-check: rejected before any funds are held.
    await expect(
      decideTrade(trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market),
    ).rejects.toMatchObject({ code: "CRYPTO_TRADE_RISK_BLOCKED" });
    expect(getTrade(trade.id)?.status).toBe("rejected");
    expect(usdc(vault)).toBe(20_000_000n);
  });

  it("refuses to execute a paper-proposed trade after switching to live", async () => {
    const vault = await fundedVault("100");
    const { trade } = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "5",
      unit: "usd",
      origin: "user",
      notify,
    });
    writeSetting("execution.mode", "live");
    const result = await decideTrade(trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("execution mode changed");
  });

  it("supports reject, cancel and expiry", async () => {
    const vault = await fundedVault("100");
    const a = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "1",
      unit: "usd",
      origin: "user",
      notify,
    });
    expect(
      (await decideTrade(a.trade.id, { decision: "reject", decidedBy: "op", via: "cli", reason: "no" }, market)).status,
    ).toBe("rejected");
    const b = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "1",
      unit: "usd",
      origin: "user",
      notify,
    });
    expect((await cancelTrade(b.trade)).status).toBe("cancelled");
    const c = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "1",
      unit: "usd",
      origin: "user",
      notify,
    });
    expect((await sweepExpired(Date.now() + 2 * 60 * 60 * 1000)).trades).toBe(1);
    expect(getTrade(c.trade.id)?.status).toBe("expired");
    expect(usdc(vault)).toBe(20_000_000n);
  });

  it("values the portfolio in USD and BRL", async () => {
    const vault = await fundedVault("100");
    const { trade } = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "TSLAx",
      amount: "5",
      unit: "usd",
      origin: "user",
      notify,
    });
    await decideTrade(trade.id, { decision: "approve", decidedBy: "op", via: "cli" }, market);
    const portfolio = await getPortfolio(vault, market);
    expect(portfolio.totals.usd).toBe(20);
    expect(portfolio.totals.brl).toBe(100);
    expect(portfolio.lines.map((l) => l.symbol).sort()).toEqual(["TSLAx", "USDC"]);
  });

  it("is a CryptoServiceError with a stable code", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c9" } });
    const error = await proposeTrade({
      vault,
      side: "buy",
      assetRef: "nope",
      amount: "1",
      unit: "usd",
      origin: "user",
      notify,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(CryptoServiceError);
    expect(error.code).toBe("CRYPTO_ASSET_NOT_FOUND");
  });
});
