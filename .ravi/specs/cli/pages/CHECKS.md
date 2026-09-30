# Pages agent-first CLI contract / CHECKS

## Checks

- `pages ship` without a positional slug MUST publish onto the project
  default host (a listed site with `isDefault`, otherwise the project-owned
  slug `<orgSlug>-<projectSlug>`, created once with `isDefault` when that
  slug can be computed) and the requested `--route` (default `/`). `--title`
  alone MUST NOT become a new host slug. A positional slug remains a legacy
  extra host: it MAY create or reuse that slug and MUST warn. Slugs `ravi`
  and `ravi-*` MUST NOT be created.
- `pages ship` without `--execute` MUST exit 3 with `WRITE_REQUIRES_EXECUTE`
  and a plan, and MUST NOT call Console. With `--execute` it MUST ensure the
  host (the project default host, or the explicit legacy slug) then
  publish+activate. `--body` MUST be wrapped in a simple HTML5 document.
  Success JSON MUST include `{url, site, slug, route, visibility, artifactId}`
  (it also carries `success` and `commentFollow`). A successful ship MUST arm
  or reuse one `page-comment:<site id>` trigger per Pages host, bound to the
  first agent that shipped there (`pages/comment-follow`); every route on that
  host shares it. The dry-run plan MUST NOT contain the HTML body or a host
  slug derived from `--title`. Usage errors (missing `--title`, zero or
  several of `--body`/`--html`/`--dir`, a missing `--html`/`--dir` path, a
  reserved positional slug) MUST exit 2 before the brake.
- `pages create` MUST reject a reserved slug (`ravi`, `ravi-*`) with exit 2
  before the brake. Otherwise, without `--execute` it MUST exit 3 with
  `WRITE_REQUIRES_EXECUTE` before any Console call. With `--execute` it MUST
  write the host record.
- `pages publish` MUST reject a local source path that does not exist with
  exit 2 before the brake (an `art_*` id is resolved later). Otherwise,
  without `--execute` it MUST exit 3 with `WRITE_REQUIRES_EXECUTE` and MUST NOT
  talk to Console. With `--execute` and valid args it MUST upload/publish.
- `pages domains` without `--execute` MUST exit 3 before credential reads,
  project resolution or any Console/provider request.
- `pages password set` without `--execute` MUST exit 3 BEFORE the hidden
  password prompt and before any Console call; its plan MUST NOT contain a
  password key or raw route path and MUST use `routePresent` metadata.
- `pages password remove` MUST reject a missing replacement `--visibility`
  with `PAYLOAD_INVALID` even without `--execute`; with a valid visibility and
  no `--execute` it MUST exit 3 without calling Console or exposing the raw
  route path.
- `pages update`/`pages visibility` switching a site to `public` without
  `--execute` MUST exit 3; switching to `private` or `protected_link` MUST
  write immediately without any brake. Without `--route`, `pages visibility`
  MUST keep PATCHing only site `defaultVisibility`.
- `pages visibility <site> public --route /` without `--execute` MUST exit 3
  and MUST NOT call Console. With `--execute` it MUST call the authorized
  route-visibility update (no artifact upload) and success JSON/human output
  MUST report the effective visibility of that route. Help/`--help` MUST
  mention `--route`.
- A Console failure whose message matches a site not-found MUST surface as the
  `SITE_NOT_FOUND` envelope (exit 1) with suggestedAction `ravi pages list
  --json`; a route not-found MUST surface as `ROUTE_NOT_FOUND` (exit 1) with
  suggestedAction `ravi pages published --json`.
- A `ContractError` thrown by a brake or a not-found mapping MUST
  pass through `runPagesCommand`'s CloudAuthError funnel untouched.
- A 400 Console response carrying `DOMAIN_SETUP_REQUIRED` MUST preserve that
  code through cloud-auth mapping and render the sanitized TXT/CNAME instruction
  with exit 1; other provider messages MUST remain redacted.
- `pages list --fields a,b,c --json` and `pages published --fields a,b,c
  --json` MUST return items containing only the requested fields.
- Braked publish ops (`ship`, `create`, `publish`) MUST stay dry-run until
  `--execute` and be declared that way in the spec. Unbraked ops (visibility
  reductions and `password status`) MUST keep immediate behavior and be
  declared as unbraked in the spec.
- The dry-run plans of `pages ship`, `pages create`, `pages publish` and
  `pages domains` MUST work without saved Console scope, showing
  `(Console scope default)` placeholders (and `(project default host)` for
  ship) instead of resolved refs.
- `ravi skills show pages` and `ravi skills show ravi-system-pages` MUST
  resolve to the same skill. The default gate `pages` MUST load
  `ravi-system-pages` for `ravi pages` and `pages.password`.
- `pages assertion audiences set` and `remove` without `--execute` MUST exit 3
  before credentials or Console. `list` MUST stay read-only. The contract is
  `pages/assertion-audiences`.
- The `pages` skill MUST teach the caller to publish itself with
  `ravi pages ship … --json --execute` as the only happy path to get a URL.
  It MUST say not to ask another agent to publish, and MUST say what to do
  when `pages` is denied (request the grant or report blocked). It MUST say
  not to use `ship --execute` as a probe. It MUST document the ship write
  brake (exit 3 without `--execute`; public visibility allowed in the same
  `--execute` call). Happy-path examples MUST keep the default private
  visibility; `--visibility public` MAY appear only on an explicit public
  example. It MUST NOT teach `create` + `publish` choreography. The happy
  path MUST be project → default host → route, MUST say `--title` does not
  create a host, and MUST tell the caller to list routes before publish.
  `create`/`publish` MAY appear only under an advanced/compat or legacy
  section, and that section MUST show their `--execute` brake.
- `bun test src/cli/commands/pages.test.ts src/cli/execute-consumers.test.ts`
  SHOULD pass after any change to the pages contract surface. The latter
  guards the skill, `AGENTS.md` and these specs against the unbraked-era
  wording.
