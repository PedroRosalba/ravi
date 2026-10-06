/**
 * Inbound crypto webhooks, mounted by the daemon HTTP server:
 *   POST /webhooks/crypto/pix/<provider>  — Pix provider callbacks (signature-verified per provider)
 *   POST /webhooks/crypto/helius          — Helius enhanced transactions for watched wallets
 *
 * Authenticity is checked before any parsing side effects. Unknown deposits
 * still get 200 so providers stop retrying; replays are harmless by design.
 */

import { logger } from "../utils/logger.js";
import { readSetting } from "./config.js";
import { ingestHeliusTransactions, verifyHeliusAuth } from "./engine/helius.js";
import { PIX_PROVIDER_IDS, PixWebhookAuthError, getPixProvider } from "./pix/index.js";
import { processPixEvent } from "./service.js";

const log = logger.child("crypto:webhook");

export const CRYPTO_WEBHOOK_PREFIX = "/webhooks/crypto/";

export interface CryptoWebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export async function handleCryptoWebhook(input: {
  method: string;
  pathname: string;
  headers: Headers;
  rawBody: string;
}): Promise<CryptoWebhookResponse> {
  if (input.method !== "POST") return { status: 405, body: { ok: false, error: "method_not_allowed" } };
  const route = input.pathname.slice(CRYPTO_WEBHOOK_PREFIX.length).replace(/\/+$/, "");

  if (route === "helius") {
    if (!(await verifyHeliusAuth(input.headers.get("authorization")))) {
      return { status: 401, body: { ok: false, error: "unauthorized" } };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(input.rawBody);
    } catch {
      return { status: 400, body: { ok: false, error: "invalid_json" } };
    }
    const result = ingestHeliusTransactions(payload);
    return { status: 200, body: { ok: true, ...result } };
  }

  const pixMatch = /^pix\/([a-z0-9-]+)$/.exec(route);
  if (pixMatch) {
    const providerId = pixMatch[1];
    if (!(PIX_PROVIDER_IDS as readonly string[]).includes(providerId)) {
      return { status: 404, body: { ok: false, error: "unknown_provider" } };
    }
    // Play money must never reach a ledger that is configured for a real provider.
    if (providerId === "sandbox" && readSetting("pix.provider") !== "sandbox") {
      return { status: 404, body: { ok: false, error: "provider_disabled" } };
    }
    let events: Awaited<ReturnType<ReturnType<typeof getPixProvider>["parseWebhook"]>>;
    try {
      events = await getPixProvider(providerId).parseWebhook({ headers: input.headers, rawBody: input.rawBody });
    } catch (error) {
      if (error instanceof PixWebhookAuthError) {
        log.warn("Rejected Pix webhook", { providerId, reason: error.message });
        return { status: 401, body: { ok: false, error: "invalid_signature" } };
      }
      throw error;
    }
    const results = [];
    for (const event of events) {
      const result = await processPixEvent(providerId, event);
      log.info("Pix webhook processed", {
        providerId,
        eventId: event.eventId,
        outcome: result.outcome,
        depositId: result.depositId,
      });
      results.push({ eventId: event.eventId, outcome: result.outcome, depositId: result.depositId });
    }
    return { status: 200, body: { ok: true, results } };
  }

  return { status: 404, body: { ok: false, error: "not_found" } };
}
