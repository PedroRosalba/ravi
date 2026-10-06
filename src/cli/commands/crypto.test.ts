import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContractError } from "../agent-contract.js";
import { setOperatorTtyRequirementForTest } from "../../crypto/cli-support.js";
import { getTrade, openVault, postJournal } from "../../crypto/db.js";
import { setMarketDataForTest } from "../../crypto/market/index.js";
import { RecordingNotifier, setCryptoNotifierForTest } from "../../crypto/notify.js";
import { FakeMarket } from "../../crypto/test-market.js";
import { withTempCryptoDb } from "../../crypto/test-support.js";
import { ASSET_USDC, SYSTEM_ACCOUNTS, vaultAccount } from "../../crypto/types.js";
import { CryptoCommands } from "./crypto.js";
import { CryptoDepositCommands } from "./crypto-deposits.js";
import { CryptoSettingsCommands } from "./crypto-settings.js";
import { CryptoTradeCommands } from "./crypto-trades.js";
import { CryptoWalletCommands } from "./crypto-wallets.js";

const tmp = withTempCryptoDb();
const AGENT_ENV = ["RAVI_AGENT_ID", "RAVI_SESSION_NAME", "RAVI_CONTACT_ID", "RAVI_SESSION_KEY"] as const;
const savedEnv: Partial<Record<(typeof AGENT_ENV)[number], string | undefined>> = {};

function asAgent(contactId?: string) {
  process.env.RAVI_AGENT_ID = "main";
  process.env.RAVI_SESSION_NAME = "agent-main-dm-test";
  if (contactId) process.env.RAVI_CONTACT_ID = contactId;
}

async function contractCode(promise: Promise<unknown> | unknown): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ContractError) return error.code;
    throw error;
  }
}

