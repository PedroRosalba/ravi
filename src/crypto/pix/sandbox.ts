/**
 * Sandbox Pix provider: real-format BR Codes bound to an unresolvable key, so
 * the full deposit → webhook → credit → notify loop runs without real money.
 *
 * Webhooks are signed with HMAC-SHA256 over the raw body using the
 * `x-ravi-signature: sha256=<hex>` header, mirroring how real PSPs sign.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseAtomicString } from "../money.js";
import { buildPixBrCode } from "./emv.js";
import {
  PixWebhookAuthError,
  type PixCharge,
  type PixChargeRequest,
  type PixPaymentEvent,
  type PixProvider,
  type PixWebhookRequest,
} from "./types.js";

export const SANDBOX_PIX_KEY = "sandbox@ravi.invalid";
export const SANDBOX_SIGNATURE_HEADER = "x-ravi-signature";

export interface SandboxWebhookPayload {
  eventId: string;
  txid: string;
  status: "paid" | "expired" | "failed";
  amountBrl: string;
  paidAt: number;
  payerName?: string;
}

export class SandboxPixProvider implements PixProvider {
  readonly id = "sandbox";
  readonly sandbox = true;
  readonly convertsOnProviderSide = false;

  constructor(private readonly webhookSecret: string) {}

  async createCharge(request: PixChargeRequest): Promise<PixCharge> {
    return {
      providerChargeId: `sbx_${randomBytes(6).toString("hex")}`,
      txid: request.txid,
      copyPaste: buildPixBrCode({
        pixKey: SANDBOX_PIX_KEY,
        merchantName: "RAVI SANDBOX",
        merchantCity: "SAO PAULO",
        amountBrl: request.amountBrl,
        txid: request.txid,
      }),
      qrImageUrl: null,
      paymentUrl: null,
      expiresAt: Date.now() + request.expiresInSeconds * 1000,
    };
  }

  async parseWebhook(request: PixWebhookRequest): Promise<PixPaymentEvent[]> {
    const header = request.headers.get(SANDBOX_SIGNATURE_HEADER) ?? "";
    if (!verifyHmacSignature(request.rawBody, header, this.webhookSecret)) {
      throw new PixWebhookAuthError("Invalid sandbox webhook signature.");
    }
    let payload: SandboxWebhookPayload;
    try {
      payload = JSON.parse(request.rawBody) as SandboxWebhookPayload;
    } catch {
      throw new PixWebhookAuthError("Sandbox webhook body is not JSON.");
    }
    if (!payload.eventId || !payload.txid || !["paid", "expired", "failed"].includes(payload.status)) {
      throw new PixWebhookAuthError("Sandbox webhook payload is missing required fields.");
    }
    return [
      {
        eventId: payload.eventId,
        txid: payload.txid,
        providerChargeId: null,
        status: payload.status,
        amountBrl: payload.amountBrl ? parseAtomicString(payload.amountBrl) : null,
        paidAt: payload.paidAt ?? Date.now(),
        payerName: payload.payerName ?? null,
        conversion: null,
      },
    ];
  }

  /** Build a signed webhook delivery, as the PSP would send it. Used by simulate-paid and tests. */
  signPayload(payload: SandboxWebhookPayload): { body: string; headers: Headers } {
    const body = JSON.stringify(payload);
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(SANDBOX_SIGNATURE_HEADER, `sha256=${hmacHex(body, this.webhookSecret)}`);
    return { body, headers };
  }
}

function hmacHex(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyHmacSignature(rawBody: string, header: string, secret: string): boolean {
  if (!secret) return false;
  const provided = header.trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = Buffer.from(hmacHex(rawBody, secret), "hex");
  const actual = Buffer.from(provided, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
