// Gate request assertion binding (Console `sandbox-gateway/gate` SPEC §Gate
// Request Assertion; `listener` SPEC §Request Checks step 5).

import { beforeAll, describe, expect, test } from "bun:test";
import {
  createSigner,
  GATE_HEADER,
  gateAssertionClaims,
  GRANT_HEADER,
  grantClaims,
  signCompact,
  T,
  TEST_INSTALLATION_A,
  TEST_INSTALLATION_B,
  TEST_NOW,
  TEST_REQUEST,
  TEST_REQUEST_ID,
  TEST_RUN_ID,
  type TestSigner,
} from "../test/sandbox-grant-tokens.js";
import { installationAudience, runSubject } from "./contract.js";
import {
  commandIdFromPath,
  GateAssertionReplayCache,
  sha256Base64url,
  verifyGateAssertion,
  type VerifyGateAssertionOptions,
} from "./gate-assertion.js";

describe("verifyGateAssertion", () => {
  let gate: TestSigner;
  let grantIssuer: TestSigner;
  let grant: string;
  let good: string;

  const opts = (patch: Partial<VerifyGateAssertionOptions> = {}): VerifyGateAssertionOptions => ({
    jwks: gate.keySet,
    installationId: TEST_INSTALLATION_A,
    runId: TEST_RUN_ID,
    grant,
    request: { ...TEST_REQUEST, requestId: TEST_REQUEST_ID },
    now: TEST_NOW,
    ...patch,
  });
  const forge = (overrides: Record<string, unknown> = {}, header: Record<string, unknown> = GATE_HEADER) =>
    signCompact(header, gateAssertionClaims(grant, overrides), gate.privateKey);
  const reasonOf = async (token: unknown, patch: Partial<VerifyGateAssertionOptions> = {}) => {
    const result = await verifyGateAssertion(token, opts(patch));
    return result.ok ? "ok" : result.reason;
  };

  beforeAll(async () => {
    gate = await createSigner("ES256", "sandbox-gate-1");
    grantIssuer = await createSigner("ES256", "sandbox-grant-1");
    grant = await signCompact(GRANT_HEADER, grantClaims(), grantIssuer.privateKey);
    good = await forge();
  });

  test("accepts an assertion bound to this exact request, run and grant", async () => {
    const result = await verifyGateAssertion(good, opts());
    expect(result).toMatchObject({ ok: true, kid: "sandbox-gate-1" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.claims).toEqual({
      iss: "https://gw.ravi.bot",
      aud: installationAudience(TEST_INSTALLATION_A),
      sub: runSubject(TEST_RUN_ID),
      jti: TEST_REQUEST_ID,
      cmd: "tasks.report",
      bodySha256: sha256Base64url(TEST_REQUEST.body),
      grantSha256: sha256Base64url(grant),
      iat: T,
      exp: T + 30,
    });
    // Body bytes and body text hash the same.
    expect(
      await reasonOf(good, {
        request: { ...TEST_REQUEST, body: new TextEncoder().encode(TEST_REQUEST.body), requestId: TEST_REQUEST_ID },
      }),
    ).toBe("ok");
  });

  test("commandIdFromPath follows the §Identifiers grammar", () => {
    expect(commandIdFromPath("/api/v1/tasks/report")).toBe("tasks.report");
    expect(commandIdFromPath("/api/v1/a/b/c/d/e/f/g/h")).toBe("a.b.c.d.e.f.g.h");
    for (const path of [
      "/api/v1/tasks",
      "/api/v1/tasks/_stream",
      "/api/v1/_meta/registry",
      "/api/v1/tasks//report",
      "/api/v1/tasks/report/",
      "/api/v1/../tasks/report",
      "/api/v1/tasks/%72eport",
      "/api/v1/Tasks/report",
      "/api/v1/tasks/report?x=1",
      "/api/v2/tasks/report",
      "/healthz",
      "/api/v1/a/b/c/d/e/f/g/h/i",
    ]) {
      expect(commandIdFromPath(path)).toBeNull();
    }
  });

  describe("request binding", () => {
    test("method and path", async () => {
      expect(await reasonOf(good, { request: { ...TEST_REQUEST, method: "GET", requestId: TEST_REQUEST_ID } })).toBe(
        "request_method_invalid",
      );
      expect(
        await reasonOf(good, {
          request: { ...TEST_REQUEST, path: "/api/v1/tasks/_stream", requestId: TEST_REQUEST_ID },
        }),
      ).toBe("request_path_invalid");
      // A valid path for another command does not match the `cmd` claim.
      expect(
        await reasonOf(good, { request: { ...TEST_REQUEST, path: "/api/v1/tasks/done", requestId: TEST_REQUEST_ID } }),
      ).toBe("cmd_mismatch");
      expect(await reasonOf(await forge({ cmd: "tasks.done" }))).toBe("cmd_mismatch");
    });

    test("body hash", async () => {
      expect(
        await reasonOf(good, {
          request: { ...TEST_REQUEST, body: `${TEST_REQUEST.body} `, requestId: TEST_REQUEST_ID },
        }),
      ).toBe("body_hash_mismatch");
      expect(await reasonOf(await forge({ bodySha256: sha256Base64url("{}") }))).toBe("body_hash_mismatch");
      expect(await reasonOf(await forge({ bodySha256: undefined }))).toBe("body_hash_mismatch");
    });

    test("jti equals X-Ravi-Request-Id and is a UUID", async () => {
      const other = "9b2b7a2e-2c7d-4b1a-8d5e-1f2a3b4c5d6e";
      expect(await reasonOf(good, { request: { ...TEST_REQUEST, requestId: other } })).toBe("jti_mismatch");
      expect(await reasonOf(good, { request: { ...TEST_REQUEST, requestId: null } })).toBe("request_id_invalid");
      expect(await reasonOf(good, { request: { ...TEST_REQUEST, requestId: "not-a-uuid" } })).toBe(
        "request_id_invalid",
      );
      expect(
        await reasonOf(await forge({ jti: "x" }), { request: { ...TEST_REQUEST, requestId: TEST_REQUEST_ID } }),
      ).toBe("jti_invalid");
    });

    test("run subject and stored grant hash", async () => {
      expect(await reasonOf(await forge({ sub: runSubject("sbr_zzzzzzzzzzzzzzzzzzzzzzzzzz") }))).toBe(
        "subject_mismatch",
      );
      expect(await reasonOf(good, { runId: "sbr_zzzzzzzzzzzzzzzzzzzzzzzzzz" })).toBe("subject_mismatch");
      const otherGrant = await signCompact(GRANT_HEADER, grantClaims({ task: "task-2" }), grantIssuer.privateKey);
      expect(await reasonOf(good, { grant: otherGrant })).toBe("grant_hash_mismatch");
      expect(await reasonOf(await forge({ grantSha256: sha256Base64url(otherGrant) }))).toBe("grant_hash_mismatch");
    });

    test("issuer and audience", async () => {
      expect(await reasonOf(await forge({ iss: "https://console.ravi.bot" }))).toBe("issuer_mismatch");
      expect(await reasonOf(await forge({ aud: installationAudience(TEST_INSTALLATION_B) }))).toBe("audience_mismatch");
      expect(await reasonOf(good, { installationId: TEST_INSTALLATION_B })).toBe("audience_mismatch");
      expect(await reasonOf(await forge({ aud: [installationAudience(TEST_INSTALLATION_A)] }))).toBe(
        "audience_mismatch",
      );
    });
  });

  describe("replay", () => {
    test("a jti is single use until exp + 60 s, then forgotten", async () => {
      const replayCache = new GateAssertionReplayCache();
      expect(await reasonOf(good, { replayCache })).toBe("ok");
      expect(await reasonOf(good, { replayCache })).toBe("jti_replayed");
      expect(await reasonOf(good, { replayCache, now: new Date((T + 89) * 1000) })).toBe("jti_replayed");
      expect(replayCache.size).toBe(1);
      // Past exp + 60 s the entry is pruned; the assertion itself is then expired anyway.
      expect(await reasonOf(good, { replayCache, now: new Date((T + 91) * 1000) })).toBe("expired");
      expect(replayCache.has(TEST_REQUEST_ID, T + 91)).toBe(false);
      expect(replayCache.size).toBe(0);
      // A rejected assertion is never remembered.
      expect(await reasonOf(await forge({ cmd: "tasks.done" }), { replayCache })).toBe("cmd_mismatch");
      expect(replayCache.size).toBe(0);
    });
  });

  describe("freshness", () => {
    const at = (seconds: number) => ({ now: new Date((T + seconds) * 1000) });

    test("exp ≤ iat + 60 with ±60 s skew", async () => {
      expect(await reasonOf(await forge({ exp: T + 60 }))).toBe("ok");
      expect(await reasonOf(await forge({ exp: T + 61 }))).toBe("lifetime_exceeded");
      expect(await reasonOf(good, at(89))).toBe("ok");
      expect(await reasonOf(good, at(90))).toBe("expired");
      expect(await reasonOf(await forge({ iat: T + 60, exp: T + 90 }))).toBe("ok");
      expect(await reasonOf(await forge({ iat: T + 61, exp: T + 91 }))).toBe("timestamps_invalid");
      expect(await reasonOf(await forge({ exp: T }))).toBe("timestamps_invalid");
      expect(await reasonOf(await forge({ iat: undefined }))).toBe("timestamps_invalid");
    });

    test("issued before the listener started is refused", async () => {
      expect(await reasonOf(good, { listenerStartedAt: T + 60 })).toBe("ok");
      expect(await reasonOf(good, { listenerStartedAt: T + 61 })).toBe("issued_before_start");
    });
  });

  describe("header and key family", () => {
    test("typ, alg, crit and kid family", async () => {
      expect(await reasonOf(await forge({}, { ...GATE_HEADER, typ: "ravi-sandbox-grant+jwt" }))).toBe("typ_mismatch");
      expect(await reasonOf(await forge({}, { ...GATE_HEADER, kid: "sandbox-grant-1" }))).toBe("kid_invalid");
      expect(await reasonOf(await forge({}, { ...GATE_HEADER, kid: "sandbox-gate-zzz" }))).toBe("key_unknown");
      expect(await reasonOf(await forge({}, { ...GATE_HEADER, crit: ["b64"], b64: true }))).toBe("crit_not_allowed");
      expect(await reasonOf(`${good.split(".")[0]}.${good.split(".")[1]}.`)).toBe("token_malformed");
      expect(await reasonOf(undefined)).toBe("token_malformed");
    });

    test("a grant key signing a gate kid, or the gate JWKS swapped for the grant JWKS, is refused", async () => {
      const crossSigned = await signCompact(GATE_HEADER, gateAssertionClaims(grant), grantIssuer.privateKey);
      expect(await reasonOf(crossSigned)).toBe("signature_invalid");
      expect(await reasonOf(good, { jwks: grantIssuer.keySet })).toBe("key_unknown");
      const outage = async () => {
        throw new TypeError("fetch failed");
      };
      expect(await reasonOf(good, { jwks: outage })).toBe("key_set_unavailable");
    });
  });
});
