import "reflect-metadata";
import {
  strategyListReturnSchema,
  strategyShowReturnSchema,
  strategySyncReturnSchema,
} from "../../crypto/return-schemas.js";
import { contractFail } from "../agent-contract.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { buildCliOffsetPagination, parseCliListLimit, parseCliListOffset } from "../pagination.js";
import { printJsonOr, runOp } from "../../crypto/cli-support.js";
import { getStrategy, listStrategies } from "../../crypto/db.js";
import { syncMiraStrategies } from "../../crypto/engine/mira.js";
import type { CryptoStrategy, StrategySource } from "../../crypto/types.js";

function publicMetrics(metrics: Record<string, unknown>) {
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const components =
    metrics.scoreComponents && typeof metrics.scoreComponents === "object" ? metrics.scoreComponents : {};
  return {
    profitFactor: num(metrics.profitFactor),
    return3mPct: num(metrics.return3mPct),
    worstFallPct: num(metrics.worstFallPct),
    winRatePct: num(metrics.winRatePct),
    trackRecordDays: num(metrics.trackRecordDays),
    pnlPoints: num(metrics.pnlPoints) ?? 0,
    latestPnlUsd: num(metrics.latestPnlUsd),
    minAllocationUsd: num(metrics.minAllocationUsd),
    scoreComponents: Object.fromEntries(
      Object.entries(components as Record<string, unknown>).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>,
    flags: Array.isArray(metrics.flags) ? metrics.flags.map(String) : [],
  };
}

function publicStrategy(strategy: CryptoStrategy) {
  return {
    id: strategy.id,
    source: strategy.source,
    externalId: strategy.externalId,
    name: strategy.name,
    venue: strategy.venue,
    riskLevel: strategy.riskLevel,
    score: strategy.score,
    metrics: publicMetrics(strategy.metrics),
    syncedAt: strategy.syncedAt ? new Date(strategy.syncedAt).toISOString() : null,
  };
}

@Group({
  name: "crypto.strategies",
  description: "Copy-trading strategies (Mira Finance) ranked by Ravi's quant score",
  scope: "open",
})
export class CryptoStrategyCommands {
  @Command({
    name: "sync",
    description:
      "Pull Mira Finance strategies (public endpoint; richer data with a stored session token) and score them",
    helpAfter: `
NOTES
  • Mira strategies trade Hyperliquid perps and hide leader wallet addresses: use them as a ranked research feed.
  • Optional session token: copy localStorage['privy:token'] from app.mirafinance.xyz and store it with
      ravi credentials add --provider mira --connection session --backend keychain --secret-stdin
    (expires in ~1h).
EXAMPLES
  ravi crypto strategies sync --json`,
  })
  @CommandAccess({ kind: "mutate", resource: "crypto.strategies", action: "sync", risk: "low" })
  @Returns(strategySyncReturnSchema)
  async sync(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return runOp("crypto strategies sync", asJson, async () => {
      const result = await syncMiraStrategies();
      const items = result.stored.map(publicStrategy).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const payload = {
        fetched: result.fetched,
        authenticated: result.authenticated,
        warnings: result.warnings,
        items,
      };
      printJsonOr(asJson, payload, () => {
        console.log(`\nSynced ${result.fetched} Mira strategies${result.authenticated ? " (authenticated)" : ""}`);
        for (const s of items.slice(0, 10))
          console.log(`  ${String(s.score ?? "-").padStart(5)}  ${s.name}  (${s.riskLevel ?? "?"})`);
        for (const warning of result.warnings) console.log(`  ! ${warning}`);
      });
      return payload;
    });
  }

  @Command({ name: "list", description: "List stored strategies, best quant score first", aliases: ["ls"] })
  @CommandAccess({ kind: "read", resource: "crypto.strategies", action: "list", risk: "low" })
  @Returns(strategyListReturnSchema)
  async list(
    @Option({ flags: "--source <source>", description: "mira|manual|engine" }) source?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (source && !["mira", "manual", "engine"].includes(source)) {
      contractFail("crypto strategies list", "CRYPTO_INVALID_ARGUMENT", "Invalid --source. Use mira|manual|engine.", {
        asJson,
        exitCode: 2,
      });
    }
    const pageLimit = parseCliListLimit(limit);
    const pageOffset = parseCliListOffset(offset);
    const page = listStrategies({ source: source as StrategySource | undefined, limit: pageLimit, offset: pageOffset });
    const items = page.items.map(publicStrategy);
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crypto", "strategies", "list"],
      limit: pageLimit,
      offset: pageOffset,
      returned: items.length,
      total: page.total,
      options: [source ? "--source" : null, source ?? null],
    });
    const payload = { total: page.total, pagination, items };
    printJsonOr(asJson, payload, () => {
      console.log(`\n${page.total} strateg${page.total === 1 ? "y" : "ies"}`);
      for (const s of items) {
        const m = s.metrics;
        console.log(
          `  ${String(s.score ?? "-").padStart(5)}  ${s.name.padEnd(28)} PF ${m.profitFactor ?? "?"} · 3m ${m.return3mPct ?? "?"}% · DD ${m.worstFallPct ?? "?"}% · WR ${m.winRatePct ?? "?"}%`,
        );
      }
      if (page.total === 0) console.log("  Run `ravi crypto strategies sync` first.");
    });
    return payload;
  }

  @Command({ name: "show", description: "Show one strategy with its score components and flags" })
  @CommandAccess({ kind: "read", resource: "crypto.strategies", action: "show", risk: "low" })
  @Returns(strategyShowReturnSchema)
  async show(
    @Arg("strategyId", { description: "Strategy id (stg_…) or external id" }) strategyId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const strategy = getStrategy(strategyId);
    if (!strategy) {
      return contractFail("crypto strategies show", "CRYPTO_STRATEGY_NOT_FOUND", `Strategy not found: ${strategyId}`, {
        asJson,
        details: { suggestedAction: "List with `ravi crypto strategies list`." },
      });
    }
    const payload = { strategy: publicStrategy(strategy) };
    printJsonOr(asJson, payload, () => console.log(JSON.stringify(payload.strategy, null, 2)));
    return payload;
  }
}
