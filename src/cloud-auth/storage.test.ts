import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCachedContactForConsoleUser, writeCachedActorBinding } from "./actor-bindings.js";
import { CloudAuthError } from "./errors.js";
import { getInstallationKeyPath, readOrCreateInstallationKey } from "./installation-key.js";
import { type CommandResult, detectCloudAuthBackends, selectCloudAuthBackend } from "./secret-backends.js";
import {
  deleteCloudCredentials,
  getActiveCloudAuthPointerPath,
  getActiveCloudCredentialsPath,
  getCloudAuthDir,
  getCloudAuthUsersDir,
  getCloudCredentialsPath,
  listCloudAuthUserIds,
  persistMeIntoCredentials,
  readActiveCloudAuthUserId,
  readCloudCredentials,
  readCloudCredentialsForUser,
  setCloudAuthBackendDepsForTests,
  shouldPersistHydratedIdentity,
  toSafeCloudAuthSession,
  writeCloudCredentials,
} from "./storage.js";
import type { CloudCredentials } from "./types.js";

let stateDir: string | null = null;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-cloud-auth-storage-"));
  process.env.RAVI_STATE_DIR = stateDir;
  delete process.env.RAVI_CLOUD_AUTH_BACKEND;
});

afterEach(() => {
  setCloudAuthBackendDepsForTests();
  delete process.env.RAVI_STATE_DIR;
  delete process.env.RAVI_CLOUD_AUTH_BACKEND;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe("cloud auth credential storage", () => {
  it("writes per-user file credentials with 0700 directories and 0600 files", () => {
    const credentials = makeCredentials({ user: { id: "user_alice", email: "alice@example.com" } });

    writeCloudCredentials(credentials);

    expect(statSync(getCloudAuthDir()).mode & 0o777).toBe(0o700);
    expect(statSync(getCloudAuthUsersDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(getCloudAuthUsersDir(), "user_alice")).mode & 0o777).toBe(0o700);
    expect(statSync(getActiveCloudCredentialsPath()!).mode & 0o777).toBe(0o600);
    expect(statSync(getActiveCloudAuthPointerPath()).mode & 0o777).toBe(0o600);
    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(readCloudCredentials()).toEqual(credentials);
    expect(existsSync(getCloudCredentialsPath())).toBe(false);
  });

  it("keeps multiple users and points whoami at the active user", () => {
    const alice = makeCredentials({
      user: { id: "user_alice", email: "alice@example.com" },
      accessToken: "alice-access",
      refreshToken: "alice-refresh",
    });
    const bob = makeCredentials({
      user: { id: "user_bob", email: "bob@example.com" },
      accessToken: "bob-access",
      refreshToken: "bob-refresh",
      organization: { id: "org_456", name: "Other" },
    });

    writeCloudCredentials(alice);
    writeCloudCredentials(bob);

    expect(readActiveCloudAuthUserId()).toBe("user_bob");
    expect(readCloudCredentials()?.user?.id).toBe("user_bob");
    expect(readCloudCredentialsForUser("user_alice")?.accessToken).toBe("alice-access");
    expect(listCloudAuthUserIds()).toEqual(["user_alice", "user_bob"]);

    deleteCloudCredentials();
    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(readCloudCredentials()?.user?.id).toBe("user_alice");
    expect(readCloudCredentialsForUser("user_bob")).toBeNull();
  });

  it("migrates the legacy single-slot file into the active user store", () => {
    const credentials = makeCredentials({ user: { id: "user_alice", email: "alice@example.com" } });
    const dir = getCloudAuthDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(getCloudCredentialsPath(), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    chmodSync(getCloudCredentialsPath(), 0o600);

    expect(readCloudCredentials()).toEqual(credentials);
    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(existsSync(getCloudCredentialsPath())).toBe(false);
    expect(statSync(getActiveCloudCredentialsPath()!).mode & 0o777).toBe(0o600);
  });

  it("writes credentials without a user id to the reserved legacy slot", () => {
    writeCloudCredentials(makeCredentials());
    expect(readActiveCloudAuthUserId()).toBe("_legacy");
    expect(readCloudCredentials()?.accessToken).toBe("access-secret");
  });

  it("promotes the legacy slot once a Console user id is known", () => {
    writeCloudCredentials(makeCredentials());
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice", email: "alice@example.com" } }));
    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(listCloudAuthUserIds()).toEqual(["user_alice"]);
  });

  it("refuses to read credentials with group or world permissions", () => {
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" } }));
    chmodSync(getActiveCloudCredentialsPath()!, 0o644);

    try {
      readCloudCredentials();
      throw new Error("Expected readCloudCredentials to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect((error as CloudAuthError).code).toBe("CREDENTIALS_INVALID");
      expect((error as CloudAuthError).message).toContain("expected 0600");
    }
  });

  it("redacts token material from safe session metadata", () => {
    const credentials = makeCredentials();
    const safe = toSafeCloudAuthSession(credentials);
    const encoded = JSON.stringify(safe);

    expect(encoded).toContain("https://console.example");
    expect(encoded).toContain("alice@example.com");
    expect(encoded).not.toContain(credentials.accessToken);
    expect(encoded).not.toContain(credentials.refreshToken);
    expect(safe).toEqual({
      consoleUrl: "https://console.example",
      user: { email: "alice@example.com" },
      organization: { id: "org_123", name: "Acme" },
      installation: { id: "ins_123" },
      scopes: ["artifacts:publish"],
      accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
      refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    });
  });

  it("deletes stored credentials on logout", () => {
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" } }));
    deleteCloudCredentials();
    expect(readCloudCredentials()).toBeNull();
    expect(readActiveCloudAuthUserId()).toBeNull();
  });
});

describe("cloud auth installation identity", () => {
  it("adopts the Console's local installation id from /me and persists the change", () => {
    const stored = makeCredentials({ installationId: "ins_local_random", user: { id: "user_alice" } });
    const next = persistMeIntoCredentials(stored, {
      user: { id: "user_alice" },
      organization: { id: "org_123" },
      localInstallation: { id: "ins_console" },
    });

    expect(next.installationId).toBe("ins_console");
    expect(shouldPersistHydratedIdentity(stored, next)).toBe(true);
    expect(shouldPersistHydratedIdentity(next, persistMeIntoCredentials(next, { localInstallation: null }))).toBe(
      false,
    );
  });

  it("keeps one private installation key across calls and logout", () => {
    const first = readOrCreateInstallationKey();
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" } }));
    deleteCloudCredentials();

    expect(readOrCreateInstallationKey()).toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(getInstallationKeyPath()).mode & 0o777).toBe(0o600);
  });

  it("maps a Console user back to a contact only when exactly one cached link matches", () => {
    const binding = {
      contactId: "contact_luis",
      actorPrincipal: "contact:contact_luis",
      consoleUserId: "user_luis",
      orgId: "org_123",
      installationId: "ins_console",
    };
    const query = { consoleUserId: "user_luis", orgId: "org_123", installationId: "ins_console" };
    expect(resolveCachedContactForConsoleUser(query)).toBeNull();

    writeCachedActorBinding(binding);
    expect(resolveCachedContactForConsoleUser(query)).toBe("contact_luis");
    expect(resolveCachedContactForConsoleUser({ ...query, installationId: "ins_other" })).toBeNull();

    writeCachedActorBinding({ ...binding, contactId: "contact_luis_wa", actorPrincipal: "contact:contact_luis_wa" });
    expect(resolveCachedContactForConsoleUser(query)).toBeNull();
  });
});

describe("cloud auth secret backends", () => {
  it("defaults to the portable file backend and never requires Keychain", () => {
    const caps = detectCloudAuthBackends({
      usersDir: getCloudAuthUsersDir(),
      platform: "linux",
      env: {},
      commandExists: () => false,
    });
    expect(caps.find((item) => item.name === "file")).toMatchObject({ available: true, default: true });
    expect(caps.find((item) => item.name === "keychain")).toMatchObject({ available: false, default: false });
    expect(selectCloudAuthBackend({ usersDir: getCloudAuthUsersDir(), platform: "linux", env: {} }).name).toBe("file");
  });

  it("falls back to file when an optional backend is requested but unavailable", () => {
    const backend = selectCloudAuthBackend({
      usersDir: getCloudAuthUsersDir(),
      platform: "linux",
      env: { RAVI_CLOUD_AUTH_BACKEND: "keychain" },
      commandExists: () => false,
    });
    expect(backend.name).toBe("file");
  });

  it("can select libsecret when secret-tool is available", () => {
    const backend = selectCloudAuthBackend({
      usersDir: getCloudAuthUsersDir(),
      platform: "linux",
      env: { RAVI_CLOUD_AUTH_BACKEND: "libsecret" },
      commandExists: (command) => command === "secret-tool",
    });
    expect(backend.name).toBe("libsecret");
  });
});

/**
 * A fake macOS Keychain behind the injected `security` runner: understands
 * the `security -i` add line, find -w and delete. Never runs the real binary.
 */
function useFakeKeychain() {
  const items = new Map<string, string>();
  const warnings: string[] = [];
  const key = (args: string[]) => `${args[args.indexOf("-s") + 1]}/${args[args.indexOf("-a") + 1]}`;
  setCloudAuthBackendDepsForTests({
    platform: "darwin",
    commandExists: (command) => command === "security",
    warn: (message) => warnings.push(message),
    runCommand: (_command, args, options = {}): CommandResult => {
      if (args[0] === "-i") {
        const match = /^add-generic-password -U -a (\S+) -s (\S+) -X ([0-9a-f]+)\n$/.exec(options.input ?? "");
        if (!match) return { status: 1, stdout: "", stderr: "unknown command" };
        items.set(`${match[2]}/${match[1]}`, Buffer.from(match[3]!, "hex").toString("utf8"));
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") {
        const value = items.get(key(args));
        return value === undefined
          ? { status: 44, stdout: "", stderr: "not found" }
          : { status: 0, stdout: value, stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        return items.delete(key(args)) ? { status: 0, stdout: "", stderr: "" } : { status: 44, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
  });
  process.env.RAVI_CLOUD_AUTH_BACKEND = "keychain";
  return { items, warnings };
}

describe("cloud auth Keychain fallback", () => {
  const oversized = (overrides: Partial<CloudCredentials> = {}) =>
    makeCredentials({ user: { id: "user_alice" }, accessToken: `access-${"x".repeat(5000)}`, ...overrides });

  it("stores and reads through Keychain when the payload fits", () => {
    const { items } = useFakeKeychain();
    const credentials = makeCredentials({ user: { id: "user_alice" } });

    writeCloudCredentials(credentials);

    expect(items.has("ravi.cloud-auth/user_alice")).toBe(true);
    expect(existsSync(join(getCloudAuthUsersDir(), "user_alice", "credentials.json"))).toBe(false);
    expect(readCloudCredentials()).toEqual(credentials);
  });

  it("reads the file store after a Keychain write falls back, not a stale Keychain item", () => {
    const { items } = useFakeKeychain();
    // An older Ravi stored these in Keychain (argv write).
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" }, accessToken: "stale-access" }));
    expect(items.has("ravi.cloud-auth/user_alice")).toBe(true);
    const fresh = oversized();

    writeCloudCredentials(fresh);

    expect(readCloudCredentials()).toEqual(fresh);
    expect(readCloudCredentialsForUser("user_alice")).toEqual(fresh);
    expect(statSync(join(getCloudAuthUsersDir(), "user_alice", "credentials.json")).mode & 0o777).toBe(0o600);
    // The stale Keychain item is removed.
    expect(items.has("ravi.cloud-auth/user_alice")).toBe(false);
  });

  it("warns once that the credentials went to the 0600 file store, without token material", () => {
    const { warnings } = useFakeKeychain();

    writeCloudCredentials(oversized());
    writeCloudCredentials(oversized({ refreshToken: "refresh-2" }));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("private file store");
    expect(warnings[0]).toContain("0600");
    expect(warnings[0]).toContain("too large");
    expect(warnings[0]).not.toContain("access-x");
  });

  it("logout removes a fallback file copy", () => {
    useFakeKeychain();
    writeCloudCredentials(oversized());

    deleteCloudCredentials();

    expect(readCloudCredentials()).toBeNull();
    expect(existsSync(join(getCloudAuthUsersDir(), "user_alice", "credentials.json"))).toBe(false);
  });

  it("a later Keychain write replaces the fallback file copy", () => {
    const { items } = useFakeKeychain();
    writeCloudCredentials(oversized());
    const small = makeCredentials({ user: { id: "user_alice" }, accessToken: "small-access" });

    writeCloudCredentials(small);

    expect(items.has("ravi.cloud-auth/user_alice")).toBe(true);
    expect(existsSync(join(getCloudAuthUsersDir(), "user_alice", "credentials.json"))).toBe(false);
    expect(readCloudCredentials()).toEqual(small);
  });
});

function makeCredentials(overrides: Partial<CloudCredentials> = {}): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["artifacts:publish"],
    user: { email: "alice@example.com" },
    organization: { id: "org_123", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
    ...overrides,
  };
}
