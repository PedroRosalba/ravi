import { LiveMarketData } from "./live.js";
import type { MarketData } from "./types.js";

let override: MarketData | null = null;
let live: LiveMarketData | null = null;

/** Process-wide market data client; tests inject a fake with setMarketDataForTest. */
export function getMarketData(): MarketData {
  if (override) return override;
  live ??= new LiveMarketData();
  return live;
}

export function setMarketDataForTest(market: MarketData | null): void {
  override = market;
}

export * from "./catalog.js";
export * from "./types.js";
