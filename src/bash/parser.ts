/**
 * Bash Command Parser
 *
 * Extracts all executables from bash commands for permission checking.
 * Includes injection safety checks to prevent bypassing restrictions.
 */

import type { ParsedCommand, PatternCheckResult } from "./types.js";

// ============================================================================
// Dangerous Patterns (checked before parsing)
// ============================================================================

/**
 * Patterns that indicate injection attempts or bypass vectors.
 * These are checked against the raw command BEFORE parsing.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\(/, reason: "command substitution $(...)  is not allowed" },
  { pattern: /`[^`]*`/, reason: "backtick command substitution is not allowed" },
  { pattern: /<\(/, reason: "process substitution <(...) is not allowed" },
  { pattern: />\(/, reason: "process substitution >(...) is not allowed" },
  { pattern: /<<[<-]?/, reason: "here documents are not allowed" },
  {
    pattern: /\|\s*(bash|sh|zsh|dash|ksh|csh|fish)\b/,
    reason: "piping to shell is not allowed",
  },
  {
    pattern: /\|\s*(python|python3|node|perl|ruby)\s+(-c|-e)\b/,
    reason: "piping to interpreter with inline code is not allowed",
  },
  {
    pattern: /\|\s*(python|python3|node|perl|ruby)\s*$/,
    reason: "piping to interpreter stdin is not allowed",
  },
];

/**
 * Executables that are ALWAYS blocked, regardless of config.
 * These can execute arbitrary strings, bypassing all restrictions.
 */
export const UNCONDITIONAL_BLOCKS = new Set([
  // Shell bypass
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "fish",
  "tcsh",
  // String execution
  "eval",
  "exec",
  // source/dot command
  "source",
  ".",
]);

/**
 * Interpreters that are blocked when used with inline code flags.
 */
const INLINE_CODE_INTERPRETERS: Record<string, string[]> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval"],
  perl: ["-e"],
  ruby: ["-e"],
  php: ["-r"],
};

// ============================================================================
// Pattern Checking
// ============================================================================

/**
 * Check command for dangerous patterns before parsing.
 * This is a fail-fast check to catch injection attempts.
 */
export function checkDangerousPatterns(command: string): PatternCheckResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        safe: false,
        reason,
        pattern: pattern.source,
      };
    }
  }
  return { safe: true };
}

// ============================================================================
// Command Parsing
// ============================================================================

/**
 * Normalize command by replacing newlines with semicolons.
 * This ensures multi-line commands are properly parsed.
 */
function normalizeCommand(command: string): string {
  return command.replace(/\n/g, " ; ");
}

/**
 * Placeholder left where quoted or escaped text was removed.
 *
 * Bash only recognizes reserved words (`do`, `done`, `if`, ...) when they are
 * unquoted, so `"x"done` or `\do` are ordinary command words. Keeping a marker
 * lets the parser tell a real keyword from one that only looks like a keyword
 * after the quotes were stripped. NUL cannot appear in a bash argument.
 */
const QUOTE_MARK = "\u0000";

function stripQuoteMarks(token: string): string {
  return token.split(QUOTE_MARK).join("");
}

/**
 * Remove quoted strings from command to avoid false positives.
 * Replaces both single and double quoted strings with a QUOTE_MARK placeholder.
 */
function removeQuotedStrings(command: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      if (!inSingle && !inDouble) result += QUOTE_MARK;
      continue;
    }

    if (char === "'" && !inDouble) {
      if (!inSingle) result += QUOTE_MARK;
      inSingle = !inSingle;
      continue;
    }

    if (char === '"' && !inSingle) {
      if (!inDouble) result += QUOTE_MARK;
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble) {
      result += char;
    }
  }

  return result;
}

/**
 * Extract the executable name from a path.
 * /usr/bin/git -> git
 */
function extractExecutableName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1];
}

/**
 * Check if a token is an environment variable assignment.
 * VAR=value or VAR="value"
 */
function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * Check if a token is a shell redirection (`>out`, `2>&1`, `<in`, `&>log`).
 */
function isRedirection(token: string): boolean {
  return /^(?:[0-9]*[<>]|&>)/.test(token);
}

/**
 * A redirection operator written without its target (`>`, `2>>`, `&>`): the
 * next token is the target file, not a command.
 */
function isBareRedirection(token: string): boolean {
  return /^(?:[0-9]*(?:<|>|>>|<>|<&|>&|>\|)|&>|&>>)$/.test(token);
}

// ============================================================================
// Shell Reserved Words
// ============================================================================

/**
 * Reserved words that may start a command and are followed by another command
 * in the same segment: `do rm x`, `then curl y`, `! grep z`, `{ ls`, `time make`.
 * They are skipped so the real command after them is still checked.
 */
const PREFIX_KEYWORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time"]);

