/**
 * Shared CLI plumbing for `ravi crypto *`: identity rules, error → contract
 * envelope mapping, and the operator gate.
 */

import { CONTRACT_EXIT_ERROR, CONTRACT_EXIT_POLICY, CONTRACT_EXIT_USAGE, contractFail } from "../cli/agent-contract.js";
import { CryptoLedgerError, getVault, getVaultByOwner, openVault } from "./db.js";
import { type CryptoCaller, formatOwner, resolveCryptoCaller, resolveVaultOwner } from "./identity.js";
import { MarketDataError } from "./market/types.js";
import { MoneyFormatError } from "./money.js";
import { CryptoServiceError } from "./service.js";
import type { AmountUnit } from "./service.js";
import type { CryptoVault } from "./types.js";

const USAGE_CODES = new Set([
  "CRYPTO_INVALID_AMOUNT",
  "CRYPTO_ASSET_REQUIRED",
  "CRYPTO_ASSET_INVALID",
  "CRYPTO_OWNER_INVALID",
  "CRYPTO_INVALID_ARGUMENT",
]);
const POLICY_CODES = new Set([
  "CRYPTO_TRADE_RISK_BLOCKED",
  "CRYPTO_TRADE_JUDGE_BLOCKED",
  "CRYPTO_OPERATOR_ONLY",
  "CRYPTO_OWNER_FLAG_FORBIDDEN",
  "CRYPTO_VAULT_FROZEN",
]);

const SUGGESTIONS: Record<string, string> = {
  CRYPTO_INSUFFICIENT_FUNDS: "Check `ravi crypto balance` or ask for a deposit with `ravi crypto deposit <valor>`.",
  CRYPTO_TRADE_RISK_BLOCKED: "Reduce the amount or check limits with `ravi crypto settings list`.",
  CRYPTO_ASSET_NOT_FOUND: "Use an xStock symbol (TSLAx, NVDAx, SPYx, AAPLx, QQQx) or a verified token mint.",
  CRYPTO_ASSET_AMBIGUOUS: "Pass the token mint address instead of the symbol.",
  CRYPTO_ACTOR_UNRESOLVED: "The sender must be a registered contact; operators pass --owner contact:<id>.",
  CRYPTO_OPERATOR_ONLY: "Ask the operator to run this from a terminal (or approve via the approval message).",
  CRYPTO_VAULT_NOT_FOUND: "Create one with `ravi crypto deposit <valor>` (vaults open on first deposit).",
  CRYPTO_TRADE_EXPIRED: "Create a new proposal with `ravi crypto trades propose`.",
};

export function failFromError(op: string, error: unknown, asJson?: boolean): never {
  if (error instanceof CryptoServiceError || error instanceof CryptoLedgerError) {
    const exitCode = USAGE_CODES.has(error.code)
      ? CONTRACT_EXIT_USAGE
      : POLICY_CODES.has(error.code)
        ? CONTRACT_EXIT_POLICY
        : CONTRACT_EXIT_ERROR;
    contractFail(op, error.code, error.message, {
      asJson,
      exitCode,
      details: {
        ...error.details,
        ...(SUGGESTIONS[error.code] ? { suggestedAction: SUGGESTIONS[error.code] } : {}),
      },
    });
  }
  if (error instanceof MoneyFormatError) {
    contractFail(op, "CRYPTO_INVALID_AMOUNT", error.message, { asJson, exitCode: CONTRACT_EXIT_USAGE });
  }
  if (error instanceof MarketDataError) {
    contractFail(op, error.code, error.message, {
      asJson,
      details: { retryable: true, suggestedAction: "Market data is temporarily unavailable; retry in a minute." },
    });
  }
  throw error;
}

export async function runOp<T>(op: string, asJson: boolean | undefined, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    return failFromError(op, error, asJson);
  }
}

/**
 * Resolve (and optionally open) the vault for the person asking.
 * Agents always get the turn actor's vault; operators may pass --owner.
 */
