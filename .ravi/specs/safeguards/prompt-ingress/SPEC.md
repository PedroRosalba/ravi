---
id: safeguards/prompt-ingress
title: "Prompt Ingress Safeguard"
kind: capability
domain: safeguards
capability: prompt-ingress
capabilities:
  - prompt-ingress
tags:
  - safeguards
  - prompt-injection
  - console
  - triggers
  - inbox
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/triggers/prompt.ts
  - src/triggers/runner.ts
  - src/triggers/template.ts
  - src/omni/session-prompt-publication.ts
  - src/omni/session-stream.ts
  - src/runtime/prompt-subscription.ts
  - src/runtime/session-surface-hint.ts
  - src/inbox/inbox-runner.ts
  - src/inbox/types.ts
  - src/inbox/mail-enrichment.ts
  - src/inbox/local-events.ts
  - src/bug-report/follow.ts
  - src/watch/events.ts
  - src/watch/connectors.ts
  - src/runtime/control-host.ts
  - src/pages/ship.ts
  - src/pages/client.ts
---

# Prompt Ingress Safeguard

## Intent

Define an agnostic screen for untrusted text that enters a Ravi model turn from open Console surfaces.

The screen is a pure decision: text plus metadata in, `allow | soft_flag | block` plus reasons out. Detectors plug in behind that decision. This spec does not ship a detector.

Two hooks share one decision function:

1. **Console pre-emit.** Before Console releases an inbox item, mail plaintext, or bug-status payload to a subscriber.
2. **OSS prompt publish/consume.** Before a prompt is stored on `SESSION_PROMPTS`, and again before that prompt starts a turn.

OSS Ravi does not contain Console. The Console hook is a contract for the sibling service. The OSS hook is the contract for this repo.

This spec is design-only. It MUST NOT change runtime behavior. No detector, dataset, or call site is added here.

## Decision Contract

Implementers MUST put the contract in a single module (proposed `src/safeguards/prompt-ingress/`) and MUST call that module from both OSS call sites. Console MUST use the same shapes on the pre-emit boundary. Versions MUST travel with the decision (`schemaVersion: "ravi.safeguard/v1"`).

```ts
type SafeguardAction = "allow" | "soft_flag" | "block";

type TrustTier = "operator" | "agent" | "known_contact" | "external" | "unknown";

type SafeguardSurface =
  | "console.page.comment"
  | "console.bug.status"
  | "console.mail"
  | "console.pages.content"
  | "watch.provider.comment"
  | "channel.inbound"
  | "operator.prompt"
  | "unknown";

interface SafeguardSubject {
  text: string;
  metadata: {
    surface: SafeguardSurface;
    trustTier: TrustTier;
    organizationId?: string;
    projectId?: string;
    pageId?: string;
    authorId?: string;
    authorKind?: string;
    eventType?: string;
    topic?: string;
    sourceRef?: string;
  };
}

interface SafeguardReason {
  detectorId: string;
  code: string;
  /** Safe to log and trace. MUST NOT contain the raw span. */
  summary: string;
}

interface SafeguardDecision {
  schemaVersion: "ravi.safeguard/v1";
  action: SafeguardAction;
  reasons: SafeguardReason[];
  /** sha256 of the exact UTF-8 span that was screened. */
  contentSha256: string;
  surface: SafeguardSurface;
  trustTier: TrustTier;
}

interface PromptSafeguardDetector {
  id: string;
  inspect(input: SafeguardSubject): Promise<SafeguardDecision>;
}
```

Rules:

- Callers MUST pass the model-visible span, not a surrounding trusted instruction, when the span is known.
- `contentSha256` MUST be the hex SHA-256 of that span's UTF-8 bytes. A later edit MUST NOT reuse an `allow` bound to a different hash.
- Reasons MUST NOT echo the raw span, a prefix of the span, or a reversible encoding of the span.
- An empty detector registry MUST return `allow` with `reasons: []` and MUST NOT emit a trace. That is the inert default and the only legal behavior until a detector is registered and explicitly enabled.
- Aggregation MUST be severity order `block` > `soft_flag` > `allow`. Reasons concatenate. Detector order MUST be sorted by `id` so the same inputs produce the same decision.
- A detector that throws or exceeds its budget MUST be treated as `detector_error`, not as `allow`, and the surface error policy below decides the outcome.
- Detector budget SHOULD be local and bounded (default 50ms per detector and 200ms for the set). A network detector is out of v0.
- v0 detectors MUST be in-process plugins registered by the host. They MUST NOT be loaded from page content, mail, or a trigger payload.

