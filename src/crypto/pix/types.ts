/**
 * Pix provider contract. A provider creates charges (QR / copia e cola) and
 * turns its webhook deliveries into normalized payment events. Providers that
 * settle directly into crypto (on-ramps) report the conversion leg too.
 */

export interface PixChargeRequest {
  /** Our correlation id: alphanumeric, ≤ 25 chars, unique per deposit. */
  txid: string;
  /** Amount in centavos. */
  amountBrl: bigint;
  description: string;
  expiresInSeconds: number;
  vaultId: string;
  /** Asset the provider should deliver if it converts on its side (e.g. USDC mint), null = keep BRL. */
  targetAssetId: string | null;
}

export interface PixCharge {
  providerChargeId: string | null;
  /** Provider may replace our txid with its own (e.g. BCB-issued). */
  txid: string;
  copyPaste: string;
  qrImageUrl: string | null;
  paymentUrl: string | null;
  expiresAt: number;
}

export interface PixConversionLeg {
  assetId: string;
  /** Delivered amount in the target asset's atomic units. */
  amountAtomic: bigint;
  /** Target units per 1 BRL, as decimal string. */
  rate: string;
  /** Provider fee in centavos, already deducted from the BRL leg. */
  feeBrl: bigint;
}

export interface PixPaymentEvent {
  /** Provider event id; used to make webhook processing idempotent. */
  eventId: string;
  txid: string | null;
  providerChargeId: string | null;
  /**
   * paid: BRL arrived. converted: provider delivered the crypto leg (on-ramps).
   * A provider may send "paid" with `conversion` set when both happen at once.
   */
  status: "paid" | "converted" | "expired" | "failed";
  /** Amount actually received in centavos (may differ from the charge — always trust this). */
  amountBrl: bigint | null;
  paidAt: number | null;
  payerName: string | null;
  conversion: PixConversionLeg | null;
}

export interface PixWebhookRequest {
  headers: Headers;
  rawBody: string;
}

export interface PixProvider {
  readonly id: string;
  /** True when no real money can move (sandbox, tests). */
  readonly sandbox: boolean;
  /** True when the provider delivers crypto itself; otherwise Ravi converts on its ledger. */
  readonly convertsOnProviderSide: boolean;
  createCharge(request: PixChargeRequest): Promise<PixCharge>;
  /** Verify authenticity (signature/HMAC) and normalize. MUST throw on bad signatures. */
  parseWebhook(request: PixWebhookRequest): Promise<PixPaymentEvent[]>;
}

export class PixWebhookAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PixWebhookAuthError";
  }
}
