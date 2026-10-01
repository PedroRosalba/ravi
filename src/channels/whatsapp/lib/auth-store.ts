/**
 * SQLite storage for the WhatsApp (Baileys) auth state.
 *
 * Backs `createStorageAuthState()` (auth.ts) with a table in ravi's router DB:
 *
 *   whatsapp_auth_state(instance_id, key, value, updated_at, PRIMARY KEY(instance_id, key))
 *
 * auth.ts addresses entries as `auth:<instanceId>:creds` and
 * `auth:<instanceId>:keys:<type>:<id>`; this store splits that into
 * `instance_id = <instanceId>` and `key = creds | keys:<type>:<id>`.
 *
 * Values are stored as text. auth.ts always writes strings produced by Baileys'
 * `BufferJSON.replacer`, and they are returned unchanged, so Buffers round-trip
 * exactly as with `useMultiFileAuthState`. A non-string value is encoded with the
 * same encoding before it is stored. The module has no runtime `baileys` import.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "../../../router/router-db.js";
import type { PluginStorage } from "./compat.js";

export const WHATSAPP_AUTH_STATE_TABLE = "whatsapp_auth_state" as const;

const AUTH_KEY_PREFIX = "auth:";
const CREDS_KEY = "creds";

type DatabaseProvider = () => Database;

const initializedDatabases = new WeakSet<Database>();

/** Create the auth table if it does not exist yet (once per database handle). */
export function ensureWhatsAppAuthStateSchema(db: Database = getDb()): void {
  if (initializedDatabases.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${WHATSAPP_AUTH_STATE_TABLE} (
      instance_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (instance_id, key)
    );
  `);
  initializedDatabases.add(db);
}

interface ParsedAuthKey {
  instanceId: string;
  key: string;
}

/** Split `auth:<instanceId>:<rest>` into its row coordinates. */
export function parseWhatsAppAuthKey(storageKey: string): ParsedAuthKey {
  if (!storageKey.startsWith(AUTH_KEY_PREFIX)) {
    throw new Error(`WhatsApp auth storage key must start with "${AUTH_KEY_PREFIX}": ${storageKey}`);
  }
  const rest = storageKey.slice(AUTH_KEY_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) {
    throw new Error(`WhatsApp auth storage key must look like auth:<instanceId>:<key>: ${storageKey}`);
  }
  return { instanceId: rest.slice(0, separator), key: rest.slice(separator + 1) };
}

function formatAuthKey(instanceId: string, key: string): string {
  return `${AUTH_KEY_PREFIX}${instanceId}:${key}`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** The instance id a glob pattern is pinned to, when its `auth:<id>:` prefix has no wildcard. */
function patternInstanceId(pattern: string): string | null {
  if (!pattern.startsWith(AUTH_KEY_PREFIX)) return null;
  const rest = pattern.slice(AUTH_KEY_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const instanceId = rest.slice(0, separator);
  return instanceId.includes("*") ? null : instanceId;
}

/**
 * Same encoding as Baileys' `BufferJSON.replacer`, inlined so this module stays
 * free of a runtime `baileys` import (driver health and CLI code can use it
 * without loading Baileys).
 */
function bufferJsonReplacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: "Buffer", data: Buffer.from(value).toString("base64") };
  }
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "Buffer") {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) return { type: "Buffer", data: Buffer.from(data as number[]).toString("base64") };
    if (typeof data === "string") return value;
  }
  return value;
}

function encodeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, bufferJsonReplacer);
}

export interface SqliteWhatsAppAuthStorageOptions {
  /** Database handle provider; defaults to ravi's router DB (`getDb()`), resolved per call. */
  db?: DatabaseProvider;
  now?: () => number;
}

/**
 * `PluginStorage` over the router DB. Calls are synchronous bun:sqlite statements
 * wrapped in promises; auth.ts already persists signal keys write-behind, so they
 * never block Baileys' key transaction.
 */
export class SqliteWhatsAppAuthStorage implements PluginStorage {
  private readonly dbProvider: DatabaseProvider;
  private readonly now: () => number;

  constructor(options: SqliteWhatsAppAuthStorageOptions = {}) {
    this.dbProvider = options.db ?? (() => getDb());
    this.now = options.now ?? Date.now;
  }

  private db(): Database {
    const db = this.dbProvider();
    ensureWhatsAppAuthStateSchema(db);
    return db;
  }

  /** Raw stored text for one entry, or null. */
  getText(instanceId: string, key: string): string | null {
    const row = this.db()
      .prepare(`SELECT value FROM ${WHATSAPP_AUTH_STATE_TABLE} WHERE instance_id = ? AND key = ?`)
      .get(instanceId, key) as { value: string } | null;
    return row?.value ?? null;
  }

  async get<T>(storageKey: string): Promise<T | null> {
    const { instanceId, key } = parseWhatsAppAuthKey(storageKey);
    return this.getText(instanceId, key) as T | null;
  }

  async set<T>(storageKey: string, value: T, _ttlMs?: number): Promise<void> {
    const { instanceId, key } = parseWhatsAppAuthKey(storageKey);
    this.db()
      .prepare(
        `INSERT INTO ${WHATSAPP_AUTH_STATE_TABLE} (instance_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(instanceId, key, encodeValue(value), this.now());
  }

  async delete(storageKey: string): Promise<boolean> {
    const { instanceId, key } = parseWhatsAppAuthKey(storageKey);
    const result = this.db()
      .prepare(`DELETE FROM ${WHATSAPP_AUTH_STATE_TABLE} WHERE instance_id = ? AND key = ?`)
      .run(instanceId, key);
    return result.changes > 0;
  }

  async has(storageKey: string): Promise<boolean> {
    const { instanceId, key } = parseWhatsAppAuthKey(storageKey);
    return this.getText(instanceId, key) !== null;
  }

  async keys(pattern = "*"): Promise<string[]> {
    const instanceId = patternInstanceId(pattern);
    const rows = (
      instanceId === null
        ? this.db().prepare(`SELECT instance_id, key FROM ${WHATSAPP_AUTH_STATE_TABLE}`).all()
        : this.db()
            .prepare(`SELECT instance_id, key FROM ${WHATSAPP_AUTH_STATE_TABLE} WHERE instance_id = ?`)
            .all(instanceId)
    ) as Array<{ instance_id: string; key: string }>;
    const matcher = globToRegExp(pattern);
    return rows.map((row) => formatAuthKey(row.instance_id, row.key)).filter((key) => matcher.test(key));
  }

  /** Delete every auth row (creds and signal keys) of one instance. Returns the row count. */
  clear(instanceId: string): number {
    return this.db().prepare(`DELETE FROM ${WHATSAPP_AUTH_STATE_TABLE} WHERE instance_id = ?`).run(instanceId).changes;
  }

  /** True when the instance has stored creds that completed pairing (`creds.me.id` is set). */
  hasRegisteredCreds(instanceId: string): boolean {
    const text = this.getText(instanceId, CREDS_KEY);
    if (!text) return false;
    try {
      const creds = JSON.parse(text) as { me?: { id?: unknown } | null };
      return typeof creds.me?.id === "string" && creds.me.id.length > 0;
    } catch {
      return false;
    }
  }
}

/** Shared default store over the router DB. */
export function createWhatsAppAuthStorage(options?: SqliteWhatsAppAuthStorageOptions): SqliteWhatsAppAuthStorage {
  return new SqliteWhatsAppAuthStorage(options);
}

/** Delete all persisted auth state of one instance from the router DB. */
export function clearWhatsAppAuthState(instanceId: string): number {
  return new SqliteWhatsAppAuthStorage().clear(instanceId);
}

/** True when the instance has paired creds in the router DB. */
export function hasWhatsAppAuthCreds(instanceId: string): boolean {
  return new SqliteWhatsAppAuthStorage().hasRegisteredCreds(instanceId);
}