beforeEach(() => {
  for (const key of AGENT_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  setMarketDataForTest(new FakeMarket());
  setCryptoNotifierForTest(new RecordingNotifier());
  setOperatorTtyRequirementForTest(false);
});

afterEach(() => {
  for (const key of AGENT_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setMarketDataForTest(null);
  setCryptoNotifierForTest(null);
  setOperatorTtyRequirementForTest(true);
});

describe("ravi crypto CLI", () => {
  it("operator flow: deposit → simulate-paid → balance", async () => {
    const crypto = new CryptoCommands();
    const deposits = new CryptoDepositCommands();
    const created = await crypto.deposit("150", "contact:op1", true);
    expect(created.deposit.status).toBe("pending");
    expect(created.deposit.pixCopyPaste).toStartWith("000201");
    expect(created.instructions).toContain("SANDBOX");

    const settled = await deposits.simulatePaid(created.deposit.id, undefined, true);
    expect(settled.outcome).toBe("converted");

    const balance = await crypto.balance("contact:op1", true);
    expect(balance.lines).toEqual([expect.objectContaining({ symbol: "USDC", amount: "30" })]);
    expect(balance.totals).toMatchObject({ usd: 30, brl: 150 });
  });

  it("agents act only for the message sender and never as operator", async () => {
    const { vault } = openVault({ owner: { type: "contact", id: "alice" } });
    postJournal({
      kind: "test.fund",
      refType: "test",
      refId: vault.id,
      entries: [
        { account: vaultAccount(vault.id), assetId: ASSET_USDC, amount: 100_000_000n },
        { account: SYSTEM_ACCOUNTS.adjustments, assetId: ASSET_USDC, amount: -100_000_000n },
      ],
    });

    asAgent("alice");
    const trades = new CryptoTradeCommands();
    const proposal = await trades.propose(
      "buy",
      "TSLAx",
      "10",
      "usd",
      "test",
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(proposal.trade.status).toBe("pending_approval");

    expect(await contractCode(trades.approve(proposal.trade.id, true, true))).toBe("CRYPTO_OPERATOR_ONLY");
    expect(await contractCode(new CryptoSettingsCommands().set("execution.mode", "live", undefined, true))).toBe(
      "CRYPTO_OPERATOR_ONLY",
    );
    expect(await contractCode(new CryptoDepositCommands().simulatePaid("dep_x", undefined, true))).toBe(
      "CRYPTO_OPERATOR_ONLY",
    );

    // Another sender cannot see or redirect to Alice's vault.
    process.env.RAVI_CONTACT_ID = "mallory";
    expect(await contractCode(new CryptoCommands().balance("contact:alice", true))).toBe("CRYPTO_OWNER_FLAG_FORBIDDEN");
    expect(await contractCode(trades.cancel(proposal.trade.id, undefined, true))).toBe("CRYPTO_VAULT_NOT_FOUND");
    expect(getTrade(proposal.trade.id)?.status).toBe("pending_approval");

    // Back in the operator shell, approval works.
    for (const key of AGENT_ENV) delete process.env[key];
    const approved = await trades.approve(proposal.trade.id, true, true);
    expect(approved.trade.status).toBe("executed");
  });

  it("refuses operator actions from a non-interactive process even with RAVI_* env stripped", async () => {
    // Simulates `env -u RAVI_… ravi crypto …` from an agent's Bash: no runtime context, no TTY.
    setOperatorTtyRequirementForTest(true);
    expect(process.stdin.isTTY).toBeFalsy();
    expect(await contractCode(new CryptoTradeCommands().approve("trd_x", true, true))).toBe("CRYPTO_OPERATOR_ONLY");
    expect(await contractCode(new CryptoSettingsCommands().set("risk.killSwitch", "false", undefined, true))).toBe(
      "CRYPTO_OPERATOR_ONLY",
    );
    expect(await contractCode(new CryptoCommands().balance("contact:someone", true))).toBe("CRYPTO_OPERATOR_ONLY");
  });

  it("refuses to open vaults when the sender is unknown", async () => {
    asAgent();
    expect(await contractCode(new CryptoCommands().deposit("50", undefined, true))).toBe("CRYPTO_ACTOR_UNRESOLVED");
  });

  it("imports watched wallets from CSV and reports bad rows", async () => {
    const file = join(tmp.dir(), "wallets.csv");
    writeFileSync(
      file,
      [
        "address,chain,label,score,tags",
        "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1,solana,whale,0.9,kol;early",
        "0x52908400098527886E0F7030069857D2E4169EE7,evm,fund,0.7,",
        "not-an-address,solana,bad,0.5,",
        "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1,solana,whale,2,",
      ].join("\n"),
    );
    const result = await new CryptoWalletCommands().import(file, "mydb", true);
    expect(result).toMatchObject({ rows: 4, created: 2, updated: 0 });
    expect(result.rejected.map((r) => r.reason)).toEqual(["invalid address", "score must be 0-1"]);
    const listed = await new CryptoWalletCommands().list(undefined, undefined, undefined, true);
    expect(listed.items.find((w) => w.chain === "solana")).toMatchObject({
      label: "whale",
      score: 0.9,
      tags: ["kol", "early"],
    });
  });
});

describe("ravi crypto return contracts", () => {
  it("emits payloads that match their exact schemas field for field", async () => {
    const schemas = await import("../../crypto/return-schemas.js");
    const exact = (schema: { parse: (v: unknown) => unknown }, payload: unknown) =>
      // parse() strips unknown keys, so equality proves there are none and every typed field matches.
      expect(schema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(JSON.parse(JSON.stringify(payload)));

    const crypto = new CryptoCommands();
    exact(schemas.cryptoStatusReturnSchema, await crypto.status(true));
    exact(schemas.cryptoBalanceReturnSchema, await crypto.balance("contact:schema", true));
    const created = await crypto.deposit("100", "contact:schema", true);
    exact(schemas.cryptoDepositReturnSchema, created);
    const settled = await new CryptoDepositCommands().simulatePaid(created.deposit.id, undefined, true);
    exact(schemas.depositSimulateReturnSchema, settled);
    exact(schemas.cryptoBalanceReturnSchema, await crypto.balance("contact:schema", true));
    exact(schemas.cryptoHistoryReturnSchema, await crypto.history("contact:schema", undefined, undefined, true));

    const trades = new CryptoTradeCommands();
    const proposal = await trades.propose(
      "buy",
      "TSLAx",
      "5",
      "usd",
      "why",
      undefined,
      undefined,
      undefined,
      "contact:schema",
      true,
    );
    exact(schemas.tradeProposeReturnSchema, proposal);
    exact(schemas.tradeMutationReturnSchema, await trades.approve(proposal.trade.id, true, true));
    exact(
      schemas.tradeListReturnSchema,
      await trades.list(undefined, undefined, "contact:schema", undefined, undefined, true),
    );
    exact(schemas.settingsListReturnSchema, await new CryptoSettingsCommands().list(undefined, undefined, true));
  });
});
