# Chat-Scoped User Overlay / RUNBOOK

## Grant A Contact A Profile In One Chat

```bash
# Plan (dry-run), then apply
ravi permissions allow image-generation --to contact:<id> --chat <chat-id> \
  --agent <executor-agent-id> --capabilities mutate:image:generate --json
ravi permissions allow image-generation --to contact:<id> --chat <chat-id> \
  --agent <executor-agent-id> --capabilities mutate:image:generate --apply --json
```

Inside a chat turn, `--chat current` resolves the current chat. A thread id
resolves to its container chat.

Verify `confirmation.scopes` is `["chat:<chat-id>"]`, `global=false`,
`force=false`. Read `hints`: the first grant in a chat makes it governed, so
other senders there lose tool access until they get their own grant.

## Grant Across Many Chats

```bash
ravi permissions allow image-generation --to contact:<id> --chat-tag clients --apply --json
```

The grant covers every chat tagged `clients` at turn time.

## Global (Only When The Human Asked For It)

```bash
ravi permissions allow image-generation --to contact:<id> --force --apply --json
```

Ask first: "only in this group, or in every chat?" Global grants contribute
only in governed chats.

## Revoke And Inspect

```bash
ravi permissions deny image-generation --to contact:<id> --chat <chat-id> --apply --json
ravi permissions list --chat <chat-id> --json
ravi permissions list --to contact:<id> --chat-tag clients --json
ravi permissions list --to contact:<id> --force --json
```

`list --chat` reports `overlays[]` with `governed`, `eligible`, and the
effective contact capabilities for that chat.

`deny --apply` also revokes live turn contexts that used the removed grant
(the operation message says how many). New grants apply from the next turn.

## Debug A Denial In A Governed Chat

1. Read the turn context metadata: `actorAuthorizationMode=user-overlay`,
   `userOverlayChat`, `userOverlayGrants`.
2. `ravi permissions list --to contact:<id> --chat <chat-id> --json` to see
   covering grants.
3. Confirm the executor agent ceiling includes the capability:
   `ravi permissions materialize --subject-type agent --subject-id <agent> --json`.
4. `ravi permissions resolve <denial-id>` plans a chat-scoped grant plus the
   agent ceiling when missing.

## Validation

```bash
bun test src/cli/commands/permissions.test.ts src/runtime/runtime-request-context.test.ts src/permissions/scope.test.ts
bun test src/bash/hook.test.ts src/runtime/context-registry.test.ts
```
