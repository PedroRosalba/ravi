# Home Passthrough / CHECKS

## Suites

```bash
bun test src/cli/home-mode.test.ts src/cli/remote-gateway.test.ts src/cli/registry.test.ts
bun run test:agent-contract
bun src/cli/index.ts sdk openapi check --against openapi.json
```

No check reaches a Gate: requests go to a fake `fetch`, and the process smokes
in `src/cli/home-mode.test.ts` point at an unreachable `https://127.0.0.1:1`.

## Checks

- `ravi home tasks report t1 --message hi --json` with `RAVI_CONTEXT_KEY`,
  `RAVI_GATEWAY_URL`, `RAVI_AGENT_ID` and `RAVI_SESSION_*` set sends exactly
  one request, to `<RAVI_HOME_GATEWAY_URL>/api/v1/tasks/report`, with headers
  exactly `content-type` and `accept`, `redirect: "manual"`, body
  `{"taskId":"t1","message":"hi"}`, and none of those env values on the wire
  (`registry.test.ts`, "sends only the grant").
- `dispatchRemote` in home mode with a `contextKey` and a `cwd` passed sends
  neither (`remote-gateway.test.ts`).
- `X-Ravi-Sandbox-Grant` is sent only when `RAVI_SANDBOX_GRANT` is set and not
  blank, trimmed (`remote-gateway.test.ts`, `registry.test.ts`).
- A grant with CR/LF, a comma or a space gives `HOME_GRANT_INVALID` exit 2,
  makes no request and its value appears in no error field
  (`remote-gateway.test.ts`; process smoke in `home-mode.test.ts`).
- `RAVI_HOME_GATEWAY_URL` missing gives `HOME_GATEWAY_REQUIRED` exit 1, also
  when `RAVI_GATEWAY_URL` is set; `http://` (loopback included) and `unix://`
  give `HOME_GATEWAY_INSECURE` exit 2; user, password, `?` or `#` (empty ones
  included) give `HOME_GATEWAY_INVALID` exit 2 without the URL in the message
  (`remote-gateway.test.ts`).
- `ravi home tasks comment t1 hi` exits 3 with `HOME_COMMAND_NOT_ALLOWED` at
  the process level, with `RAVI_CONTEXT_KEY` and `RAVI_GATEWAY_URL` set, and
  at the registry level sends nothing and runs nothing locally
  (`home-mode.test.ts`, `registry.test.ts`).
- `RAVI_HOME_COMMANDS="tasks.report, tasks.comment agents.list"` allows only
  `tasks.report`; `tasks.show,tasks.done` makes `tasks report` exit 3
  (`home-mode.test.ts`, `registry.test.ts`).
- `HOME_STATIC_COMMANDS` equals
  `["tasks.block","tasks.done","tasks.fail","tasks.report","tasks.show"]`
  (`home-mode.test.ts`).
- Without the home target, `tasks report` with `RAVI_HOME_GATEWAY_URL` and
  `RAVI_SANDBOX_GRANT` set still goes to `RAVI_GATEWAY_URL` with the bearer and
  no grant header (`registry.test.ts`).
- A listener 401 `grant_revoked` envelope renders `HOME_GRANT_REVOKED`, exit
  1, with the request id, and without the grant or any extra body field
  (`registry.test.ts`).
- Gate `grant_missing` → `HOME_GRANT_MISSING` exit 1, `source: "gate"`;
  listener `resource_forbidden` → exit 1; `command_not_allowed` → exit 3;
  `body_invalid` 400 → exit 2; `daemon_offline` 503 retryable; the request id
  comes from the header when the body has none, and a non-UUID one is dropped;
  an unknown `source` or a code that is not `^[a-z][a-z0-9_]{0,63}$` gives
  `HOME_GATEWAY_FAILED`; a relayed dispatcher envelope keeps its code; an HTML
  502 gives `HOME_GATEWAY_FAILED` retryable; a 302 gives
  `HOME_GATEWAY_REDIRECT` (`remote-gateway.test.ts`).
- `ravi home --help` exits 0 and never prints the gateway URL value
  (`home-mode.test.ts`).
- `sdk openapi check --against openapi.json` passes unchanged: no decorated
  group was added.
