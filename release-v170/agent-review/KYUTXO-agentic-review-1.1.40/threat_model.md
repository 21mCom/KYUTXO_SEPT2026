# Threat Model

## Project Overview

KYUTXO is an offline-first desktop application (Electron + React 18 / TypeScript / Vite) for managing Bitcoin address and transaction metadata. It stores data in browser IndexedDB via Dexie.js and serves file attachments through a local Express.js backend. Replit is used for development and preview; a Replit autoscale deployment exists but the primary production target is the packaged Electron desktop app.

**Tech stack:** Node.js/Express (attachment server + Tor proxy relay), React/Vite (SPA), Electron, IndexedDB (Dexie), no external database, no user accounts.

**Users:** A single local user managing their own Bitcoin metadata. Multi-user or cloud-hosted use is not the design target.

## Assets

- **Attachment files** — arbitrary files linked to records, stored on the local filesystem under a data directory. Compromise allows reading or modifying any attached file.
- **IndexedDB vault data** — Bitcoin addresses, transaction metadata, labels, notes, entity-list snapshots. Stored as plaintext; OS-level encryption is expected if protection is required (documented design choice).
- **UI lock password hash** — protects the UI lock screen. Argon2id (current) or PBKDF2 (legacy) hashes stored in IndexedDB. Compromise allows bypassing the in-app lock.
- **Launch token** — per-process random token (`/api` gate). Injected into served HTML; controls access to the local attachment API and Tor proxy.
- **Tor proxy settings token** — per-process random token that gates `POST /api/tor/settings`. Only issued to loopback clients; prevents LAN/network clients from manipulating SSRF allowlists.
- **Backup files** — ZIP archives, optionally encrypted with AES-GCM + Argon2id KDF. May contain full vault contents including sensitive metadata.

## Trust Boundaries

- **Browser/Electron renderer ↔ Express API (loopback):** The Express server accepts only requests bearing the per-launch token. In desktop mode it binds `127.0.0.1`; on Replit it binds `0.0.0.0` (Replit container isolation is the outer boundary). DNS-rebinding protection (`rejectUnknownHosts`) defends against rebounded malicious pages reading the token from `<meta>` and replaying it.
- **Express API ↔ filesystem (attachment storage):** `containedRealPath` + lexical path validation + `O_NOFOLLOW` prevent path traversal and planted-symlink attacks.
- **Express API ↔ Tor/SSRF proxy:** Server-side URL allowlist (mempool.space, blockstream.info, check.torproject.org, user-configured custom provider) + separate settings token (loopback-only issuance) prevent the Tor relay from becoming an open SSRF relay.
- **User ↔ UI lock:** Argon2id password hash in IndexedDB controls the in-app lock screen. Does NOT encrypt data at rest.

## Scan Anchors

- **Production entry points:** `server/routes.ts` (mounts `/api/attachments` and `/api/tor`), `server/launch-token.ts` (`requireLaunchToken` middleware, `rejectUnknownHosts`), `server/tor-proxy.ts` (SSRF proxy), `server/attachments.ts` (file read/write/delete/rename).
- **Highest-risk code areas:** `server/attachments.ts` (path traversal potential, symlink attacks), `server/tor-proxy.ts` (SSRF allowlist logic, `isAllowedUrl`, `updateTorProxySettings`), `server/launch-token.ts` (DNS-rebinding defense, `isAllowedHost`).
- **Public surface (no auth):** Static asset serving, HTML index (which embeds the launch token).
- **Authenticated surface:** All `/api/*` routes require `x-kyutxo-launch-token` header.
- **Admin-equivalent surface:** `GET /api/tor/settings-token` (loopback-only), `POST /api/tor/settings` (settings token required).
- **Dev-only areas:** `scripts/`, `server/index-dev.ts` (Vite dev server), test files.

## Threat Categories

### Spoofing

The launch token (random 32-byte base64url, regenerated each launch) authenticates the browser/renderer to the API. The DNS-rebinding defense (`rejectUnknownHosts`) prevents a rebound malicious page from reading the token from the HTML `<meta>` tag and replaying it.

**Known gap:** `isAllowedHost` allows `*.replit.dev` but not `*.replit.app` (the autoscale deployment domain). In the production Replit deployment this is either a functional breakage (all requests rejected) or the defense is transparent because Replit's proxy rewrites the Host header before forwarding — neither outcome is explicitly controlled by the app. This should be resolved by explicitly allowlisting `*.replit.app` when `REPL_ID` is set.

**Required guarantees:**
- `requireLaunchToken` MUST remain on all `/api` routes.
- `rejectUnknownHosts` MUST be kept before all other middleware.
- The launch token MUST NOT be logged or exposed in error responses.

### Tampering

Attachment file writes go through `containedRealPath` containment, `O_NOFOLLOW` at open time, and lexical traversal checks. The rename endpoint does a TOCTOU-safe double-containment check immediately before `rename(2)`. Bitcoin address/transaction data is client-side only (IndexedDB); no server-side mutation outside of the file store.

**Required guarantees:**
- Every file write MUST verify containment via `containedRealPath` AFTER directory creation and BEFORE the write operation.
- The Tor proxy settings token MUST only be issued to loopback clients (`isLoopbackRequest` check).

### Information Disclosure

Server error middleware strips 5xx detail in production. The request logger intentionally omits response bodies. Attachment download uses `application/octet-stream` content type, and filenames are set via `Content-Disposition` with proper RFC 5987 encoding and header-injection-safe sanitization.

IndexedDB data is stored as plaintext. The documented threat model defers data-at-rest protection to OS-level encrypted containers; this is an acceptable design tradeoff for a desktop app that does not handle raw private keys.

**Required guarantees:**
- Server MUST NOT log request/response bodies, filenames, or user data.
- Error responses MUST NOT expose filesystem paths, stack traces, or OS error details to clients in production.

### Denial of Service

The Tor proxy has an 8-concurrent-request semaphore, 64-request queue, and `MAX_RESPONSE_BODY_BYTES` (25 MiB) upstream response cap. Multer enforces a 100 MiB per-file upload limit with streaming storage (no RAM buffering). The JSON body parser has a 100 KB limit (1 MB for `/api/tor`).

No rate limiting exists on attachment upload/download beyond file size caps. The server is single-user and loopback-bound in desktop mode, making exhaustion attacks from external sources low risk.

### Elevation of Privilege

The single-token authorization model means all callers with the launch token have equivalent API access (no role separation). This is appropriate for single-user desktop use but would be a gap if the app were deployed multi-user.

SQL/command injection: there is no SQL database; IndexedDB operations are performed via Dexie's type-safe ORM without raw query construction. Shell commands are not invoked from the server.

The packaged Electron app enforces a strict CSP (`require-trusted-types-for 'script'`, `script-src 'self' 'wasm-unsafe-eval'`) and Trusted Types policy, preventing injected-script attacks from the renderer.

**Known gap (SSRF guard):** The `isPrivateAddress` function in `server/tor-proxy.ts` and `electron/tor-proxy.cjs` does not recognise IPv4-mapped IPv6 addresses (e.g. `[::ffff:127.0.0.1]`, normalised by Node's WHATWG URL parser to `[::ffff:7f00:1]`). A locally-trusted user could configure such an address as their custom Esplora provider, causing Tor-proxied requests to target a loopback-mapped address rather than taking the `trustedLocalHosts` direct path. Impact is low because the settings-token is loopback-only, the Replit deployment is private, and most Tor daemon configurations reject connections to private IPs. The fix is to extend `isPrivateAddress` to detect `[::ffff:*]` patterns that map to loopback/private IPv4 ranges.
