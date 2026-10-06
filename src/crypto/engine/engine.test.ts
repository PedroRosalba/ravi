import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { listSignals, listStrategies, upsertWatchedWallet } from "../db.js";
import { setMarketDataForTest } from "../market/index.js";
import { RecordingNotifier, setCryptoNotifierForTest } from "../notify.js";
import { summarizePriceSeries } from "../quant/stats.js";
import { FakeMarket, TSLAX } from "../test-market.js";
import { withTempCryptoDb } from "../test-support.js";
import { ASSET_USDC } from "../types.js";
import { ingestHeliusTransactions, verifyHeliusAuth } from "./helius.js";
import { storeMiraStrategy, syncMiraStrategies } from "./mira.js";
import { classifyMomentum, runMomentum, runSmartMoney } from "./signals.js";

withTempCryptoDb();

let market: FakeMarket;

beforeEach(() => {
  market = new FakeMarket();
  setMarketDataForTest(market);
  setCryptoNotifierForTest(new RecordingNotifier());
});

afterEach(() => {
  setMarketDataForTest(null);
  setCryptoNotifierForTest(null);
});

function swap(signature: string, wallet: string, usdc: number, tokenAmount: number, mint = TSLAX) {
  return {
    signature,
    type: "SWAP",
    timestamp: Math.floor(Date.now() / 1000),
    feePayer: wallet,
    tokenTransfers: [
      { fromUserAccount: wallet, toUserAccount: "pool", tokenAmount: usdc, mint: ASSET_USDC },
      { fromUserAccount: "pool", toUserAccount: wallet, tokenAmount: tokenAmount, mint },
    ],
    nativeTransfers: [{ fromUserAccount: wallet, toUserAccount: "fees", amount: 5000 }],
  };
}

describe("helius ingest", () => {
  it("records swaps for watched wallets only, deduped by signature", () => {
    upsertWatchedWallet({ chain: "solana", address: "W1", source: "manual" });
    const payload = [
      swap("s1", "W1", 500, 1.2),
      swap("s2", "Stranger", 500, 1.2),
      { signature: "s3", transactionError: "x" },
    ];
    expect(ingestHeliusTransactions(payload)).toEqual({ transactions: 3, recorded: 1, duplicates: 0, ignored: 2 });
    expect(ingestHeliusTransactions([swap("s1", "W1", 500, 1.2)]).duplicates).toBe(1);
  });

  it("verifies the echoed auth header in constant time", async () => {
    expect(await verifyHeliusAuth("secret", "secret")).toBe(true);
    expect(await verifyHeliusAuth("Secret", "secret")).toBe(false);
    expect(await verifyHeliusAuth(null, "secret")).toBe(false);
    expect(await verifyHeliusAuth("secret", null)).toBe(false);
  });
});

describe("smart-money engine", () => {
  it("emits a buy signal when distinct watched wallets accumulate the same verified token", async () => {
    upsertWatchedWallet({ chain: "solana", address: "W1", source: "manual", metrics: { score: 0.9 } });
    upsertWatchedWallet({ chain: "solana", address: "W2", source: "manual", metrics: { score: 0.8 } });
    ingestHeliusTransactions([swap("a", "W1", 1000, 2.5), swap("b", "W2", 400, 1)]);
    const report = await runSmartMoney({ market });
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]).toMatchObject({ engine: "smart-money", symbol: "TSLAx", direction: "buy" });
    expect(report.signals[0].features.distinctWallets).toBe(2);
    expect(listSignals({ status: "active", limit: 10, offset: 0 }).total).toBe(1);
  });

  it("skips unverified tokens", async () => {
    upsertWatchedWallet({ chain: "solana", address: "W1", source: "manual" });
    upsertWatchedWallet({ chain: "solana", address: "W2", source: "manual" });
    const rug = "Rug1111111111111111111111111111111111111111";
    ingestHeliusTransactions([swap("a", "W1", 100, 1e6, rug), swap("b", "W2", 100, 1e6, rug)]);
    const report = await runSmartMoney({ market });
    expect(report.signals).toHaveLength(0);
    expect(report.skipped[0].reason).toBe("CRYPTO_ASSET_NOT_FOUND");
  });
});

