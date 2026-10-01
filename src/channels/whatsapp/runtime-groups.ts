/**
 * Baileys `GroupMetadata` → RPC result mappers (`WhatsAppRpcResults` in contract.ts).
 */

import type { GroupMetadata, GroupParticipant } from "baileys";
import type {
  WhatsAppRpcGroupMetadata,
  WhatsAppRpcGroupMetadataParticipant,
  WhatsAppRpcGroupRecord,
} from "./contract.js";
import { isLidJid, isUserJid } from "./lib/jid.js";

/** Omni `fetchGroups` / `groupCreate` shape, as the Omni REST API listed groups. */
export function toGroupRecord(metadata: GroupMetadata): WhatsAppRpcGroupRecord {
  const participants = (metadata.participants ?? []).map((participant) => ({
    id: participant.id,
    admin: participant.admin ?? null,
  }));
  return {
    id: metadata.id,
    externalId: metadata.id,
    subject: metadata.subject ?? "",
    name: metadata.subject ?? "",
    ...(metadata.owner ? { owner: metadata.owner } : {}),
    ...(metadata.creation !== undefined ? { creation: metadata.creation } : {}),
    participants,
    memberCount: metadata.size ?? participants.length,
    isCommunity: metadata.isCommunity === true,
  };
}

/** Case-insensitive subject/JID filter plus limit (Omni `GET /instances/:id/groups`). */
export function filterGroupRecords(
  records: WhatsAppRpcGroupRecord[],
  options: { search?: string; limit?: number },
): WhatsAppRpcGroupRecord[] {
  const search = options.search?.trim().toLowerCase();
  const filtered = search
    ? records.filter(
        (record) => record.subject.toLowerCase().includes(search) || record.id.toLowerCase().includes(search),
      )
    : records;
  return options.limit !== undefined ? filtered.slice(0, options.limit) : filtered;
}

/** Omni `fetchGroupMembers` role (`admin ?? 'member'`) with `superadmin` mapped to ravi's `owner`. */
export function participantRole(participant: Pick<GroupParticipant, "admin">): "owner" | "admin" | "member" {
  if (participant.admin === "superadmin") return "owner";
  if (participant.admin === "admin") return "admin";
  return "member";
}

export interface GroupMetadataNameLookup {
  /** Display name for a participant JID (contacts/chat-name caches), if known. */
  nameFor(jid: string): string | undefined;
  /** Phone JID for a LID participant (LID mapping cache), if known. */
  phoneJidFor(lidJid: string): string | undefined;
}

export function toGroupMetadataResult(
  groupJid: string,
  metadata: GroupMetadata,
  fetchedAt: number,
  lookup: GroupMetadataNameLookup,
): WhatsAppRpcGroupMetadata {
  return {
    groupJid,
    subject: metadata.subject ?? null,
    description: metadata.desc ?? null,
    owner: metadata.owner ?? null,
    participants: (metadata.participants ?? []).map((participant) => toMetadataParticipant(participant, lookup)),
    fetchedAt,
  };
}

function toMetadataParticipant(
  participant: GroupParticipant,
  lookup: GroupMetadataNameLookup,
): WhatsAppRpcGroupMetadataParticipant {
  const phoneJid =
    participant.phoneNumber ??
    (isUserJid(participant.id)
      ? participant.id
      : isLidJid(participant.id)
        ? lookup.phoneJidFor(participant.id)
        : undefined);
  const phoneNumber = phoneJid ? phoneJid.split("@")[0]?.split(":")[0] : undefined;
  const displayName =
    (phoneJid ? lookup.nameFor(phoneJid) : undefined) ??
    lookup.nameFor(participant.id) ??
    participant.name ??
    participant.notify;
  return {
    platformUserId: participant.id,
    phoneJid: phoneJid ?? null,
    phoneNumber: phoneNumber || null,
    displayName: displayName ?? null,
    role: participantRole(participant),
  };
}
