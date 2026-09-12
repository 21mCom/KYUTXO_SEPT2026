# Review Scope and Architecture Notes

## Product boundaries

- Offline-first Electron desktop app for Bitcoin metadata and analysis.
- Local React renderer with Dexie/IndexedDB vault storage.
- Local Express server is used for development/production attachment serving.
- Optional synchronization uses blockchain APIs or Electrum/node connectivity; review must verify that these paths are explicit and privacy-preserving.
- No signing or broadcasting is performed by the PSBT builder.

## High-value trust boundaries

1. Untrusted renderer input → validation/canonicalization → local database.
2. Renderer ↔ Electron preload/IPC bridge.
3. Attachment upload/download paths ↔ local filesystem.
4. User-supplied node/Electrum/Tor settings ↔ network transport.
5. Backup/restore archives ↔ database records, attachments, and foreign keys.
6. Legacy encrypted records ↔ decrypted plaintext migration.
7. Derived Bitcoin identifiers and transaction relationships ↔ reports/exports.
8. Packaged `file://` renderer ↔ protocol remapping, CSP, Trusted Types, and startup visibility.

## Important code areas

- `electron/main.cjs`, `electron/preload.cjs`, `electron/*handlers.cjs`
- `client/src/contexts/AuthContext.tsx`, `client/src/App.tsx`
- `client/src/lib/database.ts`, `client/src/lib/vault.ts`, `client/src/lib/legacy-decrypt.ts`
- `client/src/lib/backup/`, `client/src/lib/data/`, `client/src/lib/engine/`
- `server/attachments.ts`, `server/launch-token.ts`, `server/tor-proxy.ts`
- `scripts/check-packaged-electron-browser.mjs`, `scripts/check-packaged-native-engine.mjs`
- `.github/workflows/build.yml`

## Known review limitation

The source bundle does not contain the Windows executable or a real user vault. Packaged-runtime behavior must be verified in an isolated Windows environment. The source includes the release gate that launches the packaged renderer and asserts visible startup UI, but the review team should confirm that gate is executed on every release.
