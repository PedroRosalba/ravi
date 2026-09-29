---
id: pages/assertion-audiences
title: "Why viewer-assertion audiences live on the Pages CLI"
kind: capability
domain: pages
capability: assertion-audiences
status: active
---

# Why the allowlist is a Pages command

A shipped page is static HTML. The CLI JWT that uploaded it is the operator session, not a credential the browser can show to someone else's API. The viewer assertion has to be minted where Console already decided the browser may read the route, with `aud` limited to an origin the operator registered.

OSS only records that registration. Signing, TTL, and the JWKS document stay in Console. Putting the token in `pages ship` would publish a credential inside the artifact.

`set` and `remove` use the same dry-run as password and domains: they change who can receive a credential for an already-hosted page. `list` does not.

`--uses ravi.identity.assertion` is the opt-in on the publish body so Console can attach the same-origin bootstrap. It is not a token.

## Rejected

- Embedding the CLI access token or a long-lived assertion in the HTML.
- Signing the assertion in the daemon.
- A second host per API. Audiences are records on the project host.
- App-gateway target registration. That is a different routing surface.
