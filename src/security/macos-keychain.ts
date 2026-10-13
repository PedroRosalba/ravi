/**
 * macOS Keychain writes without the secret in argv
 *
 * `security add-generic-password -w <secret>` puts the secret in the process
 * argv, where any local user can read it with `ps` while the command runs.
 * Instead, Ravi runs `security -i` (interactive mode, one command per stdin
 * line) and writes the command on stdin, with the secret hex-encoded through
 * `-X`. Hex has no characters the interactive tokenizer treats specially, so a
 * payload with quotes, newlines or `"; delete-keychain` cannot change the
 * command.
 *
 * `security -i` reads each line into a fixed buffer: on macOS 26 a line longer
 * than 4095 bytes (newline included) is split, the first part runs truncated
 * and the rest runs as a second command. `buildAddGenericPasswordLine` refuses
 * to build a line over `SECURITY_INTERACTIVE_MAX_LINE_BYTES` (kept below that
 * limit), so callers fail instead of storing a truncated secret.
 *
 * Hex doubles the size, so a secret over ~1.95 KB does not fit. When it is
 * printable ASCII it goes as a double-quoted `-w "<secret>"` instead (~3.9 KB):
 * the interactive tokenizer treats only whitespace, quotes and backslash
 * specially, and inside double quotes `\"` and `\\` are the only escapes
 * needed (verified on macOS 26: `"a\"b c"` stores `a"b c`, `"a\\b"` stores
 * `a\b`). A secret with control characters or non-ASCII text cannot be quoted
 * safely and is only ever sent as hex.
 */

import { spawnSync } from "node:child_process";

/** Longest stdin line (newline included) Ravi sends to `security -i`. */
export const SECURITY_INTERACTIVE_MAX_LINE_BYTES = 4000;

/** Account and service names are passed bare, so they must not need quoting. */
const SAFE_TOKEN = /^[A-Za-z0-9._:@/+-]+$/;
/** Printable ASCII only: safe inside a double-quoted `security -i` token once `"` and `\` are escaped. */
const QUOTABLE = /^[\x20-\x7e]*$/;

export interface SecurityCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type SecurityCommandRunner = (args: string[], options?: { input?: string }) => SecurityCommandResult;

export const runSecurityCommand: SecurityCommandRunner = (args, options = {}) => {
  const result = spawnSync("security", args, { encoding: "utf8", input: options.input });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export type AddGenericPasswordLine =
  | { ok: true; line: string }
  | { ok: false; reason: "unsafe_name" | "too_long"; message: string };

/**
 * The `security -i` stdin line that stores `secret` as a generic password,
 * updating an existing item (`-U`). The secret only appears hex-encoded.
 */
export function buildAddGenericPasswordLine(input: {
  account: string;
  service: string;
  secret: string;
}): AddGenericPasswordLine {
  if (!SAFE_TOKEN.test(input.account) || !SAFE_TOKEN.test(input.service)) {
    return {
      ok: false,
      reason: "unsafe_name",
      message: "Keychain account and service names may only use letters, digits and . _ : @ / + -",
    };
  }
  const prefix = `add-generic-password -U -a ${input.account} -s ${input.service}`;
  const hexLine = `${prefix} -X ${Buffer.from(input.secret, "utf8").toString("hex")}\n`;
  if (Buffer.byteLength(hexLine, "utf8") <= SECURITY_INTERACTIVE_MAX_LINE_BYTES) return { ok: true, line: hexLine };
  if (QUOTABLE.test(input.secret)) {
    const quotedLine = `${prefix} -w "${input.secret.replace(/["\\]/g, (char) => `\\${char}`)}"\n`;
    if (Buffer.byteLength(quotedLine, "utf8") <= SECURITY_INTERACTIVE_MAX_LINE_BYTES)
      return { ok: true, line: quotedLine };
  }
  return {
    ok: false,
    reason: "too_long",
    message: `The secret is too large for a macOS Keychain write through \`security -i\`, which reads at most ${SECURITY_INTERACTIVE_MAX_LINE_BYTES} bytes per command line (about 1.9 KB of secret, or 3.9 KB of printable ASCII).`,
  };
}

/**
 * Undo `find-generic-password -w` hex output. `security` prints a password as
 * text when every byte is printable ASCII and as hex otherwise. Hex output is
 * decoded only when the bytes are not all printable (otherwise `security`
 * would have printed them as text) and are valid UTF-8 (Ravi stores text).
 * A printable secret that looks like hex, such as `7b2261223a317d` or
 * `deadbeef`, comes back unchanged.
 */
export function decodeSecurityPasswordOutput(output: string): string {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(output)) return output;
  const bytes = Buffer.from(output, "hex");
  if (bytes.every((byte) => byte >= 0x20 && byte < 0x7f)) return output;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return output;
  }
}

/** Strip any secret material (`-w <value>`, `-w "<quoted>"`, `-X <hex>`, long hex runs) from `security` output. */
export function redactSecurityOutput(value: string): string {
  return value
    .replace(/(-w\s+)"(?:[^"\\]|\\.)*"?/g, "$1[redacted]")
    .replace(/(-[wX]\s+)\S+/g, "$1[redacted]")
    .replace(/[0-9a-fA-F]{16,}/g, "[redacted]")
    .trim();
}
