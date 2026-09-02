# KYUTXO — Agentic Review Bundle

## Description

KYUTXO is a private, offline-first Bitcoin metadata manager. It is a desktop Electron application with a React/TypeScript renderer and a local IndexedDB data layer. It organizes Bitcoin addresses, transactions, ownership, wallet context, labels, notes, UTXO provenance, privacy analysis, backups, evidence packages, and unsigned PSBT construction.

The application is designed to keep vault data local. It supports optional node/Electrum connectivity for synchronization, but this review bundle contains no user vault, backup, attachment, credential, private key, certificate, token, or generated release binary.

## Review target

This bundle reflects the current source state at:

- Git revision: `58c1f85ca7c8ca301e30ac32973b2e9703b38fe1`
- Related release: `v1.1.40`
- Current review focus: packaged Windows renderer startup, Electron runtime compatibility, legacy-vault migration, IPC/file safety, backup/restore integrity, and private/offline boundaries.

The workspace had a local `.replit` port configuration change when this bundle was made. It contains no secret values and is included only to preserve the reviewed source configuration.

## Included

- `client/` — React UI, pages, components, hooks, data access, migrations, reports, and tests
- `server/` — local development/production server and attachment routes
- `electron/` — desktop main process, preload bridge, IPC handlers, native read engine, and tests
- `shared/` — shared types/utilities
- `scripts/` — build, security, validation, browser-check, migration, and release checks
- `.github/workflows/` — Windows build and release workflow
- `vendor/extract-zip-adapter/` — local compatibility adapter for the hardened ZIP extractor
- `docs/`, `replit.md`, `INSTALL-USB.md`, and project configuration
- `package.json` and `package-lock.json`

## Deliberately excluded

No secrets or user data were packaged. The bundle excludes:

- `.env` files, secret stores, credentials, tokens, API keys, and private keys
- TLS key/certificate fixtures and PKCS#12 files
- `attached_assets/`, demo vault archives, PDFs, screenshots, runtime databases, and backups
- `node_modules/`, `dist/`, `release/`, executables, and other generated build output
- `.git/`, `.local/`, `.agents/`, and the mockup artifact
- runtime logs and local database files

Synthetic passwords in browser-test source are test data used to initialize disposable fixtures; they are not credentials for any service or vault.

## Suggested review procedure

1. Read `AGENT_REVIEW_PROMPT.md` and `REVIEW_SCOPE.md`.
2. Review the trust boundaries first: `electron/main.cjs`, `electron/preload.cjs`, IPC handlers, attachment handling, launch-token handling, Tor/Electrum transport, and vault/backup code.
3. Review startup and migration flow: `client/src/App.tsx`, `client/src/contexts/AuthContext.tsx`, `client/src/lib/vault.ts`, and legacy migration modules.
4. Review the Windows packaged renderer gate in `scripts/check-packaged-electron-browser.mjs` and `.github/workflows/build.yml`.
5. Run static checks only in an isolated environment. Do not point the app at a real vault, real credentials, or live user data.

## Local checks

From the bundle root, after installing dependencies in a disposable environment:

```bash
npm ci
npm run check
npm test
npm run build
node scripts/check-audit.js
node scripts/check-lockfile-urls.js
```

The full browser checks may require Chromium, Xvfb, and platform-specific native dependencies. The Windows release workflow is the authoritative environment for the Windows portable build and native SQLite ABI check.

## Reporting format

For each finding, report:

- severity and confidence
- exact file and line or symbol
- affected trust boundary or user outcome
- minimal reproduction using synthetic data only
- why existing tests/checks do or do not catch it
- a concrete remediation suggestion

Do not send source, findings, or test data to third-party services. Do not create commits, issues, releases, or external API calls as part of review without explicit approval.
