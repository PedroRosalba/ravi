/**
 * Advisory review of `changes.patch`: which files in the sandbox's diff deserve
 * a look before `git apply`, because applying them changes what runs on the
 * operator's machine rather than what the repository does.
 *
 * The patch is attacker-controlled (a prompt-injected worker wrote it), so this
 * never applies anything and only reads the diff's headers and hunks. Flags are
 * a warning plus `review.flags[]` in the JSON result; the exit code is unchanged
 * (ADR 0002 #9). The operator keeps `git apply --check` and `--exclude=<path>`.
 */

export type PatchFlagKind =
  | "agent-config"
  | "env-config"
  | "hooks-ci"
  | "build"
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
  /** Files the diff touches (`diff --git` headers). */
  files: number;
  flags: PatchFlag[];
  /** `git apply` lines for the operator: a check, and one exclude per flagged path. */
  suggestions: string[];
}

const AGENT_DIRS = new Set([".claude", ".cursor"]);
const AGENT_FILES = new Set([".mcp.json", "AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
const VSCODE_FILES = new Set(["settings.json", "tasks.json", "launch.json"]);
const ENV_FILES = new Set([".envrc", ".npmrc", "bunfig.toml", ".tool-versions"]);
const HOOK_DIRS = new Set([".husky", ".githooks", ".circleci", ".devcontainer"]);
const HOOK_FILES = new Set(["lefthook.yml", ".pre-commit-config.yaml", ".gitlab-ci.yml"]);
const BUILD_FILES = new Set(["Makefile", "makefile", "GNUmakefile", "flake.nix"]);
// Keys in package.json whose value npm/bun run as a shell command on install.
const INSTALL_SCRIPT_KEY_RE = /^\s*"(?:preinstall|install|postinstall|prepare)"\s*:/;
const SCRIPTS_KEY_RE = /^(\s*)"scripts"\s*:/;

/** The reason a path is flagged by name, or null when it is an ordinary file. */
export function classifyPath(path: string): { kind: PatchFlagKind; reason: string } | null {
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  const dirs = segments.slice(0, -1);
  if (path.startsWith("/") || segments.includes("..")) {
    return { kind: "path-escape", reason: "path leaves the repository (`..` or leading `/`)" };
  }
  if (dirs.some((dir) => AGENT_DIRS.has(dir)) || AGENT_FILES.has(base)) {
    return { kind: "agent-config", reason: "read by coding agents on this machine (prompt injection)" };
  }
  if (dirs.includes(".vscode") && VSCODE_FILES.has(base)) {
    return { kind: "agent-config", reason: "editor config that can run commands on open" };
  }
  if (ENV_FILES.has(base) || base.startsWith(".env")) {
    return { kind: "env-config", reason: "environment or tool config loaded by shells and package managers" };
  }
  if (dirs.some((dir) => HOOK_DIRS.has(dir)) || HOOK_FILES.has(base)) {
    return { kind: "hooks-ci", reason: "git hook, CI or devcontainer definition that runs code" };
  }
  if (dirs[0] === ".github" && dirs[1] === "workflows") {
    return { kind: "hooks-ci", reason: "GitHub Actions workflow" };
  }
  if (BUILD_FILES.has(base)) return { kind: "build", reason: "build file that runs commands" };
  return null;
}

/** `diff --git a/X b/Y`: the new path, handling git's C-style quoting and `a/x b/x` splitting. */
export function parseDiffHeader(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    // Quoted paths: "a/x" "b/y"; the second quoted string is the new path.
    const quoted = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]));
    return quoted.length >= 2 ? stripPrefix(quoted[1]) : null;
  }
  // Unquoted: find the split where both halves name the same path (the common case).
  let at = rest.indexOf(" b/");
  while (at >= 0) {
    if (rest.slice(2, at) === rest.slice(at + 3)) return rest.slice(at + 3);
    at = rest.indexOf(" b/", at + 1);
  }
  // Different paths (a rename header without `rename to`): take the last ` b/`.
  const last = rest.lastIndexOf(" b/");
  return last >= 0 ? rest.slice(last + 3) : null;
}

