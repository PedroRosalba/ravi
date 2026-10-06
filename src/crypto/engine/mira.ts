/**
 * Mira Finance strategy source.
 *
 * Mira curates copy-trading "strategies" (anonymized leader traders) on
 * Hyperliquid perps. Leader wallet addresses are NOT exposed to regular users,
 * so Ravi treats Mira as a ranked research feed: it pulls each strategy's
 * performance stats and scores them with ../quant/scoring.ts. Ravi does not
 * execute Hyperliquid trades in v0.
 *
 * - Public, no auth:  GET https://api.mirafinance.xyz/strategies/public
 * - Authenticated (optional): Privy JWT from the user's browser session stored
 *   in the credential broker (provider "mira", connection "session") enables
 *   /strategies/performance-summaries. Tokens expire in ~1h.
 * These endpoints are undocumented app APIs and may change.
 */

import { upsertStrategy } from "../db.js";
import { scoreStrategy } from "../quant/scoring.js";
import { lookupSecret } from "../secrets.js";
import type { CryptoStrategy } from "../types.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const MIRA_API = "https://api.mirafinance.xyz";
export const MIRA_SECRET = { provider: "mira", connection: "session", action: "strategies.read", envVar: "MIRA_TOKEN" };

export interface MiraStrategyRaw {
  id: string;
  display_name?: string;
  risk_level?: string;
  min_allocation_usd?: string | number;
  profit_factor?: string | number | null;
  last_three_months_profit_percent?: string | number | null;
  worst_fall_percent?: string | number | null;
  win_rate_percent?: string | number | null;
  track_record_started_at?: string | null;
  cumulative_realized_pnl?: Array<{ timestamp: string | number; pnl_usd: string | number }>;
}

export interface MiraSyncResult {
  fetched: number;
  stored: CryptoStrategy[];
  authenticated: boolean;
  warnings: string[];
}

export async function syncMiraStrategies(options: { fetch?: FetchLike; now?: number } = {}): Promise<MiraSyncResult> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now();
  const warnings: string[] = [];
  const response = await fetchImpl(`${MIRA_API}/strategies/public`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Mira /strategies/public returned HTTP ${response.status}`);
  const body = (await response.json()) as unknown;
  const list = extractList(body);

  // Optional enrichment with the user's session token.
  const summaries = new Map<string, MiraStrategyRaw>();
  const token = await lookupSecret(MIRA_SECRET);
  let authenticated = false;
  if (token) {
    try {
      const enriched = await fetchImpl(`${MIRA_API}/strategies/performance-summaries`, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (enriched.ok) {
        authenticated = true;
        const data = (await enriched.json()) as { summaries?: Array<MiraStrategyRaw & { strategy_id?: string }> };
        for (const summary of data.summaries ?? []) {
          if (summary.strategy_id) summaries.set(summary.strategy_id, summary);
        }
      } else {
        warnings.push(`Mira session token rejected (HTTP ${enriched.status}); refresh it from the browser.`);
      }
    } catch (error) {
      warnings.push(`Mira enrichment failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const stored = list.map((raw) => storeMiraStrategy({ ...raw, ...(summaries.get(raw.id) ?? {}) }, now));
  return { fetched: list.length, stored, authenticated, warnings };
}

export function storeMiraStrategy(raw: MiraStrategyRaw, now = Date.now()): CryptoStrategy {
  const pnlCurve = (raw.cumulative_realized_pnl ?? [])
    .map((point) => ({ t: toMillis(point.timestamp), pnl: Number(point.pnl_usd) }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.pnl))
    .sort((a, b) => a.t - b.t)
    .map((point) => point.pnl);
  const startedAt = raw.track_record_started_at ? Date.parse(raw.track_record_started_at) : Number.NaN;
  const metrics = {
    profitFactor: num(raw.profit_factor),
    return3mPct: num(raw.last_three_months_profit_percent),
    worstFallPct: num(raw.worst_fall_percent) === null ? null : Math.abs(num(raw.worst_fall_percent) as number),
    winRatePct: num(raw.win_rate_percent),
    trackRecordDays: Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 86_400_000)) : null,
    pnlCurve,
  };
  const score = scoreStrategy(metrics);
  return upsertStrategy({
    source: "mira",
    externalId: raw.id,
    name: raw.display_name ?? raw.id,
    venue: "hyperliquid",
    riskLevel: raw.risk_level ?? null,
    metrics: {
      ...metrics,
      pnlCurve: undefined,
      pnlPoints: pnlCurve.length,
      latestPnlUsd: pnlCurve.length > 0 ? pnlCurve[pnlCurve.length - 1] : null,
      minAllocationUsd: num(raw.min_allocation_usd),
      scoreComponents: score.components,
      flags: score.flags,
    },
    score: score.score,
  });
}

function extractList(body: unknown): MiraStrategyRaw[] {
  const items = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? ((body as Record<string, unknown>).strategies ?? (body as Record<string, unknown>).data ?? [])
      : [];
  return (Array.isArray(items) ? items : []).filter((item): item is MiraStrategyRaw =>
    Boolean(item && typeof item === "object" && typeof (item as MiraStrategyRaw).id === "string"),
  );
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toMillis(value: string | number): number {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number(value) < 1e12 ? Number(value) * 1000 : Number(value);
}