/**
 * Reserved words that close a compound command. Only redirections may follow
 * them, so a segment like `done` or `} > out` has no executable.
 */
const CLOSING_KEYWORDS = new Set(["done", "fi", "esac", "}"]);

/**
 * A `case` pattern such as `start)`, `*)` or `"a b")`. It is only treated as a
 * pattern where bash expects one: right after `case WORD in` or at the start of
 * an arm after `;;` / `;&` / `;;&`.
 */
const CASE_PATTERN = /^[^()]*\)$/;

/**
 * The `(stop)` pattern form is only accepted right after `case WORD in` in the
 * same segment. Elsewhere `(cmd)` may be a subshell, so it is checked as a
 * command (fail closed).
 */
const CASE_PATTERN_AFTER_IN = /^\(?[^()]*\)$/;

interface SimpleCommandOptions {
  /** Recognize reserved words. False for words that bash never reads as keywords (e.g. after `sudo`). */
  keywords?: boolean;
  /** The segment starts a `case` arm, so a leading pattern token is not a command. */
  caseArmStart?: boolean;
}

interface SimpleCommandResult {
  executable: string | null;
  /** Index of the executable token, or tokens.length when there is none. */
  index: number;
  /** The segment ended with `case WORD in`, so the next segment starts a `case` arm. */
  opensCaseArm: boolean;
}

