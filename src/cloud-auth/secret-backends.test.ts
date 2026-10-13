import { describe, expect, it } from "bun:test";
import { SECURITY_INTERACTIVE_MAX_LINE_BYTES } from "../security/macos-keychain.js";
import { CloudAuthError } from "./errors.js";
import { createBackend, type CommandResult } from "./secret-backends.js";

interface RecordedCall {
  command: string;
  args: string[];
  input?: string;
}

/**
 * A fake `security` that understands the one stdin line Ravi sends to
 * `security -i` and `find-generic-password -w`. Never runs the real binary.
 */
function fakeKeychain(options: { failWrites?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const items = new Map<string, Buffer>();
  const runCommand = (command: string, args: string[], opts: { input?: string } = {}): CommandResult => {
    calls.push({ command, args: [...args], ...(opts.input !== undefined ? { input: opts.input } : {}) });
    if (args[0] === "-i") {
      if (options.failWrites)
        return { status: 1, stdout: "", stderr: "security: SecKeychainItemCreateFromContent: -25308" };
      const lines = (opts.input ?? "").split("\n").filter(Boolean);
      for (const line of lines) {
        const match = /^add-generic-password -U -a (\S+) -s (\S+) -X ([0-9a-f]+)$/.exec(line);
        if (!match) return { status: 1, stdout: "", stderr: `unknown command "${line.slice(0, 20)}"` };
        items.set(`${match[2]}/${match[1]}`, Buffer.from(match[3]!, "hex"));
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      const item = items.get(`${args[args.indexOf("-s") + 1]}/${args[args.indexOf("-a") + 1]}`);
      if (!item) return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      // Like `security`: printable ASCII as text, anything else as hex.
      const printable = [...item].every((byte) => byte >= 0x20 && byte < 0x7f);
      return { status: 0, stdout: `${printable ? item.toString("utf8") : item.toString("hex")}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const backend = createBackend("keychain", {
    usersDir: "/nonexistent/ravi-test-users",
    platform: "darwin",
    commandExists: () => true,
    runCommand,
  });
  return { backend, calls, items };
}

const TRICKY_PAYLOAD = `${JSON.stringify(
  {
    version: 1,
    accessToken: 'tok"en; delete-keychain login.keychain',
    refreshToken: 'line1\nline2\r\n"; add-generic-password -a evil -s ravi.cloud-auth -w pwn',
    user: { name: "José Ñandú ✓", note: "back\\slash 'single' `tick` $HOME" },
  },
  null,
  2,
)}\n`;

describe("cloud-auth Keychain backend", () => {
  it("writes through `security -i` on stdin: the payload is in no argv element", () => {
    const { backend, calls } = fakeKeychain();

    backend.write("user_123", TRICKY_PAYLOAD);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.command).toBe("security");
    expect(call!.args).toEqual(["-i"]);
    const parsed = JSON.parse(TRICKY_PAYLOAD) as { accessToken: string; refreshToken: string };
    for (const arg of call!.args) {
      expect(arg).not.toContain("tok");
      expect(arg).not.toContain(parsed.refreshToken);
    }
    // One command line, payload only as hex.
    expect(call!.input).toMatch(/^add-generic-password -U -a user_123 -s ravi\.cloud-auth -X [0-9a-f]+\n$/);
    expect(call!.input).not.toContain("delete-keychain");
    expect(call!.input).not.toContain('"');
    expect(call!.input!.split("\n")).toHaveLength(2);
  });

  it("round-trips a payload with quotes, newlines and non-ASCII text", () => {
    const { backend, items } = fakeKeychain();

    backend.write("user_123", TRICKY_PAYLOAD);
    const stored = items.get("ravi.cloud-auth/user_123")!;
    const read = backend.read("user_123");

    // Stored as compact, printable ASCII JSON, so `-w` returns it as text.
    expect([...stored].every((byte) => byte >= 0x20 && byte < 0x7f)).toBe(true);
    expect(JSON.parse(read!)).toEqual(JSON.parse(TRICKY_PAYLOAD));
  });

  it("decodes an item that `security -w` prints as hex (non-ASCII, written by an older Ravi)", () => {
    const { backend, items } = fakeKeychain();
    const legacy = JSON.stringify({ user: { name: "José" } });
    items.set("ravi.cloud-auth/user_123", Buffer.from(legacy, "utf8"));

    expect(backend.read("user_123")).toBe(legacy);
  });

  it("refuses a payload too large for one `security -i` line without running security", () => {
    const { backend, calls } = fakeKeychain();
    const huge = JSON.stringify({ accessToken: "x".repeat(SECURITY_INTERACTIVE_MAX_LINE_BYTES) });

    expect(() => backend.write("user_123", huge)).toThrow(CloudAuthError);
    expect(calls).toHaveLength(0);
  });

  it("refuses an account name the interactive parser would split, without running security", () => {
    const { backend, calls } = fakeKeychain();

    expect(() => backend.write('user 1"; delete-keychain', TRICKY_PAYLOAD)).toThrow(CloudAuthError);
    expect(calls).toHaveLength(0);
  });

  it("reports a failed write as the file-store fallback error, with secret material redacted", () => {
    const { backend } = fakeKeychain({ failWrites: true });
    let failure: unknown;
    try {
      backend.write("user_123", TRICKY_PAYLOAD);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CloudAuthError);
    expect((failure as Error).message).toContain("fell back to the portable file store");
  });
});
