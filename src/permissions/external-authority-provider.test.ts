import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTERNAL_AUTHORITY_ASSERTION_SETTING,
  EXTERNAL_AUTHORITY_PROVIDER_ID,
  EXTERNAL_AUTHORITY_PUBKEY_SETTING,
  canonicalize,
  createExternalAuthorityProvider,
  evaluateExternalAssertion,
  isInlinePem,
  readExternalAuthorityConfig,
  resetExternalAuthorityCacheForTests,
} from "./external-authority-provider.js";
import { authorizePermission } from "./provider-runtime.js";
import {
  DEFAULT_PERMISSION_PROVIDER_IDS,
  PERMISSION_PROVIDER_IDS_SETTING,
  getConfiguredPermissionProviders,
} from "./provider-registry.js";
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

const nowSeconds = () => Math.floor(Date.now() / 1000);

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
        exp: nowSeconds() + 60,
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
        exp: nowSeconds() + 60,
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
        exp: nowSeconds() + 60,
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
        exp: nowSeconds() + 60,
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
      exp: nowSeconds() + 60,
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
        exp: nowSeconds() - 1,
        scope: [{ permission: "execute", objectType: "group", objectId: "pages" }],
      }),
    );
    expect(verdict.decision).toBe("deny");
    expect(verdict.reasonCode).toBe("external_assertion_expired");
  });

  it("interpreta exp em segundos (convenção JWT)", () => {
    const verdict = evaluate(
      signed({
        iss: "issuer",
        sub: "agent:cursor-grok-lab",
        exp: 1_790_000_000,
        scope: [{ permission: "execute", objectType: "group", objectId: "pages" }],
      }),
      1_789_999_000 * 1000,
    );
    expect(verdict.decision).toBe("allow");
  });

  for (const [label, exp] of [
    ["ausente", undefined],
    ["null", null],
    ["string", "1790000000"],
  ] as const) {
    it(`deny quando exp é ${label} (afirmação sem validade não vale para sempre)`, () => {
      const verdict = evaluate(
        signed({
          iss: "issuer",
          sub: "agent:cursor-grok-lab",
          exp,
          scope: [{ permission: "execute", objectType: "group", objectId: "pages" }],
        }),
      );
      expect(verdict.decision).toBe("deny");
      expect(verdict.reasonCode).toBe("external_assertion_malformed");
    });
  }

  it("deny quando o subject não é o do pedido", () => {
    const verdict = evaluate(
      signed({
        iss: "issuer",
        sub: "agent:outro-agente",
        exp: nowSeconds() + 60,
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
          exp: nowSeconds() + 60,
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
        exp: nowSeconds() + 60,
        scope: [{ permission: "execute", objectType: "group", objectId: "pages" }],
      }),
    );
    const provider = createExternalAuthorityProvider(() => ({ assertionPath: path, publicKeyPem }));
    const decision = provider.authorize(request);
    expect(decision.decision).toBe("allow");
    expect(decision.providerId).toBe(EXTERNAL_AUTHORITY_PROVIDER_ID);
  });
});

