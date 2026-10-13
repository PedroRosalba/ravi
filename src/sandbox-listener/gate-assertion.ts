// Gate request assertion verifier (Console `sandbox-gateway/gate` SPEC §Gate
// Request Assertion, `listener` SPEC §Request Checks step 5). The assertion
// is the Gate's proof that it admitted this exact request for this
// installation: every claim is bound to the received request and to the
// grant stored in the local run record. Results never echo the token.

import { createHash } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";
import {
  commandIdFromSegments,
  installationAudience,
  runSubject,
  SANDBOX_GATE_ALG,
  SANDBOX_GATE_ASSERTION_MAX_LIFETIME_SECONDS,
  SANDBOX_GATE_ISSUER,
  SANDBOX_GATE_KID_RE,
  SANDBOX_GATE_TYP,
  SANDBOX_GRANT_CLOCK_SKEW_SECONDS,
  SANDBOX_GRANT_JTI_RE,
} from "./contract.js";
import {
  COMPACT_JWS_RE,
  type CommonRejectReason,
  isUnixSeconds,
  type KeyResolver,
  mapJoseError,
  nowSeconds,
  toGetKey,
} from "./key-resolver.js";

export const SANDBOX_LISTENER_PATH_PREFIX = "/api/v1/";

/** base64url SHA-256 of exact bytes, the form used by `bodySha256` and `grantSha256`. */
export function sha256Base64url(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/**
 * `/api/v1/<seg…>` → command id, on the raw pathname. Encoded characters,
 * `..`, `//`, uppercase, `_`-prefixed segments and queries never resolve.
 */
export function commandIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(SANDBOX_LISTENER_PATH_PREFIX)) return null;
  const rest = pathname.slice(SANDBOX_LISTENER_PATH_PREFIX.length);
  if (rest.length === 0 || rest.endsWith("/") || /[%?#]/.test(rest)) return null;
  return commandIdFromSegments(rest.split("/"));
}

export type GateAssertionRejectReason =
  | CommonRejectReason
  | "request_method_invalid"
  | "request_path_invalid"
  | "request_id_invalid"
  | "subject_mismatch"
  | "jti_invalid"
  | "jti_mismatch"
  | "jti_replayed"
  | "cmd_mismatch"
  | "body_hash_mismatch"
  | "grant_hash_mismatch"
  | "lifetime_exceeded"
  | "issued_before_start";

export type GateAssertionClaims = {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  cmd: string;
  bodySha256: string;
  grantSha256: string;
  iat: number;
  exp: number;
};

/** Single-use `jti` memory: each id is kept until its `exp` + 60 s. */
export class GateAssertionReplayCache {
  private readonly seen = new Map<string, number>();

  has(jti: string, nowSeconds: number) {
    this.prune(nowSeconds);
    return this.seen.has(jti);
  }

  remember(jti: string, expSeconds: number, nowSeconds: number) {
    this.prune(nowSeconds);
    this.seen.set(jti, expSeconds + SANDBOX_GRANT_CLOCK_SKEW_SECONDS);
  }

  get size() {
    return this.seen.size;
  }

  private prune(nowSeconds: number) {
    for (const [jti, keepUntil] of this.seen) if (keepUntil < nowSeconds) this.seen.delete(jti);
  }
}

export type VerifyGateAssertionOptions = {
  /** `JwksCache` for `<consoleIssuer>/api/public/sandbox/gate-jwks`, or any jose key resolver. */
  jwks: KeyResolver;
  /** This daemon's installation. */
  installationId: string;
  /** The run record the request names (from the assertion `sub`, looked up by the listener) and its stored grant. */
  runId: string;
  grant: string;
  /** The received request, as seen by the listener. */
  request: { method: string; path: string; body: Uint8Array | string; requestId: string | null | undefined };
  /** Unix seconds the listener started; assertions issued before it are refused. */
  listenerStartedAt?: number;
  replayCache?: GateAssertionReplayCache;
  now?: Date;
};

export type GateAssertionVerifyResult =
  | { ok: true; claims: GateAssertionClaims; kid: string }
  | { ok: false; reason: GateAssertionRejectReason };

export async function verifyGateAssertion(
  token: unknown,
  options: VerifyGateAssertionOptions,
): Promise<GateAssertionVerifyResult> {
  const { request } = options;
  if (request.method !== "POST") return reject("request_method_invalid");
  const cmd = commandIdFromPath(request.path);
  if (!cmd) return reject("request_path_invalid");
  if (typeof request.requestId !== "string" || !SANDBOX_GRANT_JTI_RE.test(request.requestId)) {
    return reject("request_id_invalid");
  }

  if (typeof token !== "string" || !COMPACT_JWS_RE.test(token)) return reject("token_malformed");
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return reject("token_malformed");
  }
  if (header.alg !== SANDBOX_GATE_ALG) return reject("alg_not_allowed");
  if (header.typ !== SANDBOX_GATE_TYP) return reject("typ_mismatch");
  if (typeof header.kid !== "string" || !SANDBOX_GATE_KID_RE.test(header.kid)) return reject("kid_invalid");
  if ("crit" in header && header.crit !== undefined) return reject("crit_not_allowed");

  const { now, seconds } = nowSeconds(options.now);
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, toGetKey(options.jwks), {
      algorithms: [SANDBOX_GATE_ALG],
      typ: SANDBOX_GATE_TYP,
      currentDate: now,
      clockTolerance: SANDBOX_GRANT_CLOCK_SKEW_SECONDS,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    return reject(mapJoseError(error));
  }

  if (payload.iss !== SANDBOX_GATE_ISSUER) return reject("issuer_mismatch");
  if (payload.aud !== installationAudience(options.installationId)) return reject("audience_mismatch");
  if (payload.sub !== runSubject(options.runId)) return reject("subject_mismatch");
  if (typeof payload.jti !== "string" || !SANDBOX_GRANT_JTI_RE.test(payload.jti)) return reject("jti_invalid");
  if (payload.jti !== request.requestId) return reject("jti_mismatch");
  if (payload.cmd !== cmd) return reject("cmd_mismatch");
  if (payload.bodySha256 !== sha256Base64url(request.body)) return reject("body_hash_mismatch");
  if (payload.grantSha256 !== sha256Base64url(options.grant)) return reject("grant_hash_mismatch");

  const { iat, exp } = payload;
  if (!isUnixSeconds(iat) || !isUnixSeconds(exp) || exp <= iat) return reject("timestamps_invalid");
  if (iat > seconds + SANDBOX_GRANT_CLOCK_SKEW_SECONDS) return reject("timestamps_invalid");
  if (exp - iat > SANDBOX_GATE_ASSERTION_MAX_LIFETIME_SECONDS) return reject("lifetime_exceeded");
  if (exp <= seconds - SANDBOX_GRANT_CLOCK_SKEW_SECONDS) return reject("expired");
  if (options.listenerStartedAt !== undefined && iat < options.listenerStartedAt - SANDBOX_GRANT_CLOCK_SKEW_SECONDS) {
    return reject("issued_before_start");
  }
  if (options.replayCache) {
    if (options.replayCache.has(payload.jti, seconds)) return reject("jti_replayed");
    options.replayCache.remember(payload.jti, exp, seconds);
  }

  return {
    ok: true,
    kid: header.kid,
    claims: {
      iss: SANDBOX_GATE_ISSUER,
      aud: payload.aud as string,
      sub: payload.sub as string,
      jti: payload.jti,
      cmd,
      bodySha256: payload.bodySha256 as string,
      grantSha256: payload.grantSha256 as string,
      iat,
      exp,
    },
  };
}

function reject(reason: GateAssertionRejectReason): GateAssertionVerifyResult {
  return { ok: false, reason };
}
