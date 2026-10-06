import "reflect-metadata";
import { vaultListReturnSchema, vaultReturnSchema } from "../../crypto/return-schemas.js";
import { contractDryRun, contractFail } from "../agent-contract.js";
import { CliOnly, Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { buildCliOffsetPagination, parseCliListLimit, parseCliListOffset } from "../pagination.js";
import { assertOperator, printJsonOr, requireCallerVault, requireVaultById } from "../../crypto/cli-support.js";
import { getCryptoSetting, listVaults, setCryptoSetting, updateVault } from "../../crypto/db.js";
import { ripioCustomerSettingKey } from "../../crypto/pix/ripio.js";
import type { CryptoVault, RiskProfile } from "../../crypto/types.js";

const PROFILES: RiskProfile[] = ["conservative", "moderate", "aggressive"];

function publicVault(vault: CryptoVault) {
  return {
    id: vault.id,
    owner: `${vault.ownerType}:${vault.ownerId}`,
    status: vault.status,
    riskProfile: vault.riskProfile,
    ripioCustomerLinked: Boolean(getCryptoSetting(ripioCustomerSettingKey(vault.id))),
    createdAt: new Date(vault.createdAt).toISOString(),
  };
}

@Group({
  name: "crypto.vault",
  description: "The sender's vault settings; operator administration of vaults",
  scope: "open",
})
export class CryptoVaultCommands {
  @Command({ name: "show", description: "Show the sender's vault (status, risk profile, KYC link)" })
  @CommandAccess({ kind: "read", resource: "crypto.vault", action: "show", risk: "low" })
  @Returns(vaultReturnSchema)
  async show(
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id>" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { vault } = requireCallerVault("crypto vault show", { owner, asJson });
    const payload = { vault: publicVault(vault) };
    printJsonOr(asJson, payload, () => console.log(JSON.stringify(payload.vault, null, 2)));
    return payload;
  }

  @Command({
    name: "risk-profile",
    description: "Set the sender's risk profile (caps position sizing): conservative | moderate | aggressive",
  })
  @CommandAccess({ kind: "mutate", resource: "crypto.vault", action: "risk-profile", risk: "low" })
  @Returns(vaultReturnSchema)
  async riskProfile(
    @Arg("profile", { description: PROFILES.join("|") }) profile: string,
    @Option({ flags: "--owner <ref>", description: "Operator only: contact:<id>" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto vault risk-profile";
    if (!PROFILES.includes(profile as RiskProfile)) {
      contractFail(op, "CRYPTO_INVALID_ARGUMENT", `Invalid profile. Use ${PROFILES.join("|")}.`, {
        asJson,
        exitCode: 2,
      });
    }
    const { vault } = requireCallerVault(op, { owner, asJson });
    const payload = { vault: publicVault(updateVault(vault.id, { riskProfile: profile as RiskProfile })) };
    printJsonOr(asJson, payload, () => console.log(`\n✓ Risk profile set to ${profile}`));
    return payload;
  }

  @Command({ name: "list", description: "OPERATOR ONLY: list all vaults", aliases: ["ls"] })
  @CommandAccess({ kind: "read", resource: "crypto.vault", action: "list", risk: "low" })
  @CliOnly()
  @Returns(vaultListReturnSchema)
  async list(
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    assertOperator("crypto vault list", asJson);
    const pageLimit = parseCliListLimit(limit);
    const pageOffset = parseCliListOffset(offset);
    const page = listVaults({ limit: pageLimit, offset: pageOffset });
    const items = page.items.map(publicVault);
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crypto", "vault", "list"],
      limit: pageLimit,
      offset: pageOffset,
      returned: items.length,
      total: page.total,
    });
    const payload = { total: page.total, pagination, items };
    printJsonOr(asJson, payload, () => {
      console.log(`\n${page.total} vault(s)`);
      for (const v of items) console.log(`  ${v.id}  ${v.owner.padEnd(30)} ${v.status.padEnd(7)} ${v.riskProfile}`);
    });
    return payload;
  }

  @Command({
    name: "freeze",
    description: "OPERATOR ONLY: freeze a vault (blocks deposits and trades; dry-run by default)",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "crypto.vault",
    action: "freeze",
    risk: "high",
    requiresConfirmation: true,
  })
  @CliOnly()
  @Returns(vaultReturnSchema)
  async freeze(
    @Arg("vaultId", { description: "Vault id (vlt_…)" }) vaultId: string,
    @Option({ flags: "--execute", description: "Actually freeze" }) execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto vault freeze";
    assertOperator(op, asJson);
    const vault = requireVaultById(op, vaultId, asJson);
    if (execute !== true) contractDryRun(op, { vault: publicVault(vault), status: "frozen" }, { asJson });
    const payload = { vault: publicVault(updateVault(vault.id, { status: "frozen" })) };
    printJsonOr(asJson, payload, () => console.log(`\n✓ Vault ${vault.id} frozen`));
    return payload;
  }

  @Command({ name: "unfreeze", description: "OPERATOR ONLY: reactivate a frozen vault" })
  @CommandAccess({ kind: "mutate", resource: "crypto.vault", action: "unfreeze", risk: "medium" })
  @CliOnly()
  @Returns(vaultReturnSchema)
  async unfreeze(
    @Arg("vaultId", { description: "Vault id (vlt_…)" }) vaultId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto vault unfreeze";
    assertOperator(op, asJson);
    const vault = requireVaultById(op, vaultId, asJson);
    const payload = { vault: publicVault(updateVault(vault.id, { status: "active" })) };
    printJsonOr(asJson, payload, () => console.log(`\n✓ Vault ${vault.id} active`));
    return payload;
  }

  @Command({
    name: "link",
    description: "OPERATOR ONLY: link a vault to its KYC'd Ripio customer id (required for Ripio Pix charges)",
  })
  @CommandAccess({ kind: "mutate", resource: "crypto.vault", action: "link", risk: "medium" })
  @CliOnly()
  @Returns(vaultReturnSchema)
  async link(
    @Arg("vaultId", { description: "Vault id (vlt_…)" }) vaultId: string,
    @Option({ flags: "--ripio-customer <id>", description: "Ripio customerId with KYC COMPLETED" })
    ripioCustomer?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "crypto vault link";
    assertOperator(op, asJson);
    const vault = requireVaultById(op, vaultId, asJson);
    if (!ripioCustomer?.trim()) {
      return contractFail(op, "CRYPTO_INVALID_ARGUMENT", "Pass --ripio-customer <id>.", { asJson, exitCode: 2 });
    }
    setCryptoSetting(ripioCustomerSettingKey(vault.id), ripioCustomer.trim());
    const payload = { vault: publicVault(vault) };
    printJsonOr(asJson, payload, () => console.log(`\n✓ Vault ${vault.id} linked to Ripio customer`));
    return payload;
  }
}
