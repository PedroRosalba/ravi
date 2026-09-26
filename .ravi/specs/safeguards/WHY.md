# Safeguards / WHY

## Rationale

`permissions/enterprise` already treats prompt injection as a certainty and keeps tool authority on the host. That stops a confused model from being the authorizer. It does not stop a stranger's comment, mail subject, or bug title from being copied verbatim into the next prompt.

Those two controls fail in different places:

- Authorization fails closed on a tool call the agent was never granted.
- A content screen fails before the untrusted span is presented as the user's turn.

Putting the screen inside `permissions` would blur "may call Bash" with "this comment looks like an injected instruction." Operators reviewing a denial could not tell which question was asked.

## Decisions

- Give content screening its own domain so the prompt-ingress contract can be implemented without editing the REBAC model.
- Keep the first spec design-only. The inventory and the interface are the product of this change.

## Rejected Alternatives

- Folding the screen into `permissions`. The model is not the principal, and a content verdict is not a relation.
- Screening only inside the system prompt ("ignore untrusted instructions"). The enterprise spec already rejects model self-enforcement.
