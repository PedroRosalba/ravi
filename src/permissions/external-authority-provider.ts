import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { ContextCapability } from "../router/router-db.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";

/**
 * Provider de autoridade externa.
 *
 * A decisão NASCE FORA (um emissor assina uma afirmação sobre o subject) e o
 * Ravi apenas VERIFICA localmente. Não há chamada de rede no caminho crítico:
 * a afirmação é lida de um arquivo e validada com chave pública.
 *
 * Fail-closed por construção: ausência, expiração, assinatura inválida ou
 * escopo que não cobre o pedido resultam em `deny`. Nunca `allow` por engano,
 * nunca fallback silencioso para outra fonte de autoridade.
 *
 * Configuração (env):
 *   RAVI_EXTERNAL_AUTHORITY_ASSERTION  caminho do JSON assinado (obrigatório)
 *   RAVI_EXTERNAL_AUTHORITY_PUBKEY     PEM inline ou caminho de arquivo PEM (obrigatório)
 *   RAVI_EXTERNAL_AUTHORITY_AUD        audience esperada (opcional, recomendado)
 */

export const EXTERNAL_AUTHORITY_PROVIDER_ID = "external-authority";
export const EXTERNAL_AUTHORITY_PROVIDER_VERSION = "0.1.0";

export interface ExternalScope {
  permission: string;
  objectType: string;
  objectId: string;
  /** Quando true, o pedido casa com este escopo mas exige aprovação humana. */
  requiresApproval?: boolean;
}

export interface ExternalAssertion {
  iss: string;
  sub: string;
  aud?: string;
  iat?: number;
  exp?: number;
  scope: ExternalScope[];
  sig: string;
}

export interface ExternalAuthorityConfig {
  assertionPath: string;
  publicKeyPem: string;
  audience?: string;
}

export type ExternalAuthorityFailure =
  | "external_authority_not_configured"
  | "external_assertion_missing"
  | "external_assertion_unreadable"
  | "external_assertion_malformed"
  | "external_assertion_subject_mismatch"
  | "external_assertion_audience_mismatch"
  | "external_assertion_expired"
  | "external_assertion_invalid_signature"
  | "external_assertion_scope_empty"
  | "external_authority_not_in_scope";

export interface ExternalAuthorityVerdict {
  decision: "allow" | "deny" | "needs_approval";
  reasonCode: string;
  evidence: Array<Record<string, unknown>>;
}

/** JSON canônico: chaves ordenadas recursivamente (assinatura estável). */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Impressão digital da afirmação (para auditoria: qual afirmação sustentou a decisão). */
export function assertionFingerprint(assertion: ExternalAssertion): string {
  const { sig: _sig, ...payload } = assertion;
  return `sha256:${createHash("sha256").update(canonicalize(payload)).digest("hex")}`;
}

export function readExternalAuthorityConfig(env: NodeJS.ProcessEnv = process.env): ExternalAuthorityConfig | null {
  const assertionPath = env.RAVI_EXTERNAL_AUTHORITY_ASSERTION?.trim();
  const pubkeyRaw = env.RAVI_EXTERNAL_AUTHORITY_PUBKEY?.trim();
  if (!assertionPath || !pubkeyRaw) return null;
  const audience = env.RAVI_EXTERNAL_AUTHORITY_AUD?.trim() || undefined;
  const publicKeyPem = pubkeyRaw.includes("BEGIN PUBLIC KEY") ? pubkeyRaw : readFileSync(pubkeyRaw, "utf8");
  return { assertionPath, publicKeyPem, audience };
}

function subjectRef(request: PermissionProviderRequest): string | null {
  if (request.subject?.type && request.subject.id) return `${request.subject.type}:${request.subject.id}`;
  const agentId = request.context?.agentId;
  return agentId ? `agent:${agentId}` : null;
}

function scopeMatches(scope: ExternalScope, request: PermissionProviderRequest): boolean {
  const match = (expected: string, actual: string) => expected === "*" || expected === actual;
  return (
    match(scope.permission, request.permission) &&
    match(scope.objectType, request.objectType) &&
    match(scope.objectId, request.objectId)
  );
}

/**
 * Avalia a afirmação externa contra o pedido. Função pura: recebe o texto do
 * arquivo, não lê nada — o I/O fica em `authorize`.
 */
