import "reflect-metadata";
import { settingsListReturnSchema, settingsSetReturnSchema } from "../../crypto/return-schemas.js";
import { contractFail } from "../agent-contract.js";
import { CliOnly, Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { assertOperator, printJsonOr } from "../../crypto/cli-support.js";
import { getSettingSpec, listSettings, writeSetting } from "../../crypto/config.js";

@Group({
  name: "crypto.settings",
  description: "Crypto gateway configuration (limits, providers, execution mode)",
  scope: "open",
})
export class CryptoSettingsCommands {
  @Command({ name: "list", description: "Show every crypto setting with its value and description" })
  @CommandAccess({ kind: "read", resource: "crypto.settings", action: "list", risk: "low" })
  @Returns(settingsListReturnSchema)
  async list(
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const page = paginateCliItems(listSettings(), { limit, offset });
    const items = page.items;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crypto", "settings", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: items.length,
      total: page.total,
    });
    const payload = { total: page.total, pagination, items };
    printJsonOr(asJson, payload, () => {
      for (const item of items) {
        console.log(
          `  ${item.key.padEnd(26)} ${String(item.value || "(empty)").padEnd(46)} ${item.isDefault ? " " : "*"} ${item.description}`,
        );
      }
      console.log("\n  * = changed from default");
    });
    return payload;
  }

  @Command({
    name: "set",
    description: "OPERATOR ONLY: change a setting (agents can never raise limits or switch to live)",
    helpAfter: `
EXAMPLES
  ravi crypto settings set risk.maxTradeUsd 250
  ravi crypto settings set approval.target '{"channel":"whatsapp","accountId":"main","chatId":"5511999999999"}'
  ravi crypto settings set jev.enabled true
  ravi crypto settings set risk.killSwitch true          # halt all trading immediately
  ravi crypto settings set execution.mode live           # only after the live checklist in the crypto skill
  ravi crypto settings set risk.allowlist ""             # reset to default with --reset instead:
  ravi crypto settings set risk.allowlist --reset`,
  })
  @CommandAccess({ kind: "mutate", resource: "crypto.settings", action: "set", risk: "high" })
  @CliOnly()
  @Returns(settingsSetReturnSchema)
  async set(
    @Arg("key", { description: "Setting key (see `ravi crypto settings list`)" }) key: string,
    @Arg("value", { description: "New value", required: false }) value?: string,
    @Option({ flags: "--reset", description: "Restore the default value" }) reset?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto settings set";
    assertOperator(op, asJson);
    if (!getSettingSpec(key)) {
      return contractFail(op, "CRYPTO_UNKNOWN_SETTING", `Unknown setting: ${key}`, {
        asJson,
        exitCode: 2,
        details: { suggestedAction: "See `ravi crypto settings list`." },
      });
    }
    if (!reset && value === undefined) {
      return contractFail(op, "CRYPTO_INVALID_ARGUMENT", "Pass a value or --reset.", { asJson, exitCode: 2 });
    }
    try {
      const result = writeSetting(key, reset ? null : (value as string));
      printJsonOr(asJson, result, () => console.log(`\n✓ ${result.key} = ${result.value}`));
      return result;
    } catch (error) {
      return contractFail(op, "CRYPTO_INVALID_ARGUMENT", error instanceof Error ? error.message : String(error), {
        asJson,
        exitCode: 2,
      });
    }
  }
}
