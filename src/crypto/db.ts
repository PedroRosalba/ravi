/**
 * Crypto domain store.
 *
 * Lives in its own SQLite file (default `<stateDir>/crypto.db`, override with
 * RAVI_CRYPTO_DB_PATH) so the money ledger can be backed up, audited, and reset
 * independently of the router database.
 *
 * Ledger model: double-entry. Every movement is a journal whose entries net to
 * zero per asset. Vault balances are derived (SUM of entries), never cached, and
 * a journal that would push any vault account negative is rejected inside the
 * same write transaction that would have posted it.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { executeWrite } from "../db/write-retry.js";
import { getRaviStateDir } from "../utils/paths.js";
import { formatAtomic, parseAtomicString } from "./money.js";
import {
  ASSET_BRL,
  ASSET_SOL,
  ASSET_USDC,
  type AssetBalance,
  type AssetKind,
  type CryptoAsset,
  type CryptoDeposit,
  type CryptoSignal,
  type CryptoStrategy,
  type CryptoTrade,
  type CryptoVault,
  type DepositStatus,
  type LedgerEntry,
  type LedgerEntryInput,
  type LedgerJournal,
  type NotificationTarget,
  type RiskProfile,
  type SignalStatus,
  type StrategySource,
  type TradeStatus,
  type VaultOwner,
  type VaultStatus,
  type WalletEvent,
  type WatchedWallet,
  type WatchedWalletChain,
} from "./types.js";

export class CryptoLedgerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CryptoLedgerError";
  }
}

interface Handle {
  db: Database;
  path: string;
}

let handle: Handle | null = null;

export function getCryptoDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAVI_CRYPTO_DB_PATH?.trim() || join(getRaviStateDir(env), "crypto.db");
}

export function getCryptoDb(): Database {
  const path = getCryptoDbPath();
  if (handle?.path === path) return handle.db;
  handle?.db.close();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  handle = { db, path };
  return db;
}

/** Close the cached handle (tests swap RAVI_CRYPTO_DB_PATH between cases). */
export function closeCryptoDb(): void {
  handle?.db.close();
  handle = null;
}

export function newCryptoId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function write<T>(label: string, fn: (db: Database) => T): T {
  return executeWrite(getCryptoDb(), fn, { label: `crypto:${label}` });
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crypto_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crypto_market_cache (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crypto_assets (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      decimals INTEGER NOT NULL CHECK(decimals >= 0 AND decimals <= 36),
      kind TEXT NOT NULL CHECK(kind IN ('fiat', 'stablecoin', 'token', 'tokenized_stock')),
      chain TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_assets_symbol ON crypto_assets(symbol);

    CREATE TABLE IF NOT EXISTS crypto_vaults (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      display_name TEXT,
      agent_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('active', 'frozen')),
      risk_profile TEXT NOT NULL CHECK(risk_profile IN ('conservative', 'moderate', 'aggressive')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(owner_type, owner_id)
    );

    CREATE TABLE IF NOT EXISTS crypto_journals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      ref_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      memo TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(kind, ref_type, ref_id)
    );

    CREATE TABLE IF NOT EXISTS crypto_entries (
      id TEXT PRIMARY KEY,
      journal_id TEXT NOT NULL REFERENCES crypto_journals(id),
      account TEXT NOT NULL,
      asset_id TEXT NOT NULL REFERENCES crypto_assets(id),
      amount TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_entries_account ON crypto_entries(account, asset_id);
    CREATE INDEX IF NOT EXISTS idx_crypto_entries_journal ON crypto_entries(journal_id);

    CREATE TABLE IF NOT EXISTS crypto_deposits (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES crypto_vaults(id),
      provider TEXT NOT NULL,
      provider_charge_id TEXT,
      txid TEXT NOT NULL UNIQUE,
      amount_brl TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'paid', 'credited', 'converted', 'expired', 'failed', 'reversed', 'reversal_blocked')),
      pix_copy_paste TEXT,
      pix_qr_image_url TEXT,
      payment_url TEXT,
      target_asset_id TEXT,
      expires_at INTEGER,
      paid_at INTEGER,
      payer_name TEXT,
      credit_journal_id TEXT,
      convert_journal_id TEXT,
      conversion_json TEXT,
      notify_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_deposits_vault ON crypto_deposits(vault_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_crypto_deposits_provider_charge ON crypto_deposits(provider, provider_charge_id);

    CREATE TABLE IF NOT EXISTS crypto_trades (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES crypto_vaults(id),
      side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      input_asset_id TEXT NOT NULL,
      output_asset_id TEXT NOT NULL,
      input_amount TEXT NOT NULL,
      expected_output TEXT NOT NULL,
      min_output TEXT NOT NULL,
      slippage_bps INTEGER NOT NULL,
      price_impact_pct REAL,
      execution_mode TEXT NOT NULL CHECK(execution_mode IN ('paper', 'live')),
      status TEXT NOT NULL CHECK(status IN ('pending_approval', 'approved', 'rejected', 'executing', 'executed', 'failed', 'expired', 'cancelled')),
      rationale TEXT,
      strategy_id TEXT,
      signal_id TEXT,
      quote_json TEXT,
      judge_json TEXT,
      risk_json TEXT,
      approval_json TEXT,
      executed_output TEXT,
      tx_signature TEXT,
      error TEXT,
      notify_json TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      executed_at INTEGER,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_trades_vault ON crypto_trades(vault_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_crypto_trades_status ON crypto_trades(status, created_at);

    CREATE TABLE IF NOT EXISTS crypto_strategies (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(source IN ('mira', 'manual', 'engine')),
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      venue TEXT NOT NULL,
      risk_level TEXT,
      metrics_json TEXT NOT NULL,
      score REAL,
      status TEXT NOT NULL CHECK(status IN ('active', 'paused')),
      synced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source, external_id)
    );

    CREATE TABLE IF NOT EXISTS crypto_watched_wallets (
      id TEXT PRIMARY KEY,
      chain TEXT NOT NULL CHECK(chain IN ('solana', 'evm', 'hyperliquid')),
      address TEXT NOT NULL,
      label TEXT,
      source TEXT NOT NULL,
      strategy_id TEXT,
      tags_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      last_activity_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chain, address)
    );

    CREATE TABLE IF NOT EXISTS crypto_wallet_events (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES crypto_watched_wallets(id) ON DELETE CASCADE,
      chain TEXT NOT NULL,
      signature TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('swap', 'transfer', 'other')),
      token_in TEXT,
      token_out TEXT,
      amount_in REAL,
      amount_out REAL,
      usd_value REAL,
      occurred_at INTEGER NOT NULL,
      raw_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(wallet_id, signature)
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_wallet_events_time ON crypto_wallet_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_crypto_wallet_events_token_out ON crypto_wallet_events(token_out, occurred_at);

    CREATE TABLE IF NOT EXISTS crypto_signals (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      symbol TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('buy', 'sell', 'hold')),
      strength REAL NOT NULL,
      confidence REAL NOT NULL,
      features_json TEXT NOT NULL,
      rationale TEXT NOT NULL,
      judge_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('active', 'expired', 'acted', 'dismissed')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_signals_status ON crypto_signals(status, created_at);
  `);
  seedAssets(db);
}

const DEFAULT_ASSETS: Array<Omit<CryptoAsset, "createdAt" | "updatedAt">> = [
  { id: ASSET_BRL, symbol: "BRL", name: "Real brasileiro", decimals: 2, kind: "fiat", chain: "pix" },
  { id: ASSET_USDC, symbol: "USDC", name: "USD Coin", decimals: 6, kind: "stablecoin", chain: "solana" },
  { id: ASSET_SOL, symbol: "SOL", name: "Solana", decimals: 9, kind: "token", chain: "solana" },
];

function seedAssets(db: Database): void {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO crypto_assets (id, symbol, name, decimals, kind, chain, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const asset of DEFAULT_ASSETS) {
    insert.run(asset.id, asset.symbol, asset.name, asset.decimals, asset.kind, asset.chain, now, now);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getCryptoSetting(key: string): string | null {
  const row = getCryptoDb().prepare("SELECT value FROM crypto_settings WHERE key = ?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

export function setCryptoSetting(key: string, value: string | null): void {
  write("setting", (db) => {
    if (value === null) {
      db.prepare("DELETE FROM crypto_settings WHERE key = ?").run(key);
      return;
    }
    db.prepare(
      `INSERT INTO crypto_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, Date.now());
  });
}

