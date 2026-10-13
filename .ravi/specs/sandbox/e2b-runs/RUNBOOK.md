# E2B Runs / RUNBOOK

## Before editing

```bash
ravi specs get sandbox/e2b-runs --mode full --json
```

Read `src/sandbox/e2b.ts` top to bottom once: the run is one long function
with the network, credential and signal handling interleaved on purpose, so a
change in one place usually needs a test in `src/sandbox/e2b.test.ts` that
drives the fake sandbox end to end.

## Running a task

```bash
export E2B_API_KEY=…  ANTHROPIC_API_KEY=sk-ant-api03-…   # never an OAuth token
ravi sandbox run --repo https://github.com/owner/repo.git --task "…" --follow
```

- Private GitHub repo: also export `GITHUB_TOKEN`. It is used during the clone
  only.
- The worker needs a host that is not a package registry:
  `--allow-host internal.example.com --allow-host '*.corp.example'`.
- No registries at all: `--egress strict`.
- A broker in front of Anthropic: `RAVI_SANDBOX_ANTHROPIC_BASE_URL=https://…`
  (model auth becomes `broker`).
- A host where header injection cannot work: `--model-auth env --allow-key-in-env`
  (the key is then visible to E2B; `--keep` is refused).

## Debugging a failed run

`~/.ravi/sandbox-runs/<sandbox-id>/run.log` has the step timeline, including
the line `Egress: deny-all except …` that lists the run-phase allowlist.
`daemon.log`, `sessions/*.trace.txt` and `transcripts/` show what the worker
did. `e2b/processes.txt` lists every command E2B ran; the task text must not
appear in it (only `$(cat /home/user/.ravi-task/…)`).

- `git clone` fails with a TLS or 403 error on a private repo: the GitHub
  transform rule is not being honoured (CA trust, see the TODO below) or the
  token is wrong. The runner falls back to git's credential file only when the
  secret store refuses the rule, not when the proxy does not inject. To force
  the file path while the proxy problem is investigated, run with
  `--model-auth env --allow-key-in-env`.
- Claude Code reports 401 from the model: in `header` mode the `x-api-key`
  rule did not fire. Check the sandbox's network config in the E2B dashboard:
  the rule for `api.anthropic.com` must show the `${e2b.secrets.…}`
  placeholder, never a literal key.
- `bun install` or tests fail with network errors: the host is not in the
  allowlist. Add it with `--allow-host`; do not switch off `denyOut`.
- A paused (`--keep`) sandbox cannot be used for anything that needs the
  network; that is by design. Resume it in the E2B dashboard and inspect the
  filesystem only.

## Leaked secret

If an E2B secret named `ravi-sbx-<runId>-…` survives a crashed run, remove it:

```bash
# in a bun REPL with the e2b package
await Secret.destroy("ravi-sbx-<runId>-anthropic", { apiKey: process.env.E2B_API_KEY })
```

Then rotate the Anthropic key or GitHub token it held.

## TODO: live check that cannot run without an E2B key

Verify with the E2B test key that git and Claude Code (Node's CA store) trust
E2B's transform-rule CA; else set `NODE_EXTRA_CA_CERTS` (and git's
`http.sslCAInfo`) to E2B's CA path in the sandbox env. Also confirm, with the
same key, that DNS works under `denyOut: ["0.0.0.0/0"]`, that
`Sandbox.list({ query: { metadata } })` filters on `ravi_run`/`ravi_host`, and
that `updateNetwork` preserves `allowPublicTraffic: false`. Until then
`header` mode has only been exercised against the fake; `env` mode with
`--allow-key-in-env` is the known-good path.
