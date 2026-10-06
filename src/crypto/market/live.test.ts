import { describe, expect, it } from "bun:test";
import { withTempCryptoDb } from "../test-support.js";
import { LiveMarketData, parseJupiterExecute, parseJupiterOrder } from "./live.js";
import { MarketDataError } from "./types.js";

withTempCryptoDb();

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function router(routes: Array<[RegExp, () => Response]>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) throw new Error(`unexpected ${url}`);
    return route[1]();
  };
  return { calls, fetchImpl };
}

const geckoPools = () => json({ data: [{ attributes: { address: "POOL", reserve_in_usd: "1000" } }] });

describe("live market data", () => {
  it("retries once after HTTP 429 and then succeeds", async () => {
    let first = true;
    const { calls, fetchImpl } = router([
      [
        /price\/v3/,
        () => {
          if (first) {
            first = false;
            return json({}, 429, { "retry-after": "0" });
          }
          return json({ [TSLAX]: { usdPrice: 400, liquidity: 2_000_000 } });
        },
      ],
    ]);
    const market = new LiveMarketData({ fetch: fetchImpl, jupiterApiKey: null, throttle: false, retryDelayMs: 1 });
    const prices = await market.getUsdPrices([TSLAX]);
    expect(prices.get(TSLAX)).toEqual({ usdPrice: 400, liquidityUsd: 2_000_000 });
    expect(calls.length).toBe(2);
  });

  it("gives up after repeated 429s with a retryable error", async () => {
    const { fetchImpl } = router([[/price\/v3/, () => json({}, 429)]]);
    const market = new LiveMarketData({ fetch: fetchImpl, jupiterApiKey: null, throttle: false, retryDelayMs: 1 });
    const error = await market.getUsdPrices([TSLAX]).catch((e) => e);
    expect(error).toBeInstanceOf(MarketDataError);
    expect(error.code).toBe("MARKET_RATE_LIMITED");
  });

  it("falls back to the underlying stock when the on-chain pool is young, and caches across instances", async () => {
    const { calls, fetchImpl } = router([
      [/geckoterminal.*\/pools\?/, geckoPools],
      [
        /ohlcv/,
        () =>
          json({
            data: {
              attributes: {
                ohlcv_list: [
                  [2, 1, 1, 1, 401, 0],
                  [1, 1, 1, 1, 400, 0],
                ],
              },
            },
          }),
      ],
      [
        /finance\.yahoo\.com.*TSLA/,
        () =>
          json({
            chart: {
              result: [
                {
                  indicators: { quote: [{ close: Array.from({ length: 60 }, (_, i) => (i === 5 ? null : 300 + i)) }] },
                },
              ],
            },
          }),
      ],
    ]);
    const market = new LiveMarketData({ fetch: fetchImpl, jupiterApiKey: null, throttle: false });
    const closes = await market.getDailyCloses(TSLAX, 90);
    expect(closes.length).toBe(59); // nulls dropped, Yahoo beats the 2-candle pool
    expect(closes[0]).toBe(300);
    expect(calls.some((url) => url.includes("finance.yahoo.com"))).toBe(true);

    const second = new LiveMarketData({
      fetch: async () => {
        throw new Error("should hit cache");
      },
      throttle: false,
    });
    expect(await second.getDailyCloses(TSLAX, 90)).toEqual(closes);
  });

  it("parses Jupiter orders conservatively", () => {
    const base = { inputMint: "a", outputMint: "b", amount: 1_000n };
    const modern = parseJupiterOrder(
      { inAmount: "1000", outAmount: "500", otherAmountThreshold: "495", priceImpact: 0.2 },
      base,
      1,
    );
    expect(modern).toMatchObject({
      outAmount: 500n,
      otherAmountThreshold: 495n,
      priceImpactPct: 0.2,
      slippageBps: 100,
    });
    // Deprecated field: read as a fraction ×100 (the larger interpretation) so risk checks stay strict.
    const legacy = parseJupiterOrder({ outAmount: "500", priceImpactPct: "0.012" }, base, 1);
    expect(legacy.priceImpactPct).toBeCloseTo(1.2, 10);
    expect(() => parseJupiterOrder({ outAmount: "0" }, base, 1)).toThrow(MarketDataError);
  });

  it("parses execute results", () => {
    expect(parseJupiterExecute({ status: "Success", signature: "sig", outputAmountResult: "42" })).toMatchObject({
      status: "Success",
      signature: "sig",
      outputAmount: 42n,
    });
    expect(parseJupiterExecute({ status: "Failed", code: -2003 })).toMatchObject({
      status: "Failed",
      error: "execute code -2003",
    });
  });
});
