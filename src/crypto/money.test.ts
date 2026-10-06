import { describe, expect, it } from "bun:test";
import { MoneyFormatError, applyBps, convertAtomic, formatAtomic, formatBrl, parseDecimalToAtomic } from "./money.js";

describe("crypto money", () => {
  it("parses human decimals into atomic units without floats", () => {
    expect(parseDecimalToAtomic("100", 2)).toBe(10_000n);
    expect(parseDecimalToAtomic("25.5", 2)).toBe(2_550n);
    expect(parseDecimalToAtomic("R$ 1,99", 2)).toBe(199n);
    expect(parseDecimalToAtomic("0.000001", 6)).toBe(1n);
    expect(parseDecimalToAtomic(0.1, 6)).toBe(100_000n);
    expect(parseDecimalToAtomic("-3.25", 2)).toBe(-325n);
  });

  it("rejects ambiguous or over-precise amounts instead of rounding", () => {
    expect(() => parseDecimalToAtomic("1.234", 2)).toThrow(MoneyFormatError);
    expect(() => parseDecimalToAtomic("abc", 2)).toThrow(MoneyFormatError);
    expect(() => parseDecimalToAtomic("1e5", 2)).toThrow(MoneyFormatError);
    expect(() => parseDecimalToAtomic("", 2)).toThrow(MoneyFormatError);
  });

  it("formats atomic units back to decimals", () => {
    expect(formatAtomic(10_000n, 2)).toBe("100");
    expect(formatAtomic(10_050n, 2, { minFractionDigits: 2 })).toBe("100.50");
    expect(formatAtomic(1n, 6)).toBe("0.000001");
    expect(formatAtomic(-1_500_000n, 6)).toBe("-1.5");
    expect(formatBrl(123_456n)).toBe("R$ 1.234,56");
    expect(formatBrl(5n)).toBe("R$ 0,05");
  });

  it("converts across decimals rounding toward zero", () => {
    // R$ 100,00 at 0.18 USDC per BRL -> 18 USDC
    expect(convertAtomic(10_000n, 2, 6, "0.18")).toBe(18_000_000n);
    // 1 USDC at 5.4321 BRL per USDC -> R$ 5,43 (floor, never mints value)
    expect(convertAtomic(1_000_000n, 6, 2, "5.4321")).toBe(543n);
    expect(() => convertAtomic(1n, 2, 6, "0")).toThrow(MoneyFormatError);
  });

  it("applies basis points with floor rounding", () => {
    expect(applyBps(10_000n, 50)).toBe(50n);
    expect(applyBps(199n, 50)).toBe(0n);
  });
});
