/**
 * Generic JWKS cache for the sandbox listener verifiers (Console grant JWKS,
 * Console gate JWKS, Cloudflare Access certs).
 *
 * Rules (Console `sandbox-gateway/grants` SPEC §Keys And JWKS, §Verification;
 * OSS `.ravi/specs/sandbox/grant-verify`): keep the last set fetched
 * successfully and refresh it when older than 300 s; on an unknown `kid`
 * refetch at most once per 30 s; time out each fetch after 5 s; refuse bodies
 * over 64 KiB and any redirect; when a refresh fails keep the last good set
 * for at most 3600 s after its fetch, then fail closed. jose's
 * `createRemoteJWKSet` drops its set on a failed reload, so the cached set is
 * fed to `createLocalJWKSet` instead. An optional 0600 file persists
 * `{fetchedAt, keys}` so a daemon restart during a Console outage still
 * verifies inside the stale window; a cold start with nothing fails closed.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createLocalJWKSet,
  errors as joseErrors,
  type FlattenedJWSInput,
  type JSONWebKeySet,
  type JWSHeaderParameters,
} from "jose";

export const JWKS_REFRESH_AFTER_MS = 300_000;
export const JWKS_STALE_IF_ERROR_MS = 3_600_000;
export const JWKS_UNKNOWN_KID_COOLDOWN_MS = 30_000;
export const JWKS_FETCH_TIMEOUT_MS = 5_000;
export const JWKS_MAX_BYTES = 64 * 1024;

export type JwksFetch = (url: string, init?: RequestInit) => Promise<Response>;
type LocalKeySet = ReturnType<typeof createLocalJWKSet>;

/** No usable key set (cold start, stale window over, or a failed unknown-kid refetch): answer 503, never 401. */
export class JwksUnavailableError extends Error {
  constructor(message = "JWKS is unavailable.") {
    super(message);
    this.name = "JwksUnavailableError";
  }
}

export interface JwksCacheOptions {
  url: string;
  fetch?: JwksFetch;
  now?: () => number;
  refreshAfterMs?: number;
  staleIfErrorMs?: number;
  unknownKidCooldownMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Path of the 0600 `{fetchedAt, keys}` file. Loaded lazily on first use; a file that is not mode 0600 is ignored. */
  persistPath?: string;
}

export class JwksCache {
  readonly url: string;
  private readonly fetchImpl: JwksFetch;
  private readonly now: () => number;
  private readonly refreshAfterMs: number;
  private readonly staleIfErrorMs: number;
  private readonly unknownKidCooldownMs: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly persistPath: string | undefined;
  private keySet: LocalKeySet | null = null;
  private fetchedAt = 0;
  private loadedPersisted = false;
  private lastFailedRefreshAt: number | null = null;
  private lastUnknownKidRefetchAt: number | null = null;
  private inflight: Promise<void> | null = null;