function tokenizeSegment(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * Find the executable of a single simple command (no pipes/chains).
 *
 * Shell reserved words are syntax, not executables. Prefix words (`do`, `then`,
 * `!`, `time`, ...) are skipped and scanning continues, so an executable after a
 * keyword is always returned. Headers whose remaining words are never executed
 * (`for x in a b`, `select x in a`, `case $x in`, `[[ ... ]]`) and closing words
 * (`done`, `fi`, `esac`, `}`) yield no executable. Anything unexpected is
 * returned as the executable, so the permission check fails closed.
 */
function parseSimpleCommandTokens(tokens: string[], options: SimpleCommandOptions = {}): SimpleCommandResult {
  // Bash only reads reserved words in command position: once an assignment,
  // redirection or ordinary word has been seen, `if`/`do`/... are plain words.
  let keywords = options.keywords ?? true;
  let casePattern: RegExp | null = options.caseArmStart ? CASE_PATTERN : null;
  let i = 0;

  const none = (opensCaseArm = false): SimpleCommandResult => ({
    executable: null,
    index: tokens.length,
    opensCaseArm,
  });

  while (i < tokens.length) {
    const token = tokens[i];

    if (casePattern) {
      const pattern = casePattern;
      casePattern = null;
      if (pattern.test(token)) {
        i++;
        continue;
      }
    }

    // Keywords are matched against the raw token: a quoted or escaped word
    // (marked with QUOTE_MARK) is never a reserved word.
    if (keywords) {
      if (PREFIX_KEYWORDS.has(token)) {
        i++;
        if (token === "time" && tokens[i] === "-p") i++;
        continue;
      }

      if (CLOSING_KEYWORDS.has(token)) {
        keywords = false;
        i++;
        continue;
      }

      if (token === "for" || token === "select") {
        // for NAME [in WORDS...] | for NAME do CMD
        i += 2;
        if (i >= tokens.length || tokens[i] === "in") return none();
        if (tokens[i] === "do") {
          i++;
          continue;
        }
        keywords = false;
        continue;
      }

      if (token === "case") {
        // case WORD in [PATTERN) CMD]
        i += 2;
        if (i >= tokens.length) return none();
        if (tokens[i] === "in") {
          i++;
          if (i >= tokens.length) return none(true);
          casePattern = CASE_PATTERN_AFTER_IN;
          continue;
        }
        keywords = false;
        continue;
      }

      if (token === "in") {
        // Continuation of a `for`/`select`/`case` header split across lines.
        return none();
      }

      if (token === "function") {
        // function NAME [()] BODY
        i += 2;
        if (tokens[i] === "()") i++;
        continue;
      }

      if (token === "[[") {
        // Conditional expression: its words are tested, never executed.
        const close = tokens.indexOf("]]", i + 1);
        if (close === -1) return none();
        keywords = false;
        i = close + 1;
        continue;
      }
    }

    if (isEnvAssignment(token)) {
      keywords = false;
      i++;
      continue;
    }

    if (isRedirection(token)) {
      keywords = false;
      i += isBareRedirection(token) ? 2 : 1;
      continue;
    }

    const word = stripQuoteMarks(token);
    if (!word) {
      // The whole word was quoted text; keep scanning like before, but bash
      // would no longer treat a following reserved word as a keyword.
      keywords = false;
      i++;
      continue;
    }

    return { executable: extractExecutableName(word), index: i, opensCaseArm: false };
  }

  return none();
}

interface CommandSegment {
  text: string;
  /** The segment follows `;;`, `;&` or `;;&`, i.e. it starts a new `case` arm. */
  caseArmStart: boolean;
}

/**
 * Split command by operators (pipes, and, or, background, semicolons).
 * Returns array of simple commands. Expects quotes to be removed already.
 */
function splitByOperators(cleaned: string): CommandSegment[] {
  // Split by operators: |, &&, ||, &, ;
  const commands: CommandSegment[] = [];
  let current = "";
  let caseArmStart = false;
  let i = 0;

  const flush = () => {
    if (current.trim()) {
      commands.push({ text: current.trim(), caseArmStart });
      caseArmStart = false;
    }
    current = "";
  };

  while (i < cleaned.length) {
    const char = cleaned[i];
    const next = cleaned[i + 1];
    const prev = cleaned[i - 1];

    // Handle operators
    if (char === "|" && next !== "|") {
      // Pipe (`|&` leaves `&` to start the next segment and is split below)
      flush();
      i++;
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      // && or ||
      flush();
      i += 2;
      continue;
    }

    if (char === "&" && next !== ">" && prev !== ">" && prev !== "<") {
      // Background `cmd & next`: `next` is a separate command. `&>`, `>&`
      // and `<&` are redirections and stay attached to their command.
      flush();
      i++;
      continue;
    }

    if (char === ";") {
      // Semicolon, or a `case` arm terminator: `;;`, `;&`, `;;&`
      flush();
      if (next === ";" || next === "&") {
        caseArmStart = true;
        i += next === ";" && cleaned[i + 2] === "&" ? 3 : 2;
        continue;
      }
      i++;
      continue;
    }

    current += char;
    i++;
  }

  flush();
  return commands;
}

/**
 * Check if an executable with its arguments represents inline code execution.
 */
function isInlineCodeExecution(executable: string, command: string): { blocked: boolean; reason?: string } {
  const flags = INLINE_CODE_INTERPRETERS[executable];
  if (!flags) return { blocked: false };

  // Check if any inline code flag is present in the command
  const tokens = command.split(/\s+/).map(stripQuoteMarks);
  const execIndex = tokens.findIndex((t) => extractExecutableName(t) === executable);

  if (execIndex === -1) return { blocked: false };

  // Look at tokens after the executable
  for (let i = execIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (flags.some((flag) => token === flag || token.startsWith(flag + "="))) {
      return {
        blocked: true,
        reason: `${executable} with inline code flag is not allowed`,
      };
    }
    // Stop at pipes/chains
    if (token === "|" || token === "&&" || token === "||" || token === ";") {
      break;
    }
  }

  return { blocked: false };
}

/**
 * Parse a bash command and extract all executables.
 *
 * Handles:
 * - Pipes: cat file | grep foo -> ["cat", "grep"]
 * - Chains: git status && npm install -> ["git", "npm"]
 * - Env vars: NODE_ENV=prod node app.js -> ["node"]
 * - Sudo prefix: sudo rm -rf / -> ["sudo", "rm"]
 * - Full paths: /usr/bin/git status -> ["git"]
 * - Semicolons: ls; pwd -> ["ls", "pwd"]
 * - Reserved words: for f in *; do rm "$f"; done -> ["rm"]
 */
export function parseBashCommand(command: string): ParsedCommand {
  try {
    // Normalize newlines, drop quoted text, then split by operators
    const simpleCommands = splitByOperators(removeQuotedStrings(normalizeCommand(command)));

    // Extract executables from each command
    const executables: string[] = [];
    const seenInline: string[] = [];
    let opensCaseArm = false;

    for (const segment of simpleCommands) {
      const cmd = segment.text;
      const tokens = tokenizeSegment(cmd);
      const parsed = parseSimpleCommandTokens(tokens, {
        caseArmStart: segment.caseArmStart || opensCaseArm,
      });
      opensCaseArm = parsed.opensCaseArm;
      const exec = parsed.executable;
      if (exec) {
        executables.push(exec);

        // Check for sudo - also extract the actual command
        if (exec === "sudo") {
          const actualExec = parseSimpleCommandTokens(tokens.slice(parsed.index + 1), { keywords: false }).executable;
          if (actualExec) {
            executables.push(actualExec);
          }
        }

        // Check for inline code execution
        const inlineCheck = isInlineCodeExecution(exec, cmd);
        if (inlineCheck.blocked) {
          seenInline.push(inlineCheck.reason || `${exec} inline code`);
        }
      }
    }

    // If inline code was detected, fail parsing
    if (seenInline.length > 0) {
      return {
        executables: [],
        success: false,
        error: seenInline[0],
      };
    }

    return {
      executables: [...new Set(executables)], // Deduplicate
      success: true,
    };
  } catch (err) {
    return {
      executables: [],
      success: false,
      error: err instanceof Error ? err.message : "Parse error",
    };
  }
}
