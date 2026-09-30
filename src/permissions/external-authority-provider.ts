import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dbGetSetting, type ContextCapability } from "../router/router-db.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";

/**
 * Provider de autoridade externa.
 *
 * A decisão NASCE FORA (um emissor assina uma afirmação sobre o subject) e o
 * Ravi apenas VERIFICA localmente. Não há chamada de rede no caminho crítico:
 * a afirmação é lida de um arquivo e validada com chave pública.
 *
 * Fail-closed por construção: ausência, expiração (ou `exp` ausente),
 * assinatura inválida ou escopo que não cobre o pedido resultam em `deny`.
 * Nunca `allow` por engano, nunca fallback silencioso para outra fonte de
 * autoridade.
 *
 * `iat`/`exp` seguem a convenção JWT: segundos desde epoch. `exp` é obrigatório.
 *
 * Configuração (settings do host, nunca env — o env do processo é controlável
 * pelo agente que está sendo autorizado):
 *   permissions.external_authority.assertion  caminho do JSON assinado (obrigatório)
 *   permissions.external_authority.pubkey     PEM inline ou caminho de arquivo PEM (obrigatório)
 *   permissions.external_authority.audience   audience esperada (opcional, recomendado)
 */

export const EXTERNAL_AUTHORITY_PROVIDER_ID = "external-authority";
export const EXTERNAL_AUTHORITY_PROVIDER_VERSION = "0.1.0";

export const EXTERNAL_AUTHORITY_ASSERTION_SETTING = "permissions.external_authority.assertion";
export const EXTERNAL_AUTHORITY_PUBKEY_SETTING = "permissions.external_authority.pubkey";
export const EXTERNAL_AUTHORITY_AUDIENCE_SETTING = "permissions.external_authority.audience";

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
  | "external_authority_pubkey_unreadable"
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

/** Qualquer bloco PEM (SPKI, PKCS#1, certificado) é inline; o resto é caminho. */
export function isInlinePem(value: string): boolean {
  return value.trimStart().startsWith("-----BEGIN ");
}

export class ExternalAuthorityConfigError extends Error {
  constructor(
    readonly reasonCode: "external_authority_pubkey_unreadable",
    readonly path: string,
  ) {
    super(`${reasonCode}: ${path}`);
  }
}

function readSetting(getSetting: (key: string) => string | null, key: string): string | undefined {
  try {
    return getSetting(key)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function readExternalAuthorityConfig(
  getSetting: (key: string) => string | null = dbGetSetting,
): ExternalAuthorityConfig | null {
  const assertionPath = readSetting(getSetting, EXTERNAL_AUTHORITY_ASSERTION_SETTING);
  const pubkeyRaw = readSetting(getSetting, EXTERNAL_AUTHORITY_PUBKEY_SETTING);
  if (!assertionPath || !pubkeyRaw) return null;
  const audience = readSetting(getSetting, EXTERNAL_AUTHORITY_AUDIENCE_SETTING);
  const publicKeyPem = isInlinePem(pubkeyRaw) ? pubkeyRaw : readPubkeyFile(pubkeyRaw);
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
  // Segundos (convenção JWT). Sem `exp` numérico e finito = sem validade = deny.
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (typeof assertion.exp !== "number" || !Number.isFinite(assertion.exp)) {
    return { decision: "deny", reasonCode: "external_assertion_malformed", evidence: [{ ...audit, kind: "exp" }] };
  }
  if (now >= assertion.exp) {
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
const pubkeyCache = new Map<string, CacheEntry>();

function readPubkeyFile(path: string): string {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    pubkeyCache.delete(path);
    throw new ExternalAuthorityConfigError("external_authority_pubkey_unreadable", path);
  }
  const cached = pubkeyCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.raw;
  try {
    const raw = readFileSync(path, "utf8");
    pubkeyCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, raw });
    return raw;
  } catch {
    throw new ExternalAuthorityConfigError("external_authority_pubkey_unreadable", path);
  }
}

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
  pubkeyCache.clear();
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
      let config: ExternalAuthorityConfig | null;
      try {
        config = readConfig();
      } catch (error) {
        if (!(error instanceof ExternalAuthorityConfigError)) throw error;
        return decisionFor(request, {
          decision: "deny",
          reasonCode: error.reasonCode,
          evidence: [{ kind: "config", setting: EXTERNAL_AUTHORITY_PUBKEY_SETTING, path: error.path }],
        });
      }
      if (!config) {
        return decisionFor(request, {
          decision: "deny",
          reasonCode: "external_authority_not_configured",
          evidence: [
            { kind: "config", expected: [EXTERNAL_AUTHORITY_ASSERTION_SETTING, EXTERNAL_AUTHORITY_PUBKEY_SETTING] },
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
