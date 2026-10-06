import "reflect-metadata";
import {
  depositListReturnSchema,
  depositShowReturnSchema,
  depositSimulateReturnSchema,
} from "../../crypto/return-schemas.js";
import { contractFail } from "../agent-contract.js";
import { CliOnly, Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { buildCliOffsetPagination, parseCliListLimit, parseCliListOffset } from "../pagination.js";
import { assertOperator, printJsonOr, requireCallerVault, runOp } from "../../crypto/cli-support.js";
import { getDeposit, listDeposits } from "../../crypto/db.js";
import { resolveCryptoCaller } from "../../crypto/identity.js";
import { getPixProvider } from "../../crypto/pix/index.js";
import { SandboxPixProvider } from "../../crypto/pix/sandbox.js";
import { processPixEvent, publicDeposit } from "../../crypto/service.js";
import type { CryptoDeposit, DepositStatus } from "../../crypto/types.js";

const DEPOSIT_STATUSES: DepositStatus[] = [
  "pending",
  "paid",
  "credited",
  "converted",
  "expired",
  "failed",
  "reversed",
  "reversal_blocked",
];

function loadOwnDeposit(op: string, id: string, owner: string | undefined, asJson?: boolean): CryptoDeposit {
  const deposit = getDeposit(id);
  const notFound = () =>
    contractFail(op, "CRYPTO_DEPOSIT_NOT_FOUND", `Deposit not found: ${id}`, {
      asJson,
      details: { suggestedAction: "List deposits with `ravi crypto deposits list`." },
    });
  if (!deposit) notFound();
  if (resolveCryptoCaller().agentRuntime || owner) {
    const { vault } = requireCallerVault(op, { owner, asJson });
    if (deposit?.vaultId !== vault.id) notFound();
  }
  return deposit as CryptoDeposit;
}

@Group({
  name: "crypto.deposits",
  description: "Pix deposits into the sender's vault: list and inspect; operators can simulate sandbox payments",
  scope: "open",
})
export class CryptoDepositCommands {
  @Command({ name: "list", description: "List Pix deposits for the sender's vault", aliases: ["ls"] })
  @CommandAccess({ kind: "read", resource: "crypto.deposits", action: "list", risk: "low" })
  @Returns(depositListReturnSchema)
  async list(
    @Option({ flags: "--status <status>", description: `Filter: ${DEPOSIT_STATUSES.join("|")}` }) status?: string,
    @Option({ flags: "--all", description: "Operator only: all vaults" }) all?: boolean,
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id>" }) owner?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto deposits list";
    if (status && !DEPOSIT_STATUSES.includes(status as DepositStatus)) {
      contractFail(op, "CRYPTO_INVALID_ARGUMENT", `Invalid --status. Use ${DEPOSIT_STATUSES.join("|")}.`, {
        asJson,
        exitCode: 2,
      });
    }
    let vaultId: string | undefined;
    if (all) assertOperator(op, asJson);
    else vaultId = requireCallerVault(op, { owner, asJson }).vault.id;
    const pageLimit = parseCliListLimit(limit);
    const pageOffset = parseCliListOffset(offset);
    const page = listDeposits({
      vaultId,
      status: status as DepositStatus | undefined,
      limit: pageLimit,
      offset: pageOffset,
    });
    const items = page.items.map(publicDeposit);
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crypto", "deposits", "list"],
      limit: pageLimit,
      offset: pageOffset,
      returned: items.length,
      total: page.total,
      options: [status ? "--status" : null, status ?? null, all ? "--all" : null],
    });
    const payload = { total: page.total, pagination, items };
    printJsonOr(asJson, payload, () => {
      console.log(`\n${page.total} deposit(s)`);
      for (const d of items) {
        console.log(
          `  ${d.id}  ${d.status.padEnd(10)} ${d.amountBrlDisplay.padStart(14)}  ${d.provider}${d.sandbox ? " (sandbox)" : ""}  ${d.createdAt}`,
        );
      }
      if (pagination.nextCommand) console.log(`\nNext page: ${pagination.nextCommand}`);
    });
    return payload;
  }

  @Command({ name: "show", description: "Show one deposit (pending ones include the Pix copia e cola again)" })
  @CommandAccess({ kind: "read", resource: "crypto.deposits", action: "show", risk: "low" })
  @Returns(depositShowReturnSchema)
  async show(
    @Arg("depositId", { description: "Deposit id (dep_…)" }) depositId: string,
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id>" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const deposit = loadOwnDeposit("crypto deposits show", depositId, owner, asJson);
    const payload = { deposit: publicDeposit(deposit) };
    printJsonOr(asJson, payload, () => {
      const view = payload.deposit;
      console.log(`\n${view.id} · ${view.status} · ${view.amountBrlDisplay} · ${view.provider}`);
      if (view.pixCopyPaste) console.log(`\n${view.pixCopyPaste}`);
      if (view.conversion)
        console.log(`Converted: ${String(view.conversion.amount)} ${String(view.conversion.symbol)}`);
    });
    return payload;
  }

  @Command({
    name: "simulate-paid",
    description: "OPERATOR + SANDBOX ONLY: deliver a signed sandbox webhook marking a pending deposit as paid",
    helpAfter: `
USE
  ✓ End-to-end testing of deposit → credit → USDC conversion → session notification, without real money.
REGRAS HARD
  • Refuses inside agent sessions and for non-sandbox deposits.
  • Goes through the same signature verification and settlement path as a real webhook.
EXAMPLES
  ravi crypto deposits simulate-paid dep_0123456789abcdef --json
  ravi crypto deposits simulate-paid dep_0123456789abcdef --amount 150.00 --json`,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "crypto.deposits",
    action: "simulate-paid",
    risk: "low",
    localOperator: true,
  })
  @CliOnly()
  @Returns(depositSimulateReturnSchema)
  async simulatePaid(
    @Arg("depositId", { description: "Deposit id (dep_…)" }) depositId: string,
    @Option({ flags: "--amount <brl>", description: "Amount actually paid (default: the charge amount)" })
    amount?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto deposits simulate-paid";
    assertOperator(op, asJson);
    const deposit = getDeposit(depositId);
    if (!deposit) return contractFail(op, "CRYPTO_DEPOSIT_NOT_FOUND", `Deposit not found: ${depositId}`, { asJson });
    if (deposit.provider !== "sandbox") {
      return contractFail(op, "CRYPTO_NOT_SANDBOX", "Only sandbox deposits can be simulated.", { asJson, exitCode: 3 });
    }
    return runOp(op, asJson, async () => {
      const provider = getPixProvider("sandbox");
      if (!(provider instanceof SandboxPixProvider)) throw new Error("Sandbox provider unavailable.");
      const { parseDecimalToAtomic } = await import("../../crypto/money.js");
      const amountBrl = amount ? parseDecimalToAtomic(amount, 2).toString() : deposit.amountBrl;
      if (BigInt(amountBrl) > BigInt(deposit.amountBrl)) {
        return contractFail(op, "CRYPTO_INVALID_AMOUNT", "Simulated payment cannot exceed the charge amount.", {
          asJson,
          exitCode: 2,
        });
      }
      const delivery = provider.signPayload({
        eventId: `sim_${deposit.id}_${Date.now()}`,
        txid: deposit.txid,
        status: "paid",
        amountBrl,
        paidAt: Date.now(),
        payerName: "Sandbox Payer",
      });
      const [event] = await provider.parseWebhook({ headers: delivery.headers, rawBody: delivery.body });
      const result = await processPixEvent("sandbox", event);
      const payload = { outcome: result.outcome, deposit: result.deposit ? publicDeposit(result.deposit) : null };
      printJsonOr(asJson, payload, () =>
        console.log(`\n${result.outcome}: ${deposit.id} → ${payload.deposit?.status}`),
      );
      return payload;
    });
  }
}
