/**
 * Advisory review of `changes.patch`: which files in the sandbox's diff deserve
 * a look before `git apply`, because applying them changes what runs on the
 * operator's machine rather than what the repository does.
 *
 * The patch is attacker-authored: the worker owns the clone's `.git/config`
 * (`diff.external`, `diff.noprefix`, a replaced `git`), so `git diff` can print
 * anything. The review therefore reads the file the way `git apply` would, not
 * the way `git diff` writes it: plain unified diffs (`---`/`+++` with no
 * `diff --git`) start a file, headers count only in the extended-header area,
 * hunk bodies are consumed by their `@@ -a,b +c,d @@` line counts, modes are
 * parsed as octal like git does, and paths are matched case-insensitively.
 * It never applies anything. Flags are a warning plus `review.flags[]` in the
 * JSON result; the exit code is unchanged (ADR 0002 #9). The operator keeps
 * `git apply --check` and `--exclude=<path>`.
 */

export type PatchFlagKind =
  | "agent-config"
  | "env-config"
  | "hooks-ci"
  | "build"
  | "dependency"
  | "git-config"
  | "package-json-unknown-section"
  | "executable"
  | "symlink"
  | "binary"
  | "path-escape";

export interface PatchFlag {
  path: string;
  kind: PatchFlagKind;
  reason: string;
}

export interface PatchReview {
  /** Files the diff touches (`diff --git` headers and plain `---`/`+++` pairs). */
  files: number;
  flags: PatchFlag[];
  /** `git apply` lines for the operator: a check, and one exclude per flagged path. */
  suggestions: string[];
}

// Every name below is lower case: paths are compared lower-cased, because macOS and
// Windows checkouts are case-insensitive (`.Claude/settings.json` is `.claude/settings.json`).
const AGENT_DIRS = new Set([".claude", ".cursor", ".gemini", ".codex", ".agents", ".windsurf"]);
const AGENT_FILES = new Set([
  ".mcp.json",
  "agents.md",
  "claude.md",
  "claude.local.md",
  "gemini.md",
  ".cursorrules",
  ".windsurfrules",
]);
const VSCODE_FILES = new Set(["settings.json", "tasks.json", "launch.json"]);
const ENV_FILES = new Set([
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  ".tool-versions",
  ".mise.toml",
  "mise.toml",
]);
const HOOK_DIRS = new Set([".husky", ".githooks", ".circleci", ".devcontainer"]);
const HOOK_FILES = new Set([
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".pre-commit-config.yaml",
  ".gitlab-ci.yml",
  ".simple-git-hooks.json",
  ".simple-git-hooks.js",
]);
const BUILD_FILES = new Set([
  "makefile",
  "gnumakefile",
  "flake.nix",
  "build.rs",
  "conftest.py",
  "justfile",
  ".justfile",
  "taskfile.yml",
  "taskfile.yaml",
  "taskfile.dist.yml",
  "taskfile.dist.yaml",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
]);
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
]);
const GIT_FILES = new Set([".gitattributes", ".gitmodules"]);

/** Path segments as git would write them: `//` and `.` collapsed, each segment lower-cased and trimmed. */
function segmentsOf(path: string): string[] {
  return path
    .split("/")
    .map((segment) => segment.toLowerCase().trimEnd())
    .filter((segment) => segment !== "" && segment !== ".");
}

