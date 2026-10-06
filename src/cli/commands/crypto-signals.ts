import "reflect-metadata";
import { signalListReturnSchema, signalScanReturnSchema } from "../../crypto/return-schemas.js";
import { contractFail } from "../agent-contract.js";
import { Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { buildCliOffsetPagination, parseCliListLimit, parseCliListOffset } from "../pagination.js";
import { printJsonOr, runOp } from "../../crypto/cli-support.js";
import { listSignals } from "../../crypto/db.js";
import { ENGINE_IDS, runEngines, type EngineId } from "../../crypto/engine/signals.js";
import type { CryptoSignal, SignalStatus } from "../../crypto/types.js";

const SIGNAL_STATUSES: SignalStatus[] = ["active", "expired", "acted", "dismissed"];

function scalarRecord(value: Record<string, unknown>): Record<string, number | string | boolean | null> {
  const out: Record<string, number | string | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      entry === null || typeof entry === "number" || typeof entry === "string" || typeof entry === "boolean"
        ? entry
        : JSON.stringify(entry);
  }
  return out;
}

function publicSignal(signal: CryptoSignal) {
  return {
    id: signal.id,
    engine: signal.engine,
    symbol: signal.symbol,
    assetId: signal.assetId,
    direction: signal.direction,
    strength: signal.strength,
    confidence: signal.confidence,
    rationale: signal.rationale,
    judge: signal.judge
      ? {
          verdict: String(signal.judge.verdict ?? "skip"),
          confidence: Number(signal.judge.confidence) || 0,
          rugRisk: typeof signal.judge.rugRisk === "number" ? signal.judge.rugRisk : null,
        }
      : null,
    features: scalarRecord(signal.features),
    status: signal.status,
    createdAt: new Date(signal.createdAt).toISOString(),
    expiresAt: new Date(signal.expiresAt).toISOString(),
  };
}

@Group({
  name: "crypto.signals",
  description: "Trade ideas from Ravi's engines (smart-money copy signals, momentum) — research, never auto-executed",
  scope: "open",
})
export class CryptoSignalCommands {
  @Command({
    name: "list",
    description: "List engine signals (default: active)",
    aliases: ["ls"],
    helpAfter: `
USE
  ✓ "o que eu deveria comprar?", "tem alguma oportunidade?" — show ideas with their rationale and numbers.
REGRAS HARD
  • A signal is not a recommendation to a specific person; present it with its risks.
  • Turning a signal into a trade requires the person's explicit request:
      ravi crypto trades propose buy <symbol> <amount> --signal <id>
EXAMPLES
  ravi crypto signals list --json
  ravi crypto signals list --engine smart-money --json`,
  })
  @CommandAccess({ kind: "read", resource: "crypto.signals", action: "list", risk: "low" })
  @Returns(signalListReturnSchema)
  async list(
    @Option({ flags: "--status <status>", description: `Filter (default: active): ${SIGNAL_STATUSES.join("|")}` })
    status?: string,
    @Option({ flags: "--engine <id>", description: `Filter by engine: ${ENGINE_IDS.join("|")}` }) engine?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto signals list";
    const effectiveStatus = (status ?? "active") as SignalStatus;
    if (!SIGNAL_STATUSES.includes(effectiveStatus)) {
      contractFail(op, "CRYPTO_INVALID_ARGUMENT", `Invalid --status. Use ${SIGNAL_STATUSES.join("|")}.`, {
        asJson,
        exitCode: 2,
      });
    }
    const pageLimit = parseCliListLimit(limit);
    const pageOffset = parseCliListOffset(offset);
    const page = listSignals({ status: effectiveStatus, engine, limit: pageLimit, offset: pageOffset });
    const items = page.items.map(publicSignal);
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crypto", "signals", "list"],
      limit: pageLimit,
      offset: pageOffset,
      returned: items.length,
      total: page.total,
      options: [status ? "--status" : null, status ?? null, engine ? "--engine" : null, engine ?? null],
    });
    const payload = { total: page.total, pagination, items };
    printJsonOr(asJson, payload, () => {
      console.log(`\n${page.total} ${effectiveStatus} signal(s)`);
      for (const s of items) {
        console.log(
          `  ${s.id}  ${s.engine.padEnd(11)} ${s.direction.toUpperCase().padEnd(4)} ${String(s.symbol).padEnd(8)} strength ${s.strength.toFixed(2)}  ${s.rationale}`,
        );
      }
      if (items.length === 0) console.log("  Run `ravi crypto signals scan` to refresh.");
    });
    return payload;
  }

  @Command({
    name: "scan",
    description: "Run the signal engines now (smart-money over watched wallets, momentum over the watchlist)",
    helpAfter: `
NOTES
  • Reads market data (rate-limited public APIs); can take ~30s for a full watchlist.
  • With jev.enabled=true each candidate is judged by Jev and skipped unless it passes.
  • Schedule it: ravi cron add "crypto scan" --every 1h --message "Rode ravi crypto signals scan e resuma os sinais novos"
EXAMPLES
  ravi crypto signals scan --json
  ravi crypto signals scan --engine momentum --json`,
  })
  @CommandAccess({ kind: "mutate", resource: "crypto.signals", action: "scan", risk: "low" })
  @Returns(signalScanReturnSchema)
  async scan(
    @Option({ flags: "--engine <id>", description: `Only this engine: ${ENGINE_IDS.join("|")}` }) engine?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto signals scan";
    if (engine && !ENGINE_IDS.includes(engine as EngineId)) {
      contractFail(op, "CRYPTO_INVALID_ARGUMENT", `Invalid --engine. Use ${ENGINE_IDS.join("|")}.`, {
        asJson,
        exitCode: 2,
      });
    }
    return runOp(op, asJson, async () => {
      const reports = await runEngines(engine ? [engine as EngineId] : ENGINE_IDS);
      const payload = {
        reports: reports.map((report) => ({
          engine: report.engine,
          candidates: report.candidates,
          signals: report.signals.map(publicSignal),
          skipped: report.skipped,
        })),
      };
      printJsonOr(asJson, payload, () => {
        for (const report of payload.reports) {
          console.log(`\n${report.engine}: ${report.signals.length} signal(s) from ${report.candidates} candidate(s)`);
          for (const s of report.signals)
            console.log(`  ${s.id} ${s.direction.toUpperCase()} ${s.symbol} — ${s.rationale}`);
          for (const skip of report.skipped.slice(0, 5)) console.log(`  skipped ${skip.asset}: ${skip.reason}`);
        }
      });
      return payload;
    });
  }
}
