/**
 * Crypto domain configuration, stored in the crypto DB's settings table so it
 * travels with the ledger. Secrets never live here — they go through the
 * credential broker (`ravi credentials add --provider <p> ...`).
 */

import { randomBytes } from "node:crypto";
import { getCryptoSetting, listCryptoSettings, setCryptoSetting } from "./db.js";
import { parseDecimalToAtomic } from "./money.js";
import { ASSET_USDC, type ExecutionMode } from "./types.js";

export interface CryptoSettingSpec {
  key: string;
  description: string;
  defaultValue: string;
  validate?: (value: string) => string | null;
}

const bool = (value: string) => (value === "true" || value === "false" ? null : "Use true or false.");
const positiveNumber = (value: string) =>
  Number.isFinite(Number(value)) && Number(value) > 0 ? null : "Use a positive number.";
const nonNegativeInt = (value: string) =>
  Number.isInteger(Number(value)) && Number(value) >= 0 ? null : "Use a non-negative integer.";
const brlAmount = (value: string) => {
  try {
    return parseDecimalToAtomic(value, 2) > 0n ? null : "Use a positive BRL amount.";
  } catch {
    return "Use a BRL amount like 50.00.";
  }
};
const oneOf =
  (...values: string[]) =>
  (value: string) =>
    values.includes(value) ? null : `Use one of: ${values.join(", ")}.`;

export const CRYPTO_SETTINGS: CryptoSettingSpec[] = [
  {
    key: "pix.provider",
    description: "Pix provider: sandbox | ripio",
    defaultValue: "sandbox",
    validate: oneOf("sandbox", "ripio"),
  },
  {
    key: "pix.expiresSeconds",
    description: "Pix charge lifetime in seconds",
    defaultValue: "1800",
    validate: positiveNumber,
  },
  { key: "pix.minDepositBrl", description: "Minimum deposit (BRL)", defaultValue: "10.00", validate: brlAmount },
  {
    key: "pix.maxDepositBrl",
    description: "Maximum deposit per charge (BRL)",
    defaultValue: "5000.00",
    validate: brlAmount,
  },
  { key: "pix.merchantName", description: "Merchant name shown in the Pix charge", defaultValue: "RAVI" },
  { key: "pix.merchantCity", description: "Merchant city shown in the Pix charge", defaultValue: "SAO PAULO" },
  {
    key: "ripio.environment",
    description: "Ripio host: sandbox | production",
    defaultValue: "sandbox",
    validate: oneOf("sandbox", "production"),
  },
  {
    key: "ripio.chain",
    description: "Chain Ripio delivers USDC on (confirm Solana support with Ripio)",
    defaultValue: "SOLANA",
  },
  { key: "ripio.depositAddress", description: "Treasury address Ripio delivers USDC to", defaultValue: "" },
  {
    key: "deposit.autoConvert",
    description: "Convert BRL deposits to the target asset on arrival",
    defaultValue: "true",
    validate: bool,
  },
  { key: "deposit.targetAsset", description: "Asset deposits convert into (mint)", defaultValue: ASSET_USDC },
  {
    key: "fx.source",
    description: "BRL/USD rate source: awesomeapi | static",
    defaultValue: "awesomeapi",
    validate: oneOf("awesomeapi", "static"),
  },
  {
    key: "fx.staticUsdBrl",
    description: "BRL per USD when fx.source=static",
    defaultValue: "5.40",
    validate: positiveNumber,
  },
  {
    key: "fees.conversionBps",
    description: "Platform fee on BRL→USDC conversion (basis points)",
    defaultValue: "0",
    validate: nonNegativeInt,
  },
  {
    key: "execution.mode",
    description: "Trade execution: paper | live",
    defaultValue: "paper",
    validate: oneOf("paper", "live"),
  },
  { key: "risk.killSwitch", description: "Block all new trades and executions", defaultValue: "false", validate: bool },
  {
    key: "risk.maxTradeUsd",
    description: "Max notional per trade (USD)",
    defaultValue: "1000",
    validate: positiveNumber,
  },
  {
    key: "risk.maxDailyUsd",
    description: "Max executed notional per vault per 24h (USD)",
    defaultValue: "2500",
    validate: positiveNumber,
  },
  {
    key: "risk.maxPositionFraction",
    description: "Max fraction of vault equity in one trade",
    defaultValue: "0.35",
    validate: positiveNumber,
  },
  {
    key: "risk.maxSlippageBps",
    description: "Max slippage tolerance (bps)",
    defaultValue: "100",
    validate: nonNegativeInt,
  },
  {
    key: "risk.maxPriceImpactPct",
    description: "Max quoted price impact (%)",
    defaultValue: "1.5",
    validate: positiveNumber,
  },
  {
    key: "risk.minLiquidityUsd",
    description: "Min token liquidity to trade (USD)",
    defaultValue: "250000",
    validate: positiveNumber,
  },
  {
    key: "risk.allowlist",
    description: "Comma-separated tradable mints (empty = any asset passing liquidity checks)",
    defaultValue: "",
  },
  {
    key: "trade.ttlMinutes",
    description: "Minutes a proposal stays approvable",
    defaultValue: "30",
    validate: positiveNumber,
  },
  {
    key: "approval.target",
    description: 'Operator approval chat JSON: {"channel","accountId","chatId"}',
    defaultValue: "",
  },
  {
    key: "approval.timeoutMinutes",
    description: "Minutes to wait for an operator reaction",
    defaultValue: "30",
    validate: positiveNumber,
  },
  {
    key: "jev.enabled",
    description: "Ask TypeSafe Jev to judge engine signals and proposals",
    defaultValue: "false",
    validate: bool,
  },
  {
    key: "jev.model",
    description: "Jev model id (pin a version once thresholds are tuned)",
    defaultValue: "jev-latest",
  },
  {
    key: "jev.minConfidence",
    description: "Min Jev confidence to accept a 'take' verdict",
    defaultValue: "0.6",
    validate: positiveNumber,
  },
  {
    key: "engine.signalTtlMinutes",
    description: "Minutes an engine signal stays active",
    defaultValue: "240",
    validate: positiveNumber,
  },
  { key: "engine.watchlist", description: "Comma-separated mints the momentum engine scans", defaultValue: "" },
  {
    key: "engine.minDistinctWallets",
    description: "Smart-money: min distinct wallets for consensus",
    defaultValue: "2",
    validate: positiveNumber,
  },
  {
    key: "engine.windowHours",
    description: "Smart-money: lookback window (hours)",
    defaultValue: "24",
    validate: positiveNumber,
  },
  {
    key: "live.walletAddress",
    description: "Public key of the omnibus treasury wallet used in live mode",
    defaultValue: "",
  },
  {
    key: "live.connection",
    description: "Credential broker connection holding the treasury secret key (provider=solana)",
    defaultValue: "treasury",
  },
  {
    key: "live.rpcUrl",
    description: "Solana RPC URL for live balance checks",
    defaultValue: "https://api.mainnet-beta.solana.com",
  },
];

