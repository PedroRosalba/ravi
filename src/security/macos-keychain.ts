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
 */

import { spawnSync } from "node:child_process";

/** Longest stdin line (newline included) Ravi sends to `security -i`. */
export const SECURITY_INTERACTIVE_MAX_LINE_BYTES = 4000;

/** Account and service names are passed bare, so they must not need quoting. */
const SAFE_TOKEN = /^[A-Za-z0-9._:@/+-]+$/;

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
  const hex = Buffer.from(input.secret, "utf8").toString("hex");
  const line = `add-generic-password -U -a ${input.account} -s ${input.service} -X ${hex}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > SECURITY_INTERACTIVE_MAX_LINE_BYTES) {
    return {
      ok: false,
      reason: "too_long",
      message: `The secret is too large for a macOS Keychain write through \`security -i\` (${bytes} of ${SECURITY_INTERACTIVE_MAX_LINE_BYTES} bytes per line).`,
    };
  }
  return { ok: true, line };
}

/** Strip any secret material (`-w <value>`, `-X <hex>`, long hex runs) from `security` output. */
export function redactSecurityOutput(value: string): string {
  return value
    .replace(/(-[wX]\s+)\S+/g, "$1[redacted]")
    .replace(/[0-9a-fA-F]{16,}/g, "[redacted]")
    .trim();
}
