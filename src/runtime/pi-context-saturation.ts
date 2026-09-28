/**
 * Pi context-window saturation.
 *
 * Pi auto-compacts inside `prompt` preflight, before the RPC response is
 * emitted. That LLM call used to share the 30s prompt timeout, so a session
 * near the window failed every turn as "Timeout waiting for Pi RPC response
 * to prompt". Compaction has its own budget. Near the limit we compact on
 * that budget, or refuse the prompt with a saturation error, before the
 * short prompt RPC starts.
 */

export const DEFAULT_PI_RESPONSE_TIMEOUT_MS = 30_000;
/** Blocking summarization over a near-full session. Not the prompt RPC budget. */
export const DEFAULT_PI_COMPACT_TIMEOUT_MS = 10 * 60_000;

/** Operator warning once the session is this full. */
export const PI_CONTEXT_WARN_FILL_RATIO = 0.85;
/**
 * Refuse a new prompt at this fill, after a dedicated compaction attempt.
 * Also critical when usage crosses Pi's default auto-compaction trigger
 * (`contextWindow - reserveTokens`), which is earlier than 95% on small windows.
 */
export const PI_CONTEXT_CRITICAL_FILL_RATIO = 0.95;
/** Pi's default `compaction.reserveTokens`. The next prompt auto-compacts above this gap. */
export const PI_DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

export const PI_CONTEXT_SATURATION_EVENT = "context.saturation";

export type PiContextSaturationLevel = "ok" | "warn" | "critical";

