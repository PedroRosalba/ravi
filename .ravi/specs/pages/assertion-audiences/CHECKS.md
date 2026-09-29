# Pages viewer-assertion audiences / CHECKS

- `pages assertion audiences list --site <host>` MUST `GET /api/cli/projects/:projectRef/pages/:siteRef/viewer-assertion-audiences` and MUST NOT dry-run. `<host>` MAY be a slug, site id, or hostname. It MUST accept `--limit` and `--offset`.
- List JSON MUST include `jwksUrl` of `{consoleOrigin}/api/public/pages/viewer-assertions/jwks` and MUST omit JWT-shaped audiences and token fields from the Console body.
- A Console audience row `{ audience, origins }` MUST populate CLI `aud`. A row that only has `aud` MUST still parse. When both fields are present, `audience` MUST win.
- `set` without `--execute` MUST exit 3 before credentials and Console. The plan MUST include `site`, `aud`, and `origins`, and MUST NOT include a JWT.
- `set` with `--execute` MUST `PUT /api/cli/projects/:projectRef/pages/:siteRef/viewer-assertion-audiences` with `{ aud, origins }` and MUST NOT repeat `siteRef` in the body. Repeated `--origin` values MUST be unique https origins. More than 8 origins, and `http` origins, MUST be `PAYLOAD_INVALID` before the brake. A set response that uses `audience` MUST still fill the CLI audience row.
- `remove` without `--aud` MUST be `PAYLOAD_INVALID` before the brake. With `--aud` and without `--execute` it MUST exit 3 without calling Console. With `--execute` it MUST `DELETE` that same path with `{ aud }`.
- `pages ship --uses ravi.identity.assertion` MUST send `publish.uses` containing that id and MUST NOT send a JWT. Omitting `--uses` MUST omit `uses`.
- The `pages` skill MUST name `ravi.identity.assertion`, the JWKS URL, and the ban on logging the JWT.
- App-gateway targets MUST NOT gain a CLI in this change.
