import "reflect-metadata";
import {
  walletEventsReturnSchema,
  walletImportReturnSchema,
  walletListReturnSchema,
  walletRemoveReturnSchema,
  walletWatchReturnSchema,
} from "../../crypto/return-schemas.js";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { contractDryRun, contractFail } from "../agent-contract.js";
import { getContext } from "../context.js";
import { CliOnly, Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { buildCliOffsetPagination, parseCliListLimit, parseCliListOffset } from "../pagination.js";
import { assertOperator, printJsonOr } from "../../crypto/cli-support.js";
import {
  getAsset,
  getWatchedWalletById,
  listWalletEvents,
  listWatchedWallets,
  removeWatchedWallet,
  upsertWatchedWallet,
} from "../../crypto/db.js";
import type { WatchedWallet, WatchedWalletChain } from "../../crypto/types.js";

const CHAINS: WatchedWalletChain[] = ["solana", "evm", "hyperliquid"];
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface WalletImportRow {
  address: string;
  chain?: string;
  label?: string;
  score?: number | string;
  tags?: string[] | string;
}

function validAddress(chain: WatchedWalletChain, address: string): boolean {
  return chain === "solana" ? SOLANA_ADDRESS.test(address) : EVM_ADDRESS.test(address);
}

function publicWallet(wallet: WatchedWallet) {
  return {
    id: wallet.id,
    chain: wallet.chain,
    address: wallet.address,
    label: wallet.label,
    source: wallet.source,
    score: typeof wallet.metrics.score === "number" ? wallet.metrics.score : null,
    tags: wallet.tags,
    lastActivityAt: wallet.lastActivityAt ? new Date(wallet.lastActivityAt).toISOString() : null,
  };
}

/** CSV (header row with address[,chain,label,score,tags]) or JSON array of rows. */
function parseImport(text: string): WalletImportRow[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as WalletImportRow[];
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  const header = (lines.shift() ?? "").split(",").map((h) => h.trim().toLowerCase());
  if (!header.includes("address")) throw new Error("CSV needs a header row with an `address` column.");
  return lines.map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    header.forEach((key, index) => {
      row[key] = cells[index] ?? "";
    });
    return row as unknown as WalletImportRow;
  });
}

@Group({
  name: "crypto.wallets",
  description: "Watched on-chain wallets (smart money) that feed the copy-trading engine",
  scope: "open",
})
export class CryptoWalletCommands {
  @Command({
    name: "watch",
    description: "OPERATOR ONLY: add or update a watched wallet",
    helpAfter: `
NOTES
  • Solana wallets feed the smart-money engine via Helius webhooks to /webhooks/crypto/helius.
  • --score (0-1) weights the wallet in consensus; default 0.5.
EXAMPLES
  ravi crypto wallets watch 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1 --label "whale A" --score 0.8 --json
  ravi crypto wallets watch 0x1234…abcd --chain evm --label "fund" --json`,
  })
  @CommandAccess({ kind: "mutate", resource: "crypto.wallets", action: "watch", risk: "low" })
  @CliOnly()
  @Returns(walletWatchReturnSchema)
  async watch(
    @Arg("address", { description: "Wallet address" }) address: string,
    @Option({ flags: "--chain <chain>", description: `${CHAINS.join("|")} (default: solana)` }) chain?: string,
    @Option({ flags: "--label <text>", description: "Human label" }) label?: string,
    @Option({ flags: "--score <0-1>", description: "Quality weight for consensus (default: 0.5)" }) score?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto wallets watch";
    // Watched wallets feed signals shown to every user: only the operator curates them.
    assertOperator(op, asJson);
    const walletChain = (chain ?? "solana") as WatchedWalletChain;
    if (!CHAINS.includes(walletChain)) {
      contractFail(op, "CRYPTO_INVALID_ARGUMENT", `Invalid --chain. Use ${CHAINS.join("|")}.`, { asJson, exitCode: 2 });
    }
    if (!validAddress(walletChain, address.trim())) {
      contractFail(op, "CRYPTO_INVALID_ARGUMENT", `"${address}" is not a valid ${walletChain} address.`, {
        asJson,
        exitCode: 2,
      });
    }
    const weight = score === undefined ? undefined : Number(score);
    if (weight !== undefined && !(weight >= 0 && weight <= 1)) {
      contractFail(op, "CRYPTO_INVALID_ARGUMENT", "--score must be between 0 and 1.", { asJson, exitCode: 2 });
    }
    const { wallet, created } = upsertWatchedWallet({
      chain: walletChain,
      address: address.trim(),
      label: label ?? undefined,
      source: "manual",
      ...(weight === undefined ? {} : { metrics: { score: weight } }),
    });
    const payload = { wallet: publicWallet(wallet), created };
    printJsonOr(asJson, payload, () =>
      console.log(`\n✓ ${created ? "Watching" : "Updated"} ${wallet.chain}:${wallet.address} (${wallet.id})`),
    );
    return payload;
  }