export function listCryptoSettings(): Record<string, string> {
  const rows = getCryptoDb().prepare("SELECT key, value FROM crypto_settings ORDER BY key").all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

// ---------------------------------------------------------------------------
// Market cache (shared across CLI processes; never holds money state)
// ---------------------------------------------------------------------------

export function readMarketCache<T>(key: string, maxAgeMs: number, now = Date.now()): T | null {
  const row = getCryptoDb()
    .prepare("SELECT value_json, fetched_at FROM crypto_market_cache WHERE key = ?")
    .get(key) as { value_json: string; fetched_at: number } | null;
  if (!row || now - row.fetched_at > maxAgeMs) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export function writeMarketCache(key: string, value: unknown, now = Date.now()): void {
  write("market-cache", (db) => {
    db.prepare(
      `INSERT INTO crypto_market_cache (key, value_json, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at`,
    ).run(key, JSON.stringify(value), now);
  });
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

interface AssetRow {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: AssetKind;
  chain: string;
  created_at: number;
  updated_at: number;
}

function hydrateAsset(row: AssetRow): CryptoAsset {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    kind: row.kind,
    chain: row.chain,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertAsset(input: Omit<CryptoAsset, "createdAt" | "updatedAt">): CryptoAsset {
  const now = Date.now();
  write("asset", (db) => {
    db.prepare(
      `INSERT INTO crypto_assets (id, symbol, name, decimals, kind, chain, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, kind = excluded.kind,
         chain = excluded.chain, updated_at = excluded.updated_at`,
    ).run(input.id, input.symbol, input.name, input.decimals, input.kind, input.chain, now, now);
  });
  const asset = getAsset(input.id);
  if (!asset) throw new CryptoLedgerError(`Asset not persisted: ${input.id}`, "ASSET_WRITE_FAILED");
  if (asset.decimals !== input.decimals) {
    // Decimals are part of every stored amount's meaning; never let them drift.
    throw new CryptoLedgerError(
      `Asset ${input.id} already registered with ${asset.decimals} decimals (got ${input.decimals}).`,
      "ASSET_DECIMALS_CONFLICT",
    );
  }
  return asset;
}

export function getAsset(id: string): CryptoAsset | null {
  const row = getCryptoDb().prepare("SELECT * FROM crypto_assets WHERE id = ?").get(id) as AssetRow | null;
  return row ? hydrateAsset(row) : null;
}

/** Resolve an asset by id (mint) or case-insensitive symbol. Ambiguous symbols return null. */
export function resolveAsset(ref: string): CryptoAsset | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const byId = getAsset(trimmed);
  if (byId) return byId;
  const rows = getCryptoDb()
    .prepare("SELECT * FROM crypto_assets WHERE lower(symbol) = lower(?)")
    .all(trimmed) as AssetRow[];
  return rows.length === 1 ? hydrateAsset(rows[0]) : null;
}

export function listAssets(): CryptoAsset[] {
  const rows = getCryptoDb().prepare("SELECT * FROM crypto_assets ORDER BY kind, symbol").all() as AssetRow[];
  return rows.map(hydrateAsset);
}

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

interface VaultRow {
  id: string;
  owner_type: string;
  owner_id: string;
  display_name: string | null;
  agent_id: string | null;
  status: VaultStatus;
  risk_profile: RiskProfile;
  created_at: number;
  updated_at: number;
}

function hydrateVault(row: VaultRow): CryptoVault {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    displayName: row.display_name,
    agentId: row.agent_id,
    status: row.status,
    riskProfile: row.risk_profile,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getVault(id: string): CryptoVault | null {
  const row = getCryptoDb().prepare("SELECT * FROM crypto_vaults WHERE id = ?").get(id) as VaultRow | null;
  return row ? hydrateVault(row) : null;
}

export function getVaultByOwner(owner: VaultOwner): CryptoVault | null {
  const row = getCryptoDb()
    .prepare("SELECT * FROM crypto_vaults WHERE owner_type = ? AND owner_id = ?")
    .get(owner.type, owner.id) as VaultRow | null;
  return row ? hydrateVault(row) : null;
}

/** Idempotent: returns the existing vault for the owner when present. */
export function openVault(input: {
  owner: VaultOwner;
  displayName?: string | null;
  agentId?: string | null;
  riskProfile?: RiskProfile;
}): { vault: CryptoVault; created: boolean } {
  const existing = getVaultByOwner(input.owner);
  if (existing) return { vault: existing, created: false };
  const now = Date.now();
  const id = newCryptoId("vlt");
  write("vault-open", (db) => {
    db.prepare(
      `INSERT OR IGNORE INTO crypto_vaults (id, owner_type, owner_id, display_name, agent_id, status, risk_profile, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      id,
      input.owner.type,
      input.owner.id,
      input.displayName ?? null,
      input.agentId ?? null,
      input.riskProfile ?? "moderate",
      now,
      now,
    );
  });
  const vault = getVaultByOwner(input.owner);
  if (!vault) throw new CryptoLedgerError("Vault could not be opened.", "VAULT_WRITE_FAILED");
  return { vault, created: vault.id === id };
}

export function updateVault(
  id: string,
  patch: { status?: VaultStatus; riskProfile?: RiskProfile; displayName?: string | null },
): CryptoVault {
  const vault = getVault(id);
  if (!vault) throw new CryptoLedgerError(`Vault not found: ${id}`, "VAULT_NOT_FOUND");
  write("vault-update", (db) => {
    db.prepare(
      "UPDATE crypto_vaults SET status = ?, risk_profile = ?, display_name = ?, updated_at = ? WHERE id = ?",
    ).run(
      patch.status ?? vault.status,
      patch.riskProfile ?? vault.riskProfile,
      patch.displayName === undefined ? vault.displayName : patch.displayName,
      Date.now(),
      id,
    );
  });
  return getVault(id) as CryptoVault;
}

export function listVaults(input: { limit: number; offset: number }): { items: CryptoVault[]; total: number } {
  const db = getCryptoDb();
  const total = (db.prepare("SELECT COUNT(*) AS n FROM crypto_vaults").get() as { n: number }).n;
  const rows = db
    .prepare("SELECT * FROM crypto_vaults ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(input.limit, input.offset) as VaultRow[];
  return { items: rows.map(hydrateVault), total };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface PostJournalInput {
  kind: string;
  refType: string;
  refId: string;
  memo?: string | null;
  entries: LedgerEntryInput[];
  now?: number;
}

export interface PostJournalResult {
  journal: LedgerJournal;
  duplicate: boolean;
}

/**
 * Post a balanced journal. Idempotent on (kind, refType, refId): a replay
 * returns the original journal with `duplicate: true` and writes nothing.
 * Rejects (and writes nothing) when entries do not net to zero per asset, an
 * asset is unknown, or any `vault:` account would end negative.
 */
export function postJournal(input: PostJournalInput): PostJournalResult {
  validateJournalShape(input);
  return write("journal", (db) => postJournalInTransaction(db, input));
}

/** Variant for callers that already hold the write transaction (multi-step state changes). */
export function postJournalInTransaction(db: Database, input: PostJournalInput): PostJournalResult {
  validateJournalShape(input);
  const existing = db
    .prepare("SELECT * FROM crypto_journals WHERE kind = ? AND ref_type = ? AND ref_id = ?")
    .get(input.kind, input.refType, input.refId) as JournalRow | null;
  if (existing) return { journal: hydrateJournal(existing), duplicate: true };

  for (const assetId of new Set(input.entries.map((entry) => entry.assetId))) {
    const asset = db.prepare("SELECT id FROM crypto_assets WHERE id = ?").get(assetId);
    if (!asset) throw new CryptoLedgerError(`Unknown asset in journal: ${assetId}`, "LEDGER_UNKNOWN_ASSET");
  }

  for (const [key, delta] of netByAccountAsset(input.entries)) {
    if (delta >= 0n) continue;
    const [account, assetId] = splitKey(key);
    if (!account.startsWith("vault:")) continue;
    const balance = sumAccountAsset(db, account, assetId);
    if (balance + delta < 0n) {
      throw new CryptoLedgerError(`Insufficient balance in ${account} for ${assetId}.`, "LEDGER_INSUFFICIENT_FUNDS", {
        account,
        assetId,
        balance: balance.toString(),
        required: (-delta).toString(),
      });
    }
  }

  const now = input.now ?? Date.now();
  const journalId = newCryptoId("jnl");
  db.prepare(
    "INSERT INTO crypto_journals (id, kind, ref_type, ref_id, memo, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(journalId, input.kind, input.refType, input.refId, input.memo ?? null, now);
  const insertEntry = db.prepare(
    "INSERT INTO crypto_entries (id, journal_id, account, asset_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const entry of input.entries) {
    if (entry.amount === 0n) continue;
    insertEntry.run(newCryptoId("ent"), journalId, entry.account, entry.assetId, entry.amount.toString(), now);
  }
  return {
    journal: {
      id: journalId,
      kind: input.kind,
      refType: input.refType,
      refId: input.refId,
      memo: input.memo ?? null,
      createdAt: now,
    },
    duplicate: false,
  };
}

function validateJournalShape(input: PostJournalInput): void {
  if (!input.kind || !input.refType || !input.refId) {
    throw new CryptoLedgerError("Journal requires kind, refType and refId.", "LEDGER_INVALID_JOURNAL");
  }
  if (input.entries.length < 2) {
    throw new CryptoLedgerError("Journal requires at least two entries.", "LEDGER_INVALID_JOURNAL");
  }
  const perAsset = new Map<string, bigint>();
  for (const entry of input.entries) {
    if (typeof entry.amount !== "bigint") {
      throw new CryptoLedgerError("Ledger amounts must be bigint.", "LEDGER_INVALID_JOURNAL");
    }
    perAsset.set(entry.assetId, (perAsset.get(entry.assetId) ?? 0n) + entry.amount);
  }
  for (const [assetId, total] of perAsset) {
    if (total !== 0n) {
      throw new CryptoLedgerError(`Journal does not balance for ${assetId} (net ${total}).`, "LEDGER_UNBALANCED", {
        assetId,
        net: total.toString(),
      });
    }
  }
}

function netByAccountAsset(entries: LedgerEntryInput[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const entry of entries) {
    const key = `${entry.account}\u0000${entry.assetId}`;
    net.set(key, (net.get(key) ?? 0n) + entry.amount);
  }
  return net;
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf("\u0000");
  return [key.slice(0, index), key.slice(index + 1)];
}

function sumAccountAsset(db: Database, account: string, assetId: string): bigint {
  const rows = db
    .prepare("SELECT amount FROM crypto_entries WHERE account = ? AND asset_id = ?")
    .all(account, assetId) as Array<{ amount: string }>;
  return rows.reduce((total, row) => total + parseAtomicString(row.amount), 0n);
}

/** Entries of one journal (used to build exact reversals). */
export function getJournalEntries(db: Database, journalId: string): LedgerEntryInput[] {
  const rows = db
    .prepare("SELECT account, asset_id, amount FROM crypto_entries WHERE journal_id = ?")
    .all(journalId) as Array<{ account: string; asset_id: string; amount: string }>;
  return rows.map((row) => ({ account: row.account, assetId: row.asset_id, amount: parseAtomicString(row.amount) }));
}

/** True when any money in the vault came from the sandbox Pix provider (play money). */
export function vaultHasSandboxFunds(vaultId: string): boolean {
  const row = getCryptoDb()
    .prepare(
      `SELECT 1 FROM crypto_deposits WHERE vault_id = ? AND provider = 'sandbox'
         AND status IN ('credited', 'converted', 'reversal_blocked') LIMIT 1`,
    )
    .get(vaultId);
  return Boolean(row);
}

export function getAccountBalanceAtomic(account: string, assetId: string): bigint {
  return sumAccountAsset(getCryptoDb(), account, assetId);
}

/** Non-zero balances for one ledger account, joined with asset metadata. */
export function getAccountBalances(account: string): AssetBalance[] {
  const rows = getCryptoDb()
    .prepare(
      `SELECT e.asset_id, e.amount, a.symbol, a.decimals, a.kind
       FROM crypto_entries e JOIN crypto_assets a ON a.id = e.asset_id
       WHERE e.account = ?`,
    )
    .all(account) as Array<{ asset_id: string; amount: string; symbol: string; decimals: number; kind: AssetKind }>;
  const totals = new Map<string, { atomic: bigint; symbol: string; decimals: number; kind: AssetKind }>();
  for (const row of rows) {
    const current = totals.get(row.asset_id) ?? {
      atomic: 0n,
      symbol: row.symbol,
      decimals: row.decimals,
      kind: row.kind,
    };
    current.atomic += parseAtomicString(row.amount);
    totals.set(row.asset_id, current);
  }
  return [...totals.entries()]
    .filter(([, value]) => value.atomic !== 0n)
    .map(([assetId, value]) => ({
      assetId,
      symbol: value.symbol,
      decimals: value.decimals,
      kind: value.kind,
      atomic: value.atomic.toString(),
      amount: formatAtomic(value.atomic, value.decimals),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Ledger-wide per-asset sums. Every asset must net to zero; anything else is corruption. */
export function getLedgerTrialBalance(): Array<{ assetId: string; net: string }> {
  const rows = getCryptoDb().prepare("SELECT asset_id, amount FROM crypto_entries").all() as Array<{
    asset_id: string;
    amount: string;
  }>;
  const totals = new Map<string, bigint>();
  for (const row of rows) totals.set(row.asset_id, (totals.get(row.asset_id) ?? 0n) + parseAtomicString(row.amount));
  return [...totals.entries()].map(([assetId, net]) => ({ assetId, net: net.toString() }));
}

interface JournalRow {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  memo: string | null;
  created_at: number;
}

function hydrateJournal(row: JournalRow): LedgerJournal {
  return {
    id: row.id,
    kind: row.kind,
    refType: row.ref_type,
    refId: row.ref_id,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

export interface AccountHistoryItem {
  journal: LedgerJournal;
  entries: LedgerEntry[];
}

export function listAccountHistory(
  account: string,
  input: { limit: number; offset: number },
): { items: AccountHistoryItem[]; total: number } {
  const db = getCryptoDb();
  const total = (
    db.prepare("SELECT COUNT(DISTINCT journal_id) AS n FROM crypto_entries WHERE account = ?").get(account) as {
      n: number;
    }
  ).n;
  const journals = db
    .prepare(
      `SELECT j.* FROM crypto_journals j
       WHERE j.id IN (SELECT DISTINCT journal_id FROM crypto_entries WHERE account = ?)
       ORDER BY j.created_at DESC, j.id DESC LIMIT ? OFFSET ?`,
    )
    .all(account, input.limit, input.offset) as JournalRow[];
  const entryStmt = db.prepare("SELECT * FROM crypto_entries WHERE journal_id = ? AND account = ? ORDER BY asset_id");
  const items = journals.map((row) => ({
    journal: hydrateJournal(row),
    entries: (entryStmt.all(row.id, account) as EntryRow[]).map(hydrateEntry),
  }));
  return { items, total };
}

interface EntryRow {
  id: string;
  journal_id: string;
  account: string;
  asset_id: string;
  amount: string;
  created_at: number;
}

function hydrateEntry(row: EntryRow): LedgerEntry {
  return {
    id: row.id,
    journalId: row.journal_id,
    account: row.account,
    assetId: row.asset_id,
    amount: row.amount,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

interface DepositRow {
  id: string;
  vault_id: string;
  provider: string;
  provider_charge_id: string | null;
  txid: string;
  amount_brl: string;
  status: DepositStatus;
  pix_copy_paste: string | null;
  pix_qr_image_url: string | null;
  payment_url: string | null;
  target_asset_id: string | null;
  expires_at: number | null;
  paid_at: number | null;
  payer_name: string | null;
  credit_journal_id: string | null;
  convert_journal_id: string | null;
  conversion_json: string | null;
  notify_json: string | null;
  created_at: number;
  updated_at: number;
}

function hydrateDeposit(row: DepositRow): CryptoDeposit {
  return {
    id: row.id,
    vaultId: row.vault_id,
    provider: row.provider,
    providerChargeId: row.provider_charge_id,
    txid: row.txid,
    amountBrl: row.amount_brl,
    status: row.status,
    pixCopyPaste: row.pix_copy_paste,
    pixQrImageUrl: row.pix_qr_image_url,
    paymentUrl: row.payment_url,
    targetAssetId: row.target_asset_id,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    payerName: row.payer_name,
    creditJournalId: row.credit_journal_id,
    convertJournalId: row.convert_journal_id,
    conversion: parseJsonObject(row.conversion_json),
    notify: parseJsonObject(row.notify_json) as NotificationTarget | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateDepositInput {
  id: string;
  vaultId: string;
  provider: string;
  providerChargeId: string | null;
  txid: string;
  amountBrl: bigint;
  pixCopyPaste: string | null;
  pixQrImageUrl: string | null;
  paymentUrl: string | null;
  targetAssetId: string | null;
  expiresAt: number | null;
  notify: NotificationTarget | null;
}

export function createDeposit(input: CreateDepositInput): CryptoDeposit {
  const now = Date.now();
  write("deposit-create", (db) => {
    db.prepare(
      `INSERT INTO crypto_deposits (id, vault_id, provider, provider_charge_id, txid, amount_brl, status, pix_copy_paste,
         pix_qr_image_url, payment_url, target_asset_id, expires_at, notify_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.vaultId,
      input.provider,
      input.providerChargeId,
      input.txid,
      input.amountBrl.toString(),
      input.pixCopyPaste,
      input.pixQrImageUrl,
      input.paymentUrl,
      input.targetAssetId,
      input.expiresAt,
      input.notify ? JSON.stringify(input.notify) : null,
      now,
      now,
    );
  });
  return getDeposit(input.id) as CryptoDeposit;
}

export function getDeposit(id: string): CryptoDeposit | null {
  const row = getCryptoDb().prepare("SELECT * FROM crypto_deposits WHERE id = ?").get(id) as DepositRow | null;
  return row ? hydrateDeposit(row) : null;
}

export function getDepositByTxid(txid: string): CryptoDeposit | null {
  const row = getCryptoDb().prepare("SELECT * FROM crypto_deposits WHERE txid = ?").get(txid) as DepositRow | null;
  return row ? hydrateDeposit(row) : null;
}

export function getDepositByProviderCharge(provider: string, chargeId: string): CryptoDeposit | null {
  const row = getCryptoDb()
    .prepare("SELECT * FROM crypto_deposits WHERE provider = ? AND provider_charge_id = ?")
    .get(provider, chargeId) as DepositRow | null;
  return row ? hydrateDeposit(row) : null;
}

export function listDeposits(input: { vaultId?: string; status?: DepositStatus; limit: number; offset: number }): {
  items: CryptoDeposit[];
  total: number;
} {
  const { where, params } = buildWhere([
    ["vault_id = ?", input.vaultId],
    ["status = ?", input.status],
  ]);
  const db = getCryptoDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM crypto_deposits ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM crypto_deposits ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, input.limit, input.offset) as DepositRow[];
  return { items: rows.map(hydrateDeposit), total };
}

/** Pending deposits whose charge window has passed. */
export function listExpiredPendingDeposits(now: number): CryptoDeposit[] {
  const rows = getCryptoDb()
    .prepare("SELECT * FROM crypto_deposits WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?")
    .all(now) as DepositRow[];
  return rows.map(hydrateDeposit);
}

export function updateDepositFields(
  db: Database,
  id: string,
  patch: Partial<{
    status: DepositStatus;
    paidAt: number | null;
    payerName: string | null;
    creditJournalId: string | null;
    convertJournalId: string | null;
    conversion: Record<string, unknown> | null;
  }>,
): void {
  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];
  const add = (column: string, value: SQLQueryBindings) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.paidAt !== undefined) add("paid_at", patch.paidAt);
  if (patch.payerName !== undefined) add("payer_name", patch.payerName);
  if (patch.creditJournalId !== undefined) add("credit_journal_id", patch.creditJournalId);
  if (patch.convertJournalId !== undefined) add("convert_journal_id", patch.convertJournalId);
  if (patch.conversion !== undefined)
    add("conversion_json", patch.conversion ? JSON.stringify(patch.conversion) : null);
  add("updated_at", Date.now());
  db.prepare(`UPDATE crypto_deposits SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
}

/** Run a multi-statement state transition atomically (deposit credit + journal, trade fill + journal). */
export function withCryptoTransaction<T>(label: string, fn: (db: Database) => T): T {
  return write(label, fn);
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

interface TradeRow {
  id: string;
  vault_id: string;
  side: "buy" | "sell";
  input_asset_id: string;
  output_asset_id: string;
  input_amount: string;
  expected_output: string;
  min_output: string;
  slippage_bps: number;
  price_impact_pct: number | null;
  execution_mode: "paper" | "live";
  status: TradeStatus;
  rationale: string | null;
  strategy_id: string | null;
  signal_id: string | null;
  quote_json: string | null;
  judge_json: string | null;
  risk_json: string | null;
  approval_json: string | null;
  executed_output: string | null;
  tx_signature: string | null;
  error: string | null;
  notify_json: string | null;
  created_at: number;
  decided_at: number | null;
  executed_at: number | null;
  expires_at: number;
  updated_at: number;
}

function hydrateTrade(row: TradeRow): CryptoTrade {
  return {
    id: row.id,
    vaultId: row.vault_id,
    side: row.side,
    inputAssetId: row.input_asset_id,
    outputAssetId: row.output_asset_id,
    inputAmount: row.input_amount,
    expectedOutput: row.expected_output,
    minOutput: row.min_output,
    slippageBps: row.slippage_bps,
    priceImpactPct: row.price_impact_pct,
    executionMode: row.execution_mode,
    status: row.status,
    rationale: row.rationale,
    strategyId: row.strategy_id,
    signalId: row.signal_id,
    quote: parseJsonObject(row.quote_json),
    judge: parseJsonObject(row.judge_json),
    risk: parseJsonObject(row.risk_json),
    approval: parseJsonObject(row.approval_json),
    executedOutput: row.executed_output,
    txSignature: row.tx_signature,
    error: row.error,
    notify: parseJsonObject(row.notify_json) as NotificationTarget | null,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    executedAt: row.executed_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateTradeInput {
  vaultId: string;
  side: "buy" | "sell";
  inputAssetId: string;
  outputAssetId: string;
  inputAmount: bigint;
  expectedOutput: bigint;
  minOutput: bigint;
  slippageBps: number;
  priceImpactPct: number | null;
  executionMode: "paper" | "live";
  rationale: string | null;
  strategyId: string | null;
  signalId: string | null;
  quote: Record<string, unknown> | null;
  judge: Record<string, unknown> | null;
  risk: Record<string, unknown> | null;
  notify: NotificationTarget | null;
  expiresAt: number;
}

export function createTrade(input: CreateTradeInput): CryptoTrade {
  const now = Date.now();
  const id = newCryptoId("trd");
  write("trade-create", (db) => {
    db.prepare(
      `INSERT INTO crypto_trades (id, vault_id, side, input_asset_id, output_asset_id, input_amount, expected_output,
         min_output, slippage_bps, price_impact_pct, execution_mode, status, rationale, strategy_id, signal_id,
         quote_json, judge_json, risk_json, notify_json, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.vaultId,
      input.side,
      input.inputAssetId,
      input.outputAssetId,
      input.inputAmount.toString(),
      input.expectedOutput.toString(),
      input.minOutput.toString(),
      input.slippageBps,
      input.priceImpactPct,
      input.executionMode,
      input.rationale,
      input.strategyId,
      input.signalId,
      jsonOrNull(input.quote),
      jsonOrNull(input.judge),
      jsonOrNull(input.risk),
      jsonOrNull(input.notify),
      now,
      input.expiresAt,
      now,
    );
  });
  return getTrade(id) as CryptoTrade;
}

export function getTrade(id: string): CryptoTrade | null {
  const row = getCryptoDb().prepare("SELECT * FROM crypto_trades WHERE id = ?").get(id) as TradeRow | null;
  return row ? hydrateTrade(row) : null;
}

export function listTrades(input: { vaultId?: string; status?: TradeStatus; limit: number; offset: number }): {
  items: CryptoTrade[];
  total: number;
} {
  const { where, params } = buildWhere([
    ["vault_id = ?", input.vaultId],
    ["status = ?", input.status],
  ]);
  const db = getCryptoDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM crypto_trades ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM crypto_trades ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, input.limit, input.offset) as TradeRow[];
  return { items: rows.map(hydrateTrade), total };
}

