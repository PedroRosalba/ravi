import { afterEach, describe, expect, it } from "bun:test";
import { serve } from "bun";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECURITY_INTERACTIVE_MAX_LINE_BYTES, type SecurityCommandResult } from "../security/macos-keychain.js";
import {
  deleteSecret,
  readSecret,
  redactSecretRef,
  setKeychainCommandRunnerForTests,
  writeSecret,
} from "./backends.js";
import { explainCredentialPolicy, publicCredentialConnection } from "./broker.js";
import {
  closeCredentialsDb,
  getCredentialConnection,
  listCredentialConnections,
  upsertCredentialConnection,
  type CredentialStoreOptions,
} from "./store.js";

let stateDir: string | null = null;
let vaultServer: ReturnType<typeof serve> | null = null;
const originalVaultAddr = process.env.VAULT_ADDR;
const originalVaultToken = process.env.VAULT_TOKEN;

afterEach(() => {
  setKeychainCommandRunnerForTests();
  closeCredentialsDb();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
  vaultServer?.stop(true);
  vaultServer = null;
  restoreVaultEnv();
});

function tempOptions(): CredentialStoreOptions {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-credentials-"));
  return { dbPath: join(stateDir, "credentials.db") };
}

describe("credential broker", () => {
  it("stores only metadata and redacts public connection output", () => {
    const options = tempOptions();
    const record = upsertCredentialConnection(
      {
        provider: "slack",
        connection: "rbbt",
        label: "RBBT Slack",
        backend: "vault",
        secretRef: "vault:secret/ravi/credentials/slack/rbbt#token",
        scopes: ["chat:write"],
        status: "active",
      },
      options,
    );

    const listed = listCredentialConnections({}, options);
    expect(listed.total).toBe(1);
    expect(JSON.stringify(listed)).not.toContain("xoxb");

    const publicRecord = publicCredentialConnection(record);
    expect(publicRecord.secretRef).toBe("vault:secret/ravi/credentials/slack/rbbt#[redacted-key]");
  });

  it("expresses provider credential and action capabilities separately", () => {
    const policy = explainCredentialPolicy({ provider: "slack", connection: "rbbt", action: "messages.send" });
    expect(policy.requiredCapabilities).toEqual(["use:credential:slack:rbbt", "execute:slack:messages.send"]);
    expect(policy.approval.required).toBe(true);
  });

  it("stores scopes in SQLite and reads a provider connection back", () => {
    const options = tempOptions();
    upsertCredentialConnection(
      {
        provider: "slack",
        connection: "main",
        backend: "vault",
        secretRef: "vault:secret/ravi/credentials/slack/main#token",
        scopes: ["chat:write", "app_mentions:read"],
        status: "active",
      },
      options,
    );

    const saved = getCredentialConnection("slack", "main", options);
    expect(saved).toMatchObject({
      provider: "slack",
      connection: "main",
      backend: "vault",
      status: "active",
    });
    expect(saved?.scopes).toEqual(["app_mentions:read", "chat:write"]);
  });

  it("does not redact non-secret keychain coordinates", () => {
    expect(redactSecretRef("keychain:ravi.credentials/slack:rbbt")).toBe("keychain:ravi.credentials/slack:rbbt");
  });

  it("uses Vault KV v2 without overwriting sibling keys", async () => {
    const vaultData = new Map<string, Record<string, unknown>>([["ravi/credentials/slack/rbbt", { marker: "keep" }]]);
    const token = "test-vault-token";
    vaultServer = startVaultKvV2Server(vaultData, token);
    process.env.VAULT_ADDR = `http://127.0.0.1:${vaultServer.port}`;
    process.env.VAULT_TOKEN = token;

    const ref = await writeSecret({
      backend: "vault",
      provider: "slack",
      connection: "rbbt",
      secret: "dummy-provider-secret",
      vaultMount: "secret",
      vaultPath: "ravi/credentials/slack/rbbt",
      vaultKey: "token",
    });

    expect(ref).toBe("vault:secret/ravi/credentials/slack/rbbt#token");
    expect(vaultData.get("ravi/credentials/slack/rbbt")).toEqual({
      marker: "keep",
      token: "dummy-provider-secret",
    });
    expect(await readSecret(ref)).toBe("dummy-provider-secret");
    expect(await deleteSecret(ref)).toBe(true);
    expect(vaultData.get("ravi/credentials/slack/rbbt")).toEqual({ marker: "keep" });
  });
});

