---
id: channels/adapters/whatsapp
title: "WhatsApp Adapter (native Baileys)"
kind: feature
domain: channels
capabilities:
  - whatsapp
tags:
  - baileys
  - native-channel
  - omni-compat
applies_to:
  - src/channels/whatsapp/
  - src/omni/consumer.ts
  - src/omni/group-metadata-cache.ts
  - src/omni/sender.ts
  - src/omni/channel-wiring.ts
  - src/cli/commands/instances.ts
status: active
normative: true
---

# WhatsApp Adapter (native Baileys)

## Scope

The native WhatsApp adapter MUST let Ravi run a WhatsApp account without the
Omni bridge. It is a drop-in replacement for Omni's WhatsApp (Baileys)
transport:

- the Baileys socket MUST live in the `ravi channels` runner, one runtime per
  enabled `channels` row with provider `whatsapp`;
- inbound events MUST reach the daemon in the exact envelope shape Omni emits,
  so session keys, chats, contacts, prompts and every existing WhatsApp test
  stay valid;
- outbound and control calls MUST keep the Omni client surface (`OmniClient`,
  `OmniSender`); a routing client sends calls for natively owned instances to
  the runner over NATS request/reply and everything else to the Omni HTTP API;
- Omni MAY keep serving other instances (and Telegram/Discord) at the same time.

The contract lives in `src/channels/whatsapp/contract.ts`; the stream helpers
in `src/channels/whatsapp/inbound-stream.ts`.

## Temporary Deviation From The Channel Backend Invariant

`channels` requires every native provider to enter Session/Turn execution
through the provider-neutral Channel Backend. The native WhatsApp adapter is an
explicit, temporary exception:

- it MUST publish Omni-compatible envelopes on `CHANNEL_INBOUND`, and the
  daemon's channel consumer (`src/omni/consumer.ts`) MUST run the same pipeline
  it runs for Omni events, publishing the ordinary session prompt;
- it MUST NOT call `host.ingress` / `acceptChannelIngress`, and its driver MUST
  declare only the `inbound` capability;
- outbound text MUST keep going through the gateway's Omni-style delivery path
  (`OmniSender`), not the `CHANNEL_OUTBOUND` work queue.

The exception exists only to keep parity with the Omni path (see WHY). It MUST
end when the Channel Backend supports agent debounce, gateway text delivery
(outbound mention resolution, TTS, contact interaction, presence renew) and the
edit-restart flow for backend-owned turns; the adapter then moves to
`acceptResolvedChannelIngress` like Slack. No other provider MAY cite this
exception.

## Ownership And Identity

- A `channels` row with provider `whatsapp` binds the Ravi instance whose
  `instances.name` equals the channel name, or `defaults.instance` when set
  (`listNativeWhatsAppBindings`). A disabled or deleted channel row binds
  nothing.
- An instance is natively owned while such a binding exists and the instance
  has an `instance_id`. Ownership is evaluated from live config; there is no
  separate switch.
- The transport instance id MUST be `instances.instance_id`, a UUID. A new
  native instance mints one with `crypto.randomUUID()`. An instance migrated
  from Omni MUST keep its existing UUID. The channel name MUST NOT be used as a
  transport instance id.
- Subject channel type MUST be `whatsapp-baileys`; envelope
  `metadata.source` MUST be `ravi.whatsapp.native`.
- `message.received` payloads MUST match Omni byte-for-byte in shape:
  `from` is the bare sender id (no `@domain`), `chatId` is the canonical
  LID-first JID, `rawPayload` is the WAMessage plus Omni's extended fields.
- Outbound message ids returned by the RPC MUST be Baileys `key.id`.

## Inbound Events

- The runner MUST publish every transport envelope through
  `publishChannelInboundEvent` on stream `CHANNEL_INBOUND` (subjects
  `ravi.channel.inbound.>`, limits retention, file storage, 7 days), subject
  `ravi.channel.inbound.<type>.whatsapp-baileys.<instanceId>`, with the event id
  as JetStream `msgID` so redeliveries collapse in the duplicate window.
- Published types: `message.received` (including edits and deletes),
  `reaction.received`, `instance.qr_code`, `instance.connected`,
  `instance.disconnected`.
- History sync and Baileys offline backlog MUST be published with
  `metadata.ingestMode = "history-sync"`. The consumer MUST still persist chat,
  message, participant and contact for them and MUST NOT prompt an agent.
- The daemon consumer MUST read the native source with durables
  `ravi-native-messages`, `ravi-native-instances` and `ravi-native-reactions`,
  strip the `ravi.channel.inbound.` prefix, validate the envelope with
  `WhatsAppTransportEventSchema`, and hand the Omni subject to the unchanged
  handlers.
