/**
 * Trade executors. Both receive an already-approved trade and must either fill
 * at or above `minOutput` or throw without side effects on the ledger (the
 * service posts the journal only after a successful fill).
 *
 * - paper: fills at a fresh live quote; no chain interaction. Default.
 * - live:  omnibus treasury wallet swaps via Jupiter Swap API V2. Vault
 *          ownership is tracked on Ravi's ledger, not on-chain.
 */

import { readSetting } from "../config.js";
import type { MarketData, SwapQuote } from "../market/types.js";
import { lookupSecret } from "../secrets.js";
import type { CryptoTrade, ExecutionMode } from "../types.js";
import { base58Encode, parseSolanaSecretKey, signTransactionBase64, parseTransaction } from "./solana.js";

export interface ExecutionFill {
  inputAmount: bigint;
  outputAmount: bigint;
  txSignature: string | null;
  quote: SwapQuote;
}

export interface TradeExecutor {
  readonly mode: ExecutionMode;
  execute(trade: CryptoTrade, market: MarketData): Promise<ExecutionFill>;
}

export class ExecutionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

export class PaperExecutor implements TradeExecutor {
  readonly mode = "paper" as const;

  async execute(trade: CryptoTrade, market: MarketData): Promise<ExecutionFill> {
    const inputAmount = BigInt(trade.inputAmount);
    const quote = await market.getQuote({
      inputMint: trade.inputAssetId,
      outputMint: trade.outputAssetId,
      amount: inputAmount,
      slippageBps: trade.slippageBps,
    });
    if (quote.outAmount < BigInt(trade.minOutput)) {
      throw new ExecutionError(
        `Price moved beyond tolerance: fresh quote ${quote.outAmount} < approved minimum ${trade.minOutput}.`,
        "EXECUTION_SLIPPAGE",
      );
    }
    return { inputAmount, outputAmount: quote.outAmount, txSignature: null, quote };
  }
}

export const TREASURY_SECRET_PROVIDER = "solana";

export class JupiterLiveExecutor implements TradeExecutor {
  readonly mode = "live" as const;

  constructor(private readonly secretOverride?: string) {}

  async execute(trade: CryptoTrade, market: MarketData): Promise<ExecutionFill> {
    const walletAddress = readSetting("live.walletAddress").trim();
    if (!walletAddress) {
      throw new ExecutionError("live.walletAddress is not configured.", "EXECUTION_NOT_CONFIGURED");
    }
    const secret =
      this.secretOverride ??
      (await lookupSecret({
        provider: TREASURY_SECRET_PROVIDER,
        connection: readSetting("live.connection"),
        action: "swap.sign",
      }));
    if (!secret) {
      throw new ExecutionError(
        "Treasury key not found in the credential broker (provider=solana).",
        "EXECUTION_NOT_CONFIGURED",
      );
    }
    const keypair = parseSolanaSecretKey(secret);
    if (keypair.publicKey !== walletAddress) {
      throw new ExecutionError("Treasury key does not match live.walletAddress.", "EXECUTION_KEY_MISMATCH");
    }

    const inputAmount = BigInt(trade.inputAmount);
    const quote = await market.getQuote({
      inputMint: trade.inputAssetId,
      outputMint: trade.outputAssetId,
      amount: inputAmount,
      slippageBps: trade.slippageBps,
      taker: walletAddress,
    });
    if (!quote.transaction || !quote.requestId) {
      throw new ExecutionError("Jupiter returned no transaction to sign.", "EXECUTION_NO_TRANSACTION");
    }
    // Missing safety fields must never default to optimistic values.
    if (!quote.reported?.inAmount || !quote.reported.otherAmountThreshold) {
      throw new ExecutionError(
        "Order is missing inAmount/otherAmountThreshold; refusing to sign.",
        "EXECUTION_INCOMPLETE_ORDER",
      );
    }
    if (quote.inAmount !== inputAmount) {
      throw new ExecutionError("Order input amount differs from the approved trade.", "EXECUTION_AMOUNT_MISMATCH");
    }
    // The order's on-chain minimum must honor what the operator approved.
    if (quote.otherAmountThreshold < BigInt(trade.minOutput)) {
      throw new ExecutionError(
        `Order worst-case output ${quote.otherAmountThreshold} < approved minimum ${trade.minOutput}.`,
        "EXECUTION_SLIPPAGE",
      );
    }

    const { signedTransaction, slot } = signTransactionBase64(quote.transaction, keypair);
    // From here on the transaction may reach the chain: anything ambiguous is "outcome unknown", not failure.
    const ourSignature = signatureAt(signedTransaction, slot);
    let result: Awaited<ReturnType<MarketData["executeSwap"]>>;
    try {
      result = await market.executeSwap({ signedTransaction, requestId: quote.requestId });
    } catch (error) {
      throw new ExecutionError(
        `Execute call failed after signing (${error instanceof Error ? error.message : String(error)}); our signature ${ourSignature}.`,
        "EXECUTION_OUTCOME_UNKNOWN",
      );
    }
    if (result.status !== "Success") {
      throw new ExecutionError(result.error ?? "Swap failed.", "EXECUTION_FAILED");
    }
    if (!result.signature || result.outputAmount === null) {
      throw new ExecutionError(
        `Swap reported success without a signature/output amount; our signature ${ourSignature}.`,
        "EXECUTION_OUTCOME_UNKNOWN",
      );
    }
    return {
      // Without a reported input, assume the whole held amount was spent (never refund unverified value).
      inputAmount: result.inputAmount ?? inputAmount,
      outputAmount: result.outputAmount,
      txSignature: result.signature,
      quote,
    };
  }
}

const executorOverrides = new Map<ExecutionMode, TradeExecutor>();

export function executorFor(mode: ExecutionMode): TradeExecutor {
  return executorOverrides.get(mode) ?? (mode === "live" ? new JupiterLiveExecutor() : new PaperExecutor());
}

export function setExecutorForTest(mode: ExecutionMode, executor: TradeExecutor | null): void {
  if (executor) executorOverrides.set(mode, executor);
  else executorOverrides.delete(mode);
}

function signatureAt(transactionBase64: string, slot: number): string {
  const bytes = Uint8Array.from(Buffer.from(transactionBase64, "base64"));
  const parsed = parseTransaction(bytes);
  return base58Encode(bytes.slice(parsed.signaturesOffset + slot * 64, parsed.signaturesOffset + (slot + 1) * 64));
}
