# Vendored Baileys build

`baileys-v7.0.0-rc14.tgz` is built from the upstream `7.0.0-rc14` npm release and kept at the same package version so the local-file dependency remains reproducible. It is a byte-identical copy of Omni's `packages/channel-whatsapp/vendor/baileys-v7.0.0-rc14.tgz`.

In ravi it is a build-time `devDependency` (`file:vendor/baileys/...`, next to the `audio-decode` shim in `vendor/audio-decode-shim/`). `bun run build:cli` inlines Baileys into a lazily loaded chunk of `dist/bundle/`, so the published package declares no `file:` dependency and needs nothing from `vendor/` at runtime. The tarball is committed despite the global `*.tgz` ignore rule (see the `!vendor/**/*.tgz` exception in `.gitignore`): `bun install --frozen-lockfile` needs it.

Omni carries four focused changes in this artifact:

- support for WhatsApp's passkey companion-pairing ceremony (`passkey_prologue_request` / `crsc_continuation`);
- removal of WebSocket events that Bun does not implement;
- transient pre-key failures use the existing retry path without error-level log noise;
- `generateRegistrationNode` reads `supportGroupHistory` from the socket config instead of hardcoding `false` (#1126).

The passkey implementation validates the WhatsApp relying party, never logs the WebAuthn assertion or derived keys, and exposes the ceremony through typed socket methods and `connection.update` states.

SHA-256: `e363f7146d83897241eaf10432fbdeafbbf7cb2845a592c93bf3fc8386e72a82`

## Refreshing the vendored copy

A pinned tarball has no update signal, so check `npm view baileys dist-tags` when touching the channel (rc10 drifted four RCs silently). Check Omni too: if Omni refreshed its copy, take Omni's tarball as is and skip to step 4.

1. Download the stock releases for the current and the target version from the npm registry and verify the target against `dist.integrity` (`curl -sO https://registry.npmjs.org/baileys/-/baileys-<ver>.tgz`, then compare `sha512-$(openssl dgst -sha512 -binary <tgz> | base64 -w0)`).
2. Extract the patch set: `diff -ruN -x '*.map' <stock-current>/package <vendored-current>/package > baileys.patch`.
3. Apply it to the target (`patch -p2` inside the extracted `package/`) and hand-resolve any rejects; then repack as `vendor/baileys/baileys-v<ver>.tgz` with a top-level `package/` directory.
4. Point the `baileys` devDependency in `package.json` at the new file, delete the old tarball, and run:

   ```bash
   bun install
   bun install --frozen-lockfile
   bunx tsc --noEmit -p .
   bun test src/channels/whatsapp/
   bun run build:cli
   ```

   Once the runner registers the WhatsApp driver, `grep -l 'web.whatsapp.com' dist/bundle/*.js` must list only a `runtime-library-*.js` chunk: Baileys belongs in the chunk loaded when a WhatsApp runtime starts, never in `index.js` or a chunk it imports statically.
5. Update the SHA-256 above, commit the tarball, `package.json` and `bun.lock` together, and restart the runner (`ravi channels restart`) to pick up the new bundle.