export function resolveCallerVault(
  op: string,
  input: { owner?: string; asJson?: boolean; create?: boolean },
): { caller: CryptoCaller; vault: CryptoVault | null; ownerRef: string } {
  const caller = resolveCryptoCaller();
  const resolution = resolveVaultOwner(caller, input.owner);
  if (!resolution.ok) {
    const exitCode =
      resolution.code === "CRYPTO_OWNER_INVALID"
        ? CONTRACT_EXIT_USAGE
        : resolution.code === "CRYPTO_OWNER_FLAG_FORBIDDEN"
          ? CONTRACT_EXIT_POLICY
          : CONTRACT_EXIT_ERROR;
    contractFail(op, resolution.code, resolution.message, {
      asJson: input.asJson,
      exitCode,
      details: SUGGESTIONS[resolution.code] ? { suggestedAction: SUGGESTIONS[resolution.code] } : {},
    });
  }
  if (resolution.via === "operator-flag") assertOperator(op, input.asJson);
  const ownerRef = formatOwner(resolution.owner);
  if (input.create) {
    const { vault } = openVault({ owner: resolution.owner, agentId: caller.agentId });
    return { caller, vault, ownerRef };
  }
  return { caller, vault: getVaultByOwner(resolution.owner), ownerRef };
}

/** Best-effort vault lookup for read-only personalization (never fails, never prints). */
export function peekCallerVault(owner?: string): CryptoVault | null {
  const resolution = resolveVaultOwner(resolveCryptoCaller(), owner);
  return resolution.ok ? getVaultByOwner(resolution.owner) : null;
}

/** Same as resolveCallerVault but fails when the vault does not exist yet. */
export function requireCallerVault(
  op: string,
  input: { owner?: string; asJson?: boolean },
): { caller: CryptoCaller; vault: CryptoVault; ownerRef: string } {
  const resolved = resolveCallerVault(op, input);
  if (!resolved.vault) {
    contractFail(op, "CRYPTO_VAULT_NOT_FOUND", `No vault yet for ${resolved.ownerRef}.`, {
      asJson: input.asJson,
      details: { suggestedAction: SUGGESTIONS.CRYPTO_VAULT_NOT_FOUND },
    });
  }
  return resolved as { caller: CryptoCaller; vault: CryptoVault; ownerRef: string };
}

let operatorTtyRequired = true;

/** Tests run without a terminal; production never flips this (no env/flag can). */
export function setOperatorTtyRequirementForTest(required: boolean): void {
  operatorTtyRequired = required;
}

function operatorDenial(op: string, asJson: boolean | undefined, reason: string): never {
  return contractFail(op, "CRYPTO_OPERATOR_ONLY", reason, {
    asJson,
    exitCode: CONTRACT_EXIT_POLICY,
    details: { suggestedAction: SUGGESTIONS.CRYPTO_OPERATOR_ONLY },
  });
}

/**
 * Money-moving decisions, configuration and cross-vault access are
 * operator-only. Two independent requirements:
 * 1. no agent/tool/gateway runtime context, and
 * 2. an interactive terminal on stdin — agent Bash tools have none, so
 *    stripping the RAVI_* env (`env -u …`) is not enough to pass.
 * Neither stops an agent that can run arbitrary code as the same OS user;
 * public-facing agents must not have Bash/interpreters (see crypto RUNBOOK).
 */
export function assertOperator(op: string, asJson?: boolean): void {
  if (resolveCryptoCaller().agentRuntime) {
    operatorDenial(op, asJson, `${op} can only be run by the operator from a terminal, not by an agent.`);
  }
  if (operatorTtyRequired && !process.stdin.isTTY) {
    operatorDenial(op, asJson, `${op} must be run by the operator from an interactive terminal.`);
  }
}

/** Load a vault by id for operator commands. */
export function requireVaultById(op: string, vaultId: string, asJson?: boolean): CryptoVault {
  const vault = getVault(vaultId);
  if (!vault) contractFail(op, "CRYPTO_VAULT_NOT_FOUND", `Vault not found: ${vaultId}`, { asJson });
  return vault as CryptoVault;
}

export function printJsonOr(asJson: boolean | undefined, payload: unknown, human: () => void): void {
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else human();
}

const UNITS: AmountUnit[] = ["usd", "brl", "units", "percent"];

export function parseUnit(op: string, unit: string | undefined, asJson?: boolean): AmountUnit {
  const value = (unit ?? "usd").toLowerCase() as AmountUnit;
  if (!UNITS.includes(value)) {
    contractFail(op, "CRYPTO_INVALID_ARGUMENT", `Invalid --unit "${unit}". Use ${UNITS.join("|")}.`, {
      asJson,
      exitCode: CONTRACT_EXIT_USAGE,
    });
  }
  return value;
}

export function parseSide(op: string, side: string, asJson?: boolean): "buy" | "sell" {
  const value = side.toLowerCase();
  if (value === "buy" || value === "comprar") return "buy";
  if (value === "sell" || value === "vender") return "sell";
  return contractFail(op, "CRYPTO_INVALID_ARGUMENT", `Invalid side "${side}". Use buy|sell.`, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
  });
}