  constructor(options: JwksCacheOptions) {
    if (!/^https:\/\//.test(options.url)) throw new Error("JWKS url must be https.");
    this.url = options.url;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.refreshAfterMs = options.refreshAfterMs ?? JWKS_REFRESH_AFTER_MS;
    this.staleIfErrorMs = options.staleIfErrorMs ?? JWKS_STALE_IF_ERROR_MS;
    this.unknownKidCooldownMs = options.unknownKidCooldownMs ?? JWKS_UNKNOWN_KID_COOLDOWN_MS;
    this.timeoutMs = options.timeoutMs ?? JWKS_FETCH_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? JWKS_MAX_BYTES;
    this.persistPath = options.persistPath;
  }

  /** Diagnostics only: never exposes key material. */
  snapshot() {
    this.loadPersistedOnce();
    return { fetchedAt: this.fetchedAt || null, hasKeys: this.keySet !== null };
  }

  /**
   * Key resolver for `jwtVerify`. Throws `JwksUnavailableError` when no usable
   * set exists, and jose's `JWKSNoMatchingKey` for a token whose `kid` is not
   * on the (refetched) set.
   */
  readonly resolveKey = async (header: JWSHeaderParameters, token: FlattenedJWSInput): Promise<CryptoKey> => {
    const keySet = await this.usableKeySet();
    try {
      return await keySet(header, token);
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
      const now = this.now();
      if (this.lastUnknownKidRefetchAt !== null && now - this.lastUnknownKidRefetchAt < this.unknownKidCooldownMs) {
        throw error;
      }
      this.lastUnknownKidRefetchAt = now;
      try {
        await this.refresh();
      } catch {
        throw new JwksUnavailableError("JWKS refetch for an unknown key id failed.");
      }
      return (this.keySet ?? keySet)(header, token);
    }
  };

  private staleUsable(now: number) {
    return this.keySet !== null && now - this.fetchedAt <= this.staleIfErrorMs;
  }

  private async usableKeySet(): Promise<LocalKeySet> {
    this.loadPersistedOnce();
    const now = this.now();
    if (this.keySet && now - this.fetchedAt < this.refreshAfterMs) return this.keySet;
    // While a stale set is still usable, do not hammer a failing origin on
    // every request: one refresh attempt per cooldown window.
    if (
      this.staleUsable(now) &&
      this.lastFailedRefreshAt !== null &&
      now - this.lastFailedRefreshAt < this.unknownKidCooldownMs
    ) {
      return this.keySet!;
    }
    try {
      await this.refresh();
      return this.keySet!;
    } catch {
      this.lastFailedRefreshAt = this.now();
      if (this.staleUsable(this.now())) return this.keySet!;
      throw new JwksUnavailableError();
    }
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const current = (async () => {
      try {
        const jwks = await this.fetchJwks();
        this.keySet = createLocalJWKSet(jwks);
        this.fetchedAt = this.now();
        this.lastFailedRefreshAt = null;
        this.persist(jwks);
      } finally {
        this.inflight = null;
      }
    })();
    this.inflight = current;
    return current;
  }

  private async fetchJwks(): Promise<JSONWebKeySet> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status >= 300 && response.status < 400) throw new Error("JWKS fetch was redirected.");
      if (!response.ok) throw new Error(`JWKS fetch failed with HTTP ${response.status}.`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > this.maxBytes) throw new Error("JWKS response is too large.");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > this.maxBytes) throw new Error("JWKS response is too large.");
      return parseKeySet(JSON.parse(text));
    } finally {
      clearTimeout(timer);
    }
  }

  private persist(jwks: JSONWebKeySet) {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
      const tmp = `${this.persistPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fetchedAt: this.fetchedAt, keys: jwks.keys }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.persistPath);
    } catch {
      // Persistence is best effort; the in-memory set is authoritative.
    }
  }

  private loadPersistedOnce() {
    if (this.loadedPersisted) return;
    this.loadedPersisted = true;
    if (!this.persistPath || this.keySet) return;
    try {
      const stat = statSync(this.persistPath);
      if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) return;
      const raw = readFileSync(this.persistPath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > this.maxBytes) return;
      const parsed = JSON.parse(raw) as { fetchedAt?: unknown; keys?: unknown };
      const fetchedAt = parsed.fetchedAt;
      if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt <= 0) return;
      if (fetchedAt > this.now()) return;
      this.keySet = createLocalJWKSet(parseKeySet({ keys: parsed.keys }));
      this.fetchedAt = fetchedAt;
    } catch {
      // Unreadable or malformed cache: behave like a cold start.
    }
  }
}

function parseKeySet(parsed: unknown): JSONWebKeySet {
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || !keys.every((key) => key && typeof key === "object" && !Array.isArray(key))) {
    throw new Error("JWKS document has no keys array.");
  }
  // Public members only: a cache must never carry private key material.
  if (keys.some((key) => "d" in (key as object) || "p" in (key as object) || "k" in (key as object))) {
    throw new Error("JWKS document carries private key material.");
  }
  return { keys } as JSONWebKeySet;
}