### Actions

| Action | What the model sees | What is recorded |
|---|---|---|
| `allow` | The original span. | Decision only when a detector actually ran. |
| `soft_flag` | The original span, wrapped by a provenance marker. | Reasons, surface, trust tier, content hash. |
| `block` | A fixed omission placeholder. The span is absent. | Reasons, surface, trust tier, content hash. The span is absent. |

The provenance marker identifies where the span came from. It MUST NOT be phrased as a security instruction the model is trusted to obey. `permissions` remains the control that stops a tool call.

Block placeholder shape: `[content omitted by safeguard surface=<surface>]`.

`soft_flag` and `block` MUST NOT change tool grants, session routing, or inbox ack.

## Where To Plug

### OSS publish

`publishSessionPrompt` in `src/omni/session-stream.ts` funnels every durable prompt through `publishSessionPromptPublication` in `src/omni/session-prompt-publication.ts`.

The publish hook MUST run inside `publishSessionPromptPublication`, before `publishDurably()`.

- `allow` and `soft_flag` publish the (possibly marked) payload.
- `block` MUST NOT call `publishDurably()` and MUST NOT throw. Callers, including the trigger runner, treat the call as finished so cooldown and inbox ack still advance.
- The stored payload MUST carry the decision on `_safeguard` when a detector ran, including `contentSha256`.
- The screened string MUST be `resolveRuntimePromptText` (`_runtimePrompt ?? prompt` in `src/runtime/session-surface-hint.ts`). If `prompt` and `_runtimePrompt` differ, both MUST be screened. A block on either blocks the publish.

### OSS consume (pre-turn)

`RuntimePromptSubscription.dispatchPrompt` in `src/runtime/prompt-subscription.ts` MUST screen immediately before `handlePrompt`.

- If `_safeguard.contentSha256` matches the current model-visible text, consume MUST enforce that stored action and MUST NOT call detectors again.
- If the hash is missing or does not match, consume MUST run the decision function. This covers replay and any producer that bypassed the publication helper.
- `block` MUST ack the JetStream message. It MUST NOT nak in a loop. It MUST NOT call `handlePrompt` with the raw span.
- `block` and `soft_flag` MUST emit a runtime trace (`safeguard.blocked` or `safeguard.flagged`) whose payload is the decision without the span.

### OSS span adapter (not a third policy)

`buildTriggerPrompt` in `src/triggers/prompt.ts` is where untrusted event JSON becomes prompt text. It MUST attach surface metadata and isolate untrusted spans before publish, then call the same decision function. It MUST NOT implement a private allow/block list.

Today, a non-catalog trigger returns:

```text
[Trigger: <name>]
Event: <topic>
Data: <JSON.stringify(event.data)>

<resolved message>
```

`JSON.stringify(event.data)` is the whole event, unbounded, with no inspection. Catalog templates skip that dump (`usesCatalogMessageTemplate`) but `resolveTemplate` in `src/triggers/template.ts` still interpolates `{{data.*}}` into the message (truncated at 300 characters). Both paths are in scope. The operator-authored trigger `message` is `operator` text. Event fields are not.

The adapter MUST NOT strip or rewrite the NATS payload. `cli/inbox` requires enriched mail content to remain on the delivery event. Shell triggers, replay, and `ravi inbox items` keep the raw event. The screen applies when that event is rendered into a prompt.

### Console pre-emit

Before Console sends a subscriber any of the spans below, it SHOULD call the same decision function:

- public page comment body (`page.comment.created` and any watch-prefixed alias);
- mail subject, snippet, and `parsed_body` plaintext, if Console is the component that materializes them;
- bug-status free-text fields (`title`, and any comment, note, or body field).