- The consumer MUST ignore Omni-sourced events (message, instance, reaction)
  whose instance is natively owned, so an account connected on both sides is
  never processed twice.

## Media

- The runner MUST download inbound media itself to
  `<RAVI_STATE_DIR>/media/whatsapp/<instanceId>/<YYYY-MM>/<id><ext>` and set
  `content.mediaUrl = file://<abs>` and `content.localPath = <abs>`.
- The consumer MUST read `file://` media (and an absolute `localPath` when no
  media URL exists) from disk, only under `<RAVI_STATE_DIR>/media` after
  resolving symlinks, with the same size limits as Omni media. It MUST NOT send
  a `file://` URL to the Omni API.
- Outbound media and stickers MUST be sent by absolute `filePath`; the routing
  client drops base64 for native targets.

## Process Boundary And RPC

- Only the runner holds sockets. Daemon, gateway and CLI MUST reach it over
  NATS request/reply on `_RAVI.channels.whatsapp.rpc.<instanceId>`, queue group
  `ravi-whatsapp-rpc`.
- Requests MUST carry `{protocol: "ravi.channels.whatsapp.rpc", schemaVersion:
  1, requestId, instanceId, method, params}` and be validated with
  `WhatsAppRpcRequestSchema` plus the per-method params schema on both sides.
- Responses MUST be `{ok: true, requestId, data}` with exactly the
  `WhatsAppRpcResults[method]` shape (the Omni REST shape for the same client
  call), or `{ok: false, requestId, error: {status, code, message}}`.
- Error statuses MUST stay HTTP-like so Omni retry logic keeps working:
  `INVALID_REQUEST` 400, `NOT_FOUND` 404, `PAIRING_REQUIRED` 409,
  `RATE_LIMITED` 429, `TRANSPORT_ERROR` 502, `NOT_CONNECTED` 503. Client-side:
  no responders is 503 `WHATSAPP_RUNNER_UNAVAILABLE` (the message names
  `ravi channels start`), a timeout is 504 `WHATSAPP_RPC_TIMEOUT`, a malformed
  reply is 502 `WHATSAPP_RPC_INVALID_RESPONSE`.
- A call for a non-native instance with Omni unconfigured MUST fail with 503
  `OMNI_NOT_CONFIGURED` and MUST NOT be retried.

## Pairing

- `instances.connect` MUST reconnect when stored creds exist and otherwise open
  a socket that produces QR codes. QR codes and the connected event MUST be
  published as `instance.qr_code` / `instance.connected` envelopes, so the
  daemon re-emits `ravi.whatsapp.qr.<uuid>` / `ravi.whatsapp.connected.<uuid>`
  and registers the agent platform identity exactly as for Omni.
- `ravi instances connect <name> --transport native` MUST provision the
  instance and the channel row, subscribe to the QR/connected topics before the
  connect RPC, and wait for them; pairing therefore needs both the runner and
  the daemon running.
- Auth state MUST persist in the router DB table `whatsapp_auth_state`
  (`instance_id`, `key`, `value`, `updated_at`, primary key
  `(instance_id, key)`), created lazily, with Omni's write-behind cache
  semantics. A 401 `loggedOut` MUST clear it.

## Single Socket Owner

- Exactly one process MUST hold the Baileys socket of an instance: the
  `ravi-channels` runner. `ravi channels probe` MUST NOT open WhatsApp sockets.
- Two runners on the same router DB and NATS MUST NOT run at once; the runtime
  MUST NOT reconnect after a 440 `connectionReplaced`, which is the symptom.
- Moving an instance from Omni to native MUST disconnect it on Omni first.

## Runner Lifecycle And Health

- `start()` MUST NOT block on the network: with creds it connects in the
  background, without creds it reports health `starting` with reason
  `pairing_required` and waits for a connect RPC.
- Health MUST map the socket state: `connected`, `starting` (`pairing_required`,
  `qr_pending`), `reconnecting`, `disconnected` (with the close reason, e.g.
  `logged_out`, `connection_replaced`), and `failed` with `missing_dependency`
  when Baileys cannot be loaded.
- On `ravi.config.changed` the runner MUST start runtimes for newly added or
  enabled WhatsApp channels and stop removed or disabled ones without a runner
  restart.
- The runner is not started by `ravi daemon start`; native WhatsApp needs
  `ravi channels start`.

## Packaging

- Baileys is a vendored, patched tarball (`vendor/baileys/`) and MUST be
  committed. Baileys and the `audio-decode` shim are build-time
  devDependencies inlined into the CLI bundle; the published package MUST NOT
  declare a `file:` dependency.
- `build:cli` MUST use code splitting so the Baileys-backed module
  (`runtime-library.ts`) loads only when a WhatsApp runtime starts; `sharp`
  stays external and is imported lazily.
