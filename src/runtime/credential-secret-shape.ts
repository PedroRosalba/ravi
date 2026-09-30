/**
 * Claude auth secrets are easy to cross-wire: an Anthropic API key (`sk-ant-api…`
 * or other `sk-ant-` key) in `CLAUDE_CODE_OAUTH_TOKEN` still authenticates, then
 * fails later as provider billing. OAuth tokens use the `sk-ant-oat` prefix.
 * Unknown shapes are left alone so non-Anthropic secrets are not rejected.
 */

export const CLAUDE_INHERITED_AUTH_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/** Set on the runtime env when a selected Claude credential owns auth. */
export const RAVI_CLAUDE_MANAGED_AUTH_ENV = "RAVI_CLAUDE_MANAGED_AUTH";

export type AnthropicSecretShape = "api-key" | "oauth" | "unknown";

export interface SecretShapeMismatch {
  label: string;
  authMethod: string;
  targetName: string;
  expected: "oauth" | "api-key";
  detected: "api-key" | "oauth";
  message: string;
  reason: string;
}

export interface SecretShapeBinding {
  sourceKind: string;
  targetKind: string;
  targetName: string;
  secretRef: string;
}

export interface SecretShapeCredential {
  label: string;
  authMethod?: string;
  bindings: SecretShapeBinding[];
}

const OAUTH_SHAPE_RE = /^sk-ant-oat\d*(?:-|$)/i;
const API_KEY_SHAPE_RE = /^sk-ant-api\d*(?:-|$)/i;
const GENERIC_ANT_SHAPE_RE = /^sk-ant-/i;

export function classifyAnthropicSecretShape(value: string): AnthropicSecretShape {
  const trimmed = value.trim();
  if (!trimmed) return "unknown";
  if (OAUTH_SHAPE_RE.test(trimmed)) return "oauth";
  if (API_KEY_SHAPE_RE.test(trimmed)) return "api-key";
  if (GENERIC_ANT_SHAPE_RE.test(trimmed)) return "api-key";
  return "unknown";
}

export function describeResolvedSecretShapeMismatch(input: {
  label: string;
  authMethod?: string;
  targetName: string;
  value: string;
}): SecretShapeMismatch | null {
  const detected = classifyAnthropicSecretShape(input.value);
  if (detected === "unknown") return null;

  const targetExpected = expectedShapeForTarget(input.targetName);
  const methodExpected = expectedShapeForAuthMethod(input.authMethod);
  const expected =
    targetExpected && detected !== targetExpected
      ? targetExpected
      : methodExpected && detected !== methodExpected
        ? methodExpected
        : undefined;
  if (!expected) return null;

  const authMethod = input.authMethod?.trim() || `target ${input.targetName}`;
  const detectedLabel = detected === "api-key" ? "an Anthropic API key" : "an OAuth token";
  const expectedLabel = expected === "oauth" ? "an OAuth token (sk-ant-oat)" : "an API key (sk-ant-api)";
  const message = `Credential "${input.label.trim()}" (${authMethod}) is invalid: ${input.targetName} holds ${detectedLabel}, expected ${expectedLabel}.`;
  return {
    label: input.label.trim(),
    authMethod,
    targetName: input.targetName,
    expected,
    detected,
    message,
    reason: `secret_shape_mismatch: ${message}`,
  };
}

export function findRuntimeCredentialSecretShapeMismatch(
  credential: SecretShapeCredential,
  env: Record<string, string | undefined> = process.env,
): SecretShapeMismatch | null {
  for (const binding of credential.bindings) {
    if (binding.targetKind !== "env" || binding.sourceKind !== "env") continue;
    if (!binding.secretRef.startsWith("env:")) continue;
    const value = env[binding.secretRef.slice("env:".length)]?.trim();
    if (!value) continue;
    const mismatch = describeResolvedSecretShapeMismatch({
      label: credential.label,
      authMethod: credential.authMethod,
      targetName: binding.targetName,
      value,
    });
    if (mismatch) return mismatch;
  }
  return null;
}

/**
 * A selected Claude credential is the auth authority. Inherited process keys
 * (pm2, shell, daemon) must not remain beside an auth profile or a different
 * selected secret. Returns the key names that had a non-empty inherited value.
 */
export function isolateSelectedClaudeAuthEnv(options: {
  runtimeProviderId: string;
  binding?: { authMethod?: string; resolvedEnv: Record<string, string> } | null;
  runtimeEnv: Record<string, string>;
}): string[] {
  if (options.runtimeProviderId !== "claude" || !options.binding) return [];
  if (options.binding.authMethod === "model-broker") return [];

  const allowed = new Set(Object.keys(options.binding.resolvedEnv));
  const blocked: string[] = [];
  for (const key of CLAUDE_INHERITED_AUTH_ENV_KEYS) {
    if (allowed.has(key)) continue;
    const value = options.runtimeEnv[key];
    if (value === undefined) continue;
    if (value.trim()) blocked.push(key);
    delete options.runtimeEnv[key];
  }
  options.runtimeEnv[RAVI_CLAUDE_MANAGED_AUTH_ENV] = "1";
  return blocked;
}

export function explainRuntimeCredentialProviderFailure(
  error: string,
  credential: { label?: string; authMethod?: string } | null | undefined,
): string {
  const label = credential?.label?.trim();
  if (!label || credential?.authMethod === "model-broker") return error;
  const text = error.toLowerCase();
  const billing = text.includes("credit balance") || text.includes("insufficient credit") || text.includes("billing");
  const auth = billing || text.includes("authentication") || text.includes("api key") || text.includes("unauthorized");
  if (!auth) return error;

  const method = credential?.authMethod?.trim() || "unspecified";
  const identity = `Credential "${label}" (${method})`;
  if (method.includes("oauth") && billing) {
    return `${identity}: provider billing error (${compactProviderError(error)}). OAuth is selected; this usually means an API key is in use. Check this credential's secret shape and inherited process auth env.`;
  }
  return `${identity}: ${error}`;
}

function compactProviderError(error: string): string {
  const compact = error.replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
}

function expectedShapeForTarget(targetName: string): "oauth" | "api-key" | undefined {
  if (targetName === "CLAUDE_CODE_OAUTH_TOKEN") return "oauth";
  if (targetName === "ANTHROPIC_API_KEY") return "api-key";
  return undefined;
}

function expectedShapeForAuthMethod(authMethod: string | undefined): "oauth" | "api-key" | undefined {
  const method = authMethod?.trim().toLowerCase() ?? "";
  if (!method) return undefined;
  if (method.includes("oauth")) return "oauth";
  if (method.includes("api-key") || method.includes("api_key") || method === "apikey") return "api-key";
  return undefined;
}