On `block`, Console SHOULD emit metadata plus the decision and SHOULD omit the span. On `soft_flag` and `allow`, Console SHOULD attach the decision so OSS can reuse the hash. OSS MUST treat a missing decision as unscanned. OSS MUST NOT assume a Console screen ran.

If Console already screens mail with Model Armor (or a successor) before it returns `parsed_body`, that screen SHOULD emit `ravi.safeguard/v1` rather than a private verdict. This repo has no Model Armor client and MUST NOT grow one in v0. The pattern to mirror is the decision envelope, not the vendor call.

## Inventory

Verified in this repo unless marked Console-owned. "Model-visible" means the bytes are placed in a session prompt or interpolated into one.

| Surface | Trust | Model-visible path in this repo | v0 policy |
|---|---|---|---|
| Page comment `page.comment.created` | `external` (missing author counts as `external`) | Console-owned name. OSS copies `eventType`, `title`, `summary`, `actor`, `payload` verbatim onto `ravi.console.inbox.item` (`InboxRunner.handleItem`). A non-catalog trigger then dumps that JSON. No allowlist, no redaction. | Fail-closed. |
| Provider comment (`issue_comment.created`, `pull_request_comment.created`, `pull_request_review.commented`) | `external` when the repo is public; `unknown` otherwise, treated as external | Declared full-fidelity Console watches in `src/watch/connectors.ts`. `watchEventFromInboxPayload` republishes `payload` on `ravi.watch.<connector>.<event>`. Same JSON dump. | Fail-closed. |
| Bug follow `ravi.watch.console.bug.status` | Structured ids are operator-adjacent. `title` and any free-text field are untrusted. | `ensureBugFollowTrigger` arms a manual message, so `buildTriggerPrompt` appends the full event. Catalog fields are `bugId`, `title`, `status`, `consoleUrl`. Extra fields are dumped too, because the serializer is the whole object. | Fail-open for id/status/url. Fail-closed for free text (`title`, comment, note, body). |
| Mail subject / snippet on the local inbox topic | `external` until the sender is a known contact | `ravi.inbox.mail.received` is metadata plus subject and snippet (`src/inbox/local-events.ts`). The catalog template interpolates subject, from, and to. It does not dump the body. | Fail-closed for subject and snippet when a detector is enabled. Detector error drops those spans and still delivers the message id. |
| Mail body | `external` until the sender is a known contact | Not on the local inbox topic. `enrichMailMessageReceivedPayload` inlines `bodyText` and `bodyHtml` onto the Console delivery payload with no truncation and no screen. A manual trigger on `ravi.console.inbox.item` dumps that JSON. `ravi mail messages read` is a later tool result. | Fail-closed before the body is placed in a prompt. Do not truncate or redact the NATS payload. Tool-result reads are a non-goal for v0. |
| Pages ship / hosted bytes | `operator` or `agent` on the way out | `ravi pages ship` uploads local HTML. `src/pages/client.ts` does not fetch hosted HTML back into a prompt. | Do not screen ship egress in v0. A future read-back of a public page is `console.pages.content` at `external` and uses this same contract. |
| Control chat | Not OSS-visible | `turn.steer` and `turn.follow_up` are rejected in `handleRuntimeControlRequest` before any prompt is published. No Console chat publisher exists under `src/`. | No wire target today. If steer/follow-up text is later published through `publishSessionPrompt`, it MUST pass this hook. A public widget is fail-closed. An operator console is fail-open. |
| Channel inbound (WhatsApp, Slack, Telegram, Discord) | `known_contact` or `external` | `src/omni/consumer.ts` publishes the raw envelope via `publishSessionPrompt`. | Unscanned in v0 (`allow`). The hook MUST NOT default-block these turns. |
| Operator prompts (CLI, cron, heartbeat, task dispatch, sessions send) | `operator` or `agent` | Same publication helper, with `_cron`, `_heartbeat`, `_trigger`, or CLI markers. | Fail-open. Detector errors MUST NOT drop the operator's own prompt. |
| Artifacts, task comments, tickets, approvals | Not an open Console ingress | Artifact bytes and task-comment bodies are local records an agent can read. Slack tickets are a workflow demo. Approvals are operator decisions on tool use. | Out of v0 enforcement. The decision type MAY wrap a later tool-result hook. This contract MUST NOT screen them by default. |

