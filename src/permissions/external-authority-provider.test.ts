import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTERNAL_AUTHORITY_PROVIDER_ID,
  canonicalize,
  createExternalAuthorityProvider,
  evaluateExternalAssertion,
  resetExternalAuthorityCacheForTests,
} from "./external-authority-provider.js";
import { authorizePermission } from "./provider-runtime.js";
import { DEFAULT_PERMISSION_PROVIDER_IDS, getConfiguredPermissionProviders } from "./provider-registry.js";
import type { PermissionProviderRequest } from "./provider-types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravi-external-authority-"));
  resetExternalAuthorityCacheForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetExternalAuthorityCacheForTests();
});

function assertionFile(name: string, assertion: Record<string, unknown>): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(assertion));
  return path;
}

/** Assina de verdade: canonicaliza o payload sem `sig` e assina com ed25519. */
function signed(assertion: Record<string, unknown>): Record<string, unknown> {
  const signature = signPayload(null, Buffer.from(canonicalize(assertion)), privateKey).toString("base64");
  return { ...assertion, sig: signature };
}

const request: PermissionProviderRequest = {
  subject: { type: "agent", id: "cursor-grok-lab" },
  permission: "execute",
  objectType: "group",
  objectId: "pages",
};

function evaluate(assertion: Record<string, unknown>, now = Date.now()) {
  return evaluateExternalAssertion({
    raw: JSON.stringify(assertion),
    request,
    publicKeyPem,
    now,
  });
}

