---
id: pages/external-auth-delegation
title: "Pages external auth delegation"
kind: capability
domain: pages
capabilities:
  - external-auth-delegation
tags:
  - pages
  - auth
  - console
  - design-note
applies_to:
  - src/pages/ship.ts
  - src/pages/client.ts
  - src/pages/comment-follow.ts
  - src/cli/commands/pages.ts
  - src/artifacts/publish-client.ts
  - src/cloud-auth/client.ts
  - src/cloud-auth/connector-auth.ts
  - src/cloud-auth/actor-bindings.ts
  - src/cli/commands/link.ts
  - src/runtime/runtime-request-context.ts
  - src/inbox/inbox-runner.ts
  - src/watch/events.ts
  - src/watch/page-comment.ts
  - src/permissions/contact-chat-grants.ts
owners:
  - ravi-dev
status: draft
normative: false
---

# Pages external auth delegation

> **Design note. Non-normative.** This document maps the OSS runtime as it
> behaves today and records proposals. It does not change ship, serve, auth,
> or permissions. Sections marked **PROPOSAL** are not implemented and are
> not rules agents should follow.

## Sumário executivo

O Luís quer um backend próprio que confie na auth do Ravi: configurar esse
backend e, dentro de uma Ravi Page já aberta, sair com o utilizador
autenticado para a API dele.

No runtime open-source isso ainda não existe. `ravi pages ship` autentica o
**CLI** com o JWT da sessão ativa de `ravi login` e envia HTML estático para
o Console. A page publicada não recebe cookie, JWT, nem claim assinada que
o browser possa apresentar a uma API de terceiros. A identidade do contacto
(`ravi link` → `consoleUserId` no turno) não entra no ship. As permissões
de Pages autorizam o **agent** a publicar; não autorizam a page a chamar
uma API. Quem vê a URL, quem publicou, e qual contacto estava no chat são
três principais diferentes.

A recomendação, se o produto for em frente, é uma **asserção de curta
duração emitida pelo Console no edge da page**, com `aud` limitado à API do
Luís, lida pelo JS em same-origin e nunca gravada no artefacto. O daemon
local não deve virar IdP, e o HTML estático não deve carregar segredo. O
contrato de assinatura, a allowlist de audiências e a sessão de quem
visualiza ficam no Console. Detalhe técnico em inglês abaixo.

## Thesis under test

> Configure Ravi auth on a third-party backend and deliver a ready, logged-in
> authorization inside a Ravi Page so that page can call that API.

Two readings, both checked against this repo:

1. **User delegation.** The human already admitted to the page is logged in,
   and the page's JavaScript can prove that to Luís's API.
2. **Page service identity.** The page itself is a client allowed to call
   the API, independent of who opened it.

Reading 1 is what "ready/logged-in" asks for. Reading 2 is machine auth.
Neither exists on the OSS side today.

## 1. Identity at ship time

OSS does not serve Pages. `cli/cloud-auth` states that hosted artifact
serving and private-asset auth live outside this repo. The local path is:
materialize bytes, upload them with the active Console CLI credential, set
a route access policy, and optionally arm a local trigger.

### What authenticates the upload

`publishArtifactToConsole` (`src/artifacts/publish-client.ts`) and
`RaviPagesClient` (`src/pages/client.ts`) call `readCloudCredentials()`.
That is the **active** `ravi login` slot (`~/.ravi/cloud-auth/active.json`
→ `users/<consoleUserId>/credentials.json`). Requests send
`Authorization: Bearer <accessToken>` via `ConsoleApiClient`.

They do not call `resolveConnectorCloudCredentials`. A turn that already
has `metadata.consoleUserId` from `ravi link` does not change which Console
user publishes the page. If the active login is an operator and the chat
contact is someone else, Console sees the operator.

The finalize body (`finalizeArtifactPublish`) carries artifact name, package
manifest, route visibility, and:

```ts
source: { tool: "ravi pages ship", target: "directory" | "file" | "local_artifact", ... }
```

It does not send `actorPrincipal`, `contactId`, `consoleUserId`, or
`agentId`. Console can attribute the publish only from the bearer token
and the project ref.

### What the project is

`resolvePagesProject` uses `resolveConsoleProjectRef`. The project comes
from an explicit arg, runtime `metadata.consoleScope`, env projection, or
saved Console scope — all scoped to the organization on the **active**
credentials (`organizationFromCredentials`). A local Project name is not a
Console project unless that mapping already exists (`cli/console-scope`).

