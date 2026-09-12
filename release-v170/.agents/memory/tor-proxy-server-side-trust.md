---
name: Tor proxy server-side trust
description: Tor proxy allowlist and SOCKS URL live server-side via pushed settings; per-request trust params were removed and must not return.
---

The Tor proxy (Express `/api/tor/*` in browser, `tor-request` IPC in Electron) derives its destination allowlist and SOCKS proxy URL from server/main-process state pushed by the client (`POST /api/tor/settings` and the `tor-update-settings` IPC), never from per-request input. The old per-request `allowedHost` / `trustedLocalHosts` / `torProxyUrl` fields were removed — do not reintroduce caller-controlled trust, and keep the onion rule (only the configured custom provider's onion, not arbitrary onions).

**Why:** the endpoint was a semi-open relay while the server is LAN-reachable; a completion-review-grade hardening moved all trust server-side.

**How to apply:** when adding new proxied call types, route trust through `syncTorProxySettings` (client/src/lib/tor-proxy-settings-sync.ts, deduped by payload) rather than request fields. Gotcha: the dedup cache means a *server restart* mid-session silently drops the allowlist until some settings change re-pushes — tracked as a follow-up.
