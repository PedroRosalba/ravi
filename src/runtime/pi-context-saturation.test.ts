import { describe, expect, it } from "bun:test";
import { classifyRuntimeContextWindowFailure } from "./context-window-recovery.js";
import {
  classifyPiContextSaturation,
  createPiRpcTimeoutError,
  DEFAULT_PI_COMPACT_TIMEOUT_MS,
  DEFAULT_PI_RESPONSE_TIMEOUT_MS,
  explainPiCommandFailure,
  formatPiCompactionStallFailure,
  formatPiContextSaturationRefusal,
  formatPiContextSaturationWarning,
  readPiContextSaturationNotice,
  readPiContextUsage,
  resolvePiRpcResponseTimeoutMs,
} from "./pi-context-saturation.js";

describe("Pi RPC timeout separation", () => {
  it("keeps the short prompt budget and gives compact a longer one", () => {
    expect(DEFAULT_PI_RESPONSE_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_PI_COMPACT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_PI_RESPONSE_TIMEOUT_MS);

    expect(resolvePiRpcResponseTimeoutMs("prompt")).toBe(DEFAULT_PI_RESPONSE_TIMEOUT_MS);
    expect(resolvePiRpcResponseTimeoutMs("get_state")).toBe(DEFAULT_PI_RESPONSE_TIMEOUT_MS);
    expect(resolvePiRpcResponseTimeoutMs("compact")).toBe(DEFAULT_PI_COMPACT_TIMEOUT_MS);
    expect(resolvePiRpcResponseTimeoutMs("compact")).not.toBe(resolvePiRpcResponseTimeoutMs("prompt"));
  });

  it("honors explicit budgets without letting compact inherit the prompt timeout", () => {
    expect(resolvePiRpcResponseTimeoutMs("prompt", { responseTimeoutMs: 80, compactTimeoutMs: 1_000 })).toBe(80);
    expect(resolvePiRpcResponseTimeoutMs("compact", { responseTimeoutMs: 80, compactTimeoutMs: 1_000 })).toBe(1_000);
    expect(resolvePiRpcResponseTimeoutMs("compact", { responseTimeoutMs: 80 })).toBe(DEFAULT_PI_COMPACT_TIMEOUT_MS);
  });

  it("does not use the generic RPC timeout string for compact", () => {
    const error = createPiRpcTimeoutError("compact");
    expect(error.message).toContain("Context compaction stalled");
    expect(error.message).not.toMatch(/Timeout waiting for Pi RPC/);
    expect(createPiRpcTimeoutError("prompt").message).toBe("Timeout waiting for Pi RPC response to prompt");
  });
});

describe("Pi context saturation classification", () => {
  it("warns at 85% and treats near-full 1M sessions as critical", () => {
    expect(classifyPiContextSaturation({ tokens: 840_000, contextWindow: 1_000_000, percent: 84 })).toMatchObject({
      level: "ok",
    });
    expect(classifyPiContextSaturation({ tokens: 850_000, contextWindow: 1_000_000, percent: 85 })).toMatchObject({
      level: "warn",
      percentLabel: "85",
    });
    expect(classifyPiContextSaturation({ tokens: 870_000, contextWindow: 1_000_000, percent: 87 })).toMatchObject({
      level: "warn",
    });
    expect(classifyPiContextSaturation({ tokens: 960_000, contextWindow: 1_000_000, percent: 96 })).toMatchObject({
      level: "critical",
    });
    expect(classifyPiContextSaturation({ tokens: 993_099, contextWindow: 1_000_000, percent: 99.3 })).toMatchObject({
      level: "critical",
      usedTokens: 993_099,
      limitTokens: 1_000_000,
      percentLabel: "99.3",
    });
  });

  it("treats Pi's default compaction trigger as critical even under 95% on smaller windows", () => {
    const saturation = classifyPiContextSaturation({
      tokens: 115_000,
      contextWindow: 128_000,
      percent: null,
    });
    expect(saturation?.level).toBe("critical");
  });

  it("reads Pi get_session_stats contextUsage", () => {
    const reading = readPiContextUsage({
      contextUsage: { tokens: 993_099, contextWindow: 1_000_000, percent: 99.3 },
    });
    expect(classifyPiContextSaturation(reading)?.level).toBe("critical");
  });

  it("names saturation in operator messages and never the generic RPC timeout", () => {
    const critical = classifyPiContextSaturation({
      tokens: 993_099,
      contextWindow: 1_000_000,
      percent: 99.3,
    })!;
    const warn = classifyPiContextSaturation({
      tokens: 870_000,
      contextWindow: 1_000_000,
      percent: 87,
    })!;

    const warning = formatPiContextSaturationWarning(warn);
    const refusal = formatPiContextSaturationRefusal(critical);
    const stall = formatPiCompactionStallFailure(critical);
    const rewrittenPrompt = explainPiCommandFailure(
      new Error("Timeout waiting for Pi RPC response to prompt"),
      "prompt",
      critical,
    );
    const unrelatedPrompt = explainPiCommandFailure(
      new Error("Timeout waiting for Pi RPC response to prompt"),
      "prompt",
      warn,
    );
    const rewrittenCompact = explainPiCommandFailure(
      new Error("Timeout waiting for Pi RPC response to compact"),
      "compact",
      critical,
    );

    expect(warning).toContain("87%");
    expect(warning).toContain("870,000");
    expect(refusal).toContain("saturated at 99.3%");
    expect(refusal).toContain("Reset the session");
    expect(stall).toContain("compaction stalled");
    expect(stall).toContain("993,099");
    expect(rewrittenPrompt).toBe(refusal);
    expect(unrelatedPrompt).toBe("Timeout waiting for Pi RPC response to prompt");
    expect(rewrittenCompact).toBe(stall);

    for (const message of [warning, refusal, stall, rewrittenPrompt, rewrittenCompact]) {
      expect(message).not.toMatch(/Timeout waiting for Pi RPC/);
      expect(
        classifyRuntimeContextWindowFailure({
          runtimeProvider: "pi",
          error: message,
          rawEvent: { type: "context.saturation", message, reason: "context_saturation" },
        }),
      ).toBeNull();
    }
  });

  it("reads a warn notice and ignores unrelated Pi events", () => {
    const saturation = classifyPiContextSaturation({
      tokens: 870_000,
      contextWindow: 1_000_000,
      percent: 87,
    })!;
    const notice = readPiContextSaturationNotice({
      type: "context.saturation",
      level: "warn",
      message: formatPiContextSaturationWarning(saturation),
      usedTokens: saturation.usedTokens,
      limitTokens: saturation.limitTokens,
      reason: "context_saturation",
    });
    expect(notice?.level).toBe("warn");
    expect(readPiContextSaturationNotice({ type: "compaction_start", reason: "threshold" })).toBeNull();
  });
});
