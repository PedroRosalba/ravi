/**
 * Pure quantitative helpers. Inputs are plain number series ordered oldest →
 * newest. Nothing here touches the ledger; results feed signals, sizing, and
 * the Jev judge's state (Jev is weak at arithmetic, so we pre-compute).
 */

export const TRADING_DAYS_PER_YEAR = 252;
export const CRYPTO_DAYS_PER_YEAR = 365;

export function simpleReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    if (prev > 0 && Number.isFinite(prices[i])) out.push(prices[i] / prev - 1);
  }
  return out;
}

export function logReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const next = prices[i];
    if (prev > 0 && next > 0) out.push(Math.log(next / prev));
  }
  return out;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Sample standard deviation (n - 1). */
export function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((total, value) => total + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function annualizedVolatility(returns: readonly number[], periodsPerYear = CRYPTO_DAYS_PER_YEAR): number {
  return stdev(returns) * Math.sqrt(periodsPerYear);
}

export function sharpeRatio(
  returns: readonly number[],
  options: { riskFreeRate?: number; periodsPerYear?: number } = {},
): number {
  const periods = options.periodsPerYear ?? CRYPTO_DAYS_PER_YEAR;
  const rfPerPeriod = (options.riskFreeRate ?? 0) / periods;
  const excess = returns.map((value) => value - rfPerPeriod);
  const sd = stdev(excess);
  if (sd === 0) return 0;
  return (mean(excess) / sd) * Math.sqrt(periods);
}

export function sortinoRatio(
  returns: readonly number[],
  options: { riskFreeRate?: number; periodsPerYear?: number } = {},
): number {
  const periods = options.periodsPerYear ?? CRYPTO_DAYS_PER_YEAR;
  const rfPerPeriod = (options.riskFreeRate ?? 0) / periods;
  const excess = returns.map((value) => value - rfPerPeriod);
  if (excess.length < 2) return 0;
  const downside = Math.sqrt(excess.reduce((total, value) => total + Math.min(0, value) ** 2, 0) / excess.length);
  if (downside === 0) return mean(excess) > 0 ? Number.POSITIVE_INFINITY : 0;
  return (mean(excess) / downside) * Math.sqrt(periods);
}

/** Max peak-to-trough decline of an equity/price curve, as a positive fraction (0.25 = -25%). */
export function maxDrawdown(curve: readonly number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const value of curve) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.max(worst, (peak - value) / peak);
  }
  return worst;
}

/** Equity curve from cumulative PnL in currency (e.g. Mira's cumulative_realized_pnl) with a notional base. */
export function equityFromCumulativePnl(cumulativePnl: readonly number[], base: number): number[] {
  return cumulativePnl.map((pnl) => base + pnl);
}

export function totalReturn(prices: readonly number[]): number {
  if (prices.length < 2 || prices[0] <= 0) return 0;
  return prices[prices.length - 1] / prices[0] - 1;
}

/** Return over the last `lookback` periods. */
export function momentum(prices: readonly number[], lookback: number): number {
  if (prices.length <= lookback || lookback <= 0) return 0;
  const start = prices[prices.length - 1 - lookback];
  return start > 0 ? prices[prices.length - 1] / start - 1 : 0;
}

export function ema(values: readonly number[], period: number): number[] {
  if (values.length === 0 || period <= 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function sma(values: readonly number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  return mean(values.slice(values.length - period));
}

/** Wilder RSI of the full series; returns null when there is not enough data. */
export function rsi(prices: readonly number[], period = 14): number | null {
  if (prices.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** z-score of the latest value against the trailing window. */
export function zScore(values: readonly number[], window = values.length): number {
  if (values.length < 2) return 0;
  const slice = values.slice(Math.max(0, values.length - window));
  const sd = stdev(slice);
  return sd === 0 ? 0 : (slice[slice.length - 1] - mean(slice)) / sd;
}

export function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const xa = a.slice(a.length - n);
  const xb = b.slice(b.length - n);
  const ma = mean(xa);
  const mb = mean(xb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (xa[i] - ma) * (xb[i] - mb);
    va += (xa[i] - ma) ** 2;
    vb += (xb[i] - mb) ** 2;
  }
  return va === 0 || vb === 0 ? 0 : cov / Math.sqrt(va * vb);
}

/** Historical Value-at-Risk at `confidence` (0.95 → 5% worst period), as a positive loss fraction. */
export function historicalVaR(returns: readonly number[], confidence = 0.95): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((x, y) => x - y);
  // k-th worst observation, k = ceil(n * (1 - confidence)); epsilon absorbs float artifacts.
  const k = Math.ceil((1 - confidence) * sorted.length - 1e-9);
  const index = Math.min(sorted.length - 1, Math.max(0, k - 1));
  return Math.max(0, -sorted[index]);
}

/** Expected shortfall (CVaR): mean loss beyond VaR, positive fraction. */
export function conditionalVaR(returns: readonly number[], confidence = 0.95): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((x, y) => x - y);
  // Epsilon guards float artifacts like (1 - 0.8) * 10 = 1.9999999999999996.
  const cutoff = Math.max(1, Math.floor((1 - confidence) * sorted.length + 1e-9));
  return Math.max(0, -mean(sorted.slice(0, cutoff)));
}

/** Fraction of positive periods. */
export function hitRate(returns: readonly number[]): number {
  if (returns.length === 0) return 0;
  return returns.filter((value) => value > 0).length / returns.length;
}

/** Linear-regression slope of the series normalized by its mean, per period. Robust trend proxy. */
export function normalizedTrendSlope(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (values[i] - yMean);
    denominator += (i - xMean) ** 2;
  }
  if (denominator === 0 || yMean === 0) return 0;
  return numerator / denominator / Math.abs(yMean);
}

/** R² of a linear fit; 1 = perfectly steady curve. Used to reward smooth equity curves. */
export function linearFitR2(values: readonly number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - xMean) * (values[i] - yMean);
    sxx += (i - xMean) ** 2;
    syy += (values[i] - yMean) ** 2;
  }
  if (sxx === 0 || syy === 0) return 0;
  return (sxy * sxy) / (sxx * syy);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface SeriesSummary {
  observations: number;
  totalReturn: number;
  momentum7: number;
  momentum30: number;
  annualizedVolatility: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  var95: number;
  cvar95: number;
  rsi14: number | null;
  trendSlope: number;
  aboveSma20: boolean | null;
}

/** One-call summary used by engines and by `ravi crypto quant`. */
export function summarizePriceSeries(prices: readonly number[], periodsPerYear = CRYPTO_DAYS_PER_YEAR): SeriesSummary {
  const returns = simpleReturns(prices);
  const sma20 = sma(prices, 20);
  const last = prices[prices.length - 1];
  return {
    observations: prices.length,
    totalReturn: round(totalReturn(prices)),
    momentum7: round(momentum(prices, 7)),
    momentum30: round(momentum(prices, 30)),
    annualizedVolatility: round(annualizedVolatility(returns, periodsPerYear)),
    sharpe: round(sharpeRatio(returns, { periodsPerYear })),
    sortino: round(clamp(sortinoRatio(returns, { periodsPerYear }), -100, 100)),
    maxDrawdown: round(maxDrawdown(prices)),
    var95: round(historicalVaR(returns)),
    cvar95: round(conditionalVaR(returns)),
    rsi14: (() => {
      const value = rsi(prices, 14);
      return value === null ? null : round(value, 2);
    })(),
    trendSlope: round(normalizedTrendSlope(prices.slice(-30)), 6),
    aboveSma20: sma20 === null || last === undefined ? null : last > sma20,
  };
}