### What the creator agent is

After a successful upload, `ensurePageCommentFollow` binds a local trigger
`page-comment:<pageId>` to the creator agent: `agentId` from tool context,
else `RAVI_AGENT_ID`. Session target is `main`. A second ship reuses the
trigger and keeps the first agent. No agent in context yields
`commentFollow.skipped: missing_creator` and the ship still succeeds.

That binding is a local agent id. It is not a Console user, not a contact,
and not a browser principal. `<pageId>` is the stable site id Console
returns (slug is not a page id). `orgId` / `projectId` enter the filter
only when they are real ids. A project slug is not written as `projectId`.

### What the bytes are

`wrapHtml5Document` writes a static HTML5 shell: charset, viewport, escaped
title, and the body fragment. No script, cookie, token, or bootstrap URL
is injected. `--html` and `--dir` are copied through as files. The package
manifest is path, sha256, size, and content type.

### Route access policy is not a caller credential

The CLI can set, on the Console API:

| Control | Meaning on this side of the contract |
|---|---|
| `public` | Route may be fetched without a viewer secret. |
| `private` | Console decides who may fetch. OSS does not see that check. |
| `protected_link` | Unguessable link capability. Still a fetch policy. |
| `password` | Shared route secret. `pages password set` sends it once in the authenticated HTTPS body. The response allowlist drops `passwordHash`. The secret is not written into the artifact and is not a per-user session. |

These answer "who may GET the HTML". They do not give the HTML's
JavaScript a credential for another origin.

### Write-brake drift (factual, unresolved)

