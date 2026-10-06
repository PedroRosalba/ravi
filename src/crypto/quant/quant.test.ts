import { describe, expect, it } from "bun:test";
import { scoreStrategy, smartMoneyConsensus } from "./scoring.js";
import { kellyFraction, suggestPositionFraction } from "./sizing.js";
import {
  annualizedVolatility,
  conditionalVaR,
  historicalVaR,
  maxDrawdown,
  momentum,
  rsi,
  sharpeRatio,
  simpleReturns,
  stdev,
  summarizePriceSeries,
} from "./stats.js";

describe("quant stats", () => {
  it("computes returns, volatility and drawdown", () => {
    const prices = [100, 110, 99, 120];
    expect(simpleReturns(prices).map((r) => Number(r.toFixed(4)))).toEqual([0.1, -0.1, 0.2121]);
    expect(maxDrawdown([100, 120, 90, 130, 117])).toBeCloseTo(0.25, 10);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(annualizedVolatility([0.01, -0.01, 0.01, -0.01], 365)).toBeCloseTo(0.2207, 3);
    expect(momentum([1, 2, 3, 4], 2)).toBeCloseTo(1, 10);
  });

  it("sharpe is zero for flat series and positive for steady gains", () => {
    expect(sharpeRatio([0, 0, 0])).toBe(0);
    expect(sharpeRatio([0.01, 0.012, 0.009, 0.011])).toBeGreaterThan(5);
  });

  it("RSI is 100 for monotonic rises and null without data", () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
    expect(
      rsi(
        Array.from({ length: 20 }, (_, i) => i + 1),
        14,
      ),
    ).toBe(100);
  });

  it("VaR and CVaR pick the left tail", () => {
    const returns = [-0.1, -0.05, 0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07];
    expect(historicalVaR(returns, 0.9)).toBeCloseTo(0.1, 10);
    expect(conditionalVaR(returns, 0.8)).toBeCloseTo(0.075, 10);
  });

  it("summarizes a series without NaN", () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);
    const summary = summarizePriceSeries(prices);
    expect(summary.momentum30).toBeGreaterThan(0.3);
    expect(summary.maxDrawdown).toBe(0);
    expect(summary.aboveSma20).toBe(true);
    for (const value of Object.values(summary)) {
      if (typeof value === "number") expect(Number.isNaN(value)).toBe(false);
    }
  });
});

describe("sizing", () => {
  it("kelly is zero without edge and positive with edge", () => {
    expect(kellyFraction(0.4, 1)).toBe(0);
    expect(kellyFraction(0.6, 1)).toBeCloseTo(0.2, 10);
  });

  it("never exceeds the risk profile cap", () => {
    const result = suggestPositionFraction({ riskProfile: "conservative", assetAnnualVol: 0.05, winProbability: 0.95 });
    expect(result.fraction).toBeLessThanOrEqual(0.1);
    expect(result.binding).toBe("cap");
  });

  it("scales down for volatile assets", () => {
    const calm = suggestPositionFraction({ riskProfile: "moderate", assetAnnualVol: 0.3, winProbability: 0.7 });
    const wild = suggestPositionFraction({ riskProfile: "moderate", assetAnnualVol: 3, winProbability: 0.7 });
    expect(wild.fraction).toBeLessThan(calm.fraction);
    expect(wild.binding).toBe("volatility");
  });

  it("returns zero without edge", () => {
    expect(
      suggestPositionFraction({ riskProfile: "aggressive", assetAnnualVol: 0.5, winProbability: 0.3 }).fraction,
    ).toBe(0);
  });
});

describe("scoring", () => {
  it("ranks a steady, deep-history strategy above a lucky short one", () => {
    const steady = scoreStrategy({
      profitFactor: 2,
      return3mPct: 15,
      worstFallPct: 8,
      winRatePct: 58,
      trackRecordDays: 400,
      pnlCurve: Array.from({ length: 30 }, (_, i) => i * 100),
    });
    const lucky = scoreStrategy({
      profitFactor: 1.1,
      return3mPct: 40,
      worstFallPct: 45,
      winRatePct: 30,
      trackRecordDays: 20,
      pnlCurve: [0, -500, 2000],
    });
    expect(steady.score).toBeGreaterThan(lucky.score);
    expect(lucky.flags).toEqual(expect.arrayContaining(["thin_edge", "short_track_record", "deep_drawdown"]));
  });

  it("counts distinct wallets once and weights by quality", () => {
    const quote = new Set(["USDC"]);
    const candidates = smartMoneyConsensus(
      [
        { walletId: "w1", tokenIn: "USDC", tokenOut: "TOK", usdValue: 1000, occurredAt: 1 },
        { walletId: "w1", tokenIn: "USDC", tokenOut: "TOK", usdValue: 1000, occurredAt: 2 },
        { walletId: "w2", tokenIn: "USDC", tokenOut: "TOK", usdValue: 500, occurredAt: 3 },
        { walletId: "w3", tokenIn: "USDC", tokenOut: "SOLO", usdValue: 9000, occurredAt: 3 },
        { walletId: "w4", tokenIn: "DUMP", tokenOut: "USDC", usdValue: 100, occurredAt: 4 },
        { walletId: "w5", tokenIn: "DUMP", tokenOut: "USDC", usdValue: 100, occurredAt: 5 },
      ],
      {
        quoteAssets: quote,
        walletScores: new Map([
          ["w1", 1],
          ["w2", 1],
        ]),
      },
    );
    expect(candidates.map((c) => [c.direction, c.assetId, c.distinctWallets])).toEqual([
      ["buy", "TOK", 2],
      ["sell", "DUMP", 2],
    ]);
    expect(candidates[0].totalUsd).toBe(2500);
  });
});