### Page comments, specifically

The literal `page.comment.created` does not appear under `src/`. Console event types are opaque strings. The ingress is still real:

1. Console poll returns `ConsoleInboxItem` (`src/inbox/types.ts`) with `eventType`, `title`, `summary`, `actor`, `organization`, `project`, `source`, `target`, `payload`.
2. `handleItem` copies those fields into `InboxNatsPayload` and `publishInboxNatsEvents` publishes `ravi.console.inbox.item`.
3. If `eventType` starts with `watch.`, the same payload is republished on `ravi.watch.<connector>.<event>`.
4. `TriggerRunner` calls `buildTriggerPrompt`, which stringifies `event.data` for every manual message.

The surface map MUST classify a page comment from either envelope:

- Inbox item on `ravi.console.inbox.item`: `eventType` is `page.comment.created`, or a watch-prefixed alias `watch.pages.comment.created` / `watch.console.page.comment.created`.
- Normalized watch event: `watchEventFromInboxPayload` splits `watch.<connector>.<event>` into `connector` and `eventType`, then publishes `ravi.watch.<connector>.<event>`. A pages comment therefore arrives with `connector: "pages"` and `eventType: "comment.created"`, not with the original inbox string. Match that pair, or the topic, as `console.page.comment`.

Provider comments are the same split: inbox `watch.github.issue_comment.created` becomes watch `connector: "github"` and `eventType: "issue_comment.created"`. The map MUST match the normalized event type (`issue_comment.created`, `pull_request_comment.created`, `pull_request_review.commented`).

Unknown event types stay `unknown` and follow the unknown policy. Adding a new open Console event MUST be a surface-map change, not a new screen. The literal `page.comment.created` is not in `src/` today; the map is how OSS recognizes it once Console sends it.

Metadata the adapter MUST read when present: `organization.id`, `project.id`, `actor.id`, `actor.type`, `source.id` as `pageId` when `source.type` is a page, `eventType`, and the NATS topic. Missing author on a page comment MUST be `trustTier: "external"`.

### Bug follow, specifically

`BUG_FOLLOW_TRIGGER_MESSAGE` in `src/bug-report/follow.ts` is not the catalog template. `usesCatalogMessageTemplate` is therefore false, and the watch payload is appended as `Data:`.

The operator sentence ("Tell the user the new status...") is `operator.prompt`. `payload.bugId`, `payload.status`, and `payload.consoleUrl` MAY pass through on detector error. `payload.title` and any other string field MUST be screened as untrusted free text.

### Mail, and the Model Armor pattern

`cli/inbox` forbids OSS from inventing mail selection or redaction, and it requires the enriched NATS JSON to keep the full parsed body. This safeguard MUST NOT weaken that rule.

The screen runs only when a prompt is built or consumed. The mailbox, the delivery mirror, and `ravi mail messages read` keep the body. v0 does not screen tool results, so a model that is told to read the message can still load the body until a later hook exists. The catalog mail trigger is the path that avoids that by default: it names the message id and the subject, not the body.

There is no Model Armor reference in this repo. If Console already screens mail before plaintext leaves Console, OSS mirrors the pattern by honoring a `ravi.safeguard/v1` decision bound to the body hash. Absent that decision, body text that a prompt is about to include is unscanned and the mail error policy applies.

## Fail-Open And Fail-Closed

Error policy applies when the registry is non-empty and a detector throws, times out, or returns an invalid decision. An empty registry is `allow`, not an error.

