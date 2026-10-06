import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  SolanaTxError,
  base58Decode,
  base58Encode,
  parseSolanaSecretKey,
  parseTransaction,
  signTransactionBase64,
  verifySignatureSlot,
} from "./solana.js";

function newSecret(): { secret: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const probe = parseSolanaSecretKey(base58Encode(seed));
  const full = Uint8Array.from([...seed, ...base58Decode(probe.publicKey)]);
  return { secret: base58Encode(full), publicKey: probe.publicKey };
}

/** Build an unsigned v0 tx whose required signers are `signers` (in order). */
function buildV0(signers: string[], version = 0x80): string {
  const message = [
    version,
    signers.length,
    0,
    1,
    signers.length + 1,
    ...signers.flatMap((key) => [...base58Decode(key)]),
    ...new Array(32).fill(7), // program id
    ...new Array(32).fill(9), // recent blockhash
    0, // no instructions
    0, // no address table lookups
  ];
  const bytes = [signers.length, ...new Array(signers.length * 64).fill(0), ...message];
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

describe("solana signing", () => {
  it("round-trips base58 including leading zeros", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    expect(base58Encode(base58Decode("11111111111111111111111111111111"))).toBe("11111111111111111111111111111111");
  });

  it("parses base58 and JSON secret keys and rejects mismatched pairs", () => {
    const { secret, publicKey } = newSecret();
    expect(parseSolanaSecretKey(secret).publicKey).toBe(publicKey);
    expect(parseSolanaSecretKey(JSON.stringify([...base58Decode(secret)])).publicKey).toBe(publicKey);
    const tampered = base58Decode(secret);
    tampered[40] ^= 1;
    expect(() => parseSolanaSecretKey(base58Encode(tampered))).toThrow(SolanaTxError);
  });

  it("signs the taker's slot when a market maker pays fees (slot 0)", () => {
    const taker = newSecret();
    const maker = newSecret();
    const tx = buildV0([maker.publicKey, taker.publicKey]);
    expect(parseTransaction(Buffer.from(tx, "base64")).signerKeys).toEqual([maker.publicKey, taker.publicKey]);
    const { signedTransaction, slot } = signTransactionBase64(tx, parseSolanaSecretKey(taker.secret));
    expect(slot).toBe(1);
    expect(verifySignatureSlot(signedTransaction, 1, taker.publicKey)).toBe(true);
    // Maker slot stays empty for the counterparty.
    const bytes = Buffer.from(signedTransaction, "base64");
    expect(bytes.subarray(1, 65).every((b) => b === 0)).toBe(true);
  });

  it("refuses transactions we are not a signer of, and v1 format", () => {
    const taker = newSecret();
    const other = newSecret();
    expect(() => signTransactionBase64(buildV0([other.publicKey]), parseSolanaSecretKey(taker.secret))).toThrow(
      /not a required signer/,
    );
    expect(() => signTransactionBase64(buildV0([taker.publicKey], 0x81), parseSolanaSecretKey(taker.secret))).toThrow(
      /Unsupported transaction version/,
    );
  });
});
