import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_DAEMON_LOG,
  MAX_JSON,
  MAX_PATCH,
  MAX_TOTAL,
  MAX_TRANSCRIPT,
  appendPrivate,
  cappedCommand,
  mkdirPrivate,
  readCapped,
  stripTerminalControls,
  truncateBytes,
  truncationMarker,
  writePrivate,
} from "./outputs.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ravi-outputs-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe("private output files", () => {
  it("writes 0600 files in 0700 directories, under a custom --output and its subdirectories", () => {
    const output = join(tempDir(), "my", "output");
    writePrivate(join(output, "sessions", "a.trace.txt"), "trace\n");
    appendPrivate(join(output, "run.log"), "one\n");
    appendPrivate(join(output, "run.log"), "two\n");
    expect(mode(join(output, ".."))).toBe(0o700);
    expect(mode(output)).toBe(0o700);
    expect(mode(join(output, "sessions"))).toBe(0o700);
    expect(mode(join(output, "sessions", "a.trace.txt"))).toBe(0o600);
    expect(mode(join(output, "run.log"))).toBe(0o600);
    expect(readFileSync(join(output, "run.log"), "utf8")).toBe("one\ntwo\n");
  });

  it("makes an existing, world-readable --output directory owner-only", () => {
    const output = join(tempDir(), "shared");
    mkdirSync(output, { mode: 0o755 });
    chmodSync(output, 0o755);
    mkdirPrivate(output);
    expect(mode(output)).toBe(0o700);
    writePrivate(join(output, "changes.patch"), "diff\n");
    expect(mode(join(output, "changes.patch"))).toBe(0o600);
  });
});

describe("size caps", () => {
  it("has the limits the spec names", () => {
    const MiB = 1024 * 1024;
    expect([MAX_DAEMON_LOG, MAX_PATCH, MAX_TRANSCRIPT, MAX_TOTAL, MAX_JSON]).toEqual([
      50 * MiB,
      20 * MiB,
      10 * MiB,
      200 * MiB,
      MiB,
    ]);
  });

  /** Run a capped command with the local shell, as the sandbox would. */
  function sh(cmd: string, cap: number) {
    const ran = spawnSync("/bin/sh", ["-c", cappedCommand(cmd, cap)], { encoding: "utf8" });
    return { ...readCapped(ran.stdout, ran.stderr, cap), exit: ran.status };
  }

  it("never returns more than cap + 1 bytes and reports the full size", () => {
    expect(sh("printf hello", 10)).toEqual({ content: "hello", overflow: false, bytes: 5, exit: 0 });
    expect(sh("printf hello", 5)).toEqual({ content: "hello", overflow: false, bytes: 5, exit: 0 });
    const over = spawnSync("/bin/sh", ["-c", cappedCommand("head -c 5000 /dev/zero | tr '\\0' x", 100)], {
      encoding: "utf8",
    });
    expect(over.stdout).toHaveLength(101);
    expect(readCapped(over.stdout, over.stderr, 100)).toEqual({
      content: "x".repeat(100),
      overflow: true,
      bytes: 5000,
    });
  });

  it("keeps the command's exit code, not head's", () => {
    expect(sh("printf partial; exit 3", 100)).toMatchObject({ content: "partial", exit: 3 });
  });

  it("takes the size from the wrapper's own last line, not a lookalike the command printed", () => {
    expect(readCapped("x".repeat(11), "ravi-bytes=1\nravi-bytes=999\n", 10)).toEqual({
      content: "x".repeat(10),
      overflow: true,
      bytes: 999,
    });
  });

  it("cuts text on a character boundary and marks it", () => {
    expect(truncateBytes("aé", 2)).toBe("a");
    expect(truncateBytes("abc", 5)).toBe("abc");
    expect(truncationMarker(10, 25)).toBe("\n[ravi: output truncated at 10 bytes; the sandbox reported 25 bytes]\n");
  });
});

describe("stripTerminalControls", () => {
  it("drops an OSC 52 clipboard write, BEL- or ST-terminated", () => {
    expect(stripTerminalControls("a\x1b]52;c;ZXZpbA==\x07b")).toBe("ab");
    expect(stripTerminalControls("a\x1b]52;c;ZXZpbA==\x1b\\b")).toBe("ab");
  });

  it("drops OSC 8 hyperlinks but keeps their visible text", () => {
    expect(stripTerminalControls("\x1b]8;;http://evil\x1b\\click me\x1b]8;;\x1b\\")).toBe("click me");
  });

  it("drops CSI clear-screen, cursor moves and colours, in 7-bit and C1 form", () => {
    expect(stripTerminalControls("\x1b[2J\x1b[H\x1b[31mred\x1b[0m \x9b2Jx")).toBe("red x");
  });

  it("drops a carriage return that would overwrite the line, and other C0/C1 controls", () => {
    expect(stripTerminalControls("ok: safe\rEVIL")).toBe("ok: safeEVIL");
    expect(stripTerminalControls("a\x00b\x07c\x08d\x7fe\x85f\x8eg")).toBe("abcdefg");
    // C1 OSC (U+009D … U+009C) is a whole sequence, like ESC ].
    expect(stripTerminalControls("\x9d0;title\x9cX")).toBe("X");
  });

  it("drops bidi overrides and isolates that reorder what is shown", () => {
    expect(stripTerminalControls("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(stripTerminalControls("⁦a⁧b⁨c⁩‪‫‬‭")).toBe("abc");
  });

  it("keeps newlines, tabs and ordinary Unicode", () => {
    expect(stripTerminalControls("ação\t日本\nemoji 🚀")).toBe("ação\t日本\nemoji 🚀");
  });

  it("drops DCS strings and lone escapes", () => {
    expect(stripTerminalControls("a\x1bPq#0;2;0;0;0\x1b\\b\x1bcz")).toBe("abz");
  });
});
