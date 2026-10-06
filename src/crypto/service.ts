/**
 * Crypto domain service: vaults, Pix deposits, portfolio valuation, and the
 * trade lifecycle. CLI commands, the webhook handler, the engines, and the
 * daemon runner all go through here.
 *
 * Trade lifecycle (two keys):
 *   proposeTrade (vault owner's turn) → pending_approval
 *   decideTrade  (operator only)      → approved [+ hold journal] → executing → executed | failed
 *                                     → rejected | expired | cancelled
 */

import { randomBytes } from "node:crypto";
import { readBoolSetting, readNumberSetting, readSetting, getExecutionMode } from "./config.js";
import {
  CryptoLedgerError,
  createDeposit,
  createTrade,
  getAccountBalanceAtomic,
  getAccountBalances,
  getAsset,
  getDeposit,
  getDepositByProviderCharge,
  getDepositByTxid,
  getJournalEntries,
  vaultHasSandboxFunds,
  getTrade,
  getVault,
  listDeposits,
  listExpiredPendingDeposits,
  listExpiredPendingTrades,
  listTradesStaleInStatus,
  listTrades,
  newCryptoId,
  postJournalInTransaction,
  resolveAsset,
  sumRecentTradeNotionalUsd,
  transitionTrade,
  updateDepositFields,
  upsertAsset,
  withCryptoTransaction,
} from "./db.js";
import { ExecutionError, type ExecutionFill, executorFor } from "./execution/executors.js";
import { judgeWithJev, type JevJudgement } from "./jev.js";
import { findCatalogAsset, findCatalogByUnderlying, getMarketData, type MarketData } from "./market/index.js";
import { applyBps, atomicToNumber, convertAtomic, formatAtomic, formatBrl, parseDecimalToAtomic } from "./money.js";
import { getCryptoNotifier } from "./notify.js";
import { getPixProvider, type PixPaymentEvent } from "./pix/index.js";
import { summarizePriceSeries } from "./quant/stats.js";
import { evaluateTradeRisk, type RiskEvaluation } from "./risk.js";
import {
  ASSET_BRL,
  ASSET_USDC,
  SYSTEM_ACCOUNTS,
  vaultAccount,
  type AssetBalance,
  type CryptoAsset,
  type CryptoDeposit,
  type CryptoTrade,
  type CryptoVault,
  type NotificationTarget,
  type TradeSide,
} from "./types.js";

export class CryptoServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CryptoServiceError";
  }
}

const HOLD_ACCOUNT = "system:holds";
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export interface PortfolioLine extends AssetBalance {
  usdPrice: number | null;
  valueUsd: number | null;
  valueBrl: number | null;
}

export interface Portfolio {
  vaultId: string;
  status: CryptoVault["status"];
  riskProfile: CryptoVault["riskProfile"];
  lines: PortfolioLine[];
  totals: { usd: number; brl: number; unpricedAssets: string[] };
  fx: { usdBrl: number; source: string };
  pending: { deposits: number; trades: number };
  asOf: number;
}