/** The reason a path is flagged by name, or null when it is an ordinary file. */
export function classifyPath(path: string): { kind: PatchFlagKind; reason: string } | null {
  const segments = segmentsOf(path);
  const base = segments[segments.length - 1] ?? "";
  const dirs = segments.slice(0, -1);
  if (path.startsWith("/") || segments.includes("..")) {
    return { kind: "path-escape", reason: "path leaves the repository (`..` or leading `/`)" };
  }
  if (dirs.some((dir) => AGENT_DIRS.has(dir)) || AGENT_FILES.has(base)) {
    return { kind: "agent-config", reason: "read by coding agents on this machine (prompt injection)" };
  }
  if (dirs.length === 1 && dirs[0] === ".github" && base === "copilot-instructions.md") {
    return { kind: "agent-config", reason: "read by coding agents on this machine (prompt injection)" };
  }
  if (dirs.includes(".vscode") && VSCODE_FILES.has(base)) {
    return { kind: "agent-config", reason: "editor config that can run commands on open" };
  }
  if (ENV_FILES.has(base) || base.startsWith(".env")) {
    return { kind: "env-config", reason: "environment or tool config loaded by shells and package managers" };
  }
  if (
    dirs.some((dir) => HOOK_DIRS.has(dir)) ||
    HOOK_FILES.has(base) ||
    base.startsWith(".lintstagedrc") ||
    base.startsWith("lint-staged.config.")
  ) {
    return { kind: "hooks-ci", reason: "git hook, CI or devcontainer definition that runs code" };
  }
  if (dirs[0] === ".github" && dirs[1] === "workflows") {
    return { kind: "hooks-ci", reason: "GitHub Actions workflow" };
  }
  if (BUILD_FILES.has(base)) return { kind: "build", reason: "build file that runs commands" };
  if (LOCKFILES.has(base)) {
    return { kind: "dependency", reason: "lockfile: decides which package code is downloaded and run" };
  }
  if (GIT_FILES.has(base)) {
    return { kind: "git-config", reason: "git attributes or submodules (filters and URLs git acts on)" };
  }
  return null;
}

/** Drop the first path component, as `git apply` does by default (`-p1`). */
function stripComponent(path: string): string {
  const at = path.indexOf("/");
  return at < 0 ? path : path.slice(at + 1).replace(/^\/+/, "");
}

/** Parse a C-quoted string starting at `text[0] === '"'`: the unquoted value and where it ended. */
function readQuoted(text: string): { value: string; end: number } | null {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === '"') return { value: unquote(text.slice(1, i)), end: i + 1 };
  }
  return null;
}

/** `diff --git A B`: the new path after `-p1`, handling git's C-style quoting and spaces in names. */
export function parseDiffHeader(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const first = readQuoted(rest);
    if (!first) return null;
    const tail = rest.slice(first.end).replace(/^ /, "");
    const second = tail.startsWith('"') ? readQuoted(tail)?.value : tail;
    return second ? stripComponent(second) : null;
  }
  if (rest.endsWith('"')) {
    const open = rest.lastIndexOf(' "');
    const second = open >= 0 ? readQuoted(rest.slice(open + 1)) : null;
    return second ? stripComponent(second.value) : null;
  }
  // Unquoted: git splits where both halves name the same path once their first component is gone.
  for (let at = rest.indexOf(" "); at >= 0; at = rest.indexOf(" ", at + 1)) {
    const a = stripComponent(rest.slice(0, at));
    const b = stripComponent(rest.slice(at + 1));
    if (rest.slice(0, at).includes("/") && rest.slice(at + 1).includes("/") && a === b && b) return b;
  }
  // Different paths (a rename): a guess, used for flags only; `rename to` / `+++` name the file.
  const last = rest.lastIndexOf(" b/");
  return last >= 0 ? rest.slice(last + 3) : null;
}

