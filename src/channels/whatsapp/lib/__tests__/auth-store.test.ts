import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../../../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../../../test/ravi-state.js";
import { loadBaileys } from "../../baileys-loader.js";
import { clearAuthState, clearSenderKeys, createStorageAuthState } from "../auth.js";
import {
  SqliteWhatsAppAuthStorage,
  WHATSAPP_AUTH_STATE_TABLE,
  clearWhatsAppAuthState,
  hasWhatsAppAuthCreds,
  parseWhatsAppAuthKey,
} from "../auth-store.js";

const { BufferJSON, initAuthCreds, proto } = await loadBaileys();

const INSTANCE = "5f0c1d2e-0000-4000-8000-000000000001";
const OTHER_INSTANCE = "5f0c1d2e-0000-4000-8000-000000000002";

/** Let auth.ts' fire-and-forget background persists settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-whatsapp-auth-store-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("parseWhatsAppAuthKey", () => {
  it("splits auth:<instanceId>:<key> on the first separator after the instance", () => {
    expect(parseWhatsAppAuthKey(`auth:${INSTANCE}:creds`)).toEqual({ instanceId: INSTANCE, key: "creds" });
    expect(parseWhatsAppAuthKey(`auth:${INSTANCE}:keys:sender-key:group@g.us::123@lid::0`)).toEqual({
      instanceId: INSTANCE,
      key: "keys:sender-key:group@g.us::123@lid::0",
    });
  });

  it("rejects keys outside the auth namespace", () => {
    expect(() => parseWhatsAppAuthKey("creds")).toThrow();
    expect(() => parseWhatsAppAuthKey("auth:only-instance")).toThrow();
    expect(() => parseWhatsAppAuthKey(`auth:${INSTANCE}:`)).toThrow();
  });
});

describe("SqliteWhatsAppAuthStorage", () => {
  it("lazily creates whatsapp_auth_state with the (instance_id, key) primary key", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    await storage.set(`auth:${INSTANCE}:creds`, "{}");

    const columns = getDb().prepare(`PRAGMA table_info(${WHATSAPP_AUTH_STATE_TABLE})`).all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(columns.map((column) => column.name)).toEqual(["instance_id", "key", "value", "updated_at"]);
    expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual(["instance_id", "key"]);
  });

  it("stores rows per instance and returns the stored text unchanged", async () => {
    const storage = new SqliteWhatsAppAuthStorage({ now: () => 1234 });
    const text = JSON.stringify({ a: Buffer.from([1, 2, 3]) }, BufferJSON.replacer);
    await storage.set(`auth:${INSTANCE}:keys:pre-key:1`, text);

    expect(await storage.get<string>(`auth:${INSTANCE}:keys:pre-key:1`)).toBe(text);
    expect(await storage.get<string>(`auth:${OTHER_INSTANCE}:keys:pre-key:1`)).toBeNull();
    expect(await storage.has(`auth:${INSTANCE}:keys:pre-key:1`)).toBe(true);

    const row = getDb().prepare(`SELECT instance_id, key, updated_at FROM ${WHATSAPP_AUTH_STATE_TABLE}`).get() as {
      instance_id: string;
      key: string;
      updated_at: number;
    };
    expect(row).toEqual({ instance_id: INSTANCE, key: "keys:pre-key:1", updated_at: 1234 });
  });

  it("upserts on set and reports whether delete removed a row", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    await storage.set(`auth:${INSTANCE}:creds`, "one");
    await storage.set(`auth:${INSTANCE}:creds`, "two");
    expect(await storage.get<string>(`auth:${INSTANCE}:creds`)).toBe("two");

    expect(await storage.delete(`auth:${INSTANCE}:creds`)).toBe(true);
    expect(await storage.delete(`auth:${INSTANCE}:creds`)).toBe(false);
    expect(await storage.get(`auth:${INSTANCE}:creds`)).toBeNull();
  });

  it("encodes non-string values with BufferJSON", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    await storage.set(`auth:${INSTANCE}:keys:session:x`, { key: Buffer.from("hello") });
    const text = await storage.get<string>(`auth:${INSTANCE}:keys:session:x`);
    expect(JSON.parse(text ?? "null", BufferJSON.reviver)).toEqual({ key: Buffer.from("hello") });
  });

  it("encodes Buffers and Uint8Arrays byte-for-byte like Baileys BufferJSON.replacer", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    const value = { a: Buffer.from([0, 255, 7]), b: new Uint8Array([1, 2]), nested: { c: [Buffer.from("x")] }, n: 1 };
    await storage.set(`auth:${INSTANCE}:keys:session:y`, value);
    expect(await storage.get<string>(`auth:${INSTANCE}:keys:session:y`)).toBe(
      JSON.stringify(value, BufferJSON.replacer),
    );
  });

  it("lists keys by glob, scoped to the instance in the pattern", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    await storage.set(`auth:${INSTANCE}:creds`, "c");
    await storage.set(`auth:${INSTANCE}:keys:sender-key:g1`, "s1");
    await storage.set(`auth:${INSTANCE}:keys:sender-key-memory:g1`, "m1");
    await storage.set(`auth:${INSTANCE}:keys:pre-key:1`, "p1");
    await storage.set(`auth:${OTHER_INSTANCE}:keys:sender-key:g1`, "other");

    expect((await storage.keys(`auth:${INSTANCE}:keys:*`)).sort()).toEqual([
      `auth:${INSTANCE}:keys:pre-key:1`,
      `auth:${INSTANCE}:keys:sender-key-memory:g1`,
      `auth:${INSTANCE}:keys:sender-key:g1`,
    ]);
    expect((await storage.keys(`auth:${INSTANCE}:keys:sender-key*`)).sort()).toEqual([
      `auth:${INSTANCE}:keys:sender-key-memory:g1`,
      `auth:${INSTANCE}:keys:sender-key:g1`,
    ]);
    expect((await storage.keys("auth:*:keys:sender-key:g1")).sort()).toEqual([
      `auth:${INSTANCE}:keys:sender-key:g1`,
      `auth:${OTHER_INSTANCE}:keys:sender-key:g1`,
    ]);
    expect(await storage.keys()).toHaveLength(5);
  });

  it("clear(instanceId) removes only that instance", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    await storage.set(`auth:${INSTANCE}:creds`, "c");
    await storage.set(`auth:${INSTANCE}:keys:pre-key:1`, "p1");
    await storage.set(`auth:${OTHER_INSTANCE}:creds`, "other");

    expect(storage.clear(INSTANCE)).toBe(2);
    expect(await storage.keys(`auth:${INSTANCE}:*`)).toEqual([]);
    expect(await storage.get<string>(`auth:${OTHER_INSTANCE}:creds`)).toBe("other");
    expect(clearWhatsAppAuthState(OTHER_INSTANCE)).toBe(1);
  });
});

describe("createStorageAuthState over SQLite", () => {
  it("round-trips creds through BufferJSON exactly", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    const first = await createStorageAuthState(storage, INSTANCE);
    first.state.creds.me = { id: "5511999990000:12@s.whatsapp.net", name: "Ravi" };
    first.state.creds.registered = true;
    await first.saveCreds();

    const stored = await storage.get<string>(`auth:${INSTANCE}:creds`);
    expect(stored).toBe(JSON.stringify(first.state.creds, BufferJSON.replacer));

    const second = await createStorageAuthState(storage, INSTANCE);
    expect(second.state.creds).toEqual(first.state.creds);
    expect(Buffer.isBuffer(second.state.creds.noiseKey.private)).toBe(true);
    expect(Buffer.compare(second.state.creds.noiseKey.private, first.state.creds.noiseKey.private)).toBe(0);
    expect(Buffer.compare(second.state.creds.signedPreKey.signature, first.state.creds.signedPreKey.signature)).toBe(0);
  });

  it("starts from fresh creds when nothing is stored", async () => {
    const { state } = await createStorageAuthState(new SqliteWhatsAppAuthStorage(), INSTANCE);
    const fresh = initAuthCreds();
    expect(Object.keys(state.creds).sort()).toEqual(Object.keys(fresh).sort());
    expect(state.creds.me).toBeUndefined();
  });

  it("persists signal keys write-behind and reads them back after a restart", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    const first = await createStorageAuthState(storage, INSTANCE);
    const preKey = { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) };
    await first.state.keys.set({ "pre-key": { "7": preKey } });
    await settle();

    const second = await createStorageAuthState(storage, INSTANCE);
    const read = await second.state.keys.get("pre-key", ["7", "8"]);
    expect(read["7"]).toEqual(preKey);
    expect(Buffer.isBuffer(read["7"]?.public)).toBe(true);
    expect(read["8"]).toBeUndefined();

    await second.state.keys.set({ "pre-key": { "7": null } });
    await settle();
    expect(await storage.get(`auth:${INSTANCE}:keys:pre-key:7`)).toBeNull();
  });

  it("revives app-state-sync-key values as protobuf messages (useMultiFileAuthState parity)", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    const first = await createStorageAuthState(storage, INSTANCE);
    const keyData = proto.Message.AppStateSyncKeyData.fromObject({
      keyData: Buffer.from([9, 9, 9]),
      timestamp: 1_700_000_000,
    });
    await first.state.keys.set({ "app-state-sync-key": { AAAA: keyData } });
    await settle();

    const second = await createStorageAuthState(storage, INSTANCE);
    const read = await second.state.keys.get("app-state-sync-key", ["AAAA"]);
    const revived = read.AAAA;
    expect(revived).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect(Buffer.from(revived?.keyData ?? new Uint8Array())).toEqual(Buffer.from([9, 9, 9]));
  });

  it("clearAuthState and clearSenderKeys work through the SQLite key listing", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    const { state, saveCreds } = await createStorageAuthState(storage, INSTANCE);
    await saveCreds();
    await state.keys.set({
      "sender-key": { "group@g.us::123@lid::0": Buffer.from([1]) },
      "pre-key": { "1": { public: Buffer.from([1]), private: Buffer.from([2]) } },
    });
    await settle();

    expect(await clearSenderKeys(storage, INSTANCE)).toBe(1);
    expect(await storage.keys(`auth:${INSTANCE}:keys:sender-key*`)).toEqual([]);

    await clearAuthState(storage, INSTANCE);
    expect(await storage.keys(`auth:${INSTANCE}:*`)).toEqual([]);
  });

  it("hasRegisteredCreds is true only once creds.me.id is set", async () => {
    const storage = new SqliteWhatsAppAuthStorage();
    expect(hasWhatsAppAuthCreds(INSTANCE)).toBe(false);

    const { state, saveCreds } = await createStorageAuthState(storage, INSTANCE);
    await saveCreds();
    expect(storage.hasRegisteredCreds(INSTANCE)).toBe(false);

    state.creds.me = { id: "5511999990000:3@s.whatsapp.net" };
    await saveCreds();
    expect(hasWhatsAppAuthCreds(INSTANCE)).toBe(true);
    expect(hasWhatsAppAuthCreds(OTHER_INSTANCE)).toBe(false);
  });
});
