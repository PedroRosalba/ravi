/**
 * Pix BR Code ("copia e cola") encoder — EMV® QRCPS merchant-presented format
 * as specified by the Banco Central do Brasil manual.
 */

import { formatAtomic } from "../money.js";

function field(id: string, value: string): string {
  if (value.length > 99) throw new Error(`EMV field ${id} too long (${value.length}).`);
  return `${id}${value.length.toString().padStart(2, "0")}${value}`;
}

/** CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF), uppercase hex. */
export function crc16Ccitt(payload: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Strip accents and characters banks reject in merchant name/city fields. */
function sanitizeText(value: string, max: number): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 .-]/g, "")
    .trim()
    .slice(0, max)
    .toUpperCase();
}

export interface BrCodeInput {
  pixKey: string;
  merchantName: string;
  merchantCity: string;
  /** Amount in centavos. */
  amountBrl?: bigint;
  /** Up to 25 alphanumeric chars; "***" means no txid. */
  txid?: string;
  description?: string;
}

export function buildPixBrCode(input: BrCodeInput): string {
  const txid = (input.txid ?? "***").replace(/[^A-Za-z0-9*]/g, "").slice(0, 25) || "***";
  const merchantAccount =
    field("00", "br.gov.bcb.pix") +
    field("01", input.pixKey) +
    (input.description ? field("02", sanitizeText(input.description, 40)) : "");
  let payload =
    field("00", "01") + field("01", "12") + field("26", merchantAccount) + field("52", "0000") + field("53", "986");
  if (input.amountBrl !== undefined) {
    if (input.amountBrl <= 0n) throw new Error("Pix amount must be positive.");
    payload += field("54", formatAtomic(input.amountBrl, 2, { minFractionDigits: 2 }));
  }
  payload +=
    field("58", "BR") +
    field("59", sanitizeText(input.merchantName, 25) || "RAVI") +
    field("60", sanitizeText(input.merchantCity, 15) || "SAO PAULO") +
    field("62", field("05", txid));
  payload += "6304";
  return payload + crc16Ccitt(payload);
}

/** Parse top-level EMV fields (used by tests and to validate provider payloads). */
export function parseEmvFields(payload: string): Map<string, string> {
  const fields = new Map<string, string>();
  let index = 0;
  while (index + 4 <= payload.length) {
    const id = payload.slice(index, index + 2);
    const length = Number(payload.slice(index + 2, index + 4));
    if (!Number.isInteger(length)) break;
    fields.set(id, payload.slice(index + 4, index + 4 + length));
    index += 4 + length;
  }
  return fields;
}

export function isValidBrCodeCrc(payload: string): boolean {
  if (payload.length < 8 || payload.slice(-8, -4) !== "6304") return false;
  return crc16Ccitt(payload.slice(0, -4)) === payload.slice(-4).toUpperCase();
}
