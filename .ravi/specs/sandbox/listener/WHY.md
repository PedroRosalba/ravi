# Sandbox Listener / WHY

## Rationale

### Reuse the gateway's lower layers, not its request handler

`handleGatewayRequest` serves `/_meta/*` and streaming, lets open-scope
routes through unauthenticated and authenticates with an `rctx` bearer. None
of that belongs on an origin reachable through a tunnel. The listener reuses
only `buildRouteTable` (which already drops `cliOnly` commands) and
`dispatch` with `source: "gateway"`: with that source the authority comes
exclusively from the context record threaded in, and a request can never
degrade into the local operator (`resolveCommandAccessAuthority`).

### node:http instead of `Bun.serve`

Two contract points need the raw transport. The Gate assertion is bound to
the raw request target, and `Request.url` is already normalised. And when the
served-jti append fails the contract says "close the connection without a
response"; a `fetch`-style handler must always return a `Response`. node:http
gives `req.url` exactly as received and a socket to destroy. The probe that
decided this also found that under Bun `res.destroy()` after an async gap
still flushes an empty 200, which the Gate would pass on as the daemon's
answer; the listener destroys the socket instead.

### An oversized body is drained before the 413

Answering 413 while the client is still sending leaves the rest of the body
in flight. On a kept-alive connection the server then parses those bytes as
the next request (the probe saw stray empty 400s); if the server closes
instead, the reset can discard the 413 before the client reads it. The
listener therefore drains the body up to a bound, answers with
`Connection: close`, and past the bound destroys the socket. The Gate caps
bodies at 2 MiB itself, so an oversized request here is an anomaly, not a
hot path.

### The grant lives in the run record, never in the request

The plan's step 5 verified an `X-Ravi-Sandbox-Grant` header. The Console
spec moved the grant off the wire (gate SPEC §Gate Request Assertion): an
impostor origin would otherwise learn a bearer grant. The host CLI stores
the grant it received at mint; the listener re-verifies that stored copy on
every request and refuses any request that still carries the header. This is
also why the run record keeps `grant_sha256` after revocation: a late
assertion for a revoked run resolves to the record and fails as
`grant_revoked`, which is what Console expects, instead of `run_unknown`.

### `requireConcreteResource` forced on the dispatched entry

The `tasks` commands declare `resourceId: "taskId"` but not
`requireConcreteResource`, because an operator or a full-access agent
legitimately holds group or wildcard capabilities. Over the listener the
contract is concrete-resource only (ADR 0003 #1, #2): the dispatched registry
entry is a copy with `requireConcreteResource: true`, so a child context can
only ever satisfy `read|mutate:task:<the home task>`. The child never holds
anything else anyway; forcing the flag makes a future widening of the child
fail closed rather than quietly authorize.

### Two contexts, not one

The root snapshots what the agent holds locally; the child is the grant
intersected with it. Issuing the child through `issueRuntimeContext` makes
the intersection a property the registry enforces (a cap the parent lacks
throws) rather than a filter the listener has to remember, gives revocation
a cascade, and caps the child's lifetime at the root's, which is the grant's
`exp`. Dropped caps are recorded, never widened: a Console that mints a cap
the agent lacks learns it from the record, not from a 403 at the first
request.

### The served-jti queue is written first and never purged at start

Console's connector check (tunnels SPEC rule 6) reconciles the jtis the
listener served, any status, with what the Gate admitted. A served response
whose jti never reaches Console looks like an impostor origin. So the queue
row is written before the response, under `executeWrite`, and a failed write
means no response at all; entries leave only after Console acknowledges the
report that carried them, so a restart loses none. The same rows preload the
assertion replay cache, closing the restart window that `issued_before_start`
alone covers only when the clock is trusted.

### Module-owned tables

`sandbox_runs`, `sandbox_served_jtis` and `sandbox_listener_state` are
created by `runs-db.ts` with `CREATE TABLE IF NOT EXISTS`, the pattern of
`src/calendar/db.ts`. Keeping them out of `router-db.ts` keeps the schema
next to the code that owns it and outside the router coverage gate.

### Plan items the spec superseded

- No `GET /healthz`: Console listener SPEC step 2 says there is no health
  route; everything but an allowlisted `POST` is 404.
- Revoked and expired runs are 401 `grant_revoked`, not 410 (step 6).
- `Host` must equal the tunnel hostname (421 `host_mismatch`), so
  `gateway.tunnel.hostname` is a required setting.
- Body step: `taskId` is required and must equal the home task (403
  `resource_forbidden`); unknown keys including `cwd` are 400 `body_invalid`;
  wrong types are 400 `argument_invalid`.
- Concurrency caps (2 per run, 8 overall) and the 25 s dispatch timeout
  (504 `timeout`) join the rate limits.
- `X-Ravi-Gate: 1` is a routing marker: without it the request is simply not
  routed (404), it is not an authentication failure.
- "cmd in grant but not in the static allowlist" cannot reach a 403: the
  stored grant would fail re-verification (`cmds_not_allowlisted`) and the
  path is refused at step 2 before any token is read. The test asserts the
  404.
- Errors are `{ error: { code, requestId, source } }`; the dispatcher's own
  envelope passes through unchanged for command results and failures.
