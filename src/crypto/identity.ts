/**
 * Who is asking? Vault ownership is derived from the runtime turn context —
 * the human whose message started the turn — never from agent-supplied
 * arguments. In a group chat where Ravi was @mentioned, this is the sender,
 * not the group, so each person only ever reaches their own vault.
 */

import { getContext, hasRuntimeInvocationContext } from "../cli/context.js";
import { parseAuthorityPrincipal } from "../permissions/delegation.js";
import type { NotificationTarget, VaultOwner } from "./types.js";

export interface CryptoCaller {
  /** Human owner resolved from the runtime turn (null when the turn has no human actor). */
  actor: VaultOwner | null;
  /** True when invoked by an agent/tool/gateway (as opposed to an operator shell). */
  agentRuntime: boolean;
  agentId: string | null;
  sessionName: string | null;
  notify: NotificationTarget;
}

export function resolveCryptoCaller(): CryptoCaller {
  const ctx = getContext();
  const agentRuntime = hasRuntimeInvocationContext();
  const metadata = (ctx?.context?.metadata ?? {}) as Record<string, unknown>;

  let actor: VaultOwner | null = null;
  const principal = parseAuthorityPrincipal(metadata.actorPrincipal);
  if (principal?.subjectType === "contact") {
    actor = { type: "contact", id: principal.subjectId };
  } else if (metadata.actorType === "contact" && typeof metadata.contactId === "string" && metadata.contactId.trim()) {
    actor = { type: "contact", id: metadata.contactId.trim() };
  } else if (!ctx?.context) {
    const legacy = process.env.RAVI_CONTACT_ID?.trim();
    if (legacy) actor = { type: "contact", id: legacy };
  }

  const sessionName = ctx?.sessionName ?? ctx?.context?.sessionName ?? null;
  const source = ctx?.source
    ? {
        channel: ctx.source.channel,
        accountId: ctx.source.accountId,
        chatId: ctx.source.chatId,
        ...(ctx.source.instanceId ? { instanceId: ctx.source.instanceId } : {}),
        ...(ctx.source.threadId ? { threadId: ctx.source.threadId } : {}),
      }
    : null;

  return {
    actor,
    agentRuntime,
    agentId: ctx?.agentId ?? ctx?.context?.agentId ?? null,
    sessionName,
    notify: { sessionName, source, private: isPrivateChat(metadata, Boolean(ctx?.context)) },
  };
}

/** Only a 1:1 DM counts as private; unknown defaults to "not private" so amounts never leak to groups. */
function isPrivateChat(metadata: Record<string, unknown>, hasContextRecord: boolean): boolean {
  if (hasContextRecord) return metadata.compartmentType === "dm";
  return !process.env.RAVI_GROUP_ID && Boolean(process.env.RAVI_SENDER_ID);
}

export function parseOwnerRef(ref: string): VaultOwner | null {
  const principal = parseAuthorityPrincipal(ref.trim());
  if (!principal) return null;
  return { type: principal.subjectType, id: principal.subjectId };
}

export function formatOwner(owner: VaultOwner): string {
  return `${owner.type}:${owner.id}`;
}

export type OwnerResolution =
  | { ok: true; owner: VaultOwner; via: "actor" | "operator-flag" }
  | {
      ok: false;
      code: "CRYPTO_ACTOR_UNRESOLVED" | "CRYPTO_OWNER_FLAG_FORBIDDEN" | "CRYPTO_OWNER_INVALID";
      message: string;
    };

/**
 * Resolve the vault owner for a command.
 * - Agent runtime: always the turn actor. `--owner` is accepted only when it
 *   names that same actor (so prompts cannot redirect to another person's vault).
 * - Operator shell: `--owner contact:<id>` is required unless an actor exists.
 */
export function resolveVaultOwner(caller: CryptoCaller, ownerFlag?: string): OwnerResolution {
  const requested = ownerFlag?.trim() ? parseOwnerRef(ownerFlag) : null;
  if (ownerFlag?.trim() && !requested) {
    return { ok: false, code: "CRYPTO_OWNER_INVALID", message: `Invalid --owner "${ownerFlag}". Use contact:<id>.` };
  }

  if (caller.agentRuntime) {
    if (!caller.actor) {
      return {
        ok: false,
        code: "CRYPTO_ACTOR_UNRESOLVED",
        message:
          "Could not identify the human who sent this message, so no vault can be used. Ask the person to message from a registered contact.",
      };
    }
    if (requested && formatOwner(requested) !== formatOwner(caller.actor)) {
      return {
        ok: false,
        code: "CRYPTO_OWNER_FLAG_FORBIDDEN",
        message: "Agents can only act on the vault of the person who sent the current message.",
      };
    }
    return { ok: true, owner: caller.actor, via: "actor" };
  }

  if (requested) return { ok: true, owner: requested, via: "operator-flag" };
  if (caller.actor) return { ok: true, owner: caller.actor, via: "actor" };
  return {
    ok: false,
    code: "CRYPTO_ACTOR_UNRESOLVED",
    message: "No message sender in context. Operators must pass --owner contact:<id>.",
  };
}