const SPEC_BY_KEY = new Map(CRYPTO_SETTINGS.map((spec) => [spec.key, spec]));
const SANDBOX_SECRET_KEY = "pix.sandboxWebhookSecret";

export function getSettingSpec(key: string): CryptoSettingSpec | undefined {
  return SPEC_BY_KEY.get(key);
}

export function readSetting(key: string): string {
  const spec = SPEC_BY_KEY.get(key);
  const stored = getCryptoSetting(key);
  if (stored !== null) return stored;
  if (!spec) throw new Error(`Unknown crypto setting: ${key}`);
  return spec.defaultValue;
}

export function readNumberSetting(key: string): number {
  return Number(readSetting(key));
}

export function readBoolSetting(key: string): boolean {
  return readSetting(key) === "true";
}

export function writeSetting(key: string, value: string | null): { key: string; value: string } {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) throw new Error(`Unknown crypto setting: ${key}`);
  if (value !== null) {
    const problem = spec.validate?.(value);
    if (problem) throw new Error(`Invalid value for ${key}: ${problem}`);
    if (key === "approval.target" && value.trim()) parseApprovalTarget(value);
  }
  setCryptoSetting(key, value);
  return { key, value: readSetting(key) };
}

export function listSettings(): Array<{ key: string; value: string; isDefault: boolean; description: string }> {
  const stored = listCryptoSettings();
  return CRYPTO_SETTINGS.map((spec) => ({
    key: spec.key,
    value: stored[spec.key] ?? spec.defaultValue,
    isDefault: stored[spec.key] === undefined,
    description: spec.description,
  }));
}

export function getExecutionMode(): ExecutionMode {
  return readSetting("execution.mode") === "live" ? "live" : "paper";
}

export interface ApprovalTargetConfig {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
  instanceId?: string;
}

export function parseApprovalTarget(raw: string): ApprovalTargetConfig {
  const parsed = JSON.parse(raw) as Partial<ApprovalTargetConfig>;
  if (!parsed.channel || !parsed.accountId || !parsed.chatId) {
    throw new Error('approval.target needs {"channel","accountId","chatId"}.');
  }
  return {
    channel: parsed.channel,
    accountId: parsed.accountId,
    chatId: parsed.chatId,
    ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
    ...(parsed.instanceId ? { instanceId: parsed.instanceId } : {}),
  };
}

export function getApprovalTarget(): ApprovalTargetConfig | null {
  const raw = readSetting("approval.target").trim();
  return raw ? parseApprovalTarget(raw) : null;
}

/**
 * HMAC secret for the sandbox provider's webhooks. Generated once and kept in
 * the crypto DB: it only authenticates play money, so it is not a broker secret.
 */
export function getSandboxWebhookSecret(): string {
  const env = process.env.RAVI_CRYPTO_SANDBOX_WEBHOOK_SECRET?.trim();
  if (env) return env;
  const existing = getCryptoSetting(SANDBOX_SECRET_KEY);
  if (existing) return existing;
  const generated = randomBytes(32).toString("hex");
  setCryptoSetting(SANDBOX_SECRET_KEY, generated);
  return generated;
}

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
