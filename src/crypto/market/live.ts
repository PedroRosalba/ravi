/**
 * Live market data from free public APIs:
 * - Jupiter (api.jup.ag): prices v3, tokens v2 search, Swap API V2 order/execute.
 *   Optional key via credential broker (provider "jupiter") → `x-api-key`.
 * - GeckoTerminal: daily OHLCV for any Solana token, keyless.
 * - AwesomeAPI: USD/BRL, with CoinGecko and a static setting as fallbacks.
 *
 * Each host is throttled to its free-tier rate and responses are cached briefly.
 */

import { readNumberSetting, readSetting } from "../config.js";
import { readMarketCache, writeMarketCache } from "../db.js";
import { lookupSecret } from "../secrets.js";
import { ASSET_USDC } from "../types.js";
import { findCatalogAsset } from "./catalog.js";
import { MarketDataError, type MarketData, type SwapExecution, type SwapQuote, type TokenInfo } from "./types.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const JUPITER_BASE_URL = "https://api.jup.ag";
export const GECKOTERMINAL_BASE_URL = "https://api.geckoterminal.com/api/v2";
export const AWESOMEAPI_USD_BRL = "https://economia.awesomeapi.com.br/json/last/USD-BRL";
export const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const HISTORY_TTL_MS = 60 * 60_000;
const MAX_RATE_LIMIT_RETRIES = 2;
export const JUPITER_SECRET = {
  provider: "jupiter",
  connection: "default",
  action: "api.read",
  envVar: "JUPITER_API_KEY",
};

export interface LiveMarketDataOptions {
  fetch?: FetchLike;
  jupiterApiKey?: string | null;
  now?: () => number;
  /** Disable throttling (tests). */
  throttle?: boolean;
  /** Base backoff after HTTP 429 (default 3000ms). */
  retryDelayMs?: number;
  /** Share fetched history across processes via the crypto DB (default true). */
  persistentCache?: boolean;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LiveMarketData implements MarketData {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly throttleEnabled: boolean;
  private readonly retryDelayMs: number;
  private readonly persistentCache: boolean;
  private jupiterKey: string | null | undefined;
  private readonly lastCallAt = new Map<string, number>();
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(options: LiveMarketDataOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.throttleEnabled = options.throttle ?? true;
    this.retryDelayMs = options.retryDelayMs ?? 3000;
    this.persistentCache = options.persistentCache ?? true;
    this.jupiterKey = options.jupiterApiKey;
  }

  async getUsdPrices(mints: string[]): Promise<Map<string, { usdPrice: number; liquidityUsd: number | null }>> {
    const out = new Map<string, { usdPrice: number; liquidityUsd: number | null }>();
    const unique = [...new Set(mints.filter(Boolean))];
    const pending: string[] = [];
    for (const mint of unique) {
      const cached = this.getCached<{ usdPrice: number; liquidityUsd: number | null }>(`price:${mint}`);
      if (cached) out.set(mint, cached);
      else pending.push(mint);
    }
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      const body = await this.jupiter<Record<string, { usdPrice?: number; liquidity?: number }>>(
        `/price/v3?ids=${batch.map(encodeURIComponent).join(",")}`,
      );
      for (const mint of batch) {
        const entry = body?.[mint];
        if (entry && typeof entry.usdPrice === "number" && entry.usdPrice > 0) {
          const value = { usdPrice: entry.usdPrice, liquidityUsd: numberOrNull(entry.liquidity) };
          out.set(mint, value);
          this.setCached(`price:${mint}`, value, 15_000);
        }
      }
    }
    return out;
  }

  async getTokenInfo(mint: string): Promise<TokenInfo | null> {
    const cached = this.getCached<TokenInfo | null>(`token:${mint}`);
    if (cached !== undefined) return cached;
    const results = await this.searchTokens(mint);
    const match = results.find((token) => token.mint === mint) ?? null;
    const catalog = findCatalogAsset(mint);
    const info =
      match ??
      (catalog
        ? {
            mint,
            symbol: catalog.symbol,
            name: catalog.name,
            decimals: catalog.decimals,
            isVerified: true,
            tags: [],
            usdPrice: null,
            liquidityUsd: null,
          }
        : null);
    this.setCached(`token:${mint}`, info, 10 * 60_000);
    return info;
  }