/** USD notional (from each trade's risk snapshot) of live/pending-execution trades since `since`. */
export function sumRecentTradeNotionalUsd(vaultId: string, since: number): number {
  const rows = getCryptoDb()
    .prepare(
      `SELECT risk_json FROM crypto_trades
       WHERE vault_id = ? AND status IN ('executed', 'executing', 'approved') AND COALESCE(decided_at, created_at) >= ?`,
    )
    .all(vaultId, since) as Array<{ risk_json: string | null }>;
  let total = 0;
  for (const row of rows) {
    const notional = Number(parseJsonObject(row.risk_json)?.notionalUsd);
    if (Number.isFinite(notional) && notional > 0) total += notional;
  }
  return total;
}

/**
 * Compare-and-set a trade's status. Returns false when the trade is no longer in
 * one of `from` (someone else already decided it), which is how double approval
 * and double execution are prevented.
 */
export function transitionTrade(
  db: Database,
  id: string,
  from: TradeStatus[],
  to: TradeStatus,
  patch: Partial<{
    approval: Record<string, unknown> | null;
    executedOutput: bigint | null;
    txSignature: string | null;
    error: string | null;
    decidedAt: number | null;
    executedAt: number | null;
  }> = {},
): boolean {
  const sets = ["status = ?", "updated_at = ?"];
  const params: SQLQueryBindings[] = [to, Date.now()];
  if (patch.approval !== undefined) {
    sets.push("approval_json = ?");
    params.push(jsonOrNull(patch.approval));
  }
  if (patch.executedOutput !== undefined) {
    sets.push("executed_output = ?");
    params.push(patch.executedOutput === null ? null : patch.executedOutput.toString());
  }
  if (patch.txSignature !== undefined) {
    sets.push("tx_signature = ?");
    params.push(patch.txSignature);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    params.push(patch.error);
  }
  if (patch.decidedAt !== undefined) {
    sets.push("decided_at = ?");
    params.push(patch.decidedAt);
  }
  if (patch.executedAt !== undefined) {
    sets.push("executed_at = ?");
    params.push(patch.executedAt);
  }
  const placeholders = from.map(() => "?").join(", ");
  const result = db
    .prepare(`UPDATE crypto_trades SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`)
    .run(...params, id, ...from);
  return result.changes === 1;
}

