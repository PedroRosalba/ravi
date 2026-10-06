/**
 * Curated, verified Solana assets. Search results on Jupiter include many scam
 * copies of popular tickers, so tokenized stocks are only ever resolved from
 * this list (mints verified live 2026-10-03) or from Jupiter tokens flagged
 * `isVerified` with an `xstocks` tag.
 *
 * Ondo Global Markets tokens exist on Solana but have near-zero Jupiter
 * liquidity, so they are intentionally excluded from the tradable catalog.
 */

import type { AssetKind } from "../types.js";

export interface CatalogAsset {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: AssetKind;
  /** Underlying ticker for tokenized stocks (used for price history fallback). */
  underlying?: string;
}

export const SOLANA_CATALOG: CatalogAsset[] = [
  {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    kind: "stablecoin",
  },
  { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "Solana", decimals: 9, kind: "token" },
  {
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    symbol: "TSLAx",
    name: "Tesla xStock",
    decimals: 8,
    kind: "tokenized_stock",
    underlying: "TSLA",
  },
  {
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    symbol: "NVDAx",
    name: "NVIDIA xStock",
    decimals: 8,
    kind: "tokenized_stock",
    underlying: "NVDA",
  },
  {
    mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    symbol: "SPYx",
    name: "SP500 xStock",
    decimals: 8,
    kind: "tokenized_stock",
    underlying: "SPY",
  },
  {
    mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    symbol: "AAPLx",
    name: "Apple xStock",
    decimals: 8,
    kind: "tokenized_stock",
    underlying: "AAPL",
  },
  {
    mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
    symbol: "QQQx",
    name: "Nasdaq xStock",
    decimals: 8,
    kind: "tokenized_stock",
    underlying: "QQQ",
  },
];

const BY_MINT = new Map(SOLANA_CATALOG.map((asset) => [asset.mint, asset]));
const BY_SYMBOL = new Map(SOLANA_CATALOG.map((asset) => [asset.symbol.toLowerCase(), asset]));

export function findCatalogAsset(ref: string): CatalogAsset | null {
  const trimmed = ref.trim();
  return BY_MINT.get(trimmed) ?? BY_SYMBOL.get(trimmed.toLowerCase()) ?? null;
}

/** "TSLA" / "tesla" style lookups map to the xStock wrapper. */
export function findCatalogByUnderlying(ticker: string): CatalogAsset | null {
  const upper = ticker.trim().toUpperCase();
  return SOLANA_CATALOG.find((asset) => asset.underlying === upper) ?? null;
}
