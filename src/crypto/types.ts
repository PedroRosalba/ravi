/**
 * Crypto domain types: per-user vaults, Pix deposits, a double-entry ledger,
 * trade proposals, strategies, watched wallets, and engine signals.
 *
 * Amounts are atomic-unit decimal strings at the boundary (JSON/SQLite) and
 * `bigint` inside the service. See ./money.ts.
 */

export type AssetKind = "fiat" | "stablecoin" | "token" | "tokenized_stock";
export type VaultStatus = "active" | "frozen";
export type RiskProfile = "conservative" | "moderate" | "aggressive";
export type DepositStatus =
  | "pending"
  | "paid"
  | "credited"
  | "converted"
  | "expired"
  | "failed"
  | "reversed"
  | "reversal_blocked";
export type TradeSide = "buy" | "sell";
export type TradeStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "failed"
  | "expired"
  | "cancelled";
export type ExecutionMode = "paper" | "live";
export type StrategySource = "mira" | "manual" | "engine";
export type WatchedWalletChain = "solana" | "evm" | "hyperliquid";
export type SignalDirection = "buy" | "sell" | "hold";
export type SignalStatus = "active" | "expired" | "acted" | "dismissed";

export interface CryptoAsset {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: AssetKind;
  chain: string;
  createdAt: number;
  updatedAt: number;
}

export interface VaultOwner {
  type: string;
  id: string;
}

export interface CryptoVault {
  id: string;
  ownerType: string;
  ownerId: string;
  displayName: string | null;
  agentId: string | null;
  status: VaultStatus;
  riskProfile: RiskProfile;
  createdAt: number;
  updatedAt: number;
}

export interface LedgerEntryInput {
  account: string;
  assetId: string;
  amount: bigint;
}

export interface LedgerJournal {
  id: string;
  kind: string;
  refType: string;
  refId: string;
  memo: string | null;
  createdAt: number;
}

export interface LedgerEntry {
  id: string;
  journalId: string;
  account: string;
  assetId: string;
  amount: string;
  createdAt: number;
}

export interface AssetBalance {
  assetId: string;
  symbol: string;
  decimals: number;
  kind: AssetKind;
  atomic: string;
  amount: string;
}

/** Where to route notifications back to the human who started a flow. */
export interface NotificationTarget {
  sessionName?: string | null;
  /** True only when the originating chat is a 1:1 DM; group sessions never get amounts. */
  private?: boolean;
  source?: {
    channel: string;
    accountId: string;
    chatId: string;
    instanceId?: string;
    threadId?: string;
  } | null;
}

export interface CryptoDeposit {
  id: string;
  vaultId: string;
  provider: string;
  providerChargeId: string | null;
  txid: string;
  amountBrl: string;
  status: DepositStatus;
  pixCopyPaste: string | null;
  pixQrImageUrl: string | null;
  paymentUrl: string | null;
  targetAssetId: string | null;
  expiresAt: number | null;
  paidAt: number | null;
  payerName: string | null;
  creditJournalId: string | null;
  convertJournalId: string | null;
  conversion: Record<string, unknown> | null;
  notify: NotificationTarget | null;
  createdAt: number;
  updatedAt: number;
}

export interface CryptoTrade {
  id: string;
  vaultId: string;
  side: TradeSide;
  inputAssetId: string;
  outputAssetId: string;
  inputAmount: string;
  expectedOutput: string;
  minOutput: string;
  slippageBps: number;
  priceImpactPct: number | null;
  executionMode: ExecutionMode;
  status: TradeStatus;
  rationale: string | null;
  strategyId: string | null;
  signalId: string | null;
  quote: Record<string, unknown> | null;
  judge: Record<string, unknown> | null;
  risk: Record<string, unknown> | null;
  approval: Record<string, unknown> | null;
  executedOutput: string | null;
  txSignature: string | null;
  error: string | null;
  notify: NotificationTarget | null;
  createdAt: number;
  decidedAt: number | null;
  executedAt: number | null;
  expiresAt: number;
  updatedAt: number;
}

export interface CryptoStrategy {
  id: string;
  source: StrategySource;
  externalId: string;
  name: string;
  venue: string;
  riskLevel: string | null;
  metrics: Record<string, unknown>;
  score: number | null;
  status: "active" | "paused";
  syncedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WatchedWallet {
  id: string;
  chain: WatchedWalletChain;
  address: string;
  label: string | null;
  source: string;
  strategyId: string | null;
  tags: string[];
  metrics: Record<string, unknown>;
  lastActivityAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WalletEvent {
  id: string;
  walletId: string;
  chain: WatchedWalletChain;
  signature: string;
  kind: "swap" | "transfer" | "other";
  tokenIn: string | null;
  tokenOut: string | null;
  amountIn: number | null;
  amountOut: number | null;
  usdValue: number | null;
  occurredAt: number;
  createdAt: number;
}

export interface CryptoSignal {
  id: string;
  engine: string;
  assetId: string;
  symbol: string | null;
  direction: SignalDirection;
  strength: number;
  confidence: number;
  features: Record<string, unknown>;
  rationale: string;
  judge: Record<string, unknown> | null;
  status: SignalStatus;
  createdAt: number;
  expiresAt: number;
}

export const ASSET_BRL = "BRL";
export const ASSET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const ASSET_SOL = "So11111111111111111111111111111111111111112";

/** System (non-vault) ledger accounts. Vault accounts are `vault:<vaultId>`. */
export const SYSTEM_ACCOUNTS = {
  pixInflow: "system:pix-inflow",
  conversion: "system:conversion",
  market: "system:market",
  fees: "system:fees",
  adjustments: "system:adjustments",
} as const;

export function vaultAccount(vaultId: string): string {
  return `vault:${vaultId}`;
}
