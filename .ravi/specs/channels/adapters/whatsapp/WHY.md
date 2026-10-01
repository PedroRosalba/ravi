# Why A Native, Bridge-Compatible WhatsApp Adapter

Omni is a separate service (API, Postgres, its own NATS streams) that Ravi
installs and supervises only to hold WhatsApp sockets. Every WhatsApp turn
depends on that second runtime staying healthy, and most WhatsApp fixes land in
another repository. Moving the Baileys socket into the `ravi channels` runner
removes that dependency for WhatsApp while reusing the same patched Baileys
build and the hard-won fixes Omni carries (write-behind key store, LID-first
sender keys, decrypt-failure tracking, echo suppression, edit dedupe, reconnect
rules).

## Why Keep The Omni Event Contract

Every WhatsApp behaviour in Ravi today is defined against Omni's events: the
consumer pipeline, session keys, chat and contact persistence, LID handling,
prompt formatting, group metadata, mentions, typing and the tests that pin
them. Emitting the same envelopes and answering the same client calls makes the
native transport invisible to that code. An instance can switch transport
without forking its sessions or chats, and the existing tests keep proving
parity.

## Why Not The Channel Backend (Yet)

The Slack adapter enters through the Channel Backend, and the `channels`
invariant asks the same of every native provider. Doing that for WhatsApp now
would change runtime semantics that WhatsApp users rely on:

- backend-owned prompts carry an isolated turn envelope, which turns off agent
  debounce batching and native-steer injection and terminalizes coalesced
  prompts as interrupted;
- backend-owned turns skip gateway text delivery, losing outbound `@mention`
  resolution, the TTS emit, contact interaction records and presence renewal;
- the edit-restart flow needs the in-process daemon session, which the runner
  does not have.

Porting those behaviours into the backend is a separate project. Until then the
adapter keeps the Omni path, and the deviation is written down in the spec with
its exit condition so it does not become precedent for other providers.

## Why Ownership Comes From The Channel Row

Ownership has to be decided in three processes (runner, daemon consumer,
gateway/CLI routing client) from the same data. Deriving it from the existing
`channels` and `instances` tables means there is no extra flag to drift, a
config change is one `ravi.config.changed` away from every process, and
rollback is one `ravi channels set <name> enabled false`.

Keeping the instance UUID as the transport id is what makes migration lossless:
sessions, chats, platform identities and `RAVI_INSTANCE_ID` values written under
Omni stay attached when the instance moves.

## Why A Single Socket Owner

WhatsApp allows one live session per set of credentials. A second socket with
the same creds (a probe runner, a second host, a stale process) triggers
`connectionReplaced` and both sides fight. Keeping sockets only in the runner,
skipping them in `channels probe`, and never reconnecting after a replace keeps
the failure visible instead of flapping. Omni and native also must not both
serve one account: they would be two linked devices delivering every message
twice, which the consumer's native-ownership filter only partially hides.

## Why Bundle Baileys Into The CLI

The patched Baileys is a local `file:` tarball. A published package that
declares a `file:` dependency, even as optional, cannot be installed with
`bun add`, so the tarball is a build-time input and the bundle carries Baileys
inline. Code splitting keeps it out of the CLI's startup path: Bun hoists the
static imports of a dynamically imported module to the top of a single-file
bundle, which would load Baileys on every CLI command.