`src/cli/commands/pages.ts` and `src/cli/commands/pages.test.ts` ("ship is
dry-run by default") return exit 3 `WRITE_REQUIRES_EXECUTE` until
`--execute`. `.ravi/specs/cli/pages`, its WHY, and the `pages` skill say
`ship` / `create` / `publish` run immediately and treat `--execute` as a
no-op. This note describes the write that runs after the brake. It does
not choose which contract wins.

## 2. How Console identity lands in OSS

`ravi login` stores a Console session JWT (access + refresh) for the CLI.
The CLI must not use browser cookies as its API credential
(`cli/cloud-auth`). Layout:

```text
~/.ravi/cloud-auth/active.json
~/.ravi/cloud-auth/users/<consoleUserId>/credentials.json   # tokens
~/.ravi/cloud-auth/bindings/<contactId>.json                # ids + TTL, no tokens
```

`ravi link` / `ravi unlink` take no identity flags. Console user, org, and
installation come from the active cloud session. The local side must be a
resolved `contact:<id>` on the turn (`RAVI_CONTEXT_KEY`). Success writes
the id cache and best-effort stamps the current context metadata with
`consoleUserId` and `consoleOrgId` (`applyBindingToContext` in
`src/cli/commands/link.ts`).

On later turns, `resolveConsoleBindingMetadata` in
`src/runtime/runtime-request-context.ts` reads that cache when the actor
principal is a contact and copies `consoleUserId` / `consoleOrgId` onto
turn metadata. Connector tools that set `requireBoundUser` must use that
user's stored session and must not fall back to the operator JWT
(`src/cloud-auth/connector-auth.ts`).

Pages ship, publish, visibility, domains, and password do not read this
stamp. The stamp exists so connector calls can act as the linked human.
It is unused by the page artifact and by the browser.

Inbox delivery (`src/inbox/inbox-runner.ts`) polls with the same active
cloud-auth credential. Console remains authoritative for item visibility
and payload shape (`cli/inbox`). OSS copies `actor`, `source`, `target`,
and `payload` onto `ravi.console.inbox.item`. It does not invent a contact
or a Console user for an item that arrived without one.

## 3. What a shipped page can present to a third-party API

Nothing that this repo creates.

- The artifact is static HTML/JS/CSS. Publish uploads bytes and activates
  a route. There is no local Pages HTTP server and no gateway route that
  serves page HTML (`src/sdk/gateway` only dispatches the CLI command).
- No `Set-Cookie`, session id, viewer JWT, or signed claim is added to the
  package.
- The operator access token stays in `credentials.json` mode `0600`. It is
  a CLI credential for Console. Putting it in a page would publish a
  refreshable Console session to every viewer.
- A public page is anonymous static hosting. A private or password route
  may have a viewer check inside Console; this repository does not
  implement that check and does not expose its result to page JavaScript.
- Cross-origin calls from `*.ravi.page` (or a custom domain) to Luís's API
  are the browser's problem and his CORS config. Ravi does not attach an
  `Authorization` header for him.

So a backend cannot, today, "trust the Ravi Page session". There is no
page session on the OSS side to trust.

## 4. Permissions: pages vs chat

`pages ship` is `@CommandAccess({ kind: "mutate", resource: "pages", action: "ship" })`.
Callers need `mutate:pages:ship`, `mutate:pages:*`, or `execute:group:pages`
(see `src/cli/command-access.test.ts` and
`src/permissions/authorization-guidance.ts`). That allows an **agent** to
run the CLI. It does not name an API origin, a viewer, or a page principal.

Chat-scoped authority is a different object. `permission_contact_chat_grants`
(`src/permissions/contact-chat-grants.ts`) links a contact to a permission
profile inside a chat or chat tag. When that overlay is active, turn
metadata records `userOverlay`, `userOverlayChat`, and `userOverlayGrants`,
and effective capabilities become agent ceiling intersected with the
contact's chat caps (`src/runtime/runtime-request-context.ts`). Scope types
are `chat` and `chat_tag` only. There is no `page` scope, no site id, and
no "this page may call host X" grant.

A2A auth (`a2a/auth`) has `on_behalf_of` delegation for a remote agent.
That is agent-to-agent, credential-by-reference, and not a browser token.
It is the closest existing shape, and it does not apply to Pages.

## 5. Page comment wake (context only)

Console delivers `page.comment.created` on the Agent Inbox. OSS does not
own comment fanout or history.

`publishInboxNatsEvents` keeps the Console `actor` (`{ type, id }`) on the
inbox NATS item. `watchEventFromInboxPayload` then builds
`ravi.watch.console.page.comment.created`. The watch payload copies comment
body and URL and hoists `pageId` / `siteId` / `orgId` / `organizationId` /
`projectId`. It does not hoist `actor`. `WatchNatsPayload` has no author
field.

The catalog prompt (`PAGE_COMMENT_CREATED_MESSAGE`) includes page id, body,
and URL. It does not include the commenter. v0 does not filter out the
creator's own comments. The woken session is the creator agent's `main`
session, with whatever contact happens to be in that session later — not
the commenter, and not a browser session on the page.

If Console puts an author inside `payload`, OSS forwards that object
unchanged. OSS does not stamp `consoleUserId` or `contactId` onto the
comment.

## Gap analysis

For "Luís's API trusts a Ravi Page session":

| Needed | Present in OSS today |
|---|---|
| A principal the browser can hold | Absent. Static file only. |
| A signature his API can verify without calling the daemon | Absent. CLI JWTs are for Console, stored on the operator machine. |
| Audience limited to his API origin | Absent. No allowlist of third-party origins. |
| Binding to the human who opened the page | Absent. Ship identity is the active CLI user. Viewer identity is a Console concern and is not returned to the artifact. |
| Binding to the linked contact (`ravi link`) | The stamp exists on the **agent turn**. It is not copied into the page. |
| A grant shaped like "page P may call API X" | Absent. Grants are agent capabilities or contact-chat profiles. |
| A local daemon reachable from `https://…ravi.page` | Out of model. The daemon is local-first. A public page cannot rely on `~/.ravi`. |

Publishing a long-lived token inside HTML fails the thesis and the
credential rules in `cli/cloud-auth`: the file is the public (or
link-shared) representation of the page, it is cached, and ship-time
identity is the publisher, not the viewer.

A public page also cannot mean "logged in as Luís". Nobody has
authenticated the viewer. An assertion on a public route can at most say
"this byte stream is site S", which any copy of the page can replay unless
the token is short-lived and bound to a viewer Console already knows.

## Where each piece belongs

| Concern | Console | OSS daemon / CLI | Page artifact |
|---|---|---|---|
| Who may GET the route | Enforces. Already the authority. | Sends `visibility` / password policy only. | None. |
| CLI session that ships | Issues and refreshes the JWT. | Stores it under `cloud-auth/users/<id>`. | Must not contain it. |
| Contact ↔ Console user | Source of truth for `POST /api/cli/link`. | Caches ids; stamps turn metadata. | Must not contain it. |
| Creator agent for comments | Emits inbox events. | Trigger `page-comment:<pageId>`. | None. |
| Viewer session on the page host | Owns it, if any. Not in this repo. | Does not see it. | Must not invent one. |
| **PROPOSAL** assertion for a third-party API | Mint, audience allowlist, JWKS, revoke. | Optional CLI that registers the allowlist. No local signer. | JS that reads a same-origin bootstrap and sends `Authorization` to the API. |
| **PROPOSAL** Luís's API trust | Publish `iss` / JWKS / `aud` rules he configures. | None. | None. His server checks the JWT. |
| CORS on his API | None. | None. | His response headers. |

## Design options

All three are **PROPOSAL**. None is scheduled by this note.

### Option A — Console viewer assertion (recommended)

When Console has already allowed a browser to read a non-public route, the
Pages edge also exposes a same-origin bootstrap, for example
`GET /__ravi/session` on that host, or a response header consumed by a
tiny script. The body is a short-lived JWT:

- `iss`: Console
- `sub`: Console user who passed the route check
- `aud`: one origin Luís registered on that site or route
- `page` / `site` id, `org`, expiry measured in minutes
- no refresh token, no CLI scopes, no operator JWT

Luís's API validates the signature against Console JWKS, checks `aud`,
expiry, and site id. He configures allowed origins on his side for CORS.
Revocation is Console's: short TTL plus a generation on the route.

The uploaded artifact stays free of secrets. Agents keep using
`ravi pages ship` for HTML. A later CLI, if built, would only register
`aud` the way `pages visibility` registers a fetch policy — a Console
mutation, dry-run by default, never a secret in argv.

Public routes do not mint a user assertion. If he needs a logged-in user
on a public URL, that is Option B.

OSS work, later and only against a Console contract: a CLI to read and
write the audience allowlist, and a skill note that page JS may call the
bootstrap. The daemon does not sign, does not store his API keys, and
does not proxy the browser's call.

### Option B — Browser login to his API, or to Console as an IdP

The page is a public OAuth client (PKCE). The viewer logs in on purpose
and comes back with a code for Luís's API, or for Console if Console
grows a third-party authorize endpoint.

What exists today is the CLI device flow: open
`/cli/authorize?user_code=<CODE>`, exchange on the Console token
endpoint, store a CLI JWT. That flow has no redirect URI for an arbitrary
page and no browser session the page can reuse. Treating it as an IdP
for Luís's backend would be a new Console product.

This fits a **public** page, or a viewer who is not a member of the
Ravi org. It does not deliver "already logged in because the page
opened". The artifact owns the PKCE client. The daemon owns nothing
unless someone later adds a CLI to register redirect URIs in Console.

### Option C — Local broker beside the daemon

The page runs inside a Ravi surface that can already reach the daemon
(local webview, overlay, CLI gateway on the unix socket). JavaScript
calls that gateway with the existing context key. The daemon calls
Luís's API with a credential **reference**, using the bound
`consoleUserId` path (`requireBoundUser: true`) or a future
credential-pool entry. The browser never sees the token.

This matches local-first and the connector rule that operator JWT is
not a fallback. It does not work for a hosted `*.ravi.page` URL: that
origin cannot open `~/.ravi/cli-gateway.sock` or a loopback port on the
operator's machine. Shipping a page and expecting the public internet
to hit the daemon inverts the architecture in `sync/console-bridge`
(policy in Console, plumbing in OSS, daemon sync opt-in).

Use Option C only for surfaces that already hold a turn context. Do not
document it as how a shipped page talks to an external API.

## Recommendation

**PROPOSAL: Option A** for the thesis as stated (hosted page, viewer
already admitted by Pages, third-party API trusts Ravi).

- Console owns the viewer, the signature, the audience allowlist, and
  revocation.
- The daemon keeps shipping bytes and route policy. It may later grow a
  CLI for the allowlist. It does not become an identity provider.
- The artifact stays static. Any script that attaches `Authorization`
  reads a same-origin bootstrap at view time.

Option B is the path when the page is public or the caller is not a
Console member. Option C is the path when the UI already runs next to
the daemon. Do not bake a token into `pages ship`, do not reuse the CLI
JWT as a browser bearer, and do not stretch `permission_contact_chat_grants`
into a page grant — a page is not a chat.

## Non-goals

- Implementing A, B, or C.
- Defining Console JWT claims, JWKS, or cookie names. Those are not in
  this repo; inventing them here would be a false contract.
- Resolving the `pages ship` execute-brake drift.
- Changing comment-follow so the prompt includes `actor`. That can be a
  separate product decision; it still would not authenticate a browser.
