/**
 * Exact return contracts for `ravi crypto *`. These feed the SDK/OpenAPI
 * generators, so every object is closed and every field typed. Keep them in
 * lockstep with the `public*` view builders in ./service.ts and the commands.
 */

import { z } from "zod";
import { strictCliOffsetPaginationSchema } from "../cli/return-schemas.js";

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const scalar = z.union([z.number(), z.string(), z.boolean(), z.null()]);

export const assetAmountSchema = z.object({ symbol: z.string(), amount: z.string() });

export const depositConversionSchema = z.object({
  source: z.string(),
  rate: z.string(),
  usdBrl: z.number().optional(),
  assetId: z.string(),
  symbol: z.string(),
  amount: z.string(),
  feeBrl: z.string(),
});

export const publicDepositSchema = z.object({
  id: z.string(),
  vaultId: z.string(),
  provider: z.string(),
  status: z.string(),
  amountBrl: z.string(),
  amountBrlDisplay: z.string(),
  pixCopyPaste: nullableString,
  paymentUrl: nullableString,
  expiresAt: nullableString,
  paidAt: nullableString,
  sandbox: z.boolean(),
  conversion: depositConversionSchema.nullable(),
  createdAt: z.string(),
});

export const tradeJudgeSummarySchema = z.object({
  verdict: z.string(),
  confidence: z.number(),
  passed: z.boolean(),
  reasons: z.array(z.string()),
});

