# Pages viewer-assertion audiences / RUNBOOK

1. Dry-run first. `ravi pages assertion audiences set --site <host> --aud <aud> --origin https://… --json` exits 3 and does not call Console.
2. Repeat with `--execute` after `ravi login`. A 404 whose message is not "site not found" means the sibling Console handlers are not deployed. Keep the path. Do not post the allowlist anywhere else.
3. Confirm with `ravi pages assertion audiences list --site <host> --json`. Read `jwksUrl`. The API verifies signatures there. Do not copy an assertion out of a browser into logs.
4. Ship the page with `--uses ravi.identity.assertion` only when that page will call the registered API. The artifact stays free of tokens.
5. `remove --execute` drops one `aud`. It does not change visibility or delete the host.
