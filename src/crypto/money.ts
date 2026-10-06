/**
 * Exact money arithmetic for the crypto domain.
 *
 * Every balance, ledger entry, and order amount is an integer count of the
 * asset's smallest unit ("atomic" units: BRL centavos, USDC 1e-6, SOL lamports)
 * carried as `bigint` in memory and as a decimal string at rest. Floats are only
 * allowed for display and for quant/pricing math that never writes to the ledger.
 */

const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyFormatError";
  }
}

/**
 * Parse a human decimal string ("12.34", "1,50", "R$ 10") into atomic units.
 * Rejects more fractional digits than the asset supports instead of rounding,
 * so a user never silently pays a different amount than they typed.
 */
export function parseDecimalToAtomic(input: string | number, decimals: number): bigint {
  assertDecimals(decimals);
  const raw = typeof input === "number" ? numberToPlainString(input) : input;
  const normalized = raw
    .trim()
    .replace(/^R\$\s*/i, "")
    .replace(/\s+/g, "")
    .replace(",", ".");
  const match = DECIMAL_PATTERN.exec(normalized);
  if (!match) {
    throw new MoneyFormatError(`Invalid amount: "${raw}". Use a decimal like 100 or 25.50.`);
  }
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > decimals) {
    throw new MoneyFormatError(`Amount "${raw}" has more than ${decimals} decimal places.`);
  }
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return sign ? -atomic : atomic;
}

/** Format atomic units as a plain decimal string with exactly `decimals` places trimmed of trailing zeros. */
export function formatAtomic(atomic: bigint, decimals: number, options: { minFractionDigits?: number } = {}): string {
  assertDecimals(decimals);
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = decimals > 0 ? (abs % base).toString().padStart(decimals, "0") : "";
  const minFraction = Math.min(options.minFractionDigits ?? 0, decimals);
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, "0");
  const text = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}

/** Lossy conversion for display and quant math only. Never feed the result back into the ledger. */
export function atomicToNumber(atomic: bigint, decimals: number): number {
  return Number(formatAtomic(atomic, decimals));
}

/**
 * Convert an amount between assets at a decimal price (units of `to` per one
 * unit of `from`). Rounds toward zero so conversions never mint value.
 */
export function convertAtomic(
  amount: bigint,
  fromDecimals: number,
  toDecimals: number,
  price: string | number,
): bigint {
  assertDecimals(fromDecimals);
  assertDecimals(toDecimals);
  const priceScale = 18;
  const scaledPrice = parseDecimalToAtomic(typeof price === "number" ? numberToPlainString(price) : price, priceScale);
  if (scaledPrice <= 0n) throw new MoneyFormatError("Conversion price must be positive.");
  const numerator = amount * scaledPrice * 10n ** BigInt(toDecimals);
  const denominator = 10n ** BigInt(priceScale) * 10n ** BigInt(fromDecimals);
  return numerator / denominator;
}

/** Apply basis points (1 bp = 0.01%) to an atomic amount, rounding toward zero. */
export function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps)) throw new MoneyFormatError("Basis points must be an integer.");
  return (amount * BigInt(bps)) / 10_000n;
}

export function parseAtomicString(value: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new MoneyFormatError(`Invalid atomic amount: "${value}".`);
  return BigInt(value);
}

export function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Render a BRL amount the way Brazilian users expect: R$ 1.234,56 */
export function formatBrl(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}R$ ${whole},${cents}`;
}

function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) throw new MoneyFormatError(`Invalid amount: ${value}.`);
  // String() gives the shortest round-trip form (0.1 -> "0.1"); only fall back to
  // toFixed for exponent notation, where the extra digits are real.
  const shortest = String(value);
  if (!/e/i.test(shortest)) return shortest;
  if (Math.abs(value) >= 1e21) throw new MoneyFormatError(`Amount too large: ${value}.`);
  return value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new MoneyFormatError(`Unsupported decimals: ${decimals}.`);
  }
}