/** Undo git's C-style quoting; octal escapes are UTF-8 bytes. */
function unquote(raw: string): string {
  const escapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const octal = raw[i] === "\\" ? /^[0-7]{1,3}/.exec(raw.slice(i + 1)) : null;
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
    } else if (raw[i] === "\\" && raw[i + 1] !== undefined && raw[i + 1] in escapes) {
      bytes.push(escapes[raw[i + 1]]);
      i += 1;
    } else {
      // git escapes every non-ASCII byte, but keep a stray astral character whole.
      const char = String.fromCodePoint(raw.codePointAt(i) ?? 0);
      bytes.push(...Buffer.from(char));
      i += char.length - 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Name on a `---`/`+++` line (`prefixed`: `-p1` applies) or a `rename to`/`copy to` line.
 * Unquoted names end at a tab, like git's; null for `/dev/null`.
 */
function nameFrom(value: string, prefixed: boolean): string | null {
  const quoted = value.startsWith('"') ? readQuoted(value) : null;
  const raw = quoted ? quoted.value : value.replace(/\t.*$/, "").trimEnd();
  if (!quoted && raw === "/dev/null") return null;
  return prefixed ? stripComponent(raw) : raw;
}

/**
 * A mode as `git apply` reads it (`strtoul(…, 8)`, then whitespace): octal digits,
 * leading zeros and trailing whitespace allowed. Null when git would refuse it.
 */
function parseMode(text: string): number | null {
  const match = /^\s*\+?([0-7]+)(?:\s|$)/.exec(text);
  return match ? Number.parseInt(match[1], 8) : null;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFGITLINK = 0o160000;

/** Extended-header lines `git apply` understands after `diff --git`. */
const EXTENDED_HEADER_RE =
  /^(?:--- |\+\+\+ |old mode |new mode |deleted file mode |new file mode |copy from |copy to |rename old |rename new |rename from |rename to |similarity index |dissimilarity index |index )/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

interface FileRecord {
  /** The `diff --git` line's new name (a guess when its two names differ). */
  headerName: string | null;
  minus: string | null;
  plus: string | null;
  plusIsNull: boolean;
  renameTo: string | null;
  copyTo: string | null;
  newFile: boolean;
  /** Modes from `new file mode` and `new mode` lines. */
  modes: Array<{ mode: number; fromNewFile: boolean }>;
  /** The mode on an `index <a>..<b> <mode>` line; git uses it for a new file without a mode line. */
  indexMode: number | null;
  binary: boolean;
  hunks: Hunk[];
}

function newRecord(headerName: string | null): FileRecord {
  return {
    headerName,
    minus: null,
    plus: null,
    plusIsNull: false,
    renameTo: null,
    copyTo: null,
    newFile: false,
    modes: [],
    indexMode: null,
    binary: false,
    hunks: [],
  };
}

type Flagger = (path: string, kind: PatchFlagKind, reason: string) => void;

export function reviewPatch(patch: string): PatchReview {
  const flags: PatchFlag[] = [];
  const flagged = new Set<string>();
  const flag: Flagger = (path, kind, reason) => {
    const key = `${path}\0${kind}`;
    if (flagged.has(key)) return;
    flagged.add(key);
    flags.push({ path, kind, reason });
  };

  let files = 0;
  let file: FileRecord | null = null;
  // `search`: between files, where git skips anything that does not start one;
  // `header`: the extended header after `diff --git` (or a plain `---`/`+++` pair);
  // `hunk`: inside a hunk, whose lines are consumed by the counts in its `@@` line.
  let mode: "search" | "header" | "hunk" = "search";
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const openHunk = (record: FileRecord, match: RegExpExecArray) => {
    hunk = { oldStart: Number(match[1]), newStart: Number(match[3]), lines: [] };
    record.hunks.push(hunk);
    oldLeft = match[2] === undefined ? 1 : Number(match[2]);
    newLeft = match[4] === undefined ? 1 : Number(match[4]);
  };
  const startFile = (headerName: string | null) => {
    if (file) reviewFile(file, flag);
    files += 1;
    file = newRecord(headerName);
    hunk = null;
    mode = "header";
    return file;
  };

  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (mode === "hunk" && file) {
      const current = hunk as Hunk | null;
      if (oldLeft > 0 || newLeft > 0) {
        const c = line[0];
        // An empty line is context (GNU diff writes them that way); `\` is "No newline at end of file".
        if (line === "" || c === " ") {
          oldLeft -= 1;
          newLeft -= 1;
        } else if (c === "-") oldLeft -= 1;
        else if (c === "+") newLeft -= 1;
        else if (c !== "\\") mode = "search"; // git apply rejects the patch here ("corrupt patch").
        if (mode === "hunk") {
          current?.lines.push(line);
          continue;
        }
      } else if (line.startsWith("\\")) {
        current?.lines.push(line);
        continue;
      } else {
        const next = HUNK_RE.exec(line);
        if (next) {
          openHunk(file, next);
          continue;
        }
        mode = "search";
      }
    }
    // `startFile` (a closure) also sets the mode, which narrowing cannot see.
    if ((mode as string) === "header" && file) {
      const record: FileRecord = file;
      const next = HUNK_RE.exec(line);
      if (next) {
        openHunk(record, next);
        mode = "hunk";
        continue;
      }
      if (line === "GIT binary patch" || line.startsWith("Binary files ")) {
        record.binary = true;
        mode = "search";
        continue;
      }
      if (EXTENDED_HEADER_RE.test(line)) {
        readHeaderLine(record, line);
        continue;
      }
      // Anything else ends the header; git looks for the next file from here.
      mode = "search";
    }
    // Between files: a `diff --git` line, or a plain `---` line followed by `+++`, starts one.
    if (line.startsWith("diff --git ")) {
      startFile(parseDiffHeader(line));
    } else if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      const record = startFile(null);
      readHeaderLine(record, line);
      readHeaderLine(record, lines[i + 1]);
      i += 1;
    }
  }
  if (file) reviewFile(file, flag);

  const paths = [...new Set(flags.map((f) => f.path))];
  const suggestions =
    paths.length === 0
      ? []
      : [
          "git apply --check changes.patch",
          ...paths.map((p) => `git apply --exclude=${shellWord(escapeGlob(p))} changes.patch`),
        ];
  return { files, flags, suggestions };
}