describe("external authority provider", () => {
  it("allow quando a afirmação assinada cobre o pedido", () => {
    const verdict = evaluate(
      signed({
        iss: "https://console.ravi.bot",
        sub: "agent:cursor-grok-lab",
        exp: Date.now() + 60_000,
        scope: [{ permission: "execute", objectType: "group", objectId: "pages" }],
      }),
    );
    expect(verdict.decision).toBe("allow");
    expect(verdict.reasonCode).toBe("external_authority_scope_match");
    expect(String(verdict.evidence[0]?.fingerprint)).toStartWith("sha256:");
  });

  it("aceita wildcard no escopo", () => {
    const verdict = evaluate(
      signed({
        iss: "issuer",
        sub: "agent:cursor-grok-lab",
        exp: Date.now() + 60_000,
        scope: [{ permission: "execute", objectType: "*", objectId: "*" }],
      }),
    );
    expect(verdict.decision).toBe("allow");
  });

  it("needs_approval quando o escopo exige aprovação humana", () => {
    const verdict = evaluate(
      signed({
        iss: "issuer",
        sub: "agent:cursor-grok-lab",
        exp: Date.now() + 60_000,
        scope: [{ permission: "execute", objectType: "group", objectId: "pages", requiresApproval: true }],
      }),
    );
    expect(verdict.decision).toBe("needs_approval");
    expect(verdict.reasonCode).toBe("external_authority_requires_approval");
  });

  it("deny quando o escopo não cobre o pedido", () => {
    const verdict = evaluate(
      signed({
        iss: "issuer",
        sub: "agent:cursor-grok-lab",
        exp: Date.now() + 60_000,
        scope: [{ permission: "read", objectType: "group", objectId: "pages" }],
      }),
    );
    expect(verdict.decision).toBe("deny");
    expect(verdict.reasonCode).toBe("external_authority_not_in_scope");
  });

  it("deny quando a assinatura foi adulterada", () => {
    const assertion = signed({
      iss: "issuer",
      sub: "agent:cursor-grok-lab",
      exp: Date.now() + 60_000,
      scope: [{ permission: "execute", objectType: "group", objectId: "pages" }],
    });
    const tampered = { ...assertion, scope: [{ permission: "execute", objectType: "*", objectId: "*" }] };
    const verdict = evaluate(tampered);
    expect(verdict.decision).toBe("deny");
    expect(verdict.reasonCode).toBe("external_assertion_invalid_signature");
  });

  it("deny quando a afirmação expirou", () => {
    const verdict = evaluate(
      signed({
        iss: "issuer",
        sub: "agent:cursor-grok-lab",
        exp: Date.now() - 1_000,
        scope: [{ permission: "execute", objectType: "group", objectId: "pages" }],
      }),
    );
    expect(verdict.decision).toBe("deny");
    expect(verdict.reasonCode).toBe("external_assertion_expired");
  });

  it("deny quando o subject não é o do pedido", () => {
    const verdict = evaluate(
      signed({
        iss: "issuer",
        sub: "agent:outro-agente",
        exp: Date.now() + 60_000,
        scope: [{ permission: "execute", objectType: "group", objectId: "pages" }],
      }),
    );
    expect(verdict.decision).toBe("deny");
    expect(verdict.reasonCode).toBe("external_assertion_subject_mismatch");
  });

  it("deny quando a audience não bate", () => {
    const verdict = evaluateExternalAssertion({
      raw: JSON.stringify(
        signed({
          iss: "issuer",
          sub: "agent:cursor-grok-lab",
          aud: "outra-instalacao",
          exp: Date.now() + 60_000,
          scope: [{ permission: "execute", objectType: "group", objectId: "pages" }],
        }),
      ),
      request,
      publicKeyPem,
      audience: "esta-instalacao",
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reasonCode).toBe("external_assertion_audience_mismatch");
  });

  it("deny quando o JSON é malformado", () => {
    const verdict = evaluateExternalAssertion({ raw: "{", request, publicKeyPem });
    expect(verdict.decision).toBe("deny");
    expect(verdict.reasonCode).toBe("external_assertion_malformed");
  });

  it("deny quando não há configuração de autoridade externa", () => {
    const provider = createExternalAuthorityProvider(() => null);
    const decision = provider.authorize(request);
    expect(decision.decision).toBe("deny");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("external_authority_not_configured");
  });

  it("deny quando o arquivo da afirmação não existe", () => {
    const provider = createExternalAuthorityProvider(() => ({
      assertionPath: join(dir, "nao-existe.json"),
      publicKeyPem,
    }));
    const decision = provider.authorize(request);
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("external_assertion_missing");
  });

  it("allow ponta a ponta pelo provider, lendo a afirmação do disco", () => {
    const path = assertionFile(
      "assertion.json",
      signed({
        iss: "issuer",
        sub: "agent:cursor-grok-lab",
        exp: Date.now() + 60_000,
        scope: [{ permission: "execute", objectType: "group", objectId: "pages" }],
      }),
    );
    const provider = createExternalAuthorityProvider(() => ({ assertionPath: path, publicKeyPem }));
    const decision = provider.authorize(request);
    expect(decision.decision).toBe("allow");
    expect(decision.providerId).toBe(EXTERNAL_AUTHORITY_PROVIDER_ID);
  });
});

describe("permission provider chain", () => {
  it("mantém a cadeia default quando nada é configurado", () => {
    const providers = getConfiguredPermissionProviders({} as NodeJS.ProcessEnv);
    expect(providers.map((provider) => provider.id)).toEqual([...DEFAULT_PERMISSION_PROVIDER_IDS]);
  });

  it("aceita a autoridade externa na cadeia por configuração", () => {
    const providers = getConfiguredPermissionProviders({
      RAVI_PERMISSION_PROVIDER_IDS: "external-authority",
    } as NodeJS.ProcessEnv);
    expect(providers.map((provider) => provider.id)).toEqual([EXTERNAL_AUTHORITY_PROVIDER_ID]);
  });

  it("nega (fail-closed) quando um id configurado não existe", () => {
    const providers = getConfiguredPermissionProviders({
      RAVI_PERMISSION_PROVIDER_IDS: "operator-control,provider-que-nao-existe",
    } as NodeJS.ProcessEnv);
    const decision = authorizePermission(request, { providers });
    expect(decision.decision).toBe("deny");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("permission_provider_unavailable");
  });

  it("cadeia externa nega sem afirmação válida, mesmo com o resto saudável", () => {
    const providers = getConfiguredPermissionProviders({
      RAVI_PERMISSION_PROVIDER_IDS: "external-authority",
    } as NodeJS.ProcessEnv);
    const decision = authorizePermission(request, { providers });
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("external_authority_not_configured");
  });
});
