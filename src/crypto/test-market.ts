import { MarketDataError, type MarketData, type SwapQuote, type TokenInfo } from "./market/types.js";
import { ASSET_USDC } from "./types.js";

export const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";

/**
 * Deterministic market for tests: USD prices per mint, quotes at those prices
 * (with an optional multiplier to simulate the price moving), fixed USD/BRL.
 */
export class FakeMarket implements MarketData {
  usdBrl = 5;
  prices = new Map<string, { usdPrice: number; liquidityUsd: number | null }>([
    [ASSET_USDC, { usdPrice: 1, liquidityUsd: null }],
    [TSLAX, { usdPrice: 400, liquidityUsd: 2_000_000 }],
  ]);
  decimals = new Map<string, number>([
    [ASSET_USDC, 6],
    [TSLAX, 8],
  ]);
  /** Multiplier applied to every quote's output (simulate adverse moves). */
  quoteMultiplier = 1;
  priceImpactPct = 0.1;
  quotes = 0;
  tokens: TokenInfo[] = [];
  closes: number[] = Array.from({ length: 90 }, (_, i) => 300 + i);

  async getUsdPrices(mints: string[]) {
    return new Map(mints.filter((mint) => this.prices.has(mint)).map((mint) => [mint, this.prices.get(mint)!]));
  }

  async getTokenInfo(mint: string) {
    return this.tokens.find((token) => token.mint === mint) ?? null;
  }

  async searchTokens(query: string) {
    return this.tokens.filter((token) => token.symbol.toLowerCase() === query.toLowerCase() || token.mint === query);
  }

  async getQuote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<SwapQuote> {
    this.quotes++;
    const inPrice = this.prices.get(input.inputMint)?.usdPrice;
    const outPrice = this.prices.get(input.outputMint)?.usdPrice;
    if (!inPrice || !outPrice) throw new MarketDataError("no route", "QUOTE_UNAVAILABLE");
    const inDecimals = this.decimals.get(input.inputMint) ?? 6;
    const outDecimals = this.decimals.get(input.outputMint) ?? 6;
    const inUnits = Number(input.amount) / 10 ** inDecimals;
    const outUnits = ((inUnits * inPrice) / outPrice) * this.quoteMultiplier;
    const outAmount = BigInt(Math.floor(outUnits * 10 ** outDecimals));
    return {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inAmount: input.amount,
      outAmount,
      otherAmountThreshold: outAmount,
      slippageBps: 0,
      priceImpactPct: this.priceImpactPct,
      requestId: null,
      transaction: null,
      router: "fake",
      source: "fake",
      fetchedAt: Date.now(),
    };
  }

  async executeSwap(): Promise<never> {
    throw new Error("FakeMarket does not execute live swaps");
  }

  async getDailyCloses(): Promise<number[]> {
    return this.closes;
  }

  async getUsdBrl() {
    return { rate: this.usdBrl, source: "fake", asOf: Date.now() };
  }
}

/** Unsigned v0 transaction whose required signers are `signers` (base58 keys), for signing tests. */
export function buildUnsignedV0(signers: string[], decode: (key: string) => Uint8Array): string {
  const message = [
    0x80,
    signers.length,
    0,
    1,
    signers.length + 1,
    ...signers.flatMap((key) => [...decode(key)]),
    ...new Array(32).fill(7),
    ...new Array(32).fill(9),
    0,
    0,
  ];
  return Buffer.from(Uint8Array.from([signers.length, ...new Array(signers.length * 64).fill(0), ...message])).toString(
    "base64",
  );
}
