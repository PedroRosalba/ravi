/**
 * Signal engines. Each turns market/wallet data into `crypto_signals` rows that
 * agents read (`ravi crypto signals list`) and can turn into trade proposals.
 * Engines never trade; every signal still goes through proposeTrade's risk
 * limits, Jev gate (origin=engine), and operator approval.
 *
 * - smart-money: distinct quality-weighted watched wallets accumulating the
 *   same verified token inside a window (copy-trade consensus).
 * - momentum: trend/momentum regime on a watchlist (xStocks by default).
 */

import { readBoolSetting, readNumberSetting, readSetting, splitList } from "../config.js";
import { insertSignal, listWalletEventsSince, listWatchedWallets } from "../db.js";
import { judgeWithJev, type JevJudgement } from "../jev.js";
import { SOLANA_CATALOG, getMarketData, type MarketData } from "../market/index.js";
import { smartMoneyConsensus } from "../quant/scoring.js";
import { clamp, round, summarizePriceSeries, type SeriesSummary } from "../quant/stats.js";
import { CryptoServiceError, resolveTradableAsset } from "../service.js";
import { getCryptoNotifier } from "../notify.js";
import { ASSET_SOL, ASSET_USDC, type CryptoAsset, type CryptoSignal } from "../types.js";

export type EngineId = "smart-money" | "momentum";
export const ENGINE_IDS: EngineId[] = ["smart-money", "momentum"];

export interface EngineRunReport {
  engine: EngineId;
  candidates: number;
  signals: CryptoSignal[];
  skipped: Array<{ asset: string; reason: string }>;
}

export async function runEngines(
  engines: EngineId[] = ENGINE_IDS,
  options: { market?: MarketData; now?: number } = {},
): Promise<EngineRunReport[]> {
  const reports: EngineRunReport[] = [];
  for (const engine of engines) {
    reports.push(engine === "smart-money" ? await runSmartMoney(options) : await runMomentum(options));
  }
  return reports;
}

async function maybeJudge(
  asset: CryptoAsset,
  kind: "copy_trade" | "momentum",
  direction: "buy" | "sell",
  features: Record<string, number | string | boolean | null>,
): Promise<JevJudgement | null> {
  if (!readBoolSetting("jev.enabled")) return null;
  return judgeWithJev({
    kind,
    side: direction,
    asset: { symbol: asset.symbol, mint: asset.id, category: asset.kind },
    features,
    // Engine signals are portfolio-agnostic; sizing happens per vault at proposal time.
    portfolio: { riskProfile: "moderate", equityUsd: 0, proposedNotionalUsd: 0, proposedFraction: 0 },
  });
}

export async function runSmartMoney(options: { market?: MarketData; now?: number } = {}): Promise<EngineRunReport> {
  const market = options.market ?? getMarketData();
  const now = options.now ?? Date.now();
  const windowMs = readNumberSetting("engine.windowHours") * 3_600_000;
  const events = listWalletEventsSince(now - windowMs);
  const wallets = listWatchedWallets({ limit: 500, offset: 0 }).items;
  const scores = new Map<string, number>();
  for (const wallet of wallets) {
    const score = Number(wallet.metrics.score);
    if (Number.isFinite(score)) scores.set(wallet.id, clamp(score, 0, 1));
  }
  const candidates = smartMoneyConsensus(
    events.map((event) => ({
      walletId: event.walletId,
      tokenIn: event.tokenIn,
      tokenOut: event.tokenOut,
      usdValue: event.usdValue,
      occurredAt: event.occurredAt,
    })),
    {
      quoteAssets: new Set([ASSET_USDC, ASSET_SOL]),
      walletScores: scores,
      minDistinctWallets: readNumberSetting("engine.minDistinctWallets"),
    },
  );

  const report: EngineRunReport = { engine: "smart-money", candidates: candidates.length, signals: [], skipped: [] };
  for (const candidate of candidates.slice(0, 10)) {
    let asset: CryptoAsset;
    try {
      asset = await resolveTradableAsset(candidate.assetId, market);
    } catch (error) {
      report.skipped.push({
        asset: candidate.assetId,
        reason: error instanceof CryptoServiceError ? error.code : "resolve_failed",
      });
      continue;
    }
    const history = await safeSummary(asset, market);
    const features = {
      distinctWallets: candidate.distinctWallets,
      weightedWallets: candidate.weightedWallets,
      totalUsd: candidate.totalUsd,
      minutesSinceFirstBuy: round((now - candidate.firstSeenAt) / 60_000, 1),
      minutesSinceLastBuy: round((now - candidate.lastSeenAt) / 60_000, 1),
      ...(history ? flatten(history) : { historyDays: 0 }),
    };
    const judge = await maybeJudge(asset, "copy_trade", candidate.direction, features);
    if (judge && !judge.passed) {
      report.skipped.push({ asset: asset.symbol, reason: `jev: ${judge.reasons.join("; ")}` });
      continue;
    }
    const signal = insertSignal({
      engine: "smart-money",
      assetId: asset.id,
      symbol: asset.symbol,
      direction: candidate.direction,
      strength: candidate.strength,
      confidence: judge ? judge.confidence : round(0.4 + 0.4 * candidate.strength, 3),
      features,
      rationale: `${candidate.distinctWallets} watched wallets ${candidate.direction === "buy" ? "bought" : "sold"} ${asset.symbol} (~$${Math.round(candidate.totalUsd)}) in the last ${readNumberSetting("engine.windowHours")}h.`,
      judge: judge as unknown as Record<string, unknown> | null,
      expiresAt: now + readNumberSetting("engine.signalTtlMinutes") * 60_000,
    });
    report.signals.push(signal);
    await getCryptoNotifier().publish("signal.created", {
      signalId: signal.id,
      engine: signal.engine,
      asset: asset.symbol,
      direction: signal.direction,
      status: signal.status,
    });
  }
  return report;
}