  async searchTokens(query: string): Promise<TokenInfo[]> {
    const body = await this.jupiter<unknown[]>(`/tokens/v2/search?query=${encodeURIComponent(query.trim())}`);
    if (!Array.isArray(body)) return [];
    return body.flatMap((raw) => {
      const item = raw as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.decimals !== "number") return [];
      return [
        {
          mint: item.id,
          symbol: typeof item.symbol === "string" ? item.symbol : "?",
          name: typeof item.name === "string" ? item.name : "",
          decimals: item.decimals,
          isVerified: item.isVerified === true,
          tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [],
          usdPrice: numberOrNull(item.usdPrice),
          liquidityUsd: numberOrNull(item.liquidity),
        },
      ];
    });
  }

  async getQuote(input: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    taker?: string;
  }): Promise<SwapQuote> {
    if (input.amount <= 0n) throw new MarketDataError("Quote amount must be positive.", "QUOTE_INVALID_AMOUNT");
    const params = new URLSearchParams({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amount: input.amount.toString(),
    });
    if (input.taker) params.set("taker", input.taker);
    const body = await this.jupiter<Record<string, unknown>>(`/swap/v2/order?${params.toString()}`);
    if (!body || typeof body !== "object") throw new MarketDataError("Empty quote response.", "QUOTE_EMPTY");
    if (typeof body.errorMessage === "string" && body.errorMessage && !body.outAmount) {
      throw new MarketDataError(`Jupiter: ${body.errorMessage}`, "QUOTE_UNAVAILABLE");
    }
    return parseJupiterOrder(body, input, this.now());
  }

  async executeSwap(input: { signedTransaction: string; requestId: string }): Promise<SwapExecution> {
    // Never re-POST a signed transaction: a retry after an ambiguous failure could double-submit.
    const body = await this.jupiter<Record<string, unknown>>(
      "/swap/v2/execute",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
      { retry: false },
    );
    return parseJupiterExecute(body ?? {});
  }

  async getDailyCloses(mint: string, days: number): Promise<number[]> {
    if (mint === ASSET_USDC) return Array.from({ length: days }, () => 1);
    const key = `history:v1:${mint}:${days}`;
    const cached =
      this.getCached<number[]>(key) ?? (this.persistentCache ? readMarketCache<number[]>(key, HISTORY_TTL_MS) : null);
    if (cached) return cached;

    let closes: number[] = [];
    let failure: unknown = null;
    try {
      closes = await this.geckoTerminalCloses(mint, days);
    } catch (error) {
      failure = error;
    }
    // Young on-chain pools have short histories; an xStock tracks its underlying share 1:1.
    const underlying = findCatalogAsset(mint)?.underlying;
    if (underlying && closes.length < Math.min(days, 30)) {
      try {
        const stock = await this.yahooCloses(underlying, days);
        if (stock.length > closes.length) closes = stock;
      } catch (error) {
        failure ??= error;
      }
    }
    if (closes.length < 2) {
      if (failure instanceof MarketDataError) throw failure;
      throw new MarketDataError(`Not enough price history for ${mint}.`, "HISTORY_UNAVAILABLE");
    }
    this.setCached(key, closes, HISTORY_TTL_MS);
    if (this.persistentCache) writeMarketCache(key, closes);
    return closes;
  }

  private async geckoTerminalCloses(mint: string, days: number): Promise<number[]> {
    const pools = await this.request<{ data?: Array<{ attributes?: Record<string, unknown> }> }>(
      "geckoterminal",
      `${GECKOTERMINAL_BASE_URL}/networks/solana/tokens/${encodeURIComponent(mint)}/pools?page=1`,
      { headers: { accept: "application/json" } },
      2100,
    );
    const best = (pools?.data ?? [])
      .map((pool) => pool.attributes ?? {})
      .filter((attrs) => typeof attrs.address === "string")
      .sort((a, b) => Number(b.reserve_in_usd ?? 0) - Number(a.reserve_in_usd ?? 0))[0];
    if (!best) throw new MarketDataError(`No liquidity pool found for ${mint}.`, "HISTORY_UNAVAILABLE");
    const limit = Math.min(Math.max(days, 2), 1000);
    const ohlcv = await this.request<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
      "geckoterminal",
      `${GECKOTERMINAL_BASE_URL}/networks/solana/pools/${best.address}/ohlcv/day?limit=${limit}`,
      { headers: { accept: "application/json" } },
      2100,
    );
    // GeckoTerminal returns newest first: [unixSeconds, open, high, low, close, volume].
    return (ohlcv?.data?.attributes?.ohlcv_list ?? [])
      .filter((row) => Array.isArray(row) && typeof row[4] === "number" && row[4] > 0)
      .sort((a, b) => a[0] - b[0])
      .map((row) => row[4]);
  }

  /** Unofficial Yahoo chart endpoint; requires a User-Agent or it answers 429. */
  private async yahooCloses(ticker: string, days: number): Promise<number[]> {
    const range = days <= 90 ? "3mo" : days <= 180 ? "6mo" : days <= 365 ? "1y" : "2y";
    const body = await this.request<{
      chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    }>(
      "yahoo",
      `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?range=${range}&interval=1d`,
      { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (ravi-crypto)" } },
      1000,
    );
    const closes = body?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    return closes.filter((value): value is number => typeof value === "number" && value > 0).slice(-days);
  }

  async getUsdBrl(): Promise<{ rate: number; source: string; asOf: number }> {
    const cached = this.getCached<{ rate: number; source: string; asOf: number }>("fx:usdbrl");
    if (cached) return cached;
    let result: { rate: number; source: string; asOf: number } | null = null;
    if (readSetting("fx.source") === "awesomeapi") {
      try {
        const body = await this.request<{ USDBRL?: { bid?: string; ask?: string; timestamp?: string } }>(
          "awesomeapi",
          AWESOMEAPI_USD_BRL,
          {},
          500,
        );
        const bid = Number(body?.USDBRL?.bid);
        const ask = Number(body?.USDBRL?.ask);
        if (bid > 0 && ask > 0) {
          const ts = Number(body?.USDBRL?.timestamp);
          result = { rate: (bid + ask) / 2, source: "awesomeapi", asOf: ts > 0 ? ts * 1000 : this.now() };
        }
      } catch {
        // fall through to static
      }
    }
    if (!result) {
      result = { rate: readNumberSetting("fx.staticUsdBrl"), source: "static", asOf: this.now() };
    }
    this.setCached("fx:usdbrl", result, 5 * 60_000);
    return result;
  }

  private async jupiter<T>(path: string, init: RequestInit = {}, options: { retry?: boolean } = {}): Promise<T> {
    if (this.jupiterKey === undefined) this.jupiterKey = await lookupSecret(JUPITER_SECRET);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.jupiterKey) headers.set("x-api-key", this.jupiterKey);
    // Keyless api.jup.ag allows 0.5 rps; the free key tier allows 1 rps.
    return this.request<T>(
      "jupiter",
      `${JUPITER_BASE_URL}${path}`,
      { ...init, headers },
      this.jupiterKey ? 1000 : 2000,
      options.retry ?? true,
    );
  }

  private async request<T>(
    host: string,
    url: string,
    init: RequestInit,
    minIntervalMs: number,
    retry = true,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle(host, minIntervalMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw new MarketDataError(
          `${host} request failed: ${error instanceof Error ? error.message : String(error)}`,
          "MARKET_UNREACHABLE",
        );
      }
      if (retry && response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        // Free tiers are shared across CLI processes; back off instead of failing the command.
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.retryDelayMs * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 15_000)));
        continue;
      }
      if (!response.ok) {
        throw new MarketDataError(
          `${host} HTTP ${response.status}`,
          response.status === 429 ? "MARKET_RATE_LIMITED" : "MARKET_HTTP_ERROR",
        );
      }
      return (await response.json()) as T;
    }
  }

  private async throttle(host: string, minIntervalMs: number): Promise<void> {
    if (!this.throttleEnabled) return;
    const last = this.lastCallAt.get(host) ?? 0;
    const wait = last + minIntervalMs - this.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastCallAt.set(host, this.now());
  }

  private getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry || entry.expiresAt < this.now()) return undefined;
    return entry.value as T;
  }

  private setCached(key: string, value: unknown, ttlMs: number): void {
    this.cache.set(key, { value, expiresAt: this.now() + ttlMs });
  }
}

