---
id: pages/external-auth-delegation
title: "Pages external auth delegation checks"
kind: capability
domain: pages
capability: external-auth-delegation
status: draft
normative: false
---

# Re-verify the map

This node is a design note. Nothing in it is a runtime requirement.
`normative` stays `false` and `status` stays `draft` until a proposal is
accepted and a separate spec turns it into rules.

Re-read these before editing Pages auth. If a bullet is no longer true,
update `SPEC.md` in the same change.

## Ship identity

- `publishArtifactToConsole` and `RaviPagesClient` still authenticate with
  `readCloudCredentials()` (active login), not
  `resolveConnectorCloudCredentials`.
- `finalizeArtifactPublish` `source` is still `tool` plus package target.
  It still omits contact id, `consoleUserId`, and `agentId`.
- `wrapHtml5Document` is still a static HTML5 document with no script,
  cookie, or token.
- `ensurePageCommentFollow` still binds `page-comment:<site id>` to the
  creator agent and still skips with `missing_creator` when no agent is
  in context.

## Turn identity that Pages does not use

- `ravi link` still writes `~/.ravi/cloud-auth/bindings/<contactId>.json`
  with ids only, and still stamps `consoleUserId` / `consoleOrgId` on the
  current context.
- `resolveConsoleBindingMetadata` still copies that cache onto turn
  metadata only when the actor is a contact.
- User-scoped connector tools still fail closed without the bound user's
  stored session. Pages commands still do not call that helper.

## Browser credential

- No Pages code sets a cookie, mints a JWT, or injects a bootstrap URL
  into the uploaded package.
- Route policy is still `public` | `private` | `protected_link`, plus
  `password` as a shared route secret sent only on the CLI HTTPS call.

## Grants

- `pages ship` access is still `mutate:pages:ship` (or `mutate:pages:*` /
  `execute:group:pages`).
- `permission_contact_chat_grants.scope_type` is still `chat` | `chat_tag`.

## Comment wake

- Inbox NATS payload still copies Console `actor` through.
- `pageCommentWatchEvent` still hoists page/org/project ids and still does
  not hoist `actor`.
- The default prompt still templates `payload.pageId`, `payload.body`, and
  `payload.url` only.

## Commands that lock the current facts

```bash
bun test src/pages/ship.test.ts src/pages/comment-follow.test.ts src/cli/commands/pages.test.ts src/watch/events.test.ts src/cloud-auth/connector-auth.test.ts src/runtime/runtime-request-context.test.ts src/cli/commands/link.test.ts
```

Those tests cover today's ship, comment follow, connector credential
selection, and link stamps. They do not cover a third-party page session,
because that session does not exist.

## Index

```bash
ravi specs get pages/external-auth-delegation --mode full --json
```

The record must stay `status: draft` and `normative: false`.