describe("momentum engine", () => {
  it("classifies uptrends, downtrends and overbought markets", () => {
    const up = summarizePriceSeries(Array.from({ length: 60 }, (_, i) => 100 + 0.5 * i + 3 * Math.sin(i)));
    expect(classifyMomentum(up).direction).toBe("buy");
    const down = summarizePriceSeries(Array.from({ length: 60 }, (_, i) => 200 - i * 1.5 + (i % 4)));
    expect(classifyMomentum(down).direction).toBe("sell");
    const parabolic = summarizePriceSeries(Array.from({ length: 60 }, (_, i) => 100 * 1.03 ** i));
    expect(classifyMomentum(parabolic)).toMatchObject({ direction: "hold", reason: "overbought (RSI ≥ 75)" });
  });

  it("scans the xStock watchlist", async () => {
    market.closes = Array.from({ length: 90 }, (_, i) => 100 + 0.5 * i + 3 * Math.sin(i));
    for (const symbol of ["NVDAx", "SPYx", "AAPLx", "QQQx"])
      market.prices.set(symbol, { usdPrice: 1, liquidityUsd: 1 });
    const report = await runMomentum({ market });
    expect(report.candidates).toBe(5);
    expect(report.signals.length).toBe(5);
    expect(report.signals.every((s) => s.direction === "buy")).toBe(true);
  });
});

describe("mira strategies", () => {
  const raw = {
    id: "8d6c92b2-9596-4659-9ca7-67bcc76e4aa3",
    display_name: "#739 master-octopus",
    risk_level: "medium",
    min_allocation_usd: "100",
    profit_factor: "5.87",
    last_three_months_profit_percent: "46.00",
    worst_fall_percent: "-17.98",
    track_record_started_at: "2025-12-13T13:34:52.065Z",
    win_rate_percent: "86.64",
    cumulative_realized_pnl: Array.from({ length: 20 }, (_, i) => ({
      timestamp: new Date(Date.UTC(2026, 0, 1 + i * 7)).toISOString(),
      pnl_usd: String(i * 150 + (i % 2) * 20),
    })),
  };

  it("parses the public payload shape and scores it", () => {
    const stored = storeMiraStrategy(raw, Date.parse("2026-10-03T00:00:00Z"));
    expect(stored).toMatchObject({
      source: "mira",
      name: "#739 master-octopus",
      venue: "hyperliquid",
      riskLevel: "medium",
    });
    expect(stored.metrics.worstFallPct).toBe(17.98);
    expect(stored.metrics.trackRecordDays).toBeGreaterThan(290);
    expect(stored.score).toBeGreaterThan(70);
  });

  it("syncs from the public endpoint without credentials", async () => {
    const fake = async (url: string) => {
      expect(url).toBe("https://api.mirafinance.xyz/strategies/public");
      return new Response(JSON.stringify([raw, { ...raw, id: "b", display_name: "#2 weak", profit_factor: "1.05" }]));
    };
    const result = await syncMiraStrategies({ fetch: fake as typeof fetch, now: Date.parse("2026-10-03T00:00:00Z") });
    expect(result).toMatchObject({ fetched: 2, authenticated: false });
    const ranked = listStrategies({ source: "mira", limit: 10, offset: 0 }).items;
    expect(ranked.map((s) => s.name)).toEqual(["#739 master-octopus", "#2 weak"]);
  });
});

describe("momentum regime guards", () => {
  it("does not call a bounce inside a losing window an uptrend", () => {
    // 60 days of decline, then a 25-day recovery that is still below the start.
    const series = [
      ...Array.from({ length: 60 }, (_, i) => 200 - i * 1.6 + 2 * Math.sin(i)),
      ...Array.from({ length: 25 }, (_, i) => 104 + i * 1.2 + 2 * Math.sin(i)),
    ];
    const summary = summarizePriceSeries(series);
    expect(summary.momentum30).toBeGreaterThan(0);
    expect(summary.sharpe).toBeLessThanOrEqual(0);
    expect(classifyMomentum(summary)).toMatchObject({ direction: "hold" });
  });
});