  @Command({
    name: "import",
    description:
      "OPERATOR ONLY: bulk-import watched wallets from a CSV or JSON file (e.g. an export of your wallet database)",
    helpAfter: `
FORMAT
  CSV:  address,chain,label,score,tags      (header required; chain defaults to solana; tags separated by ;)
  JSON: [{"address":"…","chain":"solana","label":"…","score":0.8,"tags":["kol"]}]
EXAMPLES
  ravi crypto wallets import ./wallets.csv --json
  ravi crypto wallets import ./wallets.json --source mira --json`,
  })
  @CommandAccess({ kind: "mutate", resource: "crypto.wallets", action: "import", risk: "low" })
  @CliOnly()
  @Returns(walletImportReturnSchema)
  async import(
    @Arg("file", { description: "Path to .csv or .json" }) file: string,
    @Option({ flags: "--source <name>", description: "Source label stored on each wallet (default: import)" })
    source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto wallets import";
    assertOperator(op, asJson);
    const base = getContext()?.cwd ?? process.cwd();
    const path = isAbsolute(file) ? file : resolve(base, file);
    let rows: WalletImportRow[];
    try {
      rows = parseImport(readFileSync(path, "utf8"));
    } catch (error) {
      return contractFail(
        op,
        "CRYPTO_IMPORT_INVALID",
        `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
        {
          asJson,
          exitCode: 2,
        },
      );
    }
    let created = 0;
    let updated = 0;
    const rejected: Array<{ row: number; address: string; reason: string }> = [];
    for (const [index, row] of rows.entries()) {
      const chain = ((row.chain || "solana") as string).toLowerCase() as WatchedWalletChain;
      const address = String(row.address ?? "").trim();
      if (!CHAINS.includes(chain)) {
        rejected.push({ row: index + 1, address, reason: "invalid chain" });
        continue;
      }
      if (!validAddress(chain, address)) {
        rejected.push({ row: index + 1, address, reason: "invalid address" });
        continue;
      }
      const score = row.score === undefined || row.score === "" ? undefined : Number(row.score);
      if (score !== undefined && !(score >= 0 && score <= 1)) {
        rejected.push({ row: index + 1, address, reason: "score must be 0-1" });
        continue;
      }
      const tags = Array.isArray(row.tags)
        ? row.tags
        : row.tags
          ? String(row.tags)
              .split(";")
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;
      const result = upsertWatchedWallet({
        chain,
        address,
        label: row.label || undefined,
        source: source ?? "import",
        tags,
        ...(score === undefined ? {} : { metrics: { score } }),
      });
      if (result.created) created++;
      else updated++;
    }
    const payload = { file: path, rows: rows.length, created, updated, rejected };
    printJsonOr(asJson, payload, () => {
      console.log(`\nImported ${rows.length} row(s): ${created} new, ${updated} updated, ${rejected.length} rejected`);
      for (const r of rejected.slice(0, 10)) console.log(`  row ${r.row} ${r.address}: ${r.reason}`);
    });
    return payload;
  }

  @Command({ name: "list", description: "List watched wallets", aliases: ["ls"] })
  @CommandAccess({ kind: "read", resource: "crypto.wallets", action: "list", risk: "low" })
  @Returns(walletListReturnSchema)
  async list(
    @Option({ flags: "--chain <chain>", description: CHAINS.join("|") }) chain?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const pageLimit = parseCliListLimit(limit);
    const pageOffset = parseCliListOffset(offset);
    const page = listWatchedWallets({
      chain: chain as WatchedWalletChain | undefined,
      limit: pageLimit,
      offset: pageOffset,
    });
    const items = page.items.map(publicWallet);
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crypto", "wallets", "list"],
      limit: pageLimit,
      offset: pageOffset,
      returned: items.length,
      total: page.total,
      options: [chain ? "--chain" : null, chain ?? null],
    });
    const payload = { total: page.total, pagination, items };
    printJsonOr(asJson, payload, () => {
      console.log(`\n${page.total} watched wallet(s)`);
      for (const w of items)
        console.log(`  ${w.id}  ${w.chain.padEnd(11)} ${w.address}  ${w.label ?? ""}  score ${w.score ?? "-"}`);
    });
    return payload;
  }

  @Command({ name: "events", description: "Recent on-chain activity of watched wallets (newest first)" })
  @CommandAccess({ kind: "read", resource: "crypto.wallets", action: "events", risk: "low" })
  @Returns(walletEventsReturnSchema)
  async events(
    @Option({ flags: "--wallet <id>", description: "Only this wallet id (wlt_…)" }) walletId?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const pageLimit = parseCliListLimit(limit);
    const pageOffset = parseCliListOffset(offset);
    const page = listWalletEvents({ walletId, limit: pageLimit, offset: pageOffset });
    const symbol = (mint: string | null) =>
      mint ? (getAsset(mint)?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`) : null;
    const items = page.items.map((event) => ({
      walletId: event.walletId,
      kind: event.kind,
      sold: event.tokenIn ? { token: symbol(event.tokenIn), mint: event.tokenIn, amount: event.amountIn } : null,
      bought: event.tokenOut ? { token: symbol(event.tokenOut), mint: event.tokenOut, amount: event.amountOut } : null,
      usdValue: event.usdValue,
      signature: event.signature,
      at: new Date(event.occurredAt).toISOString(),
    }));
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crypto", "wallets", "events"],
      limit: pageLimit,
      offset: pageOffset,
      returned: items.length,
      total: page.total,
      options: [walletId ? "--wallet" : null, walletId ?? null],
    });
    const payload = { total: page.total, pagination, items };
    printJsonOr(asJson, payload, () => {
      console.log(`\n${page.total} event(s)`);
      for (const e of items) {
        console.log(
          `  ${e.at}  ${e.walletId}  ${e.kind}  ${e.sold?.amount ?? ""} ${e.sold?.token ?? ""} → ${e.bought?.amount ?? ""} ${e.bought?.token ?? ""}`,
        );
      }
    });
    return payload;
  }

  @Command({
    name: "rm",
    description: "OPERATOR ONLY: stop watching a wallet (dry-run by default)",
    aliases: ["remove"],
  })
  @CommandAccess({
    kind: "mutate",
    resource: "crypto.wallets",
    action: "rm",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @CliOnly()
  @Returns(walletRemoveReturnSchema)
  async rm(
    @Arg("walletId", { description: "Wallet id (wlt_…)" }) walletId: string,
    @Option({ flags: "--execute", description: "Actually remove (deletes its event history)" }) execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto wallets rm";
    assertOperator(op, asJson);
    const wallet = getWatchedWalletById(walletId);
    if (!wallet) return contractFail(op, "CRYPTO_WALLET_NOT_FOUND", `Wallet not found: ${walletId}`, { asJson });
    if (execute !== true) contractDryRun(op, { wallet: publicWallet(wallet) }, { asJson });
    const payload = { removed: removeWatchedWallet(walletId), walletId };
    printJsonOr(asJson, payload, () => console.log(`\n✓ Removed ${walletId}`));
    return payload;
  }
}
