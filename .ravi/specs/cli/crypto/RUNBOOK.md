# Crypto vaults agent-first CLI contract / RUNBOOK

## Sandbox end-to-end (no real money)

```bash
ravi crypto status
ravi crypto deposit 100 --owner contact:<id> --json        # prints a sandbox BR Code
ravi crypto deposits simulate-paid <dep_id> --json          # signed webhook → credit → USDC
ravi crypto balance --owner contact:<id>
ravi crypto trades propose buy TSLAx 5 --unit usd --owner contact:<id>
ravi crypto trades approve <trd_id> --execute               # paper fill at a live quote
ravi crypto history --owner contact:<id>
```

## Enable for an agent (least privilege) — REQUIRED

The agent that talks to the public must reach crypto **only through typed tools**.
Operator checks (no runtime context + interactive TTY) stop prompt injection
through tools and restricted Bash, but nothing at the application layer can stop
an agent that runs arbitrary code (Bash with `node`/`bun`/`python`) as the same OS
user: it could open `crypto.db` or the treasury key directly. So:

- Do NOT give the public-facing agent `full-access`, Bash, or interpreters.
- Grant only the crypto user profile:

```bash
ravi permissions allow crypto-user \
  --capabilities "read:crypto:*,mutate:crypto:deposit,read:crypto.trades:*,mutate:crypto.trades:propose,mutate:crypto.trades:cancel,read:crypto.deposits:*,read:crypto.signals:*,mutate:crypto.signals:scan,read:crypto.strategies:*,read:crypto.vault:*,mutate:crypto.vault:risk-profile,read:crypto.settings:list" \
  --to agent:<id>            # plan first; re-run with --apply
```

- Operator-only commands (`trades approve|reject|reconcile`, `settings set`,
  `deposits simulate-paid`, `vault list|freeze|unfreeze|link`,
  `wallets watch|import|rm`) are not exposed as agent tools and refuse to run
  without an interactive terminal.

## Debug Flow

1. Reproduce with `--json` and read `error.code`.
2. `CRYPTO_OPERATOR_ONLY` / `CRYPTO_OWNER_FLAG_FORBIDDEN`: working as designed
   inside agent sessions; run from a terminal.
3. `CRYPTO_ACTOR_UNRESOLVED`: the turn has no contact actor. Check the contact
   exists and the channel resolves `actorPrincipal` for that sender.
4. Deposit stuck `pending`: check the daemon log for `crypto:webhook`
   (`invalid_signature` → wrong webhook secret; `unknown_deposit` → txid
   mismatch). Webhook URL: `<RAVI_HTTP_URL>/webhooks/crypto/pix/<provider>`.
5. Trade stuck `pending_approval`: `approval.target` unset (approve via CLI) or
   the runner is not on the leader daemon.
6. Trade stuck `approved`: the leader runner retries it after 2 minutes (it was
   never sent). Stuck `executing` with `OUTCOME UNKNOWN`: a live swap was signed
   but not confirmed. Check the tx signature in the trade error on-chain, then
   `ravi crypto trades reconcile <id> --outcome filled --output <amt> --tx <sig> --execute`
   or `--outcome failed --reason "…" --execute`. Never re-propose before reconciling.
7. Deposit `reversal_blocked`: the PSP refunded a Pix whose money was already
   spent; the vault was frozen. Settle with the person, then unfreeze.
8. `MARKET_RATE_LIMITED`: free API tiers; retry, or store a Jupiter key
   (`ravi credentials add --provider jupiter --connection default`).
9. Ledger sanity: every asset in `getLedgerTrialBalance()` must net to zero.

## Going live — checklist (operator)

Do not flip `execution.mode live` until every item is done:

- [ ] Legal/compliance review: custody of third-party funds, Pix↔crypto
      exchange (BACEN/CVM rules), KYC/AML obligations.
- [ ] Pix provider in production with webhook secret in the broker, and
      USDC delivery chain confirmed (Ripio docs list ETHEREUM/POLYGON/BASE;
      Solana must be confirmed with Ripio).
- [ ] Every vault owner linked to a KYC-completed provider customer
      (`ravi crypto vault link`).
- [ ] Treasury wallet: dedicated keypair in the broker (`--provider solana
      --connection treasury`), `live.walletAddress` set, funded with SOL for fees,
      holdings reconciled against the ledger.
- [ ] `approval.target` set to the operator chat; tested approve and reject.
- [ ] Conservative limits: `risk.maxTradeUsd`, `risk.maxDailyUsd`,
      `risk.allowlist` with the exact mints you accept.
- [ ] A small live trade executed and reconciled (tx signature, on-chain
      balances, ledger) before raising limits.
- [ ] Kill switch drill: `ravi crypto settings set risk.killSwitch true`.
- [ ] Reconcile drill on a test trade (filled and failed paths).
- [ ] No vault that ever received sandbox deposits is used live (live trades
      from sandbox-funded vaults are refused; start production on a fresh
      `RAVI_CRYPTO_DB_PATH`).
- [ ] The public-facing agent has only the `crypto-user` profile (no Bash).
