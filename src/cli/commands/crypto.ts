import "reflect-metadata";
import {
  cryptoAnalyzeReturnSchema,
  cryptoBalanceReturnSchema,
  cryptoDepositReturnSchema,
  cryptoHistoryReturnSchema,
  cryptoQuoteReturnSchema,
  cryptoStatusReturnSchema,
} from "../../crypto/return-schemas.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { buildCliOffsetPagination, parseCliListLimit, parseCliListOffset } from "../pagination.js";
import {
  parseSide,
  parseUnit,
  peekCallerVault,
  printJsonOr,
  requireCallerVault,
  resolveCallerVault,
  runOp,
} from "../../crypto/cli-support.js";
import { getApprovalTarget, getExecutionMode, readBoolSetting, readSetting } from "../../crypto/config.js";
import { getAsset, getAccountBalanceAtomic, listAccountHistory } from "../../crypto/db.js";
import { JEV_SECRET, judgeWithJev } from "../../crypto/jev.js";
import { getMarketData } from "../../crypto/market/index.js";
import { atomicToNumber, formatAtomic } from "../../crypto/money.js";
import { suggestPositionFraction } from "../../crypto/quant/sizing.js";
import { summarizePriceSeries } from "../../crypto/quant/stats.js";
import { evaluateTradeRisk } from "../../crypto/risk.js";
import { hasConfiguredSecret } from "../../crypto/secrets.js";
import {
  CryptoServiceError,
  createPixDeposit,
  getPortfolio,
  publicDeposit,
  resolveTradableAsset,
} from "../../crypto/service.js";
import { ASSET_USDC, vaultAccount } from "../../crypto/types.js";
import { parseDecimalToAtomic } from "../../crypto/money.js";