function readHeaderLine(file: FileRecord, line: string): void {
  if (line.startsWith("--- ")) {
    file.minus = nameFrom(line.slice(4), true);
    if (file.minus === null) file.newFile = true;
  } else if (line.startsWith("+++ ")) {
    file.plus = nameFrom(line.slice(4), true);
    file.plusIsNull = file.plus === null;
  } else if (line.startsWith("rename to ") || line.startsWith("rename new ")) {
    file.renameTo = nameFrom(line.slice(line.indexOf(" ", "rename ".length) + 1), false);
  } else if (line.startsWith("copy to ")) {
    file.copyTo = nameFrom(line.slice("copy to ".length), false);
  } else if (line.startsWith("new file mode ") || line.startsWith("new mode ")) {
    const fromNewFile = line.startsWith("new file mode ");
    if (fromNewFile) file.newFile = true;
    const value = parseMode(line.slice(fromNewFile ? "new file mode ".length : "new mode ".length));
    if (value !== null) file.modes.push({ mode: value, fromNewFile });
  } else if (line.startsWith("index ")) {
    const space = line.indexOf(" ", "index ".length);
    file.indexMode = space >= 0 ? parseMode(line.slice(space + 1)) : null;
  }
}

/** Flag one file: by every name git could give it, by mode, and by its hunks. */
function reviewFile(file: FileRecord, flag: Flagger): void {
  const deleted = file.plusIsNull;
  // The name `git apply` writes to, and matches `--exclude` against.
  const path = file.renameTo ?? file.copyTo ?? file.plus ?? file.headerName ?? file.minus;
  if (path === null) return;
  // git refuses a patch whose names disagree, so every candidate is flagged under the one it uses.
  const names = [path, file.renameTo, file.copyTo, file.plus, file.headerName, deleted ? file.minus : null];
  for (const name of names) {
    const byName = name === null ? null : classifyPath(name);
    if (byName) flag(path, byName.kind, byName.reason);
  }

  const modes = [...file.modes];
  if (file.newFile && modes.length === 0 && file.indexMode !== null) {
    modes.push({ mode: file.indexMode, fromNewFile: true });
  }
  let symlink = false;
  for (const { mode, fromNewFile } of modes) {
    if ((mode & S_IFMT) === S_IFLNK) {
      symlink = true;
      flag(path, "symlink", "symbolic link; its target is written outside git's control");
    } else if ((mode & S_IFMT) === S_IFGITLINK) {
      flag(path, "git-config", "submodule (gitlink) entry");
    } else if (mode & 0o100) {
      flag(path, "executable", fromNewFile ? "new executable file" : "made executable");
    }
  }
  if (file.binary) flag(path, "binary", "binary content that cannot be read in the diff");

  if (symlink) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (!line.startsWith("+")) continue;
        const target = line.slice(1).trim();
        if (target.startsWith("/") || target.split("/").includes("..")) {
          flag(path, "path-escape", `symbolic link to ${target}, outside the repository`);
        }
      }
    }
  }

  if (segmentsOf(path).at(-1) === "package.json" && !deleted) {
    for (const finding of reviewPackageJson(file.hunks)) flag(path, finding.kind, finding.reason);
  }
}

