---
name: HTTP concurrency-limit tests
description: Testing server-side concurrency caps over HTTP needs node:http agent:false — undici's client pool hides queue overflow from the server.
---

When testing a server's concurrency limit / 429-overflow path over real HTTP in vitest, do NOT drive requests with global `fetch`: undici pools ~10 connections per origin, so excess requests queue in the *client* pool and the server never sees (or rejects) them — the test deadlocks. Use `node:http` `request` with `agent: false` so each request gets its own socket.

**Why:** two failed test iterations: one where overflow requests never reached the server, one where hung stubbed upstreams deadlocked `server.close()` (also fix: call `server.closeAllConnections?.()` in afterEach).

**How to apply:** any HTTP-level test asserting 429/backpressure behavior; make the stubbed upstream resolve slowly (e.g. 200ms) rather than hang-then-release, so queued requests drain on their own.