| Surface | On detector error | Why |
|---|---|---|
| `console.page.comment` | Fail-closed (`block`, reason `detector_error`) | A public comment is not something the operator just typed. Delivering it during an outage hands a stranger the agent's tools. |
| `watch.provider.comment` | Fail-closed | Same, for a public issue or review comment. |
| `console.mail` body, subject, snippet | Fail-closed for those spans only | The operator still learns that a message exists. The body is not inlined. The NATS copy is kept. |
| `console.bug.status` ids | Fail-open | The operator asked to follow this bug. A scanner outage must not hide status. |
| `console.bug.status` free text | Fail-closed for those fields only | Title and comments are attacker-influenceable. Status and the URL still arrive. |
| `operator.prompt` | Fail-open, trace `safeguard.degraded` | The operator's own cron, heartbeat, and CLI must keep working. |
| `channel.inbound` | Unscanned `allow` in v0 | Wiring the hook must not change channel turns. |
| `unknown` | Fail-open | Publish/consume cannot reliably recover trust from a bare string. Fail-closed here would drop operator prompts that lack a marker. Known external surfaces MUST be classified before they are stringified, so they do not fall through to `unknown`. |

Fail-closed means the span is replaced with the block placeholder and the rest of a mixed prompt MAY still be delivered. Fail-closed MUST NOT drop an entire operator trigger message because one field failed.

## What v0 Does Not Do

- MUST NOT add a detector, a regex jailbreak list, a model-as-judge, or a Model Armor client.
- MUST NOT vendor PromptInject, BIPIA, JailbreakBench, or Garak corpora.
- MUST NOT change `publishSessionPrompt`, `buildTriggerPrompt`, inbox ack, or mail enrichment behavior while the registry is empty.
- MUST NOT screen `ravi pages ship` egress.
- MUST NOT screen tool results (`ravi mail messages read`, artifact reads, fetched URLs).
- MUST NOT screen shell-trigger event files. Those files are not model-visible until a prompt is published. Stdout that is later published is an ordinary prompt at the consume hook.
- MUST NOT screen channel inbound, artifacts, task comments, tickets, or approvals by default.
- MUST NOT build a control-chat surface. There is nothing to attach to until steer/follow-up can publish.
- MUST NOT grant or deny tools.

## Later Benchmarks

Benchmarks are an implementation follow-up. They MUST stay outside the git tree. Name and pin a version in the eval spec. Do not copy the datasets.

| Suite | What it measures here | How to run it later |
|---|---|---|
| PromptInject and BIPIA | Indirect injection, the page-comment and mail threat. | External runner. Score the decision function, not a live channel. |
| JailbreakBench | Direct jailbreaks, relevant if a public prompt box or control chat appears. | External runner, pinned JailbreakBench release. |
| Garak, subset only | Probe families `promptinject`, `dan`, and `encoding`. | External Garak. Do not import the full probe corpus. |

Tiny hand-written fixtures MAY live next to unit tests (one allow, one flag, one block, one detector error per surface policy). Those fixtures are not a benchmark.

The harness SHOULD be `ravi eval` once a detector exists. Pass/fail thresholds are chosen with that detector, not in this spec.

## Implementation Order

1. **Base.** Types, hash, aggregation, per-surface error policy, empty registry. Unit tests only. Wiring into publish/consume is allowed only when the empty registry leaves prompt bytes and publish behavior unchanged.
2. **Wire known ingress.** Surface map for `page.comment.created` (and the watch-prefixed alias), provider comment event types, and bug-follow field classes inside `buildTriggerPrompt`. Control chat: add a guard so that if `turn.steer` / `turn.follow_up` ever publish text, that text is a subject. Do not enable those operations in the wire PR.
3. **First detector, default off.** Enabling it turns on the fail-closed policies above. Default remains off.
4. **Benchmarks.** External PromptInject/BIPIA, JailbreakBench, and the Garak subset, via `ravi eval`, with no corpora committed.

## Acceptance

- A reviewer can name the decision type, the two hooks, and the function that turns event JSON into prompt text.
- Page comments, bug follow, mail, pages ship, and control chat each have a verified disposition.
- Empty registry means today's behavior: manual triggers still embed `Data: <json>`, catalog mail triggers still interpolate subject, bug follow still dumps the watch payload.
- No file under `src/safeguards/` exists as part of this spec.
