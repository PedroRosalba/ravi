import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCryptoDb } from "./db.js";

/** Give every test in the file its own crypto DB file. */
export function withTempCryptoDb(): { dir: () => string } {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ravi-crypto-"));
    process.env.RAVI_CRYPTO_DB_PATH = join(dir, "crypto.db");
    process.env.RAVI_CRYPTO_SANDBOX_WEBHOOK_SECRET = "test-sandbox-secret";
    closeCryptoDb();
  });
  afterEach(() => {
    closeCryptoDb();
    delete process.env.RAVI_CRYPTO_DB_PATH;
    delete process.env.RAVI_CRYPTO_SANDBOX_WEBHOOK_SECRET;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir: () => dir };
}