export interface PiContextUsageReading {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface PiContextSaturation {
  level: PiContextSaturationLevel;
  usedTokens: number;
  limitTokens: number;
  /** used / limit */
  ratio: number;
  /** 0-100, one decimal when needed */
  percentLabel: string;
}

export interface PiContextSaturationNotice {
  type: typeof PI_CONTEXT_SATURATION_EVENT;
  level: "warn" | "critical";
  message: string;
  usedTokens: number;
  limitTokens: number;
  reason: "context_saturation";
}

export function resolvePiRpcResponseTimeoutMs(
  commandType: string,
  options: { responseTimeoutMs?: number; compactTimeoutMs?: number } = {},
): number {
  if (commandType === "compact") {
    return options.compactTimeoutMs ?? DEFAULT_PI_COMPACT_TIMEOUT_MS;
  }
  return options.responseTimeoutMs ?? DEFAULT_PI_RESPONSE_TIMEOUT_MS;
}

export function piContextWarnThresholdTokens(limitTokens: number): number {
  return Math.floor(limitTokens * PI_CONTEXT_WARN_FILL_RATIO);
}

export function piContextCompactionTriggerTokens(limitTokens: number): number {
  return Math.max(0, limitTokens - PI_DEFAULT_COMPACTION_RESERVE_TOKENS);
}

export function readPiContextUsage(data: unknown): PiContextUsageReading | null {
  if (!isRecord(data)) return null;
  const usage = isRecord(data.contextUsage) ? data.contextUsage : null;
  const source = usage ?? data;
  const tokens = finiteNumber(source.tokens);
  const contextWindow = finiteNumber(source.contextWindow) ?? finiteNumber(data.contextWindow);
  const percent = finiteNumber(source.percent);
  if (tokens === null && contextWindow === null && percent === null) return null;
  return { tokens, contextWindow, percent };
}

export function readPiModelContextWindow(state: unknown): number | null {
  if (!isRecord(state)) return null;
  const model = isRecord(state.model) ? state.model : null;
  return finiteNumber(model?.contextWindow);
}

export function classifyPiContextSaturation(reading: PiContextUsageReading | null): PiContextSaturation | null {
  if (!reading) return null;
  const limitTokens = finiteNumber(reading.contextWindow);
  if (limitTokens === null || limitTokens <= 0) return null;

  let usedTokens = finiteNumber(reading.tokens);
  if (usedTokens === null && reading.percent !== null && reading.percent >= 0) {
    usedTokens = Math.round((reading.percent / 100) * limitTokens);
  }
  if (usedTokens === null || usedTokens < 0) return null;

  const ratio = usedTokens / limitTokens;
  const overCompactionTrigger = usedTokens > piContextCompactionTriggerTokens(limitTokens);
  const level: PiContextSaturationLevel =
    ratio >= PI_CONTEXT_CRITICAL_FILL_RATIO || overCompactionTrigger
      ? "critical"
      : ratio >= PI_CONTEXT_WARN_FILL_RATIO
        ? "warn"
        : "ok";

  return {
    level,
    usedTokens,
    limitTokens,
    ratio,
    percentLabel: formatPercent(ratio),
  };
}

export function formatPiContextSaturationWarning(saturation: PiContextSaturation): string {
  return `Context is ${saturation.percentLabel}% full (${formatTokens(saturation.usedTokens)}/${formatTokens(saturation.limitTokens)} tokens). Compaction will be required before the session can keep taking turns.`;
}

export function formatPiContextSaturationRefusal(saturation: PiContextSaturation): string {
  return `Context is saturated at ${saturation.percentLabel}% (${formatTokens(saturation.usedTokens)}/${formatTokens(saturation.limitTokens)} tokens). This prompt was not started. Reset the session before continuing.`;
}

export function formatPiCompactionStallFailure(saturation: PiContextSaturation | null): string {
  if (!saturation) {
    return "Context compaction stalled and did not finish within the compaction budget. Reset the session before sending another prompt.";
  }
  return `Context compaction stalled at ${saturation.percentLabel}% (${formatTokens(saturation.usedTokens)}/${formatTokens(saturation.limitTokens)} tokens) and did not finish within the compaction budget. Reset the session before sending another prompt.`;
}

export function isPiRpcTimeoutError(error: unknown): boolean {
  return errorText(error).startsWith("Timeout waiting for Pi RPC response to ");
}

export function isPiCompactionStallError(error: unknown): boolean {
  return errorText(error).startsWith("Context compaction stalled");
}

export function isPiContextSaturationError(error: unknown): boolean {
  const text = errorText(error);
  return text.startsWith("Context is saturated at ") || isPiCompactionStallError(text);
}

/**
 * Timeout error for one RPC command.
 * Compact never uses the generic prompt timeout string.
 */
export function createPiRpcTimeoutError(commandType: string): Error {
  if (commandType === "compact") {
    return new Error(formatPiCompactionStallFailure(null));
  }
  return new Error(`Timeout waiting for Pi RPC response to ${commandType}`);
}

/**
 * Replace a generic RPC timeout when the classified cause is context size
 * or a compaction stall. Other failures keep their original message.
 */
export function explainPiCommandFailure(
  error: unknown,
  commandType: string,
  saturation: PiContextSaturation | null,
): string {
  const message = errorText(error);
  if (commandType === "compact" && (isPiRpcTimeoutError(error) || isPiCompactionStallError(error))) {
    return formatPiCompactionStallFailure(saturation);
  }
  if (commandType === "prompt" && isPiRpcTimeoutError(error) && saturation?.level === "critical") {
    return formatPiContextSaturationRefusal(saturation);
  }
  return message || "Pi RPC command failed";
}

export function piContextSaturationNotice(saturation: PiContextSaturation, message: string): PiContextSaturationNotice {
  return {
    type: PI_CONTEXT_SATURATION_EVENT,
    level: saturation.level === "critical" ? "critical" : "warn",
    message,
    usedTokens: saturation.usedTokens,
    limitTokens: saturation.limitTokens,
    reason: "context_saturation",
  };
}

export function piContextSaturationRawEvent(saturation: PiContextSaturation, message: string): Record<string, unknown> {
  return { ...piContextSaturationNotice(saturation, message) };
}

export function readPiContextSaturationNotice(raw: unknown): PiContextSaturationNotice | null {
  if (!isRecord(raw) || raw.type !== PI_CONTEXT_SATURATION_EVENT) return null;
  if (raw.level !== "warn" && raw.level !== "critical") return null;
  if (typeof raw.message !== "string" || raw.message.trim().length === 0) return null;
  const usedTokens = finiteNumber(raw.usedTokens);
  const limitTokens = finiteNumber(raw.limitTokens);
  if (usedTokens === null || limitTokens === null || limitTokens <= 0) return null;
  return {
    type: PI_CONTEXT_SATURATION_EVENT,
    level: raw.level,
    message: raw.message,
    usedTokens,
    limitTokens,
    reason: "context_saturation",
  };
}

/** User-facing chat notice for the warn band. Critical turns use the typed refusal. */
export function piContextSaturationUserNotice(raw: unknown): string | null {
  const notice = readPiContextSaturationNotice(raw);
  if (!notice || notice.level !== "warn") return null;
  return notice.message;
}

function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  const rounded = pct.toFixed(1);
  return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