@Group({
  name: "crypto",
  description: "Per-user crypto vaults: Pix deposits, BRL/crypto balances, quotes and quant analysis",
  scope: "open",
})
export class CryptoCommands {
  @Command({
    name: "status",
    description: "Show crypto gateway configuration (provider, execution mode, guards) and the caller's vault",
  })
  @CommandAccess({ kind: "read", resource: "crypto", action: "status", risk: "low" })
  @Returns(cryptoStatusReturnSchema)
  async status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return runOp("crypto status", asJson, () => {
      const pixProvider = readSetting("pix.provider");
      const payload = {
        pixProvider,
        sandbox: pixProvider === "sandbox" || readSetting("ripio.environment") === "sandbox",
        executionMode: getExecutionMode(),
        killSwitch: readBoolSetting("risk.killSwitch"),
        jev: {
          enabled: readBoolSetting("jev.enabled"),
          configured: hasConfiguredSecret(JEV_SECRET),
          model: readSetting("jev.model"),
        },
        approvalTargetConfigured: getApprovalTarget() !== null,
        limits: {
          maxTradeUsd: readSetting("risk.maxTradeUsd"),
          maxDailyUsd: readSetting("risk.maxDailyUsd"),
          maxPositionFraction: readSetting("risk.maxPositionFraction"),
        },
      };
      printJsonOr(asJson, payload, () => {
        console.log(`\nPix provider:    ${payload.pixProvider}${payload.sandbox ? " (SANDBOX — no real money)" : ""}`);
        console.log(
          `Execution mode:  ${payload.executionMode}${payload.executionMode === "paper" ? " (simulated fills)" : " (LIVE on-chain)"}`,
        );
        console.log(`Kill switch:     ${payload.killSwitch ? "ON — trading halted" : "off"}`);
        console.log(
          `Jev judge:       ${payload.jev.enabled ? "enabled" : "disabled"}${payload.jev.configured ? "" : " (no API key)"}`,
        );
        console.log(
          `Operator chat:   ${payload.approvalTargetConfigured ? "configured" : "not set (approve via CLI)"}`,
        );
      });
      return payload;
    });
  }

  @Command({
    name: "balance",
    description: "Show the sender's vault balances in BRL and crypto, valued in USD and BRL",
    aliases: ["saldo"],
    helpAfter: `
USE
  ✓ The person asks "qual meu saldo?", "quanto tenho em cripto?", "how much do I have?"
NÃO USE
  ✗ To see another person's balance — agents only ever see the sender's own vault.
EXAMPLES
  ravi crypto balance --json
  ravi crypto balance --owner contact:abc123     # operator terminal only
OUTPUT
  { vault, lines[{symbol, amount, valueUsd, valueBrl}], totals{usd, brl}, fx{usdBrl}, pending{deposits, trades} }
  vault=null when the person never deposited (suggest: ravi crypto deposit <valor>).
FONTES
  src/crypto/service.ts getPortfolio · prices: Jupiter price v3 · FX: AwesomeAPI USD-BRL`,
  })
  @CommandAccess({ kind: "read", resource: "crypto", action: "balance", risk: "low" })
  @Returns(cryptoBalanceReturnSchema)
  async balance(
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id> whose vault to show" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { vault, ownerRef } = resolveCallerVault("crypto balance", { owner, asJson });
    if (!vault) {
      const payload = {
        owner: ownerRef,
        vault: null,
        totals: null,
        lines: [],
        fx: null,
        pending: null,
        asOf: null,
        hint: "No vault yet. Start with: ravi crypto deposit <valor>",
      };
      printJsonOr(asJson, payload, () =>
        console.log(`\nNo vault yet for ${ownerRef}. Start with: ravi crypto deposit <valor>`),
      );
      return payload;
    }
    return runOp("crypto balance", asJson, async () => {
      const portfolio = await getPortfolio(vault);
      const payload = {
        owner: ownerRef,
        vault: { id: vault.id, status: vault.status, riskProfile: vault.riskProfile },
        lines: portfolio.lines.map((line) => ({
          symbol: line.symbol,
          assetId: line.assetId,
          kind: line.kind,
          amount: line.amount,
          usdPrice: line.usdPrice,
          valueUsd: line.valueUsd,
          valueBrl: line.valueBrl,
        })),
        totals: portfolio.totals,
        fx: portfolio.fx,
        pending: portfolio.pending,
        asOf: new Date(portfolio.asOf).toISOString(),
        hint: null,
      };
      printJsonOr(asJson, payload, () => {
        console.log(`\nVault ${vault.id} (${vault.status}, ${vault.riskProfile})`);
        if (payload.lines.length === 0) console.log("  (empty)");
        for (const line of payload.lines) {
          const value =
            line.valueBrl === null ? "unpriced" : `≈ R$ ${line.valueBrl.toFixed(2)} / $${line.valueUsd?.toFixed(2)}`;
          console.log(`  ${line.symbol.padEnd(8)} ${line.amount.padStart(16)}  ${value}`);
        }
        console.log(
          `  Total ≈ R$ ${payload.totals.brl.toFixed(2)} / $${payload.totals.usd.toFixed(2)} (USD/BRL ${payload.fx.usdBrl})`,
        );
        if (payload.pending.deposits || payload.pending.trades) {
          console.log(`  Pending: ${payload.pending.deposits} deposit(s), ${payload.pending.trades} trade(s)`);
        }
      });
      return payload;
    });
  }

  @Command({
    name: "deposit",
    description: "Create a Pix charge (copia e cola) that credits the sender's vault when paid",
    aliases: ["depositar"],
    helpAfter: `
USE
  ✓ The person asks to deposit / add money / "quero depositar 200 reais" / "manda o pix".
  ✓ Opens the person's vault on first use.
NÃO USE
  ✗ To pay someone else — this only credits the sender's own vault.
REGRAS HARD
  • Amount in BRL between pix.minDepositBrl and pix.maxDepositBrl (defaults R$10–R$5.000).
  • The vault owner is always the person who sent the message (never a flag an agent can set).
  • With deposit.autoConvert=true the BRL converts to USDC when the payment lands.
LIFECYCLE
  pending → credited → converted   (or pending → expired/failed)
  The person's session is informed automatically when the Pix lands.
HITL TEMPLATE (send to the person)
  "Aqui está seu Pix de R$ <valor>. Copie e cole no app do banco: <pixCopyPaste>
   Expira em <minutos> min. Aviso aqui quando cair."
  In SANDBOX mode, say clearly it is a test charge and no real money moves.
EXAMPLES
  ravi crypto deposit 200 --json
  ravi crypto deposit 49,90 --json
ON ERROR
  CRYPTO_DEPOSIT_OUT_OF_RANGE → ask for an amount inside the range in the message
  CRYPTO_ACTOR_UNRESOLVED     → sender is not a known contact; cannot open a vault
FONTES
  src/crypto/service.ts createPixDeposit · src/crypto/pix/*`,
  })
  @CommandAccess({ kind: "mutate", resource: "crypto", action: "deposit", risk: "low" })
  @Returns(cryptoDepositReturnSchema)
  async deposit(
    @Arg("amount", { description: "Amount in BRL, e.g. 200 or 49,90" }) amount: string,
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id> to deposit for" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { caller, vault } = resolveCallerVault("crypto deposit", { owner, asJson, create: true });
    return runOp("crypto deposit", asJson, async () => {
      const activeVault = vault as NonNullable<typeof vault>;
      const created = Date.now() - activeVault.createdAt < 5_000;
      const deposit = await createPixDeposit({ vault: activeVault, amount, notify: caller.notify });
      const view = publicDeposit(deposit);
      const minutes = deposit.expiresAt ? Math.max(1, Math.round((deposit.expiresAt - Date.now()) / 60_000)) : null;
      const instructions = `${view.sandbox ? "[SANDBOX — test charge, no real money] " : ""}Pix de ${view.amountBrlDisplay}: copie e cole o código no app do banco${minutes ? ` (expira em ${minutes} min)` : ""}.`;
      const payload = { deposit: view, vaultCreated: created, instructions };
      printJsonOr(asJson, payload, () => {
        console.log(`\n${instructions}`);
        console.log(`\n${view.pixCopyPaste}`);
        if (view.paymentUrl) console.log(`\nLink: ${view.paymentUrl}`);
        console.log(`\nDeposit ${view.id} · vault ${view.vaultId}`);
      });
      return payload;
    });
  }

  @Command({
    name: "quote",
    description: "Preview a trade for the sender's vault: live quote, risk checks and suggested size (creates nothing)",
    aliases: ["cotacao"],
    helpAfter: `
USE
  ✓ "quanto de TSLA eu compro com 50 dólares?" · before proposing a trade
EXAMPLES
  ravi crypto quote buy TSLAx 50 --unit usd --json
  ravi crypto quote buy NVDA 200 --unit brl --json
  ravi crypto quote sell TSLAx 100 --unit percent --json
NEXT
  ravi crypto trades propose <same args> --rationale "..."`,
  })
  @CommandAccess({ kind: "read", resource: "crypto", action: "quote", risk: "low" })
  @Returns(cryptoQuoteReturnSchema)
  async quote(
    @Arg("side", { description: "buy|sell" }) side: string,
    @Arg("asset", { description: "Symbol (TSLAx, NVDA, SOL) or verified mint" }) assetRef: string,
    @Arg("amount", { description: "Amount, interpreted by --unit" }) amount: string,
    @Option({ flags: "--unit <unit>", description: "usd|brl|units|percent (default: usd)" }) unit?: string,
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id>" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto quote";
    const tradeSide = parseSide(op, side, asJson);
    const amountUnit = parseUnit(op, unit, asJson);
    const { vault } = resolveCallerVault(op, { owner, asJson });
    return runOp(op, asJson, async () => {
      const market = getMarketData();
      const asset = await resolveTradableAsset(assetRef, market);
      const usdc = getAsset(ASSET_USDC);
      if (!usdc) throw new CryptoServiceError("CRYPTO_ASSET_NOT_FOUND", "USDC asset missing.");
      const inputAsset = tradeSide === "buy" ? usdc : asset;
      const outputAsset = tradeSide === "buy" ? asset : usdc;
      const prices = await market.getUsdPrices([asset.id]);
      const price = prices.get(asset.id) ?? null;

      let inputAtomic: bigint;
      if (amountUnit === "percent") {
        if (!vault) throw new CryptoServiceError("CRYPTO_VAULT_NOT_FOUND", "Percent sizing needs a vault.");
        const pct = Number(amount);
        if (!(pct > 0 && pct <= 100))
          throw new CryptoServiceError("CRYPTO_INVALID_AMOUNT", "Percent must be in (0, 100].");
        inputAtomic =
          (getAccountBalanceAtomic(vaultAccount(vault.id), inputAsset.id) * BigInt(Math.round(pct * 100))) / 10_000n;
      } else if (amountUnit === "units") {
        inputAtomic = parseDecimalToAtomic(amount, inputAsset.decimals);
      } else {
        const fx = amountUnit === "brl" ? await market.getUsdBrl() : null;
        const usd =
          amountUnit === "brl" ? Number(amount.replace(",", ".")) / (fx?.rate ?? 1) : Number(amount.replace(",", "."));
        if (!(usd > 0)) throw new CryptoServiceError("CRYPTO_INVALID_AMOUNT", `Invalid amount "${amount}".`);
        if (tradeSide === "buy") inputAtomic = parseDecimalToAtomic(usd.toFixed(6), 6);
        else {
          if (!price) throw new CryptoServiceError("CRYPTO_PRICE_UNAVAILABLE", "No price to size this sell.");
          inputAtomic = parseDecimalToAtomic(
            (usd / price.usdPrice).toFixed(Math.min(asset.decimals, 9)),
            asset.decimals,
          );
        }
      }
      const quote = await market.getQuote({
        inputMint: inputAsset.id,
        outputMint: outputAsset.id,
        amount: inputAtomic,
        slippageBps: 50,
      });
      const notionalUsd = tradeSide === "buy" ? atomicToNumber(inputAtomic, 6) : atomicToNumber(quote.outAmount, 6);
      const portfolio = vault ? await getPortfolio(vault, market) : null;
      const risk = evaluateTradeRisk({
        vaultStatus: vault?.status ?? "active",
        notionalUsd,
        vaultEquityUsd: portfolio?.totals.usd ?? 0,
        dailyUsedUsd: 0,
        slippageBps: Math.max(50, quote.slippageBps),
        priceImpactPct: quote.priceImpactPct,
        assetId: asset.id,
        liquidityUsd: price?.liquidityUsd ?? null,
        side: tradeSide,
      });
      const payload = {
        side: tradeSide,
        asset: {
          symbol: asset.symbol,
          mint: asset.id,
          kind: asset.kind,
          usdPrice: price?.usdPrice ?? null,
          liquidityUsd: price?.liquidityUsd ?? null,
        },
        input: { symbol: inputAsset.symbol, amount: formatAtomic(inputAtomic, inputAsset.decimals) },
        expectedOutput: { symbol: outputAsset.symbol, amount: formatAtomic(quote.outAmount, outputAsset.decimals) },
        notionalUsd: Math.round(notionalUsd * 100) / 100,
        priceImpactPct: quote.priceImpactPct,
        router: quote.router,
        vaultEquityUsd: portfolio?.totals.usd ?? null,
        risk: { allowed: risk.allowed, violations: risk.violations },
      };
      printJsonOr(asJson, payload, () => {
        console.log(
          `\n${tradeSide.toUpperCase()} ${payload.input.amount} ${payload.input.symbol} → ~${payload.expectedOutput.amount} ${payload.expectedOutput.symbol}`,
        );
        console.log(
          `Notional $${payload.notionalUsd} · impact ${payload.priceImpactPct?.toFixed(3) ?? "?"}% · via ${payload.router ?? "?"}`,
        );
        console.log(risk.allowed ? "Risk: OK" : `Risk: BLOCKED\n  - ${risk.violations.join("\n  - ")}`);
      });
      return payload;
    });
  }

  @Command({
    name: "analyze",
    description:
      "Quant analysis of an asset: momentum, volatility, Sharpe/Sortino, drawdown, VaR, RSI, sizing (and Jev with --judge)",
    aliases: ["quant"],
    helpAfter: `
USE
  ✓ "vale a pena comprar NVDA?", "como está o SOL?" — ground the answer in numbers before opining.
EXAMPLES
  ravi crypto analyze TSLAx --json
  ravi crypto analyze SOL --days 180 --judge --json
OUTPUT
  summary{momentum7, momentum30, annualizedVolatility, sharpe, sortino, maxDrawdown, var95, cvar95, rsi14, trendSlope, aboveSma20}
  sizing{fraction, binding} for the sender's risk profile; judge{verdict, confidence, rugRisk} when --judge and Jev is configured.
FONTES
  src/crypto/quant/*.ts · history: GeckoTerminal daily OHLCV · Jev: docs.typesafe.ai`,
  })
  @CommandAccess({ kind: "read", resource: "crypto", action: "analyze", risk: "low" })
  @Returns(cryptoAnalyzeReturnSchema)
  async analyze(
    @Arg("asset", { description: "Symbol (TSLAx, NVDA, SOL) or verified mint" }) assetRef: string,
    @Option({ flags: "--days <n>", description: "History window in days (default: 90, max: 365)" }) days?: string,
    @Option({ flags: "--judge", description: "Also ask the Jev judge for a take/reduce/skip verdict" }) judge?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto analyze";
    const window = Math.min(365, Math.max(30, Number(days ?? 90) || 90));
    return runOp(op, asJson, async () => {
      const market = getMarketData();
      const asset = await resolveTradableAsset(assetRef, market);
      const closes = await market.getDailyCloses(asset.id, window);
      const summary = summarizePriceSeries(closes, asset.kind === "tokenized_stock" ? 252 : 365);
      const prices = await market.getUsdPrices([asset.id]);
      const riskProfile = peekCallerVault()?.riskProfile ?? "moderate";
      const winProbability = Math.min(0.75, Math.max(0.3, 0.5 + summary.sharpe / 10));
      const sizing = suggestPositionFraction({
        riskProfile,
        assetAnnualVol: summary.annualizedVolatility,
        winProbability,
      });
      const verdict = judge
        ? await judgeWithJev({
            kind: "user_request",
            side: "buy",
            asset: { symbol: asset.symbol, mint: asset.id, category: asset.kind },
            features: { ...summary, liquidityUsd: prices.get(asset.id)?.liquidityUsd ?? null } as Record<
              string,
              number | string | boolean | null
            >,
            portfolio: { riskProfile, equityUsd: 0, proposedNotionalUsd: 0, proposedFraction: sizing.fraction },
          })
        : null;
      const payload = {
        asset: {
          symbol: asset.symbol,
          mint: asset.id,
          kind: asset.kind,
          usdPrice: prices.get(asset.id)?.usdPrice ?? null,
        },
        summary,
        sizing: { riskProfile, winProbabilityAssumed: Math.round(winProbability * 1000) / 1000, ...sizing },
        judge: verdict
          ? {
              verdict: verdict.verdict,
              confidence: verdict.confidence,
              rugRisk: verdict.rugRisk,
              passed: verdict.passed,
              reasons: verdict.reasons,
            }
          : null,
        disclaimer: "Historical statistics, not advice; past performance does not predict returns.",
      };
      printJsonOr(asJson, payload, () => {
        const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
        console.log(`\n${asset.symbol} — ${summary.observations} days`);
        console.log(
          `Momentum 7d/30d: ${pct(summary.momentum7)} / ${pct(summary.momentum30)} · trend ${summary.trendSlope > 0 ? "up" : "down"} · above SMA20: ${summary.aboveSma20}`,
        );
        console.log(
          `Vol ${pct(summary.annualizedVolatility)} · Sharpe ${summary.sharpe} · Sortino ${summary.sortino} · MaxDD ${pct(summary.maxDrawdown)} · VaR95 ${pct(summary.var95)} · RSI ${summary.rsi14 ?? "n/a"}`,
        );
        console.log(
          `Suggested max position (${riskProfile}): ${pct(sizing.fraction)} of vault (${sizing.binding}-bound)`,
        );
        if (payload.judge)
          console.log(
            `Jev: ${payload.judge.verdict} @ ${payload.judge.confidence.toFixed(2)} — ${payload.judge.reasons.join("; ")}`,
          );
      });
      return payload;
    });
  }

  @Command({
    name: "history",
    description: "List ledger movements (deposits, conversions, trades) for the sender's vault",
  })
  @CommandAccess({ kind: "read", resource: "crypto", action: "history", risk: "low" })
  @Returns(cryptoHistoryReturnSchema)
  async history(
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id>" }) owner?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { vault } = requireCallerVault("crypto history", { owner, asJson });
    const pageLimit = parseCliListLimit(limit);
    const pageOffset = parseCliListOffset(offset);
    const page = listAccountHistory(vaultAccount(vault.id), { limit: pageLimit, offset: pageOffset });
    const items = page.items.map((item) => ({
      kind: item.journal.kind,
      ref: `${item.journal.refType}:${item.journal.refId}`,
      memo: item.journal.memo,
      at: new Date(item.journal.createdAt).toISOString(),
      changes: item.entries.map((entry) => {
        const asset = getAsset(entry.assetId);
        return {
          symbol: asset?.symbol ?? entry.assetId,
          amount: formatAtomic(BigInt(entry.amount), asset?.decimals ?? 0),
        };
      }),
    }));
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crypto", "history"],
      limit: pageLimit,
      offset: pageOffset,
      returned: items.length,
      total: page.total,
    });
    const payload = { vaultId: vault.id, total: page.total, pagination, items };
    printJsonOr(asJson, payload, () => {
      console.log(`\nVault ${vault.id} — ${page.total} movement(s)`);
      for (const item of items) {
        console.log(
          `  ${item.at}  ${item.kind.padEnd(16)} ${item.changes.map((c) => `${c.amount} ${c.symbol}`).join(", ")}`,
        );
      }
      if (pagination.nextCommand) console.log(`\nNext page: ${pagination.nextCommand}`);
    });
    return payload;
  }
}
