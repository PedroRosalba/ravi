# Pages agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/pages --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `3`: a write brake. `ship`, `create` and `publish` dry-run until
   `--execute` (nothing is uploaded). The same exit covers `domains`,
   `password set/remove`, assertion-audience `set`/`remove`, and
   `update`/`visibility` switching to `public`. Read `error.plan`, confirm the
   write is intended, then re-run the same command adding `--execute`. For
   `password set` the dry-run never prompts — the prompt only appears with
   `--execute`. A ship dry-run does not create a host, an upload, a release,
   or a page-comment trigger.
4. Exit `1` + `SITE_NOT_FOUND`: list the real sites with `ravi pages list
   --json` and retry with an existing slug/id.
5. Exit `1` + `ROUTE_NOT_FOUND`: list the live routes with `ravi pages
   published --json`.
6. `PAYLOAD_INVALID` on `password remove`: the replacement `--visibility` is
   missing or invalid — it is validated BEFORE the brake, on purpose.
7. `AUTH_REQUIRED`/`AUTH_EXPIRED`: legacy CloudAuthError funnel, not the
   contract — run `ravi login`.
8. If a domains/password write, a visibility switch to `public`, or a
   `ship`/`create`/`publish` executed without `--execute`, the brake
   regressed: check the op still calls `contractDryRun` before
   `resolvePagesProject` (ship/create/publish/domains/password) or before
   `updatePageSite` / `updatePageRouteVisibility` (update/visibility with
   `public`). The dry-run plan MUST say whether the target is the site
   default or one `--route`.
9. If a ship dry-run created the default host or an upload session, the brake
   moved after `resolveShipHost` / `publishArtifactToConsole`; move it back
   right after arg and source validation.
10. If a braked op in agent context reports a CloudAuthError instead of the
    dry-run envelope, `runPagesCommand` lost the ContractError rethrow.

## Validation

```bash
bun test src/cli/commands/pages.test.ts
```

Live checks against the local CLI (read-only or dry-run):

```bash
ravi pages ship --title "Demo" --route /demo --body "<h1>OK</h1>" --json # expect exit 3; no upload
ravi pages ship ravi-x --title "Demo" --body "<h1>OK</h1>" --json        # expect exit 2 (reserved slug)
ravi pages create proj site --visibility private --json                   # advanced/compat: expect exit 3
ravi pages create proj ravi-site --json                                   # expect exit 2 (reserved slug)
ravi pages publish proj site ./dist --route / --visibility public --json  # expect exit 3 (./dist must exist)
ravi pages publish proj site ./missing --json                             # expect exit 2 (source not found)
ravi pages domains proj site docs.example.com --json                      # expect exit 3 before credentials
ravi pages password set proj site --route / --json                        # expect exit 3, no prompt
ravi pages password remove proj site --route / --json                     # expect PAYLOAD_INVALID (missing --visibility)
ravi pages visibility proj site public --json                             # expect exit 3
ravi pages visibility proj site public --route / --json                   # expect exit 3; no route mutation
ravi pages list --fields slug,status --json                               # expect compact items
```

Real writes. Run them only against a scratch project, once each, never as a
retry loop:

```bash
ravi pages ship --title "Demo" --route /demo --body "<h1>OK</h1>" --json --execute # project default host + route
ravi pages create proj site --visibility private --json --execute         # writes the host
ravi pages publish proj site ./dist --route / --visibility public --json --execute # publishes a public route
ravi pages domains proj site docs.example.com --execute                  # add shown DNS records, then rerun
ravi pages visibility proj site private --json                            # immediate write (no brake on reductions)
ravi pages visibility proj site public --route / --execute --json         # route policy only; effectiveVisibility in output
```
