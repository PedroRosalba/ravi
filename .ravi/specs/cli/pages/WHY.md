# Pages agent-first CLI contract / WHY

Pages is the surface where a local file becomes a URL anyone can open. The
agent-first happy path is one command the caller runs itself: `pages ship`
(ensure host + publish a route). `create` (host record) and `publish`
(upload onto an existing host or a local `art_*`) stay implemented as
advanced/compat commands. All three create a reachable host or release, so
they dry-run until `--execute` (exit 3, nothing uploaded). They are not
deleted and not the default teaching path. The other brakes cover mutations
that change who can reach an already-hosted site: the password pair (`set`
flips the route policy, `remove` can widen access up to fully public),
domain binding (provider-backed hostname routing), and the visibility switch
to `public`, which exposes content that is ALREADY hosted. Reducing
visibility remains the emergency path that must never be slowed down.

Decisions specific to this domain:

- **Unify around `ship`.** The skill, CLI help and AGENTS.md teach only
  `ravi pages ship` to get a URL. `create` + `publish` choreography is the
  failure mode this surface exists to stop.
- **One host per project.** `ship` without a positional slug publishes a
  route on the project default host (`isDefault`, else
  `<orgSlug>-<projectSlug>`). `--title` names the page. It does not mint a
  `*.ravi.page` host. A positional slug is a legacy extra host.
- **Braked publish verbs.** `ship`, `create` and `publish` dry-run by
  default. Without `--execute` they exit 3 with `WRITE_REQUIRES_EXECUTE`
  and a plan, before any Console call. A ship creates a real Pages release
  on a reachable URL, so it must not be an implied side effect or a probing
  loop. `--execute` performs the write. Public visibility is allowed in the
  same call once that flag is set. The caller publishes; another agent is
  not the publish path.
- **Conditional brake on `update`/`visibility`.** Braking every visibility
  change would put exit-3 friction inside "make it private NOW". The brake
  keys off the requested value: `public` → dry-run; `private`/`protected_link`
  → immediate. The rule is directional exposure, not the op name.
  `visibility --route` uses the same brake but targets one published route
  (no content upload); omitting `--route` still means site default only.
- **Brake before scope resolution.** `ship`, `create`, `publish`, `domains`
  and the password pair brake before `resolvePagesProject`, so a dry-run
  works offline and unauthenticated. The plan shows parsed intent
  (`(Console scope default)`, `(project default host)`) instead of resolved
  refs.
- **Host-only `create`, advanced `publish`.** `create` stays a host record.
  `publish` stays the upload primitive for an existing host or a local
  `art_*`. Both remain in the CLI and share the ship write brake. The
  `pages` skill mentions them only under “Host legado”.
- **Brake before the password prompt.** A `password set` dry-run must never
  read a secret; the plan carries site/action and `routePresent` metadata only.
- **Message-based not-found mapping.** Console reports unknown sites/routes as
  generic 404/PAYLOAD_INVALID errors. Only recognizable "site/route not found"
  messages map to `SITE_NOT_FOUND`/`ROUTE_NOT_FOUND` (with listing
  suggestedAction — sites live in Console, there is no cheap local candidate
  source for similarity suggestions); anything else keeps its stable
  CloudAuthError code, normalized by the shared transport to the global exit
  taxonomy. The funnel still rethrows ContractError first (mail.ts model) so
  policy blocks retain their exact semantics.
- **Validation before the brake on `password remove`.** The replacement
  visibility requirement exists so removing a password can never make a page
  public by accident; the check stays ahead of the brake so a dry-run already
  surfaces the payload error.

The dedicated `pages` skill (`ravi-system-pages`) is the discovery surface.
The `artifacts` skill only points “hospedar HTML → skill pages”. The
parser-level usage contract remains owned by `src/cli/index.ts`.
