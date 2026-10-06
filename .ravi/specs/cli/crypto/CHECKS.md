# Crypto vaults agent-first CLI contract / CHECKS

## Checks

- Inside agent runtime, `crypto trades approve <id> --execute` MUST exit 3 with
  `CRYPTO_OPERATOR_ONLY` and MUST NOT change the trade.
- Inside agent runtime with actor `contact:B`, `crypto balance --owner
  contact:A` MUST exit 3 with `CRYPTO_OWNER_FLAG_FORBIDDEN`.
- Inside agent runtime without a human actor, `crypto deposit <amount>` MUST
  fail with `CRYPTO_ACTOR_UNRESOLVED` and MUST NOT open a vault.
- Replaying a signed Pix webhook MUST return outcome `duplicate` and MUST NOT
  change balances; a forged signature MUST return HTTP 401; a webhook from
  provider X for a charge of provider Y MUST return `provider_mismatch`.
- A journal that does not net to zero per asset, or would overdraw a vault,
  MUST be rejected with nothing written.
- A trade whose fresh fill is below the approved minimum MUST end `failed` with
  the held funds back in the vault, and the ledger trial balance MUST be zero.
- Switching `execution.mode` between proposal and approval MUST fail the trade.
- `crypto trades approve` without `--execute` MUST exit 3 with `dryRun: true`.

## Validation

```bash
bun test src/crypto src/cli/commands/crypto.test.ts
bun test src/cli/commands/json-coverage.test.ts src/cli/commands/pagination-coverage.test.ts
```
