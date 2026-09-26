# Safeguards / Prompt Ingress / WHY

## Rationale

Open Console text becomes a model turn in one place, and that place does not look at the text.

`buildTriggerPrompt` appends `JSON.stringify(event.data)` for every trigger whose message is not a catalog template. The trigger runner then calls `publishSessionPrompt`. `publishSessionPromptPublication` writes that payload to `SESSION_PROMPTS` and records a trace. `RuntimePromptSubscription.dispatchPrompt` parses it and calls `handlePrompt`. Nothing between those steps classifies the author or drops a span.

That is why a page comment does not need a dedicated parser to become an instruction. Console can emit `page.comment.created` as an ordinary inbox item. `src/` never mentions that string. It still copies `title`, `summary`, and `payload` onto `ravi.console.inbox.item`, and a manual trigger prints them into the prompt. The same dump carries GitHub comment payloads (`issue_comment.created` is a full-fidelity watch) and bug-follow events (the follow message is manual, so the watch JSON is included).

Mail is the cautionary split. The local topic `ravi.inbox.mail.received` is metadata plus subject. The catalog template interpolates the subject and points the agent at `ravi mail messages read`. Separately, mail enrichment inlines the full parsed body onto the Console delivery event, because `cli/inbox` requires that. A manual trigger on `ravi.console.inbox.item` then dumps the body. Screening has to sit on the prompt, not on the NATS publish, or it would violate that mail contract.

Control chat is not a path yet. `turn.steer` and `turn.follow_up` are refused before publish. Pages ship uploads bytes the local agent already wrote; this repo never reads hosted HTML back. Artifacts, task comments, and tickets are local records, not public Console ingress.

## Decisions

- One decision function, two hooks. Console screens before it emits. OSS screens before JetStream publish and again before the turn, so replay cannot skip the screen.
- `buildTriggerPrompt` is the span adapter. It knows which fields are the operator's message and which fields came from the event. The publication helper only sees a finished string, so unknown strings fail open. Known external surfaces must be labeled before they are stringified.
- Empty detector registry returns `allow` and does not trace. The spec can merge without a behavior change. The first detector ships default-off.
- Fail-closed is for stranger text (public comments, mail body/subject). Fail-open is for the operator's own prompt and for bug ids the operator asked to follow. A scanner outage must not hide bug status and must not execute a public comment.
- Block replaces the span. It does not throw, does not nak forever, and does not change inbox ack or tool grants.
- Mirror Model Armor as a decision envelope if Console already screens mail. Do not add a Model Armor client to OSS in v0. This tree has no such client today.
- Keep benchmark corpora out of git. Name PromptInject/BIPIA, JailbreakBench, and a Garak subset (`promptinject`, `dan`, `encoding`) for a later `ravi eval`.

## Rejected Alternatives

- Screening only in the system prompt. `permissions/enterprise` already says the model will be manipulated. A marker on `soft_flag` is provenance, not enforcement.
- Screening inside `permissions`. A content verdict is not a relation, and it must not grant or deny tools.
- Stripping the inbox NATS payload. Mail enrichment is required to keep the full body on the delivery event. Shell triggers and replay are not the model. The prompt renderer is.
- A single consume-only hook. A blocked comment would still sit on `SESSION_PROMPTS` and would be model-visible to anything that reads the stream. Publish-time block avoids writing it. Consume-time block still has to exist for replay and for publishers that skip the helper.
- A single publish-only hook. Replay of a prompt that was stored before the screen existed would skip it. Consume rechecks the content hash.
- Fail-closed for `unknown`. Most operator prompts are not yet labeled. Fail-closed there drops cron and CLI turns. External surfaces are labeled at `buildTriggerPrompt` so they do not depend on that fallback.
- Vendoring attack corpora "so CI can score injection." The sets are large, they rot, and they are not the contract. A few hand-written fixtures cover the policy table.
- An inert TypeScript stub in this change. An unimported file is dead code. An imported file is a behavior change the moment it wraps `publishDurably`. The interface in the spec is the plug. The base module is the next PR.