/** Trades in `status` whose last decision is older than `before` (stuck-trade sweeps). */
export function listTradesStaleInStatus(status: TradeStatus, before: number): CryptoTrade[] {
  const rows = getCryptoDb()
    .prepare("SELECT * FROM crypto_trades WHERE status = ? AND COALESCE(decided_at, created_at) < ?")
    .all(status, before) as TradeRow[];
  return rows.map(hydrateTrade);
}

export function listExpiredPendingTrades(now: number): CryptoTrade[] {
  const rows = getCryptoDb()
    .prepare("SELECT * FROM crypto_trades WHERE status = 'pending_approval' AND expires_at < ?")
    .all(now) as TradeRow[];
  return rows.map(hydrateTrade);
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

interface StrategyRow {
  id: string;
  source: StrategySource;
  external_id: string;
  name: string;
  venue: string;
  risk_level: string | null;
  metrics_json: string;
  score: number | null;
  status: "active" | "paused";
  synced_at: number | null;
  created_at: number;
  updated_at: number;
}

function hydrateStrategy(row: StrategyRow): CryptoStrategy {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    name: row.name,
    venue: row.venue,
    riskLevel: row.risk_level,
    metrics: parseJsonObject(row.metrics_json) ?? {},
    score: row.score,
    status: row.status,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertStrategy(input: {
  source: StrategySource;
  externalId: string;
  name: string;
  venue: string;
  riskLevel: string | null;
  metrics: Record<string, unknown>;
  score: number | null;
}): CryptoStrategy {
  const now = Date.now();
  write("strategy-upsert", (db) => {
    db.prepare(
      `INSERT INTO crypto_strategies (id, source, external_id, name, venue, risk_level, metrics_json, score, status, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT(source, external_id) DO UPDATE SET name = excluded.name, venue = excluded.venue,
         risk_level = excluded.risk_level, metrics_json = excluded.metrics_json, score = excluded.score,
         synced_at = excluded.synced_at, updated_at = excluded.updated_at`,
    ).run(
      newCryptoId("stg"),
      input.source,
      input.externalId,
      input.name,
      input.venue,
      input.riskLevel,
      JSON.stringify(input.metrics),
      input.score,
      now,
      now,
      now,
    );
  });
  const row = getCryptoDb()
    .prepare("SELECT * FROM crypto_strategies WHERE source = ? AND external_id = ?")
    .get(input.source, input.externalId) as StrategyRow;
  return hydrateStrategy(row);
}

export function getStrategy(ref: string): CryptoStrategy | null {
  const row = getCryptoDb()
    .prepare("SELECT * FROM crypto_strategies WHERE id = ? OR external_id = ? ORDER BY id = ? DESC LIMIT 1")
    .get(ref, ref, ref) as StrategyRow | null;
  return row ? hydrateStrategy(row) : null;
}

export function listStrategies(input: { source?: StrategySource; limit: number; offset: number }): {
  items: CryptoStrategy[];
  total: number;
} {
  const { where, params } = buildWhere([["source = ?", input.source]]);
  const db = getCryptoDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM crypto_strategies ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT * FROM crypto_strategies ${where} ORDER BY score IS NULL, score DESC, updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, input.limit, input.offset) as StrategyRow[];
  return { items: rows.map(hydrateStrategy), total };
}

// ---------------------------------------------------------------------------
// Watched wallets + on-chain events
// ---------------------------------------------------------------------------

interface WalletRow {
  id: string;
  chain: WatchedWalletChain;
  address: string;
  label: string | null;
  source: string;
  strategy_id: string | null;
  tags_json: string;
  metrics_json: string;
  last_activity_at: number | null;
  created_at: number;
  updated_at: number;
}

function hydrateWallet(row: WalletRow): WatchedWallet {
  return {
    id: row.id,
    chain: row.chain,
    address: row.address,
    label: row.label,
    source: row.source,
    strategyId: row.strategy_id,
    tags: parseJsonArray(row.tags_json),
    metrics: parseJsonObject(row.metrics_json) ?? {},
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertWatchedWallet(input: {
  chain: WatchedWalletChain;
  address: string;
  label?: string | null;
  source: string;
  strategyId?: string | null;
  tags?: string[];
  metrics?: Record<string, unknown>;
}): { wallet: WatchedWallet; created: boolean } {
  const now = Date.now();
  const existing = getWatchedWallet(input.chain, input.address);
  write("wallet-upsert", (db) => {
    if (existing) {
      db.prepare(
        `UPDATE crypto_watched_wallets SET label = ?, source = ?, strategy_id = ?, tags_json = ?, metrics_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        input.label === undefined ? existing.label : input.label,
        input.source,
        input.strategyId === undefined ? existing.strategyId : input.strategyId,
        JSON.stringify(input.tags ?? existing.tags),
        JSON.stringify(input.metrics ?? existing.metrics),
        now,
        existing.id,
      );
      return;
    }
    db.prepare(
      `INSERT INTO crypto_watched_wallets (id, chain, address, label, source, strategy_id, tags_json, metrics_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newCryptoId("wlt"),
      input.chain,
      input.address,
      input.label ?? null,
      input.source,
      input.strategyId ?? null,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.metrics ?? {}),
      now,
      now,
    );
  });
  return { wallet: getWatchedWallet(input.chain, input.address) as WatchedWallet, created: !existing };
}

export function getWatchedWallet(chain: WatchedWalletChain, address: string): WatchedWallet | null {
  const row = getCryptoDb()
    .prepare("SELECT * FROM crypto_watched_wallets WHERE chain = ? AND address = ?")
    .get(chain, address) as WalletRow | null;
  return row ? hydrateWallet(row) : null;
}

export function getWatchedWalletById(id: string): WatchedWallet | null {
  const row = getCryptoDb().prepare("SELECT * FROM crypto_watched_wallets WHERE id = ?").get(id) as WalletRow | null;
  return row ? hydrateWallet(row) : null;
}

export function listWatchedWallets(input: { chain?: WatchedWalletChain; limit: number; offset: number }): {
  items: WatchedWallet[];
  total: number;
} {
  const { where, params } = buildWhere([["chain = ?", input.chain]]);
  const db = getCryptoDb();
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM crypto_watched_wallets ${where}`).get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(`SELECT * FROM crypto_watched_wallets ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, input.limit, input.offset) as WalletRow[];
  return { items: rows.map(hydrateWallet), total };
}

export function removeWatchedWallet(id: string): boolean {
  return (
    write("wallet-remove", (db) => db.prepare("DELETE FROM crypto_watched_wallets WHERE id = ?").run(id).changes) === 1
  );
}

/** Idempotent on (walletId, signature) so webhook replays and re-polls are harmless. */
export function recordWalletEvent(input: Omit<WalletEvent, "id" | "createdAt"> & { raw?: unknown }): {
  event: WalletEvent;
  duplicate: boolean;
} {
  const now = Date.now();
  const id = newCryptoId("wev");
  const inserted = write("wallet-event", (db) => {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO crypto_wallet_events (id, wallet_id, chain, signature, kind, token_in, token_out, amount_in,
           amount_out, usd_value, occurred_at, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.walletId,
        input.chain,
        input.signature,
        input.kind,
        input.tokenIn,
        input.tokenOut,
        input.amountIn,
        input.amountOut,
        input.usdValue,
        input.occurredAt,
        input.raw === undefined ? null : JSON.stringify(input.raw),
        now,
      );
    if (result.changes === 1) {
      db.prepare(
        "UPDATE crypto_watched_wallets SET last_activity_at = MAX(COALESCE(last_activity_at, 0), ?), updated_at = ? WHERE id = ?",
      ).run(input.occurredAt, now, input.walletId);
    }
    return result.changes === 1;
  });
  const row = getCryptoDb()
    .prepare("SELECT * FROM crypto_wallet_events WHERE wallet_id = ? AND signature = ?")
    .get(input.walletId, input.signature) as WalletEventRow;
  return { event: hydrateWalletEvent(row), duplicate: !inserted };
}

interface WalletEventRow {
  id: string;
  wallet_id: string;
  chain: WatchedWalletChain;
  signature: string;
  kind: "swap" | "transfer" | "other";
  token_in: string | null;
  token_out: string | null;
  amount_in: number | null;
  amount_out: number | null;
  usd_value: number | null;
  occurred_at: number;
  created_at: number;
}

function hydrateWalletEvent(row: WalletEventRow): WalletEvent {
  return {
    id: row.id,
    walletId: row.wallet_id,
    chain: row.chain,
    signature: row.signature,
    kind: row.kind,
    tokenIn: row.token_in,
    tokenOut: row.token_out,
    amountIn: row.amount_in,
    amountOut: row.amount_out,
    usdValue: row.usd_value,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

export function listWalletEventsSince(since: number, limit = 5000): WalletEvent[] {
  const rows = getCryptoDb()
    .prepare("SELECT * FROM crypto_wallet_events WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?")
    .all(since, limit) as WalletEventRow[];
  return rows.map(hydrateWalletEvent);
}

export function listWalletEvents(input: { walletId?: string; limit: number; offset: number }): {
  items: WalletEvent[];
  total: number;
} {
  const { where, params } = buildWhere([["wallet_id = ?", input.walletId]]);
  const db = getCryptoDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM crypto_wallet_events ${where}`).get(...params) as { n: number })
    .n;
  const rows = db
    .prepare(`SELECT * FROM crypto_wallet_events ${where} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`)
    .all(...params, input.limit, input.offset) as WalletEventRow[];
  return { items: rows.map(hydrateWalletEvent), total };
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

interface SignalRow {
  id: string;
  engine: string;
  asset_id: string;
  symbol: string | null;
  direction: "buy" | "sell" | "hold";
  strength: number;
  confidence: number;
  features_json: string;
  rationale: string;
  judge_json: string | null;
  status: SignalStatus;
  created_at: number;
  expires_at: number;
}

function hydrateSignal(row: SignalRow): CryptoSignal {
  return {
    id: row.id,
    engine: row.engine,
    assetId: row.asset_id,
    symbol: row.symbol,
    direction: row.direction,
    strength: row.strength,
    confidence: row.confidence,
    features: parseJsonObject(row.features_json) ?? {},
    rationale: row.rationale,
    judge: parseJsonObject(row.judge_json),
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function insertSignal(input: Omit<CryptoSignal, "id" | "createdAt" | "status">): CryptoSignal {
  const now = Date.now();
  const id = newCryptoId("sig");
  write("signal-insert", (db) => {
    db.prepare(
      `INSERT INTO crypto_signals (id, engine, asset_id, symbol, direction, strength, confidence, features_json, rationale,
         judge_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id,
      input.engine,
      input.assetId,
      input.symbol,
      input.direction,
      input.strength,
      input.confidence,
      JSON.stringify(input.features),
      input.rationale,
      jsonOrNull(input.judge),
      now,
      input.expiresAt,
    );
  });
  return getSignal(id) as CryptoSignal;
}

export function getSignal(id: string): CryptoSignal | null {
  const row = getCryptoDb().prepare("SELECT * FROM crypto_signals WHERE id = ?").get(id) as SignalRow | null;
  return row ? hydrateSignal(row) : null;
}

export function listSignals(input: {
  status?: SignalStatus;
  engine?: string;
  limit: number;
  offset: number;
  now?: number;
}): { items: CryptoSignal[]; total: number } {
  const db = getCryptoDb();
  const now = input.now ?? Date.now();
  // Lazily expire so readers never see stale "active" signals.
  write("signal-expire", (txn) => {
    txn.prepare("UPDATE crypto_signals SET status = 'expired' WHERE status = 'active' AND expires_at < ?").run(now);
  });
  const { where, params } = buildWhere([
    ["status = ?", input.status],
    ["engine = ?", input.engine],
  ]);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM crypto_signals ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM crypto_signals ${where} ORDER BY created_at DESC, strength DESC LIMIT ? OFFSET ?`)
    .all(...params, input.limit, input.offset) as SignalRow[];
  return { items: rows.map(hydrateSignal), total };
}

export function setSignalStatus(id: string, status: SignalStatus): void {
  write("signal-status", (db) => {
    db.prepare("UPDATE crypto_signals SET status = ? WHERE id = ?").run(status, id);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWhere(clauses: Array<[string, SQLQueryBindings | undefined]>): {
  where: string;
  params: SQLQueryBindings[];
} {
  const active = clauses.filter(([, value]) => value !== undefined && value !== null && value !== "");
  return {
    where: active.length > 0 ? `WHERE ${active.map(([clause]) => clause).join(" AND ")}` : "",
    params: active.map(([, value]) => value as SQLQueryBindings),
  };
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
