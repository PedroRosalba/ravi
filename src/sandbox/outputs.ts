/**
 * Output files of a sandbox run, treated as data from an untrusted machine.
 *
 * Everything a run saves (daemon log, patch, task.json, traces, transcripts,
 * E2B telemetry) was produced inside the sandbox by a worker following
 * instructions it did not write, so a prompt-injected worker can shape every
 * byte of it. Three things follow: the files are private to the operator (0600
 * in 0700 directories, under a custom `--output` too), nothing is read without
 * a size cap (a sandbox cannot fill the host's disk), and nothing is printed to
 * the terminal without stripping terminal control sequences (a log line cannot
 * rewrite the screen, write the clipboard or hide text behind a hyperlink).
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeUserOnlyFile } from "../cloud-auth/secret-backends.js";

const MiB = 1024 * 1024;
/** The full daemon log read at the end of a run; the live copy is capped the same way. */
export const MAX_DAEMON_LOG = 50 * MiB;
/** `changes.patch`; over this nothing is saved but a marker (a partial patch applies partially). */
export const MAX_PATCH = 20 * MiB;
/** Each Claude Code transcript, session trace and TASK.md. */
export const MAX_TRANSCRIPT = 10 * MiB;
/** Everything one run reads from the sandbox; files past this are not saved. */
export const MAX_TOTAL = 200 * MiB;
/** JSON the run parses (`ravi tasks show`, `ravi sessions list`); over this it is rejected, not truncated. */
export const MAX_JSON = 1 * MiB;

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Create `dir` (and its parents) and make it owner-only. An existing directory is
 * made 0700 too: the output directory holds the repository's changes and the
 * worker's transcripts, so a custom `--output` should be a directory for the run.
 */
export function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(dir, PRIVATE_DIR_MODE);
}

/** Write a whole file, mode 0600, in a 0700 directory, replacing it atomically. */
export function writePrivate(path: string, data: string): void {
  mkdirPrivate(dirname(path));
  writeUserOnlyFile(path, data);
}

/** Append to a file that is created 0600 when missing (the live daemon log and run.log). */
export function appendPrivate(path: string, data: string): void {
  const existed = existsSync(path);
  if (!existed) mkdirPrivate(dirname(path));
  appendFileSync(path, data, { mode: PRIVATE_FILE_MODE });
  if (!existed) chmodSync(path, PRIVATE_FILE_MODE);
}

/**
 * What a sandbox command returned when read through `head -c <cap + 1>`: the
 * content, whether it went past the cap, and the size the sandbox reported when
 * it did (the exact byte count, or the cap plus one when only the overflow is known).
 */
export interface CappedRead {
  content: string;
  overflow: boolean;
  bytes: number;
}

/**
 * Read `cmd`'s stdout inside the sandbox through a temp file and `head -c cap + 1`,
 * so the host never receives more than the cap and the exit code is the command's
 * own (a pipe would report `head`'s); the subshell keeps an `exit` or `cd` in `cmd`
 * from ending or moving the wrapper. The size is reported on stderr as
 * `ravi-bytes=<n>` so an overflow marker can name it.
 */
export function cappedCommand(cmd: string, cap: number): string {
  return (
    `out=$(mktemp) && ( ${cmd} ) > "$out"; rc=$?; head -c ${cap + 1} "$out"; ` +
    `printf 'ravi-bytes=%s\\n' "$(wc -c < "$out")" >&2; rm -f "$out"; exit $rc`
  );
}

/** Split what a capped command returned into content, overflow flag and reported size. */
export function readCapped(stdout: string, stderr: string | undefined, cap: number): CappedRead {
  const got = Buffer.byteLength(stdout);
  // The last match: the command's own stderr comes first and could hold a lookalike.
  const reported = [...(stderr ?? "").matchAll(/ravi-bytes=\s*(\d+)/g)].at(-1);
  const bytes = reported ? Number(reported[1]) : got;
  if (got <= cap) return { content: stdout, overflow: false, bytes: Math.max(bytes, got) };
  return { content: truncateBytes(stdout, cap), overflow: true, bytes: Math.max(bytes, cap + 1) };
}

/** The first `cap` bytes of `text`, cut on a character boundary. */
export function truncateBytes(text: string, cap: number): string {
  const buf = Buffer.from(text);
  if (buf.length <= cap) return text;
  let cut = buf.toString("utf8", 0, cap);
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return cut;
}

/** The line appended to a text file that was cut at its cap. */
export function truncationMarker(cap: number, bytes: number): string {
  return `\n[ravi: output truncated at ${cap} bytes; the sandbox reported ${bytes} bytes]\n`;
}

/** Human-readable size for markers and warnings. */
export function formatBytes(bytes: number): string {
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

// Everything a terminal interprets, except newline and tab:
// - OSC (ESC ] … BEL|ST, or the C1 form): titles, hyperlinks (OSC 8), clipboard writes (OSC 52);
// - CSI (ESC [ … final byte, or C1 CSI): cursor movement, clear screen, colours;
// - DCS/SOS/PM/APC strings (ESC P|X|^|_ … ST): programmable keys and such;
// - any other ESC + one byte (RIS, charset switches …);
// - the remaining C0 controls and DEL, incl. `\r` (overwrites the line) and BEL;
// - C1 controls U+0080–U+009F;
// - bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069) that reorder what is shown.
const TERMINAL_CONTROLS_RE = new RegExp(
  [
    "(?:\\x1b\\]|\\x9d)[^\\x07\\x1b\\x9c\\n]*(?:\\x07|\\x1b\\\\|\\x9c)?",
    "(?:\\x1b\\[|\\x9b)[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]?",
    "\\x1b[PX^_][^\\x1b\\x9c\\n]*(?:\\x1b\\\\|\\x9c)?",
    "\\x1b[\\x20-\\x7e]?",
    "[\\x00-\\x08\\x0b-\\x1f\\x7f]",
    "[\\x80-\\x9f]",
    "[\\u202a-\\u202e\\u2066-\\u2069]",
  ].join("|"),
  "g",
);

/**
 * Remove what a terminal would interpret from text that came out of the sandbox,
 * before it is printed. Saved files keep the raw bytes (redacted); only the
 * terminal copy is cleaned, so a transcript stays faithful while the screen does not.
 */
export function stripTerminalControls(text: string): string {
  return text.replace(TERMINAL_CONTROLS_RE, "");
}
