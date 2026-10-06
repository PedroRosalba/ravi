/**
 * Ripio Ramps ("Skala") on-ramp: BRL via Pix → USDC delivered to our treasury.
 *
 * Written against the public docs (docs.ripio.com/ramps-api) as of 2026-10-03;
 * NOT yet exercised against a live sandbox — run `ravi crypto pix check` with
 * real sandbox credentials before enabling. Open questions:
 * - Solana is not listed among documented chains (ETHEREUM/POLYGON/BASE are);
 *   `ripio.chain` is configurable and must be confirmed with Ripio.
 * - Each vault owner needs a Ripio customer with KYC COMPLETED (and, from
 *   2026-10-30, an investor profile); link it with `ravi crypto vault link`.
 *
 * Credentials (credential broker, provider "ripio"):
 *   connection "client"  → "<client_id>:<client_secret>"
 *   connection "webhook" → webhook HMAC secret
 */

import { randomUUID } from "node:crypto";
import { readSetting } from "../config.js";
import { getCryptoSetting } from "../db.js";
import { formatAtomic, parseDecimalToAtomic } from "../money.js";
import { lookupSecret } from "../secrets.js";
import { verifyHmacSignature } from "./sandbox.js";
import {
  PixWebhookAuthError,
  type PixCharge,
  type PixChargeRequest,
  type PixPaymentEvent,
  type PixProvider,
  type PixWebhookRequest,
} from "./types.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const RIPIO_HOSTS = {
  sandbox: "https://skala-sandbox.ripio.com",
  production: "https://skala.ripio.com",
} as const;

export const RIPIO_SIGNATURE_HEADERS = ["x-wh-signature-256", "http-x-wh-signature-256"];

export function ripioCustomerSettingKey(vaultId: string): string {
  return `ripio.customer.${vaultId}`;
}

export interface RipioOptions {
  fetch?: FetchLike;
  environment?: "sandbox" | "production";
  clientCredentials?: string | null;
  webhookSecret?: string | null;
  depositAddress?: string;
  chain?: string;
  now?: () => number;
}

export class RipioPixProvider implements PixProvider {
  readonly id = "ripio";
  readonly sandbox: boolean;
  readonly convertsOnProviderSide = true;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: RipioOptions = {}) {
    const environment =
      options.environment ?? (readSetting("ripio.environment") === "production" ? "production" : "sandbox");
    this.sandbox = environment === "sandbox";
    this.baseUrl = RIPIO_HOSTS[environment];
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async createCharge(request: PixChargeRequest): Promise<PixCharge> {
    const customerId = getCryptoSetting(ripioCustomerSettingKey(request.vaultId));
    if (!customerId) {
      throw new Error(
        "This vault has no Ripio customer linked (KYC). Operator: ravi crypto vault link <vault> --ripio-customer <id>.",
      );
    }
    const depositAddress = this.options.depositAddress ?? readSetting("ripio.depositAddress");
    if (!depositAddress) throw new Error("ripio.depositAddress is not configured.");
    const chain = this.options.chain ?? readSetting("ripio.chain");

    const quote = await this.call<Record<string, unknown>>("POST", "/api/v1/quotes/", {
      customerId,
      fromCurrency: "BRL",
      toCurrency: "USDC",
      fromAmount: formatAtomic(request.amountBrl, 2, { minFractionDigits: 2 }),
      chain,
      paymentMethodType: "pix",
    });
    const quoteId = stringField(quote, "quoteId");
    if (!quoteId) throw new Error("Ripio quote response has no quoteId.");

    // externalRef must be a UUID; it becomes our correlation txid.
    const externalRef = randomUUID();
    const order = await this.call<Record<string, unknown>>("POST", "/api/v1/onramp/", {
      customerId,
      quoteId,
      depositAddress,
      externalRef,
    });
    const instructions = (order.fiatPaymentInstructions ?? {}) as Record<string, unknown>;
    const transaction = (order.transaction ?? {}) as Record<string, unknown>;
    const brCode = stringField(instructions, "brCode");
    if (!brCode) throw new Error("Ripio order response has no brCode.");
    const expiresAt = Date.parse(String(instructions.expiresAt ?? order.expiresAt ?? ""));
    return {
      providerChargeId: stringField(transaction, "transactionId") ?? stringField(order, "id"),
      txid: externalRef,
      copyPaste: brCode,
      qrImageUrl: null,
      paymentUrl: stringField(instructions, "paymentUrl"),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.now() + request.expiresInSeconds * 1000,
    };
  }

  async parseWebhook(request: PixWebhookRequest): Promise<PixPaymentEvent[]> {
    const secret =
      this.options.webhookSecret ??
      (await lookupSecret({ provider: "ripio", connection: "webhook", action: "webhook.verify" }));
    if (!secret) throw new PixWebhookAuthError("Ripio webhook secret not configured.");
    const header = RIPIO_SIGNATURE_HEADERS.map((name) => request.headers.get(name)).find(Boolean) ?? "";
    if (!verifyHmacSignature(request.rawBody, header, secret)) {
      throw new PixWebhookAuthError("Invalid Ripio webhook signature.");
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(request.rawBody) as Record<string, unknown>;
    } catch {
      throw new PixWebhookAuthError("Ripio webhook body is not JSON.");
    }
    return normalizeRipioEvent(envelope);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 30_000) return this.token.value;
    const credentials =
      this.options.clientCredentials ??
      (await lookupSecret({ provider: "ripio", connection: "client", action: "oauth.token" }));
    if (!credentials?.includes(":")) throw new Error('Ripio client credentials missing (store as "<id>:<secret>").');
    const response = await this.fetchImpl(`${this.baseUrl}/oauth2/token/`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) throw new Error(`Ripio OAuth failed: HTTP ${response.status}`);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Ripio OAuth response has no access_token.");
    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ripio ${method} ${path} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    return (await response.json()) as T;
  }
}

