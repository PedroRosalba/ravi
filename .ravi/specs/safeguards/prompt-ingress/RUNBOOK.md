# Safeguards / Prompt Ingress / RUNBOOK

## What This Spec Is For

Use it to find the plug points and the decision type. It does not turn a screen on.

If a prompt from a public page, a GitHub comment, a followed bug, or a mail subject starts acting on stranger text, this is the path to inspect. The fix is not a new sentence in the system prompt.

## Confirm The Current Dump

Manual triggers embed the event. Catalog templates do not, but they still interpolate fields.

```bash
bun test src/triggers/__tests__/prompt.test.ts
```

Expected: the manual case contains `Data:` and the raw JSON. The catalog mail case does not contain `Data:`.

The bug-follow message is manual:

```bash
rg -n "BUG_FOLLOW_TRIGGER_MESSAGE" src/bug-report/follow.ts
```

Expected: a fixed operator sentence, not a catalog template id. `buildTriggerPrompt` will append the watch payload.

## Confirm Page Comments Are Opaque Here

```bash
rg -n "page\.comment\.created" --glob '!*.md' .
```

Expected: no matches under `src/`. Ingress is still the inbox copy in `src/inbox/inbox-runner.ts` (`handleItem` → `publishInboxNatsEvents`) plus `buildTriggerPrompt`.

## Confirm Control Chat Is Not A Publisher

```bash
rg -n "turn.steer|turn.follow_up" src/runtime/control-host.ts
```

Expected: both operations are rejected before a prompt is published.

## Confirm Mail Body Is On The Delivery Event, Not The Local Inbox Topic

- Full body: `enrichMailMessageReceivedPayload` sets `payload.mail.bodyText` and `payload.mail.bodyHtml`.
- Local topic: `buildLocalInboxMailReceivedPayload` carries subject and snippet, not the body.
- Catalog template: `mail-inbox-default` in `src/triggers/topic-catalog.ts` interpolates subject and tells the agent to read the message.

Do not "fix" injection by truncating the NATS mail payload. `cli/inbox` requires the enriched body to stay on the event.

## Where An Implementation Plugs In

1. Decision function, empty registry, proposed `src/safeguards/prompt-ingress/`.
2. Span labels in `buildTriggerPrompt` (`src/triggers/prompt.ts`), before the string is finished.
3. Publish gate at the start of `publishSessionPromptPublication`, before `publishDurably()`.
4. Consume gate in `RuntimePromptSubscription.dispatchPrompt`, before `handlePrompt`.
5. Console pre-emit in the sibling Console service, same `ravi.safeguard/v1` object.

Block must not throw out of `publishSessionPrompt`. The trigger runner increments fire count after publish returns. Inbox ack must still succeed when the model did not see the span.

## What To Do When A Comment Arrives And The Screen Is Off

That is today's behavior. The event is on `ravi.console.inbox.item`. If a trigger matches, the model sees the JSON. Tool authority is still `permissions`. Do not tell the operator the screen ran.

## Follow-Up Order

1. Base module and unit tests. Empty registry. No detector.
2. Wire page comments, provider comments, and bug-follow field classes. Guard control-chat only if steer/follow-up start publishing. Leave the detector default off.
3. External benchmarks: PromptInject/BIPIA, JailbreakBench, Garak probes `promptinject`, `dan`, `encoding`. No corpora in the repo.