export function parseJupiterOrder(
  body: Record<string, unknown>,
  input: { inputMint: string; outputMint: string; amount: bigint },
  now: number,
): SwapQuote {
  const inAmount = bigintOr(body.inAmount, input.amount);
  const outAmount = bigintOr(body.outAmount, 0n);
  if (outAmount <= 0n) throw new MarketDataError("Quote returned no output amount.", "QUOTE_UNAVAILABLE");
  const threshold = bigintOr(body.otherAmountThreshold, outAmount);
  const reportedSlippage = numberOrNull(body.slippageBps);
  const derivedSlippage = outAmount > 0n ? Number(((outAmount - threshold) * 10_000n) / outAmount) : 0;
  // `priceImpact` is in percentage points. The deprecated `priceImpactPct` is
  // ambiguous across Jupiter versions, so read it as a fraction ×100 — the
  // larger interpretation — to keep the risk check conservative.
  let priceImpactPct = numberOrNull(body.priceImpact);
  if (priceImpactPct === null) {
    const legacy = numberOrNull(body.priceImpactPct);
    priceImpactPct = legacy === null ? null : Math.abs(legacy) * 100;
  }
  const transaction = typeof body.transaction === "string" && body.transaction.length > 0 ? body.transaction : null;
  return {
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    inAmount,
    outAmount,
    otherAmountThreshold: threshold,
    slippageBps: Math.max(reportedSlippage ?? 0, derivedSlippage),
    priceImpactPct: priceImpactPct === null ? null : Math.abs(priceImpactPct),
    requestId: typeof body.requestId === "string" ? body.requestId : null,
    transaction,
    router: typeof body.router === "string" ? body.router : null,
    source: "jupiter-swap-v2",
    fetchedAt: now,
    reported: {
      inAmount: bigintOrNull(body.inAmount) !== null,
      otherAmountThreshold: bigintOrNull(body.otherAmountThreshold) !== null,
    },
  };
}

export function parseJupiterExecute(body: Record<string, unknown>): SwapExecution {
  const status = body.status === "Success" ? "Success" : "Failed";
  return {
    status,
    signature: typeof body.signature === "string" ? body.signature : null,
    code: typeof body.code === "number" ? body.code : null,
    inputAmount: bigintOrNull(body.inputAmountResult ?? body.totalInputAmount),
    outputAmount: bigintOrNull(body.outputAmountResult ?? body.totalOutputAmount),
    error:
      typeof body.error === "string" ? body.error : status === "Failed" ? `execute code ${String(body.code)}` : null,
  };
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function bigintOrNull(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function bigintOr(value: unknown, fallback: bigint): bigint {
  return bigintOrNull(value) ?? fallback;
}