describe("credential broker Keychain backend", () => {
  /** Fake `security`: parses the `security -i` stdin line; never runs the real binary. */
  function fakeSecurity() {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const items = new Map<string, string>();
    setKeychainCommandRunnerForTests((args, options = {}): SecurityCommandResult => {
      calls.push({ args: [...args], ...(options.input !== undefined ? { input: options.input } : {}) });
      const key = (a: string[]) => `${a[a.indexOf("-s") + 1]}/${a[a.indexOf("-a") + 1]}`;
      if (args[0] === "-i") {
        const input = options.input ?? "";
        const hex = /^add-generic-password -U -a (\S+) -s (\S+) -X ([0-9a-f]+)\n$/.exec(input);
        const quoted = /^add-generic-password -U -a (\S+) -s (\S+) -w "((?:[^"\\]|\\.)*)"\n$/.exec(input);
        if (hex) items.set(`${hex[2]}/${hex[1]}`, Buffer.from(hex[3]!, "hex").toString("utf8"));
        else if (quoted) items.set(`${quoted[2]}/${quoted[1]}`, quoted[3]!.replace(/\\(.)/g, "$1"));
        else return { status: 1, stdout: "", stderr: "unknown command" };
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") {
        const value = items.get(key(args));
        if (value === undefined) {
          return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
        }
        // Like `security -w`: printable ASCII as text, anything else as hex.
        const printable = /^[\x20-\x7e]*$/.test(value);
        return { status: 0, stdout: `${printable ? value : Buffer.from(value).toString("hex")}\n`, stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        return items.delete(key(args))
          ? { status: 0, stdout: "", stderr: "" }
          : { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    });
    return { calls, items };
  }

  it("writes the secret through stdin: it is in no argv element", async () => {
    const { calls } = fakeSecurity();
    const secret = 'xoxb-secret"; delete-keychain login.keychain\n-w leak';

    const ref = await writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret });

    expect(ref).toBe("keychain:ravi.credentials/slack:rbbt");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["-i"]);
    for (const call of calls) {
      for (const arg of call.args) expect(arg).not.toContain("xoxb");
    }
    expect(calls[0]!.input).toBe(
      `add-generic-password -U -a slack:rbbt -s ravi.credentials -X ${Buffer.from(secret).toString("hex")}\n`,
    );
  });

  it("reads and deletes what it wrote", async () => {
    fakeSecurity();
    const ref = await writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret: "s3cr3t" });

    expect(await readSecret(ref)).toBe("s3cr3t");
    expect(await deleteSecret(ref)).toBe(true);
    expect(await deleteSecret(ref)).toBe(false);
  });

  it("stores a ~3.5 KB printable secret (service-account JSON) through the quoted form", async () => {
    const { calls } = fakeSecurity();
    const secret = JSON.stringify({
      type: "service_account",
      private_key: `-----BEGIN PRIVATE KEY-----\n${"M".repeat(3200)}\n-----END PRIVATE KEY-----\n`,
      client_email: "bot@project.iam.gserviceaccount.com",
    });

    const ref = await writeSecret({ backend: "keychain", provider: "gcp", connection: "main", secret });

    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.input).toContain(' -w "{\\"type\\":');
    expect(Buffer.byteLength(calls[0]!.input!)).toBeLessThanOrEqual(SECURITY_INTERACTIVE_MAX_LINE_BYTES);
    expect(await readSecret(ref)).toBe(secret);
  });

  it("reads back a non-ASCII secret that `security -w` prints as hex", async () => {
    fakeSecurity();
    const ref = await writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret: "senha-ç✓" });
    expect(await readSecret(ref)).toBe("senha-ç✓");
  });

  it("refuses a secret too large for one `security -i` line instead of truncating it", async () => {
    const { calls } = fakeSecurity();
    const secret = "x".repeat(SECURITY_INTERACTIVE_MAX_LINE_BYTES);

    await expect(writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret })).rejects.toThrow(
      "vault backend",
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a Keychain service name the interactive parser would split", async () => {
    const { calls } = fakeSecurity();
    const previous = process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE;
    process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE = "ravi creds";
    try {
      await expect(
        writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret: "s3cr3t" }),
      ).rejects.toThrow("RAVI_CREDENTIALS_KEYCHAIN_SERVICE");
    } finally {
      if (previous === undefined) delete process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE;
      else process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE = previous;
    }
    expect(calls).toHaveLength(0);
  });
});

describe("credential broker DB file", () => {
  const posixOnly = process.platform === "win32" ? it.skip : it;

  posixOnly("is 0600 after open", () => {
    const options = tempOptions();
    listCredentialConnections({}, options);
    expect(statSync(options.dbPath!).mode & 0o777).toBe(0o600);
  });
});

function restoreVaultEnv(): void {
  if (originalVaultAddr === undefined) {
    delete process.env.VAULT_ADDR;
  } else {
    process.env.VAULT_ADDR = originalVaultAddr;
  }
  if (originalVaultToken === undefined) {
    delete process.env.VAULT_TOKEN;
  } else {
    process.env.VAULT_TOKEN = originalVaultToken;
  }
}

function startVaultKvV2Server(vaultData: Map<string, Record<string, unknown>>, token: string) {
  return serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("x-vault-token") !== token) {
        return Response.json({ errors: ["forbidden"] }, { status: 403 });
      }

      const url = new URL(request.url);
      const prefix = "/v1/secret/data/";
      if (!url.pathname.startsWith(prefix)) {
        return Response.json({ errors: ["not found"] }, { status: 404 });
      }

      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      if (request.method === "GET") {
        const data = vaultData.get(path);
        if (!data) return Response.json({ errors: ["not found"] }, { status: 404 });
        return Response.json({ data: { data } });
      }

      if (request.method === "POST") {
        const payload = (await request.json()) as { data?: Record<string, unknown> };
        vaultData.set(path, payload.data ?? {});
        return Response.json({ data: { version: 1 } });
      }

      if (request.method === "DELETE") {
        vaultData.delete(path);
        return new Response(null, { status: 204 });
      }

      return Response.json({ errors: ["method not allowed"] }, { status: 405 });
    },
  });
}
