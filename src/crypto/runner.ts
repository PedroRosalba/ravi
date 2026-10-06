/**
 * Daemon-side crypto runner (leader only):
 * - On `ravi.crypto.trade.proposed`, asks the operator through the approval
 *   service (a dedicated message; a reaction/button decides). The approval
 *   service verifies the reacting user server-side (admin on system:*), so an
 *   agent can never approve its own proposal.
 * - Every minute, expires stale Pix charges and trade proposals.
 *
 * Without `approval.target` configured, proposals wait for
 * `ravi crypto trades approve <id> --execute` from an operator shell.
 */

import { logger } from "../utils/logger.js";
import { getApprovalTarget, readNumberSetting } from "./config.js";
import { getTrade } from "./db.js";
import { CRYPTO_TOPIC_PREFIX } from "./notify.js";
import {
  CryptoServiceError,
  decideTrade,
  describeTradeForApproval,
  sweepExpired,
  sweepStaleTrades,
} from "./service.js";
import { getCryptoNotifier } from "./notify.js";

const log = logger.child("crypto:runner");
const SWEEP_INTERVAL_MS = 60_000;

let running = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let subscription: AsyncGenerator<{ topic: string; data: Record<string, unknown> }> | null = null;
const inFlight = new Set<string>();
const reportedStuck = new Set<string>();

/** Retry never-sent approved trades; alert once per trade stuck in executing. */
export async function runStuckTradeSweep(now = Date.now()): Promise<{ retried: string[]; alerted: string[] }> {
  const { retried, stuck } = await sweepStaleTrades(now);
  const alerted: string[] = [];
  for (const tradeId of stuck) {
    if (reportedStuck.has(tradeId)) continue;
    reportedStuck.add(tradeId);
    alerted.push(tradeId);
    log.warn("Trade stuck in executing; operator must reconcile", { tradeId });
    await getCryptoNotifier().publish("trade.stuck", { tradeId, status: "executing" });
  }
  if (retried.length > 0) log.info("Retried stale approved trades", { retried });
  return { retried, alerted };
}

export async function startCryptoRunner(): Promise<void> {
  if (running) return;
  running = true;
  sweepTimer = setInterval(() => {
    sweepExpired().catch((error) => log.warn("Expiry sweep failed", { error }));
    runStuckTradeSweep().catch((error) => log.warn("Stale trade sweep failed", { error }));
  }, SWEEP_INTERVAL_MS);
  void listen();
  log.info("Crypto runner started");
}

export async function stopCryptoRunner(): Promise<void> {
  running = false;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  await subscription?.return(undefined);
  subscription = null;
}

async function listen(): Promise<void> {
  const { subscribe } = await import("../nats.js");
  subscription = subscribe(`${CRYPTO_TOPIC_PREFIX}.trade.proposed`);
  try {
    for await (const message of subscription) {
      if (!running) break;
      const tradeId = typeof message.data.tradeId === "string" ? message.data.tradeId : null;
      if (tradeId) void requestOperatorApproval(tradeId);
    }
  } catch (error) {
    if (running) log.error("Crypto runner subscription ended", { error });
  }
}

export async function requestOperatorApproval(
  tradeId: string,
  deps: {
    requestApproval?: typeof import("../approval/service.js").requestApproval;
  } = {},
): Promise<"approved" | "rejected" | "skipped"> {
  if (inFlight.has(tradeId)) return "skipped";
  const target = getApprovalTarget();
  const trade = getTrade(tradeId);
  if (!target || !trade || trade.status !== "pending_approval") return "skipped";
  inFlight.add(tradeId);
  try {
    const requestApproval = deps.requestApproval ?? (await import("../approval/service.js")).requestApproval;
    const timeoutMs = Math.min(
      readNumberSetting("approval.timeoutMinutes") * 60_000,
      Math.max(0, trade.expiresAt - Date.now()),
    );
    const result = await requestApproval(target, `Aprovar trade de cripto?\n${describeTradeForApproval(trade)}`, {
      timeoutMs,
      type: "permission",
      agentId: "crypto",
      sessionName: trade.notify?.sessionName ?? undefined,
    });
    const decision = result.approved ? "approve" : "reject";
    try {
      await decideTrade(tradeId, {
        decision,
        decidedBy: "approval-service",
        via: target.channel === "slack" ? "slack" : "reaction",
        reason: result.approved ? null : (result.reason ?? "não aprovado"),
      });
    } catch (error) {
      // Someone decided first (e.g. operator CLI) or it expired: nothing to do.
      if (!(error instanceof CryptoServiceError)) throw error;
      log.info("Trade decision skipped", { tradeId, code: error.code });
    }
    return result.approved ? "approved" : "rejected";
  } catch (error) {
    log.error("Operator approval flow failed", { tradeId, error });
    return "skipped";
  } finally {
    inFlight.delete(tradeId);
  }
}
