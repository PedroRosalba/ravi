import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getDb } from "../router/router-db.js";
import { createRuntimeCredential, getRuntimeCredential } from "./credential-store.js";
import {
  isRuntimeCredentialSessionCompatible,
  resolveRuntimeCredentialAttemptBinding,
  serializeRuntimeCredentialAttemptBinding,
} from "./credential-resolver.js";

let stateDir: string | null = null;

describe("runtime credential resolver", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-credential-resolver-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("selects the first resolvable same-provider credential and injects provider env", async () => {
    createRuntimeCredential({
      id: "rcred_missing",
      label: "Missing secret",
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      priority: 100,
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "OPENAI_API_KEY",
          secretRef: "env:RAVI_TEST_MISSING_KEY",
          sourceHint: "RAVI_TEST_MISSING_KEY",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    createRuntimeCredential({
      id: "rcred_ready",
      label: "Ready secret",
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      priority: 50,
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "OPENAI_API_KEY",
          secretRef: "env:RAVI_TEST_READY_KEY",
          sourceHint: "RAVI_TEST_READY_KEY",
          sensitive: true,
          remoteForward: true,
        },
      ],
    });

    const result = await resolveRuntimeCredentialAttemptBinding({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      env: {
        RAVI_TEST_READY_KEY: "sk-test_ready_secret_value",
      },
    });

    expect(result.selected?.id).toBe("rcred_ready");
    expect(result.attemptBinding?.resolvedEnv).toEqual({
      OPENAI_API_KEY: "sk-test_ready_secret_value",
    });
    expect(result.rejected).toContainEqual({
      credentialId: "rcred_missing",
      label: "Missing secret",
      reason: "missing_secret:env:RAVI_TEST_[redacted]",
    });
    expect(result.managedPoolConfigured).toBe(true);

    const serialized = serializeRuntimeCredentialAttemptBinding(result.attemptBinding!);
    expect(JSON.stringify(serialized)).not.toContain("sk-test_ready_secret_value");
    expect(JSON.stringify(serialized)).not.toContain("RAVI_TEST_READY_KEY");
    expect(serialized.attemptId?.startsWith("rcatt_")).toBe(true);
    expect(serialized.envKeys).toEqual(["OPENAI_API_[redacted]"]);
  });

  it("stores credential session metadata and rejects unsafe resume across credential boundaries", () => {
    const ready = {
      credentialId: "rcred_ready",
      label: "Ready secret",
      fingerprint: "sha256:ready",
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      sessionCompatibilityKey: "account-a",
      resolvedEnv: { OPENAI_API_KEY: "sk-test_ready_secret_value" },
      sensitiveEnvKeys: ["OPENAI_API_KEY"],
      remoteForwardEnvKeys: [],
      bindings: [],
    };

    const params = {
      runtimeCredential: {
        credentialId: "rcred_ready",
        fingerprint: "sha256:ready",
        runtimeProvider: "codex",
        upstreamProvider: "openai",
        sessionCompatibilityKey: "account-a",
      },
    };

    expect(isRuntimeCredentialSessionCompatible(params, ready)).toBe(true);
    expect(
      isRuntimeCredentialSessionCompatible(
        { ...params, runtimeCredential: { ...params.runtimeCredential, sessionCompatibilityKey: "account-b" } },
        ready,
      ),
    ).toBe(false);
    expect(isRuntimeCredentialSessionCompatible(undefined, ready)).toBe(false);
    expect(isRuntimeCredentialSessionCompatible(params, null)).toBe(false);
    expect(isRuntimeCredentialSessionCompatible(undefined, null)).toBe(true);
  });

  it("rejects an OAuth credential whose env secret is an API key and keeps the auth profile selectable", async () => {
    const apiKey = "sk-ant-api03-fake-not-a-real-key";
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    createRuntimeCredential({
      id: "rcred_bad_oauth",
      label: "wired-oauth",
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      authMethod: "claude-oauth",
      priority: 100,
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "CLAUDE_CODE_OAUTH_TOKEN",
          secretRef: "env:CLAUDE_CODE_OAUTH_TOKEN",
          sourceHint: "CLAUDE_CODE_OAUTH_TOKEN",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    createRuntimeCredential({
      id: "rcred_profile",
      label: "claude-profile",
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      authMethod: "claude-oauth",
      sourceKind: "provider-profile",
      authProfileRef: "~/.claude",
      priority: 10,
      bindings: [
        {
          sourceKind: "provider-profile",
          targetKind: "auth-profile",
          targetName: "profile",
          secretRef: "file:~/.claude",
          sourceHint: "~/.claude",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });

    const result = await resolveRuntimeCredentialAttemptBinding({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      env: { CLAUDE_CODE_OAUTH_TOKEN: apiKey },
    });

    expect(result.selected?.id).toBe("rcred_profile");
    expect(result.attemptBinding?.resolvedEnv).toEqual({});
    expect(result.attemptBinding?.authProfileRef).toBe("~/.claude");
    const rejected = result.rejected.find((item) => item.credentialId === "rcred_bad_oauth");
    expect(rejected?.label).toBe("wired-oauth");
    expect(rejected?.reason).toContain('Credential "wired-oauth" (claude-oauth)');
    expect(rejected?.reason).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.stringify(result.rejected)).not.toContain(apiKey);
    expect(getRuntimeCredential("rcred_bad_oauth")?.status).toBe("invalid");
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  });

  it("reports configured managed pools even when no credential can resolve secrets", async () => {
    createRuntimeCredential({
      id: "rcred_missing_only",
      label: "Missing only",
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "OPENAI_API_KEY",
          secretRef: "env:RAVI_TEST_MISSING_ONLY_KEY",
          sourceHint: "RAVI_TEST_MISSING_ONLY_KEY",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });

    const result = await resolveRuntimeCredentialAttemptBinding({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      env: {},
    });

    expect(result.managedPoolConfigured).toBe(true);
    expect(result.attemptBinding).toBeNull();
    expect(result.rejected).toContainEqual({
      credentialId: "rcred_missing_only",
      label: "Missing only",
      reason: "missing_secret:env:RAVI_TEST_[redacted]",
    });
  });

  it("refuses to treat locally stored model-broker metadata as authority", async () => {
    expect(() =>
      createRuntimeCredential({
        id: "conn_local",
        label: "Local broker metadata",
        runtimeProvider: "codex",
        upstreamProvider: "openai",
        authMethod: "model-broker",
        sourceKind: "helper",
        bindings: [],
      }),
    ).toThrow("must be leased by a registered broker");
  });

  it("rejects local model-broker rows even when they carry an authProfileRef", async () => {
    const credential = createRuntimeCredential({
      id: "conn_legacy",
      label: "Legacy local row",
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "OPENAI_API_KEY",
          secretRef: "env:RAVI_TEST_LEGACY_KEY",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    getDb()
      .prepare("UPDATE runtime_credentials SET auth_method = 'model-broker', auth_profile_ref = ? WHERE id = ?")
      .run("/tmp/must-never-load", credential.id);
    const result = await resolveRuntimeCredentialAttemptBinding({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      env: { RAVI_TEST_LEGACY_KEY: "must-not-be-read" },
    });
    expect(result.attemptBinding).toBeNull();
    expect(result.rejected).toContainEqual({
      credentialId: "conn_legacy",
      label: "Legacy local row",
      reason: "model_broker_requires_route_lease",
    });
  });

  it("reserves an active attempt so the next equivalent selection uses a free slot", async () => {
    createRuntimeCredential({
      id: "rcred_a",
      label: "A",
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      priority: 10,
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "OPENAI_API_KEY",
          secretRef: "env:RAVI_TEST_A_KEY",
          sourceHint: "RAVI_TEST_A_KEY",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    createRuntimeCredential({
      id: "rcred_b",
      label: "B",
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      priority: 10,
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "OPENAI_API_KEY",
          secretRef: "env:RAVI_TEST_B_KEY",
          sourceHint: "RAVI_TEST_B_KEY",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });

    const env = {
      RAVI_TEST_A_KEY: "sk-test_a",
      RAVI_TEST_B_KEY: "sk-test_b",
    };

    const first = await resolveRuntimeCredentialAttemptBinding({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      env,
      sessionKey: "agent:dev:one",
      sessionName: "one",
      runId: "run-one",
    });
    const second = await resolveRuntimeCredentialAttemptBinding({
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      env,
      sessionKey: "agent:dev:two",
      sessionName: "two",
      runId: "run-two",
    });

    expect(first.attemptBinding?.credentialId).toBe("rcred_a");
    expect(second.attemptBinding?.credentialId).toBe("rcred_b");
    expect(first.attemptBinding?.attemptId?.startsWith("rcatt_")).toBe(true);
    expect(second.attemptBinding?.attemptId?.startsWith("rcatt_")).toBe(true);

    const activeRows = getDb()
      .prepare("SELECT credential_id, status FROM runtime_credential_attempts ORDER BY credential_id ASC")
      .all() as Array<{ credential_id: string; status: string }>;
    expect(activeRows).toEqual([
      { credential_id: "rcred_a", status: "reserved" },
      { credential_id: "rcred_b", status: "reserved" },
    ]);
  });
});
