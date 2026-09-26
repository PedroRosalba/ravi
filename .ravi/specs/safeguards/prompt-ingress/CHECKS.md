# Safeguards / Prompt Ingress / CHECKS

## Spec Integrity

```bash
ravi specs sync --json
ravi specs get safeguards/prompt-ingress --mode full --json
```

Expected:

- `id` is `safeguards/prompt-ingress`, `kind` is `capability`, `domain` is `safeguards`, `status` is `draft`.
- Parent `safeguards` lists capability `prompt-ingress`.
- SPEC, WHY, RUNBOOK, and CHECKS all exist.
- The SPEC names `allow`, `soft_flag`, and `block`, and names `publishSessionPromptPublication` and `dispatchPrompt`.

## Behavior Is Unchanged

```bash
test ! -e src/safeguards
bun test src/triggers/__tests__/prompt.test.ts
```

Expected:

- no `src/safeguards` tree;
- catalog mail prompts omit `Data:`;
- manual prompts still include `Data:` and the event JSON.

## Inventory Still Matches The Tree

```bash
rg -n "JSON.stringify\\(event.data" src/triggers/prompt.ts
rg -n "page\\.comment\\.created" src .ravi/specs/safeguards/prompt-ingress/SPEC.md
rg -n "BUG_FOLLOW_TRIGGER_MESSAGE" src/bug-report/follow.ts
rg -n "bodyText" src/inbox/mail-enrichment.ts
rg -n "NON_DURABLE_PROMPT_CONTROL_OPERATIONS" src/runtime/control-host.ts
```

Expected:

- `buildTriggerPrompt` still stringifies `event.data` for the non-catalog path.
- `page.comment.created` appears in the prompt-ingress SPEC and not under `src/`.
- bug follow still uses a manual message.
- mail enrichment still sets `bodyText`.
- steer and follow-up stay in the disabled control set.

## Policy Review

A reviewer SHOULD be able to answer these from the SPEC without reading this CHECKS file:

- Which hook runs before `publishDurably()`, and which runs before `handlePrompt`?
- Why does `unknown` fail open while `console.page.comment` fails closed?
- Why does a block leave the inbox NATS payload and the mail body in SQLite?
- Why is control chat listed and then left unwired?
- Which three external suites are named, and why their files are not in the repo?

## Out Of Scope For This Change

Do not add a detector test, a fixture corpus, or a publish-path unit test that imports a safeguard module. Those belong to the base implementation PR.
