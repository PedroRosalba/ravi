# Crypto vaults agent-first CLI contract / WHY

This is the first Ravi domain where a bad tool call moves somebody's money, and
the caller is a language model that reads untrusted text all day (group chats,
token names, on-chain metadata). So the contract assumes the agent can be
talked into anything and puts every money-moving decision where a prompt
cannot reach:

- **Identity comes from the runtime, not the agent.** In a group where Ravi is
  @mentioned, "show Alice's balance" typed by Mallory must not work. The vault
  is resolved from the turn's actor principal, which the runtime sets from the
  inbound message; the agent cannot pass someone else's id.
- **Two keys per trade.** The owner can only *propose*; the operator approves
  through the approval service (a reaction on a dedicated message, approver
  verified server-side) or from a terminal. The approve command refuses to run
  inside any agent context, so even a full-access agent cannot self-approve.
- **Limits in code, not in prompts.** Risk caps are evaluated at proposal and
  re-checked at execution; Jev and the engines can only make a trade *less*
  likely, never bypass a limit.
- **A ledger, not a balance column.** Derived balances, zero-sum journals and
  idempotent refs make webhook retries, double approvals and crashes between
  steps boring instead of costly. Funds are held on approval so a live swap
  can never execute against money that was spent elsewhere in the meantime.
- **Sandbox and paper by default.** The whole loop (Pix → USDC → trade) runs
  without real money until the operator deliberately configures providers and
  flips `execution.mode` to `live`.
