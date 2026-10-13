# Sandbox Gateway Tunnel Runner / RUNBOOK

## Before Editing

- Read Console's `console/sandbox-gateway/listener` SPEC (§Host And
  cloudflared, §Drift Check, §Confinement) and `tunnels` SPEC; a change to
  the template, the drift rules or the credential path starts there.
- Never put the tunnel secret in argv, a log call, an error message or the
  runner's own env. `tunnel-runner.test.ts` greps stdout/stderr for it.

## Pinned release

- Version `2026.9.1` (published 2026-09-11). Source of every hash: the GitHub
  release API, `https://api.github.com/repos/cloudflare/cloudflared/releases`,
  field `assets[].digest`, read on 2026-10-13.

  | Platform | Asset | SHA-256 |
  | --- | --- | --- |
  | darwin-arm64 | `cloudflared-darwin-arm64.tgz` | `c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe` |
  | darwin-amd64 | `cloudflared-darwin-amd64.tgz` | `ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4` |
  | linux-amd64 | `cloudflared-linux-amd64` | `03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc` |
  | linux-arm64 | `cloudflared-linux-arm64` | `3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3` |

- The Linux values also equal the release notes' "SHA256 Checksums". The
  darwin `.tgz` values in the release notes (`9a0b19f6…5a6e` arm64,
  `1ea07ae7…1b75` amd64) differ from the served bytes, as for every release
  since at least 2026.7.1; 2026.8.0/8.1 also differ for Linux, so they are
  not pinned. Before trusting a bump, install once on a Mac with the network
  and confirm the check passes (or capture what the served `.tgz` hashes to).
- To bump: pick a release at least two weeks old whose Linux digests equal
  its release notes, copy the four `digest` values and URLs into
  `CLOUDFLARED_ASSETS` and this table, keep `cloudflared --version` output
  matching `version <X>`, and run the CHECKS suites.

## Operating

- `ravi gateway expose` (05b) installs cloudflared, stores the credentials,
  writes the settings and registers PM2 `ravi-gateway`. The listener starts
  or restarts on `ravi.config.changed` without a daemon restart.
- `pm2 logs ravi-gateway` shows the runner and cloudflared output.
  `Waiting for the daemon's sandbox listener` means the daemon is down or its
  listener is not configured (`listener.armed` missing or on another port).
- Exit 78 (`stopped` in PM2, not restarted) means the runner refused or
  latched; the log line names the reason (`drift_latched:<cause>`,
  `gateway_not_configured`, `credentials_missing`, `cloudflared_not_installed`,
  `metrics_port_invalid`).
- `gateway.tunnel.metricsPort` (default 20241) and the stored credentials are
  read at runner start; after changing either, `pm2 restart ravi-gateway`.
  A change to the listener port, tunnel hostname or Access settings is picked
  up by itself: the runner exits 75 and PM2 restarts it with a new template.

## Drift

| Reason | Meaning | First step |
| --- | --- | --- |
| `config_version` | cloudflared applied a remote configuration | Treat as a compromise of the tunnel's Cloudflare account path: Console RUNBOOK §Unexpected Connector; rotate |
| `ingress_mismatch`, `warp_routing` | `/config` differs from the template | Same; capture `curl -s 127.0.0.1:<metricsPort>/config` first |
| `metrics_socket_owner` | Another process owns the metrics port, or `lsof`/`ss` could not tell | `lsof -nP -iTCP:<port> -sTCP:LISTEN`; install `lsof` or `iproute2` if missing |
| `poll_failed`, `poll_stale`, `config_unparseable` | cloudflared stopped answering, hung, or the runner stalled | Check the host (sleep, load), then rotate |

- The latch is cleared only by a successful rotate/re-expose (05b). Do not
  delete the `tunnel.drift_latch` row by hand: it is the record that the
  tunnel served something other than the host's template.
- While latched the listener answers 503 `tunnel_drift` and `ravi gateway
  status` (05b) reports it; Console sees `driftLatched` in the host report.

## Live checks still open (first run with a real tunnel)

- cloudflared at the pinned version accepts `TUNNEL_CRED_CONTENTS` for `tunnel
  run` with an API-created local tunnel (Console C3a spike item).
- The exact `/config` JSON of that version matches what `checkRemoteConfig`
  expects (rule `service` as a string, `path` null or absent, `access` keys
  `required`/`teamName`/`audTag`, `warp-routing.enabled` absent or false). A
  latch with `ingress_mismatch` on the first ever poll is this check failing:
  capture the body and adjust the comparator, never loosen it to "ignore".
- PM2 honours `--stop-exit-codes 78` and `--kill-timeout 8000` on the
  installed PM2 version.
- `lsof -iTCP@127.0.0.1:<port>` lists cloudflared's metrics socket on macOS
  and Linux without root.

## Residual risks

- A SIGKILLed runner leaves cloudflared running until the next runner start
  stops it; the listener closes within 10 s (no fresh poll), so nothing is
  served meanwhile, but the tunnel stays connected.
- No confinement of cloudflared on macOS (milestone 1, Console §Confinement);
  Linux confinement is not implemented yet and `expose` must refuse on Linux
  until it is (05b).
