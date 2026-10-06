export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  isVerified: boolean;
  tags: string[];
  usdPrice: number | null;
  liquidityUsd: number | null;
}

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Minimum out after slippage. */
  otherAmountThreshold: bigint;
  slippageBps: number;
  /** Percentage points (1.5 = 1.5%). */
  priceImpactPct: number | null;
  requestId: string | null;
  /** Base64 unsigned v0 transaction (only when a taker was given). */
  transaction: string | null;
  router: string | null;
  source: string;
  fetchedAt: number;
  /** Which safety-relevant fields the provider actually returned (live execution requires both). */
  reported?: { inAmount: boolean; otherAmountThreshold: boolean };
}

export interface SwapExecution {
  status: "Success" | "Failed";
  signature: string | null;
  code: number | null;
  inputAmount: bigint | null;
  outputAmount: bigint | null;
  error: string | null;
}

export interface MarketData {
  getUsdPrices(mints: string[]): Promise<Map<string, { usdPrice: number; liquidityUsd: number | null }>>;
  getTokenInfo(mint: string): Promise<TokenInfo | null>;
  searchTokens(query: string): Promise<TokenInfo[]>;
  getQuote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    taker?: string;
  }): Promise<SwapQuote>;
  executeSwap(input: { signedTransaction: string; requestId: string }): Promise<SwapExecution>;
  /** Daily closes, oldest → newest. */
  getDailyCloses(mint: string, days: number): Promise<number[]>;
  /** BRL per 1 USD. */
  getUsdBrl(): Promise<{ rate: number; source: string; asOf: number }>;
}

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}