// ---------------------------------------------------------------------------
// package.json

/** Top-level keys whose values run code on install, build, commit or bin lookup, or pick package sources. */
const PACKAGE_RISKY_SECTIONS: Record<string, { kind: PatchFlagKind; reason: string }> = {
  scripts: { kind: "build", reason: 'package.json "scripts" changed (run by npm/bun)' },
  bin: { kind: "build", reason: 'package.json "bin" changed (commands put on PATH)' },
  directories: { kind: "build", reason: 'package.json "directories" changed (can name bin)' },
  config: { kind: "build", reason: 'package.json "config" changed (environment of every script)' },
  gypfile: { kind: "build", reason: 'package.json "gypfile" changed (native build on install)' },
  "lint-staged": { kind: "hooks-ci", reason: 'package.json "lint-staged" changed (runs on commit)' },
  "simple-git-hooks": { kind: "hooks-ci", reason: 'package.json "simple-git-hooks" changed (git hooks)' },
  husky: { kind: "hooks-ci", reason: 'package.json "husky" changed (git hooks)' },
  "pre-commit": { kind: "hooks-ci", reason: 'package.json "pre-commit" changed (git hooks)' },
  trustedDependencies: {
    kind: "dependency",
    reason: 'package.json "trustedDependencies" changed (lets packages run install scripts)',
  },
  overrides: { kind: "dependency", reason: 'package.json "overrides" changed (replaces transitive packages)' },
  resolutions: { kind: "dependency", reason: 'package.json "resolutions" changed (replaces transitive packages)' },
  pnpm: { kind: "dependency", reason: 'package.json "pnpm" changed (overrides, patches, build permissions)' },
  patchedDependencies: { kind: "dependency", reason: 'package.json "patchedDependencies" changed' },
  packageManager: { kind: "dependency", reason: 'package.json "packageManager" changed (which tool corepack runs)' },
  workspaces: { kind: "dependency", reason: 'package.json "workspaces" changed (more package.json files)' },
};
const PACKAGE_DEPENDENCY_SECTIONS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
]);
/** Script names npm and bun run on install, publish or `npm version` without being asked. */
const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "preversion",
  "version",
  "postversion",
  "dependencies",
]);
/**
 * Object-valued keys that only appear at the top of a package.json. A context line
 * (original file content, which git apply checks) opening one of them shows that the
 * container holding it is the root.
 */
const PACKAGE_ROOT_ANCHORS = new Set(["scripts", "dependencies", "devDependencies"]);

/** A JSON object or array as seen from one hunk side; one opened before the hunk has no key. */
interface JsonContainer {
  key: string | null;
  parent: JsonContainer | null;
  /** Depth when known: 0 is outside the root object, 1 the root, 2 a top-level section. */
  level: number | null;
}

interface JsonEvent {
  sign: "+" | "-";
  container: JsonContainer;
  /** The key this token is, or the key whose value it is. */
  key: string | null;
  isKey: boolean;
  value: string | null;
}

/** JSON string token at `text[start] === '"'`: its decoded value (escapes too) and end; unterminated runs to the line end. */
function readJsonString(text: string, start: number): { value: string; end: number } {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  const closed = i < text.length;
  const raw = text.slice(start, closed ? i + 1 : text.length);
  let value: string;
  try {
    value = JSON.parse(closed ? raw : `${raw}"`) as string;
  } catch {
    value = raw.slice(1, closed ? -1 : undefined);
  }
  return { value, end: Math.min(i + 1, text.length) };
}

function levelOf(container: JsonContainer): number | null {
  if (container.level !== null) return container.level;
  const parent = container.parent ? levelOf(container.parent) : null;
  return parent === null ? null : parent + 1;
}

