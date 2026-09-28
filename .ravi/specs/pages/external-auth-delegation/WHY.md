---
id: pages/external-auth-delegation
title: "Pages external auth delegation rationale"
kind: capability
domain: pages
capability: external-auth-delegation
status: draft
normative: false
---

# Why a third-party API cannot trust a Ravi Page yet

## Problem

A hosted page looks like an app: it has a URL, a publisher, and sometimes a
viewer who already passed a Console access check. It is natural to want that
view to arrive at a private API already logged in, with trust configured on
the API rather than a second password.

The OSS runtime treats a page as a file upload plus a fetch policy. The
logged-in principal that exists locally is either the CLI (`ravi login`) or
a contact stamped onto an agent turn (`ravi link`). Neither is handed to
the browser that opens the URL.

## Decision

Keep this note non-normative until Console defines an assertion a browser
can hold. The recommended shape, if the product proceeds, is a short-lived
viewer JWT minted at the Pages edge (Option A in `SPEC.md`). The daemon
stays a publisher and a trigger host. The artifact stays free of secrets.

## Rejected for the thesis

- **Token baked into HTML at ship time.** The file is what viewers download.
  Ship-time identity is the active CLI user, not the viewer. A leaked
  operator JWT is a Console session, not a scoped API call.
- **Reuse the CLI bearer as the page's `Authorization` header.**
  `cli/cloud-auth` stores that JWT for Console and Link. Scopes are CLI
  scopes. Audience is not Luís's API.
- **Have the public page call the local daemon.** `*.ravi.page` cannot
  reach `~/.ravi`. Making the daemon internet-facing so a static page can
  proxy API calls fights the local-first split (Console policy, OSS
  plumbing).
- **Map the page onto a contact-chat grant.** Those grants intersect
  capabilities inside a chat. A page has no chat id and no contact at view
  time. Overloading `permission_contact_chat_grants` would authorize an
  agent in a conversation, not JavaScript on an origin.
- **Treat comment `actor` as the page session.** The inbox copy keeps
  Console's actor for a comment event. The wake prompt does not even
  surface it. A commenter is not the browser currently rendering the page.

## Why Option A over B and C

Option B (a fresh OAuth login) is honest for public pages and for people
who are not Console members. It does not use the access check Console
already did to show the page, so it is a second login. The current CLI
device flow is not that OAuth client.

Option C (daemon broker) is the right local-first tool when the UI already
shares a machine with the daemon and should call out with a credential
reference. It does not travel with a shipped URL.

Option A is the only option that matches "the page is already open and
the API should trust Ravi" without putting a long-lived secret in the
artifact or exposing the daemon.

## Open questions for Console (not answered here)

- Is the viewer of a `private` route a Console user, an org member, or
  only a password/link capability? OSS cannot see that check.
- Can one route allow several `aud` values, or one?
- Does a password route have a user `sub`, or only "someone who knew the
  password"? A password route may be the wrong place to mint a user
  assertion.
- Who registers the allowlist: a Console UI, a CLI, or both?
