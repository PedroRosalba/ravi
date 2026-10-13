import { describe, expect, it } from "bun:test";
import {
  buildAddGenericPasswordLine,
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

  it("stays within the line limit `security -i` reads without splitting", () => {
    const overhead = "add-generic-password -U -a u -s s -X \n".length;
    const fits = "x".repeat((SECURITY_INTERACTIVE_MAX_LINE_BYTES - overhead) / 2);
    const fitting = buildAddGenericPasswordLine({ account: "u", service: "s", secret: fits });
    expect(fitting.ok).toBe(true);
    if (fitting.ok) expect(Buffer.byteLength(fitting.line)).toBe(SECURITY_INTERACTIVE_MAX_LINE_BYTES);
    expect(buildAddGenericPasswordLine({ account: "u", service: "s", secret: `${fits}x` })).toMatchObject({
      ok: false,
      reason: "too_long",
    });
    // Measured on macOS 26: lines up to 4095 bytes (newline included) are read whole.
    expect(SECURITY_INTERACTIVE_MAX_LINE_BYTES).toBeLessThanOrEqual(4095);
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
    expect(redactSecurityOutput("returned -25308")).toBe("returned -25308");
  });
});
