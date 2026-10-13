# Sandbox Grant Verification / WHY

## Rationale

### A parity copy of the Console verifier, not a shared package

Console's `grant-verify.ts` runs in Workers and must stay `node:`-free; the
daemon bundles its own code and is published to npm from another repository.
A shared package would couple two release trains for 200 lines. Instead the
daemon keeps a byte-equal copy of the contract constants (`contract.ts`) and a
check-for-check port of the verifier (`grant.ts`), and its test suite is a
port of Console's: any divergence shows up as a differing reason code.

### `key_set_unavailable` is not a 401

A JWKS outage says nothing about the token. Answering 401 would teach the
sandbox worker that its grant is bad and end the run; answering 503 lets the
Gate retry. The cache therefore throws a non-jose error, and the verifiers map
every non-jose error to `key_set_unavailable` exactly as Console does.

### Why a Gate assertion at all (ADR 0005)

One Access application covers every tunnel host, so an Access JWT could be
replayed from one installation's tunnel to another's. The Gate signs each
forwarded request with claims bound to the installation, the run, the
command, the body and the request id. The daemon checks all of them, plus the
hash of the grant it already holds, so an impostor origin that learns request
bodies still learns no grant (ADR 0009, 0012).

### Request binding inside the verifier

The assertion carries `cmd`, not a method or path. The verifier still takes
the raw method and path: refusing anything but `POST` and deriving `cmd` from
the path with the §Identifiers grammar keeps path normalisation (`_stream`,
`..`, `%2e`, `//`, uppercase) in one audited place instead of in the listener.

### Persisted JWKS, 0600, honouring `fetchedAt`

A daemon restart during a Console outage would otherwise be a cold start and
refuse every request for the outage's duration. Persisting the public keys is
safe only if the file cannot be swapped by another local user, hence 0600 and
the refusal of any other mode, and only if its age counts from the original
fetch, so the stale window is never extended by restarting.

### Plan items the Console spec superseded

The stack plan's `sub` regex (`sbr_[A-Za-z0-9_-]+`), 65-minute phrasing and
looser `cmds` grammar were written before Console fixed the contract. The
Console constants (`sbr_[a-z2-7]{26}`, 3900 s, 2–8 segments) are used instead.
