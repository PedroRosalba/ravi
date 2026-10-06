import { getSandboxWebhookSecret, readSetting } from "../config.js";
import { RipioPixProvider } from "./ripio.js";
import { SandboxPixProvider } from "./sandbox.js";
import type { PixProvider } from "./types.js";

const overrides = new Map<string, PixProvider>();

/** Provider by id (webhook routing) or the configured default (new charges). */
export function getPixProvider(id?: string): PixProvider {
  const providerId = id ?? readSetting("pix.provider");
  const override = overrides.get(providerId);
  if (override) return override;
  switch (providerId) {
    case "sandbox":
      return new SandboxPixProvider(getSandboxWebhookSecret());
    case "ripio":
      return new RipioPixProvider();
    default:
      throw new Error(`Unknown Pix provider: ${providerId}`);
  }
}

export function setPixProviderForTest(id: string, provider: PixProvider | null): void {
  if (provider) overrides.set(id, provider);
  else overrides.delete(id);
}

export const PIX_PROVIDER_IDS = ["sandbox", "ripio"] as const;

export * from "./types.js";
