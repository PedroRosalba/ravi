import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CryptoLedgerError,
  closeCryptoDb,
  getAccountBalanceAtomic,
  getAccountBalances,
  getLedgerTrialBalance,
  getVaultByOwner,
  listAccountHistory,
  openVault,
  postJournal,
  recordWalletEvent,
  resolveAsset,
  upsertAsset,
  upsertWatchedWallet,
} from "./db.js";
import { ASSET_BRL, ASSET_USDC, SYSTEM_ACCOUNTS, vaultAccount } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravi-crypto-db-"));
  process.env.RAVI_CRYPTO_DB_PATH = join(dir, "crypto.db");
  closeCryptoDb();
});

afterEach(() => {
  closeCryptoDb();
  delete process.env.RAVI_CRYPTO_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function deposit(vaultId: string, refId: string, amount: bigint) {
  return postJournal({
    kind: "deposit",
    refType: "deposit",
    refId,
    entries: [
      { account: vaultAccount(vaultId), assetId: ASSET_BRL, amount },
      { account: SYSTEM_ACCOUNTS.pixInflow, assetId: ASSET_BRL, amount: -amount },
    ],
  });
}

describe("crypto ledger store", () => {
  it("opens exactly one vault per owner", () => {
    const first = openVault({ owner: { type: "contact", id: "c1" } });
    const second = openVault({ owner: { type: "contact", id: "c1" } });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.vault.id).toBe(first.vault.id);
    expect(getVaultByOwner({ type: "contact", id: "c2" })).toBeNull();
  });

  it("posts balanced journals and derives balances", () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    deposit(vault.id, "dep_1", 10_000n);
    const balances = getAccountBalances(vaultAccount(vault.id));
    expect(balances).toEqual([
      expect.objectContaining({ assetId: ASSET_BRL, symbol: "BRL", atomic: "10000", amount: "100" }),
    ]);
    expect(getLedgerTrialBalance().every((row) => row.net === "0")).toBe(true);
  });

  it("is idempotent on (kind, refType, refId) so webhook replays never double-credit", () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    const first = deposit(vault.id, "dep_1", 10_000n);
    const replay = deposit(vault.id, "dep_1", 10_000n);
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.journal.id).toBe(first.journal.id);
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), ASSET_BRL)).toBe(10_000n);
  });

  it("rejects unbalanced journals", () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    expect(() =>
      postJournal({
        kind: "deposit",
        refType: "deposit",
        refId: "bad",
        entries: [
          { account: vaultAccount(vault.id), assetId: ASSET_BRL, amount: 100n },
          { account: SYSTEM_ACCOUNTS.pixInflow, assetId: ASSET_BRL, amount: -99n },
        ],
      }),
    ).toThrow(CryptoLedgerError);
  });

  it("refuses to overdraw a vault and writes nothing", () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    deposit(vault.id, "dep_1", 1_000n);
    let error: unknown;
    try {
      postJournal({
        kind: "trade",
        refType: "trade",
        refId: "trd_1",
        entries: [
          { account: vaultAccount(vault.id), assetId: ASSET_BRL, amount: -1_001n },
          { account: SYSTEM_ACCOUNTS.market, assetId: ASSET_BRL, amount: 1_001n },
        ],
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CryptoLedgerError);
    expect((error as CryptoLedgerError).code).toBe("LEDGER_INSUFFICIENT_FUNDS");
    expect(getAccountBalanceAtomic(vaultAccount(vault.id), ASSET_BRL)).toBe(1_000n);
    expect(listAccountHistory(vaultAccount(vault.id), { limit: 10, offset: 0 }).total).toBe(1);
  });

  it("supports multi-asset conversion journals", () => {
    const { vault } = openVault({ owner: { type: "contact", id: "c1" } });
    deposit(vault.id, "dep_1", 10_000n);
    postJournal({
      kind: "conversion",
      refType: "deposit",
      refId: "dep_1",
      entries: [
        { account: vaultAccount(vault.id), assetId: ASSET_BRL, amount: -10_000n },
        { account: SYSTEM_ACCOUNTS.conversion, assetId: ASSET_BRL, amount: 10_000n },
        { account: vaultAccount(vault.id), assetId: ASSET_USDC, amount: 18_000_000n },
        { account: SYSTEM_ACCOUNTS.conversion, assetId: ASSET_USDC, amount: -18_000_000n },
      ],
    });
    const balances = getAccountBalances(vaultAccount(vault.id));
    expect(balances.map((b) => [b.symbol, b.amount])).toEqual([["USDC", "18"]]);
  });

  it("guards asset decimals and resolves symbols", () => {
    upsertAsset({
      id: "mintX",
      symbol: "TSLAx",
      name: "Tesla xStock",
      decimals: 8,
      kind: "tokenized_stock",
      chain: "solana",
    });
    expect(resolveAsset("tslax")?.id).toBe("mintX");
    expect(() =>
      upsertAsset({
        id: "mintX",
        symbol: "TSLAx",
        name: "Tesla xStock",
        decimals: 6,
        kind: "tokenized_stock",
        chain: "solana",
      }),
    ).toThrow(CryptoLedgerError);
  });

  it("records wallet events idempotently", () => {
    const { wallet } = upsertWatchedWallet({ chain: "solana", address: "Wa11et", source: "manual" });
    const event = {
      walletId: wallet.id,
      chain: "solana" as const,
      signature: "sig1",
      kind: "swap" as const,
      tokenIn: ASSET_USDC,
      tokenOut: "mintX",
      amountIn: 100,
      amountOut: 1,
      usdValue: 100,
      occurredAt: 1_000,
    };
    expect(recordWalletEvent(event).duplicate).toBe(false);
    expect(recordWalletEvent(event).duplicate).toBe(true);
  });
});