describe("external authority config", () => {
  it("reconhece qualquer bloco PEM como inline", () => {
    expect(isInlinePem(publicKeyPem)).toBe(true);
    expect(isInlinePem("-----BEGIN RSA PUBLIC KEY-----\nabc")).toBe(true);
    expect(isInlinePem("-----BEGIN CERTIFICATE-----\nabc")).toBe(true);
    expect(isInlinePem("/etc/ravi/authority.pem")).toBe(false);
  });

  it("lê a config dos settings do host, não do env", () => {
    const previous = process.env.RAVI_EXTERNAL_AUTHORITY_ASSERTION;
    process.env.RAVI_EXTERNAL_AUTHORITY_ASSERTION = "/tmp/forjado.json";
    try {
      expect(readExternalAuthorityConfig(() => null)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.RAVI_EXTERNAL_AUTHORITY_ASSERTION;
      else process.env.RAVI_EXTERNAL_AUTHORITY_ASSERTION = previous;
    }
  });

  it("deny explícito quando o arquivo da pubkey não existe", () => {
    const settings: Record<string, string> = {
      [EXTERNAL_AUTHORITY_ASSERTION_SETTING]: join(dir, "assertion.json"),
      [EXTERNAL_AUTHORITY_PUBKEY_SETTING]: join(dir, "nao-existe.pem"),
    };
    const provider = createExternalAuthorityProvider(() => readExternalAuthorityConfig((key) => settings[key] ?? null));
    const decision = provider.authorize(request);
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("external_authority_pubkey_unreadable");
  });
});

const chainSetting = (value: string | null) => (key: string) =>
  key === PERMISSION_PROVIDER_IDS_SETTING ? value : null;

describe("permission provider chain", () => {
  it("mantém a cadeia default quando nada é configurado", () => {
    const providers = getConfiguredPermissionProviders(chainSetting(null));
    expect(providers.map((provider) => provider.id)).toEqual([...DEFAULT_PERMISSION_PROVIDER_IDS]);
  });

  it("mantém a cadeia default quando o banco não está disponível", () => {
    const providers = getConfiguredPermissionProviders(() => {
      throw new Error("no db");
    });
    expect(providers.map((provider) => provider.id)).toEqual([...DEFAULT_PERMISSION_PROVIDER_IDS]);
  });

  it("ignora RAVI_PERMISSION_PROVIDER_IDS no env (controlável pelo agente)", () => {
    const previous = process.env.RAVI_PERMISSION_PROVIDER_IDS;
    process.env.RAVI_PERMISSION_PROVIDER_IDS = "external-authority";
    try {
      const providers = getConfiguredPermissionProviders(chainSetting(null));
      expect(providers.map((provider) => provider.id)).toEqual([...DEFAULT_PERMISSION_PROVIDER_IDS]);
    } finally {
      if (previous === undefined) delete process.env.RAVI_PERMISSION_PROVIDER_IDS;
      else process.env.RAVI_PERMISSION_PROVIDER_IDS = previous;
    }
  });

  it("aceita a autoridade externa na cadeia por configuração, com operator-control fixo", () => {
    const providers = getConfiguredPermissionProviders(chainSetting("external-authority"));
    expect(providers.map((provider) => provider.id)).toEqual(["operator-control", EXTERNAL_AUTHORITY_PROVIDER_ID]);
  });

  it("não tranca o operador local fora quando a cadeia omite operator-control", () => {
    const providers = getConfiguredPermissionProviders(chainSetting("external-authority"));
    const decision = authorizePermission(
      { localOperator: true, permission: "admin", objectType: "system", objectId: "*" },
      { providers },
    );
    expect(decision.decision).toBe("allow");
    expect(decision.reasonCode).toBe("operator_control_local_allow");
  });

  it("operator-control fixo não concede nada a agentes", () => {
    const providers = getConfiguredPermissionProviders(chainSetting("external-authority"));
    const decision = authorizePermission({ ...request, localOperator: true }, { providers });
    expect(decision.allowed).toBe(false);
  });

  it("remove ids duplicados sem mudar a ordem", () => {
    const providers = getConfiguredPermissionProviders(
      chainSetting("context-capabilities,operator-control,context-capabilities"),
    );
    expect(providers.map((provider) => provider.id)).toEqual(["context-capabilities", "operator-control"]);
  });

  it("nega (fail-closed) quando um id configurado não existe", () => {
    const providers = getConfiguredPermissionProviders(chainSetting("operator-control,provider-que-nao-existe"));
    const decision = authorizePermission(request, { providers });
    expect(decision.decision).toBe("deny");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("permission_provider_unavailable");
  });

  it("cadeia externa nega sem afirmação válida, mesmo com o resto saudável", () => {
    const providers = getConfiguredPermissionProviders(chainSetting("external-authority"));
    const decision = authorizePermission(request, { providers });
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("external_authority_not_configured");
  });
});