/**
 * Trend/momentum regime:
 *   buy  when 30d momentum > 0, price above SMA20, positive 30d trend slope, RSI < 75,
 *        and a positive risk-adjusted return over the whole window (Sharpe > 0) so a
 *        bounce inside a losing period is not mistaken for an uptrend
 *   sell when 30d momentum < 0 and price below SMA20
 * Strength blends risk-adjusted momentum (Sharpe) and trend consistency.
 */
export async function runMomentum(options: { market?: MarketData; now?: number } = {}): Promise<EngineRunReport> {
  const market = options.market ?? getMarketData();
  const now = options.now ?? Date.now();
  const configured = splitList(readSetting("engine.watchlist"));
  const watchlist =
    configured.length > 0 ? configured : SOLANA_CATALOG.filter((a) => a.kind === "tokenized_stock").map((a) => a.mint);
  const report: EngineRunReport = { engine: "momentum", candidates: watchlist.length, signals: [], skipped: [] };

  for (const ref of watchlist) {
    let asset: CryptoAsset;
    try {
      asset = await resolveTradableAsset(ref, market);
    } catch (error) {
      report.skipped.push({ asset: ref, reason: error instanceof CryptoServiceError ? error.code : "resolve_failed" });
      continue;
    }
    const summary = await safeSummary(asset, market);
    if (!summary || summary.observations < 30) {
      report.skipped.push({ asset: asset.symbol, reason: "insufficient_history" });
      continue;
    }
    const decision = classifyMomentum(summary);
    if (decision.direction === "hold") {
      report.skipped.push({ asset: asset.symbol, reason: decision.reason });
      continue;
    }
    const features = flatten(summary);
    const judge = await maybeJudge(asset, "momentum", decision.direction, features);
    if (judge && !judge.passed) {
      report.skipped.push({ asset: asset.symbol, reason: `jev: ${judge.reasons.join("; ")}` });
      continue;
    }
    const signal = insertSignal({
      engine: "momentum",
      assetId: asset.id,
      symbol: asset.symbol,
      direction: decision.direction,
      strength: decision.strength,
      confidence: judge ? judge.confidence : round(0.35 + 0.4 * decision.strength, 3),
      features,
      rationale: decision.reason,
      judge: judge as unknown as Record<string, unknown> | null,
      expiresAt: now + readNumberSetting("engine.signalTtlMinutes") * 60_000,
    });
    report.signals.push(signal);
    await getCryptoNotifier().publish("signal.created", {
      signalId: signal.id,
      engine: signal.engine,
      asset: asset.symbol,
      direction: signal.direction,
      status: signal.status,
    });
  }
  return report;
}

export function classifyMomentum(summary: SeriesSummary): {
  direction: "buy" | "sell" | "hold";
  strength: number;
  reason: string;
} {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  if (
    summary.momentum30 > 0 &&
    summary.aboveSma20 === true &&
    summary.trendSlope > 0 &&
    summary.sharpe > 0 &&
    (summary.rsi14 === null || summary.rsi14 < 75)
  ) {
    const strength = round(
      clamp(0.5 * clamp(summary.sharpe / 3, 0, 1) + 0.5 * clamp(summary.momentum30 / 0.2, 0, 1), 0, 1),
      3,
    );
    return {
      direction: "buy",
      strength,
      reason: `Uptrend: +${pct(summary.momentum30)} in 30d, above SMA20, Sharpe ${summary.sharpe.toFixed(2)}, RSI ${summary.rsi14?.toFixed(0) ?? "n/a"}, max DD ${pct(summary.maxDrawdown)}.`,
    };
  }
  if (summary.momentum30 < 0 && summary.aboveSma20 === false) {
    const strength = round(clamp(Math.abs(summary.momentum30) / 0.2, 0, 1), 3);
    return {
      direction: "sell",
      strength,
      reason: `Downtrend: ${pct(summary.momentum30)} in 30d and below SMA20; consider trimming exposure.`,
    };
  }
  let reason = "no clear trend";
  if (summary.rsi14 !== null && summary.rsi14 >= 75) reason = "overbought (RSI ≥ 75)";
  else if (summary.momentum30 > 0 && summary.sharpe <= 0) reason = "short-term bounce in a losing window (Sharpe ≤ 0)";
  return { direction: "hold", strength: 0, reason };
}

async function safeSummary(asset: CryptoAsset, market: MarketData): Promise<SeriesSummary | null> {
  try {
    const closes = await market.getDailyCloses(asset.id, 90);
    return summarizePriceSeries(closes, asset.kind === "tokenized_stock" ? 252 : 365);
  } catch {
    return null;
  }
}

function flatten(summary: SeriesSummary): Record<string, number | string | boolean | null> {
  return { ...summary } as unknown as Record<string, number | string | boolean | null>;
}
