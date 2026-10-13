import { describe, expect, it } from "bun:test";
import {
  buildAddGenericPasswordLine,
  decodeSecurityPasswordOutput,
  redactSecurityOutput,
  SECURITY_INTERACTIVE_MAX_LINE_BYTES,
} from "./macos-keychain.js";

describe("buildAddGenericPasswordLine", () => {
  it("builds one stdin line with the secret only as hex", () => {
    const secret = 'a"b\nc; delete-keychain x';
    const command = buildAddGenericPasswordLine({ account: "user_1", service: "ravi.cloud-auth", secret });
    expect(command).toEqual({
      ok: true,
      line: `add-generic-password -U -a user_1 -s ravi.cloud-auth -X ${Buffer.from(secret).toString("hex")}\n`,
    });
  });

  it("uses hex up to the line limit `security -i` reads without splitting", () => {
    const overhead = "add-generic-password -U -a u -s s -X \n".length;
    const fits = "\n".repeat((SECURITY_INTERACTIVE_MAX_LINE_BYTES - overhead) / 2);
    const fitting = buildAddGenericPasswordLine({ account: "u", service: "s", secret: fits });
    expect(fitting.ok).toBe(true);
    if (fitting.ok) {
      expect(fitting.line).toContain(" -X 0a0a");
      expect(Buffer.byteLength(fitting.line)).toBe(SECURITY_INTERACTIVE_MAX_LINE_BYTES);
    }
    // One byte more of a secret that cannot be quoted (a newline) is refused.
    expect(buildAddGenericPasswordLine({ account: "u", service: "s", secret: `${fits}\n` })).toMatchObject({
      ok: false,
      reason: "too_long",
    });
    // Measured on macOS 26: lines up to 4095 bytes (newline included) are read whole.
    expect(SECURITY_INTERACTIVE_MAX_LINE_BYTES).toBeLessThanOrEqual(4095);
  });

  it("sends a long printable secret double-quoted, escaping only quote and backslash", () => {
    const secret = `{"type":"service_account","private_key":"-----BEGIN KEY-----\\nMIIE${"A".repeat(3000)}\\n","q":"it's \\"x\\""} ; delete-keychain`;
    const command = buildAddGenericPasswordLine({ account: "slack:rbbt", service: "ravi.credentials", secret });

    expect(command.ok).toBe(true);
    if (!command.ok) return;
    expect(Buffer.byteLength(command.line)).toBeLessThanOrEqual(SECURITY_INTERACTIVE_MAX_LINE_BYTES);
    expect(command.line.endsWith('"\n')).toBe(true);
    expect(command.line.split("\n")).toHaveLength(2);
    // What `security -i` would parse: exactly one -w token holding the secret.
    const argv = splitSecurityLine(command.line.slice(0, -1));
    expect(argv).toEqual(["add-generic-password", "-U", "-a", "slack:rbbt", "-s", "ravi.credentials", "-w", secret]);
  });

  it("refuses a long secret that is neither short enough for hex nor safe to quote", () => {
    for (const secret of [`caf\u00e9${"x".repeat(2500)}`, `line1\n${"x".repeat(2500)}`, `tab\t${"x".repeat(2500)}`]) {
      expect(buildAddGenericPasswordLine({ account: "u", service: "s", secret })).toMatchObject({
        ok: false,
        reason: "too_long",
      });
    }
    expect(
      buildAddGenericPasswordLine({
        account: "u",
        service: "s",
        secret: "x".repeat(SECURITY_INTERACTIVE_MAX_LINE_BYTES),
      }),
    ).toMatchObject({ ok: false, reason: "too_long" });
  });

  it("refuses names that would need quoting", () => {
    for (const account of ["", "a b", 'a"b', "a'b", "a\nb", "a\\b"]) {
      expect(buildAddGenericPasswordLine({ account, service: "s", secret: "x" })).toMatchObject({
        ok: false,
        reason: "unsafe_name",
      });
    }
    expect(buildAddGenericPasswordLine({ account: "slack:rbbt", service: "ravi credentials", secret: "x" }).ok).toBe(
      false,
    );
  });
});

describe("redactSecurityOutput", () => {
  it("removes -w values, -X hex and long hex runs", () => {
    expect(redactSecurityOutput("add-generic-password -w hunter2 -X 7b2261223a317d")).toBe(
      "add-generic-password -w [redacted] -X [redacted]",
    );
    expect(redactSecurityOutput('security: unknown command "7b22616363657373546f6b656e223a"')).toBe(
      'security: unknown command "[redacted]"',
    );
    expect(redactSecurityOutput('add-generic-password -w "a \\"secret\\" value" ravi')).toBe(
      "add-generic-password -w [redacted] ravi",
    );
    expect(redactSecurityOutput("returned -25308")).toBe("returned -25308");
  });
});

describe("decodeSecurityPasswordOutput", () => {
  it("decodes hex that `security -w` prints for a non-printable password", () => {
    expect(decodeSecurityPasswordOutput(Buffer.from("café ✓").toString("hex"))).toBe("café ✓");
    expect(decodeSecurityPasswordOutput(Buffer.from("a\nb").toString("hex"))).toBe("a\nb");
  });

  it("returns a printable secret that only looks like hex unchanged", () => {
    expect(decodeSecurityPasswordOutput("deadbeef")).toBe("deadbeef");
    expect(decodeSecurityPasswordOutput("7b2261223a317d")).toBe("7b2261223a317d");
    expect(decodeSecurityPasswordOutput("xoxb-123")).toBe("xoxb-123");
  });
});

/**
 * The tokenizer `security -i` applies to a line (split_line): whitespace
 * separates tokens, a backslash makes the next character literal, and single
 * or double quotes group characters until the matching quote.
 */
function splitSecurityLine(line: string): string[] {
  const tokens: string[] = [];
  let current: string | null = null;
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === "\\") {
      current = (current ?? "") + (line[++index] ?? "");
    } else if (quote) {
      if (char === quote) quote = null;
      else current = (current ?? "") + char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current = current ?? "";
    } else if (/\s/.test(char)) {
      if (current !== null) tokens.push(current);
      current = null;
    } else {
      current = (current ?? "") + char;
    }
  }
  if (current !== null) tokens.push(current);
  return tokens;
}