/** Scan one side of a hunk (context plus `sign` lines) and return the tokens on its changed lines. */
function scanHunkSide(hunk: Hunk, sign: "+" | "-"): JsonEvent[] {
  const start = sign === "+" ? hunk.newStart : hunk.oldStart;
  // A hunk that starts at line 1 starts outside the root object; otherwise the depth is unknown.
  let current: JsonContainer = { key: null, parent: null, level: start <= 1 ? 0 : null };
  const events: JsonEvent[] = [];
  let pendingKey: string | null = null;
  let keyOnContext = false;
  let lastString: { value: string; changed: boolean } | null = null;

  // A string is a key when `:` follows it, a value otherwise.
  const settleString = (isKey: boolean) => {
    if (!lastString) return;
    if (isKey) {
      pendingKey = lastString.value;
      keyOnContext = !lastString.changed;
      if (lastString.changed) events.push({ sign, container: current, key: pendingKey, isKey: true, value: null });
    } else if (lastString.changed) {
      events.push({ sign, container: current, key: pendingKey, isKey: false, value: lastString.value });
    }
    lastString = null;
  };

  for (const line of hunk.lines) {
    const prefix = line === "" ? " " : line[0];
    if (prefix !== " " && prefix !== sign) continue;
    const changed = prefix === sign;
    const text = line.slice(1);
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r") continue;
      if (c === '"') {
        settleString(false);
        const read = readJsonString(text, i);
        lastString = { value: read.value, changed };
        i = read.end - 1;
        continue;
      }
      if (c === ":") {
        settleString(true);
        continue;
      }
      settleString(false);
      if (c === "{" || c === "[") {
        const key: string | null = pendingKey;
        if (
          key &&
          keyOnContext &&
          !changed &&
          PACKAGE_ROOT_ANCHORS.has(key) &&
          !current.parent &&
          current.level === null
        ) {
          current.level = 1;
        }
        current = { key, parent: current, level: null };
        pendingKey = null;
      } else if (c === "}" || c === "]") {
        if (current.parent) current = current.parent;
        else {
          // Closing a container opened before the hunk: its parent is unknown too, unless its depth was known.
          const parent: JsonContainer = {
            key: null,
            parent: null,
            level: current.level === null ? null : current.level - 1,
          };
          current.parent = parent;
          current = parent;
        }
        pendingKey = null;
      } else if (c === ",") {
        pendingKey = null;
      } else {
        // A scalar (number, true, false, null): a value of the pending key.
        const end = text.slice(i).search(/[\s,:{}[\]"]/);
        const scalar = end < 0 ? text.slice(i) : text.slice(i, i + end);
        if (changed) events.push({ sign, container: current, key: pendingKey, isKey: false, value: scalar });
        i += Math.max(1, scalar.length) - 1;
      }
    }
  }
  settleString(false);
  return events;
}

/**
 * The top-level key an event belongs to and its depth below it (0: the top-level key
 * itself, 1: directly inside its object), or `section: null` when the hunk does not show it.
 */
function sectionOf(event: JsonEvent): { section: string | null; depth: number } {
  const level = levelOf(event.container);
  if (level === null || level < 1) return { section: null, depth: 0 };
  if (level === 1) return { section: event.key, depth: 0 };
  let container: JsonContainer = event.container;
  while (levelOf(container) !== 2 && container.parent) container = container.parent;
  return { section: container.key, depth: level - 1 };
}

/** A dependency spec that names the registry (a version, range or tag), not a git, URL, file or link source. */
function isRegistrySpec(spec: string): boolean {
  return !/[:/\\]/.test(spec) && !/\.t(?:ar\.)?gz$/i.test(spec) && !spec.startsWith(".");
}

/**
 * Findings for the hunks of a package.json. Each changed token is placed under the
 * top-level key that holds it; when the hunk's context does not show that key, the
 * change is flagged `package-json-unknown-section` rather than assumed harmless.
 * Only a value change to a registry version of an existing dependency, or a change
 * to an ordinary top-level key (`version`, `description` …), passes unflagged.
 */
function reviewPackageJson(hunks: Hunk[]): Array<{ kind: PatchFlagKind; reason: string }> {
  const findings: Array<{ kind: PatchFlagKind; reason: string }> = [];
  for (const hunk of hunks) {
    const removed = scanHunkSide(hunk, "-");
    const added = scanHunkSide(hunk, "+");
    // Dependency names on the old side of this hunk, per section: a `+` name not among them is new.
    const removedNames = new Set<string>();
    for (const event of removed) {
      const where = sectionOf(event);
      if (where.section && where.depth === 1 && event.isKey && event.key) {
        removedNames.add(`${where.section}\0${event.key}`);
      }
    }
    for (const event of [...removed, ...added]) {
      const where = sectionOf(event);
      if (where.section === null) {
        findings.push(
          event.key && LIFECYCLE_SCRIPTS.has(event.key)
            ? { kind: "build", reason: "package.json install lifecycle script changed" }
            : {
                kind: "package-json-unknown-section",
                reason: "package.json change whose top-level key the hunk does not show",
              },
        );
        continue;
      }
      const risky = PACKAGE_RISKY_SECTIONS[where.section];
      if (risky) {
        findings.push(risky);
        continue;
      }
      if (!PACKAGE_DEPENDENCY_SECTIONS.has(where.section)) continue;
      if (where.depth !== 1) {
        findings.push({ kind: "dependency", reason: `package.json "${where.section}" section changed` });
      } else if (event.sign !== "+") {
        // A removal, or the old side of a version change; the new side is checked.
      } else if (event.isKey && event.key && !removedNames.has(`${where.section}\0${event.key}`)) {
        findings.push({ kind: "dependency", reason: `package.json adds a dependency to "${where.section}"` });
      } else if (!event.isKey && event.value !== null && !isRegistrySpec(event.value)) {
        findings.push({
          kind: "dependency",
          reason: `package.json dependency from a git, URL or file source in "${where.section}"`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Output

/** A path as a `git apply --exclude` pattern (wildmatch) that matches only itself. */
export function escapeGlob(path: string): string {
  return path.replace(/[[\]*?\\]/g, "\\$&");
}

// Characters that must not reach a terminal raw: C0, DEL, C1, bidi overrides and isolates.
const UNPRINTABLE = "[\\x00-\\x1f\\x7f-\\x9f\\u202a-\\u202e\\u2066-\\u2069]";
const UNPRINTABLE_RE = new RegExp(UNPRINTABLE);
const UNPRINTABLE_ALL_RE = new RegExp(UNPRINTABLE, "g");

function escapeChar(char: string): string {
  if (char === "\n") return "\\n";
  if (char === "\t") return "\\t";
  if (char === "\r") return "\\r";
  const code = char.charCodeAt(0);
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

/** A path as a shell word: bare when plain, `'…'` otherwise, `$'…'` when it holds control characters. */
function shellWord(path: string): string {
  if (/^[A-Za-z0-9._/@+-]+$/.test(path)) return path;
  if (UNPRINTABLE_RE.test(path)) {
    return `$'${path.replace(/[\\']/g, "\\$&").replace(UNPRINTABLE_ALL_RE, escapeChar)}'`;
  }
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** One line of the box: terminal sequences cleaned, then any control character left shown escaped. */
function visible(text: string, clean: (text: string) => string): string {
  return clean(text).replace(UNPRINTABLE_ALL_RE, escapeChar);
}

/** The warning printed in text mode; `clean` strips terminal controls from attacker-named paths. */
export function formatPatchReview(review: PatchReview, clean: (text: string) => string): string[] {
  if (review.flags.length === 0) return [];
  const rows = review.flags.map((f) => `${visible(f.path, clean)}  [${f.kind}] ${f.reason}`);
  const width = Math.min(100, Math.max(60, ...rows.map((r) => r.length + 2)));
  const rule = (title: string) => `┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}`;
  return [
    rule(`Patch review: ${review.flags.length} flag(s) in ${review.files} file(s), read before applying`),
    ...rows.map((r) => `│ ${r}`),
    "│",
    "│ Nothing was applied. Check and exclude what you do not want:",
    ...review.suggestions.map((s) => `│   ${visible(s, clean)}`),
    `└${"─".repeat(width)}`,
  ];
}
