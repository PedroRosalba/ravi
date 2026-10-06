/**
 * Position sizing. Every function returns a fraction of vault equity in [0, cap]
 * and is deliberately conservative: half-Kelly, volatility targeting, and hard
 * caps per risk profile. Risk limits in ../risk.ts still apply on top.
 */

import type { RiskProfile } from "../types.js";
import { clamp } from "./stats.js";

export interface RiskProfileParams {
  /** Max fraction of vault equity in a single position. */
  maxPositionFraction: number;
  /** Annualized portfolio volatility target used for vol-scaling. */
  targetAnnualVol: number;
  /** Fraction of full Kelly to use. */
  kellyMultiplier: number;
}

export const RISK_PROFILES: Record<RiskProfile, RiskProfileParams> = {
  conservative: { maxPositionFraction: 0.1, targetAnnualVol: 0.15, kellyMultiplier: 0.25 },
  moderate: { maxPositionFraction: 0.2, targetAnnualVol: 0.3, kellyMultiplier: 0.5 },
  aggressive: { maxPositionFraction: 0.35, targetAnnualVol: 0.6, kellyMultiplier: 0.5 },
};

/**
 * Kelly fraction for a binary bet: f* = p - (1 - p) / b, where p is the win
 * probability and b the average win / average loss ratio. Never negative.
 */
export function kellyFraction(winProbability: number, payoffRatio: number): number {
  if (!(payoffRatio > 0)) return 0;
  const p = clamp(winProbability, 0, 1);
  return Math.max(0, p - (1 - p) / payoffRatio);
}

/** Weight that scales a position so its standalone vol matches the target. */
export function volatilityTargetWeight(assetAnnualVol: number, targetAnnualVol: number): number {
  if (!(assetAnnualVol > 0)) return 0;
  return targetAnnualVol / assetAnnualVol;
}

export interface SizingInput {
  riskProfile: RiskProfile;
  /** Annualized volatility of the asset (e.g. 0.8 for 80%). */
  assetAnnualVol: number;
  /** Calibrated probability the trade works (signal confidence or Jev probability). */
  winProbability: number;
  /** Expected win/loss ratio; defaults to 1.5 for trend/copy setups. */
  payoffRatio?: number;
}

export interface SizingResult {
  fraction: number;
  components: {
    kelly: number;
    scaledKelly: number;
    volTarget: number;
    cap: number;
  };
  binding: "kelly" | "volatility" | "cap" | "none";
}

/** Final fraction = min(scaled Kelly, vol-target weight, profile cap). */
export function suggestPositionFraction(input: SizingInput): SizingResult {
  const params = RISK_PROFILES[input.riskProfile];
  const kelly = kellyFraction(input.winProbability, input.payoffRatio ?? 1.5);
  const scaledKelly = kelly * params.kellyMultiplier;
  const volTarget = volatilityTargetWeight(input.assetAnnualVol, params.targetAnnualVol);
  const cap = params.maxPositionFraction;
  const candidates: Array<[SizingResult["binding"], number]> = [
    ["kelly", scaledKelly],
    ["volatility", volTarget > 0 ? volTarget : cap],
    ["cap", cap],
  ];
  const [binding, fraction] = candidates.reduce((best, current) => (current[1] < best[1] ? current : best));
  const final = clamp(fraction, 0, cap);
  return {
    fraction: final,
    components: { kelly, scaledKelly, volTarget, cap },
    binding: final === 0 ? "none" : binding,
  };
}