function stripPrefix(path: string): string {
  return path.startsWith("b/") || path.startsWith("a/") ? path.slice(2) : path;
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

/** Path from a `+++ b/x` / `+++ "b/x"` line (prefixed) or a `rename to x` line (not prefixed). */
function pathFrom(value: string, prefixed: boolean): string {
  const trimmed = value.replace(/\t.*$/, "").trim();
  const path = trimmed.startsWith('"') ? unquote(trimmed.slice(1, -1)) : trimmed;
  return prefixed ? stripPrefix(path) : path;
}

export function reviewPatch(patch: string): PatchReview {
  const flags: PatchFlag[] = [];
  const flagged = new Set<string>();
  let files = 0;
  let path: string | null = null;
  let isPackageJson = false;
  let scriptsIndent: number | null = null;
  let symlink = false;
  const flag = (kind: PatchFlagKind, reason: string, at: string | null = path) => {
    if (at === null) return;
    const key = `${at}\0${kind}`;
    if (flagged.has(key)) return;
    flagged.add(key);
    flags.push({ path: at, kind, reason });
  };
  const setPath = (next: string | null) => {
    path = next;
    isPackageJson = next !== null && (next === "package.json" || next.endsWith("/package.json"));
    scriptsIndent = null;
    symlink = false;
    if (next === null) return;
    const byName = classifyPath(next);
    if (byName) flag(byName.kind, byName.reason);
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files += 1;
      setPath(parseDiffHeader(line));
      continue;
    }
    if (path === null) continue;
    if (line.startsWith("rename to ") || (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null"))) {
      const plus = line.startsWith("+++ ");
      const next = pathFrom(line.slice(plus ? 4 : "rename to ".length), plus);
      // The `diff --git` guess can be wrong for odd names: move what was flagged so far to
      // the path git states, then check that name too.
      if (next !== path) {
        for (const f of flags) {
          if (f.path !== path) continue;
          flagged.delete(`${f.path}\0${f.kind}`);
          f.path = next;
          flagged.add(`${next}\0${f.kind}`);
        }
        // Same file, better name: keep what the headers so far said about it.
        const wasPackageJson: boolean = isPackageJson;
        const wasSymlink: boolean = symlink;
        setPath(next);
        isPackageJson ||= wasPackageJson;
        symlink = wasSymlink;
      }
      continue;
    }
    const mode = /^(?:new file mode|new mode) (\d{6})$/.exec(line);
    if (mode) {
      if (mode[1] === "120000") {
        symlink = true;
        flag("symlink", "symbolic link; its target is written outside git's control");
      } else if (mode[1] === "100755") {
        flag("executable", line.startsWith("new file") ? "new executable file" : "made executable");
      }
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      flag("binary", "binary content that cannot be read in the diff");
      continue;
    }
    if (line.startsWith("@@")) {
      scriptsIndent = null;
      continue;
    }
    if (symlink && line.startsWith("+") && !line.startsWith("+++ ")) {
      const target = line.slice(1).trim();
      if (target.startsWith("/") || target.split("/").includes("..")) {
        flag("path-escape", `symbolic link to ${target}, outside the repository`);
      }
      continue;
    }
    if (!isPackageJson || !/^[ +-]/.test(line)) continue;
    const body = line.slice(1);
    const scripts = SCRIPTS_KEY_RE.exec(body);
    if (scripts) scriptsIndent = scripts[1].length;
    else if (scriptsIndent !== null && /^\s*[}\]]/.test(body) && body.search(/\S/) <= scriptsIndent) {
      scriptsIndent = null;
    }
    if (line.startsWith(" ")) continue;
    if (scripts || scriptsIndent !== null) flag("build", 'package.json "scripts" changed (run by npm/bun)');
    else if (INSTALL_SCRIPT_KEY_RE.test(body)) flag("build", "package.json install lifecycle script changed");
  }

  const paths = [...new Set(flags.map((f) => f.path))];
  const suggestions =
    paths.length === 0
      ? []
      : ["git apply --check changes.patch", ...paths.map((p) => `git apply --exclude=${shellSafe(p)} changes.patch`)];
  return { files, flags, suggestions };
}

/** A path as a shell word: quoted when it holds anything beyond plain path characters. */
function shellSafe(path: string): string {
  return /^[A-Za-z0-9._/@+-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** The warning printed in text mode; `clean` strips terminal controls from attacker-named paths. */
export function formatPatchReview(review: PatchReview, clean: (text: string) => string): string[] {
  if (review.flags.length === 0) return [];
  const rows = review.flags.map((f) => `${clean(f.path)}  [${f.kind}] ${f.reason}`);
  const width = Math.min(100, Math.max(60, ...rows.map((r) => r.length + 2)));
  const rule = (title: string) => `┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}`;
  return [
    rule(`Patch review: ${review.flags.length} flag(s) in ${review.files} file(s), read before applying`),
    ...rows.map((r) => `│ ${r}`),
    "│",
    "│ Nothing was applied. Check and exclude what you do not want:",
    ...review.suggestions.map((s) => `│   ${clean(s)}`),
    `└${"─".repeat(width)}`,
  ];
}
