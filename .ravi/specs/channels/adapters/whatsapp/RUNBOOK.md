# WhatsApp Adapter Runbook

## Prerequisites

- `ravi daemon start` is running. It consumes `CHANNEL_INBOUND` and relays QR
  codes to the CLI.
- `ravi channels start` is running (PM2 process `ravi-channels`). The daemon
  does not start it.
- `ffmpeg` is on the runner's PATH for voice notes; `sharp` is installed for
  sticker conversion.

## New Native Account

1. Connect, choosing the native transport explicitly:

   ```bash
   ravi instances connect <name> --agent <agent> --transport native
   ```

   This mints the instance UUID, creates the `channels` row named `<name>`
   (provider `whatsapp`), emits `ravi.config.changed`, waits up to 15s for the
   runner to hot-add the channel, and prints QR codes until the phone links.
   `ravi settings set whatsapp.transport native` makes native the default.
   Without that setting, native is the default only when Omni is not
   configured.
2. Scan the QR code from WhatsApp > Linked devices. `--json` returns on the
   first QR code.
3. Verify:

   ```bash
   ravi instances status <name> --json   # transport "native", state "connected"
   ravi channels status                  # <name>: connected
   ```

4. Send a DM to the account and confirm the agent answers.

## Migrate An Omni Instance

Do one instance at a time.

1. Record the current state: `ravi instances show <name> --json`. Note the
   `instanceId` UUID; it must not change.
2. Make sure the runner and the daemon are running (prerequisites).
3. Disconnect the instance on Omni while it is still Omni-owned:

   ```bash
   ravi instances disconnect <name>
   ```

   Also remove Omni's linked device from the phone (WhatsApp > Linked devices),
   or log the instance out in Omni, so two devices do not receive every message.
4. Connect natively and scan the new QR code:

   ```bash
   ravi instances connect <name> --transport native
   ```

   The instance keeps its UUID; the command only adds the channel row. From now
   on the daemon ignores Omni events for this instance and routes its sends to
   the runner.
5. Verify: `ravi instances status <name> --json` reports `transport: "native"`
   and `state: "connected"`; a DM and a group message reach the same sessions as
   before (`ravi sessions list`); an agent reply, a reaction and a media send
   arrive on the phone.

## Rollback

1. Disable the native channel. Ownership returns to Omni immediately and the
   runner stops the runtime on the config change:

   ```bash
   ravi channels set <name> enabled false
   ```

2. Reconnect on Omni: `ravi instances connect <name> --transport omni`.
3. To go native again later: `ravi channels set <name> enabled true`, then
   `ravi instances connect <name> --transport native`. Stored auth state
   reconnects without a QR code unless the device was logged out.

## Debug

- `WHATSAPP_RUNNER_UNAVAILABLE`: no runner answered the RPC. Run
  `ravi channels status`, then `ravi channels start` or
  `ravi channels restart`.
- `INSTANCE_CONNECT_TIMEOUT` during pairing: the daemon is not relaying
  `CHANNEL_INBOUND`. Check `ravi daemon status`.
- Health `starting` / `pairing_required`: no stored creds; run
  `ravi instances connect <name> --transport native`.
- Health `disconnected` / `connection_replaced`: another process holds the
  same creds. Look for a second runner (`pm2 jlist`, another host on the same
  DB) and stop it; the runtime does not reconnect on its own.
- Health `disconnected` / `logged_out`: the phone removed the device. Pair
  again.
- Health `failed` / `missing_dependency`: the bundle cannot load Baileys.
  Rebuild (`bun run build:cli`) or reinstall.
- `INSTANCE_NATIVE_OWNED` from `--transport omni`: the instance has an enabled
  native channel. Disable it first (rollback step 1).
- No inbound at all: inspect the stream and the native durables:

  ```bash
  nats stream info CHANNEL_INBOUND --server nats://127.0.0.1:4222
  nats consumer report CHANNEL_INBOUND --server nats://127.0.0.1:4222
  nats sub "ravi.channel.inbound.>" --server nats://127.0.0.1:4222
  ```

- RPC traffic: `nats sub "_RAVI.channels.whatsapp.rpc.>"`.
- Auth state rows: `whatsapp_auth_state` in `~/.ravi/ravi.db`. Do not edit them
  by hand while the runner is running.
- Runner tuning env (`WHATSAPP_*`) must be in `~/.ravi/.env` or the PM2
  environment; `ravi channels restart` carries only the listed keys.
