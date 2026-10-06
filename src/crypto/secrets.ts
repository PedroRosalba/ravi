/**
 * Secret lookup for crypto integrations. Prefers the credential broker
 * (keychain/vault-backed, audited); falls back to a named env var so local dev
 * works with ~/.ravi/.env. Secrets are never logged or returned to agents.
 */

import { getCredentialConnection, resolveCredentialSecret } from "../credentials/index.js";

export interface SecretLookup {
  provider: string;
  connection: string;
  action: string;
  envVar?: string;
}

export async function lookupSecret(input: SecretLookup): Promise<string | null> {
  try {
    if (getCredentialConnection(input.provider, input.connection)) {
      const { secret } = await resolveCredentialSecret({
        provider: input.provider,
        connection: input.connection,
        action: input.action,
      });
      if (secret.trim()) return secret.trim();
    }
  } catch {
    // Fall through to env; callers fail closed when nothing is configured.
  }
  const fromEnv = input.envVar ? process.env[input.envVar]?.trim() : undefined;
  return fromEnv || null;
}

export function hasConfiguredSecret(input: SecretLookup): boolean {
  try {
    if (getCredentialConnection(input.provider, input.connection)) return true;
  } catch {
    // ignore
  }
  return Boolean(input.envVar && process.env[input.envVar]?.trim());
}
