# Sandbox Gateway Tunnel Runner / CHECKS

## Suites

```bash
bun test src/gateway-expose/ src/cli/commands/gateway.test.ts src/sandbox-listener/ src/sandbox/ src/cloud-auth/
bun run typecheck
bun run test:agent-contract
bun src/cli/index.ts sdk openapi check --against openapi.json
```

No check reaches the network or runs a real cloudflared: downloads, spawn,
`/config`, socket ownership, PM2 and `security` are fakes; state lives in
`createIsolatedRaviState()`.

## Checks

- The pinned table MUST list exactly `darwin-arm64`, `darwin-amd64`,
  `linux-amd64`, `linux-arm64`, each with a 64-hex SHA-256 and a URL on the
  pinned release (`cloudflared.test.ts`, "pinned release table"); any other
  platform MUST fail with `unsupported_platform` before a download.
- A checksum mismatch MUST abort before extraction or `--version` and leave
  `~/.ravi/bin` empty; a redirect to a non-GitHub host or to `http` MUST be
  refused after one request and leave nothing; a binary that does not report
  the pinned version MUST not be installed; a good install MUST be `0700` in
  a `0700` directory, with `--version` run on the staged copy first.
- A tgz MUST yield only the regular-file member `cloudflared`; a symlink
  member or a missing one MUST be rejected.
- `locateCloudflared` MUST report the pinned install `verified: true` only
  when private to the user, and an explicit path `verified: false`.
- Credentials (`secret.test.ts`): the file store MUST be `0600` in a `0700`
  directory and a group-readable file MUST be refused; the Keychain store
  MUST use service `ravi.gateway-tunnel` with the secret on stdin only (no
  argv carries `TunnelSecret` or `AccountTag`); a Keychain failure MUST fall
  back to the file and leave no Keychain item; malformed objects MUST be
  rejected.
- The template (`ingress.test.ts`) MUST parse to exactly the two rules with
  Access required and `warp-routing.enabled: false`, contain no credentials,
  and not gain structure from a hostile value; args MUST bind metrics to
  `127.0.0.1` and reject an invalid port.
- `checkRemoteConfig` MUST pass the template at version -1 and flag as
  drift: version 0/3/missing, an extra rule, a repointed service, another
  hostname, a path matcher, Access not required or removed, another
  audience, a catch-all that serves or has a hostname, warp-routing on.
- Runner credentials (`tunnel-runner.test.ts`, "credentials reach
  cloudflared only through its env"): the spawn env MUST be the allowlist
  plus `TUNNEL_CRED_CONTENTS` (no `RAVI_CONTEXT_KEY`, no `TUNNEL_TOKEN`),
  argv MUST not contain the secret or account tag, `process.env` MUST be
  unchanged, no stdout/stderr line MUST contain the secret (cloudflared's
  echo is masked), and the config file MUST be `0600` without credentials.
- The runner MUST refuse with exit 78 and never spawn without credentials,
  settings or cloudflared, with an invalid metrics port, or while latched.
- End to end with a real listener (`tunnel-runner.test.ts`, "first-poll
  gate, drift ⇒ latch ⇒ listener 503 ⇒ cloudflared stopped"): before the
  first successful poll the listener MUST answer 503 `tunnel_drift`; after it,
  not; a remote config version MUST latch, SIGTERM cloudflared, exit 78, make
  the listener answer 503 `tunnel_drift`, and a restarted runner MUST refuse.
- Each of version 0, ingress change, warp-routing on, a poll error, a 2 s
  timeout, no success for 10 s, a foreign or unverifiable metrics socket
  owner MUST stop cloudflared and set the latch; a child ignoring SIGTERM
  MUST get SIGKILL; a crash inside the poller MUST stop cloudflared.
- Startup: connection failures MUST be retried within the 10 s grace without
  latching, and MUST latch when the grace runs out.
- Lifecycle: the runner MUST exit with cloudflared's code (143 for a SIGTERM
  death) and clear `last_poll_at`; MUST forward SIGTERM; MUST not spawn
  before `listener.armed` names its port; a signal while waiting MUST exit
  without spawning; a dead runner's cloudflared MUST be stopped, a reused pid
  with another name MUST not.
- A listener-port change under a running tunnel MUST stop cloudflared and
  exit 75 with no latch and the gate closed ("a gateway settings change").
- CLI (`gateway.test.ts`): `gateway.tunnel-run` MUST be CLI-only (no route),
  admin, hidden from help, and MUST exit 78 without settings; the PM2
  registration MUST use `ravi-gateway`, `--kill-timeout`, `--stop-exit-codes
  78`, `gateway tunnel-run`, and carry no `TUNNEL_*` or `RAVI_CONTEXT_KEY`.
