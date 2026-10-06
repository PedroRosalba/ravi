import { describe, expect, it } from "bun:test";
import { buildPixBrCode, crc16Ccitt, isValidBrCodeCrc, parseEmvFields } from "./emv.js";
import { SANDBOX_PIX_KEY, SandboxPixProvider } from "./sandbox.js";
import { PixWebhookAuthError } from "./types.js";

describe("pix BR Code", () => {
  it("matches the CRC16/CCITT-FALSE check vector", () => {
    expect(crc16Ccitt("123456789")).toBe("29B1");
  });

  it("encodes a dynamic charge with amount, txid and valid CRC", () => {
    const code = buildPixBrCode({
      pixKey: "chave@exemplo.com",
      merchantName: "Ravi Câmbio Ltda",
      merchantCity: "São Paulo",
      amountBrl: 12_345n,
      txid: "RAVI123",
    });
    expect(isValidBrCodeCrc(code)).toBe(true);
    const fields = parseEmvFields(code);
    expect(fields.get("00")).toBe("01");
    expect(fields.get("53")).toBe("986");
    expect(fields.get("54")).toBe("123.45");
    expect(fields.get("59")).toBe("RAVI CAMBIO LTDA");
    expect(fields.get("60")).toBe("SAO PAULO");
    expect(parseEmvFields(fields.get("26") as string).get("01")).toBe("chave@exemplo.com");
    expect(parseEmvFields(fields.get("62") as string).get("05")).toBe("RAVI123");
  });

  it("detects tampering through the CRC", () => {
    const code = buildPixBrCode({ pixKey: "k", merchantName: "x", merchantCity: "y", amountBrl: 100n, txid: "A" });
    expect(isValidBrCodeCrc(code.replace("1.00", "9.00"))).toBe(false);
  });
});

describe("sandbox pix provider", () => {
  const provider = new SandboxPixProvider("test-secret");

  it("creates charges bound to the unresolvable sandbox key", async () => {
    const charge = await provider.createCharge({
      txid: "RAVITEST1",
      amountBrl: 5_000n,
      description: "deposito",
      expiresInSeconds: 600,
      vaultId: "vlt_1",
      targetAssetId: null,
    });
    const account = parseEmvFields(parseEmvFields(charge.copyPaste).get("26") as string);
    expect(account.get("01")).toBe(SANDBOX_PIX_KEY);
    expect(charge.expiresAt).toBeGreaterThan(Date.now());
  });

  it("accepts correctly signed webhooks and rejects forged ones", async () => {
    const delivery = provider.signPayload({
      eventId: "evt_1",
      txid: "RAVITEST1",
      status: "paid",
      amountBrl: "5000",
      paidAt: 1,
      payerName: "Fulano",
    });
    const [event] = await provider.parseWebhook({ headers: delivery.headers, rawBody: delivery.body });
    expect(event).toMatchObject({ eventId: "evt_1", txid: "RAVITEST1", status: "paid", amountBrl: 5_000n });

    const forged = delivery.body.replace("5000", "500000");
    await expect(provider.parseWebhook({ headers: delivery.headers, rawBody: forged })).rejects.toBeInstanceOf(
      PixWebhookAuthError,
    );
    await expect(
      new SandboxPixProvider("other-secret").parseWebhook({ headers: delivery.headers, rawBody: delivery.body }),
    ).rejects.toBeInstanceOf(PixWebhookAuthError);
  });
});