export const publicTradeSchema = z.object({
  id: z.string(),
  vaultId: z.string(),
  side: z.string(),
  status: z.string(),
  executionMode: z.string(),
  input: assetAmountSchema,
  expectedOutput: assetAmountSchema,
  minOutput: z.string(),
  executedOutput: nullableString,
  slippageBps: z.number(),
  priceImpactPct: nullableNumber,
  notionalUsd: nullableNumber,
  rationale: nullableString,
  judge: tradeJudgeSummarySchema.nullable(),
  txSignature: nullableString,
  error: nullableString,
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const seriesSummarySchema = z.object({
  observations: z.number(),
  totalReturn: z.number(),
  momentum7: z.number(),
  momentum30: z.number(),
  annualizedVolatility: z.number(),
  sharpe: z.number(),
  sortino: z.number(),
  maxDrawdown: z.number(),
  var95: z.number(),
  cvar95: z.number(),
  rsi14: nullableNumber,
  trendSlope: z.number(),
  aboveSma20: z.boolean().nullable(),
});

export const signalJudgeSummarySchema = z.object({
  verdict: z.string(),
  confidence: z.number(),
  rugRisk: nullableNumber,
});

export const publicSignalSchema = z.object({
  id: z.string(),
  engine: z.string(),
  symbol: nullableString,
  assetId: z.string(),
  direction: z.string(),
  strength: z.number(),
  confidence: z.number(),
  rationale: z.string(),
  judge: signalJudgeSummarySchema.nullable(),
  features: z.record(z.string(), scalar),
  status: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const strategyMetricsSchema = z.object({
  profitFactor: nullableNumber,
  return3mPct: nullableNumber,
  worstFallPct: nullableNumber,
  winRatePct: nullableNumber,
  trackRecordDays: nullableNumber,
  pnlPoints: z.number(),
  latestPnlUsd: nullableNumber,
  minAllocationUsd: nullableNumber,
  scoreComponents: z.record(z.string(), z.number()),
  flags: z.array(z.string()),
});

export const publicStrategySchema = z.object({
  id: z.string(),
  source: z.string(),
  externalId: z.string(),
  name: z.string(),
  venue: z.string(),
  riskLevel: nullableString,
  score: nullableNumber,
  metrics: strategyMetricsSchema,
  syncedAt: nullableString,
});

export const publicWalletSchema = z.object({
  id: z.string(),
  chain: z.string(),
  address: z.string(),
  label: nullableString,
  source: z.string(),
  score: nullableNumber,
  tags: z.array(z.string()),
  lastActivityAt: nullableString,
});

export const publicVaultSchema = z.object({
  id: z.string(),
  owner: z.string(),
  status: z.string(),
  riskProfile: z.string(),
  ripioCustomerLinked: z.boolean(),
  createdAt: z.string(),
});

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ total: z.number(), pagination: strictCliOffsetPaginationSchema, items: z.array(item) });

// ---- crypto ----------------------------------------------------------------

export const cryptoStatusReturnSchema = z.object({
  pixProvider: z.string(),
  sandbox: z.boolean(),
  executionMode: z.string(),
  killSwitch: z.boolean(),
  jev: z.object({ enabled: z.boolean(), configured: z.boolean(), model: z.string() }),
  approvalTargetConfigured: z.boolean(),
  limits: z.object({ maxTradeUsd: z.string(), maxDailyUsd: z.string(), maxPositionFraction: z.string() }),
});

export const cryptoBalanceReturnSchema = z.object({
  owner: z.string(),
  vault: z.object({ id: z.string(), status: z.string(), riskProfile: z.string() }).nullable(),
  lines: z.array(
    z.object({
      symbol: z.string(),
      assetId: z.string(),
      kind: z.string(),
      amount: z.string(),
      usdPrice: nullableNumber,
      valueUsd: nullableNumber,
      valueBrl: nullableNumber,
    }),
  ),
  totals: z.object({ usd: z.number(), brl: z.number(), unpricedAssets: z.array(z.string()) }).nullable(),
  fx: z.object({ usdBrl: z.number(), source: z.string() }).nullable(),
  pending: z.object({ deposits: z.number(), trades: z.number() }).nullable(),
  asOf: nullableString,
  hint: nullableString,
});

export const cryptoDepositReturnSchema = z.object({
  deposit: publicDepositSchema,
  vaultCreated: z.boolean(),
  instructions: z.string(),
});

export const cryptoQuoteReturnSchema = z.object({
  side: z.string(),
  asset: z.object({
    symbol: z.string(),
    mint: z.string(),
    kind: z.string(),
    usdPrice: nullableNumber,
    liquidityUsd: nullableNumber,
  }),
  input: assetAmountSchema,
  expectedOutput: assetAmountSchema,
  notionalUsd: z.number(),
  priceImpactPct: nullableNumber,
  router: nullableString,
  vaultEquityUsd: nullableNumber,
  risk: z.object({ allowed: z.boolean(), violations: z.array(z.string()) }),
});

export const cryptoAnalyzeReturnSchema = z.object({
  asset: z.object({ symbol: z.string(), mint: z.string(), kind: z.string(), usdPrice: nullableNumber }),
  summary: seriesSummarySchema,
  sizing: z.object({
    riskProfile: z.string(),
    winProbabilityAssumed: z.number(),
    fraction: z.number(),
    components: z.object({ kelly: z.number(), scaledKelly: z.number(), volTarget: z.number(), cap: z.number() }),
    binding: z.string(),
  }),
  judge: z
    .object({
      verdict: z.string(),
      confidence: z.number(),
      rugRisk: nullableNumber,
      passed: z.boolean(),
      reasons: z.array(z.string()),
    })
    .nullable(),
  disclaimer: z.string(),
});

export const cryptoHistoryReturnSchema = z.object({
  vaultId: z.string(),
  total: z.number(),
  pagination: strictCliOffsetPaginationSchema,
  items: z.array(
    z.object({
      kind: z.string(),
      ref: z.string(),
      memo: nullableString,
      at: z.string(),
      changes: z.array(assetAmountSchema),
    }),
  ),
});

// ---- crypto.deposits -------------------------------------------------------

export const depositListReturnSchema = page(publicDepositSchema);
export const depositShowReturnSchema = z.object({ deposit: publicDepositSchema });
export const depositSimulateReturnSchema = z.object({ outcome: z.string(), deposit: publicDepositSchema.nullable() });

// ---- crypto.trades ---------------------------------------------------------

export const tradeProposeReturnSchema = z.object({
  trade: publicTradeSchema,
  risk: z.object({
    allowed: z.boolean(),
    checks: z.array(z.object({ id: z.string(), passed: z.boolean(), detail: z.string() })),
  }),
  approval: z.string(),
});
export const tradeListReturnSchema = page(publicTradeSchema);
export const tradeShowReturnSchema = z.object({ trade: publicTradeSchema, summary: z.string() });
export const tradeMutationReturnSchema = z.object({ trade: publicTradeSchema });

// ---- crypto.signals --------------------------------------------------------

export const signalListReturnSchema = page(publicSignalSchema);
export const signalScanReturnSchema = z.object({
  reports: z.array(
    z.object({
      engine: z.string(),
      candidates: z.number(),
      signals: z.array(publicSignalSchema),
      skipped: z.array(z.object({ asset: z.string(), reason: z.string() })),
    }),
  ),
});

// ---- crypto.strategies -----------------------------------------------------

export const strategySyncReturnSchema = z.object({
  fetched: z.number(),
  authenticated: z.boolean(),
  warnings: z.array(z.string()),
  items: z.array(publicStrategySchema),
});
export const strategyListReturnSchema = page(publicStrategySchema);
export const strategyShowReturnSchema = z.object({ strategy: publicStrategySchema });

// ---- crypto.wallets --------------------------------------------------------

export const walletWatchReturnSchema = z.object({ wallet: publicWalletSchema, created: z.boolean() });
export const walletImportReturnSchema = z.object({
  file: z.string(),
  rows: z.number(),
  created: z.number(),
  updated: z.number(),
  rejected: z.array(z.object({ row: z.number(), address: z.string(), reason: z.string() })),
});
export const walletListReturnSchema = page(publicWalletSchema);
const walletLegSchema = z.object({ token: nullableString, mint: z.string(), amount: nullableNumber }).nullable();
export const walletEventsReturnSchema = page(
  z.object({
    walletId: z.string(),
    kind: z.string(),
    sold: walletLegSchema,
    bought: walletLegSchema,
    usdValue: nullableNumber,
    signature: z.string(),
    at: z.string(),
  }),
);
export const walletRemoveReturnSchema = z.object({ removed: z.boolean(), walletId: z.string() });

// ---- crypto.vault / crypto.settings ---------------------------------------

export const vaultReturnSchema = z.object({ vault: publicVaultSchema });
export const vaultListReturnSchema = page(publicVaultSchema);
export const settingsListReturnSchema = page(
  z.object({ key: z.string(), value: z.string(), isDefault: z.boolean(), description: z.string() }),
);
export const settingsSetReturnSchema = z.object({ key: z.string(), value: z.string() });