export async function getPortfolio(vault: CryptoVault, market: MarketData = getMarketData()): Promise<Portfolio> {
  const balances = getAccountBalances(vaultAccount(vault.id));
  const fx = await market.getUsdBrl();
  const tokenMints = balances.filter((b) => b.assetId !== ASSET_BRL && b.assetId !== ASSET_USDC).map((b) => b.assetId);
  let prices = new Map<string, { usdPrice: number; liquidityUsd: number | null }>();
  if (tokenMints.length > 0) {
    try {
      prices = await market.getUsdPrices(tokenMints);
    } catch {
      // Valuation degrades to "unpriced" rather than failing the balance query.
    }
  }
  const unpriced: string[] = [];
  let totalUsd = 0;
  const lines = balances.map((balance): PortfolioLine => {
    let usdPrice: number | null = null;
    if (balance.assetId === ASSET_BRL) usdPrice = 1 / fx.rate;
    else if (balance.assetId === ASSET_USDC) usdPrice = 1;
    else usdPrice = prices.get(balance.assetId)?.usdPrice ?? null;
    const units = atomicToNumber(BigInt(balance.atomic), balance.decimals);
    const valueUsd = usdPrice === null ? null : round2(units * usdPrice);
    if (valueUsd === null) unpriced.push(balance.symbol);
    else totalUsd += valueUsd;
    return { ...balance, usdPrice, valueUsd, valueBrl: valueUsd === null ? null : round2(valueUsd * fx.rate) };
  });
  return {
    vaultId: vault.id,
    status: vault.status,
    riskProfile: vault.riskProfile,
    lines,
    totals: { usd: round2(totalUsd), brl: round2(totalUsd * fx.rate), unpricedAssets: unpriced },
    fx: { usdBrl: round4(fx.rate), source: fx.source },
    pending: {
      deposits: listDeposits({ vaultId: vault.id, status: "pending", limit: 1, offset: 0 }).total,
      trades: listTrades({ vaultId: vault.id, status: "pending_approval", limit: 1, offset: 0 }).total,
    },
    asOf: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

export interface PublicDeposit {
  id: string;
  vaultId: string;
  provider: string;
  status: CryptoDeposit["status"];
  amountBrl: string;
  amountBrlDisplay: string;
  pixCopyPaste: string | null;
  paymentUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  sandbox: boolean;
  conversion: PublicConversion | null;
  createdAt: string;
}

export interface PublicConversion {
  source: string;
  rate: string;
  usdBrl?: number;
  assetId: string;
  symbol: string;
  amount: string;
  feeBrl: string;
}

function publicConversion(raw: Record<string, unknown> | null): PublicConversion | null {
  if (!raw) return null;
  const text = (value: unknown) =>
    typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return {
    source: text(raw.source),
    rate: text(raw.rate),
    ...(typeof raw.usdBrl === "number" ? { usdBrl: raw.usdBrl } : {}),
    assetId: text(raw.assetId),
    symbol: text(raw.symbol),
    amount: text(raw.amount),
    feeBrl: text(raw.feeBrl),
  };
}

export function publicDeposit(deposit: CryptoDeposit): PublicDeposit {
  return {
    id: deposit.id,
    vaultId: deposit.vaultId,
    provider: deposit.provider,
    status: deposit.status,
    amountBrl: formatAtomic(BigInt(deposit.amountBrl), 2, { minFractionDigits: 2 }),
    amountBrlDisplay: formatBrl(BigInt(deposit.amountBrl)),
    pixCopyPaste: deposit.status === "pending" ? deposit.pixCopyPaste : null,
    paymentUrl: deposit.status === "pending" ? deposit.paymentUrl : null,
    expiresAt: iso(deposit.expiresAt),
    paidAt: iso(deposit.paidAt),
    sandbox: deposit.provider === "sandbox",
    conversion: publicConversion(deposit.conversion),
    createdAt: new Date(deposit.createdAt).toISOString(),
  };
}

function newTxid(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(21);
  return `RAVI${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

export async function createPixDeposit(input: {
  vault: CryptoVault;
  amount: string;
  notify: NotificationTarget | null;
}): Promise<CryptoDeposit> {
  if (input.vault.status !== "active") {
    throw new CryptoServiceError("CRYPTO_VAULT_FROZEN", "This vault is frozen; deposits are disabled.");
  }
  let amountBrl: bigint;
  try {
    amountBrl = parseDecimalToAtomic(input.amount, 2);
  } catch (error) {
    throw new CryptoServiceError("CRYPTO_INVALID_AMOUNT", error instanceof Error ? error.message : String(error));
  }
  const min = parseDecimalToAtomic(readSetting("pix.minDepositBrl"), 2);
  const max = parseDecimalToAtomic(readSetting("pix.maxDepositBrl"), 2);
  if (amountBrl < min || amountBrl > max) {
    throw new CryptoServiceError(
      "CRYPTO_DEPOSIT_OUT_OF_RANGE",
      `Deposits must be between ${formatBrl(min)} and ${formatBrl(max)}.`,
      { min: formatAtomic(min, 2), max: formatAtomic(max, 2) },
    );
  }

  const provider = getPixProvider();
  const targetAssetId = readBoolSetting("deposit.autoConvert") ? readSetting("deposit.targetAsset") : null;
  const charge = await provider.createCharge({
    txid: newTxid(),
    amountBrl,
    description: "Deposito Ravi",
    expiresInSeconds: readNumberSetting("pix.expiresSeconds"),
    vaultId: input.vault.id,
    targetAssetId,
  });
  const deposit = createDeposit({
    id: newCryptoId("dep"),
    vaultId: input.vault.id,
    provider: provider.id,
    providerChargeId: charge.providerChargeId,
    txid: charge.txid,
    amountBrl,
    pixCopyPaste: charge.copyPaste,
    pixQrImageUrl: charge.qrImageUrl,
    paymentUrl: charge.paymentUrl,
    targetAssetId,
    expiresAt: charge.expiresAt,
    notify: input.notify,
  });
  await getCryptoNotifier().publish("deposit.created", {
    vaultId: deposit.vaultId,
    depositId: deposit.id,
    amountBrl: deposit.amountBrl,
    provider: deposit.provider,
    status: deposit.status,
  });
  return deposit;
}

export type PixEventOutcome =
  | "credited"
  | "converted"
  | "duplicate"
  | "expired"
  | "failed"
  | "unknown_deposit"
  | "provider_mismatch"
  | "ignored";

export interface PixEventResult {
  outcome: PixEventOutcome;
  depositId: string | null;
  deposit: CryptoDeposit | null;
}

/** Late webhooks are normal (provider retries, clock skew): only expire charges this long after their deadline. */
export const DEPOSIT_EXPIRY_GRACE_MS = 30 * 60_000;

/**
 * Apply one verified provider event. Safe to call repeatedly with the same
 * event (webhook retries): state checks + ledger idempotency make replays no-ops.
 *
 * - paid/converted on pending OR locally-expired charges credits the vault
 *   (money that arrived is never dropped), capped at the charge amount.
 * - failed/expired on a pending charge closes it; failed after credit (refund,
 *   cancellation) reverses the credit and conversion exactly, or freezes the
 *   vault when the funds were already spent.
 */
export async function processPixEvent(
  providerId: string,
  event: PixPaymentEvent,
  market: MarketData = getMarketData(),
): Promise<PixEventResult> {
  const deposit =
    (event.txid ? getDepositByTxid(event.txid) : null) ??
    (event.providerChargeId ? getDepositByProviderCharge(providerId, event.providerChargeId) : null);
  if (!deposit) return { outcome: "unknown_deposit", depositId: null, deposit: null };
  // A provider can only settle its own charges (e.g. a sandbox webhook can never credit a real deposit).
  if (deposit.provider !== providerId) return { outcome: "provider_mismatch", depositId: deposit.id, deposit };

  if (event.status === "expired" || event.status === "failed") {
    return closeOrReverseDeposit(deposit, event);
  }

  const notifier = getCryptoNotifier();
  const provider = getPixProvider(providerId);
  const charged = BigInt(deposit.amountBrl);
  const reported = event.amountBrl ?? charged;
  if (reported <= 0n) return { outcome: "ignored", depositId: deposit.id, deposit };
  // Dynamic Pix charges fix the amount; never credit more than was requested.
  const amountBrl = reported > charged ? charged : reported;
  if (reported > charged) {
    await notifier.publish("deposit.overpaid", {
      vaultId: deposit.vaultId,
      depositId: deposit.id,
      reportedBrl: reported.toString(),
      creditedBrl: charged.toString(),
      status: "needs_review",
    });
  }

  // Ravi-side conversion needs a rate; fetch it before opening the write transaction.
  let raviConversion: { usdBrl: number; source: string } | null = null;
  const wantsRaviConversion =
    !provider.convertsOnProviderSide && !event.conversion && deposit.targetAssetId === ASSET_USDC;
  if (wantsRaviConversion && event.status === "paid") {
    const fx = await market.getUsdBrl();
    raviConversion = { usdBrl: fx.rate, source: fx.source };
  }

  let creditedNow = false;
  const outcome = withCryptoTransaction("deposit-settle", (db): PixEventOutcome => {
    const current = getDeposit(deposit.id);
    if (!current) return "unknown_deposit";
    if (current.status === "pending" || current.status === "expired") {
      const credit = postJournalInTransaction(db, {
        kind: "deposit.credit",
        refType: "deposit",
        refId: current.id,
        memo: `Pix ${current.provider} ${current.txid}`,
        entries: [
          { account: vaultAccount(current.vaultId), assetId: ASSET_BRL, amount: amountBrl },
          { account: SYSTEM_ACCOUNTS.pixInflow, assetId: ASSET_BRL, amount: -amountBrl },
        ],
      });
      updateDepositFields(db, current.id, {
        status: "credited",
        paidAt: event.paidAt ?? Date.now(),
        payerName: event.payerName,
        creditJournalId: credit.journal.id,
      });
      creditedNow = true;
    } else if (current.status !== "credited") {
      return "duplicate";
    }

    const conversion = event.conversion;
    if (conversion && (event.status === "converted" || event.status === "paid")) {
      postConversion(db, current, amountBrl, conversion.assetId, conversion.amountAtomic, conversion.feeBrl, {
        source: providerId,
        rate: conversion.rate,
      });
      return "converted";
    }
    if (raviConversion) {
      const feeBrl = applyBps(amountBrl, readNumberSetting("fees.conversionBps"));
      const usdcPerBrl = (1 / raviConversion.usdBrl).toFixed(12);
      const usdc = convertAtomic(amountBrl - feeBrl, 2, 6, usdcPerBrl);
      postConversion(db, current, amountBrl, ASSET_USDC, usdc, feeBrl, {
        source: `ravi:${raviConversion.source}`,
        rate: usdcPerBrl,
        usdBrl: raviConversion.usdBrl,
      });
      return "converted";
    }
    return creditedNow ? "credited" : "duplicate";
  });

  const updated = getDeposit(deposit.id);
  if (outcome === "credited" || outcome === "converted") {
    await notifier.publish(outcome === "converted" ? "deposit.converted" : "deposit.paid", {
      vaultId: deposit.vaultId,
      depositId: deposit.id,
      amountBrl: amountBrl.toString(),
      status: updated?.status,
    });
    await notifier.informSession(deposit.notify, describeSettlement(updated ?? deposit, amountBrl));
  }
  return { outcome, depositId: deposit.id, deposit: updated };
}

async function closeOrReverseDeposit(deposit: CryptoDeposit, event: PixPaymentEvent): Promise<PixEventResult> {
  const notifier = getCryptoNotifier();
  const terminal = event.status === "expired" ? "expired" : "failed";

  // Not yet credited: just close the charge.
  const closed = withCryptoTransaction("deposit-close", (db) => {
    const current = getDeposit(deposit.id);
    if (current?.status !== "pending") return false;
    updateDepositFields(db, deposit.id, { status: terminal });
    return true;
  });
  if (closed) {
    await notifier.publish(`deposit.${terminal}`, {
      vaultId: deposit.vaultId,
      depositId: deposit.id,
      status: terminal,
    });
    await notifier.informSession(
      deposit.notify,
      deposit.notify?.private
        ? `O Pix de ${formatBrl(BigInt(deposit.amountBrl))} (depósito ${deposit.id}) ${terminal === "expired" ? "expirou" : "falhou"} e não foi creditado.`
        : `Um depósito Pix (${deposit.id}) ${terminal === "expired" ? "expirou" : "falhou"} e não foi creditado.`,
    );
    return { outcome: terminal, depositId: deposit.id, deposit: getDeposit(deposit.id) };
  }

  // Refund/cancellation after credit: undo exactly what was posted.
  const current = getDeposit(deposit.id);
  if (event.status !== "failed" || !current || (current.status !== "credited" && current.status !== "converted")) {
    return { outcome: "duplicate", depositId: deposit.id, deposit: current };
  }
  try {
    withCryptoTransaction("deposit-reverse", (db) => {
      const entries = [current.creditJournalId, current.convertJournalId]
        .filter((id): id is string => Boolean(id))
        .flatMap((journalId) => getJournalEntries(db, journalId))
        .map((entry) => ({ ...entry, amount: -entry.amount }));
      postJournalInTransaction(db, {
        kind: "deposit.reversal",
        refType: "deposit",
        refId: current.id,
        memo: `Provider reversed Pix ${current.txid}`,
        entries,
      });
      updateDepositFields(db, current.id, { status: "reversed" });
    });
  } catch (error) {
    if (!(error instanceof CryptoLedgerError) || error.code !== "LEDGER_INSUFFICIENT_FUNDS") throw error;
    // The money was already spent: stop the vault and hand it to the operator.
    withCryptoTransaction("deposit-reversal-blocked", (db) => {
      updateDepositFields(db, current.id, { status: "reversal_blocked" });
      db.prepare("UPDATE crypto_vaults SET status = 'frozen', updated_at = ? WHERE id = ?").run(
        Date.now(),
        current.vaultId,
      );
    });
    await notifier.publish("deposit.reversal_blocked", {
      vaultId: current.vaultId,
      depositId: current.id,
      status: "reversal_blocked",
    });
    return { outcome: "failed", depositId: current.id, deposit: getDeposit(current.id) };
  }
  await notifier.publish("deposit.reversed", { vaultId: current.vaultId, depositId: current.id, status: "reversed" });
  await notifier.informSession(
    current.notify,
    `O provedor estornou o depósito Pix ${current.id}; o valor foi retirado do cofre.`,
  );
  return { outcome: "failed", depositId: current.id, deposit: getDeposit(current.id) };
}

function postConversion(
  db: Parameters<typeof postJournalInTransaction>[0],
  deposit: CryptoDeposit,
  amountBrl: bigint,
  targetAssetId: string,
  targetAmount: bigint,
  feeBrl: bigint,
  meta: Record<string, unknown>,
): void {
  const target = getAsset(targetAssetId);
  if (!target) throw new CryptoLedgerError(`Unknown conversion asset ${targetAssetId}`, "LEDGER_UNKNOWN_ASSET");
  const journal = postJournalInTransaction(db, {
    kind: "deposit.convert",
    refType: "deposit",
    refId: deposit.id,
    memo: `BRL→${target.symbol}`,
    entries: [
      { account: vaultAccount(deposit.vaultId), assetId: ASSET_BRL, amount: -amountBrl },
      { account: SYSTEM_ACCOUNTS.fees, assetId: ASSET_BRL, amount: feeBrl },
      { account: SYSTEM_ACCOUNTS.conversion, assetId: ASSET_BRL, amount: amountBrl - feeBrl },
      { account: vaultAccount(deposit.vaultId), assetId: targetAssetId, amount: targetAmount },
      { account: SYSTEM_ACCOUNTS.conversion, assetId: targetAssetId, amount: -targetAmount },
    ],
  });
  if (journal.duplicate) return;
  updateDepositFields(db, deposit.id, {
    status: "converted",
    convertJournalId: journal.journal.id,
    conversion: {
      ...meta,
      assetId: targetAssetId,
      symbol: target.symbol,
      amount: formatAtomic(targetAmount, target.decimals),
      feeBrl: formatAtomic(feeBrl, 2, { minFractionDigits: 2 }),
    },
  });
}

function describeSettlement(deposit: CryptoDeposit, amountBrl: bigint): string {
  if (!deposit.notify?.private) {
    // Group chats never see amounts or vault ids.
    return `Um depósito Pix (${deposit.id}) foi confirmado. Por privacidade, os valores só aparecem no privado: peça o saldo numa DM.`;
  }
  const base = `Pix de ${formatBrl(amountBrl)} recebido e creditado no cofre ${deposit.vaultId} (depósito ${deposit.id}).`;
  if (deposit.status === "converted" && deposit.conversion) {
    return `${base} Convertido em ${String(deposit.conversion.amount)} ${String(deposit.conversion.symbol)}. Use \`ravi crypto balance\` para mostrar o saldo atualizado.`;
  }
  return `${base} Use \`ravi crypto balance\` para mostrar o saldo atualizado.`;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Resolve a user's asset reference to a verified, tradable Solana asset (registered in the DB). */
export async function resolveTradableAsset(ref: string, market: MarketData = getMarketData()): Promise<CryptoAsset> {
  const trimmed = ref.trim();
  if (!trimmed)
    throw new CryptoServiceError("CRYPTO_ASSET_REQUIRED", "Specify an asset (symbol like TSLAx or a mint).");
  const catalog = findCatalogAsset(trimmed) ?? findCatalogByUnderlying(trimmed);
  if (catalog) {
    return upsertAsset({
      id: catalog.mint,
      symbol: catalog.symbol,
      name: catalog.name,
      decimals: catalog.decimals,
      kind: catalog.kind,
      chain: "solana",
    });
  }
  const known = resolveAsset(trimmed);
  if (known && known.kind !== "fiat") return known;

  if (MINT_PATTERN.test(trimmed)) {
    const info = await market.getTokenInfo(trimmed);
    if (!info) throw new CryptoServiceError("CRYPTO_ASSET_NOT_FOUND", `No token found for mint ${trimmed}.`);
    if (!info.isVerified) {
      throw new CryptoServiceError(
        "CRYPTO_ASSET_UNVERIFIED",
        `${info.symbol} (${trimmed}) is not a verified token; refusing to trade it.`,
      );
    }
    return registerVerifiedToken(info);
  }

  const results = (await market.searchTokens(trimmed)).filter(
    (token) => token.isVerified && token.symbol.toLowerCase() === trimmed.toLowerCase(),
  );
  if (results.length === 1) return registerVerifiedToken(results[0]);
  if (results.length > 1) {
    throw new CryptoServiceError(
      "CRYPTO_ASSET_AMBIGUOUS",
      `Several verified tokens are named ${trimmed}; pass the mint.`,
      {
        candidates: results
          .slice(0, 5)
          .map((token) => ({ symbol: token.symbol, mint: token.mint, liquidityUsd: token.liquidityUsd })),
      },
    );
  }
  throw new CryptoServiceError(
    "CRYPTO_ASSET_NOT_FOUND",
    `No verified token named ${trimmed}. Try a mint address or an xStock like TSLAx.`,
  );
}

function registerVerifiedToken(info: {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  tags: string[];
}): CryptoAsset {
  return upsertAsset({
    id: info.mint,
    symbol: info.symbol,
    name: info.name,
    decimals: info.decimals,
    kind: info.tags.includes("xstocks") ? "tokenized_stock" : "token",
    chain: "solana",
  });
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export type AmountUnit = "usd" | "brl" | "units" | "percent";

export interface ProposeTradeInput {
  vault: CryptoVault;
  side: TradeSide;
  assetRef: string;
  amount: string;
  unit: AmountUnit;
  rationale?: string | null;
  strategyId?: string | null;
  signalId?: string | null;
  slippageBps?: number;
  origin: "user" | "engine";
  notify: NotificationTarget | null;
}

export interface TradeProposal {
  trade: CryptoTrade;
  risk: RiskEvaluation;
  judge: JevJudgement | null;
}

export async function proposeTrade(
  input: ProposeTradeInput,
  market: MarketData = getMarketData(),
): Promise<TradeProposal> {
  if (input.vault.status !== "active") throw new CryptoServiceError("CRYPTO_VAULT_FROZEN", "This vault is frozen.");
  const asset = await resolveTradableAsset(input.assetRef, market);
  if (asset.id === ASSET_USDC)
    throw new CryptoServiceError(
      "CRYPTO_ASSET_INVALID",
      "USDC is the settlement asset; pick something to buy or sell.",
    );
  const usdc = getAsset(ASSET_USDC) as CryptoAsset;
  const inputAsset = input.side === "buy" ? usdc : asset;
  const outputAsset = input.side === "buy" ? asset : usdc;

  const prices = await market.getUsdPrices([asset.id]);
  const assetPrice = prices.get(asset.id) ?? null;
  const inputAmount = await resolveInputAmount(input, inputAsset, assetPrice?.usdPrice ?? null, market);
  if (inputAmount <= 0n) throw new CryptoServiceError("CRYPTO_INVALID_AMOUNT", "Trade amount must be positive.");

  const available = getAccountBalanceAtomic(vaultAccount(input.vault.id), inputAsset.id);
  if (available < inputAmount) {
    throw new CryptoServiceError(
      "CRYPTO_INSUFFICIENT_FUNDS",
      `Not enough ${inputAsset.symbol}: have ${formatAtomic(available, inputAsset.decimals)}, need ${formatAtomic(inputAmount, inputAsset.decimals)}.`,
      {
        asset: inputAsset.symbol,
        available: formatAtomic(available, inputAsset.decimals),
        required: formatAtomic(inputAmount, inputAsset.decimals),
      },
    );
  }

  const quote = await market.getQuote({
    inputMint: inputAsset.id,
    outputMint: outputAsset.id,
    amount: inputAmount,
    slippageBps: input.slippageBps ?? 50,
  });
  // Quote-only responses carry no slippage; never go below our own floor.
  const slippageBps = Math.max(input.slippageBps ?? 50, quote.slippageBps);
  const minOutput = (quote.outAmount * BigInt(10_000 - slippageBps)) / 10_000n;
  const notionalUsd =
    input.side === "buy" ? atomicToNumber(inputAmount, usdc.decimals) : atomicToNumber(quote.outAmount, usdc.decimals);

  const portfolio = await getPortfolio(input.vault, market);
  const risk = evaluateTradeRisk({
    vaultStatus: input.vault.status,
    notionalUsd,
    vaultEquityUsd: portfolio.totals.usd,
    dailyUsedUsd: sumRecentTradeNotionalUsd(input.vault.id, Date.now() - DAY_MS),
    slippageBps,
    priceImpactPct: quote.priceImpactPct,
    assetId: asset.id,
    liquidityUsd: assetPrice?.liquidityUsd ?? null,
    side: input.side,
  });
  if (!risk.allowed) {
    throw new CryptoServiceError(
      "CRYPTO_TRADE_RISK_BLOCKED",
      `Trade blocked by risk limits: ${risk.violations.join("; ")}`,
      {
        violations: risk.violations,
      },
    );
  }

  let judge: JevJudgement | null = null;
  if (readBoolSetting("jev.enabled")) {
    const features = await buildAssetFeatures(asset, market);
    judge = await judgeWithJev({
      kind: input.origin === "engine" ? "copy_trade" : "user_request",
      side: input.side,
      asset: { symbol: asset.symbol, mint: asset.id, category: asset.kind },
      features: {
        ...features,
        priceImpactPct: quote.priceImpactPct,
        liquidityUsd: assetPrice?.liquidityUsd ?? null,
      },
      portfolio: {
        riskProfile: input.vault.riskProfile,
        equityUsd: portfolio.totals.usd,
        proposedNotionalUsd: round2(notionalUsd),
        proposedFraction: portfolio.totals.usd > 0 ? round4(notionalUsd / portfolio.totals.usd) : 1,
      },
    });
    // Engine ideas need Jev's blessing; explicit user requests only carry Jev's opinion to the approver.
    if (input.origin === "engine" && !judge.passed) {
      throw new CryptoServiceError(
        "CRYPTO_TRADE_JUDGE_BLOCKED",
        `Jev did not approve this signal: ${judge.reasons.join("; ")}`,
        {
          judge,
        },
      );
    }
  }

  const trade = createTrade({
    vaultId: input.vault.id,
    side: input.side,
    inputAssetId: inputAsset.id,
    outputAssetId: outputAsset.id,
    inputAmount,
    expectedOutput: quote.outAmount,
    minOutput,
    slippageBps,
    priceImpactPct: quote.priceImpactPct,
    executionMode: getExecutionMode(),
    rationale: input.rationale?.trim().slice(0, 1000) || null,
    strategyId: input.strategyId ?? null,
    signalId: input.signalId ?? null,
    quote: {
      source: quote.source,
      router: quote.router,
      inAmount: quote.inAmount.toString(),
      outAmount: quote.outAmount.toString(),
      priceImpactPct: quote.priceImpactPct,
      fetchedAt: quote.fetchedAt,
      assetUsdPrice: assetPrice?.usdPrice ?? null,
    },
    judge: judge as unknown as Record<string, unknown> | null,
    risk: { notionalUsd: round2(notionalUsd), equityUsd: portfolio.totals.usd, checks: risk.checks },
    notify: input.notify,
    expiresAt: Date.now() + readNumberSetting("trade.ttlMinutes") * 60_000,
  });
  await getCryptoNotifier().publish("trade.proposed", {
    vaultId: trade.vaultId,
    tradeId: trade.id,
    side: trade.side,
    asset: asset.symbol,
    notionalUsd: round2(notionalUsd),
    executionMode: trade.executionMode,
    status: trade.status,
  });
  return { trade, risk, judge };
}

async function resolveInputAmount(
  input: ProposeTradeInput,
  inputAsset: CryptoAsset,
  assetUsdPrice: number | null,
  market: MarketData,
): Promise<bigint> {
  const parse = (text: string, decimals: number) => {
    try {
      return parseDecimalToAtomic(text, decimals);
    } catch (error) {
      throw new CryptoServiceError("CRYPTO_INVALID_AMOUNT", error instanceof Error ? error.message : String(error));
    }
  };
  const balance = getAccountBalanceAtomic(vaultAccount(input.vault.id), inputAsset.id);
  if (input.unit === "percent") {
    const pct = Number(input.amount);
    if (!(pct > 0 && pct <= 100)) throw new CryptoServiceError("CRYPTO_INVALID_AMOUNT", "Percent must be in (0, 100].");
    return (balance * BigInt(Math.round(pct * 100))) / 10_000n;
  }
  let usd: string | null = null;
  if (input.unit === "usd") usd = input.amount;
  if (input.unit === "brl") {
    const fx = await market.getUsdBrl();
    usd = (Number(formatAtomic(parse(input.amount, 2), 2)) / fx.rate).toFixed(6);
  }
  if (input.side === "buy") {
    if (input.unit === "units") {
      throw new CryptoServiceError("CRYPTO_INVALID_AMOUNT", "Buys are sized in money: use --unit usd, brl or percent.");
    }
    return parse(usd as string, inputAsset.decimals);
  }
  // Sells spend the asset itself.
  if (input.unit === "units") return parse(input.amount, inputAsset.decimals);
  if (!assetUsdPrice)
    throw new CryptoServiceError(
      "CRYPTO_PRICE_UNAVAILABLE",
      "No price available to size this sell; use --unit units or percent.",
    );
  const units = Number(usd) / assetUsdPrice;
  // toFixed never exceeds the asset's precision and the parser accepts trailing zeros.
  return parse(units.toFixed(Math.min(inputAsset.decimals, 12)), inputAsset.decimals);
}

/** Numeric features for Jev / the approver, computed defensively (history may be unavailable). */
export async function buildAssetFeatures(
  asset: CryptoAsset,
  market: MarketData = getMarketData(),
): Promise<Record<string, number | string | boolean | null>> {
  try {
    const closes = await market.getDailyCloses(asset.id, 90);
    const summary = summarizePriceSeries(closes, asset.kind === "tokenized_stock" ? 252 : 365);
    return { ...summary, historyDays: closes.length } as unknown as Record<string, number | string | boolean | null>;
  } catch {
    return { historyDays: 0 };
  }
}

export async function cancelTrade(trade: CryptoTrade): Promise<CryptoTrade> {
  const changed = withCryptoTransaction("trade-cancel", (db) =>
    transitionTrade(db, trade.id, ["pending_approval"], "cancelled", { decidedAt: Date.now() }),
  );
  if (!changed)
    throw new CryptoServiceError(
      "CRYPTO_TRADE_NOT_PENDING",
      `Trade ${trade.id} is ${getTrade(trade.id)?.status}; only pending trades can be cancelled.`,
    );
  return getTrade(trade.id) as CryptoTrade;
}

export interface TradeDecision {
  decision: "approve" | "reject";
  decidedBy: string;
  via: "cli" | "reaction" | "slack";
  reason?: string | null;
}

/**
 * Operator decision. Callers MUST have verified operator authority (CLI refuses
 * agent runtime; the runner trusts the approval service's server-side grantor check).
 */
export async function decideTrade(
  tradeId: string,
  decision: TradeDecision,
  market: MarketData = getMarketData(),
): Promise<CryptoTrade> {
  const trade = getTrade(tradeId);
  if (!trade) throw new CryptoServiceError("CRYPTO_TRADE_NOT_FOUND", `Trade not found: ${tradeId}`);
  const now = Date.now();
  const approval = { ...decision, decidedAt: new Date(now).toISOString() };

  if (trade.status === "pending_approval" && trade.expiresAt < now) {
    withCryptoTransaction("trade-expire", (db) =>
      transitionTrade(db, trade.id, ["pending_approval"], "expired", { decidedAt: now }),
    );
    throw new CryptoServiceError("CRYPTO_TRADE_EXPIRED", `Trade ${trade.id} expired; ask for a fresh proposal.`);
  }

  if (decision.decision === "reject") return rejectTrade(trade, approval, decision.reason ?? null);
  if (trade.status !== "pending_approval") {
    throw new CryptoServiceError("CRYPTO_TRADE_NOT_PENDING", `Trade ${trade.id} is already ${trade.status}.`);
  }

  // Limits may have changed, other trades may have executed, and prices move:
  // re-run every risk check against a fresh quote before any money is held.
  const recheck = await recheckTradeRisk(trade, market);
  if (recheck.violations.length > 0) {
    await rejectTrade(trade, approval, `risk re-check failed: ${recheck.violations.join("; ")}`);
    throw new CryptoServiceError(
      "CRYPTO_TRADE_RISK_BLOCKED",
      `Trade ${trade.id} no longer passes risk limits and was rejected: ${recheck.violations.join("; ")}`,
      { violations: recheck.violations },
    );
  }

  // Approve: status change and fund hold commit together, or not at all. The
  // daily cap is re-checked inside the write lock so concurrent approvals
  // cannot jointly exceed it.
  withCryptoTransaction("trade-approve", (db) => {
    const dailyUsed = sumRecentTradeNotionalUsd(trade.vaultId, now - DAY_MS);
    const maxDaily = readNumberSetting("risk.maxDailyUsd");
    if (dailyUsed + recheck.notionalUsd > maxDaily) {
      throw new CryptoServiceError(
        "CRYPTO_TRADE_RISK_BLOCKED",
        `Daily limit reached: $${dailyUsed.toFixed(2)} used + $${recheck.notionalUsd.toFixed(2)} > $${maxDaily}.`,
      );
    }
    if (!transitionTrade(db, trade.id, ["pending_approval"], "approved", { approval, decidedAt: now })) {
      throw new CryptoServiceError(
        "CRYPTO_TRADE_NOT_PENDING",
        `Trade ${trade.id} is already ${getTrade(trade.id)?.status}.`,
      );
    }
    postJournalInTransaction(db, {
      kind: "trade.hold",
      refType: "trade",
      refId: trade.id,
      entries: [
        { account: vaultAccount(trade.vaultId), assetId: trade.inputAssetId, amount: -BigInt(trade.inputAmount) },
        { account: HOLD_ACCOUNT, assetId: trade.inputAssetId, amount: BigInt(trade.inputAmount) },
      ],
    });
  });
  return executeApprovedTrade(trade.id, market);
}

async function rejectTrade(
  trade: CryptoTrade,
  approval: Record<string, unknown>,
  reason: string | null,
): Promise<CryptoTrade> {
  const now = Date.now();
  const changed = withCryptoTransaction("trade-reject", (db) =>
    transitionTrade(db, trade.id, ["pending_approval"], "rejected", {
      approval: { ...approval, decision: "reject", ...(reason ? { reason } : {}) },
      decidedAt: now,
    }),
  );
  if (!changed) {
    throw new CryptoServiceError(
      "CRYPTO_TRADE_NOT_PENDING",
      `Trade ${trade.id} is already ${getTrade(trade.id)?.status}.`,
    );
  }
  await getCryptoNotifier().publish("trade.rejected", {
    vaultId: trade.vaultId,
    tradeId: trade.id,
    status: "rejected",
  });
  await getCryptoNotifier().informSession(
    trade.notify,
    `A proposta de trade ${trade.id} foi recusada${reason ? `: ${reason}` : "."}`,
  );
  return getTrade(trade.id) as CryptoTrade;
}

/** Fresh-quote risk evaluation for a pending trade (approval-time re-check). */
async function recheckTradeRisk(
  trade: CryptoTrade,
  market: MarketData,
): Promise<{ violations: string[]; notionalUsd: number }> {
  const vault = getVault(trade.vaultId);
  if (!vault) return { violations: ["vault_missing"], notionalUsd: 0 };
  const violations: string[] = [];
  if (trade.executionMode === "live" && vaultHasSandboxFunds(vault.id)) {
    violations.push("sandbox_funds: this vault holds sandbox (test) deposits and cannot trade live");
  }
  const asset = trade.side === "buy" ? trade.outputAssetId : trade.inputAssetId;
  const [quote, prices, portfolio] = await Promise.all([
    market.getQuote({
      inputMint: trade.inputAssetId,
      outputMint: trade.outputAssetId,
      amount: BigInt(trade.inputAmount),
      slippageBps: trade.slippageBps,
    }),
    market.getUsdPrices([asset]),
    getPortfolio(vault, market),
  ]);
  const notionalUsd =
    trade.side === "buy" ? atomicToNumber(BigInt(trade.inputAmount), 6) : atomicToNumber(quote.outAmount, 6);
  const risk = evaluateTradeRisk({
    vaultStatus: vault.status,
    notionalUsd,
    vaultEquityUsd: portfolio.totals.usd,
    dailyUsedUsd: sumRecentTradeNotionalUsd(vault.id, Date.now() - DAY_MS),
    slippageBps: trade.slippageBps,
    priceImpactPct: quote.priceImpactPct,
    assetId: asset,
    liquidityUsd: prices.get(asset)?.liquidityUsd ?? null,
    side: trade.side,
  });
  return { violations: [...violations, ...risk.violations], notionalUsd };
}

export async function executeApprovedTrade(
  tradeId: string,
  market: MarketData = getMarketData(),
): Promise<CryptoTrade> {
  const trade = getTrade(tradeId);
  if (!trade) throw new CryptoServiceError("CRYPTO_TRADE_NOT_FOUND", `Trade not found: ${tradeId}`);
  const vault = getVault(trade.vaultId);
  const blocker = readBoolSetting("risk.killSwitch")
    ? "kill switch is on"
    : vault?.status !== "active"
      ? "vault is frozen"
      : getExecutionMode() !== trade.executionMode
        ? `execution mode changed to ${getExecutionMode()} after this trade was proposed in ${trade.executionMode} mode`
        : trade.executionMode === "live" && vaultHasSandboxFunds(trade.vaultId)
          ? "vault holds sandbox (test) deposits and cannot trade live"
          : null;

  const claimed = withCryptoTransaction("trade-claim", (db) =>
    transitionTrade(db, trade.id, ["approved"], "executing"),
  );
  if (!claimed)
    throw new CryptoServiceError(
      "CRYPTO_TRADE_NOT_APPROVED",
      `Trade ${trade.id} is ${getTrade(trade.id)?.status}, not approved.`,
    );

  if (blocker) return failTrade(trade, `Execution blocked: ${blocker}.`);

  let fill: ExecutionFill;
  try {
    fill = await executorFor(trade.executionMode).execute(trade, market);
  } catch (error) {
    if (error instanceof ExecutionError && error.code === "EXECUTION_OUTCOME_UNKNOWN") {
      return markOutcomeUnknown(trade, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return failTrade(trade, message);
  }
  return completeFill(trade, fill);
}

/** Post the fill journal and finish the trade (shared by execution and operator reconciliation). */
function completeFill(
  trade: CryptoTrade,
  fill: Pick<ExecutionFill, "inputAmount" | "outputAmount" | "txSignature">,
): Promise<CryptoTrade> {
  const held = BigInt(trade.inputAmount);
  // Live fills may spend slightly less than held; return any remainder to the vault.
  const spent = fill.inputAmount > held ? held : fill.inputAmount;
  withCryptoTransaction("trade-fill", (db) => {
    if (
      !transitionTrade(db, trade.id, ["executing"], "executed", {
        executedOutput: fill.outputAmount,
        txSignature: fill.txSignature,
        executedAt: Date.now(),
        error: null,
      })
    ) {
      throw new CryptoServiceError("CRYPTO_TRADE_NOT_EXECUTING", `Trade ${trade.id} is not executing.`);
    }
    postJournalInTransaction(db, {
      kind: "trade.fill",
      refType: "trade",
      refId: trade.id,
      memo: `${trade.side} ${trade.executionMode}${fill.txSignature ? ` ${fill.txSignature}` : ""}`,
      entries: [
        { account: HOLD_ACCOUNT, assetId: trade.inputAssetId, amount: -held },
        { account: vaultAccount(trade.vaultId), assetId: trade.inputAssetId, amount: held - spent },
        { account: SYSTEM_ACCOUNTS.market, assetId: trade.inputAssetId, amount: spent },
        { account: vaultAccount(trade.vaultId), assetId: trade.outputAssetId, amount: fill.outputAmount },
        { account: SYSTEM_ACCOUNTS.market, assetId: trade.outputAssetId, amount: -fill.outputAmount },
      ],
    });
  });
  return announceFill(trade, spent, fill.outputAmount, fill.txSignature);
}

async function announceFill(trade: CryptoTrade, spent: bigint, output: bigint, txSignature: string | null) {
  const executed = getTrade(trade.id) as CryptoTrade;
  const outputAsset = getAsset(trade.outputAssetId);
  const inputAsset = getAsset(trade.inputAssetId);
  await getCryptoNotifier().publish("trade.executed", {
    vaultId: trade.vaultId,
    tradeId: trade.id,
    executionMode: trade.executionMode,
    txSignature,
    status: "executed",
  });
  const mode = trade.executionMode === "paper" ? "simulação/paper" : "on-chain";
  await getCryptoNotifier().informSession(
    trade.notify,
    trade.notify?.private
      ? `Trade ${trade.id} executado (${mode}): ${formatAtomic(spent, inputAsset?.decimals ?? 6)} ${inputAsset?.symbol ?? ""} → ${formatAtomic(output, outputAsset?.decimals ?? 6)} ${outputAsset?.symbol ?? ""}.${txSignature ? ` Tx: ${txSignature}` : ""}`
      : `O trade ${trade.id} foi executado (${mode}). Detalhes no privado (DM).`,
  );
  return executed;
}

async function markOutcomeUnknown(trade: CryptoTrade, message: string): Promise<CryptoTrade> {
  // The swap may have landed: keep the funds held and the trade executing until reconciled.
  withCryptoTransaction("trade-unknown", (db) =>
    transitionTrade(db, trade.id, ["executing"], "executing", { error: `OUTCOME UNKNOWN: ${message}`.slice(0, 500) }),
  );
  await getCryptoNotifier().publish("trade.outcome_unknown", {
    vaultId: trade.vaultId,
    tradeId: trade.id,
    status: "executing",
  });
  await getCryptoNotifier().informSession(
    trade.notify,
    `O trade ${trade.id} está em verificação: a confirmação da rede não chegou. O saldo segue reservado até o operador conciliar.`,
  );
  return getTrade(trade.id) as CryptoTrade;
}

async function failTrade(trade: CryptoTrade, message: string): Promise<CryptoTrade> {
  const changed = withCryptoTransaction("trade-fail", (db) => {
    if (!transitionTrade(db, trade.id, ["executing", "approved"], "failed", { error: message.slice(0, 500) })) {
      return false;
    }
    // Release the hold back to the vault.
    postJournalInTransaction(db, {
      kind: "trade.release",
      refType: "trade",
      refId: trade.id,
      entries: [
        { account: HOLD_ACCOUNT, assetId: trade.inputAssetId, amount: -BigInt(trade.inputAmount) },
        { account: vaultAccount(trade.vaultId), assetId: trade.inputAssetId, amount: BigInt(trade.inputAmount) },
      ],
    });
    return true;
  });
  if (changed) {
    await getCryptoNotifier().publish("trade.failed", { vaultId: trade.vaultId, tradeId: trade.id, status: "failed" });
    await getCryptoNotifier().informSession(
      trade.notify,
      `O trade ${trade.id} não foi executado: ${message} O saldo reservado voltou para o cofre.`,
    );
  }
  return getTrade(trade.id) as CryptoTrade;
}

export type ReconcileResolution =
  | { outcome: "retry" }
  | { outcome: "failed"; reason: string }
  | { outcome: "filled"; outputAmount: bigint; inputAmount?: bigint; txSignature: string | null };

/**
 * Operator recovery for trades stuck in `approved` (never sent) or `executing`
 * (outcome unknown). The operator decides from chain evidence; the ledger
 * follows exactly one resolution.
 */
export async function reconcileTrade(
  tradeId: string,
  resolution: ReconcileResolution,
  market: MarketData = getMarketData(),
): Promise<CryptoTrade> {
  const trade = getTrade(tradeId);
  if (!trade) throw new CryptoServiceError("CRYPTO_TRADE_NOT_FOUND", `Trade not found: ${tradeId}`);
  if (trade.status !== "approved" && trade.status !== "executing") {
    throw new CryptoServiceError(
      "CRYPTO_TRADE_NOT_RECONCILABLE",
      `Trade ${trade.id} is ${trade.status}; only approved or executing trades can be reconciled.`,
    );
  }
  if (resolution.outcome === "retry") {
    if (trade.status !== "approved") {
      throw new CryptoServiceError(
        "CRYPTO_TRADE_NOT_RECONCILABLE",
        "Only never-sent (approved) trades can be retried; an executing trade may already be on-chain.",
      );
    }
    return executeApprovedTrade(trade.id, market);
  }
  if (resolution.outcome === "failed") return failTrade(trade, `Reconciled as failed: ${resolution.reason}`);
  if (trade.status === "approved") {
    withCryptoTransaction("trade-claim", (db) => transitionTrade(db, trade.id, ["approved"], "executing"));
  }
  if (resolution.outputAmount <= 0n) throw new CryptoServiceError("CRYPTO_INVALID_AMOUNT", "Output must be positive.");
  return completeFill(trade, {
    inputAmount: resolution.inputAmount ?? BigInt(trade.inputAmount),
    outputAmount: resolution.outputAmount,
    txSignature: resolution.txSignature,
  });
}

export interface PublicTrade {
  id: string;
  vaultId: string;
  side: TradeSide;
  status: CryptoTrade["status"];
  executionMode: CryptoTrade["executionMode"];
  input: { symbol: string; amount: string };
  expectedOutput: { symbol: string; amount: string };
  minOutput: string;
  executedOutput: string | null;
  slippageBps: number;
  priceImpactPct: number | null;
  notionalUsd: number | null;
  rationale: string | null;
  judge: { verdict: string; confidence: number; passed: boolean; reasons: string[] } | null;
  txSignature: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

export function publicTrade(trade: CryptoTrade): PublicTrade {
  const input = getAsset(trade.inputAssetId);
  const output = getAsset(trade.outputAssetId);
  const outDecimals = output?.decimals ?? 6;
  const judge = trade.judge
    ? {
        verdict: String(trade.judge.verdict ?? "skip"),
        confidence: Number(trade.judge.confidence) || 0,
        passed: trade.judge.passed === true,
        reasons: Array.isArray(trade.judge.reasons) ? trade.judge.reasons.map(String) : [],
      }
    : null;
  return {
    id: trade.id,
    vaultId: trade.vaultId,
    side: trade.side,
    status: trade.status,
    executionMode: trade.executionMode,
    input: {
      symbol: input?.symbol ?? trade.inputAssetId,
      amount: formatAtomic(BigInt(trade.inputAmount), input?.decimals ?? 6),
    },
    expectedOutput: {
      symbol: output?.symbol ?? trade.outputAssetId,
      amount: formatAtomic(BigInt(trade.expectedOutput), outDecimals),
    },
    minOutput: formatAtomic(BigInt(trade.minOutput), outDecimals),
    executedOutput: trade.executedOutput === null ? null : formatAtomic(BigInt(trade.executedOutput), outDecimals),
    slippageBps: trade.slippageBps,
    priceImpactPct: trade.priceImpactPct,
    notionalUsd: typeof trade.risk?.notionalUsd === "number" ? trade.risk.notionalUsd : null,
    rationale: trade.rationale,
    judge,
    txSignature: trade.txSignature,
    error: trade.error,
    createdAt: new Date(trade.createdAt).toISOString(),
    expiresAt: new Date(trade.expiresAt).toISOString(),
  };
}

/** Text the operator sees when asked to approve (also shown by `trades show`). */
export function describeTradeForApproval(trade: CryptoTrade): string {
  const view = publicTrade(trade);
  const lines = [
    `Trade ${view.id} (${view.executionMode.toUpperCase()}) — cofre ${view.vaultId}`,
    `${view.side === "buy" ? "Comprar" : "Vender"}: ${view.input.amount} ${view.input.symbol} → ~${view.expectedOutput.amount} ${view.expectedOutput.symbol} (mín ${view.minOutput})`,
    `Notional: $${view.notionalUsd ?? "?"} · slippage ${view.slippageBps} bps · impacto ${view.priceImpactPct?.toFixed(3) ?? "?"}%`,
  ];
  if (view.rationale) lines.push(`Motivo: ${view.rationale}`);
  if (view.judge)
    lines.push(
      `Jev: ${String(view.judge.verdict)} @ ${Number(view.judge.confidence).toFixed(2)} (${view.judge.passed ? "ok" : "alerta"})`,
    );
  lines.push(`Expira: ${view.expiresAt}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export async function sweepExpired(now = Date.now()): Promise<{ deposits: number; trades: number }> {
  let deposits = 0;
  for (const deposit of listExpiredPendingDeposits(now - DEPOSIT_EXPIRY_GRACE_MS)) {
    const result = await processPixEvent(deposit.provider, {
      eventId: `sweep:${deposit.id}`,
      txid: deposit.txid,
      providerChargeId: deposit.providerChargeId,
      status: "expired",
      amountBrl: null,
      paidAt: null,
      payerName: null,
      conversion: null,
    });
    if (result.outcome === "expired") deposits++;
  }
  let trades = 0;
  for (const trade of listExpiredPendingTrades(now)) {
    const changed = withCryptoTransaction("trade-expire", (db) =>
      transitionTrade(db, trade.id, ["pending_approval"], "expired", { decidedAt: now }),
    );
    if (changed) {
      trades++;
      await getCryptoNotifier().informSession(trade.notify, `A proposta de trade ${trade.id} expirou sem aprovação.`);
    }
  }
  return { deposits, trades };
}

export const STALE_APPROVED_MS = 2 * 60_000;
export const STUCK_EXECUTING_MS = 10 * 60_000;

/**
 * Recover from crashes between approval and execution. Approved trades were
 * never sent, so re-executing them is safe (claiming is compare-and-set).
 * Executing trades may be on-chain: they are only reported for reconciliation.
 */
export async function sweepStaleTrades(
  now = Date.now(),
  market: MarketData = getMarketData(),
): Promise<{ retried: string[]; stuck: string[] }> {
  const retried: string[] = [];
  for (const trade of listTradesStaleInStatus("approved", now - STALE_APPROVED_MS)) {
    try {
      await executeApprovedTrade(trade.id, market);
      retried.push(trade.id);
    } catch {
      // Claimed concurrently or failed and released: nothing else to do here.
    }
  }
  const stuck = listTradesStaleInStatus("executing", now - STUCK_EXECUTING_MS).map((trade) => trade.id);
  return { retried, stuck };
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
