import "reflect-metadata";
import {
  tradeListReturnSchema,
  tradeMutationReturnSchema,
  tradeProposeReturnSchema,
  tradeShowReturnSchema,
} from "../../crypto/return-schemas.js";
import { contractDryRun, contractFail } from "../agent-contract.js";
import { CliOnly, Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { buildCliOffsetPagination, parseCliListLimit, parseCliListOffset } from "../pagination.js";
import {
  assertOperator,
  parseSide,
  parseUnit,
  printJsonOr,
  requireCallerVault,
  runOp,
} from "../../crypto/cli-support.js";
import { getTrade, listTrades } from "../../crypto/db.js";
import { resolveCryptoCaller } from "../../crypto/identity.js";
import {
  cancelTrade,
  decideTrade,
  describeTradeForApproval,
  proposeTrade,
  publicTrade,
  reconcileTrade,
  type ReconcileResolution,
} from "../../crypto/service.js";
import { getAsset } from "../../crypto/db.js";
import { parseDecimalToAtomic } from "../../crypto/money.js";
import type { CryptoTrade, TradeStatus } from "../../crypto/types.js";

const TRADE_STATUSES: TradeStatus[] = [
  "pending_approval",
  "approved",
  "rejected",
  "executing",
  "executed",
  "failed",
  "expired",
  "cancelled",
];

function loadTrade(op: string, id: string, asJson?: boolean): CryptoTrade {
  const trade = getTrade(id);
  if (!trade) {
    contractFail(op, "CRYPTO_TRADE_NOT_FOUND", `Trade not found: ${id}`, {
      asJson,
      details: { suggestedAction: "List trades with `ravi crypto trades list`." },
    });
  }
  return trade as CryptoTrade;
}

/** Agents may only see/cancel trades of the vault belonging to the current sender. */
function loadOwnTrade(op: string, id: string, owner: string | undefined, asJson?: boolean): CryptoTrade {
  const trade = loadTrade(op, id, asJson);
  if (resolveCryptoCaller().agentRuntime || owner) {
    const { vault } = requireCallerVault(op, { owner, asJson });
    if (trade.vaultId !== vault.id) {
      // Same answer as "not found" so trade ids of other people leak nothing.
      contractFail(op, "CRYPTO_TRADE_NOT_FOUND", `Trade not found: ${id}`, { asJson });
    }
  }
  return trade;
}

@Group({
  name: "crypto.trades",
  description: "Trade proposals for the sender's vault: propose, list, cancel; operator approves or rejects",
  scope: "open",
})
export class CryptoTradeCommands {
  @Command({
    name: "propose",
    description: "Propose a buy/sell for the sender's vault; it waits for operator approval before any money moves",
    helpAfter: `
USE
  ✓ The person asks to buy/sell ("compra 50 dólares de TSLA", "vende metade do meu NVDA").
  ✓ Acting on an engine signal the person agreed to: pass --signal <id>.
NÃO USE
  ✗ To approve — approvals are operator-only (ravi crypto trades approve, or the approval message).
  ✗ Without the person asking: never propose trades on your own initiative.
REGRAS HARD (precedence: REGRAS HARD > INPUT HUMANO > CONVENÇÕES)
  • Only verified assets (xStocks catalog or Jupiter-verified tokens).
  • Risk limits block in code: kill switch, per-trade/day USD caps, max % of vault, slippage, price impact, liquidity.
  • Proposals expire after trade.ttlMinutes (default 30).
  • Execution mode is fixed at proposal time (paper = simulated fill; live = on-chain).
LIFECYCLE
  pending_approval → approved → executing → executed | failed (funds released)
  pending_approval → rejected | expired | cancelled
HITL TEMPLATE (send to the person)
  "Proposta <id>: <comprar/vender> <input> → ~<output> (mín <minOutput>). Está aguardando
   aprovação do operador; aviso quando executar. Modo: <paper/live>."
EXAMPLES
  ravi crypto trades propose buy TSLAx 50 --unit usd --rationale "pediu exposição a Tesla" --json
  ravi crypto trades propose buy NVDA 300 --unit brl --json
  ravi crypto trades propose sell TSLAx 50 --unit percent --json
  ravi crypto trades propose buy SPYx 20 --signal sig_abc123 --json
ON ERROR
  CRYPTO_INSUFFICIENT_FUNDS   → show balance; offer a Pix deposit
  CRYPTO_TRADE_RISK_BLOCKED   → explain the violated limit; suggest a smaller amount
  CRYPTO_ASSET_NOT_FOUND / _UNVERIFIED / _AMBIGUOUS → ask which asset (offer xStocks list)
  CRYPTO_TRADE_JUDGE_BLOCKED  → engine idea rejected by Jev; do not retry the same signal
FONTES
  src/crypto/service.ts proposeTrade · src/crypto/risk.ts · src/crypto/jev.ts`,
  })
  @CommandAccess({ kind: "mutate", resource: "crypto.trades", action: "propose", risk: "medium" })
  @Returns(tradeProposeReturnSchema)
  async propose(
    @Arg("side", { description: "buy|sell" }) side: string,
    @Arg("asset", { description: "Symbol (TSLAx, NVDA, SOL) or verified mint" }) assetRef: string,
    @Arg("amount", { description: "Amount, interpreted by --unit" }) amount: string,
    @Option({ flags: "--unit <unit>", description: "usd|brl|units|percent (default: usd)" }) unit?: string,
    @Option({ flags: "--rationale <text>", description: "Why — shown to the operator approving" }) rationale?: string,
    @Option({ flags: "--signal <id>", description: "Engine signal this trade acts on" }) signalId?: string,
    @Option({ flags: "--strategy <id>", description: "Strategy this trade follows" }) strategyId?: string,
    @Option({ flags: "--slippage-bps <n>", description: "Slippage tolerance in bps (default: 50)" }) slippage?: string,
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id>" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto trades propose";
    const tradeSide = parseSide(op, side, asJson);
    const amountUnit = parseUnit(op, unit, asJson);
    const slippageBps = slippage === undefined ? undefined : Number(slippage);
    if (slippageBps !== undefined && !(Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps <= 5000)) {
      contractFail(op, "CRYPTO_INVALID_ARGUMENT", "--slippage-bps must be an integer between 0 and 5000.", {
        asJson,
        exitCode: 2,
      });
    }
    const { caller, vault } = requireCallerVault(op, { owner, asJson });
    return runOp(op, asJson, async () => {
      const proposal = await proposeTrade({
        vault,
        side: tradeSide,
        assetRef,
        amount,
        unit: amountUnit,
        rationale: rationale ?? null,
        strategyId: strategyId ?? null,
        signalId: signalId ?? null,
        slippageBps,
        origin: signalId ? "engine" : "user",
        notify: caller.notify,
      });
      const payload = {
        trade: publicTrade(proposal.trade),
        risk: { allowed: proposal.risk.allowed, checks: proposal.risk.checks },
        approval:
          "Waiting for operator approval. The person will be informed automatically when it executes, fails, or expires.",
      };
      printJsonOr(asJson, payload, () => {
        console.log(`\n${describeTradeForApproval(proposal.trade)}`);
        console.log(
          `\nStatus: pending_approval — operator approves with: ravi crypto trades approve ${proposal.trade.id} --execute`,
        );
      });
      return payload;
    });
  }

  @Command({
    name: "list",
    description: "List trades for the sender's vault (operators: all vaults with --all)",
    aliases: ["ls"],
  })
  @CommandAccess({ kind: "read", resource: "crypto.trades", action: "list", risk: "low" })
  @Returns(tradeListReturnSchema)
  async list(
    @Option({ flags: "--status <status>", description: `Filter: ${TRADE_STATUSES.join("|")}` }) status?: string,
    @Option({ flags: "--all", description: "Operator only: all vaults" }) all?: boolean,
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id>" }) owner?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto trades list";
    if (status && !TRADE_STATUSES.includes(status as TradeStatus)) {
      contractFail(op, "CRYPTO_INVALID_ARGUMENT", `Invalid --status. Use ${TRADE_STATUSES.join("|")}.`, {
        asJson,
        exitCode: 2,
      });
    }
    let vaultId: string | undefined;
    if (all) assertOperator(op, asJson);
    else vaultId = requireCallerVault(op, { owner, asJson }).vault.id;
    const pageLimit = parseCliListLimit(limit);
    const pageOffset = parseCliListOffset(offset);
    const page = listTrades({
      vaultId,
      status: status as TradeStatus | undefined,
      limit: pageLimit,
      offset: pageOffset,
    });
    const items = page.items.map(publicTrade);
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crypto", "trades", "list"],
      limit: pageLimit,
      offset: pageOffset,
      returned: items.length,
      total: page.total,
      options: [status ? "--status" : null, status ?? null, all ? "--all" : null],
    });
    const payload = { total: page.total, pagination, items };
    printJsonOr(asJson, payload, () => {
      console.log(`\n${page.total} trade(s)`);
      for (const t of items) {
        console.log(
          `  ${t.id}  ${t.status.padEnd(16)} ${t.side} ${t.input.amount} ${t.input.symbol} → ${t.executedOutput ?? `~${t.expectedOutput.amount}`} ${t.expectedOutput.symbol} [${t.executionMode}]`,
        );
      }
      if (pagination.nextCommand) console.log(`\nNext page: ${pagination.nextCommand}`);
    });
    return payload;
  }

  @Command({ name: "show", description: "Show one trade (agents: only the sender's own trades)" })
  @CommandAccess({ kind: "read", resource: "crypto.trades", action: "show", risk: "low" })
  @Returns(tradeShowReturnSchema)
  async show(
    @Arg("tradeId", { description: "Trade id (trd_…)" }) tradeId: string,
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id>" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const trade = loadOwnTrade("crypto trades show", tradeId, owner, asJson);
    const payload = { trade: publicTrade(trade), summary: describeTradeForApproval(trade) };
    printJsonOr(asJson, payload, () =>
      console.log(`\n${payload.summary}\nStatus: ${trade.status}${trade.error ? ` (${trade.error})` : ""}`),
    );
    return payload;
  }

  @Command({ name: "cancel", description: "Cancel one of the sender's pending proposals" })
  @CommandAccess({ kind: "mutate", resource: "crypto.trades", action: "cancel", risk: "low" })
  @Returns(tradeMutationReturnSchema)
  async cancel(
    @Arg("tradeId", { description: "Trade id (trd_…)" }) tradeId: string,
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id>" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto trades cancel";
    const trade = loadOwnTrade(op, tradeId, owner, asJson);
    return runOp(op, asJson, async () => {
      const payload = { trade: publicTrade(await cancelTrade(trade)) };
      printJsonOr(asJson, payload, () => console.log(`\n✓ Trade ${trade.id} cancelled`));
      return payload;
    });
  }

  @Command({
    name: "approve",
    description: "OPERATOR ONLY: approve and execute a pending trade (dry-run by default; --execute moves funds)",
    helpAfter: `
HITL OBRIGATÓRIO
  This is the second key of every trade. It refuses to run inside an agent session.
  Approving holds the vault's funds, then executes (paper or live per the trade's mode).
EXAMPLES
  ravi crypto trades approve trd_ab12cd34ef56 --json            # dry-run: shows what would happen (exit 3)
  ravi crypto trades approve trd_ab12cd34ef56 --execute --json
ON ERROR
  CRYPTO_OPERATOR_ONLY      → run it from a terminal, not through an agent
  CRYPTO_TRADE_EXPIRED      → the person must request a new proposal
  CRYPTO_TRADE_NOT_PENDING  → already decided`,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "crypto.trades",
    action: "approve",
    risk: "high",
    requiresConfirmation: true,
  })
  @CliOnly()
  @Returns(tradeMutationReturnSchema)
  async approve(
    @Arg("tradeId", { description: "Trade id (trd_…)" }) tradeId: string,
    @Option({ flags: "--execute", description: "Actually approve and execute; default is a dry-run (exit 3)" })
    execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto trades approve";
    assertOperator(op, asJson);
    const trade = loadTrade(op, tradeId, asJson);
    if (execute !== true) {
      contractDryRun(op, { trade: publicTrade(trade), summary: describeTradeForApproval(trade) }, { asJson });
    }
    return runOp(op, asJson, async () => {
      const decided = await decideTrade(trade.id, {
        decision: "approve",
        decidedBy: process.env.USER ?? "operator",
        via: "cli",
      });
      const payload = { trade: publicTrade(decided) };
      printJsonOr(asJson, payload, () =>
        console.log(
          decided.status === "executed"
            ? `\n✓ Trade ${decided.id} executed (${decided.executionMode}) → ${payload.trade.executedOutput} ${payload.trade.expectedOutput.symbol}`
            : `\n✗ Trade ${decided.id} ${decided.status}: ${decided.error ?? ""}`,
        ),
      );
      return payload;
    });
  }

  @Command({ name: "reject", description: "OPERATOR ONLY: reject a pending trade" })
  @CommandAccess({ kind: "mutate", resource: "crypto.trades", action: "reject", risk: "low" })
  @CliOnly()
  @Returns(tradeMutationReturnSchema)
  async reject(
    @Arg("tradeId", { description: "Trade id (trd_…)" }) tradeId: string,
    @Option({ flags: "--reason <text>", description: "Reason shown to the person" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto trades reject";
    assertOperator(op, asJson);
    const trade = loadTrade(op, tradeId, asJson);
    return runOp(op, asJson, async () => {
      const decided = await decideTrade(trade.id, {
        decision: "reject",
        decidedBy: process.env.USER ?? "operator",
        via: "cli",
        reason: reason ?? null,
      });
      const payload = { trade: publicTrade(decided) };
      printJsonOr(asJson, payload, () => console.log(`\n✓ Trade ${decided.id} rejected`));
      return payload;
    });
  }

  @Command({
    name: "reconcile",
    description:
      "OPERATOR ONLY: resolve a trade stuck in approved/executing (retry, failed, or filled from chain evidence)",
    helpAfter: `
WHEN
  • approved for minutes but never executed (daemon restart, Ctrl-C) → --outcome retry
  • executing with "OUTCOME UNKNOWN" (live swap whose confirmation never arrived):
      check the treasury wallet / tx signature on-chain first, then
      --outcome filled --output <amount received> --tx <signature>   (credits the vault)
      --outcome failed --reason "not on chain"                        (releases the hold)
REGRAS HARD
  • Dry-run by default (exit 3); --execute applies. Refuses inside agent sessions.
  • retry is only allowed for approved trades (an executing trade may already be on-chain).
EXAMPLES
  ravi crypto trades reconcile trd_ab12cd34ef56 --outcome retry --execute
  ravi crypto trades reconcile trd_ab12cd34ef56 --outcome filled --output 0.0269 --tx 5Kx… --execute
  ravi crypto trades reconcile trd_ab12cd34ef56 --outcome failed --reason "tx expired" --execute`,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "crypto.trades",
    action: "reconcile",
    risk: "high",
    requiresConfirmation: true,
  })
  @CliOnly()
  @Returns(tradeMutationReturnSchema)
  async reconcile(
    @Arg("tradeId", { description: "Trade id (trd_…)" }) tradeId: string,
    @Option({ flags: "--outcome <outcome>", description: "retry|failed|filled" }) outcome?: string,
    @Option({ flags: "--output <amount>", description: "filled: output received, in output-asset units" })
    output?: string,
    @Option({ flags: "--input <amount>", description: "filled: input actually spent (default: full held amount)" })
    input?: string,
    @Option({ flags: "--tx <signature>", description: "filled: on-chain transaction signature" }) tx?: string,
    @Option({ flags: "--reason <text>", description: "failed: why" }) reason?: string,
    @Option({ flags: "--execute", description: "Apply; default is a dry-run (exit 3)" }) execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto trades reconcile";
    assertOperator(op, asJson);
    const trade = loadTrade(op, tradeId, asJson);
    let resolution: ReconcileResolution;
    try {
      if (outcome === "retry") resolution = { outcome: "retry" };
      else if (outcome === "failed")
        resolution = { outcome: "failed", reason: reason?.trim() || "operator reconciliation" };
      else if (outcome === "filled") {
        const outputAsset = getAsset(trade.outputAssetId);
        const inputAsset = getAsset(trade.inputAssetId);
        if (!output || !outputAsset || !inputAsset) throw new Error("--output is required for filled.");
        resolution = {
          outcome: "filled",
          outputAmount: parseDecimalToAtomic(output, outputAsset.decimals),
          ...(input ? { inputAmount: parseDecimalToAtomic(input, inputAsset.decimals) } : {}),
          txSignature: tx?.trim() || null,
        };
      } else throw new Error("--outcome must be retry|failed|filled.");
    } catch (error) {
      return contractFail(op, "CRYPTO_INVALID_ARGUMENT", error instanceof Error ? error.message : String(error), {
        asJson,
        exitCode: 2,
      });
    }
    if (execute !== true) {
      contractDryRun(
        op,
        {
          trade: publicTrade(trade),
          outcome: resolution.outcome,
          ...(resolution.outcome === "filled" ? { output: output ?? null, tx: tx ?? null } : {}),
        },
        { asJson },
      );
    }
    return runOp(op, asJson, async () => {
      const result = await reconcileTrade(trade.id, resolution);
      const payload = { trade: publicTrade(result) };
      printJsonOr(asJson, payload, () => console.log(`\n✓ Trade ${result.id} → ${result.status}`));
      return payload;
    });
  }
}