export function evaluateExternalAssertion(input: {
  raw: string;
  request: PermissionProviderRequest;
  publicKeyPem: string;
  audience?: string;
  now?: number;
}): ExternalAuthorityVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    return { decision: "deny", reasonCode: "external_assertion_malformed", evidence: [{ kind: "parse_error" }] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { decision: "deny", reasonCode: "external_assertion_malformed", evidence: [{ kind: "shape" }] };
  }
  const assertion = parsed as ExternalAssertion;
  if (typeof assertion.sig !== "string" || !Array.isArray(assertion.scope) || typeof assertion.sub !== "string") {
    return { decision: "deny", reasonCode: "external_assertion_malformed", evidence: [{ kind: "fields" }] };
  }

  const fingerprint = assertionFingerprint(assertion);
  const audit = {
    kind: "external-assertion",
    fingerprint,
    issuer: assertion.iss,
    subject: assertion.sub,
    exp: assertion.exp,
  };

  const { sig, ...payload } = assertion;
  let signatureValid = false;
  try {
    signatureValid = verifySignature(
      null,
      Buffer.from(canonicalize(payload)),
      createPublicKey(input.publicKeyPem),
      Buffer.from(sig, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { decision: "deny", reasonCode: "external_assertion_invalid_signature", evidence: [audit] };
  }

  const subject = subjectRef(input.request);
  if (!subject || assertion.sub !== subject) {
    return {
      decision: "deny",
      reasonCode: "external_assertion_subject_mismatch",
      evidence: [{ ...audit, requestedSubject: subject }],
    };
  }
  if (input.audience && assertion.aud !== input.audience) {
    return {
      decision: "deny",
      reasonCode: "external_assertion_audience_mismatch",
      evidence: [{ ...audit, expectedAudience: input.audience }],
    };
  }
  const now = input.now ?? Date.now();
  if (typeof assertion.exp === "number" && now >= assertion.exp) {
    return { decision: "deny", reasonCode: "external_assertion_expired", evidence: [{ ...audit, now }] };
  }
  if (assertion.scope.length === 0) {
    return { decision: "deny", reasonCode: "external_assertion_scope_empty", evidence: [audit] };
  }

  const matching = assertion.scope.filter((scope) => scopeMatches(scope, input.request));
  if (matching.length === 0) {
    return { decision: "deny", reasonCode: "external_authority_not_in_scope", evidence: [audit] };
  }
  if (matching.some((scope) => scope.requiresApproval === true)) {
    return { decision: "needs_approval", reasonCode: "external_authority_requires_approval", evidence: [audit] };
  }
  return { decision: "allow", reasonCode: "external_authority_scope_match", evidence: [audit] };
}

type CacheEntry = { mtimeMs: number; size: number; raw: string };
const assertionCache = new Map<string, CacheEntry>();

/** Leitura com cache por mtime/tamanho: evita I/O repetido sem mascarar mudança. */
function readAssertionRaw(
  path: string,
): { raw: string } | { error: "external_assertion_missing" | "external_assertion_unreadable" } {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    assertionCache.delete(path);
    return { error: "external_assertion_missing" };
  }
  const cached = assertionCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { raw: cached.raw };
  try {
    const raw = readFileSync(path, "utf8");
    assertionCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, raw });
    return { raw };
  } catch {
    return { error: "external_assertion_unreadable" };
  }
}

export function resetExternalAuthorityCacheForTests(): void {
  assertionCache.clear();
}

function decisionFor(
  request: PermissionProviderRequest,
  verdict: ExternalAuthorityVerdict,
): PermissionProviderDecision {
  return {
    decision: verdict.decision,
    allowed: verdict.decision === "allow",
    providerId: EXTERNAL_AUTHORITY_PROVIDER_ID,
    providerVersion: EXTERNAL_AUTHORITY_PROVIDER_VERSION,
    reasonCode: verdict.reasonCode,
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
    ...(request.subject ? { subject: request.subject } : {}),
    evidence: verdict.evidence,
  };
}

export function createExternalAuthorityProvider(
  readConfig: () => ExternalAuthorityConfig | null = () => readExternalAuthorityConfig(),
): PermissionProvider {
  return {
    id: EXTERNAL_AUTHORITY_PROVIDER_ID,
    version: EXTERNAL_AUTHORITY_PROVIDER_VERSION,
    required: false,
    supports(request: PermissionProviderRequest): boolean {
      // Só participa quando o pedido tem um ator identificável: autoridade
      // externa é sobre QUEM age, não sobre o que existe no sistema.
      return Boolean(subjectRef(request));
    },
    authorize(request: PermissionProviderRequest): PermissionProviderDecision {
      const config = readConfig();
      if (!config) {
        return decisionFor(request, {
          decision: "deny",
          reasonCode: "external_authority_not_configured",
          evidence: [
            { kind: "config", expected: ["RAVI_EXTERNAL_AUTHORITY_ASSERTION", "RAVI_EXTERNAL_AUTHORITY_PUBKEY"] },
          ],
        });
      }

      const loaded = readAssertionRaw(config.assertionPath);
      if ("error" in loaded) {
        return decisionFor(request, {
          decision: "deny",
          reasonCode: loaded.error,
          evidence: [{ kind: "io", path: config.assertionPath }],
        });
      }

      return decisionFor(
        request,
        evaluateExternalAssertion({
          raw: loaded.raw,
          request,
          publicKeyPem: config.publicKeyPem,
          audience: config.audience,
        }),
      );
    },
    materializeCapabilities(): ContextCapability[] {
      // Autoridade externa autoriza; não materializa capability.
      return [];
    },
  };
}

export const externalAuthorityProvider = createExternalAuthorityProvider();
