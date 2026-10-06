/**
 * Helius enhanced-transaction webhooks → watched-wallet events.
 *
 * Register a Helius "enhanced" webhook for the watched addresses pointing at
 * `/webhooks/crypto/helius`, with an `authHeader` value stored in the broker
 * (provider "helius", connection "webhook") or HELIUS_WEBHOOK_AUTH. Helius
 * echoes it in the Authorization header; there is no HMAC. Deliveries may be
 * retried, so events are deduped by (wallet, signature).
 */

import { timingSafeEqual } from "node:crypto";
import { getWatchedWallet, recordWalletEvent } from "../db.js";
import { lookupSecret } from "../secrets.js";
import { ASSET_SOL, ASSET_USDC, type WalletEvent } from "../types.js";

export const HELIUS_SECRET = {
  provider: "helius",
  connection: "webhook",
  action: "webhook.verify",
  envVar: "HELIUS_WEBHOOK_AUTH",
};

/** Ignore SOL movements below this (fees, rent, dust). */
const MIN_SOL_LEG = 0.01;

interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount?: number;
  mint?: string;
}

interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number;
}

export interface HeliusEnhancedTx {
  signature?: string;
  type?: string;
  timestamp?: number;
  feePayer?: string;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
  transactionError?: unknown;
}

export async function verifyHeliusAuth(header: string | null, secretOverride?: string | null): Promise<boolean> {
  const secret = secretOverride === undefined ? await lookupSecret(HELIUS_SECRET) : secretOverride;
  if (!secret || !header) return false;
  const a = Buffer.from(header.trim());
  const b = Buffer.from(secret.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Leg {
  mint: string;
  amount: number;
}

/** Net flows per mint for one wallet in one transaction (positive = received). */
export function walletFlows(tx: HeliusEnhancedTx, wallet: string): Map<string, number> {
  const flows = new Map<string, number>();
  const add = (mint: string, delta: number) => flows.set(mint, (flows.get(mint) ?? 0) + delta);
  for (const transfer of tx.tokenTransfers ?? []) {
    if (!transfer.mint || typeof transfer.tokenAmount !== "number") continue;
    if (transfer.fromUserAccount === wallet) add(transfer.mint, -transfer.tokenAmount);
    if (transfer.toUserAccount === wallet) add(transfer.mint, transfer.tokenAmount);
  }
  for (const transfer of tx.nativeTransfers ?? []) {
    if (typeof transfer.amount !== "number") continue;
    const sol = transfer.amount / 1e9;
    if (transfer.fromUserAccount === wallet) add(ASSET_SOL, -sol);
    if (transfer.toUserAccount === wallet) add(ASSET_SOL, sol);
  }
  const solFlow = flows.get(ASSET_SOL);
  if (solFlow !== undefined && Math.abs(solFlow) < MIN_SOL_LEG) flows.delete(ASSET_SOL);
  for (const [mint, value] of flows) if (Math.abs(value) < 1e-12) flows.delete(mint);
  return flows;
}

export function classifyFlows(flows: Map<string, number>): {
  kind: WalletEvent["kind"];
  tokenIn: Leg | null;
  tokenOut: Leg | null;
} {
  const sent = [...flows].filter(([, v]) => v < 0).map(([mint, v]) => ({ mint, amount: -v }));
  const received = [...flows].filter(([, v]) => v > 0).map(([mint, v]) => ({ mint, amount: v }));
  const largest = (legs: Leg[]) => legs.sort((a, b) => b.amount - a.amount)[0] ?? null;
  const tokenIn = largest(sent);
  const tokenOut = largest(received);
  if (tokenIn && tokenOut && tokenIn.mint !== tokenOut.mint) return { kind: "swap", tokenIn, tokenOut };
  if (tokenIn || tokenOut) return { kind: "transfer", tokenIn, tokenOut };
  return { kind: "other", tokenIn: null, tokenOut: null };
}

export interface HeliusIngestResult {
  transactions: number;
  recorded: number;
  duplicates: number;
  ignored: number;
}

export function ingestHeliusTransactions(payload: unknown): HeliusIngestResult {
  const txs = (Array.isArray(payload) ? payload : [payload]) as HeliusEnhancedTx[];
  const result: HeliusIngestResult = { transactions: txs.length, recorded: 0, duplicates: 0, ignored: 0 };
  for (const tx of txs) {
    if (!tx?.signature || tx.transactionError) {
      result.ignored++;
      continue;
    }
    const participants = new Set<string>();
    if (tx.feePayer) participants.add(tx.feePayer);
    for (const t of tx.tokenTransfers ?? []) {
      if (t.fromUserAccount) participants.add(t.fromUserAccount);
      if (t.toUserAccount) participants.add(t.toUserAccount);
    }
    let matched = false;
    for (const address of participants) {
      const wallet = getWatchedWallet("solana", address);
      if (!wallet) continue;
      matched = true;
      const { kind, tokenIn, tokenOut } = classifyFlows(walletFlows(tx, address));
      if (kind === "other") continue;
      const usdValue =
        tokenIn?.mint === ASSET_USDC ? tokenIn.amount : tokenOut?.mint === ASSET_USDC ? tokenOut.amount : null;
      const { duplicate } = recordWalletEvent({
        walletId: wallet.id,
        chain: "solana",
        signature: tx.signature,
        kind,
        tokenIn: tokenIn?.mint ?? null,
        tokenOut: tokenOut?.mint ?? null,
        amountIn: tokenIn?.amount ?? null,
        amountOut: tokenOut?.amount ?? null,
        usdValue,
        occurredAt: (tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
        raw: { type: tx.type ?? null },
      });
      if (duplicate) result.duplicates++;
      else result.recorded++;
    }
    if (!matched) result.ignored++;
  }
  return result;
}
