---
id: cli/crypto
title: "Crypto vaults agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - crypto
tags:
  - cli
  - crypto
  - payments
  - pix
  - trading
  - agent-first
  - two-key-approval
  - ledger
applies_to:
  - src/cli/commands/crypto.ts
  - src/cli/commands/crypto-deposits.ts
  - src/cli/commands/crypto-trades.ts
  - src/cli/commands/crypto-signals.ts
  - src/cli/commands/crypto-strategies.ts
  - src/cli/commands/crypto-wallets.ts
  - src/cli/commands/crypto-vault.ts
  - src/cli/commands/crypto-settings.ts
  - src/crypto/
owners:
  - ravi-dev
status: active
normative: true
---
# Crypto vaults agent-first CLI contract

## Intent

`ravi crypto` gives every person who talks to Ravi a private vault: Pix in,
balances in BRL and crypto, trade proposals, and research from Ravi's signal
engines. Money moves through a double-entry ledger, and every trade needs two
independent keys: the vault owner's request and the operator's approval.

## Invariants

1. **Owner = turn actor.** Vault ownership MUST come from the runtime turn
   context (`actorPrincipal` / `contactId`), never from agent-supplied
   arguments. Inside agent runtime, `--owner` MUST be rejected unless it names
   the same actor (`CRYPTO_OWNER_FLAG_FORBIDDEN`, exit 3). Without a resolved
   human actor, vault commands MUST fail with `CRYPTO_ACTOR_UNRESOLVED`.
2. **Operator-only surface.** `trades approve|reject|reconcile`, `settings set`,
   `deposits simulate-paid`, `vault list|freeze|unfreeze|link`,
   `wallets watch|import|rm`, `--owner` and `--all` MUST refuse whenever the
   command runs in agent/tool/gateway context or without an interactive
   terminal (`CRYPTO_OPERATOR_ONLY`, exit 3), and are `@CliOnly` (never agent
   tools). The bash hook MUST deny `env -i/-u/-`, `unset RAVI_*` and `exec -c`
   around `ravi`. Public-facing agents MUST NOT have Bash or interpreters.
3. **No cross-vault disclosure.** Agents asking for another vault's trade or
   deposit id MUST receive the same not-found envelope as for a missing id.
4. **Ledger.** Every movement is a journal whose entries net to zero per
   asset; journals are idempotent on `(kind, refType, refId)`; no `vault:`
   account may go negative. Amounts are atomic-unit integers end to end.
5. **Pix settlement.** Webhooks MUST be authenticated before any side effect;
   a provider can only settle its own charges; the sandbox route is disabled
   unless sandbox is the configured provider; replays are no-ops; the credited
   amount is what the provider reports, capped at the charge; a payment that
   lands after local expiry is still credited; refunds after credit reverse
   the credit and conversion exactly (or freeze the vault if spent). Group
   sessions never receive amounts or vault ids.
6. **Trades.** Proposals MUST pass hard risk limits in code (kill switch,
   per-trade/day USD caps, position fraction, slippage, price impact,
   liquidity or allowlist) and only verified assets are tradable. Approval
   MUST re-run all limits on a fresh quote and re-check the daily cap inside
   the approval transaction; it holds funds atomically with the status change.
   Provable failures release the hold; an ambiguous live outcome (after
   signing) MUST keep the hold and the `executing` status until reconciled.
   Signed transactions are never re-submitted. The execution mode is fixed at
   proposal time; sandbox-funded vaults never execute live.
7. **Jev** is advisory for user requests and a gate for engine signals; any
   error fails closed.
8. Every finite command exposes `--json`; every list paginates; exit codes
   follow `0/1/2/3`.

## Exceptions

- `crypto deposit` writes without `--execute`: creating a Pix charge moves no
  money and is reversible by expiry.
- `crypto trades approve` and `vault freeze`, `wallets rm` use the standard
  dry-run brake (`--execute`).
