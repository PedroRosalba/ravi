/**
 * Scoring for copy-trade sources: curated strategies (Mira) and individual
 * watched wallets, plus smart-money consensus across wallets.
 */

import { clamp, linearFitR2, normalizedTrendSlope, round } from "./stats.js";

export interface StrategyMetricsInput {
  profitFactor: number | null;
  /** Percent, e.g. 12.5 for +12.5% over the last three months. */
  return3mPct: number | null;
  /** Percent, positive number for the worst peak-to-trough fall (e.g. 18 for -18%). */
  worstFallPct: number | null;
  winRatePct: number | null;
  trackRecordDays: number | null;
  /** Cumulative realized PnL curve in USD, oldest → newest. */
  pnlCurve: number[];
}

export interface StrategyScore {
  score: number;
  components: Record<string, number>;
  flags: string[];
}

const STRATEGY_WEIGHTS = {
  profitFactor: 0.25,
  returnOverDrawdown: 0.25,
  consistency: 0.2,
  winRate: 0.1,
  trackRecord: 0.1,
  drawdown: 0.1,
} as const;

/**
 * 0-100 quality score. Rewards edge (profit factor), return per unit of pain
 * (3m return / worst fall), and a steady upward equity curve; penalizes short
 * track records and deep drawdowns. Missing metrics score 0 for that component
 * rather than being imputed, so thin data cannot look good.
 */
export function scoreStrategy(input: StrategyMetricsInput): StrategyScore {
  const flags: string[] = [];
  const components: Record<string, number> = {};

  components.profitFactor = input.profitFactor === null ? 0 : clamp((input.profitFactor - 1) / 1.5, 0, 1);
  if (input.profitFactor !== null && input.profitFactor < 1.2) flags.push("thin_edge");

  if (input.return3mPct !== null && input.worstFallPct !== null) {
    const fall = Math.max(input.worstFallPct, 1);
    components.returnOverDrawdown = clamp(input.return3mPct / fall / 2, 0, 1);
  } else {
    components.returnOverDrawdown = 0;
  }

  const curve = input.pnlCurve;
  if (curve.length >= 5) {
    const slope = normalizedTrendSlope(curve.map((value) => value + Math.abs(Math.min(0, ...curve)) + 1));
    components.consistency = slope > 0 ? clamp(linearFitR2(curve), 0, 1) : 0;
  } else {
    components.consistency = 0;
    flags.push("sparse_pnl_history");
  }

  components.winRate = input.winRatePct === null ? 0 : clamp((input.winRatePct - 35) / 30, 0, 1);
  components.trackRecord = input.trackRecordDays === null ? 0 : clamp(input.trackRecordDays / 365, 0, 1);
  if (input.trackRecordDays !== null && input.trackRecordDays < 90) flags.push("short_track_record");

  components.drawdown = input.worstFallPct === null ? 0 : clamp(1 - input.worstFallPct / 50, 0, 1);
  if (input.worstFallPct !== null && input.worstFallPct > 30) flags.push("deep_drawdown");

  let total = 0;
  for (const [key, weight] of Object.entries(STRATEGY_WEIGHTS)) {
    total += (components[key] ?? 0) * weight;
  }
  for (const key of Object.keys(components)) components[key] = round(components[key], 3);
  return { score: round(total * 100, 1), components, flags };
}

export interface WalletTradeObservation {
  walletId: string;
  /** Token the wallet acquired; null for pure transfers. */
  tokenOut: string | null;
  /** Token the wallet gave up. */
  tokenIn: string | null;
  usdValue: number | null;
  occurredAt: number;
}

export interface ConsensusCandidate {
  assetId: string;
  direction: "buy" | "sell";
  distinctWallets: number;
  weightedWallets: number;
  totalUsd: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** 0-1: saturating function of quality-weighted distinct wallets. */
  strength: number;
}

/**
 * Smart-money consensus: a token several independent, high-quality wallets are
 * accumulating (or dumping) inside the window. One whale buying many times
 * counts once; quality comes from each wallet's score (0-1, default 0.5).
 *
 * `quoteAssets` are the "cash" legs (USDC, SOL, …) that define buy vs. sell.
 */
export function smartMoneyConsensus(
  observations: readonly WalletTradeObservation[],
  options: {
    quoteAssets: ReadonlySet<string>;
    walletScores?: ReadonlyMap<string, number>;
    minDistinctWallets?: number;
    minUsdPerTrade?: number;
  },
): ConsensusCandidate[] {
  const minWallets = options.minDistinctWallets ?? 2;
  const minUsd = options.minUsdPerTrade ?? 0;
  const buckets = new Map<
    string,
    { assetId: string; direction: "buy" | "sell"; wallets: Set<string>; usd: number; first: number; last: number }
  >();

  for (const obs of observations) {
    if ((obs.usdValue ?? 0) < minUsd) continue;
    let assetId: string | null = null;
    let direction: "buy" | "sell" | null = null;
    if (obs.tokenOut && !options.quoteAssets.has(obs.tokenOut) && obs.tokenIn && options.quoteAssets.has(obs.tokenIn)) {
      assetId = obs.tokenOut;
      direction = "buy";
    } else if (
      obs.tokenIn &&
      !options.quoteAssets.has(obs.tokenIn) &&
      obs.tokenOut &&
      options.quoteAssets.has(obs.tokenOut)
    ) {
      assetId = obs.tokenIn;
      direction = "sell";
    }
    if (!assetId || !direction) continue;
    const key = `${direction}:${assetId}`;
    const bucket = buckets.get(key) ?? {
      assetId,
      direction,
      wallets: new Set<string>(),
      usd: 0,
      first: obs.occurredAt,
      last: obs.occurredAt,
    };
    bucket.wallets.add(obs.walletId);
    bucket.usd += obs.usdValue ?? 0;
    bucket.first = Math.min(bucket.first, obs.occurredAt);
    bucket.last = Math.max(bucket.last, obs.occurredAt);
    buckets.set(key, bucket);
  }

  const candidates: ConsensusCandidate[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.wallets.size < minWallets) continue;
    let weighted = 0;
    for (const walletId of bucket.wallets) weighted += clamp(options.walletScores?.get(walletId) ?? 0.5, 0, 1);
    candidates.push({
      assetId: bucket.assetId,
      direction: bucket.direction,
      distinctWallets: bucket.wallets.size,
      weightedWallets: round(weighted, 3),
      totalUsd: round(bucket.usd, 2),
      firstSeenAt: bucket.first,
      lastSeenAt: bucket.last,
      strength: round(1 - Math.exp(-weighted / 2), 3),
    });
  }
  return candidates.sort((a, b) => b.strength - a.strength || b.totalUsd - a.totalUsd);
}