/** Map Ripio's {eventType, transactionObject} envelope to normalized events. */
export function normalizeRipioEvent(envelope: Record<string, unknown>): PixPaymentEvent[] {
  const eventType = String(envelope.eventType ?? "");
  const tx = (envelope.transactionObject ?? {}) as Record<string, unknown>;
  const txid = stringField(tx, "externalRef");
  const providerChargeId = stringField(tx, "transactionId") ?? stringField(tx, "id");
  const eventId = `${eventType}:${providerChargeId ?? txid ?? String(envelope.issueDatetime ?? "")}`;
  const issued = Date.parse(String(envelope.issueDatetime ?? ""));
  const at = Number.isFinite(issued) ? issued : Date.now();
  const base = { eventId, txid, providerChargeId, payerName: null };

  switch (eventType) {
    case "ON-RAMP.DEPOSIT.RECEIVED":
      return [
        {
          ...base,
          status: "paid",
          amountBrl: decimalOrNull(tx.fromAmount ?? tx.amount, 2),
          paidAt: at,
          conversion: null,
        },
      ];
    case "ON-RAMP.TRADE.COMPLETED":
    case "ON-RAMP.WITHDRAWAL.COMPLETED": {
      const delivered = decimalOrNull(tx.finalToAmount ?? tx.toAmount, 6);
      if (delivered === null) return [];
      const rate = typeof tx.rate === "string" || typeof tx.rate === "number" ? String(tx.rate) : "0";
      return [
        {
          ...base,
          // Only the final delivery credits USDC; TRADE.COMPLETED is informational.
          status: eventType === "ON-RAMP.WITHDRAWAL.COMPLETED" ? "converted" : "paid",
          amountBrl: decimalOrNull(tx.fromAmount, 2),
          paidAt: at,
          conversion:
            eventType === "ON-RAMP.WITHDRAWAL.COMPLETED"
              ? { assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amountAtomic: delivered, rate, feeBrl: 0n }
              : null,
        },
      ];
    }
    case "ON-RAMP.ORDER.CANCELLED":
    case "ON-RAMP.ORDER.REFUNDED":
    case "ON-RAMP.DEPOSIT.REJECTED":
    case "ON-RAMP.DEPOSIT.REFUNDED":
      return [{ ...base, status: "failed", amountBrl: null, paidAt: null, conversion: null }];
    default:
      return [];
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decimalOrNull(value: unknown, decimals: number): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  const [whole, fraction = ""] = text.split(".");
  try {
    // Truncate extra precision (never round up a credit).
    return parseDecimalToAtomic(fraction ? `${whole}.${fraction.slice(0, decimals)}` : whole, decimals);
  } catch {
    return null;
  }
}
