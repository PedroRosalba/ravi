/**
 * Hard trade guardrails. These are evaluated in code at proposal time AND
 * again right before execution; no model output (agent, engine, or Jev) can
 * bypass them. A failing check blocks the trade — there is no "warn and go".
 */

import { readBoolSetting, readNumberSetting, readSetting, splitList } from "./config.js";

export interface RiskCheckInput {
  vaultStatus: "active" | "frozen";
  /** USD notional of the trade's input leg. */
  notionalUsd: number;
  /** USD value of the whole vault before the trade. */
  vaultEquityUsd: number;
  /** USD already executed/approved for this vault in the last 24h. */
  dailyUsedUsd: number;
  slippageBps: number;
  priceImpactPct: number | null;
  /** Non-quote leg being bought or sold (mint). */
  assetId: string;
  liquidityUsd: number | null;
  side: "buy" | "sell";
}

export interface RiskCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface RiskEvaluation {
  allowed: boolean;
  checks: RiskCheck[];
  violations: string[];
  limits: Record<string, number | string | boolean>;
}

export function evaluateTradeRisk(input: RiskCheckInput): RiskEvaluation {
  const limits = {
    killSwitch: readBoolSetting("risk.killSwitch"),
    maxTradeUsd: readNumberSetting("risk.maxTradeUsd"),
    maxDailyUsd: readNumberSetting("risk.maxDailyUsd"),
    maxPositionFraction: readNumberSetting("risk.maxPositionFraction"),
    maxSlippageBps: readNumberSetting("risk.maxSlippageBps"),
    maxPriceImpactPct: readNumberSetting("risk.maxPriceImpactPct"),
    minLiquidityUsd: readNumberSetting("risk.minLiquidityUsd"),
    allowlist: readSetting("risk.allowlist"),
  };
  const allowlist = splitList(limits.allowlist);
  const checks: RiskCheck[] = [];
  const add = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });

  add("kill_switch", !limits.killSwitch, limits.killSwitch ? "Trading is halted by the operator kill switch." : "off");
  add("vault_active", input.vaultStatus === "active", `vault is ${input.vaultStatus}`);
  add(
    "positive_notional",
    Number.isFinite(input.notionalUsd) && input.notionalUsd > 0,
    `notional $${fmt(input.notionalUsd)}`,
  );
  add(
    "max_trade",
    input.notionalUsd <= limits.maxTradeUsd,
    `$${fmt(input.notionalUsd)} vs limit $${fmt(limits.maxTradeUsd)}`,
  );
  add(
    "max_daily",
    input.dailyUsedUsd + input.notionalUsd <= limits.maxDailyUsd,
    `$${fmt(input.dailyUsedUsd)} used + $${fmt(input.notionalUsd)} vs 24h limit $${fmt(limits.maxDailyUsd)}`,
  );
  // Sells reduce exposure, so the concentration cap only applies to buys.
  if (input.side === "buy") {
    const fraction = input.vaultEquityUsd > 0 ? input.notionalUsd / input.vaultEquityUsd : Number.POSITIVE_INFINITY;
    add(
      "max_position_fraction",
      fraction <= limits.maxPositionFraction + 1e-9,
      `${pct(fraction)} of equity vs limit ${pct(limits.maxPositionFraction)}`,
    );
  }
  add(
    "max_slippage",
    input.slippageBps <= limits.maxSlippageBps,
    `${input.slippageBps} bps vs limit ${limits.maxSlippageBps} bps`,
  );
  add(
    "max_price_impact",
    input.priceImpactPct === null || Math.abs(input.priceImpactPct) <= limits.maxPriceImpactPct,
    input.priceImpactPct === null
      ? "no impact reported"
      : `${input.priceImpactPct.toFixed(3)}% vs limit ${limits.maxPriceImpactPct}%`,
  );
  if (allowlist.length > 0) {
    add(
      "allowlist",
      allowlist.includes(input.assetId),
      `asset ${input.assetId} ${allowlist.includes(input.assetId) ? "is" : "is not"} allowlisted`,
    );
  } else {
    // Without an allowlist, demand real liquidity so thin/rug tokens are unreachable.
    add(
      "min_liquidity",
      input.liquidityUsd !== null && input.liquidityUsd >= limits.minLiquidityUsd,
      input.liquidityUsd === null
        ? "liquidity unknown (blocked: configure risk.allowlist or a liquidity source)"
        : `$${fmt(input.liquidityUsd)} vs min $${fmt(limits.minLiquidityUsd)}`,
    );
  }

  const violations = checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`);
  return { allowed: violations.length === 0, checks, violations, limits };
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : String(value);
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "∞";
}
