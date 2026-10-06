/**
 * Minimal Solana transaction signing without @solana/web3.js.
 *
 * Wire format: compact-u16 signature count, N × 64-byte ed25519 signatures,
 * then the message. Each signature covers the serialized message bytes. The
 * signer for slot i is account key i of the message, for i < numRequiredSignatures.
 *
 * Jupiter may route through gasless/RFQ paths where a market maker pays fees and
 * occupies slot 0, so the taker's slot is located by public key, never assumed.
 */

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX_LENGTH = 12;

export class SolanaTxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaTxError";
  }
}

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) throw new SolanaTxError("Invalid base58 character.");
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

export interface SolanaKeypair {
  publicKey: string;
  privateKey: KeyObject;
}

/** Accepts a base58 64-byte secret (wallet export) or a JSON byte array (solana-keygen). */
export function parseSolanaSecretKey(secret: string): SolanaKeypair {
  const trimmed = secret.trim();
  let bytes: Uint8Array;
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new SolanaTxError("Secret key JSON must be an array of bytes.");
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    bytes = base58Decode(trimmed);
  }
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new SolanaTxError(`Secret key must be 64 (or 32-byte seed) bytes, got ${bytes.length}.`);
  }
  const seed = bytes.slice(0, 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const publicBytes = publicKeyBytes(privateKey);
  if (bytes.length === 64 && !Buffer.from(bytes.slice(32)).equals(publicBytes)) {
    throw new SolanaTxError("Secret key's embedded public key does not match its seed.");
  }
  return { publicKey: base58Encode(publicBytes), privateKey };
}

function publicKeyBytes(privateKey: KeyObject): Buffer {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(SPKI_ED25519_PREFIX_LENGTH));
}

function readCompactU16(bytes: Uint8Array, offset: number): { value: number; size: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= bytes.length) throw new SolanaTxError("Truncated compact-u16.");
    const byte = bytes[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if ((byte & 0x80) === 0) break;
    if (size > 3) throw new SolanaTxError("Invalid compact-u16.");
  }
  return { value, size };
}

export interface ParsedTransaction {
  signatureCount: number;
  signaturesOffset: number;
  messageOffset: number;
  version: "legacy" | 0;
  numRequiredSignatures: number;
  signerKeys: string[];
}

export function parseTransaction(bytes: Uint8Array): ParsedTransaction {
  const sigCount = readCompactU16(bytes, 0);
  const signaturesOffset = sigCount.size;
  const messageOffset = signaturesOffset + sigCount.value * 64;
  if (messageOffset >= bytes.length) throw new SolanaTxError("Transaction has no message.");
  let cursor = messageOffset;
  let version: "legacy" | 0 = "legacy";
  if (bytes[cursor] & 0x80) {
    const declared = bytes[cursor] & 0x7f;
    if (declared !== 0) {
      throw new SolanaTxError(`Unsupported transaction version ${declared}; only legacy and v0 are signed.`);
    }
    version = 0;
    cursor++;
  }
  const numRequiredSignatures = bytes[cursor];
  cursor += 3; // header: required sigs, readonly signed, readonly unsigned
  const keyCount = readCompactU16(bytes, cursor);
  cursor += keyCount.size;
  if (numRequiredSignatures !== sigCount.value) {
    throw new SolanaTxError("Signature slots do not match the message's required signers.");
  }
  if (keyCount.value < numRequiredSignatures || cursor + keyCount.value * 32 > bytes.length) {
    throw new SolanaTxError("Malformed account key section.");
  }
  const signerKeys: string[] = [];
  for (let i = 0; i < numRequiredSignatures; i++) {
    signerKeys.push(base58Encode(bytes.slice(cursor + i * 32, cursor + (i + 1) * 32)));
  }
  return {
    signatureCount: sigCount.value,
    signaturesOffset,
    messageOffset,
    version,
    numRequiredSignatures,
    signerKeys,
  };
}

/**
 * Sign a base64 transaction as `keypair`, writing only that signer's slot.
 * Other slots (e.g. a market maker's) are left for the counterparty to fill.
 */
export function signTransactionBase64(
  transactionBase64: string,
  keypair: SolanaKeypair,
): {
  signedTransaction: string;
  slot: number;
} {
  const bytes = Uint8Array.from(Buffer.from(transactionBase64, "base64"));
  const parsed = parseTransaction(bytes);
  const slot = parsed.signerKeys.indexOf(keypair.publicKey);
  if (slot < 0) throw new SolanaTxError("Our wallet is not a required signer of this transaction.");
  const message = bytes.slice(parsed.messageOffset);
  const signature = sign(null, message, keypair.privateKey);
  bytes.set(signature, parsed.signaturesOffset + slot * 64);
  return { signedTransaction: Buffer.from(bytes).toString("base64"), slot };
}

export function verifySignatureSlot(transactionBase64: string, slot: number, publicKey: string): boolean {
  const bytes = Uint8Array.from(Buffer.from(transactionBase64, "base64"));
  const parsed = parseTransaction(bytes);
  const signature = bytes.slice(parsed.signaturesOffset + slot * 64, parsed.signaturesOffset + (slot + 1) * 64);
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(base58Decode(publicKey))]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verify(null, bytes.slice(parsed.messageOffset), key, signature);
}
